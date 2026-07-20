/**
 * rateService.ts
 *
 * Last-known-rate cache wrapper around the RateAggregator.
 *
 * Responsibilities:
 *   - Call the aggregator to get a fresh rate.
 *   - On success, update the in-memory cache for the currency pair.
 *   - On NoRateAvailableError, fall back to the last-known cached rate.
 *     If there is no cached rate either, re-throw NoRateAvailableError.
 *   - On StaleRateError (from aggregateStrict), fall back to cache and
 *     include staleness metadata in the returned CachedRate.
 *   - Expose getLastKnownRate() for explicit cache lookups (used by tests
 *     and health-check endpoints).
 *
 * Thread safety: Node.js is single-threaded; no locking required.
 */

import { NoRateAvailableError } from "./errors";
import { AggregatedRate, Logger } from "./types";
import { RateAggregator } from "./aggregator";

export interface CachedRate {
  /** The aggregated rate (may be from a prior successful fetch) */
  rate: AggregatedRate;
  /** True when the returned rate is from the cache, not a fresh fetch */
  fromCache: boolean;
  /** True when the cached rate itself is marked stale */
  isStale: boolean;
}

export class RateService {
  private readonly cache = new Map<string, AggregatedRate>();

  constructor(
    private readonly aggregator: RateAggregator,
    private readonly logger: Logger
  ) {}

  /**
   * Returns the best available rate for `pair`.
   *
   * Fetch order:
   *   1. Attempt a fresh aggregation (tolerates stale — isStale flag only).
   *   2. On NoRateAvailableError, serve last-known cached rate.
   *   3. If no cache entry exists, rethrow NoRateAvailableError.
   */
  async getRate(pair: string): Promise<CachedRate> {
    try {
      const fresh = await this.aggregator.aggregate(pair);
      this.cache.set(pair, fresh);
      this.logger({
        level: "info",
        event: "rate_served",
        pair,
        rate: fresh.rate,
        fromCache: false,
        isStale: fresh.isStale,
      });
      return { rate: fresh, fromCache: false, isStale: fresh.isStale };
    } catch (err) {
      if (err instanceof NoRateAvailableError) {
        const cached = this.cache.get(pair);
        if (cached) {
          this.logger({
            level: "warn",
            event: "rate_served_from_cache",
            pair,
            cachedRate: cached.rate,
            cachedFetchedAt: new Date(cached.fetchedAt).toISOString(),
            reason: err.message,
          });
          return { rate: cached, fromCache: true, isStale: cached.isStale };
        }
        this.logger({
          level: "error",
          event: "rate_unavailable_no_cache",
          pair,
          error: err.message,
        });
        throw err;
      }
      // Unknown error — rethrow
      throw err;
    }
  }

  /**
   * Returns the last successfully aggregated rate for `pair`, or undefined
   * if no rate has ever been fetched.
   */
  getLastKnownRate(pair: string): AggregatedRate | undefined {
    return this.cache.get(pair);
  }

  /**
   * Manually seed the cache with a known-good rate.
   * Useful for warm-up / bootstrap scenarios.
   */
  seedCache(pair: string, rate: AggregatedRate): void {
    this.cache.set(pair, rate);
  }

  /** Clear the cache entirely. Primarily for test teardown. */
  clearCache(): void {
    this.cache.clear();
  }
}
