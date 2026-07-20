/**
 * errors.ts
 *
 * Typed error classes for the FX rate oracle aggregator.
 * Using distinct error types (not generic Error) allows callers to handle
 * each failure mode precisely with `instanceof` checks, and TypeScript strict
 * mode can enforce exhaustive handling.
 */

/**
 * Thrown when the aggregated rate was last refreshed more than the permitted
 * staleness window (default: 60 seconds).  Callers should either surface this
 * to the user or fall back to `RateService.getLastKnownRate()`.
 */
export class StaleRateError extends Error {
  /** Unix-millisecond timestamp when the stale rate was last fetched */
  public readonly lastFetchedAt: number;
  /** Age of the stale data in milliseconds */
  public readonly ageMs: number;
  /** The corridor pair this rate applies to, e.g. "USD/NGN" */
  public readonly pair: string;

  constructor(pair: string, lastFetchedAt: number, ageMs: number) {
    super(
      `Rate for ${pair} is stale: last fetched ${ageMs}ms ago ` +
        `(threshold 60000ms) at ${new Date(lastFetchedAt).toISOString()}`
    );
    this.name = "StaleRateError";
    this.pair = pair;
    this.lastFetchedAt = lastFetchedAt;
    this.ageMs = ageMs;
    // Maintain proper prototype chain for instanceof checks in transpiled code
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when no rate could be obtained from any provider and there is no
 * cached last-known rate to fall back to.  This is a hard failure: callers
 * must not proceed with any exchange rate calculation.
 */
export class NoRateAvailableError extends Error {
  /** The corridor pair for which no rate is available, e.g. "USD/NGN" */
  public readonly pair: string;
  /** Human-readable reason summary from each provider */
  public readonly providerErrors: Record<string, string>;

  constructor(pair: string, providerErrors: Record<string, string>) {
    const summary = Object.entries(providerErrors)
      .map(([p, e]) => `${p}: ${e}`)
      .join("; ");
    super(`No rate available for ${pair}. Provider errors — ${summary}`);
    this.name = "NoRateAvailableError";
    this.pair = pair;
    this.providerErrors = providerErrors;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
