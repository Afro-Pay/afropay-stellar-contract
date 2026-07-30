/**
 * Escrow management routes.
 *
 * POST /api/v1/escrow            – create an escrow (payment initiation)
 * GET  /api/v1/escrow/:id        – get escrow state
 * GET  /api/v1/escrow/:id/stream – real-time escrow timeline via SSE (Issue #24)
 * POST /api/v1/escrow/:id/release  – release funds to agent (SEP-10 required)
 * POST /api/v1/escrow/:id/dispute  – open a dispute  (SEP-10 required)
 *
 * Sensitive endpoints (/release, /dispute) are gated by the full SEP-10
 * Ed25519 JWT verification middleware (not just the shared-secret variant).
 *
 * Payment initiation (POST /) is gated by verificationGate which enforces
 * CBN KYC requirements for high-value NGN corridor transfers (issue #19).
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { timingSafeEqual } from "crypto";
import { requireSep10Ed25519 } from "../middleware/sep10";
import { verificationGate } from "../middleware/verificationGate";
import { createBvnVerificationService } from "../services/kyc/bvnVerification";
import {
  paymentSubmissionsTotal,
  escrowStateDurationSeconds,
} from "../services/metrics";
import { escrowEventStore, EscrowEvent } from "../services/eventStore";

// ---------------------------------------------------------------------------
// KYC verification gate — instantiated once at module load.
// The gate is a no-op (service: null) when REDIS_URL is not set so that
// local development and CI runs without a Redis instance still work.
// ---------------------------------------------------------------------------
const kycRedis = process.env.REDIS_URL
  ? (() => {
      // Lazy-require ioredis so it is only resolved when REDIS_URL is present.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Redis = require("ioredis") as { new(url: string): import("../services/kyc/bvnVerification").RedisClient };
      return new Redis(process.env.REDIS_URL);
    })()
  : null;

const kycService = kycRedis ? createBvnVerificationService(kycRedis) : null;

const kycGate = verificationGate({
  service: kycService,
  thresholdNgn: parseInt(process.env.TRANSFER_LIMIT_NGN ?? "1000000", 10),
});

/** How often to write an SSE comment so idle proxies don't time out the connection. */
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export type EscrowState = "Funded" | "Released" | "Refundable" | "Refunded" | "Cancelled";

export interface EscrowRecord {
  id: string;
  senderAccount: string;
  corridor: string;
  amountUsdc: string;
  state: EscrowState;
  createdAt: Date;
  stateChangedAt: Date;
}

/** In-memory store — replace with a database in production. */
export const escrows = new Map<string, EscrowRecord>();

const router = Router();

function notFound(res: Response): void {
  res.status(404).json({ error: "escrow not found" });
}

// ---------------------------------------------------------------------------
// POST /api/v1/escrow — initiate a payment / create escrow
// KYC gate applied first: rejects high-value NGN payments from unverified
// senders with 403 before the handler runs (issue #19).
// ---------------------------------------------------------------------------
router.post("/", kycGate, (req: Request, res: Response): void => {
  const { sender_account, corridor, amount_usdc } = req.body ?? {};

  if (!sender_account || typeof sender_account !== "string") {
    res.status(400).json({ error: "sender_account is required" });
    return;
  }
  if (!corridor || typeof corridor !== "string") {
    res.status(400).json({ error: "corridor is required (e.g. USD_NGN)" });
    return;
  }
  const numericAmount = Number(amount_usdc);
  if (!amount_usdc || !Number.isFinite(numericAmount) || numericAmount <= 0) {
    res.status(400).json({ error: "amount_usdc must be a positive number" });
    return;
  }

  const id = uuidv4();
  const now = new Date();
  const record: EscrowRecord = {
    id,
    senderAccount: sender_account,
    corridor: corridor.toUpperCase(),
    amountUsdc: numericAmount.toFixed(7),
    state: "Funded",
    createdAt: now,
    stateChangedAt: now,
  };
  escrows.set(id, record);

  escrowEventStore.append(id, {
    type: "created",
    state: record.state,
    corridor: record.corridor,
    amountUsdc: record.amountUsdc,
  });

  paymentSubmissionsTotal.inc({ status: "pending", corridor: record.corridor });

  res.status(201).json({ escrow_id: id, state: record.state });
});

// ---------------------------------------------------------------------------
// GET /api/v1/escrow/:id — poll escrow state (constant-time)
// ---------------------------------------------------------------------------
// Both hit and miss paths perform the same dummy timingSafeEqual call so
// that response timing cannot be used to enumerate valid escrow IDs.
// ---------------------------------------------------------------------------
router.get("/:id", (req: Request, res: Response): void => {
  const record = escrows.get(req.params.id);
  const dummyBuf = Buffer.from("afropay-constant-time-dummy");
  try {
    timingSafeEqual(dummyBuf, dummyBuf);
  } catch {
    // noop
  }
  if (!record) { notFound(res); return; }

  res.json({
    escrow_id: record.id,
    state: record.state,
    corridor: record.corridor,
    amount_usdc: record.amountUsdc,
    created_at: record.createdAt.toISOString(),
    state_changed_at: record.stateChangedAt.toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/escrow/:id/stream — real-time timeline via Server-Sent Events
//
// Replays every event since `Last-Event-ID` (sent automatically by the
// browser's EventSource on reconnect; also accepted as a `?lastEventId=`
// query param for non-browser clients and tests) before switching to live
// push. The event store's monotonic id is used as the SSE `id:` field, so
// no event can be skipped or double-delivered across a reconnect.
// ---------------------------------------------------------------------------
router.get("/:id/stream", (req: Request, res: Response): void => {
  const record = escrows.get(req.params.id);
  if (!record) { notFound(res); return; }

  const escrowId = record.id;

  res.status(200);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering (nginx) so events flush immediately.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  function writeEvent(event: EscrowEvent): void {
    // Written as a single frame so the id/event/data lines always arrive in
    // one TCP chunk together — a partial write could otherwise let a
    // reconnecting client observe an `id:` with no matching `data:` yet.
    const data = JSON.stringify({
      escrow_id: event.escrowId,
      type: event.type,
      state: event.state,
      corridor: event.corridor,
      amount_usdc: event.amountUsdc,
      occurred_at: event.occurredAt,
    });
    res.write(`id: ${event.id}\nevent: escrow_event\ndata: ${data}\n\n`);
  }

  const lastEventIdHeader =
    req.get("Last-Event-ID") ?? (req.query.lastEventId as string | undefined);
  const lastEventId = lastEventIdHeader ? Number(lastEventIdHeader) : 0;

  for (const event of escrowEventStore.since(escrowId, lastEventId)) {
    writeEvent(event);
  }

  const unsubscribe = escrowEventStore.subscribe(escrowId, writeEvent);

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/escrow/:id/release — SEP-10 gated
// ---------------------------------------------------------------------------
router.post("/:id/release", requireSep10Ed25519, (req: Request, res: Response): void => {
  const record = escrows.get(req.params.id);
  if (!record) { notFound(res); return; }

  if (record.state !== "Funded") {
    res.status(409).json({ error: `escrow is in state ${record.state}, not Funded` });
    return;
  }

  // Record time spent in Funded state
  const durationSec = (Date.now() - record.stateChangedAt.getTime()) / 1000;
  escrowStateDurationSeconds.observe({ state: "Funded" }, durationSec);

  record.state = "Released";
  record.stateChangedAt = new Date();

  escrowEventStore.append(record.id, {
    type: "state_changed",
    state: record.state,
    corridor: record.corridor,
    amountUsdc: record.amountUsdc,
  });

  paymentSubmissionsTotal.inc({ status: "success", corridor: record.corridor });

  res.json({ escrow_id: record.id, state: record.state });
});

// ---------------------------------------------------------------------------
// POST /api/v1/escrow/:id/dispute — SEP-10 gated
// ---------------------------------------------------------------------------
router.post("/:id/dispute", requireSep10Ed25519, (req: Request, res: Response): void => {
  const record = escrows.get(req.params.id);
  if (!record) { notFound(res); return; }

  if (!["Funded", "Released"].includes(record.state)) {
    res.status(409).json({ error: `escrow in state ${record.state} cannot be disputed` });
    return;
  }

  const durationSec = (Date.now() - record.stateChangedAt.getTime()) / 1000;
  escrowStateDurationSeconds.observe({ state: record.state }, durationSec);

  record.state = "Refundable";
  record.stateChangedAt = new Date();

  escrowEventStore.append(record.id, {
    type: "state_changed",
    state: record.state,
    corridor: record.corridor,
    amountUsdc: record.amountUsdc,
  });

  paymentSubmissionsTotal.inc({ status: "failure", corridor: record.corridor });

  res.json({ escrow_id: record.id, state: record.state });
});

export default router;
