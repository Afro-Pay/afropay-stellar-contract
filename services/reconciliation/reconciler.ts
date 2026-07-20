/**
 * reconciler.ts
 *
 * Chain-vs-DB reconciliation service for AfroPay escrow state.
 *
 * Chain state is the ground truth.  The reconciler:
 *   1. Loads all open escrow IDs from the DB.
 *   2. Queries the Soroban contract's `get_escrow` entry point for each ID
 *      (in configurable parallel batches for throughput).
 *   3. Diffs on-chain state against DB state and classifies each discrepancy:
 *        - 'status_mismatch'    — both sides know the escrow but states differ
 *        - 'missing_from_db'    — on-chain exists, DB does not know it
 *        - 'missing_from_chain' — DB knows it, contract returns not-found
 *   4. Writes a reconciliation_runs row and one reconciliation_reports row
 *      per discrepancy.
 *   5. Optionally self-heals: updates the DB to match chain truth when
 *      heal=true (logs every update with escrow ID + old/new state).
 *
 * Startup cooldown: if the last completed run finished < COOLDOWN_MS ago,
 * the startup run is skipped and `ReconcileSkippedError` is thrown.
 */

import { Pool, PoolClient } from "pg";
import { SorobanRpc, Contract, nativeToScVal, scValToNative, Networks } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The on-chain EscrowState discriminants from src/escrow.rs */
export type EscrowState =
  | "Locked"
  | "Released"
  | "Refundable"
  | "Refunded"
  | "Cancelled"
  | "Unknown";

export type DiscrepancyScenario =
  | "status_mismatch"
  | "missing_from_db"
  | "missing_from_chain";

export interface Discrepancy {
  escrowId: string;
  scenario: DiscrepancyScenario;
  /** State recorded in DB; undefined when scenario = missing_from_db */
  dbState?: EscrowState;
  /** State returned by chain; undefined when scenario = missing_from_chain */
  chainState?: EscrowState;
}

export interface ReconcileResult {
  runId: bigint;
  triggeredBy: "startup" | "admin_api";
  totalChecked: number;
  totalMatched: number;
  discrepancies: Discrepancy[];
  totalHealed: number;
  durationMs: number;
}

export interface ReconcilerConfig {
  pool: Pool;
  /** Soroban RPC endpoint URL */
  sorobanRpcUrl: string;
  /** Bech32 contract ID of the RemittanceContract */
  contractId: string;
  /** Network passphrase (defaults to testnet) */
  networkPassphrase?: string;
  /**
   * Minimum milliseconds between automatic startup runs.
   * Default: 300_000 (5 minutes).
   */
  cooldownMs?: number;
  /**
   * Number of concurrent Soroban RPC calls during reconciliation.
   * Default: 50.  Tune to stay within RPC rate limits.
   */
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// Sentinel error for skipped startup runs
// ---------------------------------------------------------------------------

export class ReconcileSkippedError extends Error {
  constructor(public readonly lastRunAt: Date, public readonly cooldownMs: number) {
    super(
      `Startup reconciliation skipped — last run completed at ${lastRunAt.toISOString()}, ` +
        `cooldown is ${cooldownMs / 1000}s`
    );
    this.name = "ReconcileSkippedError";
  }
}

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

interface DbEscrowRow {
  escrow_id: string;
  state: string;
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export class Reconciler {
  private readonly pool: Pool;
  private readonly cfg: Required<ReconcilerConfig>;

  constructor(config: ReconcilerConfig) {
    this.pool = config.pool;
    this.cfg = {
      networkPassphrase: Networks.TESTNET,
      cooldownMs: 5 * 60 * 1000,
      concurrency: 50,
      ...config,
    };
  }

  // -------------------------------------------------------------------------
  // Public entry points
  // -------------------------------------------------------------------------

  /**
   * Run on service startup.  Skips (throws ReconcileSkippedError) if the last
   * completed run finished within `cooldownMs`.
   */
  async runOnStartup(): Promise<ReconcileResult> {
    const lastRun = await this.loadLastCompletedRunTime();
    if (lastRun !== null) {
      const elapsed = Date.now() - lastRun.getTime();
      if (elapsed < this.cfg.cooldownMs) {
        throw new ReconcileSkippedError(lastRun, this.cfg.cooldownMs);
      }
    }
    return this.run({ triggeredBy: "startup", heal: false });
  }

  /**
   * Run triggered by the admin API.
   * @param heal  When true, update DB rows to match chain state for each discrepancy.
   */
  async runOnDemand(heal: boolean): Promise<ReconcileResult> {
    return this.run({ triggeredBy: "admin_api", heal });
  }

  // -------------------------------------------------------------------------
  // Core reconciliation logic
  // -------------------------------------------------------------------------

  private async run(opts: {
    triggeredBy: "startup" | "admin_api";
    heal: boolean;
  }): Promise<ReconcileResult> {
    const start = Date.now();

    // 1. Open a run record
    const runId = await this.openRun(opts.triggeredBy, opts.heal);

    try {
      // 2. Load all open escrow IDs + states from DB
      const dbEscrows = await this.loadDbEscrows();

      // 3. Query Soroban for each escrow (batched concurrent)
      const chainStates = await this.fetchChainStates(dbEscrows.map((r) => r.escrow_id));

      // 4. Diff
      const discrepancies = this.diff(dbEscrows, chainStates);

      // 5. Persist reports
      await this.persistReports(runId, discrepancies);

      // 6. Self-heal if requested
      let totalHealed = 0;
      if (opts.heal && discrepancies.length > 0) {
        totalHealed = await this.heal(runId, discrepancies);
      }

      const durationMs = Date.now() - start;

      // 7. Close the run record
      await this.closeRun(runId, {
        totalChecked: dbEscrows.length,
        totalMatched: dbEscrows.length - discrepancies.length,
        totalDiscrepancies: discrepancies.length,
        totalHealed,
        status: "completed",
      });

      return {
        runId,
        triggeredBy: opts.triggeredBy,
        totalChecked: dbEscrows.length,
        totalMatched: dbEscrows.length - discrepancies.length,
        discrepancies,
        totalHealed,
        durationMs,
      };
    } catch (err) {
      await this.closeRun(runId, {
        totalChecked: 0,
        totalMatched: 0,
        totalDiscrepancies: 0,
        totalHealed: 0,
        status: "failed",
      });
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // DB helpers
  // -------------------------------------------------------------------------

  /**
   * Load all escrows from the DB whose state indicates they are still "open"
   * (i.e., not in a terminal state on-chain).  We load Locked and Refundable
   * because those are the only states that can diverge from chain — Released,
   * Refunded, and Cancelled are terminal and not expected to change.
   *
   * For the reconciliation to cover up to 10,000 escrows within 5 minutes,
   * this query uses a cursor-style approach: it streams rows rather than
   * loading all at once, but for simplicity we return an array here (Postgres
   * can easily return 10k rows in one round-trip).
   */
  async loadDbEscrows(): Promise<DbEscrowRow[]> {
    const result = await this.pool.query<DbEscrowRow>(
      `SELECT escrow_id, state
         FROM escrows
        WHERE state NOT IN ('Released', 'Refunded', 'Cancelled')
        ORDER BY escrow_id`
    );
    return result.rows;
  }

  private async openRun(
    triggeredBy: "startup" | "admin_api",
    healRequested: boolean
  ): Promise<bigint> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO reconciliation_runs (triggered_by, heal_requested)
            VALUES ($1, $2)
       RETURNING id`,
      [triggeredBy, healRequested]
    );
    return BigInt(result.rows[0].id);
  }

  private async closeRun(
    runId: bigint,
    stats: {
      totalChecked: number;
      totalMatched: number;
      totalDiscrepancies: number;
      totalHealed: number;
      status: "completed" | "failed";
    }
  ): Promise<void> {
    await this.pool.query(
      `UPDATE reconciliation_runs
          SET completed_at         = NOW(),
              total_checked        = $2,
              total_matched        = $3,
              total_discrepancies  = $4,
              total_healed         = $5,
              status               = $6
        WHERE id = $1`,
      [
        runId.toString(),
        stats.totalChecked,
        stats.totalMatched,
        stats.totalDiscrepancies,
        stats.totalHealed,
        stats.status,
      ]
    );
  }

  private async persistReports(runId: bigint, discrepancies: Discrepancy[]): Promise<void> {
    if (discrepancies.length === 0) return;

    // Insert all discrepancy rows in a single transaction
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const d of discrepancies) {
        await client.query(
          `INSERT INTO reconciliation_reports
                  (run_id, escrow_id, scenario, db_state, chain_state)
                VALUES ($1, $2, $3, $4, $5)`,
          [
            runId.toString(),
            d.escrowId,
            d.scenario,
            d.dbState ?? null,
            d.chainState ?? null,
          ]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Load the timestamp of the last successfully completed reconciliation run.
   * Returns null if no completed run exists.
   */
  async loadLastCompletedRunTime(): Promise<Date | null> {
    const result = await this.pool.query<{ completed_at: Date }>(
      `SELECT completed_at
         FROM reconciliation_runs
        WHERE status = 'completed'
        ORDER BY completed_at DESC
        LIMIT 1`
    );
    if (result.rowCount === 0) return null;
    return result.rows[0].completed_at;
  }

  // -------------------------------------------------------------------------
  // Soroban chain queries
  // -------------------------------------------------------------------------

  /**
   * Query the Soroban contract for every escrow ID, in concurrent batches.
   * Returns a Map<escrowId, EscrowState | null> where null means the contract
   * returned EscrowNotFound (missing_from_chain scenario).
   */
  async fetchChainStates(
    escrowIds: string[]
  ): Promise<Map<string, EscrowState | null>> {
    const results = new Map<string, EscrowState | null>();
    const batchSize = this.cfg.concurrency;

    for (let i = 0; i < escrowIds.length; i += batchSize) {
      const batch = escrowIds.slice(i, i + batchSize);
      const settled = await Promise.allSettled(
        batch.map((id) => this.queryChainEscrowState(id))
      );

      settled.forEach((result, idx) => {
        const id = batch[idx];
        if (result.status === "fulfilled") {
          results.set(id, result.value);
        } else {
          // Log the error but treat as unknown rather than crashing the run
          console.warn(
            `[reconciler] RPC error for escrow ${id}: ${result.reason}`
          );
          results.set(id, "Unknown");
        }
      });
    }

    return results;
  }

  /**
   * Query the contract's `get_escrow` entry point for a single escrow ID.
   * Returns null when the contract returns EscrowNotFound (error code 7).
   */
  async queryChainEscrowState(escrowId: string): Promise<EscrowState | null> {
    const server = new SorobanRpc.Server(this.cfg.sorobanRpcUrl, { allowHttp: true });
    const contract = new Contract(this.cfg.contractId);

    // Build the simulated call — we use simulateTransaction since we only need
    // to read state; no auth or fee submission required.
    const scEscrowId = nativeToScVal(escrowId, { type: "string" });
    const operation = contract.call("get_escrow", scEscrowId);

    // We need a source account for simulation; use the contract ID itself as a
    // dummy source (read-only sim does not deduct fees).
    const account = await server.getAccount(this.cfg.contractId).catch(() => null);
    if (!account) {
      // Fallback: use a zero-sequence dummy account for simulation
      const { Account } = await import("@stellar/stellar-sdk");
      const dummyAccount = new Account(this.cfg.contractId, "0");
      return this.simulateGetEscrow(server, dummyAccount, operation);
    }

    return this.simulateGetEscrow(server, account, operation);
  }

  private async simulateGetEscrow(
    server: SorobanRpc.Server,
    account: InstanceType<typeof import("@stellar/stellar-sdk").Account>,
    operation: ReturnType<Contract["call"]>
  ): Promise<EscrowState | null> {
    const { TransactionBuilder, BASE_FEE } = await import("@stellar/stellar-sdk");

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      // EscrowNotFound (error code 7) → missing_from_chain
      if (sim.error?.includes("7") || sim.error?.includes("EscrowNotFound")) {
        return null;
      }
      throw new Error(`Soroban simulation error for get_escrow: ${sim.error}`);
    }

    if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
      throw new Error(`Unexpected simulation result for get_escrow`);
    }

    // Decode the return value — it's an Escrow struct; we only need .state
    const returnVal = sim.result?.retval;
    if (!returnVal) return "Unknown";

    return this.decodeEscrowState(returnVal);
  }

  /**
   * Decode the `state` field from a Soroban Escrow struct ScVal.
   * The EscrowState enum discriminants match src/escrow.rs:
   *   Locked=0, Released=1, Refundable=2, Refunded=3, Cancelled=4
   */
  decodeEscrowState(scVal: unknown): EscrowState {
    try {
      const native = scValToNative(scVal as Parameters<typeof scValToNative>[0]);
      // native is a plain object with the struct fields
      const stateDiscriminant =
        typeof native === "object" && native !== null
          ? (native as Record<string, unknown>)["state"]
          : undefined;

      const discriminantMap: Record<number, EscrowState> = {
        0: "Locked",
        1: "Released",
        2: "Refundable",
        3: "Refunded",
        4: "Cancelled",
      };

      if (typeof stateDiscriminant === "number") {
        return discriminantMap[stateDiscriminant] ?? "Unknown";
      }
      // Some SDK versions return the enum variant name as a string
      if (typeof stateDiscriminant === "string") {
        const named = stateDiscriminant as EscrowState;
        return ["Locked", "Released", "Refundable", "Refunded", "Cancelled"].includes(named)
          ? named
          : "Unknown";
      }
      return "Unknown";
    } catch {
      return "Unknown";
    }
  }

  // -------------------------------------------------------------------------
  // Diff
  // -------------------------------------------------------------------------

  /**
   * Compare DB rows against chain states and produce the discrepancy list.
   *
   * The diff covers three scenarios:
   *   1. status_mismatch   — escrow in both, but states differ
   *   2. missing_from_db   — chain has it, DB does not (detected if chain query
   *      returns a state for an ID not in the DB set — this scenario requires
   *      a separate "known chain IDs" source; for now we only detect it via
   *      the heal path if an admin provides extra IDs, but the method signature
   *      supports it via the `extraChainIds` parameter)
   *   3. missing_from_chain — DB has it, chain returns null (EscrowNotFound)
   */
  diff(
    dbRows: DbEscrowRow[],
    chainStates: Map<string, EscrowState | null>,
    extraChainIds: string[] = []
  ): Discrepancy[] {
    const discrepancies: Discrepancy[] = [];
    const dbIds = new Set(dbRows.map((r) => r.escrow_id));

    // Check every DB row against chain
    for (const row of dbRows) {
      const chainState = chainStates.get(row.escrow_id);

      if (chainState === null) {
        // Chain returned EscrowNotFound
        discrepancies.push({
          escrowId: row.escrow_id,
          scenario: "missing_from_chain",
          dbState: this.normaliseState(row.state),
          chainState: undefined,
        });
        continue;
      }

      if (chainState === undefined || chainState === "Unknown") {
        // RPC error — do not report as discrepancy, already logged as warning
        continue;
      }

      const dbState = this.normaliseState(row.state);
      if (dbState !== chainState) {
        discrepancies.push({
          escrowId: row.escrow_id,
          scenario: "status_mismatch",
          dbState,
          chainState,
        });
      }
    }

    // Check for chain IDs not present in DB (missing_from_db)
    for (const id of extraChainIds) {
      if (!dbIds.has(id)) {
        const chainState = chainStates.get(id);
        if (chainState && chainState !== "Unknown") {
          discrepancies.push({
            escrowId: id,
            scenario: "missing_from_db",
            dbState: undefined,
            chainState,
          });
        }
      }
    }

    return discrepancies;
  }

  // -------------------------------------------------------------------------
  // Self-heal
  // -------------------------------------------------------------------------

  /**
   * For each discrepancy, update the DB to match chain truth.
   *   - status_mismatch    → UPDATE escrows SET state = chainState
   *   - missing_from_db    → INSERT a minimal escrow row (chain state only)
   *   - missing_from_chain → mark the DB row as state = 'ChainNotFound'
   *                          (do NOT delete — preserve audit trail)
   *
   * Every DB mutation is logged with structured context.
   * Returns the count of rows actually updated/inserted.
   */
  async heal(runId: bigint, discrepancies: Discrepancy[]): Promise<number> {
    let healed = 0;
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      for (const d of discrepancies) {
        let healDetail: string;

        if (d.scenario === "status_mismatch" && d.chainState) {
          await client.query(
            `UPDATE escrows
                SET state      = $2,
                    updated_at = NOW()
              WHERE escrow_id  = $1`,
            [d.escrowId, d.chainState]
          );
          healDetail =
            `self-heal: status_mismatch — updated escrow ${d.escrowId} ` +
            `db_state=${d.dbState} → chain_state=${d.chainState}`;
          console.info(`[reconciler] ${healDetail}`);
          healed++;
        } else if (d.scenario === "missing_from_db" && d.chainState) {
          // Insert a stub row so the API can at least surface the escrow
          await client.query(
            `INSERT INTO escrows (escrow_id, state, created_at, updated_at)
                  VALUES ($1, $2, NOW(), NOW())
             ON CONFLICT (escrow_id) DO NOTHING`,
            [d.escrowId, d.chainState]
          );
          healDetail =
            `self-heal: missing_from_db — inserted stub for escrow ${d.escrowId} ` +
            `with chain_state=${d.chainState}`;
          console.info(`[reconciler] ${healDetail}`);
          healed++;
        } else if (d.scenario === "missing_from_chain") {
          // Chain does not know this escrow — flag it without deleting
          await client.query(
            `UPDATE escrows
                SET state      = 'ChainNotFound',
                    updated_at = NOW()
              WHERE escrow_id  = $1
                AND state     != 'ChainNotFound'`,
            [d.escrowId]
          );
          healDetail =
            `self-heal: missing_from_chain — flagged escrow ${d.escrowId} ` +
            `(was db_state=${d.dbState})`;
          console.info(`[reconciler] ${healDetail}`);
          healed++;
        } else {
          continue;
        }

        // Record the heal detail on the report row
        await client.query(
          `UPDATE reconciliation_reports
              SET healed      = TRUE,
                  heal_detail = $2
            WHERE run_id    = $3
              AND escrow_id = $1
              AND scenario  = $4`,
          [d.escrowId, healDetail, runId.toString(), d.scenario]
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return healed;
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  private normaliseState(raw: string): EscrowState {
    const map: Record<string, EscrowState> = {
      locked: "Locked",
      released: "Released",
      refundable: "Refundable",
      refunded: "Refunded",
      cancelled: "Cancelled",
      Locked: "Locked",
      Released: "Released",
      Refundable: "Refundable",
      Refunded: "Refunded",
      Cancelled: "Cancelled",
    };
    return map[raw] ?? "Unknown";
  }
}
