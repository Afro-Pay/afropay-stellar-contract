Summary
Build a structured adversarial test suite (api/tests/adversarial/) that simulates attacker behavior against AfroPay's payment and escrow endpoints: replay attacks, HMAC forgery, sequence-number manipulation, mass-account enumeration, and fee-manipulation attempts. Each scenario must be implemented as a repeatable automated test, not a one-off manual probe.

Background
Security testing at AfroPay is currently limited to basic input validation unit tests. There is no systematic adversarial coverage. A sophisticated attacker targeting a remittance platform would attempt: replaying captured signed requests, submitting crafted fee parameters to underpay fees, enumerating account balances via timing side-channels, and bypassing the idempotency key check via header spoofing. These scenarios must be codified before the platform handles real funds.

Work Required
Implement the following adversarial test scenarios in api/tests/adversarial/:
Replay attack: capture a valid signed payment request and resubmit it — must receive 409 or 400 (idempotency/nonce protection)
HMAC forgery: submit a webhook with a tampered signature — must receive 400
Fee manipulation: submit a payment with a crafted feeOverride field — must receive 400 or fee must be server-computed regardless of input
Account enumeration timing: GET /api/v1/users/:id for existing vs non-existing accounts — response time delta must be < 5 ms (constant-time check)
Rate-limit bypass via header spoofing: attempt to spoof X-Forwarded-For to bypass per-IP limit — must not succeed
Each scenario is an automated Jest/Supertest test, not a manual script.
Document findings and mitigations in docs/security/adversarial-test-report.md.
Scope
In scope:

The 5 adversarial scenarios above as automated tests
Any code fixes needed to make the tests pass (e.g., constant-time comparison, stripping X-Forwarded-For)
Adversarial test report
Out of scope:

Soroban contract adversarial tests (separate issue)
Penetration testing infrastructure (Burp Suite, etc.)
Acceptance Criteria

All 5 adversarial test scenarios are implemented as Jest/Supertest tests and pass in CI

Account enumeration timing test confirms response time delta < 5 ms across 100 paired requests (both existing and non-existing accounts)

X-Forwarded-For spoofing test confirms the rate limiter uses the socket IP (or a trusted proxy IP, configurable) — not the raw header value

Fee manipulation test confirms the server ignores client-supplied fee fields and recomputes from config

docs/security/adversarial-test-report.md documents each scenario, expected outcome, actual outcome, and any remediation applied
Complexity
Very High

Labels
security, testing, typescript, audit, needs-design-review

Relevant Files / Components
api/tests/adversarial/ (to be created)
api/middleware/rateLimit.ts
api/middleware/idempotency.ts
api/routes/payments.ts
docs/security/adversarial-test-report.md (to be created)
Activity