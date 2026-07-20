"use strict";
/**
 * Paystack webhook handler.
 *
 * Security
 * --------
 * Paystack signs each webhook by setting the `x-paystack-signature` header to
 * HMAC-SHA256(rawBody, PAYSTACK_SECRET_KEY) encoded as a lowercase hex digest.
 * This matches the signature verification approach documented at
 * https://paystack.com/docs/payments/webhooks/#verify-event-origin
 *
 * Idempotency
 * -----------
 * The idempotency key is `data.reference` from the event body.  On first
 * delivery the handler:
 *   1. Verifies the HMAC-SHA256 signature.
 *   2. Inserts a row in the idempotency store.
 *   3. Attempts to apply the escrow state change.
 *   4. If the escrow does not yet exist, enqueues the event in the DLQ.
 *
 * On subsequent deliveries the existing record is detected and the original
 * HTTP response is replayed without re-processing.
 *
 * Environment variables
 * ----------------------
 * PAYSTACK_SECRET_KEY  Secret key from your Paystack dashboard.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = require("crypto");
const uuid_1 = require("uuid");
const idempotency_store_1 = require("./idempotency-store");
const dlq_1 = require("../../services/queue/dlq");
const store_1 = require("../store");
const router = (0, express_1.Router)();
const PROVIDER = "paystack";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Verify the Paystack `x-paystack-signature` header.
 *
 * Paystack computes: HMAC-SHA256(rawBody, secretKey) → lowercase hex.
 * Returns true when the computed digest matches the header value.
 */
function verifySignature(rawBody, headerValue) {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) {
        console.error("[paystack] PAYSTACK_SECRET_KEY is not set");
        return false;
    }
    const expected = (0, crypto_1.createHmac)("sha256", secret)
        .update(rawBody)
        .digest("hex");
    try {
        return (0, crypto_1.timingSafeEqual)(Buffer.from(headerValue.toLowerCase(), "utf8"), Buffer.from(expected, "utf8"));
    }
    catch {
        // timingSafeEqual throws when buffers differ in byte length
        return false;
    }
}
/** Extract the idempotency reference from the Paystack event body. */
function extractReference(body) {
    const data = body.data;
    if (!data)
        return undefined;
    const ref = data.reference;
    return typeof ref === "string" && ref.length > 0 ? ref : undefined;
}
/** Apply escrow state change for a settled Paystack payment. */
function applyEscrowChange(body) {
    const data = body.data;
    if (!data)
        return false;
    const reference = data.reference;
    if (!reference)
        return false;
    const transaction = store_1.transactions.get(reference);
    if (!transaction) {
        // Escrow record does not exist yet — caller should enqueue to DLQ.
        return false;
    }
    const event = body.event;
    const status = data.status?.toLowerCase();
    if (event === "charge.success" && status === "success") {
        transaction.status = "pending_stellar";
        transaction.updated_at = new Date().toISOString();
        transaction.external_transaction_id = String(data.id ?? reference);
    }
    else if (status === "failed" || status === "abandoned") {
        transaction.status = "error";
        transaction.updated_at = new Date().toISOString();
    }
    return true;
}
// ---------------------------------------------------------------------------
// Route — POST /
// ---------------------------------------------------------------------------
/**
 * Receive and process a Paystack webhook.
 *
 * This handler works whether express.json() has already parsed the body
 * (object) or the raw Buffer is available via req.body.
 */
router.use((req, _res, next) => {
    if (!Buffer.isBuffer(req.body) && typeof req.body === "object") {
        req.rawBody = Buffer.from(JSON.stringify(req.body), "utf8");
    }
    else if (Buffer.isBuffer(req.body)) {
        req.rawBody = req.body;
    }
    next();
});
router.post("/", (req, res) => {
    // ── 1. Signature verification ──────────────────────────────────────────
    const sigHeader = req.get("x-paystack-signature") ?? "";
    const rawBody = req.rawBody ??
        Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
    if (!verifySignature(rawBody, sigHeader)) {
        const truncatedHash = sigHeader.slice(0, 16);
        console.error(`[paystack] Invalid HMAC signature. provider=paystack ` +
            `truncatedHash=${truncatedHash}`);
        res.status(400).json({ error: "invalid_signature" });
        return;
    }
    // ── 2. Parse body ──────────────────────────────────────────────────────
    let parsedBody;
    try {
        parsedBody =
            typeof req.body === "object" && !Buffer.isBuffer(req.body)
                ? req.body
                : JSON.parse(rawBody.toString("utf8"));
    }
    catch {
        res.status(400).json({ error: "invalid_json" });
        return;
    }
    // ── 3. Extract reference ───────────────────────────────────────────────
    const reference = extractReference(parsedBody);
    if (!reference) {
        res.status(400).json({ error: "missing_reference" });
        return;
    }
    // ── 4. Idempotency check ───────────────────────────────────────────────
    const existing = (0, idempotency_store_1.findRecord)(PROVIDER, reference);
    if (existing) {
        // Replay the cached response — no re-processing.
        res.status(200).json(JSON.parse(existing.responseBody));
        return;
    }
    // ── 5. Attempt escrow state change ────────────────────────────────────
    const escrowFound = applyEscrowChange(parsedBody);
    const status = escrowFound ? "processed" : "dlq";
    const responsePayload = { received: true, reference, status };
    const responseBody = JSON.stringify(responsePayload);
    // ── 6. Persist idempotency record ─────────────────────────────────────
    (0, idempotency_store_1.insertRecord)({
        id: (0, uuid_1.v4)(),
        provider: PROVIDER,
        reference,
        receivedAt: new Date().toISOString(),
        status,
        responseBody,
    });
    // ── 7. Enqueue to DLQ if escrow was not found ─────────────────────────
    if (!escrowFound) {
        (0, dlq_1.enqueue)({
            id: (0, uuid_1.v4)(),
            provider: PROVIDER,
            reference,
            rawBody: parsedBody,
        });
    }
    res.status(200).json(responsePayload);
});
exports.default = router;
//# sourceMappingURL=paystack.js.map