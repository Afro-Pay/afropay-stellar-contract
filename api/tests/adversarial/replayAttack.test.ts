import request from "supertest";
import express, { Express } from "express";
import { clearIdempotencyStore, idempotencyMiddleware } from "../../middleware/idempotency";

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(idempotencyMiddleware());

  app.post("/api/v1/payments", (req, res) => {
    const { amount, asset_code } = req.body ?? {};
    if (!amount || !asset_code) {
      res.status(400).json({ error: "amount and asset_code are required" });
      return;
    }
    res.status(201).json({ id: "txn-001", status: "pending", amount, asset_code });
  });

  return app;
}

function buildSlowTestApp(delayMs = 300): Express {
  const app = express();
  app.use(express.json());
  app.use(idempotencyMiddleware());

  app.post("/api/v1/payments", async (req, res) => {
    const { amount, asset_code } = req.body ?? {};
    if (!amount || !asset_code) {
      res.status(400).json({ error: "amount and asset_code are required" });
      return;
    }
    await new Promise((r) => setTimeout(r, delayMs));
    res.status(201).json({ id: "txn-001", status: "pending", amount, asset_code });
  });

  return app;
}

let app: Express;

beforeAll(() => {
  app = buildTestApp();
});

beforeEach(() => {
  clearIdempotencyStore();
});

describe("Adversarial: Replay Attack", () => {
  it("first request with Idempotency-Key returns 201", async () => {
    const res = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", "unique-key-001")
      .send({ amount: "100", asset_code: "USDC" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("txn-001");
  });

  it("sequential replay with same Idempotency-Key returns cached response", async () => {
    const body = { amount: "100", asset_code: "USDC" };

    const first = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", "replay-key-001")
      .send(body);

    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", "replay-key-001")
      .send(body);

    // After the first request completes, the cached response is returned
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it("concurrent replay with same Idempotency-Key returns 409 for the loser", async () => {
    const slowApp = buildSlowTestApp(300);
    const body = { amount: "100", asset_code: "USDC" };

    const [first, second] = await Promise.all([
      request(slowApp)
        .post("/api/v1/payments")
        .set("Idempotency-Key", "concurrent-replay-001")
        .send(body),
      request(slowApp)
        .post("/api/v1/payments")
        .set("Idempotency-Key", "concurrent-replay-001")
        .send(body),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);
  });

  it("replay with different key succeeds (different idempotency context)", async () => {
    const body = { amount: "100", asset_code: "USDC" };

    const first = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", "key-a")
      .send(body);

    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", "key-b")
      .send(body);

    expect(second.status).toBe(201);
  });

  it("GET request with Idempotency-Key is ignored (no replay check)", async () => {
    const res = await request(app)
      .get("/api/v1/payments")
      .set("Idempotency-Key", "some-key");

    expect(res.status).toBe(404);
  });
});
