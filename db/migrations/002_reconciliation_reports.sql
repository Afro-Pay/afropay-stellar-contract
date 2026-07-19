-- Migration 002: Reconciliation service tables
--
-- reconciliation_runs   — one row per reconciliation run (tracks timing for the
--                         5-minute cooldown check and provides a run_id foreign key).
-- reconciliation_reports — one row per discrepancy found within a run.

-- ---------------------------------------------------------------------------
-- reconciliation_runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id             BIGSERIAL   PRIMARY KEY,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at   TIMESTAMPTZ,
    triggered_by   TEXT        NOT NULL,   -- 'startup' | 'admin_api'
    heal_requested BOOLEAN     NOT NULL DEFAULT FALSE,
    total_checked  INTEGER     NOT NULL DEFAULT 0,
    total_matched  INTEGER     NOT NULL DEFAULT 0,
    total_discrepancies INTEGER NOT NULL DEFAULT 0,
    total_healed   INTEGER     NOT NULL DEFAULT 0,
    status         TEXT        NOT NULL DEFAULT 'running'  -- 'running' | 'completed' | 'failed'
);

-- ---------------------------------------------------------------------------
-- reconciliation_reports
-- ---------------------------------------------------------------------------
-- One row per escrow discrepancy detected in a run.
-- scenario values:
--   'status_mismatch'        — escrow exists in both DB and chain but states differ
--   'missing_from_db'        — escrow exists on-chain but not in DB
--   'missing_from_chain'     — escrow exists in DB but not found on-chain
CREATE TABLE IF NOT EXISTS reconciliation_reports (
    id             BIGSERIAL   PRIMARY KEY,
    run_id         BIGINT      NOT NULL REFERENCES reconciliation_runs(id),
    escrow_id      TEXT        NOT NULL,
    scenario       TEXT        NOT NULL,
    db_state       TEXT,                  -- NULL when missing_from_db
    chain_state    TEXT,                  -- NULL when missing_from_chain
    healed         BOOLEAN     NOT NULL DEFAULT FALSE,
    heal_detail    TEXT,                  -- log message written when heal applied
    detected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reconciliation_reports_run_id   ON reconciliation_reports (run_id);
CREATE INDEX IF NOT EXISTS reconciliation_reports_escrow_id ON reconciliation_reports (escrow_id);
CREATE INDEX IF NOT EXISTS reconciliation_reports_scenario  ON reconciliation_reports (scenario);

-- Fast lookup of the most recent completed run (used for cooldown check).
CREATE INDEX IF NOT EXISTS reconciliation_runs_completed_at
    ON reconciliation_runs (completed_at DESC NULLS LAST)
    WHERE status = 'completed';
