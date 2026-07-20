# API Middleware

This directory contains Express middleware modules used by the AfroPay anchor API.

---

## `sep10.ts` — SEP-10 Authentication

Implements two variants of [SEP-10 Web Authentication](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md) JWT verification.

### `requireSep10` — HS256 shared-secret (SEP-12 / SEP-31 gate)

Verifies JWTs signed with the server's own `JWT_SECRET` (HS256 algorithm). Used to protect SEP-12 KYC and SEP-31 direct-payment endpoints. Returns `403` on failure.

```ts
import { requireSep10 } from './middleware/sep10';

router.get('/customer', requireSep10, handler);
```

### `requireSep10Ed25519` — Ed25519 anchor-key (escrow release / dispute gate)

Verifies JWTs signed with the anchor's Ed25519 private key. The public key is fetched from the anchor's `stellar.toml` at `ANCHOR_DOMAIN` and cached in-process for **1 hour** to avoid a round-trip on every request. Returns `401` on failure.

This provides defence-in-depth for the most sensitive contract interactions: even if an attacker knows an `escrow_id`, they cannot trigger a release or dispute without a valid SEP-10 JWT proving control of the anchor account.

```ts
import { requireSep10Ed25519 } from './middleware/sep10';

router.post('/api/v1/escrow/:id/release', requireSep10Ed25519, handler);
router.post('/api/v1/escrow/:id/dispute', requireSep10Ed25519, handler);
```

#### Verification flow

1. Extract `Authorization: Bearer <token>` header — `401` if missing.
2. Decode the JWT header (no verification yet) to read the `alg` field.
3. If `alg === "EdDSA"`: fetch the anchor public key from `stellar.toml` (TOML cache consulted first).
4. Verify the EdDSA signature using Node.js `crypto.verify` with the raw Ed25519 key bytes.
5. Check the `exp` claim — `401` with `"SEP-10 JWT has expired"` if expired.
6. Validate `sub` claim — must be a valid Stellar G… or M… public key (optionally `key:memo`).
7. Attach `req.sep10 = { sub, account, memo }` and call `next()`.

If `alg` is not `"EdDSA"`, the middleware falls back to HS256 shared-secret verification (for tokens issued by this same server).

#### Error responses

| Condition | Status | Body |
|---|---|---|
| Missing `Authorization` header | 401 | `{ "error": "missing Authorization: Bearer <sep10-jwt> header" }` |
| Expired token | 401 | `{ "error": "SEP-10 JWT has expired" }` |
| Tampered / invalid signature | 401 | `{ "error": "SEP-10 JWT verification failed: invalid signature" }` |
| Malformed token structure | 401 | `{ "error": "SEP-10 JWT verification failed: malformed JWT ..." }` |
| Invalid `sub` (not a Stellar key) | 401 | `{ "error": "sub account <key> is not a valid Stellar public key" }` |
| stellar.toml unreachable | 503 | `{ "error": "unable to fetch anchor public key: <reason>" }` |

#### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANCHOR_DOMAIN` | No (falls back to `HOME_DOMAIN`) | Domain to fetch `stellar.toml` from. Can be `localhost:PORT` for local/test environments. |
| `JWT_SECRET` | Yes | Shared secret for HS256 tokens (SEP-12/31). Never used for EdDSA verification. |
| `SEP10_SIGNING_SEED` | Yes | Stellar secret seed of the anchor's signing keypair. Never hardcoded. |

#### TOML key caching

The anchor's `SIGNING_KEY` is cached in-memory for **1 hour** after the first successful fetch. The cache is keyed on `expiresAt` (epoch ms).

For testing, inject a cache entry without making real HTTP requests:

```ts
import { setTomlKeyCache } from './middleware/sep10';

beforeEach(() => {
  // Pre-seed so tests don't hit a real stellar.toml endpoint
  setTomlKeyCache({
    publicKey: 'G...', // 56-char base32 Stellar public key
    expiresAt: Date.now() + 3_600_000,
  });
});

afterEach(() => setTomlKeyCache(null)); // clear between tests
```

To verify the TOML endpoint is called exactly once within the cache window, point `ANCHOR_DOMAIN` at a local mock server and count requests — see `api/__tests__/sep10.test.ts`.

---

## Integration tests

Run the test suite:

```bash
cd api
npm test
```

The test file `api/__tests__/sep10.test.ts` covers all acceptance criteria:

| Test | Scenario |
|---|---|
| Missing header | `401` with descriptive error on both `/release` and `/dispute` |
| Valid EdDSA token | `200` — escrow transitions to `Released` / `Refundable` |
| Expired token | `401` with `"expired"` in the error message |
| Tampered signature | `401` with `"verification failed"` in the error message |
| TOML caching | `stellar.toml` fetched exactly once for two requests within the 1-hour cache window |
| Unprotected endpoints | `POST /api/v1/escrow` and `GET /api/v1/escrow/:id` work without any token |
