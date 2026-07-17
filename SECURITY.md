# Security Policy

AfroPay handles real financial value on-chain. We take security vulnerabilities seriously and appreciate the responsible disclosure of any issues you discover.

---

## Supported Versions

| Component | Supported |
|-----------|-----------|
| `src/` — RemittanceContract (latest `main`) | ✅ |
| `contracts/escrow/` — EscrowContract (latest `main`) | ✅ |
| Any tagged release | ✅ |
| Branches other than `main` | ❌ |

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

### Option 1 — GitHub Private Security Advisory (preferred)

1. Go to the [Security Advisories page](https://github.com/afropay/afropay-stellar-contract/security/advisories/new).
2. Click **"Report a vulnerability"**.
3. Fill in the title, description, severity estimate, and any proof-of-concept code.
4. Submit. The maintainers will be notified privately.

### Option 2 — Email

Send an encrypted email to **security@afropay.io** with:

- Subject line: `[SECURITY] <short description>`
- A description of the vulnerability and its impact
- Steps to reproduce or a proof-of-concept
- Your preferred handle for credit in the advisory

We recommend encrypting the email with our PGP key (available at `https://afropay.io/.well-known/security.txt`).

---

## Disclosure Timeline

| Step | Target Time |
|------|-------------|
| Acknowledgement of report | **48 hours** |
| Initial severity assessment | **5 business days** |
| Patch development & review | **14 days** for critical; **30 days** for high/medium |
| Coordinated public disclosure | After patch is deployed or 90 days, whichever comes first |

If circumstances require a different timeline (e.g., active exploitation in the wild), we will communicate with you promptly.

---

## Scope

### In Scope

- Logic errors in `src/contract.rs` (RemittanceContract entry points)
- Logic errors in `contracts/escrow/src/lib.rs` (EscrowContract entry points)
- Incorrect state-machine transitions (Locked → Released, Locked → Refundable, etc.)
- Oracle attestation bypass or signature forgery
- Admin auth bypass (`info.admin.require_auth()` circumvention)
- Reentrancy or front-running vulnerabilities
- Integer overflow / underflow in amount or ledger calculations
- Unintended fund lock-up (funds permanently inaccessible)
- Storage key collision that overwrites live escrow data
- Migration logic vulnerabilities (`migration.rs`)

### Out of Scope

- Issues requiring physical access to a user's device
- Social engineering attacks
- Issues in third-party dependencies already publicly disclosed upstream
- Theoretical attacks without a plausible real-world impact
- Front-end or API layer vulnerabilities (report those to the respective repositories)

---

## Severity Classification

We use CVSS 3.1 as a baseline and adjust for on-chain context:

| Severity | Examples |
|----------|---------|
| **Critical** | Unauthorized fund withdrawal; admin key bypass; total contract drain |
| **High** | Partial fund theft; oracle attestation forged; escrow permanently locked |
| **Medium** | Incorrect state transition exploitable only under specific conditions; DoS |
| **Low** | Information disclosure; minor logic errors with no financial impact |

---

## Bug Bounty

AfroPay does not currently operate a formal paid bug bounty programme. Contributors who responsibly disclose **Critical** or **High** severity issues will be:

1. Credited by name (or handle) in the public security advisory.
2. Listed in the project's `ACKNOWLEDGEMENTS.md`.
3. Eligible for consideration in future bounty programmes when they launch.

---

## Security Best Practices for Contributors

All contributors should read [docs/developer-handbook/code-style.md](docs/developer-handbook/code-style.md) for secure coding guidelines, particularly:

- Never use `unwrap()` in on-chain code; always map to a typed `RemittanceError`.
- All state transitions must be gated behind `require_auth()`.
- New storage keys must be documented and must not collide with existing keys (`"info"`, `"escrows"`, `"escrow_counter"`, `"schema_version"`).
- Timeout logic must use ledger sequence numbers, not block timestamps, to avoid validator clock-skew issues (see [ADR-003](docs/adr/ADR-003-sequence-based-timelocks.md)).

---

## Contact

- **Security email:** security@afropay.io
- **Discord (maintainers):** [AfroPay Community](https://discord.gg/afropay) — DM a maintainer with the `@maintainer` role
- **GitHub Advisory:** https://github.com/afropay/afropay-stellar-contract/security/advisories/new
