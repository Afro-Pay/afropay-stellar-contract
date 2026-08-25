/**
 * Transaction settlement service (Issue #83).
 *
 * Central service for managing transaction settlement events. Wraps
 * the transaction event store and publishes domain events via a local
 * EventEmitter so both NestJS controllers (RxJS Observable SSE) and
 * Express routes can consume the same event stream.
 *
 * In production, replace the in-memory event store with a durable log.
 */

import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Domain event types for settlement workflow
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
  id: number;
  escrowId: string;
  type: TransactionEventType;
  state: TransactionSettlementState;
  corridor: string;
  amountUsdc: string;
  occurredAt: string;
  stellarTxHash?: string | null;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event store — in-memory, monotonically indexed
// ---------------------------------------------------------------------------

function channelFor(escrowId: string): string {
  return `tx:${escrowId}`;
}

class TransactionEventStore extends EventEmitter {
  private eventsByEscrow = new Map<string, TransactionEvent[]>();
  private nextId = 1;

  constructor() {
    super();
    this.setMaxListeners(200);
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

  since(escrowId: string, lastEventId: number): TransactionEvent[] {
    const list = this.eventsByEscrow.get(escrowId) ?? [];
    if (!Number.isFinite(lastEventId) || lastEventId <= 0) return list.slice();
    return list.filter((e) => e.id > lastEventId);
  }

  all(escrowId: string): TransactionEvent[] {
    return (this.eventsByEscrow.get(escrowId) ?? []).slice();
  }

  has(escrowId: string): boolean {
    const list = this.eventsByEscrow.get(escrowId);
    return !!list && list.length > 0;
  }

  subscribe(
    escrowId: string,
    listener: (event: TransactionEvent) => void
  ): () => void {
    const channel = channelFor(escrowId);
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }

  reset(): void {
    this.eventsByEscrow.clear();
    this.nextId = 1;
  }
}

// ---------------------------------------------------------------------------
// Exported service (singleton)
// ---------------------------------------------------------------------------

/**
 * TransactionService manages transaction settlement events.
 *
 * Used by the NestJS controller to create RxJS Observable SSE streams,
 * and can also be consumed by other services to publish domain events.
 */
export class TransactionService {
  public readonly eventStore: TransactionEventStore;

  constructor() {
    this.eventStore = new TransactionEventStore();
  }

  /** Publish a TransactionCreated event. */
  createTransaction(
    escrowId: string,
    corridor: string,
    amountUsdc: string
  ): TransactionEvent {
    return this.eventStore.append(escrowId, {
      type: "TransactionCreated",
      state: "pending_sender",
      corridor,
      amountUsdc,
    });
  }

  /** Publish a TransactionSettled event (oracle signed the payout). */
  settleTransaction(
    escrowId: string,
    corridor: string,
    amountUsdc: string,
    stellarTxHash?: string
  ): TransactionEvent {
    return this.eventStore.append(escrowId, {
      type: "TransactionSettled",
      state: "settled",
      corridor,
      amountUsdc,
      stellarTxHash,
    });
  }

  /** Publish a TransactionRefunded event. */
  refundTransaction(
    escrowId: string,
    corridor: string,
    amountUsdc: string
  ): TransactionEvent {
    return this.eventStore.append(escrowId, {
      type: "TransactionRefunded",
      state: "refunded",
      corridor,
      amountUsdc,
    });
  }

  /** Publish a generic state transition. */
  transitionState(
    escrowId: string,
    state: TransactionSettlementState,
    corridor: string,
    amountUsdc: string,
    stellarTxHash?: string
  ): TransactionEvent {
    return this.eventStore.append(escrowId, {
      type: "state_changed",
      state,
      corridor,
      amountUsdc,
      stellarTxHash,
    });
  }
}

/** Shared singleton instance. */
export const transactionService = new TransactionService();
