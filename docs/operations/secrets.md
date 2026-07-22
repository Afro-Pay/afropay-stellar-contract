# AfroPay Secrets Inventory

**Document:** `docs/operations/secrets.md`  
**Owner:** Platform Security  
**Reviewed:** 2026-07  
**Classification:** Internal — Confidential

> This document lists every secret used by AfroPay, where it is stored, how
> it is rotated, and who to contact for emergency revocation. It does **not**
> contain actual secret values — those live exclusively in HashiCorp Vault.

---

## Table of Contents

1. [Secret Storage Architecture](#1-secret-storage-architecture)
2. [Secret Inventory](#2-secret-inventory)
3. [Rotation Schedule](#3-rotation-schedule)
4. [Emergency Revocation Procedures](#4-emergency-revocation-procedures)
5. [Access Audit](#5-access-audit)
6. [False-Positive Suppressions (gitleaks)](#6-false-positive-suppressions-gitleaks)

---

## 1. Secret Storage Architecture

All secrets are stored in **HashiCorp Vault** running at `https://vault.afropay.internal:8200`. No plaintext secrets are permitted in:

- Source code or git history
- Docker Compose files (only Vault references)
- CI/CD environment variables (use GitHub Actions OIDC or Vault Agent instead)
- Application logs or error messages
- Slack, email, or any unencrypted channel

### Vault Namespaces

| Mount Path | Type | Purpose |
|---|---|---|
| `secret/` | KV v2 | Static secrets (JWT, API keys, Redis password) |
| `database/` | Database engine | Dynamic Postgres credentials with TTL |
| `auth/approle/` | Auth method | Service identity (role_id + secret_id per service) |

### Service → Secret Mapping (least-privilege)

| Service | Vault Policy | Can Read |
|---|---|---|
| `api` | `api-service` | `secret/api/*`, `database/creds/api-role` |
| `relayer` | `relayer-service` | `secret/relayer/signing-key` only |
| `oracle` | `oracle-service` | `secret/oracle/providers/*` only |
| `reconciler` | `reconciler-service` | `database/creds/reconciler-role` only |

Policy files: [`infrastructure/vault/policies/`](../../infrastructure/vault/policies/)

---

## 2. Secret Inventory

### 2.1 Stellar Signing Keys

| Secret | Vault Path | Type | Rotation Frequency | Owner |
|---|---|---|---|---|
| Relayer hot-wallet seed | `secret/relayer/signing-key` | Static KV | 90 days | Platform Security |
| Relayer public key | `secret/relayer/signing-key` (field: `public_key`) | Static KV | On rotation | Platform Security |

**Notes:**
- The seed is an Ed25519 Stellar secret seed (56-char Base32 string starting with `S`).
- The corresponding public key must match `SIGNING_KEY` in `public/.well-known/stellar.toml`.
- Rotation procedure: see [`docs/operations/key-rotation.md`](./key-rotation.md).

### 2.2 API Authentication Secrets

| Secret | Vault Path | Type | Rotation Frequency | Owner |
|---|---|---|---|---|
| JWT signing secret | `secret/api/jwt-secret` | Static KV | 90 days | Platform Security |
| Master encryption key (AES-256) | `secret/api/master-enc-key` | Static KV | 180 days (requires re-encryption migration) | Platform Security |

**Notes:**
- The JWT secret rotation requires a rolling restart of the API service. All existing JWT sessions become invalid; users must re-authenticate.
- The master encryption key encrypts Stellar keypairs stored in the database. Rotation requires a data migration script — do NOT rotate without a tested migration plan.

### 2.3 Database Credentials

| Secret | Vault Path | Type | TTL | Rotation |
|---|---|---|---|---|
| Postgres credentials (api) | `database/creds/api-role` | Dynamic | 1h (max 24h) | Auto (Vault) |
| Postgres credentials (reconciler) | `database/creds/reconciler-role` | Dynamic | 1h (max 24h) | Auto (Vault) |
| Postgres root credential | Set via `POSTGRES_ROOT_PASSWORD` at init | Static | 180 days | Manual |
| Vault DB connection password | `database/config/afropay-postgres` | Vault internal | 180 days | Manual |

**Notes:**
- Dynamic credentials are fetched by `services/db/vaultCredsManager.ts` and renewed automatically before TTL expiry.
- The `api-role` grants `SELECT, INSERT, UPDATE` on all public tables.
- The `reconciler-role` grants `SELECT` only.
- Neither role can `DROP`, `ALTER`, or access system tables.

### 2.4 Redis

| Secret | Vault Path | Type | Rotation Frequency | Owner |
|---|---|---|---|---|
| Redis password | `secret/api/redis` (field: `password`) | Static KV | 180 days | Platform Security |

**Notes:**
- Accessed only by the API and queue services.
- Redis is not exposed outside the internal Docker network.

### 2.5 Payment Provider API Keys

| Secret | Vault Path | Type | Rotation Frequency | Owner |
|---|---|---|---|---|
| Flutterwave secret key | `secret/api/flutterwave` (field: `secret_key`) | Static KV | 90 days or on incident | Payments Team |
| Paystack secret key | `secret/api/paystack` (field: `secret_key`) | Static KV | 90 days or on incident | Payments Team |
| Flutterwave FX API key (oracle) | `secret/oracle/providers/flutterwave` (field: `api_key`) | Static KV | 90 days | Payments Team |
| CBN FX API key (oracle) | `secret/oracle/providers/cbn` (field: `api_key`) | Static KV | 180 days | Payments Team |

**Notes:**
- Flutterwave and Paystack webhook secrets are used to verify HMAC-SHA512/256 signatures. Rotate in the provider dashboard first, then update Vault.
- The oracle API keys are read-only (rate queries only) — rotate on schedule, not urgently on compromise.

### 2.6 Infrastructure Secrets

| Secret | Storage | Type | Rotation Frequency | Owner |
|---|---|---|---|---|
| Vault unseal keys (5 shares) | Separate offline keystores (1 per keyholder) | Shamir key share | Annual | Vault Admin |
| Vault root token | Revoked after bootstrap; recreated for break-glass only | Vault token | After each break-glass use | Vault Admin |
| GitHub Actions OIDC | Managed by GitHub | OIDC | Auto (short-lived) | DevOps |
| Docker registry credentials | GitHub Packages (OIDC) | OIDC | Auto | DevOps |
| Grafana admin password | `secret/api/grafana` | Static KV | 180 days | Platform |

---

## 3. Rotation Schedule

| Secret Category | Frequency | Method | Who Executes |
|---|---|---|---|
| Stellar signing key | 90 days | Manual runbook (`key-rotation.md`) | Platform Security + On-call |
| JWT secret | 90 days | Vault KV write + API rolling restart | DevOps |
| Provider API keys | 90 days | Provider dashboard → Vault KV write | Payments Team |
| Postgres dynamic creds | Every 1h | Automatic (`vaultCredsManager.ts`) | Vault (automated) |
| Postgres root credential | 180 days | Manual (`POSTGRES_ROOT_PASSWORD` reset) | DBA / Platform Security |
| Master encryption key | 180 days | Manual + data migration | Platform Security + DBA |
| Redis password | 180 days | Redis `CONFIG SET requirepass` + Vault KV write | DevOps |
| Vault unseal keys | Annual | `vault operator rekey` | Vault Admin (all keyholders) |

### Rotation Calendar

Rotations should be tracked in the security team's on-call calendar. Add a recurring event 2 weeks before each due date as a reminder.

---

## 4. Emergency Revocation Procedures

### 4.1 Stellar Signing Key Compromised

**Impact:** Attacker can sign SEP-10 challenges and submit escrow transactions. Hot-wallet XLM at risk.

```bash
# IMMEDIATE: Revoke the AppRole secret_id used by the relayer
vault write -f auth/approle/role/relayer-service/secret-id-accessor/destroy \
  secret_id_accessor="<accessor-from-audit-log>"

# Rotate the key immediately — follow docs/operations/key-rotation.md
# Contact: @security-lead via PagerDuty P1
```

Also: Freeze the Soroban contract's pausing mechanism (admin multi-sig required) to prevent fraudulent escrow releases while the key is rotated.

### 4.2 Postgres Credentials Compromised

**Impact:** Attacker can read/write escrow records, user wallets, KYC data.

```bash
# Revoke the specific dynamic lease
vault lease revoke <lease-id>

# Revoke ALL dynamic leases for the compromised role
vault lease revoke -prefix database/creds/api-role

# Force-rotate the DB root credential
vault write database/config/afropay-postgres \
  rotate_root_credentials=true

# Contact: @dba-on-call and @security-lead
```

### 4.3 JWT Secret Compromised

**Impact:** Attacker can forge authentication tokens for any user.

```bash
# Write a new JWT secret — ALL existing sessions are immediately invalidated
NEW_SECRET=$(openssl rand -hex 32)
vault kv put secret/api/jwt-secret value="${NEW_SECRET}"

# Rolling restart the API to load the new secret
kubectl rollout restart deployment/api -n afropay-production

# Contact: @platform-oncall
```

### 4.4 Provider API Key Compromised

**Impact:** Attacker can initiate payments / query sensitive transaction data via provider API.

1. **Immediately** revoke the key in the provider's dashboard (Flutterwave: Settings → API Keys; Paystack: Settings → API Keys).
2. Generate a new key in the provider dashboard.
3. Update Vault: `vault kv put secret/api/flutterwave secret_key="<new-key>"`
4. Rolling restart the API: `kubectl rollout restart deployment/api -n afropay-production`
5. Review provider audit logs for suspicious activity in the past 24 hours.

### 4.5 Vault Token / AppRole Compromised

**Impact:** Attacker can read secrets accessible to the compromised policy.

```bash
# Revoke the token immediately
vault token revoke <compromised-token>

# If an AppRole secret_id was exposed:
vault write -f auth/approle/role/<service>/secret-id-accessor/destroy \
  secret_id_accessor="<accessor>"

# Generate a new secret_id for the service
vault write -f auth/approle/role/<service>/secret-id

# Contact: @vault-admin immediately
```

### 4.6 Master Encryption Key Compromised

**Impact:** Attacker can decrypt stored Stellar keypairs for all users (highest severity).

1. Immediately engage @security-lead and @cto via PagerDuty P0.
2. **Do not rotate the key yet** — rotation requires a data migration.
3. Revoke all API tokens and force re-authentication.
4. Initiate incident response protocol (IR-001).
5. Coordinate offline migration with DBA before generating a new master key.

---

## 5. Access Audit

Vault audit logs are written to `/vault/logs/audit.log` and forwarded to the SIEM. Review regularly:

```bash
# Check who accessed the relayer signing key in the last 24h
vault audit list
grep '"path":"secret/data/relayer/signing-key"' /vault/logs/audit.log | \
  jq '{time: .time, token: .auth.display_name, remote_addr: .request.remote_address}'

# Check for unexpected reads of dynamic DB creds
grep '"path":"database/creds/"' /vault/logs/audit.log | \
  jq '{time: .time, token: .auth.display_name, role: .request.path}'
```

### Audit Review Schedule

| Review | Frequency | Reviewer |
|---|---|---|
| Vault access log spot-check | Weekly | Platform Security |
| Dynamic credential usage report | Monthly | DBA + Platform Security |
| Full Vault audit log review | Quarterly | External auditor (SOC-2) |

---

## 6. False-Positive Suppressions (gitleaks)

The following patterns are excluded from secret scanning. Any new suppression must be reviewed and documented here before being added to `.gitleaks.toml`:

| Pattern / File | Reason | Added By | Date |
|---|---|---|---|
| `REPLACE_ME_STELLAR*` | Placeholder values in `init.sh` and docs — not real secrets | Platform Security | 2026-07 |
| `SCEXAMPLE*` | Example Stellar seed format in documentation only | Platform Security | 2026-07 |
| `infrastructure/vault/init.sh` → `REPLACE_ME_*` lines | Bootstrap placeholders, never real values | Platform Security | 2026-07 |

To add a new suppression, open a PR with both the `.gitleaks.toml` change and a new row in this table. The PR must be reviewed by Platform Security before merging.

---

## Related Documents

- [`docs/operations/key-rotation.md`](./key-rotation.md) — Stellar signing key rotation runbook
- [`infrastructure/vault/policies/`](../../infrastructure/vault/policies/) — Vault least-privilege policies
- [`infrastructure/vault/init.sh`](../../infrastructure/vault/init.sh) — Vault bootstrap
- [`services/db/vaultCredsManager.ts`](../../services/db/vaultCredsManager.ts) — Dynamic DB credential manager
- [`SECURITY.md`](../../SECURITY.md) — Vulnerability disclosure policy
