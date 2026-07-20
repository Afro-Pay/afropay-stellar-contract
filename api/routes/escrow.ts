/**
 * Escrow management routes.
 *
 * POST /api/v1/escrow              – create an escrow (payment initiation)
 * GET  /api/v1/escrow/:id          – get escrow state
 * POST /api/v1/escrow/:id/release  – release funds to agent  (SEP-10 Ed25519 required)
 * POST /api/v1/escrow/:id/dispute  – open a dispute          (SEP-10 Ed25519 required)
 *
 * The /release and /dispute endpoints are gated by requireSep10Ed25519 which:
 *  - Fetches the anchor's public key from stellar.toml (cached 1 h)
 *  - Verifies the JWT's EdDSA signature against that key
 *  - Returns 401 with a descriptive error for all failure scenarios
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { requireSep10Ed25519 } from "../middleware/sep10";

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
// POST /api/v1/escrow/:id/release — SEP-10 Ed25519 gated
// ---------------------------------------------------------------------------
router.post("/:id/release", requireSep10Ed25519, (req: Request, res: Response): void => {
  const record = escrows.get(req.params.id);
  if (!record) { notFound(res); return; }

  if (record.state !== "Funded") {
    res.status(409).json({ error: `escrow is in state ${record.state}, not Funded` });
    return;
  }

  record.state = "Released";
  record.stateChangedAt = new Date();

  res.json({ escrow_id: record.id, state: record.state });
});

// ---------------------------------------------------------------------------
// POST /api/v1/escrow/:id/dispute — SEP-10 Ed25519 gated
// ---------------------------------------------------------------------------
router.post("/:id/dispute", requireSep10Ed25519, (req: Request, res: Response): void => {
  const record = escrows.get(req.params.id);
  if (!record) { notFound(res); return; }

  if (!["Funded", "Released"].includes(record.state)) {
    res.status(409).json({ error: `escrow in state ${record.state} cannot be disputed` });
    return;
  }

  record.state = "Refundable";
  record.stateChangedAt = new Date();

  res.json({ escrow_id: record.id, state: record.state });
});

export default router;
