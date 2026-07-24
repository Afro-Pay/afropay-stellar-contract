/**
 * Escrow audit-trail event store (Issue #24).
 *
 * Every escrow lifecycle transition is appended here with a monotonically
 * increasing, store-wide sequence id. That id doubles as the SSE `id:`
 * field, so a client reconnecting with `Last-Event-ID` can be replayed
 * exactly the events it missed — in order, with no gaps and no duplicates.
 *
 * Backed by an in-memory array per escrow — swap for a durable log
 * (Postgres table, Kafka topic, etc.) in production without changing the
 * public API of this module.
 */

import { EventEmitter } from "events";
import { EscrowState } from "../routes/escrow";

export type EscrowEventType = "created" | "state_changed" | "kyc_verification_attempt";

/** Outcome values for kyc_verification_attempt events. */
export type KycOutcome = "verified" | "unverified" | "pending" | "provider_error";

export interface EscrowEvent {
  /** Store-wide monotonically increasing id — used verbatim as the SSE id. */
  id: number;
  escrowId: string;
  type: EscrowEventType;
  state: EscrowState;
  corridor: string;
  amountUsdc: string;
  occurredAt: string;
  /** Present on kyc_verification_attempt events — Stellar account that triggered the check. */
  actor?: string;
  /** Present on kyc_verification_attempt events — outcome of the verification attempt. */
  kycOutcome?: KycOutcome;
  /** Present on kyc_verification_attempt events — provider reference ID, if available. */
  kycProviderReference?: string | null;
}

function channelFor(escrowId: string): string {
  return `event:${escrowId}`;
}

class EscrowEventStore extends EventEmitter {
  private eventsByEscrow = new Map<string, EscrowEvent[]>();
  private nextId = 1;

  constructor() {
    super();
    // Many SSE subscribers can share a single escrow's channel (multiple
    // browser tabs, reconnect races); the default cap of 10 is too low.
    this.setMaxListeners(100);
  }

  append(
    escrowId: string,
    partial: Omit<EscrowEvent, "id" | "escrowId" | "occurredAt">
  ): EscrowEvent {
    const event: EscrowEvent = {
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
  since(escrowId: string, lastEventId: number): EscrowEvent[] {
    const list = this.eventsByEscrow.get(escrowId) ?? [];
    if (!Number.isFinite(lastEventId) || lastEventId <= 0) return list.slice();
    return list.filter((event) => event.id > lastEventId);
  }

  all(escrowId: string): EscrowEvent[] {
    return (this.eventsByEscrow.get(escrowId) ?? []).slice();
  }

  /** Subscribe to live events for one escrow; returns an unsubscribe function. */
  subscribe(escrowId: string, listener: (event: EscrowEvent) => void): () => void {
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

export const escrowEventStore = new EscrowEventStore();
