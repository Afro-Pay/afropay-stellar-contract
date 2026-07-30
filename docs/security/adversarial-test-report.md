# Adversarial Test Report

| Issue | #28 |
|-------|-----|
| **Date** | 2026-07-27 |
| **Author** | Security Engineering |
| **Scope** | Payment & escrow API adversarial scenarios |

---

## Scenario 1: Replay Attack

**Endpoint:** POST /api/v1/payments (via Idempotency-Key middleware)

**Attack:** Capture a valid signed payment request and resubmit it with the same `Idempotency-Key` header.

**Expected outcome:** 409 Conflict — the server detects the duplicate idempotency key and rejects the replay.

**Actual outcome:** The server returns 409 with `error: "idempotency_key_already_used"`. The idempotency middleware (added in this issue) checks an in-memory store for previously seen keys and blocks replays before the handler runs.

**Remediation applied:** Added `api/middleware/idempotency.ts` — a general-purpose idempotency middleware mounted on the payment routes. It stores seen keys in a Map and returns 409 on conflict.

**Test:** `api/tests/adversarial/replayAttack.test.ts` — 4 test cases covering first use, replay, different-key-with-same-body, and GET passthrough.

---

## Scenario 2: HMAC Forgery

**Endpoint:** POST /webhooks/flutterwave, POST /webhooks/paystack

**Attack:** Submit a webhook payload with a tampered or missing HMAC signature header.

**Expected outcome:** 400 Bad Request with `error: "invalid_signature"`.

**Actual outcome:** Both webhook handlers return 400 for all tampering variants: wrong signature, missing header, empty header, binary garbage, very long signature (buffer overflow probe), and cross-body signature mismatch. The existing `timingSafeEqual`-based HMAC verification prevents timing side-channel attacks on the signature.

**Remediation applied:** None required — the webhook handlers already had secure HMAC verification using Node's `timingSafeEqual`. The adversarial tests confirm the coverage.

**Test:** `api/tests/adversarial/hmacForgery.test.ts` — 9 test cases across both providers.

---

## Scenario 3: Fee Manipulation

**Endpoint:** POST /transactions (SEP-31)

**Attack:** Submit a payment with crafted `feeOverride`, `fee`, or `amount_fee` fields to underpay fees.

**Expected outcome:** 400 Bad Request — the server rejects client-supplied fee fields and computes fees from configuration.

**Actual outcome:** The server returns 400 when any fee-related field is present in the request body. A normal request without fee fields succeeds with fee computed from `ASSETS.USDC.fee_fixed` (0.50 USDC). The server-computed fee is deterministic and ignores client input.

**Remediation applied:** Added an explicit fee field check to `api/routes/sep31.ts` that rejects `fee`, `feeOverride`, and `amount_fee` fields with a 400 response. The fee is always computed server-side from the asset configuration.

**Test:** `api/tests/adversarial/feeManipulation.test.ts` — 5 test cases covering rejection of each fee field variant and verification of server-computed fee.

---

## Scenario 4: Account Enumeration Timing

**Endpoint:** GET /api/v1/escrow/:id

**Attack:** Measure response time for existing vs. non-existing escrow IDs to enumerate valid escrows via a timing side-channel.

**Expected outcome:** Response time delta < 5ms (constant-time check) across 100 paired requests.

**Actual outcome:** Both the 404 (non-existing) and 200 (existing) paths execute a dummy `timingSafeEqual` call that burns equivalent CPU time before returning. The delta between average response times was below 2ms, and the max delta was below 5ms.

**Remediation applied:** Added a constant-time dummy `timingSafeEqual` call to the GET /:id handler in `api/routes/escrow.ts`, ensuring the 404 and 200 paths have indistinguishable timing.

**Test:** `api/tests/adversarial/accountEnumerationTiming.test.ts` — 1 test that runs 100 paired requests and asserts max delta < 5ms and average delta < 2ms.

---

## Scenario 5: Rate-Limit Bypass via Header Spoofing

**Endpoint:** Global rate limiter

**Attack:** Send requests with spoofed `X-Forwarded-For` headers to bypass the per-IP rate limit.

**Expected outcome:** Spoofed headers are ignored; the rate limiter uses the socket IP (`req.socket.remoteAddress`). Rate limit cannot be bypassed.

**Actual outcome:** The rate limiter correctly uses `req.socket.remoteAddress` and ignores `X-Forwarded-For`. Requests with spoofed headers that exceed the limit receive 429. Changing the `X-Forwarded-For` value does not reset the counter. Multiple comma-separated IPs in the header are also ignored.

**Remediation applied:** Created `api/middleware/rateLimit.ts` — a sliding-window in-memory rate limiter that keys on `req.socket.remoteAddress` (not `req.ip` and not the X-Forwarded-For header). Mounted globally in `api/app.ts`.

**Test:** `api/tests/adversarial/rateLimitBypass.test.ts` — 5 test cases covering limit enforcement, single-IP bypass attempt, multi-IP bypass attempt, and cross-socket-IP behavior.

---

## Summary

| Scenario | Status | Remediation |
|----------|--------|-------------|
| Replay Attack | Pass | Idempotency middleware added |
| HMAC Forgery | Pass | Already mitigated (tests confirm) |
| Fee Manipulation | Pass | Fee field rejection added |
| Account Enumeration Timing | Pass | Constant-time response added |
| Rate-Limit Bypass | Pass | Socket-IP rate limiter added |

All 5 adversarial scenarios are now implemented as automated Jest/Supertest tests and pass in CI.
