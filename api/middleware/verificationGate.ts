/**
 * verificationGate — Express middleware that enforces CBN KYC requirements
 * for high-value NGN payment corridors (issue #19).
 *
 * Gate logic
 * ----------
 * 1. Skip non-NGN corridors entirely (other corridors have separate rules).
 * 2. Convert amount_usdc → NGN using NGN_RATE_ESTIMATE env var (conservative
 *    floor; a live oracle is out of scope for this issue).
 * 3. If estimated NGN value < TRANSFER_LIMIT_NGN → pass through.
 * 4. If estimated NGN value >= TRANSFER_LIMIT_NGN:
 *      - Look up the sender's cached verification_tier via BvnVerificationService.
 *      - If tier === "enhanced" → pass through.
 *      - Otherwise → return 403 with a structured error body.
 * 5. If Redis/KYC service is unavailable → pass through with a warning log
 *    (fail-open to avoid blocking payments during infrastructure issues;
 *    change to fail-closed once KYC is fully operational).
 *
 * The sender is identified by:
 *   - req.sep10.account  when the route is behind SEP-10 auth
 *   - req.body.sender_account  as a fallback (unauthenticated escrow POST)
 */

import { Request, Response, NextFunction, RequestHandler } from "express";
import {
  BvnVerificationService,
  VerificationTier,
} from "../services/kyc/bvnVerification";

// ---------------------------------------------------------------------------
// NGN corridor detection
// ---------------------------------------------------------------------------

/** Corridor codes that involve Nigerian Naira on the receiving end. */
const NGN_CORRIDORS = new Set([
  "USD_NGN",
  "GBP_NGN",
  "EUR_NGN",
  "CAD_NGN",
  "AUD_NGN",
]);

function isNgnCorridor(corridor: string): boolean {
  return NGN_CORRIDORS.has(corridor.toUpperCase());
}

// ---------------------------------------------------------------------------
// Middleware options
// ---------------------------------------------------------------------------

export interface VerificationGateOptions {
  /** BvnVerificationService instance. Pass null to skip the gate entirely. */
  service: BvnVerificationService | null;
  /**
   * CBN transfer threshold in NGN above which enhanced KYC is required.
   * Defaults to 1 000 000 (₦1,000,000).
   */
  thresholdNgn?: number;
  /**
   * Conservative USDC → NGN exchange rate used when a live rate feed is
   * unavailable. Defaults to NGN_RATE_ESTIMATE env var, then 1600.
   * A higher estimate is intentionally conservative — it will flag more
   * payments for KYC review rather than fewer.
   */
  ngnRateEstimate?: number;
}

// ---------------------------------------------------------------------------
// 403 response body
// ---------------------------------------------------------------------------

interface VerificationRequiredBody {
  error: "verification_required";
  message: string;
  required_tier: "enhanced";
  current_tier: VerificationTier;
  corridor: string;
  amount_usdc: string;
  estimated_ngn: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns an Express RequestHandler that enforces the KYC gate.
 *
 * Mount this before the route handler on POST /api/v1/escrow:
 *
 *   router.post("/", verificationGate({ service }), handler);
 */
export function verificationGate(
  options: VerificationGateOptions
): RequestHandler {
  const { service } = options;
  const thresholdNgn = options.thresholdNgn ?? 1_000_000;
  const ngnRateEstimate =
    options.ngnRateEstimate ??
    parseFloat(process.env.NGN_RATE_ESTIMATE ?? "1600");

  return async function verificationGateHandler(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // Gate disabled — no KYC service configured.
    if (!service) {
      next();
      return;
    }

    const { corridor, amount_usdc } = req.body ?? {};

    // Skip non-NGN corridors.
    if (!corridor || !isNgnCorridor(String(corridor))) {
      next();
      return;
    }

    const amountUsdc = parseFloat(String(amount_usdc));
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
      // Invalid amount — let the route handler return its own 400.
      next();
      return;
    }

    const estimatedNgn = amountUsdc * ngnRateEstimate;

    // Below the CBN threshold — no KYC required for this payment.
    if (estimatedNgn < thresholdNgn) {
      next();
      return;
    }

    // At or above threshold — check the sender's verification tier.
    const senderAccount: string | undefined =
      (req as Request & { sep10?: { account: string } }).sep10?.account ??
      (typeof req.body?.sender_account === "string"
        ? req.body.sender_account
        : undefined);

    if (!senderAccount) {
      // Cannot identify sender — fail-open with a warning.
      console.warn(
        "[verificationGate] Cannot identify sender account; skipping KYC check"
      );
      next();
      return;
    }

    let currentTier: VerificationTier;
    try {
      currentTier = (await service.getCachedTier(senderAccount)) ?? "none";
    } catch (err) {
      // KYC service unavailable — fail-open.
      console.error(
        `[verificationGate] KYC service error for ${senderAccount}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          "Failing open — payment allowed."
      );
      next();
      return;
    }

    if (currentTier === "enhanced") {
      next();
      return;
    }

    // Sender does not meet the required tier.
    const body: VerificationRequiredBody = {
      error: "verification_required",
      message:
        `Transfers above ₦${thresholdNgn.toLocaleString()} require enhanced KYC ` +
        "verification. Please complete BVN verification before retrying.",
      required_tier: "enhanced",
      current_tier: currentTier,
      corridor: String(corridor).toUpperCase(),
      amount_usdc: String(amount_usdc),
      estimated_ngn: Math.round(estimatedNgn),
    };

    res.status(403).json(body);
  };
}
