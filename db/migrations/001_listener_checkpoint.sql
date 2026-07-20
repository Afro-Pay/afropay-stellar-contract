-- Migration 001: Horizon listener checkpoint and escrow event deduplication tables
--
-- checkpoint_store   — persists the last successfully processed paging_token
--                      so the listener can detect ledger gaps on reconnect.
-- escrow_events      — append-only, insert-idempotent log of every contract
--                      event the listener has processed (keyed on event_id to
--                      prevent duplicate inserts on catch-up replay).

-- ---------------------------------------------------------------------------
-- checkpoint_store
-- ---------------------------------------------------------------------------
-- A single-row table: the listener upserts the paging_token after every
-- processed ledger batch.  The "singleton" pattern uses a fixed primary key
-- ('horizon') so there is never more than one row.
CREATE TABLE IF NOT EXISTS checkpoint_store (
    service_name  TEXT        NOT NULL PRIMARY KEY DEFAULT 'horizon',
    paging_token  TEXT        NOT NULL,
    ledger_seq    BIGINT      NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- escrow_events
-- ---------------------------------------------------------------------------
-- Immutable audit log of every Soroban contract event emitted by the escrow
-- contract and ingested by the listener.
--
-- event_id is Horizon's canonical "<ledger_seq>-<operation_order>-<event_index>"
-- identifier; it is the natural idempotency key for replay.
CREATE TABLE IF NOT EXISTS escrow_events (
    id               BIGSERIAL   PRIMARY KEY,
    event_id         TEXT        NOT NULL UNIQUE,   -- Horizon canonical event ID — idempotency key
    paging_token     TEXT        NOT NULL,
    ledger_seq       BIGINT      NOT NULL,
    tx_hash          TEXT        NOT NULL,
    contract_id      TEXT        NOT NULL,
    event_type       TEXT        NOT NULL,          -- 'deposit' | 'release' | 'refund' | 'oracle_submit'
    escrow_id        TEXT,
    payload          JSONB       NOT NULL,          -- full decoded event body
    replayed         BOOLEAN     NOT NULL DEFAULT FALSE,  -- true when inserted via catch-up
    processed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS escrow_events_ledger_seq  ON escrow_events (ledger_seq);
CREATE INDEX IF NOT EXISTS escrow_events_escrow_id   ON escrow_events (escrow_id) WHERE escrow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS escrow_events_event_type  ON escrow_events (event_type);
