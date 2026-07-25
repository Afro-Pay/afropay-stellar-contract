/**
 * NIBSS (Nigeria Inter-Bank Settlement System) BVN lookup adapter stub
 * (issue #19).
 *
 * This is a stub implementation — full NIBSS integration requires a
 * bilateral agreement and network access to the NIBSS closed network.
 * The class satisfies the BvnProvider interface so BvnVerificationService
 * can be wired to NIBSS as a fallback without any other code changes.
 *
 * Credentials are loaded exclusively from environment variables:
 *   NIBSS_CLIENT_ID      — client ID issued by NIBSS
 *   NIBSS_CLIENT_SECRET  — client secret issued by NIBSS
 *   NIBSS_BASE_URL       — optional override (defaults to NIBSS production)
 *
 * To promote this stub to a full implementation:
 *  1. Obtain NIBSS API access credentials and network access.
 *  2. Replace the body of verify() with the actual NIBSS BVN API call.
 *  3. Map NIBSS response codes to VerificationTier following the same
 *     pattern as SmileIdentityProvider.
 */

import { BvnProvider, BvnLookupResult } from "./types";
import { ProviderError } from "../errors";

export class NibssProvider implements BvnProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;

  constructor() {
    const clientId = process.env.NIBSS_CLIENT_ID;
    const clientSecret = process.env.NIBSS_CLIENT_SECRET;

    if (!clientId) {
      throw new Error("NIBSS_CLIENT_ID environment variable is required");
    }
    if (!clientSecret) {
      throw new Error("NIBSS_CLIENT_SECRET environment variable is required");
    }

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl =
      process.env.NIBSS_BASE_URL?.replace(/\/$/, "") ??
      "https://api.nibss-plc.com.ng";
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async verify(_bvn: string, _stellarAccount: string): Promise<BvnLookupResult> {
    // Stub: full NIBSS BVN API integration is pending bilateral agreement.
    // This will be replaced with a real implementation in a follow-up PR.
    throw new ProviderError(
      "NIBSS provider is not yet fully implemented. " +
      "Configure Smile Identity (SMILE_IDENTITY_API_KEY) as the primary provider.",
      501
    );
  }
}
