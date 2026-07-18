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

import { Router, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { v4 as uuidv4 } from "uuid";
import {
  findRecord,
  insertRecord,
  WebhookProvider,
} from "./idempotency-store";
import { enqueue } from "../../services/queue/dlq";
import { transactions } from "../store";

const router = Router();

const PROVIDER: WebhookProvider = "paystack";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Verify the Paystack `x-paystack-signature` header.
 *
 * Paystack computes: HMAC-SHA256(rawBody, secretKey) → lowercase hex.
 * Returns true when the computed digest matches the header value.
 */
function verifySignature(rawBody: Buffer, headerValue: string): boolean {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error("[paystack] PAYSTACK_SECRET_KEY is not set");
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(headerValue.toLowerCase(), "utf8"),
      Buffer.from(expected, "utf8")
    );
  } catch {
    // timingSafeEqual throws when buffers differ in byte length
    return false;
  }
}

/** Extract the idempotency reference from the Paystack event body. */
function extractReference(body: Record<string, unknown>): string | undefined {
  const data = body.data as Record<string, unknown> | undefined;
  if (!data) return undefined;
  const ref = data.reference;
  return typeof ref === "string" && ref.length > 0 ? ref : undefined;
}

/** Apply escrow state change for a settled Paystack payment. */
function applyEscrowChange(body: Record<string, unknown>): boolean {
  const data = body.data as Record<string, unknown> | undefined;
  if (!data) return false;

  const reference = data.reference as string | undefined;
  if (!reference) return false;

  const transaction = transactions.get(reference);
  if (!transaction) {
    // Escrow record does not exist yet — caller should enqueue to DLQ.
    return false;
  }

  const event = body.event as string | undefined;
  const status = (data.status as string | undefined)?.toLowerCase();

  if (event === "charge.success" && status === "success") {
    transaction.status = "pending_stellar";
    transaction.updated_at = new Date().toISOString();
    transaction.external_transaction_id = String(
      (data.id as number | string | undefined) ?? reference
    );
  } else if (status === "failed" || status === "abandoned") {
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
router.use((req: Request, _res: Response, next: () => void) => {
  if (!Buffer.isBuffer(req.body) && typeof req.body === "object") {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(
      JSON.stringify(req.body),
      "utf8"
    );
  } else if (Buffer.isBuffer(req.body)) {
    (req as Request & { rawBody?: Buffer }).rawBody = req.body;
  }
  next();
});

router.post("/", (req: Request, res: Response): void => {
  // ── 1. Signature verification ──────────────────────────────────────────
  const sigHeader = req.get("x-paystack-signature") ?? "";
  const rawBody: Buffer =
    (req as Request & { rawBody?: Buffer }).rawBody ??
    Buffer.from(JSON.stringify(req.body ?? {}), "utf8");

  if (!verifySignature(rawBody, sigHeader)) {
    const truncatedHash = sigHeader.slice(0, 16);
    console.error(
      `[paystack] Invalid HMAC signature. provider=paystack ` +
        `truncatedHash=${truncatedHash}`
    );
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  // ── 2. Parse body ──────────────────────────────────────────────────────
  let parsedBody: Record<string, unknown>;
  try {
    parsedBody =
      typeof req.body === "object" && !Buffer.isBuffer(req.body)
        ? (req.body as Record<string, unknown>)
        : (JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>);
  } catch {
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
  const existing = findRecord(PROVIDER, reference);
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
  insertRecord({
    id: uuidv4(),
    provider: PROVIDER,
    reference,
    receivedAt: new Date().toISOString(),
    status,
    responseBody,
  });

  // ── 7. Enqueue to DLQ if escrow was not found ─────────────────────────
  if (!escrowFound) {
    enqueue({
      id: uuidv4(),
      provider: PROVIDER,
      reference,
      rawBody: parsedBody,
    });
  }

  res.status(200).json(responsePayload);
});

export default router;
