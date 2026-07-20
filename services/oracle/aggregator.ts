/**
 * aggregator.ts
 *
 * Median-aggregation engine for FX rate quotes.
 *
 * Algorithm:
 *   1. Fan out fetch requests to all registered providers concurrently.
 *   2. Collect successful quotes; log and discard failed provider results.
 *   3. Compute the median of the collected rates.
 *   4. Re-run outlier rejection: exclude any quote whose absolute deviation
 *      from the median exceeds `outlierThresholdFraction` (default 2 %).
 *      Emit a structured warning log for each rejected outlier that includes
 *      provider name, reported rate, median, and deviation %.
 *   5. Recompute the median on the surviving quotes.
 *   6. Check staleness: if the oldest surviving quote was fetched more than
 *      `stalenessThresholdMs` ago, mark the result as stale (callers may
 *      throw StaleRateError).
 *   7. Return an AggregatedRate or throw NoRateAvailableError if no valid
 *      quotes survived.
 *
 * Design decisions:
 *   - Provider fetches are raced with a per-request AbortSignal so a slow
 *     provider does not block the entire aggregation cycle.
 *   - Two-pass outlier rejection (compute median → reject outliers → recompute)
 *     is stable when ≤ floor((N-1)/2) providers are compromised.
 *   - Median of N numbers: if N is even, returns the lower median to avoid
 *     bias toward the higher of two middle values (conservative for financial
 *     calculations — we never want to over-estimate the rate).
 */

import { NoRateAvailableError, StaleRateError } from "./errors";
import {
  AggregatedRate,
  AggregatorConfig,
  Logger,
  OutlierRecord,
  ProviderResult,
  RateProvider,
} from "./types";

const DEFAULT_OUTLIER_THRESHOLD = 0.02; // 2 %
const DEFAULT_STALENESS_MS = 60_000;    // 60 s
const DEFAULT_FETCH_TIMEOUT_MS = 5_000; // 5 s

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns the lower-median of a sorted array of numbers.
 * Precondition: arr.length > 0 (callers must ensure this).
 */
export function lowerMedian(sorted: number[]): number {
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted[mid]!;
}

/** Sort numerically ascending (does not mutate). */
function sortedRates(rates: number[]): number[] {
  return [...rates].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Aggregator class
// ---------------------------------------------------------------------------

export class RateAggregator {
  private readonly outlierThreshold: number;
  private readonly stalenessThresholdMs: number;
  private readonly fetchTimeoutMs: number;

  constructor(
    private readonly providers: RateProvider[],
    private readonly logger: Logger,
    config: AggregatorConfig = {}
  ) {
    this.outlierThreshold =
      config.outlierThresholdFraction ?? DEFAULT_OUTLIER_THRESHOLD;
    this.stalenessThresholdMs =
      config.stalenessThresholdMs ?? DEFAULT_STALENESS_MS;
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  /**
   * Fetch rates from all providers and return the aggregated result.
   *
   * @throws {NoRateAvailableError} if no valid quotes survive aggregation.
   */
  async aggregate(pair: string): Promise<AggregatedRate> {
    // Fan out with per-provider timeout
    const results = await this.fetchAll(pair);

    // Partition into successes and failures
    const providerErrors: Record<string, string> = {};
    const quotes = results.flatMap((r: ProviderResult) => {
      if (r.ok) return [r.quote];
      providerErrors[r.provider] = r.error;
      this.logger({
        level: "warn",
        event: "provider_fetch_failed",
        provider: r.provider,
        pair,
        error: r.error,
      });
      return [];
    });

    if (quotes.length === 0) {
      throw new NoRateAvailableError(pair, providerErrors);
    }

    // First-pass median
    const rates = quotes.map((q) => q.rate);
    const firstMedian = lowerMedian(sortedRates(rates));

    // Outlier rejection
    const kept = quotes.filter((q) => {
      const deviationFraction = Math.abs(q.rate - firstMedian) / firstMedian;
      if (deviationFraction > this.outlierThreshold) {
        const record: OutlierRecord = {
          provider: q.provider,
          reportedRate: q.rate,
          medianRate: firstMedian,
          deviationFraction,
        };
        this.logger({
          level: "warn",
          event: "outlier_rejected",
          provider: q.provider,
          pair,
          reportedRate: q.rate,
          medianRate: firstMedian,
          deviationPct: (deviationFraction * 100).toFixed(2),
        });
        return false;
      }
      return true;
    });

    const excluded: OutlierRecord[] = quotes
      .filter((q) => {
        const dev = Math.abs(q.rate - firstMedian) / firstMedian;
        return dev > this.outlierThreshold;
      })
      .map((q) => ({
        provider: q.provider,
        reportedRate: q.rate,
        medianRate: firstMedian,
        deviationFraction: Math.abs(q.rate - firstMedian) / firstMedian,
      }));

    if (kept.length === 0) {
      // All providers were outliers — treat as unavailable
      throw new NoRateAvailableError(pair, {
        ...providerErrors,
        aggregator: "All provider quotes rejected as outliers",
      });
    }

    // Second-pass median on surviving quotes
    const finalMedian = lowerMedian(sortedRates(kept.map((q) => q.rate)));

    // Staleness check: use the minimum fetchedAt (oldest quote)
    const oldestFetchedAt = Math.min(...kept.map((q) => q.fetchedAt));
    const ageMs = Date.now() - oldestFetchedAt;
    const isStale = ageMs >= this.stalenessThresholdMs;

    if (isStale) {
      this.logger({
        level: "warn",
        event: "rate_stale",
        pair,
        ageMs,
        thresholdMs: this.stalenessThresholdMs,
        oldestFetchedAt: new Date(oldestFetchedAt).toISOString(),
      });
    }

    const aggregated: AggregatedRate = {
      pair,
      rate: finalMedian,
      sources: kept.map((q) => q.provider),
      excludedSources: excluded,
      fetchedAt: oldestFetchedAt,
      isStale,
    };

    this.logger({
      level: "info",
      event: "rate_aggregated",
      pair,
      rate: finalMedian,
      sources: aggregated.sources,
      excludedCount: excluded.length,
      isStale,
    });

    return aggregated;
  }

  /**
   * Same as `aggregate` but additionally throws `StaleRateError` when the
   * result is stale, rather than just marking the flag.
   *
   * @throws {StaleRateError}
   * @throws {NoRateAvailableError}
   */
  async aggregateStrict(pair: string): Promise<AggregatedRate> {
    const result = await this.aggregate(pair);
    if (result.isStale) {
      const ageMs = Date.now() - result.fetchedAt;
      throw new StaleRateError(pair, result.fetchedAt, ageMs);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async fetchAll(pair: string): Promise<ProviderResult[]> {
    const settled = await Promise.allSettled(
      this.providers.map((p) => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          this.fetchTimeoutMs
        );
        return p
          .fetchRate(pair, controller.signal)
          .catch((err: unknown): ProviderResult => {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, provider: p.name, error: msg };
          })
          .finally(() => clearTimeout(timer));
      })
    );

    return settled.map((s, i): ProviderResult => {
      if (s.status === "fulfilled") return s.value;
      const provider = this.providers[i]!.name;
      const error =
        s.reason instanceof Error ? s.reason.message : String(s.reason);
      return { ok: false, provider, error };
    });
  }
}
