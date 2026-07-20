"use strict";
/**
 * Flutterwave webhook handler.
 *
 * Security
 * --------
 * Flutterwave signs every webhook by setting the `verif-hash` request header
 * to the value of the secret hash you configure in your Flutterwave dashboard
 * (FLW_WEBHOOK_SECRET).  This implementation re-creates the expected hash
 * with HMAC-SHA512 over the raw request body and performs a timing-safe
 * comparison so the signature cannot be brute-forced via timing differences.
 *
 * Idempotency
 * -----------
 * The idempotency key is `data.txRef` from the event body.  On first delivery
 * the handler:
 *   1. Verifies the signature.
 *   2. Inserts a row in the idempotency store.
 *   3. Attempts to apply the escrow state change.
 *   4. If the escrow does not yet exist, enqueues the event in the DLQ.
 *
 * On subsequent deliveries the handler detects the existing record and replays
 * the original HTTP response (200 with the cached body) without re-processing.
 *
 * Environment variables
 * ----------------------
 * FLW_WEBHOOK_SECRET  Shared secret configured in the Flutterwave dashboard.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = require("crypto");
const uuid_1 = require("uuid");
const idempotency_store_1 = require("./idempotency-store");
const dlq_1 = require("../../services/queue/dlq");
const store_1 = require("../store");
const router = (0, express_1.Router)();
const PROVIDER = "flutterwave";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Verify the Flutterwave `verif-hash` header against the raw body.
 *
 * Flutterwave uses a shared-secret approach: the header value IS the secret
 * hash (not an HMAC).  We derive an HMAC-SHA512 of the raw body with the
 * secret so that an attacker who intercepts the header cannot forge new
 * payloads — they would need the secret to re-sign a modified body.
 *
 * Returns true when the signature is valid.
 */
function verifySignature(rawBody, headerValue) {
    const secret = process.env.FLW_WEBHOOK_SECRET;
    if (!secret) {
        console.error("[flutterwave] FLW_WEBHOOK_SECRET is not set");
        return false;
    }
    const expected = (0, crypto_1.createHmac)("sha512", secret)
        .update(rawBody)
        .digest("hex");
    try {
        return (0, crypto_1.timingSafeEqual)(Buffer.from(headerValue, "utf8"), Buffer.from(expected, "utf8"));
    }
    catch {
        // timingSafeEqual throws if buffers differ in length
        return false;
    }
}
/** Extract the idempotency reference from the event body. */
function extractReference(body) {
    const data = body.data;
    if (!data)
        return undefined;
    const ref = data.tx_ref ?? data.txRef;
    return typeof ref === "string" && ref.length > 0 ? ref : undefined;
}
/** Apply escrow state change for a settled Flutterwave payment. */
function applyEscrowChange(body) {
    const data = body.data;
    if (!data)
        return false;
    // Map Flutterwave's tx_ref to a SEP-31 transaction id.
    const txRef = (data.tx_ref ?? data.txRef);
    if (!txRef)
        return false;
    const transaction = store_1.transactions.get(txRef);
    if (!transaction) {
        // Escrow record does not exist yet — caller should enqueue to DLQ.
        return false;
    }
    const event = body.event;
    const status = data.status?.toLowerCase();
    if (event === "charge.completed" && status === "successful") {
        transaction.status = "pending_stellar";
        transaction.updated_at = new Date().toISOString();
        transaction.external_transaction_id = String(data.id ?? txRef);
    }
    else if (status === "failed" || status === "cancelled") {
        transaction.status = "error";
        transaction.updated_at = new Date().toISOString();
    }
    return true;
}
// ---------------------------------------------------------------------------
// Route — POST /
// ---------------------------------------------------------------------------
/**
 * Receive and process a Flutterwave webhook.
 *
 * The route must be mounted with `express.raw({ type: '*\/*' })` so that
 * `req.body` is a Buffer and the raw bytes are available for HMAC verification.
 * The app.ts middleware applies `express.json()` globally; this handler uses
 * its own raw-body middleware via `router.use`.
 */
router.use((req, _res, next) => {
    // If express.json() already ran, body is an object — re-stringify it.
    // In production the route should be mounted before express.json().
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
    const sigHeader = req.get("verif-hash") ?? "";
    const rawBody = req.rawBody ??
        Buffer.from(JSON.stringify(req.body ?? {}), "utf8");
    if (!verifySignature(rawBody, sigHeader)) {
        const truncatedHash = Buffer.from(sigHeader).slice(0, 8).toString("hex");
        console.error(`[flutterwave] Invalid HMAC signature. provider=flutterwave ` +
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
//# sourceMappingURL=flutterwave.js.map