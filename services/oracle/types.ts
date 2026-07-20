/**
 * types.ts
 *
 * Shared domain types for the FX rate oracle aggregator.
 * Every provider returns a `ProviderResult`; the aggregator merges them into
 * an `AggregatedRate`.  Callers consume `RateQuote`.
 */

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

/**
 * A single exchange-rate observation from one data source.
 */
export interface RateQuote {
  /** e.g. "USD/NGN" */
  pair: string;
  /** Mid-market exchange rate (units of quote currency per unit of base) */
  rate: number;
  /** Unix-millisecond timestamp when this rate was observed by the provider */
  fetchedAt: number;
  /** Name of the provider that produced this quote, e.g. "flutterwave" */
  provider: string;
}

/**
 * The result of one provider's fetch attempt.
 * Either a successful quote or an error description.
 */
export type ProviderResult =
  | { ok: true; quote: RateQuote }
  | { ok: false; provider: string; error: string };

/**
 * The aggregated output from the median-aggregation algorithm.
 *
 * - `rate`           — median of the valid (non-outlier) provider rates
 * - `sources`        — providers whose quotes contributed to the median
 * - `excludedSources`— providers whose quotes were rejected as outliers
 * - `fetchedAt`      — minimum fetchedAt across contributing sources
 *                      (the "freshest" window: if any source is stale,
 *                      `freshness.isStale` is true)
 */
export interface AggregatedRate {
  pair: string;
  rate: number;
  sources: string[];
  excludedSources: OutlierRecord[];
  fetchedAt: number;
  /** True when the oldest contributing quote exceeds the staleness threshold */
  isStale: boolean;
}

/**
 * Record attached to an excluded outlier for structured logging.
 */
export interface OutlierRecord {
  provider: string;
  reportedRate: number;
  medianRate: number;
  /** Absolute deviation as a fraction of the median, e.g. 0.031 = 3.1% */
  deviationFraction: number;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/** All concrete providers must conform to this contract. */
export interface RateProvider {
  readonly name: string;
  fetchRate(pair: string, signal?: AbortSignal): Promise<ProviderResult>;
}

// ---------------------------------------------------------------------------
// Logger interface (structured JSON logs)
// ---------------------------------------------------------------------------

export interface LogPayload {
  level: "info" | "warn" | "error";
  event: string;
  [key: string]: unknown;
}

export type Logger = (payload: LogPayload) => void;

// ---------------------------------------------------------------------------
// Aggregator configuration
// ---------------------------------------------------------------------------

export interface AggregatorConfig {
  /**
   * Maximum allowed deviation from the computed median before a quote is
   * treated as an outlier and excluded.  Default: 0.02 (2 %).
   */
  outlierThresholdFraction?: number;
  /**
   * Maximum age (ms) of the oldest contributing quote before the aggregated
   * rate is considered stale.  Default: 60_000 (60 s).
   */
  stalenessThresholdMs?: number;
  /**
   * Per-provider HTTP request timeout in milliseconds.  Default: 5_000 (5 s).
   */
  fetchTimeoutMs?: number;
}
