# Testing Guide — Soroban Contracts

This document describes how to run the test suites for the `contracts/escrow/` and `contracts/remittance/` crates, including property-based tests and adversarial scenarios.

---

## Table of Contents

1. [Running All Tests](#running-all-tests)
2. [Running Property-Based Tests](#running-property-based-tests)
3. [Running Adversarial Tests](#running-adversarial-tests)
4. [Reproducing a Failing Seed](#repeating-a-failing-seed)
5. [Coverage Targets](#coverage-targets)
6. [CI Gates](#ci-gates)

---

## Running All Tests

Run the full test suite for both contract crates:

```bash
# From the repository root
cargo test --workspace --features testutils
```

Or run tests for a single crate:

```bash
cd contracts/escrow
cargo test --features testutils -- --nocapture

cd contracts/remittance
cargo test --features testutils -- --nocapture
```

---

## Running Property-Based Tests

Property-based tests use the `proptest` crate and generate thousands of random inputs to verify invariants. They are located in `proptests.rs` in each contract crate.

### Run all property tests (default 100 cases per property)

```bash
cd contracts/escrow
cargo test --features testutils proptest

cd contracts/remittance
cargo test --features testutils proptest
```

### Run property tests with 50,000 cases per property

```bash
cd contracts/escrow
PROPTEST_CASES=50000 cargo test --features testutils proptest

cd contracts/remittance
PROPTEST_CASES=50000 cargo test --features testutils proptest
```

### Run property tests with a wall-time cap of 120 seconds

The CI pipeline sets `PROPTEST_TIMEOUT=120` to ensure property tests do not exceed 2 minutes. You can use the same setting locally:

```bash
cd contracts/escrow
PROPTEST_TIMEOUT=120 PROPTEST_CASES=50000 cargo test --features testutils proptest

cd contracts/remittance
PROPTEST_TIMEOUT=120 PROPTEST_CASES=50000 cargo test --features testutils proptest
```

---

## Running Adversarial Tests

Adversarial tests target security-sensitive edge cases (unauthorized access, boundary values, invalid inputs). They are located in `adversarial_tests.rs` in each contract crate.

```bash
cd contracts/escrow
cargo test --features testutils adversarial

cd contracts/remittance
cargo test --features testutils adversarial
```

---

## Reproducing a Failing Seed

When a property test finds a counterexample, `proptest` prints the failing input. To reproduce it deterministically:

1. **Note the seed** printed by proptest in the test output. It looks like:
   ```
   thread 'property_foo' panicked at src/...
   Failed after 42 test cases
   ```

2. **Re-run with the same seed** using the `PROPTEST_SEED` environment variable:
   ```bash
   PROPTEST_SEED=42 cargo test --features testutils property_foo
   ```

3. **If the seed is not printed**, run with `--nocapture` to see the full output:
   ```bash
   PROPTEST_CASES=50000 cargo test --features testutils -- --nocapture
   ```

4. **Shrink the failing case** — proptest automatically shrinks large/random inputs to the minimal counterexample. The shrunk input is printed in the panic message.

### Example: Reproducing an escrow release failure

```bash
# Run property tests with verbose output
cd contracts/escrow
PROPTEST_CASES=50000 PROPTEST_TIMEOUT=120 cargo test --features testutils -- --nocapture property_beneficiary_only_release

# If a counterexample is found, note the seed and reproduce
PROPTEST_SEED=12345 cargo test --features testutils property_beneficiary_only_release
```

---

## Coverage Targets

The project targets **≥ 90% line coverage** for both contract crates, measured via `cargo-llvm-cov`.

### Install cargo-llvm-cov

```bash
cargo install cargo-llvm-cov --locked
```

### Measure coverage for a single crate

```bash
cd contracts/escrow
cargo llvm-cov --features testutils --html --output-dir ./target/coverage

cd contracts/remittance
cargo llvm-cov --features testutils --html --output-dir ./target/coverage
```

### Measure coverage for the entire workspace

```bash
cargo llvm-cov workspace --features testutils --html --output-dir ./target/coverage
```

### View the HTML report

```bash
open ./target/coverage/html/index.html
```

### Enforce the 90% threshold in CI

```bash
cargo llvm-cov workspace --features testutils --fail-under-lines 90
```

---

## CI Gates

The following checks run on every PR targeting `main` or `develop`:

| Gate | Command | Timeout |
|------|---------|---------|
| Build (wasm32) | `cargo build --target wasm32-unknown-unknown --release` | — |
| Unit + integration tests | `cargo test --workspace --features testutils` | — |
| Property-based tests | `PROPTEST_TIMEOUT=120 cargo test --workspace --features testutils proptest` | 120 s |
| Clippy | `cargo clippy --workspace --all-targets -- -D warnings` | — |
| Format check | `cargo fmt --all -- --check` | — |
| Unchecked arithmetic audit | `bash scripts/check-unchecked-arithmetic.sh` | — |
| Dependency audit | `cargo audit` | — |

All gates must pass before a PR can be merged.

---

## Test File Locations

| Contract | Test File | Purpose |
|----------|-----------|---------|
| `contracts/escrow/` | `src/test.rs` | Example-based unit tests |
| `contracts/escrow/` | `src/proptests.rs` | Property-based tests (proptest) |
| `contracts/escrow/` | `src/adversarial_tests.rs` | Security-focused adversarial tests |
| `contracts/escrow/` | `src/reentrancy_tests.rs` | Reentrancy guard tests |
| `contracts/remittance/` | `src/test.rs` | Example-based unit tests |
| `contracts/remittance/` | `src/proptests.rs` | Property-based tests (proptest) |
| `contracts/remittance/` | `src/adversarial_tests.rs` | Security-focused adversarial tests |
| `contracts/remittance/` | `src/reentrancy_tests.rs` | Reentrancy guard tests |
