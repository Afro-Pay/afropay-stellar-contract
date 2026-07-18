## Summary

<!-- 
Describe what this PR does and why. Link the relevant issue(s).
Use "Closes #N" to auto-close issues on merge.
-->

Closes #

---

## Type of Change

<!-- Check all that apply -->

- [ ] `feat` — New feature or behaviour
- [ ] `fix` — Bug fix
- [ ] `refactor` — No behaviour change, code quality improvement
- [ ] `test` — Tests only
- [ ] `docs` — Documentation only
- [ ] `chore` — Tooling, CI, or dependency update
- [ ] `security` — Security hardening
- [ ] `perf` — Performance improvement

---

## Changes Made

<!-- List the files/modules changed and what was changed in each. -->

| File | Change |
|------|--------|
| `src/...` | |

---

## Testing Done

<!-- Describe what tests you ran and how to reproduce them. -->

```bash
# Commands used to verify the change
```

- [ ] `cargo test --lib` passes
- [ ] `cargo test --test integration_test` passes
- [ ] `cargo clippy --all-targets -- -D warnings` passes
- [ ] `cargo fmt -- --check` passes
- [ ] `cd contracts/escrow && cargo test --features testutils` passes (if escrow changed)

---

## Checklist

- [ ] Tests pass locally (see above)
- [ ] New logic is covered by tests (unit, integration, and/or property-based as appropriate)
- [ ] All `pub` items have doc comments (`///`)
- [ ] No `unwrap()` calls in non-test code
- [ ] Docs updated (`README.md`, inline comments, relevant `docs/` files)
- [ ] **ADR updated or created** if this is an architectural change (see [docs/adr/README.md](docs/adr/README.md))
- [ ] **`contracts/MIGRATION.md` updated** if storage keys or value types changed
- [ ] **Threat model impact described below** if new entry points or auth logic changed

---

## Threat Model Impact

<!--
Required if this PR:
- Adds a new entry point to contract.rs or contracts/escrow/src/lib.rs
- Changes oracle registration, admin auth, or timeout/refund mechanics

If not applicable, write "N/A".
-->

N/A

---

## ADR Reference

<!--
If this PR introduces or changes an architectural decision, link the ADR.
If a new ADR is needed, include it in this PR or open a follow-up docs/ PR.

If not applicable, write "N/A".
-->

N/A

---

## Screenshots / Logs

<!-- Optional: attach test output, benchmark results, or event logs if relevant. -->
