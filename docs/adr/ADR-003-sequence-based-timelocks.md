# ADR-003: Sequence-Number-Based Timelocks

**Date:** 2024-01-22  
**Status:** Accepted  
**Deciders:** AfroPay core team

---

## Context and Problem Statement

The AfroPay escrow contract requires a timelock mechanism: after a configurable window (e.g., 2 hours), the sender can claim a refund if the oracle has not confirmed delivery. The timelock must be resistant to manipulation and must behave deterministically across all validators in the Stellar network.

Two mechanisms are available in Soroban: ledger sequence numbers (`env.ledger().sequence()`) and ledger timestamps (`env.ledger().timestamp()`). This decision has security implications — a manipulable timelock could allow either premature refunds (denying an agent in-flight payment) or permanent fund lock-up.

---

## Decision Drivers

- **Manipulation resistance:** The timelock reference must not be forgeable or subject to validator collusion at the per-block level.
- **Determinism:** Every validator must agree on whether the timelock has expired for a given ledger.
- **Predictability:** Operators and users must be able to predict when a timelock expires.
- **Stellar protocol alignment:** The chosen mechanism must match Stellar's recommended approach for time-sensitive on-chain logic.

---

## Considered Options

1. **Ledger sequence numbers** — Use `env.ledger().sequence()` and count ledgers elapsed
2. **Ledger timestamps** — Use `env.ledger().timestamp()` (Unix seconds) directly

---

## Decision Outcome

**Chosen option:** Ledger sequence numbers

**Rationale:** Stellar validators can and do disagree on wall-clock time at the individual ledger level. The Stellar protocol specification explicitly documents that validator clocks can drift and that `closeTime` (the source of `env.ledger().timestamp()`) may vary by several seconds between ledgers. Sequence numbers, by contrast, are strictly monotonic and agreed-upon by all validators as part of consensus.

> **Stellar spec reference:** The Stellar Consensus Protocol (SCP) closes ledgers approximately every 5 seconds, but the `closeTime` field is set by the validator that proposes the ledger and is only loosely constrained. Per the [Stellar Core documentation on ledger close time](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/ledgers#ledger-header), `closeTime` may be up to several seconds ahead of or behind wall-clock time and is not suitable as a precise timing mechanism for smart contracts. The SCP whitepaper (§4) notes that ledger close times are "not adversarially unpredictable" and can be influenced by the nominating validator within the tolerance window.

At an average ledger close time of ~4.5 seconds:
- 15 ledgers ≈ 1 minute
- 60 timeout minutes × 15 ledgers/minute = 900 ledgers

The code in `src/contract.rs` implements this as:

```rust
let timeout_ledgers = (timeout_minutes as u32) * 60 / 4; // ~15 ledgers per minute
let timeout_ledger = ledger_height
    .checked_add(timeout_ledgers)
    .ok_or(RemittanceError::InvalidTimeout)?;
```

---

## Pros and Cons of Each Option

### Option 1 — Ledger Sequence Numbers

**Pros:**
- Strictly monotonic — no validator can decrease or reuse a sequence number
- Agreed upon by all validators as part of SCP consensus
- No clock-skew attack surface
- Already used by Stellar's native time-lock operations (`MIN_TIME`/`MAX_TIME` in classic transactions use sequence-derived logic in some contexts)
- `checked_add` can prevent overflow (u32 counter)

**Cons:**
- Ledger close time is not constant (averages ~4.5s but can vary); long-duration timelocks accumulate approximation error
- Users see "ledger number" instead of a human-readable timestamp in wallet UIs — requires conversion in the frontend
- Very long timelocks (days) could drift by minutes from wall-clock expectation

**Reason chosen:** The approximation error for 2-hour timelocks is ~±5 minutes — acceptable for remittance use cases. The security benefit of manipulation resistance outweighs the UX inconvenience.

---

### Option 2 — Ledger Timestamps

**Pros:**
- Human-readable expiry (Unix seconds)
- No conversion needed in frontend
- Exact to the second at time of ledger close

**Cons:**
- `closeTime` is set by the proposing validator; it is not adversarially unpredictable within a tolerance window (see Stellar spec note above)
- A colluding or buggy validator could set `closeTime` ahead by several seconds, potentially expiring a timelock earlier than intended
- Stellar's own tooling (e.g., `stellar-sdk`) has historically had subtle bugs related to timestamp-based time bounds
- Does not align with Soroban's recommended best practices, which favour sequence numbers for on-chain logic

**Reason rejected:** The validator clock-skew risk is not acceptable for financial contracts where even a few-second premature expiry could allow an incorrect refund while an agent is mid-delivery.

---

## Consequences

### Positive

- Timelock expiry is deterministic and agreed upon by the entire validator set.
- No attack vector for a single validator to manipulate the expiry window.
- `checked_add` in the implementation prevents silent overflow.

### Negative

- Ledger close time variability means a "2 hour" timeout is an approximation (~±5 minutes over the window).
- The frontend must convert `timeout_ledger` to an estimated wall-clock time for display. Recommended formula: `estimated_expiry = created_at_unix + (timeout_ledgers * 4.5)`.

### Neutral

- The maximum allowed timeout is `MAX_TIMEOUT_LEDGERS = 1,000,000` ledgers ≈ 5 days at 4.5s/ledger, enforced in `contract.rs`.

---

## References

- [Stellar Core — Ledger Header documentation](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/ledgers#ledger-header) — documents `closeTime` semantics and validator clock-skew behaviour
- [Stellar Consensus Protocol whitepaper](https://www.stellar.org/papers/stellar-consensus-protocol) — §4 discusses ledger close time nomination
- [Soroban SDK — `env.ledger().sequence()`](https://docs.rs/soroban-sdk/latest/soroban_sdk/struct.Ledger.html)
- Implementation: [`src/contract.rs`](../../src/contract.rs) — `deposit_escrow` timeout calculation
- Related issue: #36
