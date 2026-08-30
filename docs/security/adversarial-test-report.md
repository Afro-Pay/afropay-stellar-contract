# Adversarial Test Report

| Issue | #28 |
|-------|-----|
| **Date** | 2026-08-29 |
| **Author** | Security Engineering |
| **Scope** | Payment & escrow API adversarial scenarios + SEP-10 Ed25519 JWT verification |
| **Status** | ✅ All scenarios pass — 143 tests / 13 suites green |

---

## Overview

This report documents the five adversarial test scenarios implemented for Issue #28, plus the
pre-existing SEP-10 Ed25519 JWT verification failures that were discovered and fixed during
implementation.

All tests run as automated Jest/Supertest suites against the in-process Express app. No live
Stellar network or external service is required.

---

## Scenario 1: Replay Attack

**Endpoint:** `POST /api/v1/payments` (via `Idempotency-Key` middleware)

**Attack:** Capture a valid signed payment request and resubmit it with the same
`Idempotency-Key` header.

**Expected outcome:** `409 Conflict` — the server detects the duplicate idempotency key and
rejects the replay.

**Actual outcome:** The server returns `409` with `error: "idempotency_key_already_used"`. The
idempotency middleware checks an in-memory store for previously seen keys and blocks replays
before the handler runs. A GET request with `Idempotency-Key` passes through without recording
the key (idempotency check is only applied to state-mutating methods: POST, PATCH, PUT).

**Remediation applied:** Added `api/middleware/idempotency.ts` — a general-purpose idempotency
middleware mounted on the payment routes. It stores seen keys in a Map (keyed by
`method:url:idempotency-key`) and returns `409` on conflict.

**Test:** `api/tests/adversarial/replayAttack.test.ts` — 4 test cases.

| Test | Result |
|------|--------|
| First request with `Idempotency-Key` returns 201 | ✅ Pass |
| Replay with same `Idempotency-Key` returns 409 | ✅ Pass |
| Replay with different key succeeds | ✅ Pass |
| GET with `Idempotency-Key` is ignored (no replay check) | ✅ Pass |

---

## Scenario 2: HMAC Forgery

**Endpoint:** `POST /webhooks/flutterwave`, `POST /webhooks/paystack`

**Attack:** Submit a webhook payload with a tampered or missing HMAC signature header.

**Expected outcome:** `400 Bad Request` with `error: "invalid_signature"`.

**Actual outcome:** Both webhook handlers return `400` for all tampering variants: wrong
signature value, missing header, empty header, special-character garbage, very long signature
(buffer overflow probe), and cross-body signature mismatch (valid signature for a different body
body is rejected). The existing `timingSafeEqual`-based HMAC verification prevents timing
side-channel attacks on the signature comparison.

**Remediation applied:** None required — the webhook handlers already had secure HMAC
verification using Node's `timingSafeEqual`. The adversarial tests confirm the coverage.

**Test:** `api/tests/adversarial/hmacForgery.test.ts` — 9 test cases across both providers.

| Test | Result |
|------|--------|
| Wrong signature value (Flutterwave) → 400 | ✅ Pass |
| Missing `verif-hash` header → 400 | ✅ Pass |
| Empty `verif-hash` header → 400 | ✅ Pass |
| Non-hex special characters as signature → 400 | ✅ Pass |
| Valid signature for different body → 400 | ✅ Pass |
| Wrong signature value (Paystack) → 400 | ✅ Pass |
| Missing `x-paystack-signature` header → 400 | ✅ Pass |
| Empty signature header → 400 | ✅ Pass |
| Very long signature (buffer overflow probe) → 400 | ✅ Pass |

---

## Scenario 3: Fee Manipulation

**Endpoint:** `POST /transactions` (SEP-31)

**Attack:** Submit a payment with crafted `feeOverride`, `fee`, or `amount_fee` fields to
underpay fees.

**Expected outcome:** `400 Bad Request` — the server rejects client-supplied fee fields and
computes fees from configuration.

**Actual outcome:** The server returns `400` when any fee-related field is present in the
request body. A normal request without fee fields succeeds with the fee computed from
`ASSETS.USDC.fee_fixed` (0.50 USDC). The server-computed fee is deterministic and ignores
client input entirely — the fee field check runs before any other payment validation.

**Remediation applied:** Added an explicit fee field guard to `api/routes/sep31.ts` that rejects
`fee`, `feeOverride`, and `amount_fee` fields with a `400` response before any business logic
runs. The fee is always computed server-side from the asset configuration:
`fee = fee_fixed + (fee_percent / 100) * amount`.

**Test:** `api/tests/adversarial/feeManipulation.test.ts` — 5 test cases.

| Test | Result |
|------|--------|
| Normal payment without fee fields succeeds with server-computed fee | ✅ Pass |
| Payment with `feeOverride` field rejected with 400 | ✅ Pass |
| Payment with `fee` field rejected with 400 | ✅ Pass |
| Payment with `amount_fee` field rejected with 400 | ✅ Pass |
| Server-computed fee matches config (0.50 fixed for USDC) | ✅ Pass |

---

## Scenario 4: Account Enumeration Timing

**Endpoint:** `GET /api/v1/escrow/:id`

**Attack:** Measure response time for existing vs. non-existing escrow IDs to enumerate valid
escrows via a timing side-channel.

**Expected outcome:** Response time delta < 5 ms (constant-time check) across 100 paired
requests.

**Actual outcome:** Both the `404` (non-existing) and `200` (existing) paths execute a dummy
`timingSafeEqual` call that burns equivalent CPU time before returning. The median delta between
both paths was well below 2 ms, and the P95 delta was below 5 ms across all 100 paired
measurements.

**Remediation applied:** Added a constant-time dummy `timingSafeEqual` call to the
`GET /:id` handler in `api/routes/escrow.ts`, ensuring the `404` and `200` paths have
indistinguishable timing from the client's perspective.

**Test:** `api/tests/adversarial/accountEnumerationTiming.test.ts` — 1 test exercising 100
paired requests with a 10-request warm-up phase.

| Test | Result |
|------|--------|
| Median response time delta (existing vs. non-existing) < 5 ms over 100 pairs | ✅ Pass |
| P95 response time delta < 5 ms over 100 pairs | ✅ Pass |

---

## Scenario 5: Rate-Limit Bypass via Header Spoofing

**Endpoint:** Global rate limiter (all routes)

**Attack:** Send requests with spoofed `X-Forwarded-For` headers to bypass the per-IP rate
limit.

**Expected outcome:** Spoofed headers are ignored; the rate limiter uses the socket IP
(`req.socket.remoteAddress`). Rate limit cannot be bypassed by changing headers.

**Actual outcome:** The rate limiter correctly uses `req.socket.remoteAddress` and ignores
`X-Forwarded-For`. Requests with spoofed headers that exceed the limit receive `429`.
Changing the `X-Forwarded-For` value does not reset the counter or create a new rate-limit
bucket. Multiple comma-separated IPs in the header are all ignored.

**Remediation applied:** Created `api/middleware/rateLimit.ts` — a sliding-window in-memory
rate limiter that keys exclusively on `req.socket.remoteAddress` (not `req.ip` and not the
`X-Forwarded-For` header). Mounted globally in `api/app.ts` before all routes.

**Test:** `api/tests/adversarial/rateLimitBypass.test.ts` — 5 test cases.

| Test | Result |
|------|--------|
| Allows up to `maxRequests` from the same IP | ✅ Pass |
| Blocks the 6th request with 429 + `Retry-After` header | ✅ Pass |
| Spoofed `X-Forwarded-For` does not bypass the rate limit | ✅ Pass |
| Spoofed `X-Forwarded-For` with different socket IP treated as new client | ✅ Pass |
| Multiple comma-separated spoofed IPs are all ignored | ✅ Pass |

---

## Pre-Existing Issue Fixed: SEP-10 Ed25519 JWT Verification

**File:** `api/middleware/sep10.ts`

**Discovery:** During implementation of the adversarial suite, the SEP-10 Ed25519 JWT
middleware (`requireSep10Ed25519`) was found to be non-functional. Five tests in
`api/__tests__/sep10.test.ts` were failing.

**Root cause:** `jsonwebtoken` v9 delegates algorithm support to the `jwa` library, which only
handles `RS/PS/ES/HS` algorithm families. When the middleware called
`jwt.verify(token, pem, { algorithms: ['EdDSA'] })`, `jwa` threw
`"Unknown key type \"ed25519\""` — the EdDSA path silently caught this as a generic JWT error
and returned `"SEP-10 JWT is invalid"` regardless of the actual error (including token expiry).

**Fix:** Replaced the `jwt.verify()` call for EdDSA tokens with direct use of Node's built-in
`crypto` module:
1. Split the JWT into `header.payload.signature` parts.
2. Decode the header to detect the `alg: "EdDSA"` marker.
3. Convert the Stellar G… public key to a `KeyObject` via `crypto.createPublicKey()` with a
   DER-encoded SPKI envelope (RFC 8410 `id-Ed25519` OID).
4. Call `crypto.verify(null, signInput, keyObject, sigBytes)` to verify the Ed25519 signature.
5. Manually decode the payload and check the `exp` claim for token expiry.

This approach is fully compatible with `jsonwebtoken` v9 and Node.js ≥ 15 (where Ed25519 was
added to the `crypto` module).

**Tests fixed (11 total):**

| Test | Before | After |
|------|--------|-------|
| POST /release returns 401 without token | ✅ Pass | ✅ Pass |
| POST /dispute returns 401 without token | ✅ Pass | ✅ Pass |
| POST /release returns 200 with valid EdDSA token | ❌ Fail (401) | ✅ Pass |
| POST /dispute returns 200 with valid EdDSA token | ❌ Fail (401) | ✅ Pass |
| POST /release returns 401 with expiry error | ❌ Fail (wrong msg) | ✅ Pass |
| POST /dispute returns 401 with expiry error | ❌ Fail (wrong msg) | ✅ Pass |
| POST /release returns 401 for tampered signature | ✅ Pass | ✅ Pass |
| POST /dispute returns 401 for tampered signature | ✅ Pass | ✅ Pass |
| TOML key cached — fetched exactly once per 1h window | ❌ Fail (401) | ✅ Pass |
| Unprotected POST /api/v1/escrow works without token | ✅ Pass | ✅ Pass |
| Unprotected GET /api/v1/escrow/:id works without token | ✅ Pass | ✅ Pass |

---

## Summary

| Scenario | Test File | Tests | Status | Remediation |
|----------|-----------|-------|--------|-------------|
| Replay Attack | `replayAttack.test.ts` | 4 | ✅ All pass | Idempotency middleware added |
| HMAC Forgery | `hmacForgery.test.ts` | 9 | ✅ All pass | Already mitigated (tests confirm) |
| Fee Manipulation | `feeManipulation.test.ts` | 5 | ✅ All pass | Fee field rejection added to sep31 route |
| Account Enumeration Timing | `accountEnumerationTiming.test.ts` | 1 | ✅ Pass | Constant-time response path added |
| Rate-Limit Bypass | `rateLimitBypass.test.ts` | 5 | ✅ All pass | Socket-IP rate limiter added |
| SEP-10 Ed25519 JWT (pre-existing) | `sep10.test.ts` | 11 | ✅ All pass | Manual Ed25519 verify via Node crypto |

**Total: 143 tests / 13 suites — all green.**

All 5 adversarial scenarios are implemented as automated Jest/Supertest tests and pass in CI.
The pre-existing SEP-10 Ed25519 verification failures have been resolved.
