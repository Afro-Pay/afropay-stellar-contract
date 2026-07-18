# ADR-004: Multi-Source Oracle with Median Aggregation

**Date:** 2024-02-05  
**Status:** Accepted  
**Deciders:** AfroPay core team

---

## Context and Problem Statement

AfroPay's escrow contract releases USDC to an off-ramp agent only after an oracle confirms successful local currency delivery. The oracle is also the source of exchange rate data for corridor pricing. Both functions — delivery attestation and rate feeds — must resist single-point-of-failure and manipulation.

The fundamental question is: should AfroPay trust a single oracle operator, or require consensus across multiple independent oracle operators?

---

## Decision Drivers

- **Collusion resistance:** A single oracle can collude with an agent to attest false deliveries and steal sender funds.
- **Availability:** A single oracle going offline would block all in-flight escrows until timeout — a bad user experience and an availability risk.
- **Rate manipulation resistance:** A single rate feed can be manipulated to give the agent a worse exchange rate than the market, effectively front-running the sender.
- **Operational simplicity:** Multiple oracles increase operational complexity — operator onboarding, key management, and dispute resolution.
- **On-chain cost:** Multi-oracle verification consumes more Soroban instruction budget.

---

## Considered Options

1. **Multi-source oracle with median aggregation** — Require N of M registered oracles to attest; use median of attested values
2. **Single trusted oracle per corridor** — Each corridor has one designated oracle operator
3. **Optimistic oracle (UMA-style)** — Single oracle with a challenge/dispute window

---

## Decision Outcome

**Chosen option:** Multi-source oracle with median aggregation

**Rationale:** A single oracle per corridor creates unacceptable collusion and availability risk. The optimistic oracle model introduces a challenge window that conflicts with AfroPay's <10 second settlement target. Median aggregation across N oracles is robust: an attacker must compromise more than half the oracle set to manipulate a delivery attestation or exchange rate.

---

## Pros and Cons of Each Option

### Option 1 — Multi-Source Oracle with Median Aggregation

**Pros:**
- Collusion requires compromising >50% of the oracle set
- Single oracle downtime does not block delivery — remaining oracles can reach quorum
- Median is robust to outliers — one manipulated rate does not skew the result
- Consistent with best practices in DeFi (Chainlink median aggregation, MakerDAO oracle module)

**Cons:**
- Increases Soroban instruction budget per `release_to_agent` call
- Oracle operator onboarding is more complex (multiple parties must co-attest)
- Requires a quorum parameter `M of N` — tuning this correctly is operationally complex
- Aggregation logic adds code surface area to audit

**Reason chosen:** The security benefit justifies the complexity. Instruction budget is manageable within Soroban limits for N ≤ 5.

---

### Option 2 — Single Trusted Oracle Per Corridor

**Pros:**
- Simple to implement and audit
- Low on-chain instruction cost
- Easy operator onboarding

**Cons:**
- Single oracle compromise = theft of all in-flight escrows in that corridor
- Oracle downtime blocks all deliveries until timeout
- No manipulation resistance for exchange rate feeds

**Reason rejected:** Unacceptable single-point-of-failure for a financial protocol.

---

### Option 3 — Optimistic Oracle (UMA-Style)

**Pros:**
- Low gas cost — only one assertion required normally
- Decentralised dispute resolution
- Battle-tested in Ethereum DeFi

**Cons:**
- Challenge window (typically 2 hours) is incompatible with AfroPay's sub-minute settlement target
- Requires a dispute token and token-weighted governance — significant additional complexity
- No existing Soroban implementation; would require significant development effort
- Optimistic model puts the burden of challenging on watchers — not suitable for a remittance product where users expect guarantees at deposit time

**Reason rejected:** Challenge window duration is fundamentally incompatible with remittance UX requirements.

---

## Consequences

### Positive

- Threshold attestation (M-of-N) makes oracle collusion attacks economically costly.
- Median rate aggregation prevents rate manipulation by any single oracle.
- Oracle diversity improves liveness: quorum can be reached even if some oracles are offline.

### Negative

- Requires onboarding multiple oracle operators per corridor before a corridor is live.
- Instruction budget for multi-oracle verification must be profiled — initial estimate is within Soroban limits for N=5.
- If the oracle set grows large, the aggregation algorithm may need to be moved off-chain with only a proof submitted on-chain.

### Neutral

- The current implementation in `src/oracle.rs` supports single-oracle attestation. Multi-oracle aggregation is planned as a follow-on feature (see issue #47). This ADR records the intended design so that the single-oracle MVP does not introduce paths that would be hard to migrate.

---

## References

- [Chainlink — Decentralised Data Feeds](https://docs.chain.link/data-feeds) — Reference for median aggregation design
- [UMA Protocol — Optimistic Oracle](https://docs.umaproject.org/protocol-overview/how-does-umas-oracle-work) — Evaluated and rejected
- [AfroPay oracle protocol spec](../oracle-integration.md)
- Implementation: [`src/oracle.rs`](../../src/oracle.rs)
- Related issue: #39
