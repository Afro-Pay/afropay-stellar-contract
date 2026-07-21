# DR Drill Results

This directory contains the output of every AfroPay disaster recovery drill,
both automated (GitHub Actions monthly) and manual.

Each result file is named `YYYY-MM-DD_HHMMSS_result.json` and is generated
automatically by `scripts/dr/restore-postgres.sh`.

## Result Schema

```json
{
  "drill_date":          "ISO-8601 UTC timestamp when the drill started",
  "completed_at":        "ISO-8601 UTC timestamp when the drill finished",
  "elapsed_seconds":     "Total wall-clock seconds for restore + integrity checks",
  "target_time":         "The PITR target time used for this drill",
  "stanza":              "pgBackRest stanza name (afropay)",
  "pgdata":              "PostgreSQL data directory path",
  "status":              "PASS | FAIL | INTEGRITY_FAILED | RTO_EXCEEDED | PRECONDITION_FAILED",
  "rto_target_seconds":  14400,
  "rto_met":             true,
  "rpo_target_minutes":  15,
  "dry_run":             false,
  "notes":               ["array of log messages"],
  "integrity_checks":    ["array of PASS/FAIL/WARN/INFO per check"]
}
```

## Integrity Checks (8 total)

| # | Check | Pass Condition |
|---|-------|----------------|
| 1 | Database connectivity | psql can connect, databases are listed |
| 2 | Recovery target time | DB `NOW()` is at or after the target time |
| 3 | Required tables exist | All 5 AfroPay tables present with row counts |
| 4 | escrow_events immutability | No rows with negative IDs |
| 5 | Long-running transactions | No transactions running > 5 min |
| 6 | Replication slots | No active replication slots on restored instance |
| 7 | Checkpoint freshness | `checkpoint_store` updated within RPO window |
| 8 | FK integrity | No orphaned `reconciliation_reports` rows |

## Drill History

| Date | Status | Elapsed | RTO Met | Notes |
|------|--------|---------|---------|-------|
| _(automated results will appear here)_ | | | | |

## How Results Are Generated

Results are posted automatically by the `.github/workflows/dr-drill.yml` workflow,
which runs on the first Monday of each month. The workflow:

1. Restores staging PostgreSQL to a point 1 hour in the past
2. Runs all 8 integrity checks
3. Commits the JSON result file to this directory
4. Posts a summary to the `#dr-alerts` Slack channel

To run a manual drill, see the procedure in
[docs/operations/disaster-recovery.md](../disaster-recovery.md#5-monthly-drill-procedure).
