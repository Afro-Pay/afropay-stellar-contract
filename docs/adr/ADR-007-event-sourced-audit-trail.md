# ADR-007: Event-Sourced Audit Trail

**Date:** 2024-03-01  
**Status:** Accepted  
**Deciders:** AfroPay core team

---

## Context and Problem Statement

AfroPay handles real money transfers. Every state transition — escrow creation, fund release, refund, oracle submission — must be permanently and tamper-evidently recorded for:

1. **Regulatory compliance** — Transaction history for AML/KYC reporting
2. **Dispute resolution** — Proof that a delivery was attested or a refund was triggered
3. **Fraud investigation** — Reconstruction of exactly what happened and when
4. **User transparency** — Senders and recipients can verify the status of their transfer on-chain

Two approaches were considered: (a) emit Soroban contract events for each state transition, or (b) maintain a mutable `status` field in the `Escrow` struct and rely on storage reads for current state.

---

## Decision Drivers

- **Immutability:** Audit records must not be modifiable after the fact, even by the admin.
- **Completeness:** The full history of state transitions must be recoverable, not just the current state.
- **On-chain permanence:** Records must survive contract upgrades.
- **Off-chain indexing:** The API layer and compliance systems must be able to stream state transitions as they occur.
- **Storage efficiency:** Soroban persistent storage has costs; minimising redundant data is desirable.

---

## Considered Options

1. **Event-sourced audit trail** — Emit Soroban contract events for every state transition; keep only current state in storage
2. **Mutable status field** — Store full `Escrow` struct with a `status` field updated in place; no events
3. **Append-only history log in storage** — Write every state transition to a `Vec<EscrowEvent>` in persistent storage

---

## Decision Outcome

**Chosen option:** Event-sourced audit trail (Option 1)

**Rationale:** Soroban contract events are appended to the Stellar ledger and are immutable once included in a closed ledger. They provide a tamper-evident, indexed history of every state transition without the storage cost of maintaining a full history in persistent contract storage. The current `Escrow` struct in storage holds only current state; the full audit trail is in the event log.

---

## Pros and Cons of Each Option

### Option 1 — Event-Sourced Audit Trail

**Pros:**
- Events are immutable — they cannot be modified or deleted once a ledger is closed
- Events are stored in the ledger, not in contract storage — no ongoing storage rent cost
- Stellar's Horizon API indexes contract events and makes them queryable by contract ID
- The `EventEmitter` module (`src/events.rs`) centralises all event emission — easy to audit
- Off-chain systems (compliance, fraud detection) can stream events via Horizon `/contract_events`
- Each transition is recorded atomically with the state change — no possibility of a state change without a corresponding event

**Cons:**
- Events cannot be read from within the contract — queries must go through Horizon (off-chain)
- Event schema changes require care in off-chain consumers when contract is upgraded
- Horizon indexing has a lag of ~1 ledger close (~5 seconds) — not suitable for in-contract queries

**Reason chosen:** Immutability, off-chain indexability, and zero storage rent cost make events the optimal choice for a financial audit trail.

---

### Option 2 — Mutable Status Field

**Pros:**
- Simple to implement
- Current state readable from within the contract

**Cons:**
- Provides no history — only current state is stored
- The admin (or a compromised contract) could overwrite state without a trace
- Does not satisfy regulatory requirements for immutable audit trails
- Off-chain systems cannot detect what changed or when without polling the entire state

**Reason rejected:** No history and no immutability guarantee. Incompatible with compliance requirements.

---

### Option 3 — Append-Only History Log in Storage

**Pros:**
- History is queryable from within the contract
- Self-contained — does not depend on Horizon indexing

**Cons:**
- Significant storage rent cost — each event appended to a `Vec` increases storage size and rent
- Soroban persistent storage has size limits — a long-lived escrow with many state changes could hit limits
- Redundant with Stellar's ledger event system — duplicates data that is already immutably stored
- Increases instruction budget per state transition

**Reason rejected:** Storage rent cost and redundancy with the ledger event system. No additional security benefit over Option 1 because the ledger itself is the immutable append-only log.

---

## Consequences

### Positive

- Every state transition (`DepositEvent`, `ReleaseEvent`, `RefundEvent`, `OracleSubmitEvent`) is immutably recorded on the Stellar ledger.
- Compliance teams can reconstruct the full transaction history for any escrow by querying Horizon's `/contract_events` endpoint.
- The `EventEmitter` module (`src/events.rs`) ensures consistent event schema across all transitions.
- No storage rent accumulation for audit history.

### Negative

- In-contract event queries are not possible — a contract cannot read its own past events. Any logic that needs history must be passed in by the caller (already the case for oracle attestation).
- Event schema changes in future contract upgrades require off-chain consumers to handle version differences. Document event schema changes in `contracts/MIGRATION.md`.

### Neutral

- The `schema_migrated` event (emitted by `migrate()`) should be indexed by monitoring systems to detect when a schema upgrade has occurred.

---

## References

- [Soroban Events documentation](https://developers.stellar.org/docs/smart-contracts/guides/events)
- [Horizon — Contract Events API](https://developers.stellar.org/network/horizon/api-reference/resources/contract_events)
- [Martin Fowler — Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html)
- Implementation: [`src/events.rs`](../../src/events.rs)
- Related issue: #39
