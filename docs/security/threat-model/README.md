# AfroPay Threat Model

**Location:** `docs/security/threat-model/`  
**Status:** Active — v1.0.0 (2026-07-30)  
**Owners:** Security Engineering, Lead Maintainers

---

## Document Index

| Document | Purpose |
|----------|---------|
| [dfd.md](./dfd.md) | Level-1 Data-Flow Diagram — all processes, data stores, external entities, and the five trust boundaries |
| [stride-analysis.md](./stride-analysis.md) | STRIDE threat enumeration — all 5 trust boundaries, 20+ threats, severities, mitigations, residual risks, and open issues |
| **This file** | Review process, update triggers, approval requirements |

---

## What Is a Threat Model?

A threat model is a structured analysis of what can go wrong in a system from a security perspective. AfroPay's threat model:

1. Draws a data-flow diagram (DFD) that shows every component, data store, and trust boundary.
2. Applies the STRIDE framework to enumerate threats at each trust boundary.
3. Documents current mitigations, residual risks, and linked GitHub issues for open work.
4. Defines a mandatory review process so the threat model stays current as the codebase evolves.

---

## Threat Model Review Process

### When Must the Threat Model Be Updated?

A PR **must** include a threat model update if it introduces any of the following:

| Change Type | Example |
|-------------|---------|
| New external integration | Adding a new off-ramp PSP (e.g. M-Pesa, Chipper Cash) |
| New trust boundary | A new service that communicates across an external network boundary |
| New contract entry point | Adding a new `pub fn` to `contract.rs` or `contracts/escrow/src/lib.rs` |
| Change to authentication or authorization | Modifying SEP-10 middleware, oracle registration, admin auth |
| Change to oracle or rate aggregation | New rate provider, changed outlier threshold, new staleness policy |
| Change to webhook handling | New webhook source, modified HMAC verification, idempotency changes |
| Change to fund transfer logic | Modifications to `deposit_escrow`, `release_to_agent`, `claim_refund` |
| New data store | Adding a new database, cache, or persistent queue |

**Rule:** If your PR adds a new external integration or trust boundary, you must update `dfd.md` and `stride-analysis.md` as part of that PR. PRs that fail this requirement will be labelled `needs-threat-model-update` and will not be merged until the update is provided.

### How to Update the Threat Model

1. **Update the DFD** (`dfd.md`): Add the new process, external entity, data store, and/or data flows. If a new trust boundary is introduced, add it to the DFD and the Trust Boundary Definitions table.

2. **Update the STRIDE analysis** (`stride-analysis.md`): For each new or modified trust boundary, enumerate at least 3 STRIDE threats. Use the existing threat format (ID, Title, STRIDE category, Severity, Affected component, Description, Current Mitigation, Residual Risk, Issue link).

3. **Open GitHub issues** for any newly identified High or Critical severity threats that are not immediately mitigated.

4. **Update the version and revision history** at the top of `stride-analysis.md`.

5. **Reference the threat model update** in your PR description under the "Threat Model Impact" section.

### PR Review Requirements for Threat Model Changes

Threat model updates require **2 approvals**, at least one of which must be from a maintainer listed below.

| Approval Requirement | Applies To |
|----------------------|-----------|
| 1 approval | Minor clarifications, typo fixes, issue link updates |
| 2 approvals (1 maintainer) | New threat entries, mitigation changes, new trust boundaries |
| 2 approvals (both maintainers) | Removing a threat, downgrading severity, changing an open issue to "Accepted Risk" |

### Accepting a Risk

To accept a residual risk rather than mitigating it:

1. The PR author must document the acceptance rationale in `stride-analysis.md` under the "Accepted Risks" table.
2. The rationale must include: threat ID, why the risk is acceptable, any compensating controls, and who approved the acceptance.
3. Two maintainer approvals are required.
4. Accepted risks must be re-evaluated at each major release.

---

## Maintainers

The following maintainers are responsible for approving threat model changes:

| Role | Responsibility |
|------|---------------|
| Lead Security Reviewer | Final approval on severity changes and accepted risks |
| Lead Contract Reviewer | Approval on Soroban contract threat changes (TB-2) |

To become a threat model maintainer, open a PR updating this file with your GitHub handle and the role, approved by both current maintainers.

---

## Threat Model Cadence

| Event | Action |
|-------|--------|
| Every PR with qualifying changes (see above) | Update DFD and STRIDE inline with the PR |
| Major release (vX.0.0) | Full threat model review — re-evaluate all Accepted Risks |
| New high-severity CVE affecting a dependency | Emergency review of affected trust boundaries within 5 business days |
| Post-incident (security incident or near-miss) | Threat model retrospective — add or update threats within 10 business days |

---

## Tooling

- **DFD diagrams:** Written in [Mermaid](https://mermaid.js.org/) flowchart syntax, rendered in GitHub Markdown.
- **Severity:** CVSS-lite (Impact × Likelihood). See `stride-analysis.md` severity scale for definitions.
- **Issue tracking:** All open High/Critical threats link to GitHub issues. Use the `security` and `needs-design-review` labels.

---

## Quick Links

- [SECURITY.md](../../SECURITY.md) — Responsible disclosure process
- [CONTRIBUTING.md](../../CONTRIBUTING.md) — Contribution guidelines including threat model rule
- [docs/adr/](../adr/) — Architecture Decision Records
- [docs/contract-design.md](../contract-design.md) — Contract security model
- [docs/oracle-integration.md](../oracle-integration.md) — Oracle protocol specification
