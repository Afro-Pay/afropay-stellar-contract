/**
 * Shared types for the BVN verification provider abstraction layer (issue #19).
 *
 * All provider adapters implement the BvnProvider interface so that
 * BvnVerificationService is decoupled from any specific vendor.
 */

// ---------------------------------------------------------------------------
// Verification tier
// ---------------------------------------------------------------------------

/** Maps to the CHECK constraint on users.verification_tier in migration 003. */
export type VerificationTier = "none" | "basic" | "enhanced";

// ---------------------------------------------------------------------------
// Provider result
// ---------------------------------------------------------------------------

export interface BvnLookupResult {
  /** Resolved verification tier for the BVN / account pair. */
  tier: VerificationTier;
  /** ISO-8601 timestamp from the provider's response. */
  verifiedAt: string;
  /** Provider-assigned transaction / reference ID for audit trail. */
  providerReference: string;
  /** Raw result code from the provider — stored for debugging only. */
  providerResultCode: string;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * Contract every BVN verification adapter must satisfy.
 *
 * Implementations must:
 *  - Read all credentials exclusively from environment variables.
 *  - Throw ProviderError (from errors.ts) on any non-recoverable failure.
 *  - Never log or propagate raw BVN values.
 */
export interface BvnProvider {
  /**
   * Verify a BVN against the provider's identity database.
   *
   * @param bvn             The 11-digit Nigerian Bank Verification Number.
   * @param stellarAccount  The G… account initiating the payment (for audit).
   * @returns               Resolved BvnLookupResult on success.
   * @throws ProviderError  On provider API errors (4xx / 5xx / network failure).
   */
  verify(bvn: string, stellarAccount: string): Promise<BvnLookupResult>;
}
