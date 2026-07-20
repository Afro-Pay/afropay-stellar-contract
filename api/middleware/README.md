# API Middleware

This directory contains Express middleware modules used by the AfroPay anchor API.

---

## `metrics.ts` — Prometheus Instrumentation

Instruments every HTTP request and exposes a `/metrics` scrape endpoint for Prometheus.

### Exports

| Export | Type | Purpose |
|---|---|---|
| `metricsMiddleware` | `RequestHandler` | Per-request timing middleware — attach **before** route handlers |
| `metricsEndpoint` | `RequestHandler` | `GET /metrics` handler that serves the Prometheus text exposition format |

### Usage

```ts
import { metricsMiddleware, metricsEndpoint } from './middleware/metrics';

app.use(metricsMiddleware);   // must be first
app.get('/metrics', metricsEndpoint);
```

### Metrics emitted

All metrics are registered on the shared registry in `services/metrics/index.ts`.

| Metric | Type | Labels | Description |
|---|---|---|---|
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | Per-request latency in seconds |
| `http_requests_total` | Counter | `method`, `route`, `status_code` | Total requests handled |
| `payment_submissions_total` | Counter | `status`, `corridor` | Payment submission outcomes |
| `escrow_state_duration_seconds` | Histogram | `state` | Time an escrow spends in each lifecycle state |
| `horizon_stream_lag_ledgers` | Gauge | — | Ledgers the Horizon listener is behind the chain tip |
| `rate_oracle_staleness_seconds` | Gauge | `corridor` | Seconds since the FX oracle last refreshed a corridor |

Dynamic path segments are normalised before labelling (UUIDs → `:id`, Stellar keys → `:account`, numeric IDs → `/:id`) to keep label cardinality bounded.

### Health endpoint

`GET /health` returns structured JSON including service name, version, and live Horizon connectivity:

```json
{
  "status": "ok",
  "service": "afropay-anchor-api",
  "version": "0.1.0",
  "horizon": {
    "url": "https://horizon-testnet.stellar.org",
    "connected": true,
    "latency_ms": 42
  },
  "timestamp": "2026-07-20T04:00:00.000Z"
}
```

Returns `200` when Horizon is reachable and `503` (with `"status": "degraded"`) otherwise.

---

## `sep10.ts` — SEP-10 Authentication

Implements two variants of SEP-10 JWT verification:

### `requireSep10` — HS256 shared-secret (SEP-12 / SEP-31 gate)

Verifies JWTs signed with the server's own `JWT_SECRET` (HS256). Used to protect SEP-12 KYC and SEP-31 payment endpoints. Returns `403` on failure.

```ts
import { requireSep10 } from './middleware/sep10';

router.get('/customer', requireSep10, handler);
```

### `requireSep10Ed25519` — Ed25519 anchor-key (escrow release / dispute gate)

Verifies JWTs signed with the anchor's Ed25519 private key. The public key is fetched from the anchor's `stellar.toml` at `ANCHOR_DOMAIN` and cached for **1 hour** to avoid a round-trip on every request. Returns `401` on failure.

```ts
import { requireSep10Ed25519 } from './middleware/sep10';

router.post('/escrow/:id/release', requireSep10Ed25519, handler);
router.post('/escrow/:id/dispute', requireSep10Ed25519, handler);
```

#### Validation steps

1. Extract `Authorization: Bearer <token>` header — `401` if missing.
2. Decode header to check `alg`. If `EdDSA`, fetch the anchor public key from stellar.toml.
3. Convert the Stellar G… key to a PEM-encoded SubjectPublicKeyInfo DER structure.
4. Verify the JWT signature with `jsonwebtoken` using the EdDSA algorithm.
5. Validate expiry — `401` with `"SEP-10 JWT has expired"` if expired.
6. Validate `sub` claim — must be a valid Stellar G… or M… public key (optionally `key:memo`).
7. Attach `req.sep10 = { sub, account, memo }` and call `next()`.

#### Error responses

| Condition | Status | Body |
|---|---|---|
| Missing `Authorization` header | 401 | `{ "error": "missing Authorization: Bearer <sep10-jwt> header" }` |
| Expired token | 401 | `{ "error": "SEP-10 JWT has expired" }` |
| Tampered / invalid signature | 401 | `{ "error": "SEP-10 JWT verification failed: <reason>" }` |
| Invalid `sub` (not a Stellar key) | 401 | `{ "error": "sub account <key> is not a valid Stellar public key" }` |
| stellar.toml unreachable | 503 | `{ "error": "unable to fetch anchor public key: <reason>" }` |

#### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANCHOR_DOMAIN` | No | `config.homeDomain` | Domain to fetch stellar.toml from |
| `JWT_SECRET` | Yes | — | Shared secret for HS256 tokens (SEP-12/31) |
| `SEP10_SIGNING_SEED` | Yes | — | Stellar signing key seed (never hardcoded) |

#### Testing cache behaviour

The TOML key cache is exported as `tomlKeyCache` and can be injected in tests:

```ts
import { setTomlKeyCache } from './middleware/sep10';

// Pre-seed the cache so tests don't make real HTTP requests
setTomlKeyCache({ publicKey: 'G...', expiresAt: Date.now() + 3_600_000 });

// Clear between tests
setTomlKeyCache(null);
```
