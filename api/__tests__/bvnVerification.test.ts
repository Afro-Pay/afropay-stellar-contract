/**
 * Unit tests for BvnVerificationService (issue #19).
 *
 * Acceptance criteria covered:
 *  ✓ verified        — provider returns enhanced tier; cached in Redis
 *  ✓ unverified      — provider returns none tier; cached in Redis
 *  ✓ pending         — provider throws VerificationPendingError; nothing cached
 *  ✓ provider-error  — provider throws ProviderError (5xx); nothing cached
 *  ✓ cache-hit       — two calls within TTL window; provider called exactly once
 *  ✓ audit trail     — every attempt (success or failure) written to escrowEventStore
 */

import { BvnVerificationService, RedisClient } from "../services/kyc/bvnVerification";
import { BvnProvider, BvnLookupResult } from "../services/kyc/providers/types";
import { ProviderError, VerificationPendingError } from "../services/kyc/errors";
import { escrowEventStore } from "../services/eventStore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STELLAR_ACCOUNT = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
const BVN = "12345678901";

function makeResult(overrides: Partial<BvnLookupResult> = {}): BvnLookupResult {
  return {
    tier: "enhanced",
    verifiedAt: "2026-07-24T22:00:00.000Z",
    providerReference: "smile-ref-001",
    providerResultCode: "1012",
    ...overrides,
  };
}

/** Build a simple in-memory Redis mock. */
function makeRedisMock(): RedisClient & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn().mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    get: jest.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
    del: jest.fn().mockImplementation(async (key: string) => {
      store.delete(key);
      return 1;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  escrowEventStore.reset();
});

describe("BvnVerificationService", () => {
  // =========================================================================
  // Scenario 1 — verified (provider returns enhanced)
  // =========================================================================
  describe("verified scenario", () => {
    it("returns enhanced tier and writes result to Redis cache", async () => {
      const result = makeResult({ tier: "enhanced" });
      const provider: BvnProvider = { verify: jest.fn().mockResolvedValue(result) };
      const redis = makeRedisMock();
      const service = new BvnVerificationService(provider, redis);

      const outcome = await service.verify(BVN, STELLAR_ACCOUNT);

      expect(outcome.tier).toBe("enhanced");
      expect(provider.verify).toHaveBeenCalledTimes(1);

      // Allow the fire-and-forget cache write to flush.
      await Promise.resolve();

      const cachedRaw = redis.store.get(`kyc:bvn:${STELLAR_ACCOUNT}`);
      expect(cachedRaw).toBeDefined();
      expect(JSON.parse(cachedRaw!).tier).toBe("enhanced");

      expect(redis.set).toHaveBeenCalledWith(
        `kyc:bvn:${STELLAR_ACCOUNT}`,
        expect.any(String),
        "EX",
        86_400
      );
    });

    it("writes a verified audit event to the escrowEventStore", async () => {
      const provider: BvnProvider = {
        verify: jest.fn().mockResolvedValue(makeResult({ tier: "enhanced" })),
      };
      const service = new BvnVerificationService(provider, makeRedisMock());

      await service.verify(BVN, STELLAR_ACCOUNT);

      const events = escrowEventStore.all(STELLAR_ACCOUNT);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("kyc_verification_attempt");
      expect(events[0].actor).toBe(STELLAR_ACCOUNT);
      expect(events[0].kycOutcome).toBe("verified");
      expect(events[0].kycProviderReference).toBe("smile-ref-001");
      expect(events[0].occurredAt).toBeTruthy();
    });
  });

  // =========================================================================
  // Scenario 2 — unverified (provider returns none)
  // =========================================================================
  describe("unverified scenario", () => {
    it("returns none tier and writes result to Redis cache", async () => {
      const result = makeResult({ tier: "none", providerResultCode: "1014" });
      const provider: BvnProvider = { verify: jest.fn().mockResolvedValue(result) };
      const redis = makeRedisMock();
      const service = new BvnVerificationService(provider, redis);

      const outcome = await service.verify(BVN, STELLAR_ACCOUNT);

      expect(outcome.tier).toBe("none");
      await Promise.resolve();
      expect(redis.store.has(`kyc:bvn:${STELLAR_ACCOUNT}`)).toBe(true);
    });

    it("writes an unverified audit event", async () => {
      const provider: BvnProvider = {
        verify: jest.fn().mockResolvedValue(makeResult({ tier: "none" })),
      };
      const service = new BvnVerificationService(provider, makeRedisMock());

      await service.verify(BVN, STELLAR_ACCOUNT);

      const events = escrowEventStore.all(STELLAR_ACCOUNT);
      expect(events[0].kycOutcome).toBe("unverified");
    });
  });

  // =========================================================================
  // Scenario 3 — verification-pending
  // =========================================================================
  describe("verification-pending scenario", () => {
    it("throws VerificationPendingError and does NOT write to cache", async () => {
      const provider: BvnProvider = {
        verify: jest.fn().mockRejectedValue(
          new VerificationPendingError("smile-pending-001")
        ),
      };
      const redis = makeRedisMock();
      const service = new BvnVerificationService(provider, redis);

      await expect(service.verify(BVN, STELLAR_ACCOUNT)).rejects.toBeInstanceOf(
        VerificationPendingError
      );

      await Promise.resolve();
      expect(redis.store.has(`kyc:bvn:${STELLAR_ACCOUNT}`)).toBe(false);
    });
  });

  // =========================================================================
  // Scenario 4 — provider-error (5xx from provider)
  // =========================================================================
  describe("provider-error scenario", () => {
    it("throws ProviderError and does NOT write to cache", async () => {
      const provider: BvnProvider = {
        verify: jest.fn().mockRejectedValue(
          new ProviderError("Smile Identity returned HTTP 503", 503)
        ),
      };
      const redis = makeRedisMock();
      const service = new BvnVerificationService(provider, redis);

      await expect(service.verify(BVN, STELLAR_ACCOUNT)).rejects.toBeInstanceOf(
        ProviderError
      );

      await Promise.resolve();
      expect(redis.store.has(`kyc:bvn:${STELLAR_ACCOUNT}`)).toBe(false);
    });

    it("writes a provider_error audit event", async () => {
      const provider: BvnProvider = {
        verify: jest.fn().mockRejectedValue(new ProviderError("5xx error", 503)),
      };
      const service = new BvnVerificationService(provider, makeRedisMock());

      await service.verify(BVN, STELLAR_ACCOUNT).catch(() => undefined);

      const events = escrowEventStore.all(STELLAR_ACCOUNT);
      expect(events).toHaveLength(1);
      expect(events[0].kycOutcome).toBe("provider_error");
    });
  });

  // =========================================================================
  // Scenario 5 — cache-hit (provider called exactly once within TTL window)
  // =========================================================================
  describe("cache-hit scenario", () => {
    it("calls the provider exactly once for two back-to-back requests within the TTL window", async () => {
      const result = makeResult({ tier: "enhanced" });
      const provider: BvnProvider = { verify: jest.fn().mockResolvedValue(result) };
      const redis = makeRedisMock();
      const service = new BvnVerificationService(provider, redis);

      // First call — cache miss → hits provider.
      const first = await service.verify(BVN, STELLAR_ACCOUNT);
      // Allow fire-and-forget cache write to complete.
      await Promise.resolve();

      // Second call — cache hit → must NOT call provider again.
      const second = await service.verify(BVN, STELLAR_ACCOUNT);

      expect(provider.verify).toHaveBeenCalledTimes(1);
      expect(first.tier).toBe("enhanced");
      expect(second.tier).toBe("enhanced");
    });

    it("getCachedTier returns the cached tier without calling the provider", async () => {
      const result = makeResult({ tier: "enhanced" });
      const provider: BvnProvider = { verify: jest.fn().mockResolvedValue(result) };
      const redis = makeRedisMock();
      const service = new BvnVerificationService(provider, redis);

      await service.verify(BVN, STELLAR_ACCOUNT);
      await Promise.resolve();

      const tier = await service.getCachedTier(STELLAR_ACCOUNT);

      expect(tier).toBe("enhanced");
      // Provider must still have been called only once (from the initial verify).
      expect(provider.verify).toHaveBeenCalledTimes(1);
    });

    it("getCachedTier returns null on cache miss", async () => {
      const provider: BvnProvider = { verify: jest.fn() };
      const service = new BvnVerificationService(provider, makeRedisMock());

      const tier = await service.getCachedTier(STELLAR_ACCOUNT);
      expect(tier).toBeNull();
      expect(provider.verify).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // invalidate
  // =========================================================================
  describe("invalidate", () => {
    it("removes the cache entry so the next verify() hits the provider again", async () => {
      const provider: BvnProvider = {
        verify: jest.fn().mockResolvedValue(makeResult()),
      };
      const redis = makeRedisMock();
      const service = new BvnVerificationService(provider, redis);

      await service.verify(BVN, STELLAR_ACCOUNT);
      await Promise.resolve();
      expect(redis.store.has(`kyc:bvn:${STELLAR_ACCOUNT}`)).toBe(true);

      await service.invalidate(STELLAR_ACCOUNT);
      expect(redis.store.has(`kyc:bvn:${STELLAR_ACCOUNT}`)).toBe(false);

      await service.verify(BVN, STELLAR_ACCOUNT);
      expect(provider.verify).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Redis unavailability — fail-open (no crash, cache miss)
  // =========================================================================
  describe("Redis unavailable", () => {
    it("treats a Redis GET error as a cache miss and still calls the provider", async () => {
      const result = makeResult();
      const provider: BvnProvider = { verify: jest.fn().mockResolvedValue(result) };
      const brokenRedis: RedisClient = {
        set: jest.fn().mockResolvedValue("OK"),
        get: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        del: jest.fn().mockResolvedValue(1),
      };
      const service = new BvnVerificationService(provider, brokenRedis);

      const outcome = await service.verify(BVN, STELLAR_ACCOUNT);

      expect(outcome.tier).toBe("enhanced");
      expect(provider.verify).toHaveBeenCalledTimes(1);
    });
  });
});
