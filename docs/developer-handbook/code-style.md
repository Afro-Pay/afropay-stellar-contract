# AfroPay Developer Handbook — Code Style & Conventions

This document defines the coding standards, linting rules, commit format, and naming conventions for the AfroPay codebase. All contributors are expected to follow these rules. CI enforces them automatically.

---

## Table of Contents

1. [Rust Formatting](#rust-formatting)
2. [Clippy Rules](#clippy-rules)
3. [Soroban-Specific Conventions](#soroban-specific-conventions)
4. [Storage Key Naming Conventions](#storage-key-naming-conventions)
5. [Error Code Allocation](#error-code-allocation)
6. [Documentation Standards](#documentation-standards)
7. [Commit Message Format](#commit-message-format)
8. [Naming Conventions](#naming-conventions)

---

## Rust Formatting

AfroPay uses the default `rustfmt` configuration. No custom `rustfmt.toml` is committed.

**Run before every commit:**

```bash
cargo fmt
```

**Verify in CI:**

```bash
cargo fmt -- --check
```

Key defaults to be aware of:

- Indentation: 4 spaces (no tabs)
- Max line width: 100 characters
- Trailing commas in multi-line expressions
- Import groups: std, external crates, local crate — one blank line between groups

---

## Clippy Rules

The project enforces a strict Clippy configuration. All warnings are treated as errors in CI:

```bash
cargo clippy --all-targets -- -D warnings
# For the escrow sub-crate with testutils:
cd contracts/escrow
cargo clippy --all-targets --features testutils -- -D warnings
```

### Enforced Lints

| Lint | Reason |
|------|--------|
| `clippy::unwrap_used` | `unwrap()` panics in on-chain code are catastrophic; use `?` or `map_err` |
| `clippy::expect_used` | Same rationale as `unwrap_used` |
| `clippy::panic` | Panics in contract code can lock funds; use typed errors |
| `clippy::integer_arithmetic` | Overflow in amount/ledger calculations silently corrupts state |
| `clippy::pedantic` | General quality; individual allows permitted with a comment |

### Suppressing a Lint

If you must suppress a lint, add an `#[allow(...)]` attribute with a comment explaining why:

```rust
// ALLOW: This branch is provably unreachable because EscrowState is sealed
// and all variants are matched above.
#[allow(clippy::unreachable)]
_ => unreachable!(),
```

Suppressing `clippy::unwrap_used` or `clippy::panic` in non-test code requires maintainer approval in the PR review.

---

## Soroban-Specific Conventions

### No Standard Library

All on-chain Rust files begin with `#![no_std]`. Do not import `std::*` in contract code.

```rust
#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, Symbol};
```

### Auth Guards

Every entry point that mutates contract state must call `require_auth()` on the appropriate address before reading or writing storage:

```rust
pub fn register_oracle(env: Env, oracle: Address) -> Result<(), RemittanceError> {
    let mut info: ContractInfo = env.storage().instance()
        .get(&Symbol::new(&env, "info"))
        .ok_or(RemittanceError::NotInitialized)?;

    info.admin.require_auth();  // ← must be first meaningful line after input loading
    // ... rest of logic
}
```

### Error Handling

- Never use `unwrap()`, `expect()`, or `panic!()` in non-test code.
- Use `ok_or(RemittanceError::X)?` when converting `Option` to `Result`.
- Use `map_err(|_| RemittanceError::X)?` when converting foreign errors.

```rust
// ✅ correct
let info: ContractInfo = env.storage().instance()
    .get(&Symbol::new(&env, "info"))
    .ok_or(RemittanceError::NotInitialized)?;

// ❌ wrong — panics on-chain
let info: ContractInfo = env.storage().instance()
    .get(&Symbol::new(&env, "info"))
    .unwrap();
```

### Integer Arithmetic

Always use checked arithmetic for amounts, ledger counters, and any value that can overflow:

```rust
// ✅ correct
let timeout_ledger = ledger_height
    .checked_add(timeout_ledgers)
    .ok_or(RemittanceError::InvalidTimeout)?;

// ❌ wrong — silent overflow
let timeout_ledger = ledger_height + timeout_ledgers;
```

---

## Storage Key Naming Conventions

Soroban persistent storage keys are `Symbol` values. AfroPay uses the following conventions:

### Rules

1. Keys are **lowercase** strings matching the Rust identifier convention.
2. Keys are defined as constants or documented in `contract.rs` rather than scattered inline.
3. New keys must be added to the table below and must not collide with existing keys.
4. Keys for per-escrow data use the escrow ID as a compound key (not as a plain string).

### Reserved Keys — Instance Storage (`storage().instance()`)

| Key String | Type | Description |
|------------|------|-------------|
| `"info"` | `ContractInfo` | Admin address, oracle map, pause flag, version |
| `"escrows"` | `Map<String, Escrow>` | All active and historical escrow records |
| `"escrow_counter"` | `u64` | Monotonically increasing escrow ID counter |
| `"schema_version"` | `u32` | Current storage schema version (set by `migrate()`) |

### Naming New Keys

When adding a new top-level storage entry:

- Use snake_case.
- Choose a name that reflects the data it holds, not the function that writes it.
- Document the type alongside the key.

```rust
// ✅ correct — descriptive, snake_case, documented
const KEY_FEE_SCHEDULE: &str = "fee_schedule";
// Stores: Map<String, i128> — keyed by corridor code, value in basis points

// ❌ wrong — opaque abbreviation
const KEY_FS: &str = "fs";
```

---

## Error Code Allocation

`RemittanceError` (`src/errors.rs`) uses a numeric code system. When adding a new error:

1. Check that no existing code covers the situation.
2. Assign the next available integer after the current maximum (currently 26).
3. Place the variant in the appropriate category block.
4. Update this table:

| Range | Category |
|-------|---------|
| 1–2 | Contract state (not initialized, already initialized) |
| 3–6 | Permission / auth |
| 7–11 | Escrow lifecycle |
| 12–17 | Validation |
| 18–20 | Fund transfer |
| 21–23 | Oracle |
| 24–25 | Rate / slippage |
| 26 | Generic fallback |
| 27+ | Future use — document when allocated |

---

## Documentation Standards

### Rust Doc Comments

All `pub` items (functions, structs, enums, constants) must have a doc comment (`///`).

```rust
/// Release USDC funds to the off-ramp agent after successful delivery attestation.
///
/// # Errors
///
/// - [`RemittanceError::NotInitialized`] if the contract has not been initialised.
/// - [`RemittanceError::NotOracleOperator`] if the attesting oracle is not registered.
/// - [`RemittanceError::InvalidSignature`] if the attestation signature fails verification.
pub fn release_to_agent(
    env: Env,
    escrow_id: SorobanString,
    attestation: OracleAttestation,
) -> Result<(), RemittanceError> {
```

### Module-Level Comments

Each source file begins with a module-level doc comment (`//!`) that describes its purpose:

```rust
//! Oracle attestation types and Ed25519 signature verification.
//!
//! An [`OracleAttestation`] carries the oracle's delivery confirmation for a specific
//! escrow, along with a nonce for replay protection.
```

---

## Commit Message Format

AfroPay uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

```
<type>(<scope>): <short summary in imperative mood, ≤72 chars>

[optional body — wrap at 72 chars, explain the why not the what]

[optional footer — "Closes #N", "BREAKING CHANGE: ..."]
```

### Types

| Type | When to Use |
|------|-------------|
| `feat` | A new feature or capability |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `chore` | Build, tooling, dependencies |
| `refactor` | No behaviour change, code quality |
| `test` | Adding or updating tests |
| `security` | Security hardening |
| `perf` | Performance improvement |
| `ci` | GitHub Actions changes |

### Scopes

| Scope | Component |
|-------|-----------|
| `contract` | `src/contract.rs` |
| `escrow` | `contracts/escrow/` |
| `oracle` | `src/oracle.rs` |
| `migration` | `**/migration.rs` |
| `adr` | `docs/adr/` |
| `ci` | `.github/workflows/` |
| `deps` | `Cargo.toml` updates |

### Example Commits

```
feat(escrow): add multi-source oracle median aggregation

Replaces single oracle with a configurable quorum of N oracles whose
attested exchange rates are median-aggregated before acceptance.

Requires minimum 3 oracle signatures (default, configurable by admin).

Closes #47
```

```
fix(contract): use checked_add for timeout ledger calculation

Prevents silent u32 overflow when timeout_minutes * 15 exceeds u32::MAX.
Returns InvalidTimeout error instead of panicking.

Closes #52
```

```
docs(adr): add ADR-003 sequence-based timelocks

Documents why Soroban sequence numbers are used for timelocks instead
of block timestamps, citing Stellar validator clock-skew specification.

Closes #36
```

---

## Naming Conventions

### Rust Identifiers

| Category | Convention | Example |
|----------|-----------|---------|
| Types / enums | `PascalCase` | `RemittanceError`, `EscrowState` |
| Functions / methods | `snake_case` | `deposit_escrow`, `claim_refund` |
| Constants | `SCREAMING_SNAKE_CASE` | `MAX_TIMEOUT_LEDGERS`, `MIN_AMOUNT` |
| Storage key strings | `snake_case` (lowercase) | `"info"`, `"escrow_counter"` |
| Module files | `snake_case` | `contract.rs`, `oracle.rs` |
| Test helpers | `snake_case` with `_` prefix if private | `_make_env`, `_seed_escrow` |

### Storage Key Constants

Prefer named constants over inline string literals when a key is referenced in more than one place:

```rust
// Define once at module top
const KEY_INFO: &str = "info";
const KEY_ESCROWS: &str = "escrows";
const KEY_COUNTER: &str = "escrow_counter";
const KEY_SCHEMA: &str = "schema_version";

// Use consistently
env.storage().instance().get(&Symbol::new(&env, KEY_INFO))
```

### Event Topics

Event topics (emitted via `EventEmitter`) use snake_case strings matching the function that emits them:

| Event | Topic String |
|-------|-------------|
| Escrow created | `"deposit"` |
| Funds released to agent | `"release"` |
| Funds refunded to sender | `"refund"` |
| Oracle submission | `"oracle_submit"` |
| Contract paused/unpaused | `"pause_state"` |
| Schema migrated | `"schema_migrated"` |
