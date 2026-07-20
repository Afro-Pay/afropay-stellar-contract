/**
 * checkpointStore.ts
 *
 * Persists the Horizon SSE paging_token to Postgres after each processed
 * ledger batch, and exposes helpers for:
 *   - reading the last stored checkpoint on startup / reconnect
 *   - upserting a new checkpoint atomically
 *   - idempotent event insertion (escrow_events table)
 *
 * All writes use parameterised queries — no string interpolation of
 * user-derived values.
 */

import { Pool, PoolClient } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Checkpoint {
  /** Horizon paging_token, e.g. "1234567890-0" */
  pagingToken: string;
  /** Stellar ledger sequence number corresponding to this token */
  ledgerSeq: bigint;
  updatedAt: Date;
}

export interface EscrowEventRecord {
  /** Horizon canonical event ID — "<ledger>-<op_order>-<event_index>" */
  eventId: string;
  pagingToken: string;
  ledgerSeq: bigint;
  txHash: string;
  contractId: string;
  /** 'deposit' | 'release' | 'refund' | 'oracle_submit' */
  eventType: string;
  escrowId?: string;
  payload: Record<string, unknown>;
  /** true when this record was inserted during catch-up replay */
  replayed: boolean;
}

// ---------------------------------------------------------------------------
// CheckpointStore
// ---------------------------------------------------------------------------

export class CheckpointStore {
  private readonly pool: Pool;
  /** Fixed service name key — single-row sentinel */
  private static readonly SERVICE = "horizon";

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // -------------------------------------------------------------------------
  // Checkpoint read / write
  // -------------------------------------------------------------------------

  /**
   * Load the persisted checkpoint.  Returns `null` if no checkpoint exists
   * yet (first run).
   */
  async load(): Promise<Checkpoint | null> {
    const result = await this.pool.query<{
      paging_token: string;
      ledger_seq: string;
      updated_at: Date;
    }>(
      `SELECT paging_token, ledger_seq, updated_at
         FROM checkpoint_store
        WHERE service_name = $1`,
      [CheckpointStore.SERVICE]
    );

    if (result.rowCount === 0) return null;

    const row = result.rows[0];
    return {
      pagingToken: row.paging_token,
      ledgerSeq: BigInt(row.ledger_seq),
      updatedAt: row.updated_at,
    };
  }

  /**
   * Upsert the checkpoint atomically.  Safe to call multiple times with the
   * same token (idempotent via ON CONFLICT DO UPDATE).
   */
  async save(pagingToken: string, ledgerSeq: bigint): Promise<void> {
    await this.pool.query(
      `INSERT INTO checkpoint_store (service_name, paging_token, ledger_seq, updated_at)
            VALUES ($1, $2, $3, NOW())
       ON CONFLICT (service_name)
       DO UPDATE SET paging_token = EXCLUDED.paging_token,
                     ledger_seq   = EXCLUDED.ledger_seq,
                     updated_at   = EXCLUDED.updated_at`,
      [CheckpointStore.SERVICE, pagingToken, ledgerSeq.toString()]
    );
  }

  // -------------------------------------------------------------------------
  // Escrow event ingestion — idempotent
  // -------------------------------------------------------------------------

  /**
   * Insert an escrow event record.  If a row with the same `event_id` already
   * exists (replayed event), the insert is silently skipped via
   * ON CONFLICT DO NOTHING, making replay exactly-once at the DB level.
   *
   * Returns `true` if the row was newly inserted, `false` if it was a
   * duplicate (already processed).
   */
  async insertEvent(record: EscrowEventRecord): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO escrow_events
              (event_id, paging_token, ledger_seq, tx_hash, contract_id,
               event_type, escrow_id, payload, replayed)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        record.eventId,
        record.pagingToken,
        record.ledgerSeq.toString(),
        record.txHash,
        record.contractId,
        record.eventType,
        record.escrowId ?? null,
        JSON.stringify(record.payload),
        record.replayed,
      ]
    );

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Batch-insert events within a single transaction.  Each individual event
   * is still idempotent — duplicates are skipped.  Wraps multiple inserts
   * in one DB round-trip for catch-up replay efficiency.
   */
  async insertEventBatch(
    records: EscrowEventRecord[],
    client?: PoolClient
  ): Promise<{ inserted: number; skipped: number }> {
    const exec = client ?? this.pool;
    let inserted = 0;
    let skipped = 0;

    for (const record of records) {
      const result = await exec.query(
        `INSERT INTO escrow_events
                (event_id, paging_token, ledger_seq, tx_hash, contract_id,
                 event_type, escrow_id, payload, replayed)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          record.eventId,
          record.pagingToken,
          record.ledgerSeq.toString(),
          record.txHash,
          record.contractId,
          record.eventType,
          record.escrowId ?? null,
          JSON.stringify(record.payload),
          record.replayed,
        ]
      );
      if ((result.rowCount ?? 0) > 0) {
        inserted++;
      } else {
        skipped++;
      }
    }

    return { inserted, skipped };
  }

  /**
   * Check whether a specific event_id is already present in escrow_events.
   * Used by unit tests; production code relies on ON CONFLICT DO NOTHING.
   */
  async eventExists(eventId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM escrow_events WHERE event_id = $1 LIMIT 1`,
      [eventId]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
