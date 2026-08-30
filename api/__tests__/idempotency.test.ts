/**
 * Unit tests for the distributed idempotency middleware.
 *
 * Acceptance criteria (Issue #33):
 *  - Intercepts duplicate requests with the same Idempotency-Key and returns
 *    identical cached responses.
 *  - Prevents concurrent race conditions using Redis distributed locks — a
 *    second request arriving while the first is still PENDING gets 409.
 *  - Caches response bodies and headers correctly.
 *  - Covered by concurrent mock-client testing.
 */

import request from "supertest";
import express, { Express } from "express";
import {
  idempotencyMiddleware,
  clearIdempotencyStore,
  setIdempotencyRedis,
  IdempotencyRedisClient,
} from "../middleware/idempotency";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Slow handler that takes `delayMs` before responding — used to test
 *  concurrent race conditions. */
function buildSlowTestApp(delayMs = 200): Express {
  const app = express();
  app.use(express.json());
  app.use(idempotencyMiddleware());

  let callCount = 0;
  app.post("/api/v1/payments", async (_req, res) => {
    callCount++;
    await new Promise((r) => setTimeout(r, delayMs));
    res.status(201).json({ id: `txn-${callCount}`, status: "pending" });
  });

  app.get("/api/v1/payments", (_req, res) => {
    res.json([]);
  });

  return app;
}

/** Simple Express app with multiple mutating endpoints. */
function buildMultiEndpointApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(idempotencyMiddleware());

  app.post("/api/v1/escrow", (req, res) => {
    const { amount } = req.body ?? {};
    res.status(201).json({ escrow_id: "esc-001", amount });
  });

  app.patch("/api/v1/escrow/esc-001", (req, res) => {
    res.json({ escrow_id: "esc-001", ...req.body });
  });

  app.put("/api/v1/escrow/esc-001/callback", (_req, res) => {
    res.status(204).end();
  });

  return app;
}

// ---------------------------------------------------------------------------
// In-memory tests (no Redis required)
// ---------------------------------------------------------------------------

let app: Express;

beforeEach(() => {
  clearIdempotencyStore();
});

describe("Idempotency middleware (in-memory)", () => {
  it("first request with Idempotency-Key succeeds and caches response", async () => {
    app = buildMultiEndpointApp();

    const res = await request(app)
      .post("/api/v1/escrow")
      .set("Idempotency-Key", "key-001")
      .send({ amount: "100" });

    expect(res.status).toBe(201);
    expect(res.body.escrow_id).toBe("esc-001");
    expect(res.body.amount).toBe("100");
  });

  it("subsequent request with same key returns identical cached response", async () => {
    app = buildMultiEndpointApp();

    const first = await request(app)
      .post("/api/v1/escrow")
      .set("Idempotency-Key", "key-cache-001")
      .send({ amount: "250" });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/escrow")
      .set("Idempotency-Key", "key-cache-001")
      .send({ amount: "999" });

    // Must return the same status and body as the first request
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it("returns cached response with correct status code", async () => {
    app = buildMultiEndpointApp();

    const first = await request(app)
      .put("/api/v1/escrow/esc-001/callback")
      .set("Idempotency-Key", "key-cb-001")
      .send({ url: "https://example.com" });

    expect(first.status).toBe(204);

    const second = await request(app)
      .put("/api/v1/escrow/esc-001/callback")
      .set("Idempotency-Key", "key-cb-001")
      .send({ url: "https://other.com" });

    expect(second.status).toBe(204);
  });

  it("returns 409 when a concurrent request arrives while the first is still PENDING", async () => {
    app = buildSlowTestApp(300);

    // Fire two requests simultaneously with the same key
    const [first, second] = await Promise.all([
      request(app)
        .post("/api/v1/payments")
        .set("Idempotency-Key", "race-key-001")
        .send({ amount: "50" }),
      request(app)
        .post("/api/v1/payments")
        .set("Idempotency-Key", "race-key-001")
        .send({ amount: "50" }),
    ]);

    // One should succeed, the other should get 409
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it("concurrent requests return 409 with the correct error shape", async () => {
    app = buildSlowTestApp(200);

    const [, second] = await Promise.all([
      request(app)
        .post("/api/v1/payments")
        .set("Idempotency-Key", "race-shape-001")
        .send({ amount: "10" }),
      request(app)
        .post("/api/v1/payments")
        .set("Idempotency-Key", "race-shape-001")
        .send({ amount: "10" }),
    ]);

    if (second.status === 409) {
      expect(second.body.error).toBe("idempotency_lock_pending");
      expect(second.body.message).toBeDefined();
    }
  });

  it("different Idempotency-Keys are processed independently", async () => {
    app = buildMultiEndpointApp();

    const first = await request(app)
      .post("/api/v1/escrow")
      .set("Idempotency-Key", "key-a")
      .send({ amount: "100" });

    const second = await request(app)
      .post("/api/v1/escrow")
      .set("Idempotency-Key", "key-b")
      .send({ amount: "200" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.amount).toBe("100");
    expect(second.body.amount).toBe("200");
  });

  it("GET requests with Idempotency-Key are ignored (no interception)", async () => {
    app = buildSlowTestApp();

    const res = await request(app)
      .get("/api/v1/payments")
      .set("Idempotency-Key", "get-key-001");

    expect(res.status).toBe(200);
  });

  it("requests without Idempotency-Key bypass the middleware entirely", async () => {
    app = buildMultiEndpointApp();

    const first = await request(app)
      .post("/api/v1/escrow")
      .send({ amount: "100" });

    const second = await request(app)
      .post("/api/v1/escrow")
      .send({ amount: "100" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it("cached response preserves response body shape on replay", async () => {
    app = buildMultiEndpointApp();

    const first = await request(app)
      .post("/api/v1/escrow")
      .set("Idempotency-Key", "shape-key-001")
      .send({ amount: "42" });

    const second = await request(app)
      .post("/api/v1/escrow")
      .set("Idempotency-Key", "shape-key-001")
      .send({ amount: "999" });

    // Body must be deeply equal — same keys, same values
    expect(second.body).toEqual(first.body);
    // A different request body must NOT influence the cached response
    expect(second.body.amount).toBe("42");
  });

  it("PATCH requests are subject to idempotency", async () => {
    app = buildMultiEndpointApp();

    const first = await request(app)
      .patch("/api/v1/escrow/esc-001")
      .set("Idempotency-Key", "patch-key-001")
      .send({ state: "Released" });

    expect(first.status).toBe(200);

    const second = await request(app)
      .patch("/api/v1/escrow/esc-001")
      .set("Idempotency-Key", "patch-key-001")
      .send({ state: "Refunded" });

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it("concurrent PATCH requests: one succeeds, one gets 409", async () => {
    const slowApp = express();
    slowApp.use(express.json());
    slowApp.use(idempotencyMiddleware());
    slowApp.patch("/api/v1/escrow/:id", async (_req, res) => {
      await new Promise((r) => setTimeout(r, 200));
      res.json({ state: "Released" });
    });

    const [first, second] = await Promise.all([
      request(slowApp)
        .patch("/api/v1/escrow/esc-001")
        .set("Idempotency-Key", "patch-race-001")
        .send({ state: "Released" }),
      request(slowApp)
        .patch("/api/v1/escrow/esc-001")
        .set("Idempotency-Key", "patch-race-001")
        .send({ state: "Released" }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("replayed response after completion returns identical body even with different request payload", async () => {
    app = buildMultiEndpointApp();

    await request(app)
      .post("/api/v1/escrow")
      .set("Idempotency-Key", "payload-key-001")
      .send({ amount: "100" });

    // Wait briefly to ensure the first request completes and markCompleted fires
    await new Promise((r) => setTimeout(r, 50));

    const replay = await request(app)
      .post("/api/v1/escrow")
      .set("Idempotency-Key", "payload-key-001")
      .send({ amount: "DIFFERENT" });

    expect(replay.status).toBe(201);
    expect(replay.body.amount).toBe("100");
  });
});

// ---------------------------------------------------------------------------
// Concurrent mock-client testing
// ---------------------------------------------------------------------------

describe("Concurrent client idempotency", () => {
  it("100 concurrent requests with the same key: exactly one succeeds, rest get 409", async () => {
    const slowApp = express();
    slowApp.use(express.json());
    slowApp.use(idempotencyMiddleware());
    let handlerCalls = 0;
    slowApp.post("/api/v1/payments", async (_req, res) => {
      handlerCalls++;
      await new Promise((r) => setTimeout(r, 200));
      res.status(201).json({ id: `txn-${handlerCalls}`, status: "processed" });
    });

    const promises = Array.from({ length: 100 }, () =>
      request(slowApp)
        .post("/api/v1/payments")
        .set("Idempotency-Key", "concurrent-key-001")
        .send({ amount: "50" })
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(99);
    expect(handlerCalls).toBe(1);
  });

  it("concurrent requests with different keys all succeed", async () => {
    const slowApp = express();
    slowApp.use(express.json());
    slowApp.use(idempotencyMiddleware());
    slowApp.post("/api/v1/payments", async (req, res) => {
      await new Promise((r) => setTimeout(r, 100));
      res.status(201).json({ id: "txn-ok", body: req.body });
    });

    const promises = Array.from({ length: 10 }, (_, i) =>
      request(slowApp)
        .post("/api/v1/payments")
        .set("Idempotency-Key", `unique-key-${i}`)
        .send({ amount: "10" })
    );

    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.status).toBe(201);
    }
  });

  it("after a concurrent batch, subsequent requests return the cached response", async () => {
    const slowApp = express();
    slowApp.use(express.json());
    slowApp.use(idempotencyMiddleware());
    slowApp.post("/api/v1/payments", async (req, res) => {
      await new Promise((r) => setTimeout(r, 100));
      res.status(201).json({ id: "txn-ok", amount: req.body.amount });
    });

    // Fire 5 concurrent requests with the same key
    const batch = Array.from({ length: 5 }, () =>
      request(slowApp)
        .post("/api/v1/payments")
        .set("Idempotency-Key", "batch-key-001")
        .send({ amount: "75" })
    );
    const batchResults = await Promise.all(batch);
    const winner = batchResults.find((r) => r.status === 201)!;
    expect(winner).toBeDefined();

    // Wait for markCompleted to flush
    await new Promise((r) => setTimeout(r, 50));

    // Subsequent request should get the cached response
    const replay = await request(slowApp)
      .post("/api/v1/payments")
      .set("Idempotency-Key", "batch-key-001")
      .send({ amount: "DIFFERENT" });

    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(winner.body);
  });
});

// ---------------------------------------------------------------------------
// Mock Redis store tests
// ---------------------------------------------------------------------------

describe("Idempotency with mock Redis", () => {
  let mockRedis: IdempotencyRedisClient & { store: Map<string, string> };

  beforeEach(() => {
    clearIdempotencyStore();
    mockRedis = {
      store: new Map<string, string>(),
      async set(key: string, value: string, _expiryMode?: string, _ttl?: number, setMode?: string) {
        if (setMode === "NX" && this.store.has(key)) {
          return null;
        }
        this.store.set(key, value);
        return "OK";
      },
      async get(key: string) {
        return this.store.get(key) ?? null;
      },
      async del(key: string) {
        const existed = this.store.has(key);
        this.store.delete(key);
        return existed ? 1 : 0;
      },
    };
    setIdempotencyRedis(mockRedis);
  });

  it("uses Redis for lock acquisition and response caching", async () => {
    const app = express();
    app.use(express.json());
    app.use(idempotencyMiddleware());
    app.post("/api/v1/payments", (_req, res) => {
      res.status(201).json({ id: "redis-txn-001" });
    });

    const first = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", "redis-key-001")
      .send({ amount: "100" });

    expect(first.status).toBe(201);
    expect(first.body.id).toBe("redis-txn-001");

    // Verify the record was stored in Redis
    const keys = Array.from(mockRedis.store.keys());
    expect(keys.some((k) => k.includes("redis-key-001"))).toBe(true);
  });

  it("replays cached response from Redis on subsequent request", async () => {
    const app = express();
    app.use(express.json());
    app.use(idempotencyMiddleware());
    app.post("/api/v1/payments", (_req, res) => {
      res.status(201).json({ id: "redis-txn-002" });
    });

    await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", "redis-key-002")
      .send({ amount: "100" });

    // Wait for async markCompleted
    await new Promise((r) => setTimeout(r, 50));

    const second = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", "redis-key-002")
      .send({ amount: "999" });

    expect(second.status).toBe(201);
    expect(second.body.id).toBe("redis-txn-002");
  });

  it("concurrent requests: Redis NX lock prevents double-processing", async () => {
    const app = express();
    app.use(express.json());
    app.use(idempotencyMiddleware());
    app.post("/api/v1/payments", async (_req, res) => {
      await new Promise((r) => setTimeout(r, 200));
      res.status(201).json({ id: "redis-txn-concurrent" });
    });

    const [first, second] = await Promise.all([
      request(app)
        .post("/api/v1/payments")
        .set("Idempotency-Key", "redis-race-001")
        .send({ amount: "50" }),
      request(app)
        .post("/api/v1/payments")
        .set("Idempotency-Key", "redis-race-001")
        .send({ amount: "50" }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it("falls back to in-memory when Redis operations throw", async () => {
    const brokenRedis: IdempotencyRedisClient = {
      async set() {
        throw new Error("Redis connection refused");
      },
      async get() {
        throw new Error("Redis connection refused");
      },
      async del() {
        throw new Error("Redis connection refused");
      },
    };
    setIdempotencyRedis(brokenRedis);

    const app = express();
    app.use(express.json());
    app.use(idempotencyMiddleware());
    app.post("/api/v1/payments", (_req, res) => {
      res.status(201).json({ id: "fallback-txn" });
    });

    // Should still work via in-memory fallback
    const first = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", "fallback-key-001")
      .send({ amount: "100" });

    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", "fallback-key-001")
      .send({ amount: "200" });

    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });
});
