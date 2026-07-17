# ADR-002: Escrow-First Payment Model

**Date:** 2024-01-18  
**Status:** Accepted  
**Deciders:** AfroPay core team

---

## Context and Problem Statement

AfroPay needs to move USDC from a sender on Stellar to a recipient via an off-ramp agent who disburses local currency (e.g., NGN, GHS, KES) to the recipient's bank or mobile money account. The core challenge is sequencing: how do we ensure the sender's funds are not released to the agent until delivery is confirmed, while also ensuring the sender cannot reclaim funds while the agent is mid-delivery?

Two fundamentally different approaches were considered: an escrow-first model (lock first, release after attestation) and a direct atomic swap model (release and deliver simultaneously). This decision determines the trust model, attack surface, and the role of oracles in the protocol.

---

## Decision Drivers

- **Sender protection:** The sender must not lose funds if the off-ramp agent fails to deliver.
- **Agent protection:** The agent must be assured of payment if they successfully deliver local currency.
- **Trustlessness:** Neither the sender nor the agent should need to trust the other party.
- **Oracle role:** The delivery confirmation mechanism must be resistant to false attestation.
- **Timeout handling:** If an agent disappears mid-delivery, the sender must be able to recover funds automatically.
- **Simplicity:** The model must be implementable within Soroban's instruction limits.

---

## Considered Options

1. **Escrow-first** — Sender locks USDC in contract; oracle attests delivery; funds released to agent
2. **Direct atomic swap** — On-chain USDC release is atomic with off-chain local currency delivery via a cross-ledger protocol
3. **Payment channel** — Pre-funded bidirectional channel between sender and agent; settled off-chain

---

## Decision Outcome

**Chosen option:** Escrow-first

**Rationale:** Atomic cross-ledger swaps are technically complex and require the off-ramp side to also be on a programmable ledger, which is not feasible for mobile money systems (M-Pesa, bank rails). Payment channels require pre-funding by agents. The escrow model is well-understood, implementable in Soroban, and provides clear recourse paths for both parties.

---

## Pros and Cons of Each Option

### Option 1 — Escrow-First

**Pros:**
- Sender funds are locked until delivery is confirmed — sender cannot be front-run
- Agent knows payment is guaranteed once they deliver (oracle attestation sufficient)
- Timeout mechanism (`timeout_ledger`) provides automatic refund without manual intervention
- Clear state machine: `Locked → Released | Refundable → Refunded`
- Simple to audit and formally verify

**Cons:**
- Funds are temporarily locked and unavailable to both parties during delivery window
- Requires a trusted oracle to attest delivery — oracle compromise is a risk
- Agent bears the risk of delivering before attestation confirms on-chain

**Reason chosen:** The cons are well-understood and mitigated (multi-oracle in ADR-004, timeout for lock-up risk).

---

### Option 2 — Direct Atomic Swap

**Pros:**
- Truly trustless — no oracle required
- No lock-up period

**Cons:**
- Requires the receiving side (mobile money, bank rail) to also support on-chain coordination — not feasible for existing African financial infrastructure
- Cross-chain atomic swaps introduce complexity in failure/partial-fill scenarios
- Hash time-locked contracts (HTLCs) require both parties to be online simultaneously

**Reason rejected:** Incompatible with existing off-ramp infrastructure. African mobile money systems (M-Pesa, MTN MoMo) do not expose programmable settlement interfaces.

---

### Option 3 — Payment Channel

**Pros:**
- High throughput for repeated agent-sender pairs
- Low on-chain footprint

**Cons:**
- Requires agents to pre-fund channels, locking capital
- Complex dispute and closure mechanics
- Unsuitable for one-off or infrequent remittances (most of AfroPay's use case)
- Not supported natively by Soroban at this time

**Reason rejected:** Capital inefficiency and complexity are not appropriate for the initial product.

---

## Consequences

### Positive

- The escrow model is battle-tested in TradFi (letters of credit, escrow agents) and DeFi.
- Sender has a clear refund path via `claim_refund()` after `timeout_ledger`.
- Agent registration (`register_oracle()`) creates an auditable set of trusted operators.
- On-chain state machine transitions are simple to test and formally reason about.

### Negative

- USDC is illiquid during the delivery window (minutes to hours). For high-volume senders this has a carrying cost.
- Oracle collusion could result in premature fund release without actual delivery — mitigated by multi-oracle design (ADR-004).
- Agent must trust that the oracle will attest accurately; agent bears local currency delivery risk.

### Neutral

- The `Refundable` intermediate state (entered on oracle delivery failure) allows the sender to reclaim funds without waiting for timeout, improving UX in confirmed failure cases.

---

## References

- [AfroPay Contract Design](../contract-design.md) — Full state machine diagram
- [ADR-004](ADR-004-multi-source-oracle-median.md) — Oracle design that mitigates oracle collusion risk
- [Escrow state machine — `src/escrow.rs`](../../src/escrow.rs)
- Related issue: #39
