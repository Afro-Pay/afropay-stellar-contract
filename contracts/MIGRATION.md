# Contract Migration Guide

Soroban contracts are upgraded by swapping the WASM bytecode via
`env.deployer().update_current_contract_wasm()`. Storage keys and value types
are **not** changed automatically — any schema change must be applied
explicitly by calling the `migrate()` entry point after the WASM swap.

This document describes the migration framework, how to add a new migration
function, and the testing procedure.

---

## Table of Contents

1. [Overview](#overview)
2. [Storage Key Registry](#storage-key-registry)
3. [SchemaVersion Enum](#schemaversion-enum)
4. [The `migrate()` Entry Point](#the-migrate-entry-point)
5. [How to Add a New Migration](#how-to-add-a-new-migration)
6. [Upgrade Procedure](#upgrade-procedure)
7. [Testing Procedure](#testing-procedure)
8. [CI Integration](#ci-integration)
9. [Version History](#version-history)

---

## Overview

Both contracts implement the same migration pattern:

| Contract | Migration module | Entry point |
|----------|-----------------|-------------|
| RemittanceContract (`src/`) | `src/migration.rs` | `RemittanceContract::migrate(admin)` |
| EscrowContract (`contracts/escrow/`) | `contracts/escrow/src/migration.rs` | `EscrowContract::migrate(admin)` |

Key invariants:

1. **Idempotent** — calling `migrate()` when already at the target version
   returns `Ok(())` without any storage writes.
2. **One-shot per version** — each migration function runs exactly once;
   subsequent calls skip it because the stored `schema_version` advances past
   its trigger point.
3. **Admin-only** — `admin.require_auth()` is called before any storage
   modification. Non-admin callers receive `Unauthorized`.
4. **Ordered** — migrations run in strictly ascending version order.
   Downgrade attempts return an error.
5. **Checkpointed** — the `schema_version` key is written after each
   individual step, so a mid-migration failure leaves storage in a
   consistently partially-migrated state (not a corrupt one).

---

## Storage Key Registry

All keys written to persistent / instance storage are listed here. Any PR
that adds or renames a key must update this table.

### RemittanceContract — Instance Storage

| Key string | Rust type | Since | Notes |
|-----------|-----------|-------|-------|
| `"info"` | `ContractInfo` | V1 | Admin address, pause flag, oracle map, version |
| `"escrows"` | `Map<String, Escrow>` | V1 | All escrow records |
| `"escrow_counter"` | `u64` | V1 | Monotonic escrow ID counter |
| `"schema_version"` | `u32` | V1 | Written by `set_initial_schema_version()` |

### EscrowContract — Instance Storage

| Key string | Rust type | Since | Notes |
|-----------|-----------|-------|-------|
| `"admin"` | `Address` | V1 | Set by `initialize()` |
| `"schema_version"` | `u32` | V1 | Written by `set_initial_schema_version()` |

### EscrowContract — Persistent Storage (per-escrow)

| Key | Rust type | Since | Notes |
|-----|-----------|-------|-------|
| `<escrow_id: String>` | `Escrow` | V1 | Keyed directly by escrow ID string |

---

## SchemaVersion Enum

Both migration modules define a `SchemaVersion` enum. Variants are strictly
ascending integers. The constant `TARGET_VERSION` identifies the version
compiled into the current WASM binary.

```rust
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SchemaVersion {
    V1 = 1,  // initial deployment
    V2 = 2,  // added max_transfer_limit / description field
    // V3 = 3, // future
}

pub const TARGET_VERSION: SchemaVersion = SchemaVersion::V2;
```

**Rules:**
- Do not renumber existing variants.
- Do not remove variants (historical record is important for audits).
- Always update `TARGET_VERSION` when adding a variant.

---

## The `migrate()` Entry Point

```rust
// RemittanceContract
pub fn migrate(env: Env, admin: Address) -> Result<(), RemittanceError>

// EscrowContract
pub fn migrate(env: Env, admin: Address) -> Result<(), EscrowMigrationError>
```

**What it does:**

1. Loads the stored admin address and calls `admin.require_auth()`.
2. Reads the current `schema_version` from instance storage (defaults to `V1`
   for contracts deployed before migration support was added).
3. If already at `TARGET_VERSION`, returns `Ok(())` — **idempotent no-op**.
4. If stored version > target, returns an error — **no downgrade**.
5. Runs each migration step in order (`V1→V2`, then `V2→V3`, etc.),
   writing the intermediate version after each step.
6. Emits a `schema_migrated` event with `(old_version, new_version)` for
   off-chain monitoring.

---

## How to Add a New Migration

Follow these steps exactly. Skipping any step risks data loss on upgrade.

### Step 1 — Add a variant to `SchemaVersion`

```rust
// In src/migration.rs and/or contracts/escrow/src/migration.rs
pub enum SchemaVersion {
    V1 = 1,
    V2 = 2,
    V3 = 3,  // ← new variant
}

pub const TARGET_VERSION: SchemaVersion = SchemaVersion::V3;  // ← update
```

### Step 2 — Implement the migration function

```rust
/// Migration V2 → V3: rename storage key "escrow_counter" to "counter".
fn migrate_v2_to_v3(env: &Env) -> Result<(), RemittanceError> {
    let key_old = Symbol::new(env, "escrow_counter");
    let key_new = Symbol::new(env, "counter");

    if let Some(counter_value) = env.storage().instance().get::<_, u64>(&key_old) {
        env.storage().instance().set(&key_new, &counter_value);
        env.storage().instance().remove(&key_old);
    }
    Ok(())
}
```

### Step 3 — Register in `run_single_migration`

```rust
fn run_single_migration(env: &Env, from: u32, to: u32) -> Result<(), RemittanceError> {
    match (from, to) {
        (1, 2) => migrate_v1_to_v2(env),
        (2, 3) => migrate_v2_to_v3(env),  // ← add this arm
        _ => Err(RemittanceError::OperationFailed),
    }
}
```

### Step 4 — Write a simulation test

Add a test in `contracts/tests/upgrade/simulation_test.rs` that:

1. Deploys the contract and seeds V(N) state.
2. Calls `migrate()`.
3. Asserts all V(N) records are intact under the V(N+1) schema.
4. Asserts new operations work correctly post-migration.

### Step 5 — Update this document

Add a row to the [Version History](#version-history) table below.

### Step 6 — Update the ADR if it is a schema change

If the schema change is significant (new storage keys, renamed types, changed
semantics), update or create an ADR in `docs/adr/`.

---

## Upgrade Procedure

The following steps must be performed by the contract admin for every WASM
upgrade that includes schema changes.

```bash
# 1. Build the new WASM binary
cd contracts/escrow
cargo build --target wasm32-unknown-unknown --release

# 2. Upload the new WASM to the network (Testnet example)
stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/escrow.wasm \
  --source <admin-key> \
  --network testnet

# 3. Upgrade the deployed contract to point at the new WASM hash
stellar contract upgrade \
  --id <contract-id> \
  --wasm-hash <new-wasm-hash> \
  --source <admin-key> \
  --network testnet

# 4. Call migrate() — must be done BEFORE any other entry point in the new binary
stellar contract invoke \
  --id <contract-id> \
  --source <admin-key> \
  --network testnet \
  -- migrate \
  --admin <admin-address>

# 5. Verify schema_version advanced
stellar contract invoke \
  --id <contract-id> \
  --network testnet \
  -- get_schema_version   # if you expose this helper entry point
```

**Important:** `migrate()` must be the **first** call after the WASM swap if
the new binary introduces storage schema changes. Entry points that read
storage before migration completes may encounter unexpected layouts.

---

## Testing Procedure

### Run upgrade simulation tests

```bash
cd contracts/escrow
cargo test --features testutils upgrade -- --nocapture
```

The harness is located at `contracts/tests/upgrade/simulation_test.rs`.

### Run the full test suite after adding a migration

```bash
cd contracts/escrow
cargo test --features testutils -- --nocapture
PROPTEST_CASES=100000 cargo test --features testutils -- --nocapture
```

### Upgrade Regression Test Harness (Issue #29)

The harness in `contracts/tests/upgrade/simulation_test.rs` provides full
regression coverage for every v→v+1 migration pair.

#### What it seeds

Before calling `migrate()`, the harness seeds **5 representative escrow states**
that cover the full state machine:

| State | How it's reached |
|-------|-----------------|
| `Pending` | `create_escrow()` |
| `Funded` | `create_escrow()` → `fund_escrow()` |
| `Disputed` | `create_escrow()` → `fund_escrow()` → `dispute_escrow()` |
| `Released` | `create_escrow()` → `fund_escrow()` → `release_escrow()` |
| `Refunded` | `create_escrow()` → `fund_escrow()` → *(ledger time > timelock)* → `refund_escrow()` |

#### What it asserts post-migration

For each of the 5 records:
- `state` field matches the expected value
- `amount` field is exactly `1_000_000` (unchanged)
- `sender`, `beneficiary`, `arbitrator` party addresses are unchanged
- Relevant timestamp fields (`funded_at`, `disputed_at`, etc.) are preserved

#### What operations it tests post-migration

| Test | Post-migration operation |
|------|--------------------------|
| `test_pending_can_be_funded_after_migration` | `fund_escrow()` on Pending |
| `test_funded_can_be_released_after_migration` | `release_escrow()` on Funded |
| `test_funded_can_be_disputed_after_migration` | `dispute_escrow()` on Funded |
| `test_disputed_can_be_resolved_after_migration` | `resolve_dispute()` on Disputed |
| `test_released_is_terminal_after_migration` | `fund_escrow()` on Released → must fail |
| `test_refunded_is_terminal_after_migration` | `fund_escrow()` on Refunded → must fail |
| `test_create_new_escrow_after_migration` | `create_escrow()` under V2 schema |
| `test_full_lifecycle_post_migration` | Pending→Funded→Released end-to-end |
| `test_dispute_resolve_lifecycle_post_migration` | Funded→Disputed→Resolved end-to-end |

#### Broken migration detection

`test_broken_migration_detected_by_harness` documents and validates that the
harness assertions will catch a faulty `migrate()` that drops or corrupts
storage keys.  A deliberately broken migration (e.g., one that drops an escrow
key) would cause `get_escrow()` to panic with `"Escrow not found"`, surfacing
as a descriptive test failure rather than a silent data loss.

#### Parameterising for a new v→v+1 pair

The `run_upgrade_harness()` helper accepts a `HarnessConfig`:

```rust
pub struct HarnessConfig {
    /// Human-readable label printed in assertion failure messages.
    pub label: &'static str,
}
```

To test a new migration pair (e.g., V2→V3):

1. Create or import the V3 contract type.
2. Instantiate `HarnessConfig { label: "V2 → V3" }`.
3. Call `run_upgrade_harness(&cfg)` — it will deploy, seed, migrate, and assert.
4. Add targeted operation tests for any new fields or behaviours introduced in V3.

### What the simulation tests cover

| Test | Verifies |
|------|---------|
| `test_initialize_sets_schema_v1` | `initialize()` writes V1 schema version |
| `test_all_five_states_intact_after_migration` | All 5 seeded states readable post-migration |
| `test_pending_can_be_funded_after_migration` | Pending→Funded works post-migration |
| `test_funded_can_be_released_after_migration` | Funded→Released works post-migration |
| `test_funded_can_be_disputed_after_migration` | Funded→Disputed works post-migration |
| `test_disputed_can_be_resolved_after_migration` | Disputed→Resolved works post-migration |
| `test_released_is_terminal_after_migration` | Released rejects further transitions |
| `test_refunded_is_terminal_after_migration` | Refunded rejects further transitions |
| `test_create_new_escrow_after_migration` | New records created under V2 schema |
| `test_migrate_is_idempotent` | Second migrate() call is a no-op |
| `test_migrate_rejects_non_admin` | Non-admin receives `Unauthorized` |
| `test_broken_migration_detected_by_harness` | Harness catches faulty migrate() |
| `test_target_version_is_v2` | TARGET_VERSION compile-time assertion |
| `test_full_lifecycle_post_migration` | Pending→Funded→Released end-to-end |
| `test_dispute_resolve_lifecycle_post_migration` | Funded→Disputed→Resolved end-to-end |

---

## CI Integration

The upgrade simulation tests run on every PR that touches `contracts/`:

```yaml
# .github/workflows/escrow-tests.yml (excerpt)
- name: Run upgrade simulation tests
  run: |
    cd contracts/escrow
    cargo test --features testutils upgrade -- --nocapture
```

If you add a new migration, the simulation tests must pass in CI before the PR
can be merged.

---

## Version History

| Version | Date | Description | Migration function |
|---------|------|-------------|--------------------|
| V1 | 2024-01-15 | Initial deployment — `Escrow` struct with 13 fields, `ContractInfo` with 5 fields | *(baseline — no migration needed)* |
| V2 | 2024-03-15 | `EscrowContract`: added `description: Option<String>` to `Escrow`. `RemittanceContract`: advanced `ContractInfo.version` to 2 as a migration proof-of-concept. | `migrate_v1_to_v2` |
