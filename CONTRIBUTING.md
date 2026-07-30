# Contributing to AfroPay

Thank you for your interest in contributing to AfroPay — the open-source decentralised remittance protocol on Stellar. This document is the single source of truth for contributing guidelines.

> **Security issues** must not be opened as public GitHub issues. See [SECURITY.md](SECURITY.md) for the responsible-disclosure process.

---

## Table of Contents

1. [Repository Structure](#repository-structure)
2. [Local Development Setup](#local-development-setup)
3. [Branching Convention](#branching-convention)
4. [Commit Message Format](#commit-message-format)
5. [PR Workflow](#pr-workflow)
6. [Code Style & Linting](#code-style--linting)
7. [Testing Expectations](#testing-expectations)
8. [Architecture Decision Records (ADRs)](#architecture-decision-records-adrs)
9. [Threat Model Updates](#threat-model-updates)
10. [Code Review SLA](#code-review-sla)
11. [Reporting Bugs and Requesting Features](#reporting-bugs-and-requesting-features)
12. [License](#license)

---

## Repository Structure

```
afropay-stellar-contract/
├── src/                          # Root remittance contract (soroban-sdk 20.5.0)
│   ├── lib.rs                    # Crate root, module declarations
│   ├── contract.rs               # RemittanceContract — all entry points
│   ├── escrow.rs                 # Escrow struct + state machine
│   ├── oracle.rs                 # OracleAttestation + signature verification
│   ├── errors.rs                 # RemittanceError enum (26 error codes)
│   ├── events.rs                 # EventEmitter — on-chain audit trail
│   └── bin/afropay.rs            # WASM binary entry point
├── contracts/
│   └── escrow/                   # Standalone escrow contract (soroban-sdk 21.0.0)
│       └── src/
│           ├── lib.rs            # EscrowContract entry points
│           ├── test.rs           # Unit tests
│           ├── proptests.rs      # Property-based tests (proptest)
│           └── adversarial_tests.rs  # Security-focused adversarial tests
├── tests/
│   └── integration_test.rs       # Integration test suite
├── docs/
│   ├── contract-design.md        # Technical deep-dive
│   ├── oracle-integration.md     # Oracle protocol specification
│   ├── adr/                      # Architecture Decision Records
│   └── developer-handbook/       # Code style, tooling guides
├── .github/
│   ├── workflows/
│   │   └── escrow-tests.yml      # CI for contracts/escrow
│   ├── ISSUE_TEMPLATE/           # Bug, feature, and security templates
│   └── PULL_REQUEST_TEMPLATE.md
├── Cargo.toml                    # Workspace root manifest
└── contracts/escrow/Cargo.toml   # Escrow sub-crate manifest
```

---

## Local Development Setup

### Prerequisites

| Tool | Minimum Version | Install |
|------|----------------|---------|
| Rust | 1.77 (stable) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| WASM target | — | `rustup target add wasm32-unknown-unknown` |
| Stellar CLI | 20.x | [Install guide](https://developers.stellar.org/docs/tools/stellar-cli) |
| Git | 2.40+ | system package manager |

### Clone and Build

```bash
git clone https://github.com/afropay/afropay-stellar-contract.git
cd afropay-stellar-contract

# Build root remittance contract
cargo build --target wasm32-unknown-unknown --release

# Build standalone escrow contract
cd contracts/escrow
cargo build --target wasm32-unknown-unknown --release
```

### Run Tests

```bash
# Root contract — unit + integration tests
cargo test --lib
cargo test --test integration_test -- --nocapture

# Standalone escrow contract — all test suites
cd contracts/escrow
cargo test --features testutils -- --nocapture

# Escrow adversarial tests
cargo test adversarial --features testutils -- --nocapture

# High-volume property tests (CI uses 100,000 cases)
PROPTEST_CASES=100000 cargo test --features testutils -- --nocapture
```

### Linting

```bash
# Clippy — all targets, treat warnings as errors
cargo clippy --all-targets -- -D warnings

# In contracts/escrow
cd contracts/escrow
cargo clippy --all-targets --features testutils -- -D warnings

# Format check
cargo fmt -- --check
```

---

## Branching Convention

All work happens on feature branches off `main`. Use the following prefixes:

| Prefix | When to Use | Example |
|--------|-------------|---------|
| `feat/` | New capability or behaviour | `feat/multi-hop-routing` |
| `fix/` | Bug fix | `fix/timeout-ledger-overflow` |
| `chore/` | Tooling, CI, dependency updates | `chore/bump-soroban-sdk-21` |
| `docs/` | Documentation only | `docs/adr-003-timelocks` |
| `refactor/` | No behaviour change, code quality | `refactor/extract-oracle-verify` |
| `test/` | Tests only | `test/adversarial-reentrancy` |
| `security/` | Security hardening | `security/replay-protection` |

Branch names must be kebab-case and descriptive. Avoid generic names like `fix/bug` or `feat/update`.

**Do not push directly to `main`.** All changes go through a pull request.

---

## Commit Message Format

AfroPay uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

```
<type>(<scope>): <short summary>

[optional body — wrap at 72 chars]

[optional footer — e.g. "Closes #42", "BREAKING CHANGE: ..."]
```

### Types

| Type | Purpose |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation changes |
| `chore` | Build, tooling, dependencies |
| `refactor` | Refactor without behaviour change |
| `test` | Adding or updating tests |
| `security` | Security hardening |
| `perf` | Performance improvement |
| `ci` | CI configuration changes |

### Scopes

| Scope | Component |
|-------|-----------|
| `contract` | `src/contract.rs` (remittance) |
| `escrow` | `contracts/escrow/` |
| `oracle` | `src/oracle.rs` |
| `migration` | Migration framework |
| `adr` | Architecture Decision Records |
| `ci` | GitHub Actions workflows |
| `deps` | Dependency updates |

### Examples

```
feat(escrow): add multi-source oracle median aggregation

Replaces single-feed oracle with a quorum of N oracles whose attested
exchange rates are median-aggregated before acceptance.  Requires a
minimum of 3 oracle signatures (configurable by admin).

Closes #47
```

```
fix(contract): prevent ledger-sequence overflow in timeout calculation

checked_add() now returns InvalidTimeout instead of panicking when
timeout_minutes * 15 overflows u32.

Closes #52
```

---

## PR Workflow

### PR Size Guidelines

| Category | Guideline |
|----------|-----------|
| Logic lines changed | **< 400 lines** (excludes generated code, test fixtures, and lock files) |
| Files changed | < 20 |
| Reviewers required | 1 for docs/tests; **2 for any change under `src/` or `contracts/`** |

Large PRs will be asked to split. If a single atomic change genuinely exceeds 400 logic lines, explain why in the PR description.

### Before Opening a PR

- [ ] `cargo fmt` applied — no formatting diff
- [ ] `cargo clippy --all-targets -- -D warnings` passes
- [ ] All existing tests pass
- [ ] New behaviour is covered by tests
- [ ] If the change is architectural, an ADR is drafted or updated (see [ADRs](#architecture-decision-records-adrs))
- [ ] `MIGRATION.md` is updated if storage keys or value types changed

### Opening the PR

Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md). Fill in every section — incomplete PRs will be labelled `needs-info` and will not be reviewed until complete.

Link the relevant GitHub issue(s) in the PR description using `Closes #<n>` so the issue is auto-closed on merge.

### After Review

- Address all requested changes with new commits; do not force-push during review.
- Once all reviewers have approved, the PR author squash-merges (or a maintainer does so).
- Delete the feature branch after merge.

---

## Code Style & Linting

See [docs/developer-handbook/code-style.md](docs/developer-handbook/code-style.md) for the full reference, including:

- Rust `clippy` rule set
- Soroban storage-key naming conventions
- Commit message format (this doc)
- Error code allocation rules for `RemittanceError`

**Quick rules:**

1. Use `rustfmt` defaults — no custom `rustfmt.toml` overrides.
2. All `pub` items must have doc comments (`///`).
3. Storage keys are uppercase `Symbol` constants, e.g. `Symbol::new(&env, "INFO")`.
4. Avoid `unwrap()` in non-test code; use the `?` operator or map to `RemittanceError`.
5. `#[allow(...)]` attributes require a comment explaining why.

---

## Testing Expectations

Every PR touching `src/` or `contracts/` must include or update tests. The expected coverage levels are:

| Test Type | Location | Minimum |
|-----------|----------|---------|
| Unit tests | `src/*.rs` inline or `contracts/escrow/src/test.rs` | All new entry points |
| Integration tests | `tests/integration_test.rs` | Happy-path + at least one failure path |
| Property-based tests | `contracts/escrow/src/proptests.rs` | Any function accepting numeric or string inputs |
| Adversarial tests | `contracts/escrow/src/adversarial_tests.rs` | All auth-guarded entry points |
| Upgrade simulation | `contracts/tests/upgrade/` | Any PR touching `migration.rs` |

If your change cannot reasonably be tested (e.g., a docs-only PR), say so in the PR description under "Testing Done".

---

## Architecture Decision Records (ADRs)

AfroPay uses the [MADR format](https://adr.github.io/madr/) for Architecture Decision Records. The full process is documented in [docs/adr/README.md](docs/adr/README.md).

**When is an ADR required?**

A PR requires a new ADR (or updates an existing one) when it:

- Introduces or replaces a third-party dependency with significant surface area (SDK, auth library)
- Changes the smart-contract storage schema
- Alters the oracle attestation or signature protocol
- Selects between two or more substantially different design approaches
- Changes the settlement layer, token standard, or corridor-support model

For smaller decisions, a brief note in the PR description is sufficient.

**How to propose an ADR:**

1. Copy `docs/adr/template.md` to `docs/adr/ADR-NNN-short-title.md` (next available number).
2. Fill in all sections; mark status as `Proposed`.
3. Open a PR — the ADR can be part of the feature PR or a standalone `docs/` PR.
4. Once the PR is merged, the ADR status changes to `Accepted`.

---

## Threat Model Updates

The threat model lives in [`docs/security/threat-model/`](docs/security/threat-model/) and consists of three documents:

| Document | Contents |
|----------|---------|
| [`dfd.md`](docs/security/threat-model/dfd.md) | Mermaid Level-1 Data-Flow Diagram — all trust boundaries |
| [`stride-analysis.md`](docs/security/threat-model/stride-analysis.md) | STRIDE threat enumeration — severity, mitigations, residual risks |
| [`README.md`](docs/security/threat-model/README.md) | Review process and update cadence |

### Mandatory Rule

> **PRs that add a new external integration or trust boundary must update the threat model.**

Specifically, a PR **must** update `dfd.md` and `stride-analysis.md` if it:

- Adds a new entry point to `contract.rs` or `contracts/escrow/src/lib.rs`
- Changes oracle registration or admin auth logic
- Modifies timeout / refund mechanics
- Adds a new off-ramp payment provider, webhook source, or rate feed
- Introduces a new service that communicates across a network boundary
- Changes SEP-10 authentication or signing key handling
- Modifies fund transfer logic (`deposit_escrow`, `release_to_agent`, `claim_refund`)

PRs that meet the above criteria but do not include a threat model update will be labelled **`needs-threat-model-update`** and will not be merged until the update is provided.

### What to Include in the PR Description

Every qualifying PR must include a **"Threat Model Impact"** section:

```
### Threat Model Impact

- [ ] This PR adds / modifies a trust boundary: [yes / no]
- [ ] dfd.md updated: [yes / no / not required]
- [ ] stride-analysis.md updated: [yes / no / not required]
- Summary of attack-surface changes and mitigations:
  <describe changes here>
```

### Approval Requirements for Threat Model Changes

| Change Type | Approvals Required |
|-------------|-------------------|
| Typo fix, issue link update | 1 approval |
| New threat entry or mitigation change | 2 approvals (1 must be a maintainer) |
| Removing a threat or downgrading severity | 2 maintainer approvals |
| Accepting a residual risk | 2 maintainer approvals with documented rationale |

See [`docs/security/threat-model/README.md`](docs/security/threat-model/README.md) for the full review process, acceptance criteria, and cadence.

---

## Code Review SLA

| Reviewer | Response Time |
|----------|--------------|
| First review pass | **48 hours** from PR open (business days) |
| Follow-up after changes requested | **24 hours** after contributor pushes fixes |
| Urgent security fixes (`security/` branch) | **4 hours** |

If a reviewer has not responded within the SLA, ping them in the PR thread. After a second missed SLA, a maintainer may assign a different reviewer.

**Approval requirements:**

- `docs/`, `test/`, `chore/` PRs: **1 approval**
- `feat/`, `fix/`, `refactor/` touching `src/` or `contracts/`: **2 approvals**
- Any change to `src/contract.rs`, `contracts/escrow/src/lib.rs`, or `migration.rs`: **2 approvals, one of which must be a maintainer**

---

## Reporting Bugs and Requesting Features

Use the appropriate GitHub Issue template:

- **Bug report** — unexpected behaviour, panics, incorrect state transitions
- **Feature request** — new corridors, capabilities, or integrations
- **Security vulnerability** — see [SECURITY.md](SECURITY.md); do **not** open a public issue

Before opening a new issue, search existing issues to avoid duplicates.

---

## License

By contributing to AfroPay you agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE).
