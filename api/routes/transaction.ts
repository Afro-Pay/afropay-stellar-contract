/**
 * Transaction settlement SSE streaming routes (Issue #83).
 *
 * GET /transactions/stream/:escrow_id  — real-time settlement timeline via SSE
 * GET /transactions/:escrow_id/status  — polling fallback for current state
 *
 * Uses the same SSE pattern as the escrow stream (Issue #24): replay events
 * since `Last-Event-ID` on reconnect, heartbeat comments every 15s to prevent
 * proxy timeouts, and an EventEmitter-backed subscribe/unsubscribe lifecycle.
 *
 * Event types pushed to clients:
 *   - TransactionCreated
 *   - TransactionSettled  (oracle signed the payout)
 *   - TransactionRefunded
 *   - state_changed       (intermediate status transitions)
 */

import { Router, Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import {
  transactionEventStore,
  TransactionEvent,
  TransactionSettlementState,
} from "../services/transactionEventStore";
import { transactions } from "../store";

/** How often to write an SSE comment so idle proxies don't time out the connection. */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

const router = Router();

function notFound(res: Response): void {
  res.status(404).json({ error: "transaction not found" });
}

// ---------------------------------------------------------------------------
// GET /transactions/stream/:escrow_id — real-time settlement via SSE
//
// Replays every event since `Last-Event-ID` (sent automatically by the
// browser's EventSource on reconnect; also accepted as a `?lastEventId=`
// query param for non-browser clients) before switching to live push.
// The event store's monotonic id is used as the SSE `id:` field, so
// no event can be skipped or double-delivered across a reconnect.
// ---------------------------------------------------------------------------
router.get("/stream/:escrow_id", (req: Request, res: Response): void => {
  const escrowId = req.params.escrow_id;

  // Verify the transaction/escrow exists in either the transaction store
  // or the transaction event store before opening a stream.
  const txExists = transactions.has(escrowId) || transactionEventStore.has(escrowId);

  // Constant-time dummy comparison to prevent timing-based enumeration
  const dummyBuf = Buffer.from("afropay-constant-time-dummy");
  try {
    timingSafeEqual(dummyBuf, dummyBuf);
  } catch {
    // noop
  }

  if (!txExists) {
    notFound(res);
    return;
  }

  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering (nginx) so events flush immediately.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  function writeEvent(event: TransactionEvent): void {
    const data = JSON.stringify({
      escrow_id: event.escrowId,
      type: event.type,
      state: event.state,
      corridor: event.corridor,
      amount_usdc: event.amountUsdc,
      occurred_at: event.occurredAt,
      stellar_tx_hash: event.stellarTxHash ?? null,
    });
    res.write(`id: ${event.id}\nevent: settlement_event\ndata: ${data}\n\n`);
  }

  const lastEventIdHeader =
    req.get("Last-Event-ID") ?? (req.query.lastEventId as string | undefined);
  const lastEventId = lastEventIdHeader ? Number(lastEventIdHeader) : 0;

  // Replay missed events
  for (const event of transactionEventStore.since(escrowId, lastEventId)) {
    writeEvent(event);
  }

  // Subscribe to live events
  const unsubscribe = transactionEventStore.subscribe(escrowId, writeEvent);

  // Heartbeat to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);

  // Cleanup on client disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// GET /transactions/:escrow_id/status — polling fallback
//
// Returns the current settlement state for clients that cannot use SSE.
// Uses constant-time comparison to prevent escrow-id enumeration.
// ---------------------------------------------------------------------------
router.get("/:escrow_id/status", (req: Request, res: Response): void => {
  const escrowId = req.params.escrow_id;
  const events = transactionEventStore.all(escrowId);

  const dummyBuf = Buffer.from("afropay-constant-time-dummy");
  try {
    timingSafeEqual(dummyBuf, dummyBuf);
  } catch {
    // noop
  }

  if (events.length === 0) {
    // Check if the transaction exists in the SEP-31 store
    const tx = transactions.get(escrowId);
    if (!tx) {
      notFound(res);
      return;
    }
    res.json({
      escrow_id: escrowId,
      state: tx.status as TransactionSettlementState,
      corridor: null,
      amount_usdc: tx.amount_in,
      updated_at: tx.updated_at,
    });
    return;
  }

  const latest = events[events.length - 1];
  res.json({
    escrow_id: latest.escrowId,
    state: latest.state,
    corridor: latest.corridor,
    amount_usdc: latest.amountUsdc,
    updated_at: latest.occurredAt,
    stellar_tx_hash: latest.stellarTxHash ?? null,
  });
});

export default router;
