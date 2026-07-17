# AfroPay SEP Compliance Audit

- **Date:** 2026-07-17
- **Scope:** SEP-1 (stellar.toml), SEP-10 (Web Authentication), SEP-31 (Cross-Border Payments), plus SEP-12 (KYC) as a hard dependency of SEP-31. SEP-6 and SEP-24 are out of scope (AfroPay's primary flow is SEP-31; see issue #42).
- **Method:** Requirement-by-requirement review against the SEP specifications, followed by conformance verification with the official [`@stellar/anchor-tests`](https://github.com/stellar/stellar-anchor-tests) suite v0.6.22.
- **References:** [SEP-1], [SEP-10], [SEP-12], [SEP-31].

[SEP-1]: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md
[SEP-10]: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
[SEP-12]: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0012.md
[SEP-31]: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md

## Executive summary

**The audit's central finding is that, at the time of review, this repository contained no anchor API at all.** The repository held only the Soroban escrow contract (`src/`, `contracts/`); the `api/` directory, SEP-10 middleware, and stellar.toml referenced in issue #42 did not exist in the codebase or its git history. Every SEP-1, SEP-10, and SEP-31 requirement was therefore **Non-Compliant** (endpoint absent), and remediation consisted of implementing the anchor API surface from scratch rather than patching an existing one.

Post-remediation, the implementation in `api/` passes the full `stellar-anchor-tests` suites for SEP-1, SEP-10, SEP-12, and SEP-31 (42/42 tests; one SEP-10 signer test depends on the public testnet friendbot and can fail transiently on faucet outages — CI retries once).

Statuses below are given as *pre-remediation → post-remediation*.

## SEP-1 — stellar.toml

| # | Requirement | Pre | Post | Notes |
|---|-------------|-----|------|-------|
| 1.1 | TOML served at `https://<home domain>/.well-known/stellar.toml` | Non-Compliant (absent) | Compliant | `public/.well-known/stellar.toml`, served by `api/app.ts` |
| 1.2 | Served with CORS header `Access-Control-Allow-Origin: *` | Non-Compliant | Compliant | Global CORS middleware in `api/app.ts` |
| 1.3 | Served with `Content-Type: text/plain` | Non-Compliant | Compliant | `res.type("text/plain")` |
| 1.4 | File size < 100KB | Non-Compliant | Compliant | ~1KB; enforced by `scripts/validate-stellar-toml.mjs` |
| 1.5 | `NETWORK_PASSPHRASE` present and valid | Non-Compliant | Compliant | Testnet passphrase (project is in testnet phase); must be rotated for mainnet |
| 1.6 | `SIGNING_KEY` present, valid ed25519 public key | Non-Compliant | Compliant | Testnet-only key; rotate for mainnet |
| 1.7 | `WEB_AUTH_ENDPOINT` present, HTTPS, no trailing slash | Non-Compliant | Compliant | |
| 1.8 | `DIRECT_PAYMENT_SERVER` present (required for SEP-31) | Non-Compliant | Compliant | |
| 1.9 | `KYC_SERVER` present (required for SEP-12) | Non-Compliant | Compliant | |
| 1.10 | `CURRENCIES` section with valid `code`/`issuer` | Non-Compliant | Compliant | USDC (Circle testnet issuer) |
| 1.11 | `DOCUMENTATION` / `PRINCIPALS` org info | Non-Compliant | Compliant | |
| 1.12 | No hardcoded anchor endpoints elsewhere in the stack | N/A (no stack) | Compliant | `api/config.ts` parses stellar.toml and derives every endpoint (including Express mount paths) from it |

## SEP-10 — Web Authentication

| # | Requirement | Pre | Post | Notes |
|---|-------------|-----|------|-------|
| 10.1 | `GET <WEB_AUTH_ENDPOINT>` returns `{transaction, network_passphrase}` | Non-Compliant (absent) | Compliant | `api/routes/sep10.ts` |
| 10.2 | Challenge tx: source = `SIGNING_KEY`, sequence 0, time-bounded (900s) | Non-Compliant | Compliant | Built with `WebAuth.buildChallengeTx` |
| 10.3 | First operation: `manage_data` `<home_domain> auth` with 48-byte base64 nonce, source = client account | Non-Compliant | Compliant | SDK-built |
| 10.4 | `web_auth_domain` manage_data operation, source = server account | Non-Compliant | Compliant | SDK-built |
| 10.5 | `account` parameter required; must be valid G/M address; 400 with `{"error": ...}` otherwise | Non-Compliant | Compliant | |
| 10.6 | `memo` parameter: 64-bit integer only, rejected for muxed (M) accounts | Non-Compliant | Compliant | |
| 10.7 | `home_domain` parameter validated against server's home domain | Non-Compliant | Compliant | |
| 10.8 | `client_domain`: unsupported servers must return 400 | Non-Compliant | Compliant | Client attribution deliberately not supported; documented 400 |
| 10.9 | `POST <WEB_AUTH_ENDPOINT>` accepts JSON and form-encoded `transaction` | Non-Compliant | Compliant | |
| 10.10 | Server verifies its own signature and challenge structure (seq 0, timebounds, domains) | Non-Compliant | Compliant | `WebAuth.readChallengeTx` |
| 10.11 | Existing accounts: signatures must meet medium threshold using ledger signers | Non-Compliant | Compliant | Horizon lookup + `verifyChallengeTxThreshold` |
| 10.12 | Non-existent accounts: challenge must be signed by master key only; extra signatures rejected | Non-Compliant | Compliant | `verifyChallengeTxSigners` |
| 10.13 | Success returns `{"token": <JWT>}`; JWT has `iss`, `sub`, `iat`, `exp`, `jti` | Non-Compliant | Compliant | `sub` is `G...`, `G...:memo`, or `M...`; `jti` = challenge tx hash |
| 10.14 | Errors returned as 400 `{"error": "..."}` | Non-Compliant | Compliant | |
| 10.15 | Protected SEP endpoints reject missing/invalid JWT with 403 | Non-Compliant | Compliant | `api/middleware/sep10.ts` |

## SEP-12 — KYC (dependency of SEP-31)

SEP-12 was not listed in issue #42 but is a hard dependency of SEP-31 (`sender_id`/`receiver_id` must reference SEP-12 customers, and `stellar-anchor-tests` requires a `KYC_SERVER` to run the SEP-31 suite). A minimal conformant implementation is included.

| # | Requirement | Pre | Post | Notes |
|---|-------------|-----|------|-------|
| 12.1 | `GET /customer` status lookup by `id` or SEP-10 token; `NEEDS_INFO` schema with `fields` | Non-Compliant (absent) | Compliant | `api/routes/sep12.ts` |
| 12.2 | `PUT /customer` creates/updates customers (JSON, form, multipart); returns 202 `{id}` | Non-Compliant | Compliant | |
| 12.3 | Memos differentiate customers registered by the same account | Non-Compliant | Compliant | |
| 12.4 | `DELETE /customer/:account` with account-match authorization | Non-Compliant | Compliant | |
| 12.5 | All endpoints require SEP-10 JWT (403 otherwise) | Non-Compliant | Compliant | |

## SEP-31 — Cross-Border Payments

| # | Requirement | Pre | Post | Notes |
|---|-------------|-----|------|-------|
| 31.1 | `GET /info` with `receive` object: `enabled`, min/max amounts, fees, `sep12` sender/receiver types, optional `fields.transaction` | Non-Compliant (absent) | Compliant | `api/routes/sep31.ts` |
| 31.2 | `POST /transactions` requires SEP-10 JWT (403 otherwise) | Non-Compliant | Compliant | |
| 31.3 | Field validation: `asset_code` supported, `amount` within min/max — 400 `{"error": ...}` | Non-Compliant | Compliant | |
| 31.4 | Customer validation: unknown/incomplete `sender_id`/`receiver_id` → 400 `{"error": "customer_info_needed"}` | Non-Compliant | Compliant | |
| 31.5 | Missing required transaction fields → 400 `{"error": "transaction_info_needed", "fields": {...}}` | Non-Compliant | Compliant | |
| 31.6 | Success: 201 `{id, stellar_account_id, stellar_memo_type, stellar_memo}` | Non-Compliant | Compliant | Memo is a unique per-transaction hash |
| 31.7 | `GET /transactions/:id` returns protocol-schema transaction object (status enum, amounts, memo, timestamps, refund info) | Non-Compliant | Compliant | Verified by anchor-tests schema check |
| 31.8 | `GET /transactions/:id`: 404 for unknown IDs and for transactions not created by the authenticated anchor | Non-Compliant | Compliant | |
| 31.9 | `PATCH /transactions/:id` accepts updates only in `pending_transaction_info_update`; rejects unexpected fields | Non-Compliant | Compliant | |
| 31.10 | `PUT /transactions/:id/callback` registers status callback URL | Non-Compliant | Compliant | Callback *delivery* (signed `Signature` header) not yet wired to status transitions — see residual gaps |
| 31.11 | Quotes (SEP-38) integration | N/A | N/A | `quote_id`/`destination_asset` not supported; AfroPay quotes FX via its oracle layer on-chain |

## Verification evidence

Run locally (and in CI via `.github/workflows/sep-compliance.yml`):

```
npx @stellar/anchor-tests --home-domain http://localhost:8000 \
  --seps 1 10 12 31 --asset-code USDC \
  --sep-config ci/anchor-tests-sep-config.json

Tests: 42 passed, 42 total
```

The SEP-10 "Account Signer Support" tests fund throwaway accounts through the public testnet friendbot; a faucet outage can fail one of them transiently. The CI job retries the suite once before failing the build.

## Residual gaps and production notes (tracked, not blocking)

1. **In-memory storage** — `api/store.ts` holds SEP-12 customers and SEP-31 transactions in memory. Production must back this with persistent storage.
2. **Status-transition engine** — transactions are created in `pending_sender`; the off-ramp integration that advances status (and fires the registered callback with a signed `Signature` header per SEP-31) is future work tied to the oracle layer.
3. **`client_domain` (client attribution)** — deliberately unsupported; the server returns the spec-mandated 400. Revisit if wallet partners require it.
4. **Key management** — the committed `SIGNING_KEY` and the CI seed in `sep-compliance.yml` are testnet-only. Mainnet launch requires fresh keys from a secret manager and a pubnet `NETWORK_PASSPHRASE`.
5. **JWT algorithm** — HS256 with a server-side secret (spec-conformant). Rotate `JWT_SECRET` per environment.
