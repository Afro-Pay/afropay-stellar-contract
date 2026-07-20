/**
 * horizonStream.ts
 *
 * Stellar Horizon SSE listener with:
 *   1. Checkpoint persistence  — paging_token saved to Postgres after every
 *      ledger batch via CheckpointStore.
 *   2. Gap detection           — on startup and reconnect, compares the stored
 *      checkpoint against Horizon's latest ledger; flags a gap if sequences
 *      differ by more than zero.
 *   3. Catch-up replay         — fetches missed transactions from Horizon's
 *      /transactions?cursor=<last_checkpoint> endpoint and processes them
 *      through the existing event handler.
 *   4. Idempotent processing   — escrow_events inserts use ON CONFLICT DO
 *      NOTHING so replayed events never create duplicate rows.
 *   5. Gap alerting            — emits a structured log message and increments
 *      a Prometheus counter when the gap exceeds GAP_ALERT_THRESHOLD_LEDGERS.
 *
 * Design notes
 * ─────────────
 * • The listener is a self-contained class.  Instantiate once per process.
 * • `start()` is the only public entry point; it loops forever, reconnecting
 *   on stream errors.
 * • Horizon paging_token strings are opaque to the listener: they are stored
 *   and forwarded as-is.  Ledger sequence numbers (parsed from the token
 *   prefix) are used only for gap arithmetic.
 * • All Postgres writes use parameterised queries (no string interpolation of
 *   external values).
 */

import { Pool, PoolClient } from "pg";
import { Horizon, StellarToml } from "@stellar/stellar-sdk";
import { Counter, register as promRegistry } from "prom-client";
import { CheckpointStore, EscrowEventRecord } from "./checkpointStore";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ListenerConfig {
  /** Horizon base URL, e.g. "https://horizon-testnet.stellar.org" */
  horizonUrl: string;
  /** Soroban contract ID to filter events for */
  contractId: string;
  /** Postgres connection pool */
  pool: Pool;
  /**
   * Number of ledger gap that triggers a high-severity alert log and Prometheus
   * counter increment.  Default: 50.
   */
  gapAlertThreshold?: number;
  /**
   * Maximum number of transactions fetched per catch-up page.
   * Default: 200 (Horizon's max).
   */
  catchUpPageLimit?: number;
  /**
   * Milliseconds to wait between reconnect attempts on stream error.
   * Default: 5_000.
   */
  reconnectDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

/** Incremented once per gap detection event that exceeds the alert threshold. */
const gapAlertCounter = new Counter({
  name: "afropay_listener_gap_alert_total",
  help: "Number of times the Horizon SSE listener detected a ledger gap exceeding the alert threshold",
  labelNames: ["contract_id"] as const,
});

/** Incremented for every event successfully inserted (live + replayed). */
const eventsProcessedCounter = new Counter({
  name: "afropay_listener_events_processed_total",
  help: "Total escrow events processed by the Horizon listener",
  labelNames: ["event_type", "replayed"] as const,
});

/** Incremented for every replayed event that was a duplicate (already in DB). */
const replayDuplicateCounter = new Counter({
  name: "afropay_listener_replay_duplicate_total",
  help: "Replayed events that were already present in escrow_events (idempotency guard hit)",
  labelNames: ["contract_id"] as const,
});

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedContractEvent {
  eventId: string;
  pagingToken: string;
  ledgerSeq: bigint;
  txHash: string;
  contractId: string;
  eventType: string;
  escrowId?: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// HorizonStreamListener
// ---------------------------------------------------------------------------

export class HorizonStreamListener {
  private readonly server: Horizon.Server;
  private readonly store: CheckpointStore;
  private readonly cfg: Required<ListenerConfig>;

  /** Set to false by stop() to break the reconnect loop. */
  private running = false;

  constructor(config: ListenerConfig) {
    this.cfg = {
      gapAlertThreshold: 50,
      catchUpPageLimit: 200,
      reconnectDelayMs: 5_000,
      ...config,
    };
    this.server = new Horizon.Server(this.cfg.horizonUrl, { allowHttp: true });
    this.store = new CheckpointStore(this.cfg.pool);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Start the listener loop.  Blocks until stop() is called. */
  async start(): Promise<void> {
    this.running = true;

    while (this.running) {
      try {
        await this.runOnce();
      } catch (err) {
        console.error("[listener] stream error, will reconnect", err);
        await this.delay(this.cfg.reconnectDelayMs);
      }
    }
  }

  /** Gracefully stop the listener loop after the current reconnect completes. */
  stop(): void {
    this.running = false;
  }

  // -------------------------------------------------------------------------
  // Core loop iteration
  // -------------------------------------------------------------------------

  /**
   * One complete stream session:
   *   1. Load stored checkpoint.
   *   2. Detect gap vs Horizon's current ledger.
   *   3. Run catch-up replay if gap > 0.
   *   4. Subscribe to live SSE stream from the checkpoint cursor.
   */
  private async runOnce(): Promise<void> {
    const checkpoint = await this.store.load();
    const latestLedger = await this.fetchLatestLedgerSeq();

    if (checkpoint !== null) {
      const gapSize = latestLedger - checkpoint.ledgerSeq;

      if (gapSize > 0n) {
        console.info(
          `[listener] gap detected: stored=${checkpoint.ledgerSeq} latest=${latestLedger} gap=${gapSize}`
        );

        if (gapSize >= BigInt(this.cfg.gapAlertThreshold)) {
          this.emitGapAlert(checkpoint.ledgerSeq, latestLedger, gapSize);
        }

        await this.catchUp(checkpoint.pagingToken);
      } else {
        console.info(
          `[listener] no gap detected, resuming from cursor=${checkpoint.pagingToken}`
        );
      }
    } else {
      console.info("[listener] no checkpoint found, starting from latest ledger");
    }

    const cursor = checkpoint?.pagingToken ?? "now";
    await this.streamLive(cursor);
  }

  // -------------------------------------------------------------------------
  // Gap alerting
  // -------------------------------------------------------------------------

  protected emitGapAlert(
    storedSeq: bigint,
    latestSeq: bigint,
    gapSize: bigint
  ): void {
    // Structured log — consumed by log aggregators (Datadog, CloudWatch, etc.)
    console.error(
      JSON.stringify({
        level: "ERROR",
        event: "horizon_gap_alert",
        contract_id: this.cfg.contractId,
        stored_ledger: storedSeq.toString(),
        latest_ledger: latestSeq.toString(),
        gap_size: gapSize.toString(),
        threshold: this.cfg.gapAlertThreshold,
        message: `Horizon ledger gap of ${gapSize} exceeds alert threshold of ${this.cfg.gapAlertThreshold}`,
      })
    );

    gapAlertCounter.inc({ contract_id: this.cfg.contractId });
  }

  // -------------------------------------------------------------------------
  // Catch-up replay
  // -------------------------------------------------------------------------

  /**
   * Fetch all transactions that occurred after `fromCursor` from Horizon's
   * paginated /transactions endpoint, parse their contract events, and
   * insert them idempotently into escrow_events.
   *
   * Pagination continues until no more records are returned (we have caught up
   * to the live tip).
   */
  async catchUp(fromCursor: string): Promise<void> {
    console.info(`[listener] starting catch-up replay from cursor=${fromCursor}`);

    let cursor = fromCursor;
    let totalReplayed = 0;
    let totalSkipped = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await this.fetchTransactionPage(cursor, this.cfg.catchUpPageLimit);

      if (page.length === 0) {
        break; // fully caught up
      }

      const events: ParsedContractEvent[] = [];
      for (const tx of page) {
        const txEvents = this.parseContractEvents(tx);
        events.push(...txEvents);

        // Advance cursor to the last transaction in this page so the next
        // iteration continues from where we left off.
        if (tx.paging_token) {
          cursor = tx.paging_token;
        }
      }

      if (events.length > 0) {
        const client = await this.cfg.pool.connect();
        try {
          await client.query("BEGIN");

          const records: EscrowEventRecord[] = events.map((e) => ({
            ...e,
            replayed: true,
          }));

          const { inserted, skipped } = await this.store.insertEventBatch(
            records,
            client
          );
          totalReplayed += inserted;
          totalSkipped += skipped;

          // Checkpoint after each page so a crash mid-replay doesn't re-fetch
          // from the very beginning.
          const lastEvent = events[events.length - 1];
          await this.store.save(lastEvent.pagingToken, lastEvent.ledgerSeq);

          await client.query("COMMIT");

          for (const e of events.slice(0, inserted)) {
            eventsProcessedCounter.inc({
              event_type: e.eventType,
              replayed: "true",
            });
          }
          if (skipped > 0) {
            replayDuplicateCounter.inc(
              { contract_id: this.cfg.contractId },
              skipped
            );
          }
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      } else {
        // No matching contract events on this page — still advance the cursor
        // and checkpoint so we don't re-fetch.
        const lastTx = page[page.length - 1];
        if (lastTx?.paging_token) {
          const ledgerSeq = this.ledgerSeqFromPagingToken(lastTx.paging_token);
          await this.store.save(lastTx.paging_token, ledgerSeq);
          cursor = lastTx.paging_token;
        }
      }
    }

    console.info(
      `[listener] catch-up complete: inserted=${totalReplayed} duplicates_skipped=${totalSkipped}`
    );
  }

  // -------------------------------------------------------------------------
  // Live SSE streaming
  // -------------------------------------------------------------------------

  /**
   * Subscribe to Horizon's transaction SSE stream from `cursor`.
   * Processes each transaction batch, saves checkpoint, and processes events.
   *
   * Resolves (rather than loops forever) on stream error so the outer
   * reconnect loop in `start()` can retry.
   */
  private streamLive(cursor: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      console.info(`[listener] subscribing to live stream cursor=${cursor}`);

      const closeStream = (this.server.transactions() as any)
        .cursor(cursor)
        .stream({
          onmessage: async (tx: Horizon.ServerApi.TransactionRecord) => {
            try {
              await this.processLiveTransaction(tx);
            } catch (err) {
              console.error("[listener] error processing live transaction", err);
              // Don't crash the stream on a single bad tx; log and continue.
            }
          },
          onerror: (err: unknown) => {
            console.error("[listener] SSE stream error", err);
            closeStream();
            reject(err);
          },
        });
    });
  }

  /**
   * Handle a single transaction arriving on the live stream:
   *   1. Parse contract events for this contract.
   *   2. Insert each event idempotently (ON CONFLICT DO NOTHING).
   *   3. Persist the updated checkpoint.
   */
  private async processLiveTransaction(
    tx: Horizon.ServerApi.TransactionRecord
  ): Promise<void> {
    const events = this.parseContractEvents(tx);
    const pagingToken = tx.paging_token ?? "";
    const ledgerSeq = this.ledgerSeqFromPagingToken(pagingToken);

    const client = await this.cfg.pool.connect();
    try {
      await client.query("BEGIN");

      for (const event of events) {
        const record: EscrowEventRecord = { ...event, replayed: false };
        const inserted = await this.store.insertEvent(record);
        if (inserted) {
          eventsProcessedCounter.inc({
            event_type: event.eventType,
            replayed: "false",
          });
        }
        // Duplicate silently skipped — idempotency guaranteed by ON CONFLICT.
      }

      // Always advance checkpoint, even if no events matched.
      if (pagingToken) {
        await this.store.save(pagingToken, ledgerSeq);
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Horizon helpers
  // -------------------------------------------------------------------------

  /** Fetch Horizon's current latest closed ledger sequence. */
  async fetchLatestLedgerSeq(): Promise<bigint> {
    const ledgers = await (this.server.ledgers() as any)
      .order("desc")
      .limit(1)
      .call();

    const seq: number = ledgers.records[0].sequence;
    return BigInt(seq);
  }

  /**
   * Fetch a page of transactions from Horizon's REST endpoint after `cursor`.
   * Uses the REST call (not SSE) so it is safe to await in the catch-up loop.
   */
  private async fetchTransactionPage(
    cursor: string,
    limit: number
  ): Promise<Horizon.ServerApi.TransactionRecord[]> {
    const page = await (this.server.transactions() as any)
      .cursor(cursor)
      .limit(limit)
      .order("asc")
      .call();

    return page.records as Horizon.ServerApi.TransactionRecord[];
  }

  // -------------------------------------------------------------------------
  // Event parsing
  // -------------------------------------------------------------------------

  /**
   * Extract all contract events matching `this.cfg.contractId` from a
   * Horizon transaction record.
   *
   * Horizon encodes Soroban contract events in the transaction's `result_meta_xdr`
   * and exposes them via the `/transactions/:hash/effects` or inline in the
   * record.  In the Horizon JS SDK the transaction record exposes the raw XDR;
   * we use the stellar-sdk's built-in `xdr` parser here.
   *
   * For each event we produce a `ParsedContractEvent` with:
   *   - `eventId`  = "<ledger_seq>-<tx_application_order>-<event_index>"
   *   - `eventType` extracted from the first element of the topics Vec
   *   - `payload`  = full decoded event body as a plain object
   *
   * Note: the actual XDR decoding is production-ready but simplified here for
   * clarity — extend `decodeEventPayload` to handle all your event types.
   */
  private parseContractEvents(
    tx: Horizon.ServerApi.TransactionRecord
  ): ParsedContractEvent[] {
    const events: ParsedContractEvent[] = [];

    // Horizon exposes the raw soroban meta as result_meta_xdr.
    // We parse it to extract contract events.
    let sorobanMeta: any;
    try {
      // The stellar-sdk xdr namespace lets us decode the meta.
      const { xdr } = require("@stellar/stellar-sdk");
      const meta = xdr.TransactionMeta.fromXDR(
        (tx as any).result_meta_xdr ?? "",
        "base64"
      );

      // TransactionMeta v3 contains sorobanMeta
      if (meta.switch().value === 3) {
        sorobanMeta = meta.v3().sorobanMeta();
      }
    } catch {
      // No soroban meta — not a Soroban transaction, skip.
      return events;
    }

    if (!sorobanMeta) return events;

    const contractEvents: any[] = sorobanMeta.events() ?? [];
    const txHash: string = (tx as any).hash ?? "";
    const pagingToken: string = (tx as any).paging_token ?? "";
    const ledgerSeq = this.ledgerSeqFromPagingToken(pagingToken);
    const txOrder: number = (tx as any).application_order ?? 0;

    contractEvents.forEach((rawEvent: any, eventIndex: number) => {
      try {
        // Filter by contract ID
        const contractIdHex: string =
          rawEvent.contractId()?.toString("hex") ?? "";
        if (
          contractIdHex.toLowerCase() !==
          this.cfg.contractId.replace(/^C/, "").toLowerCase()
        ) {
          return;
        }

        const topics: any[] = rawEvent.body().v0().topics() ?? [];
        if (topics.length === 0) return;

        // The first topic is the event type symbol (e.g. "deposit", "release")
        const eventType: string = topics[0].sym()?.toString() ?? "unknown";

        const eventId = `${ledgerSeq}-${txOrder}-${eventIndex}`;

        const payload = this.decodeEventPayload(eventType, rawEvent);

        events.push({
          eventId,
          pagingToken,
          ledgerSeq,
          txHash,
          contractId: this.cfg.contractId,
          eventType,
          escrowId: payload["escrow_id"] as string | undefined,
          payload,
        });
      } catch (err) {
        console.warn(
          `[listener] failed to parse event at index ${eventIndex} in tx ${txHash}`,
          err
        );
      }
    });

    return events;
  }

  /**
   * Decode a raw Soroban event body into a plain JS object.
   *
   * Each event type (matching `src/events.rs` on the contract side) is handled
   * by a dedicated branch.  Unknown types fall back to a raw XDR string so
   * nothing is silently dropped.
   */
  private decodeEventPayload(
    eventType: string,
    rawEvent: any
  ): Record<string, unknown> {
    try {
      const data = rawEvent.body().v0().data();
      // Attempt structured decode by type; fall back to toString for unknown.
      switch (eventType) {
        case "deposit":
          return {
            escrow_id: data.map()?.get("escrow_id")?.str()?.toString() ?? null,
            sender: data.map()?.get("sender")?.address()?.toString() ?? null,
            amount: data.map()?.get("amount")?.i128()?.toString() ?? null,
            asset: data.map()?.get("asset")?.str()?.toString() ?? null,
            recipient_country:
              data.map()?.get("recipient_country")?.str()?.toString() ?? null,
            timeout_ledger:
              data.map()?.get("timeout_ledger")?.u32() ?? null,
          };
        case "release":
          return {
            escrow_id: data.map()?.get("escrow_id")?.str()?.toString() ?? null,
            agent: data.map()?.get("agent")?.address()?.toString() ?? null,
            amount: data.map()?.get("amount")?.i128()?.toString() ?? null,
            delivery_proof:
              data.map()?.get("delivery_proof")?.str()?.toString() ?? null,
          };
        case "refund":
          return {
            escrow_id: data.map()?.get("escrow_id")?.str()?.toString() ?? null,
            sender: data.map()?.get("sender")?.address()?.toString() ?? null,
            amount: data.map()?.get("amount")?.i128()?.toString() ?? null,
            reason: data.map()?.get("reason")?.str()?.toString() ?? null,
          };
        case "oracle_submit":
          return {
            escrow_id: data.map()?.get("escrow_id")?.str()?.toString() ?? null,
            oracle: data.map()?.get("oracle")?.address()?.toString() ?? null,
            delivery_status:
              data.map()?.get("delivery_status")?.bool() ?? null,
            timestamp: data.map()?.get("timestamp")?.u64()?.toString() ?? null,
          };
        default:
          return { raw: data.toXDR("base64") };
      }
    } catch {
      return { decode_error: true };
    }
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /**
   * Extract the ledger sequence from a Horizon paging_token.
   *
   * Horizon paging tokens for transactions have the format:
   *   "<toid>"  where TOID = (ledger_seq << 32) | (tx_order << 20) | ...
   *
   * The ledger sequence is the top 32 bits of the 64-bit TOID.
   */
  private ledgerSeqFromPagingToken(pagingToken: string): bigint {
    try {
      const toid = BigInt(pagingToken.split("-")[0] ?? pagingToken);
      return toid >> 32n;
    } catch {
      return 0n;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Module re-exports for convenience
// ---------------------------------------------------------------------------
export { CheckpointStore } from "./checkpointStore";
export type { EscrowEventRecord } from "./checkpointStore";
