/**
 * Distributed idempotency middleware for financial API endpoints.
 *
 * Prevents double-processing of transaction submissions when clients retry
 * due to network disconnects. Uses Redis (when available) for distributed
 * locking, falling back to an in-memory Map for local development and CI.
 *
 * Lifecycle
 * ---------
 * 1. First request with a given Idempotency-Key:
 *    → acquire a lock (SET NX with TTL), status = PENDING
 *    → intercept the response to capture body/status/headers
 *    → on response completion, store cached response with status = COMPLETED
 *
 * 2. Concurrent duplicate (key is PENDING):
 *    → return 409 Conflict
 *
 * 3. Subsequent duplicate (key is COMPLETED):
 *    → return the cached response verbatim (no re-processing)
 *
 * TTL: 24 hours (86 400 s).  Expired keys are treated as absent.
 *
 * Scope
 * -----
 * Applied only to POST, PATCH, and PUT requests that carry an
 * `Idempotency-Key` header.  GET and DELETE are never intercepted.
 */

import { Request, Response, NextFunction, RequestHandler } from "express";

// ---------------------------------------------------------------------------
// Redis client interface — intentionally minimal so both ioredis and
// node-redis v4 satisfy it.  Matches the pattern used by
// api/services/kyc/bvnVerification.ts.
// ---------------------------------------------------------------------------

export interface IdempotencyRedisClient {
  set(key: string, value: string, expiryMode: "EX", ttl: number, setMode?: "NX"): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Internal record shape stored in the backing store
// ---------------------------------------------------------------------------

interface CachedResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

interface IdempotencyRecord {
  status: "pending" | "completed";
  response?: CachedResponse;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TTL_SECONDS = 86_400; // 24 hours
const KEY_PREFIX = "idempot:";
const METHODS = new Set(["POST", "PATCH", "PUT"]);

// ---------------------------------------------------------------------------
// In-memory fallback store (dev / CI without Redis)
// ---------------------------------------------------------------------------

interface MemoryEntry {
  record: IdempotencyRecord;
  expiresAt: number;
}

class InMemoryStore {
  private map = new Map<string, MemoryEntry>();

  /** Atomic set-if-not-exists. Returns true when the key was created. */
  setNx(key: string, record: IdempotencyRecord, ttlSeconds: number): boolean {
    const now = Date.now();
    const existing = this.map.get(key);
    if (existing && existing.expiresAt > now) {
      return false;
    }
    this.map.set(key, { record, expiresAt: now + ttlSeconds * 1000 });
    return true;
  }

  get(key: string): IdempotencyRecord | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.record;
  }

  set(key: string, record: IdempotencyRecord, ttlSeconds: number): void {
    this.map.set(key, { record, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  clear(): void {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------
// Module-level state — one instance per process
// ---------------------------------------------------------------------------

let redis: IdempotencyRedisClient | null = null;
const memory = new InMemoryStore();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inject a Redis client for distributed idempotency.
 * Call once at startup when REDIS_URL is set.
 */
export function setIdempotencyRedis(client: IdempotencyRedisClient): void {
  redis = client;
}

/** Wipe all in-memory records — used by tests. */
export function clearIdempotencyStore(): void {
  memory.clear();
}

/**
 * Express middleware factory.
 *
 * Usage:  app.use("/path", idempotencyMiddleware());
 */
export function idempotencyMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!METHODS.has(req.method)) {
      next();
      return;
    }

    const rawKey = req.get("Idempotency-Key");
    if (!rawKey || typeof rawKey !== "string" || rawKey.length === 0) {
      next();
      return;
    }

    const composite = `${req.method}:${req.originalUrl}:${rawKey}`;

    // ── Attempt to acquire the lock ──────────────────────────────────────
    acquireLock(composite)
      .then((state) => {
        if (state === "completed") {
          replayCachedResponse(res, composite).catch(() => {
            // Cache miss after race — treat as first request
            handleFirstRequest(req, res, next, composite);
          });
          return;
        }

        if (state === "pending") {
          res.status(409).json({
            error: "idempotency_lock_pending",
            message:
              "A request with this Idempotency-Key is already being processed",
          });
          return;
        }

        // state === "acquired" — first request
        handleFirstRequest(req, res, next, composite);
      })
      .catch(() => {
        // Redis/store failure — fail open, let the request through
        next();
      });
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function keyName(composite: string): string {
  return `${KEY_PREFIX}${composite}`;
}

async function acquireLock(composite: string): Promise<"acquired" | "pending" | "completed"> {
  const record: IdempotencyRecord = { status: "pending", createdAt: Date.now() };
  const value = JSON.stringify(record);
  const rKey = keyName(composite);

  if (redis) {
    try {
      // SET … EX … NX — atomic set-if-not-expired
      const result = await redis.set(rKey, value, "EX", TTL_SECONDS, "NX");
      if (result === "OK") return "acquired";

      // Key already exists — read its status
      const raw = await redis.get(rKey);
      if (!raw) return "acquired"; // expired between set and get (unlikely)
      const parsed = JSON.parse(raw) as IdempotencyRecord;
      return parsed.status;
    } catch {
      // Redis failure — fall through to in-memory
    }
  }

  // In-memory path
  const created = memory.setNx(rKey, record, TTL_SECONDS);
  if (created) return "acquired";

  const existing = memory.get(rKey);
  if (!existing) return "acquired";
  return existing.status;
}

async function markCompleted(
  composite: string,
  statusCode: number,
  body: string,
  headers: Record<string, string>
): Promise<void> {
  const record: IdempotencyRecord = {
    status: "completed",
    response: { statusCode, body, headers },
    createdAt: Date.now(),
  };
  const value = JSON.stringify(record);
  const rKey = keyName(composite);

  if (redis) {
    try {
      await redis.set(rKey, value, "EX", TTL_SECONDS);
      return;
    } catch {
      // Fall through to in-memory
    }
  }

  memory.set(rKey, record, TTL_SECONDS);
}

async function replayCachedResponse(res: Response, composite: string): Promise<void> {
  let record: IdempotencyRecord | undefined;

  if (redis) {
    try {
      const raw = await redis.get(keyName(composite));
      if (raw) record = JSON.parse(raw) as IdempotencyRecord;
    } catch {
      // Fall through to in-memory
    }
  }

  if (!record) {
    record = memory.get(keyName(composite));
  }

  if (!record || record.status !== "completed" || !record.response) {
    throw new Error("no cached response");
  }

  const { statusCode, body, headers } = record.response;
  for (const [h, v] of Object.entries(headers)) {
    res.set(h, v);
  }

  // For responses with a body, parse and use res.json() so Express sets
  // the correct Content-Type.  For empty-body responses (e.g. 204),
  // use res.status().end().
  if (body && body !== "") {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body);
    } catch {
      parsedBody = body;
    }
    res.status(statusCode).json(parsedBody);
  } else {
    res.status(statusCode).end();
  }
}

function handleFirstRequest(
  req: Request,
  res: Response,
  next: NextFunction,
  composite: string
): void {
  // Capture the response by monkey-patching res.json, res.status, and res.end
  const origJson = res.json.bind(res);
  const origStatus = res.status.bind(res);
  const origEnd = res.end.bind(res);
  let capturedStatus = 200;
  let cached = false;

  res.status = function (code: number) {
    capturedStatus = code;
    return origStatus(code);
  } as typeof res.status;

  function persistCache(bodyStr: string): void {
    if (cached) return;
    cached = true;
    const respHeaders: Record<string, string> = {};
    const ct = res.get("Content-Type");
    if (ct) respHeaders["Content-Type"] = ct;
    const cc = res.get("Cache-Control");
    if (cc) respHeaders["Cache-Control"] = cc;

    markCompleted(composite, capturedStatus, bodyStr, respHeaders).catch(
      (err: unknown) => {
        console.error(
          `[idempotency] failed to cache response: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    );
  }

  res.json = function (body: unknown) {
    const bodyStr = JSON.stringify(body);

    // We only intercept res.json(), so the content type is always JSON.
    persistCache(bodyStr);

    return origJson(body);
  } as typeof res.json;

  // Handle res.end() for non-JSON responses (e.g. 204 No Content)
  res.end = function (...args: unknown[]) {
    persistCache("");
    return (origEnd as Function)(...args);
  } as typeof res.end;

  next();
}
