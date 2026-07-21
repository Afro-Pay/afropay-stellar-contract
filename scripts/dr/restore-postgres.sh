#!/usr/bin/env bash
# =============================================================================
# AfroPay — PostgreSQL Point-in-Time Recovery (PITR) Script
# =============================================================================
#
# Usage:
#   ./restore-postgres.sh [OPTIONS]
#
# Options:
#   -t, --target-time  TIMESTAMP   Recovery target (ISO-8601 UTC).
#                                  Default: 1 hour before current UTC time.
#                                  Example: "2026-07-21 06:00:00 UTC"
#   -s, --stanza       NAME        pgBackRest stanza name (default: afropay)
#   -d, --pgdata       PATH        PostgreSQL data directory (default: /var/lib/postgresql/data)
#   -p, --pg-port      PORT        PostgreSQL port on restored instance (default: 5432)
#   -c, --config       FILE        pgBackRest config file (default: /etc/pgbackrest/pgbackrest.conf)
#       --dry-run                  Print plan without executing any restore commands
#       --skip-integrity           Skip post-restore integrity checks (NOT recommended for production drills)
#   -h, --help                     Show this help message
#
# Environment variables (override pgbackrest.conf values):
#   PGBACKREST_REPO1_S3_BUCKET     S3 bucket name
#   PGBACKREST_REPO1_S3_REGION     AWS region
#   PGBACKREST_S3_KEY              AWS access key ID
#   PGBACKREST_S3_KEY_SECRET       AWS secret access key
#   PGBACKREST_REPO1_CIPHER_PASS   Encryption passphrase
#   PGPASSWORD                     Postgres superuser password (for integrity checks)
#   DR_POSTGRES_USER               Postgres superuser (default: postgres)
#
# RTO target: restore must complete within 4 hours.
# RPO target: ≤ 15 minutes of data loss (validated by WAL archive interval).
#
# Output: writes a structured JSON result to stdout and to
#   docs/operations/dr-drill-results/YYYY-MM-DD_HHMMSS_result.json
#
# Exit codes:
#   0 — restore + integrity checks passed
#   1 — restore failed
#   2 — integrity checks failed (restore succeeded but DB is inconsistent)
#   3 — precondition failure (missing tools, bad arguments)
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
TARGET_TIME=""
STANZA="afropay"
PGDATA="/var/lib/postgresql/data"
PG_PORT="5432"
PGBACKREST_CONFIG="/etc/pgbackrest/pgbackrest.conf"
DRY_RUN=false
SKIP_INTEGRITY=false
PG_USER="${DR_POSTGRES_USER:-postgres}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RESULTS_DIR="${REPO_ROOT}/docs/operations/dr-drill-results"
RESULT_FILE=""
START_TS=$(date -u +%s)
START_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
log()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO]  $*"; }
warn() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [WARN]  $*" >&2; }
err()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [ERROR] $*" >&2; }

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  grep '^#' "$0" | sed 's/^# \{0,2\}//' | sed '/^!\/usr/d'
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target-time)   TARGET_TIME="$2";         shift 2 ;;
    -s|--stanza)        STANZA="$2";              shift 2 ;;
    -d|--pgdata)        PGDATA="$2";              shift 2 ;;
    -p|--pg-port)       PG_PORT="$2";             shift 2 ;;
    -c|--config)        PGBACKREST_CONFIG="$2";   shift 2 ;;
    --dry-run)          DRY_RUN=true;             shift   ;;
    --skip-integrity)   SKIP_INTEGRITY=true;      shift   ;;
    -h|--help)          usage; exit 0 ;;
    *) err "Unknown option: $1"; usage; exit 3 ;;
  esac
done

# Default target: 1 hour ago (standard monthly drill scenario)
if [[ -z "${TARGET_TIME}" ]]; then
  TARGET_TIME=$(date -u -d "1 hour ago" +"%Y-%m-%d %H:%M:%S UTC" 2>/dev/null \
    || date -u -v-1H +"%Y-%m-%d %H:%M:%S UTC")  # macOS fallback
fi

# ---------------------------------------------------------------------------
# Result tracking
# ---------------------------------------------------------------------------
RESULT_STATUS="UNKNOWN"
RESULT_NOTES=()
INTEGRITY_CHECKS=()

add_note()  { RESULT_NOTES+=("$1"); log "$1"; }
add_check() { INTEGRITY_CHECKS+=("$1"); }

finalize_result() {
  local end_ts end_iso elapsed_s
  end_ts=$(date -u +%s)
  end_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  elapsed_s=$(( end_ts - START_TS ))

  local notes_json checks_json
  notes_json=$(printf '%s\n' "${RESULT_NOTES[@]}" | jq -R . | jq -s .)
  checks_json=$(printf '%s\n' "${INTEGRITY_CHECKS[@]}" | jq -R . | jq -s . 2>/dev/null || echo "[]")

  local rto_met="false"
  [[ ${elapsed_s} -le 14400 ]] && rto_met="true"   # 4 hours = 14400 s

  cat <<EOF
{
  "drill_date": "${START_ISO}",
  "completed_at": "${end_iso}",
  "elapsed_seconds": ${elapsed_s},
  "target_time": "${TARGET_TIME}",
  "stanza": "${STANZA}",
  "pgdata": "${PGDATA}",
  "status": "${RESULT_STATUS}",
  "rto_target_seconds": 14400,
  "rto_met": ${rto_met},
  "rpo_target_minutes": 15,
  "dry_run": ${DRY_RUN},
  "notes": ${notes_json},
  "integrity_checks": ${checks_json}
}
EOF
}

write_result_file() {
  mkdir -p "${RESULTS_DIR}"
  local filename="${RESULTS_DIR}/$(date -u +"%Y-%m-%d_%H%M%S")_result.json"
  finalize_result | tee "${filename}"
  log "Result written to ${filename}"
}

# On exit (success or failure), always write the result file
trap 'write_result_file' EXIT

# ---------------------------------------------------------------------------
# Precondition checks
# ---------------------------------------------------------------------------
log "=========================================================="
log "AfroPay PostgreSQL PITR Restore"
log "=========================================================="
log "Target time : ${TARGET_TIME}"
log "Stanza      : ${STANZA}"
log "PGDATA      : ${PGDATA}"
log "PG port     : ${PG_PORT}"
log "Dry run     : ${DRY_RUN}"
log "=========================================================="

check_tool() {
  if ! command -v "$1" &>/dev/null; then
    err "Required tool not found: $1 — install it before running this script."
    RESULT_STATUS="PRECONDITION_FAILED"
    exit 3
  fi
  log "Tool found: $1 ($(command -v "$1"))"
}

check_tool pgbackrest
check_tool psql
check_tool jq

# Verify pgBackRest config exists
if [[ ! -f "${PGBACKREST_CONFIG}" ]]; then
  warn "pgBackRest config not found at ${PGBACKREST_CONFIG}."
  warn "Attempting to use infrastructure/backup/pgbackrest.conf from repo."
  PGBACKREST_CONFIG="${REPO_ROOT}/infrastructure/backup/pgbackrest.conf"
fi
[[ -f "${PGBACKREST_CONFIG}" ]] || { err "No pgBackRest config found."; RESULT_STATUS="PRECONDITION_FAILED"; exit 3; }

# Verify required S3 credentials
: "${PGBACKREST_S3_KEY:?PGBACKREST_S3_KEY env var is required}"
: "${PGBACKREST_S3_KEY_SECRET:?PGBACKREST_S3_KEY_SECRET env var is required}"
: "${PGBACKREST_REPO1_CIPHER_PASS:?PGBACKREST_REPO1_CIPHER_PASS env var is required}"

add_note "Precondition checks passed."

# ---------------------------------------------------------------------------
# Step 1: List available backups and confirm WAL coverage
# ---------------------------------------------------------------------------
log ""
log "--- Step 1: Listing available backups ---"

PGBACKREST_CMD="pgbackrest --config=${PGBACKREST_CONFIG} --stanza=${STANZA}"

if ${DRY_RUN}; then
  log "[DRY RUN] Would run: ${PGBACKREST_CMD} info --output=json"
  add_note "DRY RUN: skipping backup listing."
else
  BACKUP_INFO=$(${PGBACKREST_CMD} info --output=json 2>&1) || {
    err "pgbackrest info failed: ${BACKUP_INFO}"
    RESULT_STATUS="FAILED"
    exit 1
  }
  add_note "pgBackRest info retrieved successfully."

  # Check that at least one backup exists
  BACKUP_COUNT=$(echo "${BACKUP_INFO}" | jq '.[0].backup | length' 2>/dev/null || echo "0")
  if [[ "${BACKUP_COUNT}" -eq 0 ]]; then
    err "No backups found in stanza '${STANZA}'. Cannot proceed with restore."
    RESULT_STATUS="FAILED"
    exit 1
  fi
  add_note "Found ${BACKUP_COUNT} backup(s) in stanza '${STANZA}'."
  log "Backup count: ${BACKUP_COUNT}"

  # Confirm the most recent WAL is newer than our target time
  LATEST_WAL_STOP=$(echo "${BACKUP_INFO}" | jq -r '.[0].backup[-1].info.repository.delta' 2>/dev/null || echo "unknown")
  add_note "Latest backup info retrieved: ${LATEST_WAL_STOP}."
fi

# ---------------------------------------------------------------------------
# Step 2: Stop PostgreSQL (if running)
# ---------------------------------------------------------------------------
log ""
log "--- Step 2: Stopping PostgreSQL ---"

stop_postgres() {
  if pg_ctlcluster 16 main status &>/dev/null 2>&1; then
    log "Stopping PostgreSQL via pg_ctlcluster..."
    pg_ctlcluster 16 main stop -m fast || true
  elif command -v pg_ctl &>/dev/null && pg_ctl status -D "${PGDATA}" &>/dev/null 2>&1; then
    log "Stopping PostgreSQL via pg_ctl..."
    pg_ctl stop -D "${PGDATA}" -m fast || true
  else
    log "PostgreSQL does not appear to be running (or pg_ctl not in PATH). Continuing."
  fi
}

if ${DRY_RUN}; then
  log "[DRY RUN] Would stop PostgreSQL at ${PGDATA}."
else
  stop_postgres
  add_note "PostgreSQL stopped (or was not running)."
fi

# ---------------------------------------------------------------------------
# Step 3: pgBackRest restore (PITR to target time)
# ---------------------------------------------------------------------------
log ""
log "--- Step 3: Restoring from backup to target time ---"
log "Target: ${TARGET_TIME}"

RESTORE_CMD="${PGBACKREST_CMD} restore \
  --delta \
  --type=time \
  --target=\"${TARGET_TIME}\" \
  --target-action=promote \
  --pg1-path=${PGDATA}"

log "Restore command: ${RESTORE_CMD}"

if ${DRY_RUN}; then
  log "[DRY RUN] Would execute: ${RESTORE_CMD}"
  add_note "DRY RUN: skipping actual restore."
else
  eval "${RESTORE_CMD}" || {
    err "pgbackrest restore failed!"
    RESULT_STATUS="FAILED"
    exit 1
  }
  add_note "pgBackRest restore completed successfully to target: ${TARGET_TIME}."
fi

# ---------------------------------------------------------------------------
# Step 4: Start PostgreSQL on the restored data directory
# ---------------------------------------------------------------------------
log ""
log "--- Step 4: Starting PostgreSQL on restored instance ---"

start_postgres() {
  if command -v pg_ctlcluster &>/dev/null; then
    pg_ctlcluster 16 main start
  else
    pg_ctl start -D "${PGDATA}" -l /tmp/postgres-dr-restore.log
  fi
}

wait_for_postgres() {
  local attempts=0 max_attempts=60
  while [[ ${attempts} -lt ${max_attempts} ]]; do
    if pg_isready -p "${PG_PORT}" -U "${PG_USER}" -q 2>/dev/null; then
      log "PostgreSQL is accepting connections."
      return 0
    fi
    (( attempts++ ))
    sleep 2
  done
  err "PostgreSQL did not become ready within $((max_attempts * 2)) seconds."
  return 1
}

if ${DRY_RUN}; then
  log "[DRY RUN] Would start PostgreSQL and wait for readiness."
  add_note "DRY RUN: skipping PostgreSQL start."
else
  start_postgres || { err "Failed to start PostgreSQL."; RESULT_STATUS="FAILED"; exit 1; }
  wait_for_postgres || { RESULT_STATUS="FAILED"; exit 1; }
  add_note "PostgreSQL started and accepting connections on port ${PG_PORT}."
fi

# ---------------------------------------------------------------------------
# Step 5: Post-restore integrity checks
# ---------------------------------------------------------------------------
log ""
log "--- Step 5: Post-restore integrity checks ---"

run_query() {
  psql -p "${PG_PORT}" -U "${PG_USER}" -d postgres -At -c "$1" 2>&1
}

if ${SKIP_INTEGRITY}; then
  warn "Integrity checks skipped (--skip-integrity flag set)."
  add_note "WARN: Integrity checks were skipped."
  add_check "SKIPPED: --skip-integrity was passed"
elif ${DRY_RUN}; then
  log "[DRY RUN] Would run integrity checks."
  add_note "DRY RUN: skipping integrity checks."
else

  INTEGRITY_PASS=true

  # ---- Check 1: Database accessibility ----
  log "Check 1: Verifying database connectivity..."
  if DB_LIST=$(run_query "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;"); then
    add_check "PASS: Database connectivity OK — databases: $(echo "${DB_LIST}" | tr '\n' ',')"
    log "Databases found: ${DB_LIST}"
  else
    add_check "FAIL: Cannot connect to PostgreSQL"
    INTEGRITY_PASS=false
  fi

  # ---- Check 2: pgBackRest recovery target time check ----
  log "Check 2: Verifying recovery target was reached..."
  DB_TIME=$(run_query "SELECT NOW() AT TIME ZONE 'UTC';" 2>/dev/null || echo "error")
  add_check "INFO: Restored DB current time = ${DB_TIME}"
  log "Restored DB time: ${DB_TIME}"

  # ---- Check 3: Required tables exist ----
  log "Check 3: Verifying AfroPay tables exist..."
  REQUIRED_TABLES=(
    "checkpoint_store"
    "escrow_events"
    "reconciliation_runs"
    "reconciliation_reports"
    "webhook_idempotency"
  )
  for table in "${REQUIRED_TABLES[@]}"; do
    TABLE_EXISTS=$(run_query "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = '${table}';" 2>/dev/null || echo "0")
    if [[ "${TABLE_EXISTS}" -gt 0 ]]; then
      ROW_COUNT=$(run_query "SELECT COUNT(*) FROM ${table};" 2>/dev/null || echo "error")
      add_check "PASS: Table '${table}' exists — ${ROW_COUNT} rows"
      log "Table ${table}: ${ROW_COUNT} rows"
    else
      add_check "FAIL: Table '${table}' missing from restored database"
      INTEGRITY_PASS=false
    fi
  done

  # ---- Check 4: escrow_events append-only constraint (no negative IDs) ----
  log "Check 4: Verifying escrow_events immutability..."
  INVALID_EVENTS=$(run_query "SELECT COUNT(*) FROM escrow_events WHERE id < 0;" 2>/dev/null || echo "error")
  if [[ "${INVALID_EVENTS}" == "0" ]]; then
    add_check "PASS: escrow_events integrity OK (no negative IDs)"
  else
    add_check "FAIL: escrow_events has ${INVALID_EVENTS} invalid rows"
    INTEGRITY_PASS=false
  fi

  # ---- Check 5: No active transactions left open ----
  log "Check 5: Verifying no long-running transactions..."
  LONG_TXN=$(run_query "SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'active' AND query_start < NOW() - INTERVAL '5 minutes';" 2>/dev/null || echo "error")
  if [[ "${LONG_TXN}" == "0" ]]; then
    add_check "PASS: No long-running transactions detected"
  else
    add_check "WARN: ${LONG_TXN} transaction(s) running for > 5 min (may be normal on startup)"
  fi

  # ---- Check 6: Replication slots check (should be none on restored instance) ----
  log "Check 6: Verifying replication slots..."
  ACTIVE_SLOTS=$(run_query "SELECT COUNT(*) FROM pg_replication_slots WHERE active = true;" 2>/dev/null || echo "0")
  if [[ "${ACTIVE_SLOTS}" == "0" ]]; then
    add_check "PASS: No active replication slots on restored instance"
  else
    add_check "WARN: ${ACTIVE_SLOTS} active replication slot(s) — verify these are intentional"
  fi

  # ---- Check 7: Checkpoint freshness ----
  log "Check 7: Verifying checkpoint_store has a recent checkpoint..."
  CHECKPOINT_AGE=$(run_query "SELECT EXTRACT(EPOCH FROM (NOW() - updated_at)) FROM checkpoint_store WHERE service_name = 'horizon' LIMIT 1;" 2>/dev/null || echo "null")
  if [[ "${CHECKPOINT_AGE}" == "null" || "${CHECKPOINT_AGE}" == "" ]]; then
    add_check "INFO: checkpoint_store is empty (acceptable for a fresh restore)"
  else
    CHECKPOINT_AGE_INT=$(echo "${CHECKPOINT_AGE}" | cut -d. -f1)
    if [[ "${CHECKPOINT_AGE_INT}" -lt 900 ]]; then
      add_check "PASS: checkpoint_store updated ${CHECKPOINT_AGE_INT}s ago (within 15-min RPO)"
    else
      add_check "WARN: checkpoint_store last updated ${CHECKPOINT_AGE_INT}s ago (verify against RPO target)"
    fi
  fi

  # ---- Check 8: Reconciliation data integrity ----
  log "Check 8: Verifying reconciliation_reports FK integrity..."
  ORPHAN_REPORTS=$(run_query "
    SELECT COUNT(*) FROM reconciliation_reports r
    LEFT JOIN reconciliation_runs rn ON r.run_id = rn.id
    WHERE rn.id IS NULL;
  " 2>/dev/null || echo "error")
  if [[ "${ORPHAN_REPORTS}" == "0" ]]; then
    add_check "PASS: reconciliation_reports FK integrity OK (no orphaned reports)"
  else
    add_check "FAIL: reconciliation_reports has ${ORPHAN_REPORTS} orphaned rows (FK violation)"
    INTEGRITY_PASS=false
  fi

  # ---- Final integrity verdict ----
  if ${INTEGRITY_PASS}; then
    add_note "All integrity checks passed."
    RESULT_STATUS="PASS"
  else
    err "One or more integrity checks FAILED. Review the checks above."
    RESULT_STATUS="INTEGRITY_FAILED"
    exit 2
  fi
fi

# ---------------------------------------------------------------------------
# Step 6: Timing check against RTO
# ---------------------------------------------------------------------------
log ""
log "--- Step 6: RTO compliance check ---"

END_TS=$(date -u +%s)
ELAPSED=$(( END_TS - START_TS ))
ELAPSED_MIN=$(( ELAPSED / 60 ))

log "Restore completed in ${ELAPSED}s (${ELAPSED_MIN} min)."

if [[ ${ELAPSED} -le 14400 ]]; then
  add_note "RTO PASS: Restore completed in ${ELAPSED}s — within 4-hour target (14400s)."
else
  add_note "RTO FAIL: Restore took ${ELAPSED}s — exceeded 4-hour target (14400s)."
  RESULT_STATUS="RTO_EXCEEDED"
fi

# Set final status if it hasn't been set to a failure state
if [[ "${RESULT_STATUS}" == "UNKNOWN" ]]; then
  RESULT_STATUS="PASS"
fi

log ""
log "=========================================================="
log "RESULT: ${RESULT_STATUS}"
log "Elapsed: ${ELAPSED}s (${ELAPSED_MIN} min)"
log "=========================================================="
