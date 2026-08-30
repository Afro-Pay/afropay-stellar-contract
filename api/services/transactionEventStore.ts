/**
 * Transaction settlement event store (Issue #83).
 *
 * Mirrors the escrow event store pattern (Issue #24), but tracks
 * settlement-specific lifecycle events: TransactionCreated, TransactionSettled,
 * TransactionRefunded, and generic state_changed.
 *
 * Each event receives a store-wide monotonically increasing id that doubles
 * as the SSE `id:` field, enabling gapless replay via `Last-Event-ID`.
 *
 * Backed by in-memory arrays per escrow/transaction — swap for a durable log
 * (Postgres, Kafka, etc.) in production without changing the public API.
 */

import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Event types for the settlement workflow
// ---------------------------------------------------------------------------

export type TransactionEventType =
  | "TransactionCreated"
  | "TransactionSettled"
  | "TransactionRefunded"
  | "state_changed";

export type TransactionSettlementState =
  | "pending_sender"
  | "pending_stellar"
  | "pending_receiver"
  | "pending_external"
  | "oracle_signed"
  | "settled"
  | "refunded"
  | "completed"
  | "error";

export interface TransactionEvent {
  /** Store-wide monotonically increasing id — used verbatim as the SSE id. */
  id: number;
  escrowId: string;
  type: TransactionEventType;
  state: TransactionSettlementState;
  corridor: string;
  amountUsdc: string;
  occurredAt: string;
  /** Optional stellar transaction hash associated with the event. */
  stellarTxHash?: string | null;
  /** Optional additional metadata about the event. */
  metadata?: Record<string, unknown>;
}

function channelFor(escrowId: string): string {
  return `tx_event:${escrowId}`;
}

class TransactionEventStore extends EventEmitter {
  private eventsByEscrow = new Map<string, TransactionEvent[]>();
  private nextId = 1;

  constructor() {
    super();
    // Many SSE subscribers can share a single escrow's channel (multiple
    // browser tabs, reconnect races); the default cap of 10 is too low.
    this.setMaxListeners(100);
  }

  append(
    escrowId: string,
    partial: Omit<TransactionEvent, "id" | "escrowId" | "occurredAt">
  ): TransactionEvent {
    const event: TransactionEvent = {
      id: this.nextId++,
      escrowId,
      occurredAt: new Date().toISOString(),
      ...partial,
    };

    const list = this.eventsByEscrow.get(escrowId) ?? [];
    list.push(event);
    this.eventsByEscrow.set(escrowId, list);

    this.emit(channelFor(escrowId), event);
    return event;
  }

  /** Events strictly after `lastEventId`, in order — the replay set for reconnects. */
  since(escrowId: string, lastEventId: number): TransactionEvent[] {
    const list = this.eventsByEscrow.get(escrowId) ?? [];
    if (!Number.isFinite(lastEventId) || lastEventId <= 0) return list.slice();
    return list.filter((event) => event.id > lastEventId);
  }

  all(escrowId: string): TransactionEvent[] {
    return (this.eventsByEscrow.get(escrowId) ?? []).slice();
  }

  /** Returns true if any events exist for the given escrow. */
  has(escrowId: string): boolean {
    const list = this.eventsByEscrow.get(escrowId);
    return !!list && list.length > 0;
  }

  /** Subscribe to live events for one escrow; returns an unsubscribe function. */
  subscribe(
    escrowId: string,
    listener: (event: TransactionEvent) => void
  ): () => void {
    const channel = channelFor(escrowId);
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }

  /** Test/dev helper — clears all history and resets the id sequence. */
  reset(): void {
    this.eventsByEscrow.clear();
    this.nextId = 1;
  }
}

export const transactionEventStore = new TransactionEventStore();
