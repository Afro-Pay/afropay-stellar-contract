/**
 * Unit tests for verificationGate middleware (issue #19).
 *
 * Acceptance criteria covered:
 *  ✓ NGN corridor, amount below threshold     → gate passes through
 *  ✓ NGN corridor, above threshold, enhanced  → gate passes through
 *  ✓ NGN corridor, above threshold, none      → 403 with structured body
 *  ✓ NGN corridor, above threshold, basic     → 403 with structured body
 *  ✓ Non-NGN corridor                         → gate passes through regardless of tier
 *  ✓ No REDIS_URL / service null              → gate is skipped (no error)
 *  ✓ KYC service error                        → fail-open, gate passes through
 *  ✓ Missing sender_account                   → fail-open warning, gate passes through
 */

import request from "supertest";
import express, { Express, Request, Response } from "express";
import { verificationGate } from "../middleware/verificationGate";
import { BvnVerificationService, RedisClient } from "../services/kyc/bvnVerification";
import { BvnProvider } from "../services/kyc/providers/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THRESHOLD_NGN = 1_000_000;
/** At rate 1600, this is exactly ₦1,600,000 — above the threshold. */
const HIGH_USDC = "1000";
/** At rate 1600, this is ₦800,000 — below the threshold. */
const LOW_USDC = "499";
const SENDER = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";

function makeRedisMock(tier: string | null): RedisClient {
  const cached = tier ? JSON.stringify({ tier, verifiedAt: "", providerReference: "", providerResultCode: "" }) : null;
  return {
    set: jest.fn().mockResolvedValue("OK"),
    get: jest.fn().mockResolvedValue(cached),
    del: jest.fn().mockResolvedValue(1),
  };
}

function makeService(tier: string | null): BvnVerificationService {
  const provider: BvnProvider = { verify: jest.fn() };
  const redis = makeRedisMock(tier);
  return new BvnVerificationService(provider, redis);
}

/** Build a minimal Express app with the gate + a success handler. */
function buildApp(service: BvnVerificationService | null, thresholdNgn = THRESHOLD_NGN): Express {
  const app = express();
  app.use(express.json());
  app.post(
    "/api/v1/escrow",
    verificationGate({ service, thresholdNgn, ngnRateEstimate: 1600 }),
    (_req: Request, res: Response) => {
      res.status(201).json({ ok: true });
    }
  );
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verificationGate", () => {
  // =========================================================================
  // NGN corridor — below threshold
  // =========================================================================
  describe("NGN corridor, amount below threshold", () => {
    it("passes through without checking tier", async () => {
      const service = makeService(null); // no cached tier
      const app = buildApp(service);

      const res = await request(app)
        .post("/api/v1/escrow")
        .send({ sender_account: SENDER, corridor: "USD_NGN", amount_usdc: LOW_USDC });

      expect(res.status).toBe(201);
    });
  });

  // =========================================================================
  // NGN corridor — above threshold, enhanced tier
  // =========================================================================
  describe("NGN corridor, above threshold, tier=enhanced", () => {
    it("passes through when sender has enhanced verification", async () => {
      const service = makeService("enhanced");
      const app = buildApp(service);

      const res = await request(app)
        .post("/api/v1/escrow")
        .send({ sender_account: SENDER, corridor: "USD_NGN", amount_usdc: HIGH_USDC });

      expect(res.status).toBe(201);
    });
  });

  // =========================================================================
  // NGN corridor — above threshold, none tier
  // =========================================================================
  describe("NGN corridor, above threshold, tier=none", () => {
    it("returns 403 with structured error body", async () => {
      const service = makeService("none");
      const app = buildApp(service);

      const res = await request(app)
        .post("/api/v1/escrow")
        .send({ sender_account: SENDER, corridor: "USD_NGN", amount_usdc: HIGH_USDC });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("verification_required");
      expect(res.body.required_tier).toBe("enhanced");
      expect(res.body.current_tier).toBe("none");
      expect(res.body.corridor).toBe("USD_NGN");
      expect(res.body.amount_usdc).toBe(HIGH_USDC);
      expect(typeof res.body.estimated_ngn).toBe("number");
      expect(res.body.estimated_ngn).toBeGreaterThanOrEqual(THRESHOLD_NGN);
      expect(res.body.message).toMatch(/enhanced KYC/i);
    });
  });

  // =========================================================================
  // NGN corridor — above threshold, basic tier
  // =========================================================================
  describe("NGN corridor, above threshold, tier=basic", () => {
    it("returns 403 — basic tier is insufficient for high-value transfers", async () => {
      const service = makeService("basic");
      const app = buildApp(service);

      const res = await request(app)
        .post("/api/v1/escrow")
        .send({ sender_account: SENDER, corridor: "USD_NGN", amount_usdc: HIGH_USDC });

      expect(res.status).toBe(403);
      expect(res.body.current_tier).toBe("basic");
    });
  });

  // =========================================================================
  // Non-NGN corridor
  // =========================================================================
  describe("non-NGN corridor", () => {
    it.each(["USD_USD", "EUR_GHS", "GBP_KES", "USD_KES"])(
      "passes through for corridor %s regardless of tier",
      async (corridor) => {
        const service = makeService("none"); // unverified sender
        const app = buildApp(service);

        const res = await request(app)
          .post("/api/v1/escrow")
          .send({ sender_account: SENDER, corridor, amount_usdc: HIGH_USDC });

        expect(res.status).toBe(201);
      }
    );
  });

  // =========================================================================
  // service=null (REDIS_URL not set)
  // =========================================================================
  describe("service is null (Redis/KYC not configured)", () => {
    it("skips the gate entirely — all payments pass through", async () => {
      const app = buildApp(null);

      const res = await request(app)
        .post("/api/v1/escrow")
        .send({ sender_account: SENDER, corridor: "USD_NGN", amount_usdc: HIGH_USDC });

      expect(res.status).toBe(201);
    });
  });

  // =========================================================================
  // KYC service throws — fail-open
  // =========================================================================
  describe("KYC service error (fail-open)", () => {
    it("passes through when getCachedTier throws", async () => {
      // Build a service whose getCachedTier rejects at the service level
      // (simulates an unexpected exception that bypasses internal error handling).
      const provider: BvnProvider = { verify: jest.fn() };
      const redis = makeRedisMock(null);
      const service = new BvnVerificationService(provider, redis);
      jest.spyOn(service, "getCachedTier").mockRejectedValue(
        new Error("Unexpected KYC service failure")
      );
      const app = buildApp(service);

      const res = await request(app)
        .post("/api/v1/escrow")
        .send({ sender_account: SENDER, corridor: "USD_NGN", amount_usdc: HIGH_USDC });

      // Fail-open: payment allowed despite KYC service being unavailable.
      expect(res.status).toBe(201);
    });
  });

  // =========================================================================
  // Missing sender_account — fail-open
  // =========================================================================
  describe("missing sender_account", () => {
    it("passes through when sender cannot be identified", async () => {
      const service = makeService("none");
      const app = buildApp(service);

      // No sender_account in the body.
      const res = await request(app)
        .post("/api/v1/escrow")
        .send({ corridor: "USD_NGN", amount_usdc: HIGH_USDC });

      expect(res.status).toBe(201);
    });
  });

  // =========================================================================
  // All NGN corridor variants are detected
  // =========================================================================
  describe("NGN corridor detection", () => {
    it.each(["USD_NGN", "GBP_NGN", "EUR_NGN", "CAD_NGN", "AUD_NGN"])(
      "detects %s as an NGN corridor",
      async (corridor) => {
        const service = makeService("none");
        const app = buildApp(service);

        const res = await request(app)
          .post("/api/v1/escrow")
          .send({ sender_account: SENDER, corridor, amount_usdc: HIGH_USDC });

        expect(res.status).toBe(403);
      }
    );
  });
});
