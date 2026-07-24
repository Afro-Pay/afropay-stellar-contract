/**
 * Typed error classes for the KYC/BVN verification layer (issue #19).
 */

/**
 * Thrown when a provider returns an unexpected HTTP status or a
 * non-retryable error code.  The caller should surface this as 503.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    /** HTTP status returned by the provider, if available. */
    public readonly httpStatus?: number,
    /** Provider-specific error code, if available. */
    public readonly providerCode?: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Thrown when a verification is in-flight at the provider side and a
 * definitive result is not yet available.  The caller should retry after
 * a short delay and must not cache this as a final result.
 */
export class VerificationPendingError extends Error {
  constructor(
    public readonly providerReference: string,
    message = "Verification result is pending — retry after a short delay"
  ) {
    super(message);
    this.name = "VerificationPendingError";
  }
}
