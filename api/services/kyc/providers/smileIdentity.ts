/**
 * Smile Identity Nigeria ID / BVN verification adapter (issue #19).
 *
 * Implements BvnProvider using Smile Identity's v2 ID Verification API:
 *   POST https://api.smileidentity.com/v1/id_verification
 *
 * Result code mapping:
 *   "1012" — Verified (full match)    → "enhanced"
 *   "1013" — Partial match             → "basic"
 *   "1014" — Not found                 → "none"
 *   anything else / 4xx / 5xx          → ProviderError
 *
 * Credentials are loaded exclusively from environment variables:
 *   SMILE_IDENTITY_API_KEY     — API key issued by Smile Identity
 *   SMILE_IDENTITY_PARTNER_ID  — Partner ID issued by Smile Identity
 *   SMILE_IDENTITY_BASE_URL    — optional override (defaults to production)
 */

import https from "https";
import http from "http";
import { URL } from "url";
import { BvnProvider, BvnLookupResult, VerificationTier } from "./types";
import { ProviderError, VerificationPendingError } from "../errors";

const DEFAULT_BASE_URL = "https://api.smileidentity.com";
const REQUEST_TIMEOUT_MS = 10_000;

/** Shape of the Smile Identity v1/id_verification response we care about. */
interface SmileIdResponse {
  ResultCode: string;
  ResultText: string;
  SmileJobID: string;
  timestamp?: string;
}

export class SmileIdentityProvider implements BvnProvider {
  private readonly apiKey: string;
  private readonly partnerId: string;
  private readonly baseUrl: string;

  constructor() {
    const apiKey = process.env.SMILE_IDENTITY_API_KEY;
    const partnerId = process.env.SMILE_IDENTITY_PARTNER_ID;

    if (!apiKey) {
      throw new Error(
        "SMILE_IDENTITY_API_KEY environment variable is required"
      );
    }
    if (!partnerId) {
      throw new Error(
        "SMILE_IDENTITY_PARTNER_ID environment variable is required"
      );
    }

    this.apiKey = apiKey;
    this.partnerId = partnerId;
    this.baseUrl =
      process.env.SMILE_IDENTITY_BASE_URL?.replace(/\/$/, "") ??
      DEFAULT_BASE_URL;
  }

  async verify(bvn: string, stellarAccount: string): Promise<BvnLookupResult> {
    const payload = JSON.stringify({
      partner_id: this.partnerId,
      api_key: this.apiKey,
      country: "NG",
      id_type: "BVN",
      id_number: bvn,
      // stellarAccount is included as an opaque partner_params reference
      // so Smile Identity can associate the query with an account in audit logs.
      partner_params: {
        job_id: `afropay-${stellarAccount}-${Date.now()}`,
        user_id: stellarAccount,
        job_type: 5,
      },
    });

    const smileResponse = await this.post<SmileIdResponse>(
      "/v1/id_verification",
      payload
    );

    const tier = this.mapResultCode(smileResponse.ResultCode, smileResponse.ResultText);

    return {
      tier,
      verifiedAt: smileResponse.timestamp ?? new Date().toISOString(),
      providerReference: smileResponse.SmileJobID,
      providerResultCode: smileResponse.ResultCode,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private mapResultCode(code: string, text: string): VerificationTier {
    switch (code) {
      case "1012":
        return "enhanced";
      case "1013":
        return "basic";
      case "1014":
        return "none";
      case "1511":
      case "1512":
        // Smile Identity "pending" codes — verification queued asynchronously.
        throw new VerificationPendingError(
          `smile-pending-${Date.now()}`,
          `Smile Identity verification pending: ${text}`
        );
      default:
        throw new ProviderError(
          `Smile Identity returned unexpected result code ${code}: ${text}`,
          undefined,
          code
        );
    }
  }

  /** POST JSON to a Smile Identity endpoint, returns parsed response body. */
  private post<T>(path: string, body: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(this.baseUrl + path);
      const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      const lib = isLocal ? http : https;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isLocal ? 80 : 443),
        path: parsed.pathname + (parsed.search ?? ""),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Accept: "application/json",
        },
      };

      const req = lib.request(options, (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 500) {
            reject(
              new ProviderError(
                `Smile Identity returned HTTP ${status}`,
                status
              )
            );
            return;
          }
          if (status >= 400) {
            reject(
              new ProviderError(
                `Smile Identity returned HTTP ${status}: ${raw.slice(0, 200)}`,
                status
              )
            );
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            reject(new ProviderError(`Smile Identity response was not valid JSON: ${raw.slice(0, 200)}`));
          }
        });
      });

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy();
        reject(new ProviderError("Smile Identity request timed out", 408));
      });

      req.on("error", (err) => {
        reject(new ProviderError(`Smile Identity network error: ${err.message}`));
      });

      req.write(body);
      req.end();
    });
  }
}
