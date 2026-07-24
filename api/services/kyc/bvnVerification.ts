/**
 * BvnVerificationService — orchestrates BVN verification with a Redis
 * caching layer (issue #19).
 *
 * Cache strategy
 * --------------
 * Key   : kyc:bvn:<stellarAccount>  (never keyed on raw BVN)
 * Value : JSON-serialised BvnLookupResult
 * TTL   : 24 hours (configurable via constructor)
 *
 * On cache hit  → return cached result; provider is NOT called.
 * On cache miss → call provider → on success, write to Redis with TTL
 *                 → return result.
 * On provider 5xx → throw ProviderError; nothing written to cache.
 * On pending    → throw VerificationPendingError; nothing written to cache.
 *
 * The RedisClient interface below is intentionally minimal so both
 * ioredis and node-redis v4 clients satisfy it without adaptation, and
 * tests can pass a plain mock object.
 */

import { BvnProvider, BvnLookupResult, VerificationTier } from "./providers/types";
import { ProviderError } from "./errors";
import { escrowEventStore, KycOutcome } from "../eventStore";
import { EscrowState } from "../../routes/escrow";

// ---------------------------------------------------------------------------
// Minimal Redis client interface (ioredis / node-redis v4 compatible)
// ---------------------------------------------------------------------------

export interface RedisClient {
  /** Set key with an expiry in seconds. Returns "OK" on success. */
  set(key: string, value: string, expiryMode: "EX", ttl: number): Promise<string | null>;
  /** Get value by key. Returns null on cache miss. */
  get(key: string): Promise<string | null>;
  /** Delete one or more keys. */
  del(key: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Cache key helpers
// ---------------------------------------------------------------------------

const CACHE_KEY_PREFIX = "kyc:bvn:";

function cacheKey(stellarAccount: string): string {
  return `${CACHE_KEY_PREFIX}${stellarAccount}`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class BvnVerificationService {
  constructor(
    private readonly provider: BvnProvider,
    private readonly redis: RedisClient,
    /** Cache TTL in seconds — defaults to 24 hours. */
    private readonly ttlSeconds: number = 86_400
  ) {}

  /**
   * Verify a BVN for the given Stellar account.
   *
   * Returns the cached result if one exists and has not expired.
   * Otherwise calls the provider, caches the result, and returns it.
   *
   * @param bvn             11-digit Nigerian Bank Verification Number.
   * @param stellarAccount  Stellar G… account initiating the payment.
   * @throws ProviderError           on provider 4xx / 5xx / network failure.
   * @throws VerificationPendingError when provider result is not yet ready.
   */
  async verify(bvn: string, stellarAccount: string): Promise<BvnLookupResult> {
    // 1. Check cache first.
    const cached = await this.getCached(stellarAccount);
    if (cached !== null) {
      return cached;
    }

    // 2. Cache miss — call provider.
    let result: BvnLookupResult;
    try {
      result = await this.provider.verify(bvn, stellarAccount);
    } catch (err) {
      // Write a provider_error audit event before re-throwing.
      this.appendAuditEvent(stellarAccount, "provider_error", null);
      throw err;
    }

    // 3. Determine audit outcome from resolved tier.
    const outcome: KycOutcome =
      result.tier === "enhanced" || result.tier === "basic"
        ? "verified"
        : "unverified";

    // 4. Write audit trail (fire-and-forget — must not block the caller).
    this.appendAuditEvent(stellarAccount, outcome, result.providerReference);

    // 5. Write to cache (fire-and-forget).
    this.writeCache(stellarAccount, result).catch((err: unknown) => {
      console.error(
        `[kyc] Failed to cache verification result for ${stellarAccount}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    });

    return result;
  }

  /**
   * Return the cached VerificationTier for an account without hitting the
   * provider.  Returns null when the cache entry is absent or expired.
   *
   * Used by verificationGate middleware for lightweight tier checks on
   * repeat payments within the TTL window.
   */
  async getCachedTier(stellarAccount: string): Promise<VerificationTier | null> {
    const result = await this.getCached(stellarAccount);
    return result ? result.tier : null;
  }

  /**
   * Evict the cached result for an account (e.g. after a manual re-verify).
   */
  async invalidate(stellarAccount: string): Promise<void> {
    await this.redis.del(cacheKey(stellarAccount));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async getCached(stellarAccount: string): Promise<BvnLookupResult | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(cacheKey(stellarAccount));
    } catch (err) {
      // Redis unavailability must not block payment flow — treat as cache miss.
      console.error(
        `[kyc] Redis GET failed for ${stellarAccount}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }

    if (raw === null) return null;

    try {
      return JSON.parse(raw) as BvnLookupResult;
    } catch {
      // Corrupt cache entry — evict and treat as miss.
      await this.invalidate(stellarAccount).catch(() => undefined);
      return null;
    }
  }

  private async writeCache(
    stellarAccount: string,
    result: BvnLookupResult
  ): Promise<void> {
    await this.redis.set(
      cacheKey(stellarAccount),
      JSON.stringify(result),
      "EX",
      this.ttlSeconds
    );
  }

  /**
   * Append a kyc_verification_attempt event to the audit trail.
   * Uses the stellarAccount as the escrowId key so the event is
   * queryable per-account in the event store.
   */
  private appendAuditEvent(
    stellarAccount: string,
    outcome: KycOutcome,
    providerReference: string | null
  ): void {
    try {
      escrowEventStore.append(stellarAccount, {
        type: "kyc_verification_attempt",
        // state/corridor/amountUsdc are required by EscrowEvent but not
        // meaningful for KYC events — use sentinel values.
        state: "Funded" as EscrowState,
        corridor: "",
        amountUsdc: "",
        actor: stellarAccount,
        kycOutcome: outcome,
        kycProviderReference: providerReference,
      });
    } catch (err) {
      // Audit trail failure must never block the verification response.
      console.error(
        `[kyc] Failed to append audit event for ${stellarAccount}: ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Factory — builds a service instance from env vars
// ---------------------------------------------------------------------------

/**
 * Build a BvnVerificationService wired to the Smile Identity provider
 * (recommended) or NIBSS fallback based on which env vars are present.
 *
 * Returns null when neither provider is configured — callers should treat
 * this as KYC being disabled and skip the verification gate.
 */
export function createBvnVerificationService(
  redis: RedisClient
): BvnVerificationService | null {
  if (process.env.SMILE_IDENTITY_API_KEY && process.env.SMILE_IDENTITY_PARTNER_ID) {
    const { SmileIdentityProvider } = require("./providers/smileIdentity");
    return new BvnVerificationService(new SmileIdentityProvider(), redis);
  }

  if (process.env.NIBSS_CLIENT_ID && process.env.NIBSS_CLIENT_SECRET) {
    const { NibssProvider } = require("./providers/nibss");
    return new BvnVerificationService(new NibssProvider(), redis);
  }

  return null;
}

// Re-export error types so callers only need to import from this module.
export { ProviderError } from "./errors";
export { VerificationPendingError } from "./errors";
export type { BvnLookupResult, VerificationTier } from "./providers/types";
