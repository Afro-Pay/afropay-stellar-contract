"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.escrows = void 0;
const express_1 = require("express");
const uuid_1 = require("uuid");
const sep10_1 = require("../middleware/sep10");
const metrics_1 = require("../services/metrics");
/** In-memory store — replace with a database in production. */
exports.escrows = new Map();
const router = (0, express_1.Router)();
function notFound(res) {
    res.status(404).json({ error: "escrow not found" });
}
// ---------------------------------------------------------------------------
// POST /api/v1/escrow — initiate a payment / create escrow
// ---------------------------------------------------------------------------
router.post("/", (req, res) => {
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
    const id = (0, uuid_1.v4)();
    const now = new Date();
    const record = {
        id,
        senderAccount: sender_account,
        corridor: corridor.toUpperCase(),
        amountUsdc: numericAmount.toFixed(7),
        state: "Funded",
        createdAt: now,
        stateChangedAt: now,
    };
    exports.escrows.set(id, record);
    metrics_1.paymentSubmissionsTotal.inc({ status: "pending", corridor: record.corridor });
    res.status(201).json({ escrow_id: id, state: record.state });
});
// ---------------------------------------------------------------------------
// GET /api/v1/escrow/:id — poll escrow state
// ---------------------------------------------------------------------------
router.get("/:id", (req, res) => {
    const record = exports.escrows.get(req.params.id);
    if (!record) {
        notFound(res);
        return;
    }
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
router.post("/:id/release", sep10_1.requireSep10Ed25519, (req, res) => {
    const record = exports.escrows.get(req.params.id);
    if (!record) {
        notFound(res);
        return;
    }
    if (record.state !== "Funded") {
        res.status(409).json({ error: `escrow is in state ${record.state}, not Funded` });
        return;
    }
    // Record time spent in Funded state
    const durationSec = (Date.now() - record.stateChangedAt.getTime()) / 1000;
    metrics_1.escrowStateDurationSeconds.observe({ state: "Funded" }, durationSec);
    record.state = "Released";
    record.stateChangedAt = new Date();
    metrics_1.paymentSubmissionsTotal.inc({ status: "success", corridor: record.corridor });
    res.json({ escrow_id: record.id, state: record.state });
});
// ---------------------------------------------------------------------------
// POST /api/v1/escrow/:id/dispute — SEP-10 gated
// ---------------------------------------------------------------------------
router.post("/:id/dispute", sep10_1.requireSep10Ed25519, (req, res) => {
    const record = exports.escrows.get(req.params.id);
    if (!record) {
        notFound(res);
        return;
    }
    if (!["Funded", "Released"].includes(record.state)) {
        res.status(409).json({ error: `escrow in state ${record.state} cannot be disputed` });
        return;
    }
    const durationSec = (Date.now() - record.stateChangedAt.getTime()) / 1000;
    metrics_1.escrowStateDurationSeconds.observe({ state: record.state }, durationSec);
    record.state = "Refundable";
    record.stateChangedAt = new Date();
    metrics_1.paymentSubmissionsTotal.inc({ status: "failure", corridor: record.corridor });
    res.json({ escrow_id: record.id, state: record.state });
});
exports.default = router;
//# sourceMappingURL=escrow.js.map