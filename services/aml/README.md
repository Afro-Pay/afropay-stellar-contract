# aml

Rule-based AML/CFT transaction monitoring engine for AfroPay, built to satisfy CBN AML/CFT
Regulations 2022 transaction-monitoring and NFIU SAR-filing requirements.

This is a standalone Rust crate (`std`, not a Soroban contract) since it needs file/S3 I/O and
JSON serialization that the `#![no_std]` escrow contracts in this repo don't use. It has no HTTP
layer yet — `review_queue::pending_review` / `AlertStore::review` are the functions a future
admin API or CLI would call.

## Layout

- `rule_engine.rs` — the pluggable `Rule` trait and `RuleEngine` that evaluates a transaction
  against all registered rules.
- `rules/` — the four required rules: `structuring`, `high_velocity`, `sanctions_screening`,
  `dormant_account`.
- `sanctions_list.rs` — sanctions list model plus `FileSanctionsListSource` /
  `S3SanctionsListSource` loaders wrapped in `CachedSanctionsList` (1h default TTL).
- `alerts.rs` — `AlertStore`, an insert-only event log (mirrors the `escrow_events` audit-trail
  pattern: raising and reviewing an alert both append records, nothing is mutated in place).
- `review_queue.rs` — folds the alert log into current-state views for admin review
  (open/escalated/dismissed).
- `sar.rs` — builds a `SuspiciousActivityReport` from a reviewed alert and exports it as JSON
  (validated in tests against `docs/compliance/nfiu-sar-schema.json`) or CSV.

## Usage

```rust
use aml::{default_rule_engine, RuleConfig, EvaluationContext, AlertStore, SanctionsList};

let engine = default_rule_engine(RuleConfig::default());
let sanctions = SanctionsList::default(); // or CachedSanctionsList::get()
let mut store = AlertStore::new();

let ctx = EvaluationContext { transaction: &tx, sender_history: &history, sanctions_list: &sanctions };
for draft in engine.evaluate(&ctx) {
    store.raise(format!("alert-{}", tx.id), &draft, tx.sender_id.clone(), tx.completed_at);
}
```

## Testing

```bash
cd services/aml
cargo test
```
