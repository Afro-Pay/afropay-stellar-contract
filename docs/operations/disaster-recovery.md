# AfroPay Disaster Recovery Runbook

**Version:** 1.0  
**Last Updated:** 2026-07-21  
**Owner:** Platform Engineering  
**Review Cycle:** Quarterly  

---

## Table of Contents

1. [Overview & Targets](#1-overview--targets)
2. [Architecture & Backup Strategy](#2-architecture--backup-strategy)
3. [RPO Evidence — WAL Archiving Interval](#3-rpo-evidence--wal-archiving-interval)
4. [Scenario Playbooks](#4-scenario-playbooks)
   - [4.1 PostgreSQL Complete Loss](#41-postgresql-complete-loss)
   - [4.2 PostgreSQL Data Corruption (PITR)](#42-postgresql-data-corruption-pitr)
   - [4.3 Redis Loss](#43-redis-loss)
   - [4.4 Secrets / Credentials Compromised](#44-secrets--credentials-compromised)
   - [4.5 Application API Layer Loss](#45-application-api-layer-loss)
5. [Monthly Drill Procedure](#5-monthly-drill-procedure)
6. [Contacts & Escalation](#6-contacts--escalation)
7. [Post-Incident Checklist](#7-post-incident-checklist)
8. [Appendix: Backup Infrastructure Reference](#8-appendix-backup-infrastructure-reference)

---

## 1. Overview & Targets

AfroPay is a remittance platform handling real USDC escrow funds. Data loss or extended downtime has direct financial consequences for users. This runbook defines the recovery procedures, targets, and monthly drill schedule.

| Target | Value | Justification |
|--------|-------|---------------|
| **RTO** (Recovery Time Objective) | **≤ 4 hours** | Remittance SLA; escrow timeouts are typically set to 2 h, meaning a 4 h recovery window avoids mass refund triggers |
| **RPO** (Recovery Point Objective) | **≤ 15 minutes** | WAL archiving runs every 10 min (`archive_timeout = 600`); worst-case loss is one unarchived WAL segment |

### What Is In Scope

| System | Criticality | Backup Method |
|--------|-------------|---------------|
| PostgreSQL (escrow state, events, reconciliation, idempotency) | **CRITICAL** | pgBackRest WAL archiving → S3 |
| Redis (BullMQ queues, rate-limit counters, idempotency cache) | **HIGH** | RDB + AOF → S3 |
| Secrets (DB passwords, API keys, Stellar signing keys) | **CRITICAL** | AWS Secrets Manager with automated rotation |
| Stellar contract state | OUT OF SCOPE | Managed by Stellar network — immutable on-chain |

---

## 2. Architecture & Backup Strategy

### 2.1 PostgreSQL Backup Architecture

```
┌─────────────────────────────────────────────────────────┐
│  PostgreSQL Primary                                      │
│  wal_level = replica                                     │
│  archive_timeout = 600s  (→ RPO ≤ 15 min)              │
│  archive_command = 'pgbackrest archive-push %p'         │
└──────────────┬──────────────────────────────────────────┘
               │  WAL segments (continuous)
               │  Full backup (weekly Sun 02:00 UTC)
               │  Differential backup (daily Mon–Sat 02:00 UTC)
               ▼
┌─────────────────────────────────────────────────────────┐
│  S3 Bucket: afropay-db-backups                          │
│  Encryption: AES-256-CBC (pgBackRest cipher)            │
│  Region: us-east-1                                      │
│  Retention: 2 full + 14 diff backups                   │
│  Path layout: afropay/backup/*, afropay/archive/*       │
└─────────────────────────────────────────────────────────┘
```

Relevant files:
- `infrastructure/backup/postgres.conf` — WAL archiving parameters
- `infrastructure/backup/pgbackrest.conf` — pgBackRest global + stanza config

### 2.2 Redis Backup Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Redis 7.2                                               │
│  RDB snapshots: every 60s if ≥1000 keys changed         │
│  AOF: appendfsync everysec                              │
│  aof-use-rdb-preamble yes (hybrid format)               │
└──────────────┬──────────────────────────────────────────┘
               │  /data/dump.rdb + /data/appendonly.aof
               ▼
┌─────────────────────────────────────────────────────────┐
│  S3 Bucket: afropay-redis-backups                       │
│  Sync: every 15 min via cron (rclone s3 copy)           │
│  Retention: 7 days of snapshots                         │
└─────────────────────────────────────────────────────────┘
```

Relevant files:
- `infrastructure/backup/redis.conf` — Redis persistence configuration
- `infrastructure/backup/docker-compose.redis-dr-test.yml` — DR validation test

### 2.3 Secrets Management

All credentials are stored in **AWS Secrets Manager** and injected at runtime:

| Secret Name | Contents | Rotation |
|-------------|----------|----------|
| `afropay/prod/postgres` | DB password, connection string | 90 days |
| `afropay/prod/redis` | Redis AUTH password | 90 days |
| `afropay/prod/stellar` | Stellar signing key (encrypted) | Manual |
| `afropay/prod/pgbackrest` | S3 key, cipher passphrase | 90 days |
| `afropay/prod/slack-webhook` | DR drill Slack webhook URL | On rotation |

---

## 3. RPO Evidence — WAL Archiving Interval

**Claim:** RPO ≤ 15 minutes.

**Evidence:**

The PostgreSQL `archive_timeout` parameter in `infrastructure/backup/postgres.conf` is set to `600` seconds (10 minutes):

```conf
archive_timeout = 600
```

This forces PostgreSQL to close and archive any open WAL segment after 600 seconds even if it is not full. Combined with the default WAL segment size of 16 MB (which fills and archives in seconds under normal load), this provides:

- **Worst-case RPO:** 10 minutes of unarchived WAL (one open segment at moment of failure)
- **Typical RPO under production load:** < 1 minute (WAL segments fill rapidly)
- **Target:** 15 minutes ✅

The `archive_command` calls `pgbackrest archive-push`, which uploads the WAL segment to S3 with LZ4 compression. If the archive command fails transiently, PostgreSQL retries automatically. The `archive-push-queue-max = 128mb` parameter buffers up to 8 segments during S3 outages without blocking writes.

---

## 4. Scenario Playbooks

### 4.1 PostgreSQL Complete Loss

**Trigger:** Database host destroyed (hardware failure, accidental deletion, ransomware).

**Estimated recovery time:** 45–120 minutes (depends on backup size and network speed).

#### Steps

1. **Declare incident** — notify the on-call engineer and incident channel.

2. **Provision a new PostgreSQL host** with the same version (16.x):
   ```bash
   # Example using cloud provider CLI
   # Ensure the host has the same Postgres version as the backup
   apt-get install postgresql-16 pgbackrest
   ```

3. **Copy pgBackRest config to the new host:**
   ```bash
   scp infrastructure/backup/pgbackrest.conf new-host:/etc/pgbackrest/pgbackrest.conf
   ```

4. **Inject secrets** (do not hard-code):
   ```bash
   export PGBACKREST_S3_KEY=$(aws secretsmanager get-secret-value \
     --secret-id afropay/prod/pgbackrest --query SecretString --output text | jq -r .s3_key)
   export PGBACKREST_S3_KEY_SECRET=$(...)
   export PGBACKREST_REPO1_CIPHER_PASS=$(...)
   ```

5. **Run the PITR restore script:**
   ```bash
   # Restore to latest available WAL (full recovery)
   ./scripts/dr/restore-postgres.sh \
     --target-time "$(date -u +"%Y-%m-%d %H:%M:%S UTC")" \
     --stanza afropay \
     --pgdata /var/lib/postgresql/data
   ```

6. **Verify output JSON result** in `docs/operations/dr-drill-results/`.

7. **Update DNS / connection strings** to point to the new host.

8. **Re-enable WAL archiving** on the new primary (it is auto-configured via `postgres.conf`).

9. **Notify stakeholders** — send incident update once DB is healthy.

**Verification:** Run `psql -c "SELECT COUNT(*) FROM escrow_events;"` and compare against the last known row count from monitoring dashboards.

---

### 4.2 PostgreSQL Data Corruption (PITR)

**Trigger:** Accidental `DELETE`/`UPDATE` without `WHERE`, bad migration, application bug corrupting rows.

**Goal:** Restore to the last known-good state (up to 1 minute before the corrupting event).

#### Steps

1. **Identify the corruption timestamp** from:
   - Application logs / Sentry error timestamp
   - `pg_stat_activity` if the query is still running
   - Grafana dashboard (spike in error rate or unusual write volume)

2. **Do not restart or write to the database** — stop the API layer first:
   ```bash
   # Scale down API pods / stop the service
   kubectl scale deployment afropay-api --replicas=0
   ```

3. **Run PITR restore to 1 minute before the corruption:**
   ```bash
   ./scripts/dr/restore-postgres.sh \
     --target-time "2026-07-21 05:59:00 UTC" \
     --stanza afropay \
     --pgdata /var/lib/postgresql/data
   ```

4. **Validate the restored data** — the script runs 8 integrity checks automatically.

5. **Re-enable the API layer** once you confirm the corrupt rows are absent:
   ```bash
   kubectl scale deployment afropay-api --replicas=3
   ```

6. **Identify root cause** and add a migration or constraint to prevent recurrence.

---

### 4.3 Redis Loss

**Trigger:** Redis container crash, volume deletion, or host failure.

**Impact:**
- **BullMQ jobs in `active` state** — re-queued automatically by BullMQ stalled-job detection (within 30 seconds of API restart)
- **Idempotency cache** — falls back to Postgres `webhook_idempotency` table (slower but correct)
- **Rate-limit counters** — reset to zero; brief window where rate limits are not enforced

**RPO for Redis:** Up to 1 second (AOF `everysec`) for queue data. Rate-limit counters accept full loss.

#### Steps

1. **Copy backup files from S3:**
   ```bash
   aws s3 cp s3://afropay-redis-backups/latest/dump.rdb /data/dump.rdb
   aws s3 cp s3://afropay-redis-backups/latest/appendonly.aof /data/appendonly.aof
   ```

2. **Start a new Redis instance** with the backup config:
   ```bash
   docker run -d \
     --name afropay-redis-restored \
     -v /data:/data \
     -p 6379:6379 \
     redis:7.2-alpine \
     redis-server --appendonly yes --aof-use-rdb-preamble yes
   ```

3. **Validate key counts:**
   ```bash
   redis-cli DBSIZE
   redis-cli KEYS "idempotency:*" | wc -l
   redis-cli LLEN "bull:payment:wait"
   ```

4. **Run the automated validation:**
   ```bash
   docker compose -f infrastructure/backup/docker-compose.redis-dr-test.yml up --abort-on-container-exit
   ```

5. **Update Redis connection string** in the API config to point to the new instance.

---

### 4.4 Secrets / Credentials Compromised

**Trigger:** Leaked environment variable, compromised CI secret, or insider threat.

#### Immediate Actions (< 30 minutes)

1. **Rotate all affected secrets** in AWS Secrets Manager immediately.
2. **Revoke the old credentials** at the provider level (AWS IAM, Stellar, payment processors).
3. **Redeploy all services** to pick up the new secrets.
4. **Audit access logs** in CloudTrail for unauthorized use.

#### PostgreSQL

```bash
# Rotate the Postgres password
psql -c "ALTER USER afropay_api PASSWORD 'new-strong-password';"
# Update Secrets Manager
aws secretsmanager put-secret-value --secret-id afropay/prod/postgres \
  --secret-string '{"password":"new-strong-password"}'
```

#### Stellar Signing Key

A compromised Stellar signing key requires:
1. Removing the compromised key from all accounts via `SetOptions` (multi-sig required)
2. Adding a new key
3. Notifying affected oracle operators

**This is a P0 incident — escalate to the Security team immediately.**

---

### 4.5 Application API Layer Loss

**Trigger:** NestJS API pods all down; Postgres and Redis are healthy.

**Recovery:** Scale up API pods (stateless service). No data recovery needed.

```bash
kubectl rollout restart deployment/afropay-api
kubectl get pods -l app=afropay-api -w
```

**RTO for API-only failure:** < 5 minutes.

---

## 5. Monthly Drill Procedure

The DR drill validates that the restore procedure works end-to-end on staging before a real incident occurs. It runs automatically via GitHub Actions on the **first Monday of each month** (`.github/workflows/dr-drill.yml`).

### 5.1 Automated Drill (GitHub Actions)

The `dr-drill.yml` workflow:
1. Provisions a temporary PostgreSQL instance on the GitHub Actions runner.
2. Calls `restore-postgres.sh --target-time "1 hour ago"`.
3. Runs all 8 integrity checks.
4. Posts the result JSON to the `#dr-alerts` Slack channel.
5. Commits the result file to `docs/operations/dr-drill-results/`.

**Required GitHub secrets:**
```
DR_SLACK_WEBHOOK_URL        # Slack incoming webhook URL
PGBACKREST_S3_BUCKET        # S3 bucket name
PGBACKREST_S3_REGION        # AWS region
PGBACKREST_S3_KEY           # AWS access key ID
PGBACKREST_S3_KEY_SECRET    # AWS secret access key
PGBACKREST_REPO1_CIPHER_PASS # Encryption passphrase
STAGING_DB_PASSWORD         # Staging Postgres password
```

### 5.2 Manual Drill Steps (if automation fails)

Run on a staging environment — never on production during a drill.

```bash
# 1. Confirm backup coverage
pgbackrest --stanza=afropay info

# 2. Run restore to 1 hour ago
./scripts/dr/restore-postgres.sh \
  --target-time "$(date -u -d '1 hour ago' +'%Y-%m-%d %H:%M:%S UTC')" \
  --stanza afropay

# 3. Confirm result
cat docs/operations/dr-drill-results/*_result.json | jq .

# 4. Run Redis DR validation
docker compose -f infrastructure/backup/docker-compose.redis-dr-test.yml \
  up --abort-on-container-exit

# 5. Record results
# Commit the result JSON from docs/operations/dr-drill-results/ to the repo
```

### 5.3 Drill Pass/Fail Criteria

| Criterion | Pass Condition |
|-----------|----------------|
| Restore completes | Exit code 0 from `restore-postgres.sh` |
| RTO | `elapsed_seconds` ≤ 14400 (4 h) |
| RPO evidence | `archive_timeout = 600` present in `postgres.conf` |
| All 8 integrity checks | No `FAIL:` entries in result JSON |
| Redis key count | Restored key count == seeded key count |
| Slack notification | Message appears in `#dr-alerts` within 5 min of workflow completion |

### 5.4 Result Storage

All drill results are committed to `docs/operations/dr-drill-results/` as:

```
docs/operations/dr-drill-results/
├── README.md                           — index of all drill results
├── 2026-07-07_020500_result.json      — July drill (auto-generated)
├── 2026-08-03_020500_result.json      — August drill
└── ...
```

---

## 6. Contacts & Escalation

| Role | Responsibility | Escalation Path |
|------|----------------|-----------------|
| On-call Engineer | First responder; executes runbook | PagerDuty rotation |
| Platform Lead | Approves production changes during restore | Direct contact |
| Security Lead | Handles secrets compromise scenarios | Security hotline |
| CTO | P0 escalation (> 2 h downtime, fund risk) | Emergency contact |

**Incident channel:** `#incidents` on Slack  
**DR alerts channel:** `#dr-alerts` on Slack  
**PagerDuty service:** `afropay-platform`

---

## 7. Post-Incident Checklist

After any production DR activation (not drills):

- [ ] Incident timeline documented (when detected, when restored, root cause)
- [ ] RTO/RPO actuals recorded and compared against targets
- [ ] Drill result JSON committed to `docs/operations/dr-drill-results/`
- [ ] Root cause identified and prevention ticket created
- [ ] Runbook updated if any steps were incorrect or missing
- [ ] Backup infrastructure reviewed (was archiving working as expected?)
- [ ] Stakeholder communication sent (customers if data loss occurred)
- [ ] Quarterly runbook review scheduled if this was a gap

---

## 8. Appendix: Backup Infrastructure Reference

### File Reference

| File | Purpose |
|------|---------|
| `infrastructure/backup/postgres.conf` | WAL archiving parameters for PostgreSQL |
| `infrastructure/backup/pgbackrest.conf` | pgBackRest stanza config (S3 target, encryption, retention) |
| `infrastructure/backup/redis.conf` | Redis RDB + AOF persistence settings |
| `infrastructure/backup/docker-compose.redis-dr-test.yml` | Redis DR validation compose test |
| `scripts/dr/restore-postgres.sh` | PITR restore script with 8 integrity checks |
| `.github/workflows/dr-drill.yml` | Monthly automated drill workflow |
| `docs/operations/dr-drill-results/` | Historical drill results (JSON) |

### Key Commands Reference

```bash
# Check pgBackRest backup status
pgbackrest --stanza=afropay info

# Verify WAL archiving is working
pgbackrest --stanza=afropay check

# Take an ad-hoc full backup
pgbackrest --stanza=afropay backup --type=full

# Restore to latest
pgbackrest --stanza=afropay restore

# Restore to specific time (PITR)
pgbackrest --stanza=afropay restore \
  --type=time \
  --target="2026-07-21 06:00:00 UTC" \
  --target-action=promote

# Redis: trigger manual snapshot
redis-cli BGSAVE

# Redis: check AOF status
redis-cli INFO persistence | grep aof

# Run full DR drill locally
./scripts/dr/restore-postgres.sh --dry-run
docker compose -f infrastructure/backup/docker-compose.redis-dr-test.yml up
```

### S3 Bucket Layout

```
afropay-db-backups/
└── afropay/
    ├── archive/
    │   └── 16-1/           # PostgreSQL 16, system identifier
    │       └── WAL/        # WAL segments (continuous)
    └── backup/
        ├── 20260601-020000F/  # Full backup
        ├── 20260602-020000D/  # Differential
        └── ...

afropay-redis-backups/
├── latest/
│   ├── dump.rdb
│   └── appendonly.aof
└── archive/
    └── YYYY-MM-DD/
        ├── dump.rdb
        └── appendonly.aof
```
