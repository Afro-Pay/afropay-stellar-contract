# AfroPay — STRIDE Threat Analysis

**Version:** 1.0.0  
**Date:** 2026-07-30  
**Status:** Active  
**Authors:** Security Engineering  

---

## How to Read This Document

Each threat entry uses the following fields:

| Field | Description |
|-------|-------------|
| **ID** | Unique threat identifier (TB-{boundary}-{seq}) |
| **Title** | Short name |
| **STRIDE Category** | Spoofing / Tampering / Repudiation / Information Disclosure / Denial of Service / Elevation of Privilege |
| **Description** | What the attacker does and how |
| **Affected Component** | Code file or service |
| **Severity** | Critical / High / Medium / Low (CVSS-lite: Impact × Likelihood) |
| **Current Mitigation** | Controls already in place |
| **Residual Risk** | What remains after mitigations |
| **Issue** | Linked GitHub issue for unmitigated High/Critical threats |

Severity scale:

| Severity | Financial impact | Likelihood |
|----------|-----------------|------------|
| Critical | Full fund drain or permanent lock | Realistic exploit path exists |
| High | Partial fund loss or significant data breach | Plausible with moderate effort |
| Medium | Service degradation or limited data leak | Requires specific conditions |
| Low | Nuisance, no financial impact | Low likelihood or hard to exploit |

---

## Trust Boundary 1 — Browser ↔ API

**Scope:** HTTPS requests from end-users and admin operators to the Express API, including SEP-10 challenge/token flows, escrow creation, and SSE streams.

---

### TB1-001 · JWT Forging via Weak Secret

| Field | Value |
|-------|-------|
| **STRIDE** | Spoofing |
| **Severity** | High |
| **Affected** | `api/middleware/sep10.ts`, `api/routes/sep10.ts` |

**Description:** If `JWT_SECRET` is short, guessable, or leaked (e.g. committed to git, exposed in logs), an attacker can forge arbitrary HS256 SEP-10 tokens and impersonate any Stellar account. The `requireSep10` middleware accepts HS256 tokens for SEP-12/31 endpoints; a valid forged token grants full API access as any user.

**Current Mitigation:** `jwt.verify()` with server-side secret; token includes `exp` claim. Ed25519 variant (`requireSep10Ed25519`) fetches anchor public key from stellar.toml and cannot be forged without the private key.

**Residual Risk:** HS256 tokens remain in use for SEP-12/31 routes. Secret rotation procedure and minimum entropy requirements are not enforced in code. A leaked secret grants permanent impersonation until manually rotated.

**Issue:** [#TM-001](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-001+Enforce+JWT+secret+minimum+entropy+and+rotation+policy) — Enforce minimum 256-bit JWT secret and document rotation runbook.

---

### TB1-002 · SEP-10 Challenge Replay

| Field | Value |
|-------|-------|
| **STRIDE** | Spoofing |
| **Severity** | Medium |
| **Affected** | `api/routes/sep10.ts` — `WebAuth.buildChallengeTx` |

**Description:** A SEP-10 challenge transaction has a time window (`challengeTimeoutSeconds`). If that window is large, a network observer who captures a signed challenge can replay it within the window to obtain a valid JWT for the victim's account.

**Current Mitigation:** `WebAuth.buildChallengeTx` embeds a sequence-number-based nonce and the Stellar SDK's `readChallengeTx` / `verifyChallengeTxSigners` validates it. The `jti` (JWT ID) is set to the transaction hash.

**Residual Risk:** No server-side `jti` denylist — a captured JWT remains valid until expiry. If `jwtExpirySeconds` is long, a stolen JWT cannot be revoked.

**Issue:** [#TM-002](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-002+Add+JWT+jti+denylist+for+logout+and+token+revocation)

---

### TB1-003 · Tampered Payment Parameters (Amount/Corridor)

| Field | Value |
|-------|-------|
| **STRIDE** | Tampering |
| **Severity** | High |
| **Affected** | `api/routes/escrow.ts` — `POST /escrow` |

**Description:** The `POST /escrow` endpoint accepts `amount_usdc` and `corridor` from the request body. An attacker who controls a browser session (XSS, MITM on non-HTTPS leg) can submit a manipulated amount — for example `0.000001` USDC — while the UI displays a legitimate amount to the victim. The API converts it to a `numericAmount` without comparing against a server-computed quote.

**Current Mitigation:** Basic type and positivity checks (`Number.isFinite`, `> 0`). HTTPS in transit. SEP-10 JWT required.

**Residual Risk:** No server-side rate quote binding — the API does not verify that the submitted amount matches a quote it previously issued. An attacker can submit any positive amount.

**Issue:** [#TM-003](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-003+Bind+escrow+creation+to+server-issued+rate+quote)

---

### TB1-004 · Unauthenticated Escrow State Read (Information Disclosure)

| Field | Value |
|-------|-------|
| **STRIDE** | Information Disclosure |
| **Severity** | Low |
| **Affected** | `api/routes/escrow.ts` — `GET /escrow/:id` and `/stream` |

**Description:** `GET /escrow/:id` and the SSE stream endpoint require no authentication. Any party who knows an escrow UUID can poll its state, corridor, and USDC amount. UUIDs are v4 random (128-bit) which makes guessing impractical, but the ID is returned to the browser and may appear in logs or referrer headers.

**Current Mitigation:** UUID v4 (cryptographically random). HTTPS.

**Residual Risk:** Log exposure of escrow IDs; no ownership check on read. Acceptable for MVP; owner-only read should be added before mainnet.

---

### TB1-005 · Denial of Service via SSE Connection Exhaustion

| Field | Value |
|-------|-------|
| **STRIDE** | Denial of Service |
| **Severity** | Medium |
| **Affected** | `api/routes/escrow.ts` — `GET /escrow/:id/stream` |

**Description:** The SSE endpoint opens a long-lived HTTP connection per client. An unauthenticated attacker can open thousands of connections (no auth required on stream endpoint), exhausting file descriptors or memory on the API server and preventing legitimate clients from connecting.

**Current Mitigation:** Heartbeat interval (15 s) helps detect dead connections. Node.js `close` event cleans up subscriptions.

**Residual Risk:** No connection limit per IP, no authentication requirement, no rate limiting on the stream endpoint.

**Issue:** [#TM-005](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-005+Rate-limit+SSE+stream+endpoint+and+require+authentication)

---

### TB1-006 · Admin Privilege Escalation via Weak Role Check

| Field | Value |
|-------|-------|
| **STRIDE** | Elevation of Privilege |
| **Severity** | High |
| **Affected** | `api/routes/admin.ts`, `api/routes/escrow.ts` — `/release` and `/dispute` |

**Description:** `/release` and `/dispute` are gated by `requireSep10Ed25519`, which verifies the JWT is signed by the anchor key from stellar.toml. However, `stellar.toml` is fetched over HTTPS with a 1-hour cache. If the toml file is compromised or the domain hijacked during the cache window, any key can be used to issue valid admin JWTs.

**Current Mitigation:** Ed25519 anchor key fetched from HTTPS stellar.toml; 1-hour cache; StrKey validation on the `sub` claim.

**Residual Risk:** Cache poisoning window of up to 1 hour. No TOFU (trust-on-first-use) pinning of the anchor key.

**Issue:** [#TM-006](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-006+Pin+anchor+signing+key+in+config+and+use+toml+as+secondary+check)


---

## Trust Boundary 2 — API ↔ Soroban

**Scope:** The relayer layer that constructs, signs, and broadcasts Stellar XDR transactions to invoke Soroban contract entry points (`deposit_escrow`, `release_to_agent`, `claim_refund`, `register_oracle`, `set_paused`).

---

### TB2-001 · Relayer Private Key Compromise

| Field | Value |
|-------|-------|
| **STRIDE** | Spoofing |
| **Severity** | Critical |
| **Affected** | API relayer key (env var), `src/contract.rs` — all entry points |

**Description:** The relayer signs all Soroban transactions with an Ed25519 private key stored as an environment variable. If this key is leaked (misconfigured secret manager, container image introspection, debug log), an attacker can submit arbitrary contract invocations — including `deposit_escrow` on behalf of any `sender` address that has pre-authorized the contract, or `claim_refund` on any Refundable escrow.

**Current Mitigation:** `sender.require_auth()` in `deposit_escrow` means the contract requires the *sender's* signature, not just the relayer's. The relayer key alone cannot drain escrows — each escrow is auth-gated to the original sender's key.

**Residual Risk:** Relayer key compromise allows submitting malformed or spam transactions, draining transaction fees, and griefing the service. If the relayer is also the oracle operator key, compromise enables `release_to_agent` calls.

**Issue:** [#TM-007](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-007+Separate+relayer+and+oracle+operator+keys+and+use+HSM+or+KMS)

---

### TB2-002 · Oracle Attestation Forgery

| Field | Value |
|-------|-------|
| **STRIDE** | Tampering |
| **Severity** | Critical |
| **Affected** | `src/oracle.rs` — `verify_signature()`, `src/contract.rs` — `release_to_agent()` |

**Description:** `OracleAttestation::verify_signature` currently returns `true` unconditionally (placeholder implementation). If deployed as-is to mainnet, any caller registered as an oracle can submit a fake attestation claiming `delivery_success: true` and release funds to themselves without delivering the fiat payment.

**Current Mitigation:** Oracle operators must be registered by the admin (`register_oracle`). The attestation struct includes an Ed25519 signature field and nonce. The signature verification function is stubbed.

**Residual Risk:** **Verification is not implemented.** Any registered oracle can steal all escrowed funds for any escrow they target. This is a Critical pre-deployment blocker.

**Issue:** [#TM-008](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-008+CRITICAL+Implement+Ed25519+signature+verification+in+OracleAttestation) — **BLOCKER: must be resolved before mainnet.**

---

### TB2-003 · Oracle Attestation Replay

| Field | Value |
|-------|-------|
| **STRIDE** | Tampering |
| **Severity** | High |
| **Affected** | `src/oracle.rs` — `OracleAttestation`, `src/contract.rs` — `release_to_agent()` |

**Description:** Even with proper signature verification, a valid attestation for escrow `A` could be replayed against escrow `B` if the signed message does not uniquely bind the attestation to the escrow. The current message format (`AFROPAY_ATTESTATION|escrow_id|...`) includes the escrow ID, but the contract does not record used nonces.

**Current Mitigation:** Message includes `escrow_id`, `timestamp`, and `nonce` fields. Escrow state machine (`Locked → Released`) prevents double-release of the same escrow.

**Residual Risk:** Nonces are not stored on-chain, so a nonce cannot be checked for uniqueness across different escrows with the same oracle. Timestamp window attacks remain possible if oracle clock drift is large.

**Issue:** [#TM-009](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-009+Store+used+attestation+nonces+on-chain+to+prevent+replay)

---

### TB2-004 · Unauthorized Contract Upgrade / Admin Takeover

| Field | Value |
|-------|-------|
| **STRIDE** | Elevation of Privilege |
| **Severity** | Critical |
| **Affected** | `src/contract.rs` — `set_paused()`, `register_oracle()`, `migrate()` |

**Description:** Admin functions (`set_paused`, `register_oracle`, `migrate`) are gated solely by `info.admin.require_auth()`. If the admin key is a single Ed25519 keypair (rather than multi-sig), its compromise allows an attacker to: pause the contract (locking all funds), register a malicious oracle, or trigger a migration to a backdoored WASM.

**Current Mitigation:** `require_auth()` enforces the admin address. README documents multi-sig intent for treasury management.

**Residual Risk:** Multi-sig is not enforced in code — the contract accepts a single admin address. No on-chain timelock on admin actions. Single point of failure.

**Issue:** [#TM-010](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-010+Enforce+multi-sig+admin+threshold+in+contract+and+add+upgrade+timelock)

---

### TB2-005 · Escrow ID Collision / Counter Predictability

| Field | Value |
|-------|-------|
| **STRIDE** | Tampering |
| **Severity** | Medium |
| **Affected** | `src/contract.rs` — `generate_escrow_id()` |

**Description:** Escrow IDs are generated as `"escrow_{counter}"` using a simple monotonic counter in contract storage. IDs are entirely predictable. An attacker can pre-compute the next escrow ID and front-run a deposit by submitting a transaction that references that ID before the legitimate deposit is confirmed.

**Current Mitigation:** The contract checks for duplicate escrow IDs and the state machine prevents overwriting an existing escrow. Soroban's deterministic execution order within a ledger provides partial ordering.

**Residual Risk:** Front-running within the same ledger is theoretically possible. Predictable IDs can be enumerated by anyone watching on-chain events.

---

### TB2-006 · Repudiation of Contract Invocations

| Field | Value |
|-------|-------|
| **STRIDE** | Repudiation |
| **Severity** | Medium |
| **Affected** | `src/events.rs` — all emitted events |

**Description:** If the off-chain event store (Postgres) diverges from the on-chain Soroban event log (due to listener downtime or missed events), an oracle or relayer could claim a transaction did not occur, and the off-chain records would not definitively refute this.

**Current Mitigation:** `EventEmitter` emits structured on-chain events (`DepositEvent`, `ReleaseEvent`, `RefundEvent`). Horizon listener with checkpoint and gap-detection replay (`horizonStream.ts`). Reconciliation service (`services/reconciliation/`) cross-checks off-chain vs on-chain.

**Residual Risk:** Reconciliation runs periodically; real-time gaps remain. On-chain events are the ground truth but querying them requires Horizon availability.


---

## Trust Boundary 3 — API ↔ Flutterwave / Paystack

**Scope:** Inbound HTTPS webhook POST requests from Flutterwave and Paystack carrying payment status notifications. The API verifies HMAC signatures, enforces idempotency, and updates escrow state or enqueues to the DLQ.

---

### TB3-001 · Webhook Secret Exposure Leading to Forged Events

| Field | Value |
|-------|-------|
| **STRIDE** | Spoofing |
| **Severity** | High |
| **Affected** | `api/webhooks/flutterwave.ts`, `api/webhooks/paystack.ts` |

**Description:** If `FLW_WEBHOOK_SECRET` or `PAYSTACK_SECRET_KEY` is leaked (env var in logs, misconfigured secret manager, source code exposure), an attacker can craft arbitrary webhook payloads with valid HMAC signatures. A forged `charge.completed` event can set an escrow to `pending_stellar` state, causing the API to submit a `deposit_escrow` or `release_to_agent` on-chain without actual fiat delivery.

**Current Mitigation:** HMAC-SHA512 (Flutterwave) and HMAC-SHA256 (Paystack) with `timingSafeEqual`. Secrets loaded from environment variables, not hardcoded. Idempotency store prevents double-processing.

**Residual Risk:** No runtime secret rotation. If a secret is leaked, all historical and future events can be forged until manually rotated. Secret storage security depends entirely on deployment environment.

**Issue:** [#TM-011](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-011+Document+webhook+secret+rotation+procedure+and+add+monitoring+alert)

---

### TB3-002 · Webhook Replay Attack

| Field | Value |
|-------|-------|
| **STRIDE** | Tampering |
| **Severity** | High |
| **Affected** | `api/webhooks/flutterwave.ts`, `api/webhooks/paystack.ts` |

**Description:** A captured legitimate webhook POST (with valid HMAC signature) can be replayed to re-trigger payment processing. For example, a `charge.completed` event for a legitimate payment could be replayed to trigger a second escrow release if idempotency records are cleared or if a different `tx_ref` / `reference` is injected.

**Current Mitigation:** Idempotency store (`api/webhooks/idempotency-store.ts`) keyed on `tx_ref` / `data.reference`. First delivery inserts a record; subsequent deliveries replay the cached 200 response without re-processing.

**Residual Risk:** Idempotency store is currently in-memory (`Map`). On API restart, all idempotency records are lost and replays would be re-processed. No timestamp/age check on webhook delivery.

**Issue:** [#TM-012](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-012+Persist+webhook+idempotency+store+to+Postgres+to+survive+restarts)

---

### TB3-003 · Information Disclosure via Webhook Logs

| Field | Value |
|-------|-------|
| **STRIDE** | Information Disclosure |
| **Severity** | Medium |
| **Affected** | `api/webhooks/flutterwave.ts`, `api/webhooks/paystack.ts` |

**Description:** Failed signature verification logs a truncated hash (`truncatedHash`). While truncated, structured log aggregators (e.g. Datadog, Splunk) that store raw request headers could capture full `verif-hash` or `x-paystack-signature` values, giving an attacker partial oracle information if logs are breached.

**Current Mitigation:** Only the first 8/16 bytes of the header are logged. `timingSafeEqual` prevents timing side-channels.

**Residual Risk:** Raw body and full headers may be logged at DEBUG level by Express middleware elsewhere. No explicit PII scrubbing in log pipeline.

---

### TB3-004 · DLQ Poisoning / Denial of Service

| Field | Value |
|-------|-------|
| **STRIDE** | Denial of Service |
| **Severity** | Medium |
| **Affected** | `services/queue/dlq.ts`, `api/webhooks/flutterwave.ts` |

**Description:** Webhook events for which no escrow record exists are enqueued to the DLQ. An attacker who can send valid-HMAC webhooks (requires secret) with non-existent `tx_ref` values can flood the DLQ with millions of entries, exhausting Redis memory and preventing legitimate unmatched events from being processed.

**Current Mitigation:** HMAC verification is required before enqueuing, limiting this to attackers who know the webhook secret.

**Residual Risk:** No DLQ size limit or TTL enforcement. DLQ overflow would affect legitimate replay processing.

---

### TB3-005 · Repudiation of Off-Ramp Payment Confirmation

| Field | Value |
|-------|-------|
| **STRIDE** | Repudiation |
| **Severity** | High |
| **Affected** | `api/webhooks/flutterwave.ts`, `api/webhooks/paystack.ts`, `api/webhooks/idempotency-store.ts` |

**Description:** If the idempotency store is not durable, AfroPay cannot prove to a user or regulator which webhook events were received and processed. A PSP could claim a payment was confirmed while AfroPay has no record, or vice versa.

**Current Mitigation:** `insertRecord` stores `receivedAt`, `status`, and `responseBody`. DB migration `001_webhook_idempotency.sql` exists for persistent storage.

**Residual Risk:** The in-memory idempotency store in `idempotency-store.ts` is not backed by Postgres in the current implementation — the SQL migration exists but the TypeScript store uses a `Map`. Audit trail is lost on restart.

**Issue:** [#TM-012](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-012+Persist+webhook+idempotency+store+to+Postgres+to+survive+restarts) (same as TB3-002)


---

## Trust Boundary 4 — Relayer ↔ Horizon

**Scope:** The Horizon SSE listener (`services/listener/horizonStream.ts`) subscribing to on-chain events, and the API relayer broadcasting signed XDR transactions via Horizon's REST API. Horizon is a public, unauthenticated API.

---

### TB4-001 · Horizon MITM / DNS Spoofing

| Field | Value |
|-------|-------|
| **STRIDE** | Spoofing |
| **Severity** | High |
| **Affected** | `services/listener/horizonStream.ts`, `api/routes/sep10.ts`, `api/routes/escrow.ts` |

**Description:** All Horizon communication uses `config.horizonUrl` which defaults to `https://horizon-testnet.stellar.org` or the configured mainnet URL. If DNS is poisoned or TLS certificates are not pinned, a MITM attacker can return forged transaction results, fake on-chain confirmations, or feed a poisoned event stream to the listener — causing the API to believe escrows are settled when they are not.

**Current Mitigation:** HTTPS with standard TLS validation. Stellar SDK verifies transaction XDR structure.

**Residual Risk:** No TLS certificate pinning. No fallback to a secondary Horizon instance. A MITM on the Horizon connection can fabricate confirmations with high impact.

**Issue:** [#TM-013](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-013+Add+secondary+Horizon+endpoint+and+document+TLS+pinning+policy)

---

### TB4-002 · Ledger Gap — Missed Events

| Field | Value |
|-------|-------|
| **STRIDE** | Tampering / Repudiation |
| **Severity** | High |
| **Affected** | `services/listener/horizonStream.ts` — gap detection, `services/listener/checkpointStore.ts` |

**Description:** If the SSE stream disconnects and the listener resumes from an outdated checkpoint, ledger events between the last checkpoint and the reconnect point may be missed. A missed `ReleaseEvent` would leave the off-chain database in `Locked` state while funds have already been released on-chain — enabling double-processing or false refund claims.

**Current Mitigation:** `gapAlertThreshold` (default 50 ledgers) triggers a Prometheus counter and structured warning log. Catch-up replay fetches missed transactions from Horizon's `/transactions?cursor=` endpoint. Idempotent DB inserts (`ON CONFLICT DO NOTHING`).

**Residual Risk:** Gap detection and replay rely on Horizon being available. If Horizon itself is unavailable during the gap, catch-up cannot proceed. Gap alert fires but does not auto-pause the service.

---

### TB4-003 · Transaction Fee Exhaustion (DoS on Relayer)

| Field | Value |
|-------|-------|
| **STRIDE** | Denial of Service |
| **Severity** | Medium |
| **Affected** | API relayer account (fee account) |

**Description:** Stellar transactions require a fee paid in XLM. If the relayer's XLM balance is drained (by spam transactions, relayer key misuse, or network fee spikes), the relayer cannot submit new escrow transactions. Pending deposits would be stuck.

**Current Mitigation:** Stellar's fee mechanism (base fee + surge pricing). Prometheus alerting on payment submission metrics.

**Residual Risk:** No automated XLM balance monitoring alert. No fee-bump transaction fallback. No documented minimum XLM balance for operations.

**Issue:** [#TM-014](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-014+Add+XLM+balance+monitoring+alert+and+minimum+balance+runbook)

---

### TB4-004 · Horizon Rate Limiting / Availability DoS

| Field | Value |
|-------|-------|
| **STRIDE** | Denial of Service |
| **Severity** | Medium |
| **Affected** | `services/listener/horizonStream.ts`, `api/routes/escrow.ts` |

**Description:** Public Horizon instances enforce rate limits. If AfroPay's IP is rate-limited (due to high transaction volume, a bug causing request storms, or a targeted attack using AfroPay's IP range), all Horizon interactions — event listening, transaction submission, account lookups — fail simultaneously.

**Current Mitigation:** Reconnect delay with backoff (`reconnectDelayMs`). Prometheus counters for gap alerts.

**Residual Risk:** Single Horizon endpoint configured. No retry with exponential backoff documented. No fallback to a self-hosted Horizon or alternative RPC provider.

---

### TB4-005 · Checkpoint Corruption / Rollback

| Field | Value |
|-------|-------|
| **STRIDE** | Tampering |
| **Severity** | Medium |
| **Affected** | `services/listener/checkpointStore.ts`, Postgres |

**Description:** If a privileged attacker can write to the Postgres checkpoint table (via SQL injection in an unrelated route, compromised DB credentials, or direct DB access), they can roll back the paging token to a past ledger. The listener would replay all events since that point — triggering duplicate state transitions if idempotency is not perfectly enforced.

**Current Mitigation:** Parameterized queries in checkpoint store. Idempotent event inserts (`ON CONFLICT DO NOTHING`).

**Residual Risk:** Postgres access control not audited in this document. Checkpoint rollback would cause noisy duplicate-processing attempts, not fund loss, due to idempotency.


---

## Trust Boundary 5 — Oracle ↔ Rate Providers

**Scope:** The oracle aggregator service (`services/oracle/aggregator.ts`) fetching FX rates from three providers: Stellar DEX order-book (via Horizon), CBN public API, and Flutterwave Rate API. Rates are median-aggregated with outlier rejection and used to validate exchange rates in escrow deposits.

---

### TB5-001 · Rate Provider Manipulation (Oracle Manipulation)

| Field | Value |
|-------|-------|
| **STRIDE** | Tampering |
| **Severity** | High |
| **Affected** | `services/oracle/aggregator.ts`, `services/oracle/providers/stellarDex.ts` |

**Description:** The Stellar DEX provider derives rates from the live order-book mid-price. A well-capitalised attacker can temporarily manipulate the DEX order-book (wash trading, spoofing bids/asks) to skew the reported mid-price. If two of the three providers are manipulated simultaneously, the median shifts enough to pass the 2% outlier threshold, causing escrow deposits to use a fraudulent exchange rate. Users receive less fiat than expected.

**Current Mitigation:** Three-provider median aggregation. Two-pass outlier rejection at 2% deviation threshold. `aggregateStrict` throws `StaleRateError` if data is older than 60 seconds.

**Residual Risk:** Only three providers — a 2-of-3 compromise flips the median. Outlier threshold (2%) is configurable but not enforced as a minimum. Stellar DEX is the most manipulable source (thin order books for NGN/USDC). No circuit breaker that halts deposits when rate deviation is extreme.

**Issue:** [#TM-015](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-015+Add+fourth+rate+provider+and+circuit-breaker+for+extreme+rate+deviation)

---

### TB5-002 · Stale Rate Accepted in Deposit

| Field | Value |
|-------|-------|
| **STRIDE** | Tampering |
| **Severity** | High |
| **Affected** | `services/oracle/aggregator.ts` — `isStale` flag, `api/routes/escrow.ts` |

**Description:** `aggregate()` marks `isStale: true` when the oldest quote exceeds 60 seconds but does not throw — it returns the stale result. If the caller uses `aggregate()` instead of `aggregateStrict()`, a stale rate is silently used. The escrow deposit would lock funds at an outdated exchange rate, potentially giving the sender a worse rate than the market.

**Current Mitigation:** `aggregateStrict()` throws `StaleRateError` for stale rates. Structured warning log emitted when stale. Prometheus counter via `Redis` alert.

**Residual Risk:** It is not enforced in code that all deposit flows use `aggregateStrict()`. A future developer may call `aggregate()` and miss the `isStale` flag.

**Issue:** [#TM-016](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-016+Enforce+aggregateStrict+usage+in+deposit+path+via+linting+or+type+system)

---

### TB5-003 · CBN API Unavailability / Spoofed Response

| Field | Value |
|-------|-------|
| **STRIDE** | Denial of Service / Tampering |
| **Severity** | Medium |
| **Affected** | `services/oracle/providers/cbn.ts` |

**Description:** The CBN public API is unauthenticated and fetched over plain HTTPS without any API key. There is no SLA on this endpoint. A DNS spoof or BGP hijack of `www.cbn.gov.ng` could return crafted rate data. CBN availability outages directly degrade the oracle to 2-provider operation.

**Current Mitigation:** Provider failure is logged and discarded; aggregation continues with remaining providers. `NoRateAvailableError` thrown only when all providers fail.

**Residual Risk:** 2-provider fallback reduces manipulation resistance. No TLS pinning for CBN. No authenticated fallback rate source for NGN.

---

### TB5-004 · All Providers Simultaneously Unavailable

| Field | Value |
|-------|-------|
| **STRIDE** | Denial of Service |
| **Severity** | High |
| **Affected** | `services/oracle/aggregator.ts` — `NoRateAvailableError` |

**Description:** If all three providers are unreachable (network partition, concurrent outages, per-IP rate limiting by Horizon), the aggregator throws `NoRateAvailableError`. If the API propagates this error to the deposit endpoint, no new escrow deposits can be created — a complete service outage for the remittance flow.

**Current Mitigation:** Per-provider `AbortSignal` timeout (5 s default) prevents slow providers from blocking the entire cycle. `NoRateAvailableError` is a typed error that callers can catch.

**Residual Risk:** No last-known-good rate cache with TTL fallback. No alerting on `NoRateAvailableError`. A sustained outage of all providers silently blocks all deposits.

**Issue:** [#TM-017](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-017+Add+last-known-good+rate+cache+and+alert+on+NoRateAvailableError)

---

### TB5-005 · Flutterwave Rate API Key Exposure

| Field | Value |
|-------|-------|
| **STRIDE** | Information Disclosure / Elevation of Privilege |
| **Severity** | Medium |
| **Affected** | `services/oracle/providers/flutterwave.ts` |

**Description:** The Flutterwave rate provider uses an API key. If this key is the same credential used for the payment processing integration (the webhook secret), its exposure compromises both rate fetching and payment webhook verification. Even if separate, a leaked rate API key allows an attacker to make unlimited rate queries, potentially burning quota and causing a DoS on the rate feed.

**Current Mitigation:** API key loaded from environment variable. Separate from `FLW_WEBHOOK_SECRET` (assumed; not enforced).

**Residual Risk:** No explicit enforcement that rate API key and webhook secret are different credentials. No quota monitoring.

---

## High-Severity Unmitigated Threats — Open Issues Summary

The following table lists all **Critical** and **High** severity threats that require active mitigation work. Each must have a linked GitHub issue before the threat model is considered complete.

| Threat ID | Title | Severity | Issue | Status |
|-----------|-------|----------|-------|--------|
| TB2-002 | Oracle Attestation Signature Not Implemented | **Critical** | [#TM-008](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-008+CRITICAL+Implement+Ed25519+signature+verification+in+OracleAttestation) | 🔴 Open — Mainnet Blocker |
| TB2-004 | Single-key Admin — No Multi-sig Enforcement | **Critical** | [#TM-010](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-010+Enforce+multi-sig+admin+threshold+in+contract+and+add+upgrade+timelock) | 🔴 Open |
| TB2-001 | Relayer Key Compromise | **Critical** | [#TM-007](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-007+Separate+relayer+and+oracle+operator+keys+and+use+HSM+or+KMS) | 🔴 Open |
| TB1-001 | JWT Forging via Weak HS256 Secret | High | [#TM-001](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-001+Enforce+JWT+secret+minimum+entropy+and+rotation+policy) | 🟡 Open |
| TB1-003 | Tampered Payment Amount in Deposit | High | [#TM-003](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-003+Bind+escrow+creation+to+server-issued+rate+quote) | 🟡 Open |
| TB1-006 | Anchor Key Cache Poisoning (stellar.toml) | High | [#TM-006](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-006+Pin+anchor+signing+key+in+config+and+use+toml+as+secondary+check) | 🟡 Open |
| TB2-003 | Oracle Attestation Replay (No Nonce Store) | High | [#TM-009](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-009+Store+used+attestation+nonces+on-chain+to+prevent+replay) | 🟡 Open |
| TB3-001 | Webhook Secret Leak → Forged Events | High | [#TM-011](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-011+Document+webhook+secret+rotation+procedure+and+add+monitoring+alert) | 🟡 Open |
| TB3-002 | Webhook Replay (In-memory Idempotency) | High | [#TM-012](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-012+Persist+webhook+idempotency+store+to+Postgres+to+survive+restarts) | 🟡 Open |
| TB3-005 | Repudiation — Idempotency Store Not Durable | High | [#TM-012](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-012+Persist+webhook+idempotency+store+to+Postgres+to+survive+restarts) | 🟡 Open |
| TB4-001 | Horizon MITM / DNS Spoofing | High | [#TM-013](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-013+Add+secondary+Horizon+endpoint+and+document+TLS+pinning+policy) | 🟡 Open |
| TB4-002 | Ledger Gap — Missed Events | High | Accepted — gap detection + replay in place; monitor Prometheus alerts | ✅ Accepted |
| TB5-001 | Rate Provider Manipulation (DEX) | High | [#TM-015](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-015+Add+fourth+rate+provider+and+circuit-breaker+for+extreme+rate+deviation) | 🟡 Open |
| TB5-002 | Stale Rate Used in Deposit | High | [#TM-016](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-016+Enforce+aggregateStrict+usage+in+deposit+path+via+linting+or+type+system) | 🟡 Open |
| TB5-004 | All Rate Providers Unavailable | High | [#TM-017](https://github.com/afropay/afropay-stellar-contract/issues/new?title=TM-017+Add+last-known-good+rate+cache+and+alert+on+NoRateAvailableError) | 🟡 Open |

---

## Accepted Risks

The following threats have been reviewed and accepted for v1 with documented rationale:

| Threat ID | Rationale |
|-----------|-----------|
| TB1-004 | Escrow IDs are v4 UUIDs (128-bit entropy). Acceptable for MVP; owner-only reads will be added before mainnet. |
| TB4-002 | Gap detection + replay + Prometheus alerting is in place. Residual risk is operational noise, not fund loss. |
| TB4-005 | Checkpoint rollback causes noisy replay but not fund loss due to idempotent DB inserts. |
| TB5-003 | CBN API is a supplementary source; 2-provider fallback remains operational. Acceptable until a paid NGN rate feed is procured. |

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-07-30 | Security Engineering | Initial STRIDE analysis — all 5 trust boundaries |

*Related documents: [DFD](./dfd.md) · [Review Process](./README.md)*
