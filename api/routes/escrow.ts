/**
 * Escrow management routes.
 *
 * POST /api/v1/escrow            – create an escrow (payment initiation)
 * GET  /api/v1/escrow/:id        – get escrow state
 * POST /api/v1/escrow/:id/release  – release funds to agent (SEP-10 required)
 * POST /api/v1/escrow/:id/dispute  – open a dispute  (SEP-10 required)
 *
 * Sensitive endpoints (/release, /dispute) are gated by the full SEP-10
 * Ed25519 JWT verification middleware (not just the shared-secret variant).
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { requireSep10Ed25519 } from "../middleware/sep10";
import {
  paymentSubmissionsTotal,
  escrowStateDurationSeconds,
} from "../services/metrics";

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
// ---------------------------------------------------------------------------
router.post("/", (req: Request, res: Response): void => {
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

  paymentSubmissionsTotal.inc({ status: "pending", corridor: record.corridor });

  res.status(201).json({ escrow_id: id, state: record.state });
});

// ---------------------------------------------------------------------------
// GET /api/v1/escrow/:id — poll escrow state
// ---------------------------------------------------------------------------
router.get("/:id", (req: Request, res: Response): void => {
  const record = escrows.get(req.params.id);
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

  paymentSubmissionsTotal.inc({ status: "failure", corridor: record.corridor });

  res.json({ escrow_id: record.id, state: record.state });
});

export default router;
