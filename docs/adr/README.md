# Architecture Decision Records

This directory contains the Architecture Decision Records (ADRs) for AfroPay. ADRs document significant design decisions so that contributors can understand *why* the codebase is built the way it is — not just *what* it does.

AfroPay uses the [MADR format](https://adr.github.io/madr/) (Markdown Architecture Decision Records).

---

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](ADR-001-stellar-soroban-settlement-layer.md) | Stellar/Soroban as the Settlement Layer | Accepted |
| [ADR-002](ADR-002-escrow-first-payment-model.md) | Escrow-First Payment Model | Accepted |
| [ADR-003](ADR-003-sequence-based-timelocks.md) | Sequence-Number-Based Timelocks | Accepted |
| [ADR-004](ADR-004-multi-source-oracle-median.md) | Multi-Source Oracle with Median Aggregation | Accepted |
| [ADR-005](ADR-005-sep10-relayer-auth.md) | SEP-10 for Relayer Authentication | Accepted |
| [ADR-006](ADR-006-flutterwave-ngn-offramp.md) | Flutterwave as Primary NGN Off-Ramp | Accepted |
| [ADR-007](ADR-007-event-sourced-audit-trail.md) | Event-Sourced Audit Trail | Accepted |
| [ADR-008](ADR-008-nextjs-app-router.md) | Next.js App Router for Frontend | Accepted |

---

## ADR Lifecycle

Each ADR passes through the following states:

```
Proposed → Accepted → Deprecated (optional) → Superseded (optional)
```

| Status | Meaning |
|--------|---------|
| **Proposed** | The ADR has been drafted and is open for discussion in a PR. |
| **Accepted** | The PR has been merged; the decision is in effect. |
| **Deprecated** | The decision is no longer followed but the ADR is kept for historical context. |
| **Superseded** | A newer ADR overrides this one. The old ADR links to the replacement. |

---

## When to Write an ADR

An ADR is required when a PR:

- Introduces or replaces a third-party dependency with significant surface area (SDK, auth library, off-ramp provider)
- Changes the smart-contract storage schema in a way that requires migration
- Alters the oracle attestation or signature protocol
- Selects between two or more substantially different design approaches
- Changes the settlement layer, token standard, or corridor-support model
- Modifies the admin or multi-sig governance model

For smaller implementation choices (e.g., which iterator method to use), a PR comment is sufficient.

---

## How to Propose an ADR

1. **Pick a number.** Use the next available ADR number after the last entry in the index above.
2. **Copy the template.** `cp docs/adr/template.md docs/adr/ADR-NNN-short-title.md`
3. **Fill in the template.** Mark status as `Proposed`. Fill in all sections.
4. **Open a PR.** The ADR can be included in the feature PR that implements the decision, or as a standalone `docs/` PR.
5. **Get review.** At least one maintainer must review the ADR before it is merged.
6. **Update status on merge.** The merging maintainer updates the status to `Accepted` and adds the ADR to the index table above.

---

## How to Deprecate or Supersede an ADR

If a future decision overturns an existing one:

1. Create the new ADR (e.g., `ADR-009-...`) with status `Accepted`.
2. In the new ADR's **Supersedes** field, reference the old ADR.
3. In the old ADR, update its status to `Superseded` and add a link: `Superseded by [ADR-009](ADR-009-...)`.
4. Update the index table in this file.

Do **not** delete old ADRs. The historical record of why decisions were made — including decisions that turned out to be wrong — is valuable.

---

## Template

See [template.md](template.md) for the full MADR template.

---

## Further Reading

- [MADR specification](https://adr.github.io/madr/)
- [Michael Nygard's original ADR article](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [ADR GitHub organisation](https://adr.github.io/)
