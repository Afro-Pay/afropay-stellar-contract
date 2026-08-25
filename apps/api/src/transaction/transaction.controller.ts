/**
 * Transaction SSE streaming controller (Issue #83).
 *
 * Implements the SSE endpoint described in the issue specification:
 *   GET /transactions/stream/:escrow_id
 *
 * Uses RxJS Observable to emit Server-Sent Events for real-time settlement
 * monitoring. Supports reconnection via Last-Event-ID header / lastEventId
 * query param with gapless event replay.
 *
 * Design notes:
 *   - Returns an Observable<MessageEvent> that the NestJS @Sse() decorator
 *     serializes as text/event-stream automatically.
 *   - Heartbeat comments every 15s keep proxies from timing out.
 *   - The Observable completes (cleans up subscription + heartbeat) when
 *     the client disconnects.
 */

import { Observable, Subscriber } from "rxjs";
import {
  transactionService,
  TransactionEvent,
} from "./transaction.service";

/** SSE heartbeat interval in milliseconds. */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/** Shape of an SSE message frame that NestJS @Sse() expects. */
export interface SseMessageEvent {
  id?: string;
  type?: string;
  data: string;
  retry?: number;
}

/**
 * Transaction SSE Controller.
 *
 * In a full NestJS deployment this would be decorated with @Controller()
 * and @Sse(). Because this repo currently uses plain Express, this class
 * is exported as a plain TypeScript class whose methods can be called from
 * any controller or route handler.
 *
 * Usage with NestJS:
 *   @Controller('transactions')
 *   export class TransactionController {
 *     @Sse('stream/:escrow_id')
 *     stream(@Param('escrow_id') id: string, @Req() req: Request) {
 *       return controller.streamSettlement(id, req.headers['last-event-id']);
 *     }
 *   }
 */
export class TransactionController {
  /**
   * Returns an RxJS Observable that emits settlement events as SSE frames.
   *
   * @param escrowId  The escrow/transaction ID to stream.
   * @param lastEventId  The `Last-Event-ID` header value, if reconnecting.
   * @returns Observable of SSE message events, or null if the escrow doesn't exist.
   */
  streamSettlement(
    escrowId: string,
    lastEventId?: string | null
  ): Observable<SseMessageEvent> | null {
    if (!transactionService.eventStore.has(escrowId)) {
      return null;
    }

    return new Observable<SseMessageEvent>((subscriber: Subscriber<SseMessageEvent>) => {
      // Replay missed events
      const lastId = lastEventId ? Number(lastEventId) : 0;
      for (const event of transactionService.eventStore.since(escrowId, lastId)) {
        subscriber.next(formatEvent(event));
      }

      // Subscribe to live events
      const unsubscribe = transactionService.eventStore.subscribe(
        escrowId,
        (event: TransactionEvent) => {
          subscriber.next(formatEvent(event));
        }
      );

      // Heartbeat to keep proxies alive
      const heartbeat = setInterval(() => {
        subscriber.next({ data: "", type: "heartbeat" });
      }, SSE_HEARTBEAT_INTERVAL_MS);

      // Cleanup on unsubscription (client disconnect)
      return () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    });
  }
}

function formatEvent(event: TransactionEvent): SseMessageEvent {
  return {
    id: String(event.id),
    type: "settlement_event",
    data: JSON.stringify({
      escrow_id: event.escrowId,
      type: event.type,
      state: event.state,
      corridor: event.corridor,
      amount_usdc: event.amountUsdc,
      occurred_at: event.occurredAt,
      stellar_tx_hash: event.stellarTxHash ?? null,
    }),
  };
}

/** Shared singleton instance. */
export const transactionController = new TransactionController();
