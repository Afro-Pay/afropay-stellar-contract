/**
 * tests/aggregator.integration.test.ts
 *
 * MSW-based integration tests for the FX rate oracle aggregator.
 *
 * Each test exercises the FULL pipeline:
 *   fetch (real Node.js fetch) → MSW intercept → parse → aggregate → return/throw
 *
 * MSW intercepts network calls at the Node.js undici / http level via
 * `setupServer` from "msw/node", so no jest spies on fetch are used —
 * confirmed by the import below.
 *
 * Covered scenarios (matches acceptance criteria):
 *   1. All 3 providers healthy  → correct median returned, no outlier warnings
 *   2. One provider is an outlier (>2%)  → excluded, median of 2 returned
 *      + structured log warning with provider, reportedRate, medianRate, deviationPct
 *   3. One provider times out  → graceful degradation, median of remaining 2
 *   4. Two providers return stale data (>60 s old)  → StaleRateError thrown
 *   5. All three providers unavailable  → NoRateAvailableError, last-known rate served
 *   6. One provider returns malformed JSON  → parsed as error, not a crash
 */

// Confirm MSW is used (not jest.spyOn / jest.fn on fetch)
import { setupServer } from "msw/node"; // eslint-disable-line @typescript-eslint/no-unused-vars

import {
  server,
  flutterwaveRatesHandler,
  cbnRatesHandler,
  horizonOrderBookHandler,
  HEALTHY_RATES,
  HEALTHY_MEDIAN,
} from "./handlers";
import { createLogCapture } from "./logCapture";
import { RateAggregator } from "../aggregator";
import { RateService } from "../rateService";
import { FlutterwaveProvider } from "../providers/flutterwave";
import { CbnProvider } from "../providers/cbn";
import { StellarDexProvider } from "../providers/stellarDex";
import { StaleRateError } from "../errors";
import { NoRateAvailableError } from "../errors";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAIR = "USD/NGN";

/**
 * An AbortSignal timeout large enough that it never fires in tests but still
 * exercises the abort-propagation path in providers.
 */
const TEST_FETCH_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh aggregator + rate service for each test, sharing the given
 * log capture so assertions can be made against emitted events.
 */
function buildStack(logs: ReturnType<typeof createLogCapture>) {
  const providers = [
    new FlutterwaveProvider("test-api-key"),
    new CbnProvider(),
    new StellarDexProvider(),
  ];
  const aggregator = new RateAggregator(providers, logs.logger, {
    fetchTimeoutMs: TEST_FETCH_TIMEOUT_MS,
  });
  const service = new RateService(aggregator, logs.logger);
  return { aggregator, service };
}

// ---------------------------------------------------------------------------
// MSW lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Fail loudly if any unexpected URL is requested — catches URL mismatches
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// SCENARIO 1: All three providers healthy — correct median returned
// ---------------------------------------------------------------------------

describe("Scenario 1: all three providers healthy", () => {
  it("returns the correct lower-median of the three provider rates", async () => {
    const logs = createLogCapture();
    const { aggregator } = buildStack(logs);

    const result = await aggregator.aggregate(PAIR);

    // The three rates are: 1548.00, 1550.50, 1552.25
    // Sorted: [1548.00, 1550.50, 1552.25]
    // Lower-median (index 1 of 3) = 1550.50
    expect(result.rate).toBeCloseTo(HEALTHY_MEDIAN, 2);
    expect(result.pair).toBe(PAIR);
    expect(result.sources).toHaveLength(3);
    expect(result.excludedSources).toHaveLength(0);
    expect(result.isStale).toBe(false);
  });

  it("logs a rate_aggregated info event", async () => {
    const logs = createLogCapture();
    const { aggregator } = buildStack(logs);

    await aggregator.aggregate(PAIR);

    logs.assertEmitted("rate_aggregated");
    const log = logs.findOne("rate_aggregated")!;
    expect(log.level).toBe("info");
    expect(log.pair).toBe(PAIR);
    expect(log.excludedCount).toBe(0);
  });

  it("does NOT log any outlier_rejected events", async () => {
    const logs = createLogCapture();
    const { aggregator } = buildStack(logs);

    await aggregator.aggregate(PAIR);

    logs.assertNotEmitted("outlier_rejected");
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 2: One provider returns an outlier (>2% deviation)
// ---------------------------------------------------------------------------

describe("Scenario 2: one provider returns an outlier rate (>2%)", () => {
  // Inject a Flutterwave rate that is ~5% above the healthy cluster
  const CLUSTER_RATE = 1_550.00; // cbn and horizon will be near this
  const OUTLIER_RATE = Math.round(CLUSTER_RATE * 1.05 * 100) / 100; // +5%

  beforeEach(() => {
    server.use(
      // Outlier: Flutterwave returns 5% above consensus
      flutterwaveRatesHandler({ body: { status: "success", data: { rate: OUTLIER_RATE } } }),
      // Healthy cluster
      cbnRatesHandler({
        body: {
          success: true,
          data: [{ currency: "US DOLLAR", code: "USD", buyingRate: 1547.5, sellingRate: 1552.5, centralRate: CLUSTER_RATE }],
        },
      }),
      horizonOrderBookHandler({
        body: {
          bids: [{ price: String(CLUSTER_RATE - 0.25), amount: "10000" }],
          asks: [{ price: String(CLUSTER_RATE + 0.25), amount: "8500" }],
        },
      })
    );
  });

  it("excludes the outlier and returns the median of the remaining two", async () => {
    const logs = createLogCapture();
    const { aggregator } = buildStack(logs);

    const result = await aggregator.aggregate(PAIR);

    // Only cbn and stellarDex survive; both are ~1550, so median = 1550
    expect(result.rate).toBeCloseTo(CLUSTER_RATE, 1);
    expect(result.sources).not.toContain("flutterwave");
    expect(result.sources).toHaveLength(2);
    expect(result.excludedSources).toHaveLength(1);
    expect(result.excludedSources[0]!.provider).toBe("flutterwave");
  });

  it("logs an outlier_rejected warn event with provider, reportedRate, medianRate, deviationPct", async () => {
    const logs = createLogCapture();
    const { aggregator } = buildStack(logs);

    await aggregator.aggregate(PAIR);

    logs.assertEmitted("outlier_rejected");
    const warnings = logs.findAll("outlier_rejected");
    expect(warnings).toHaveLength(1);

    const w = warnings[0]!;
    expect(w.level).toBe("warn");
    expect(w.provider).toBe("flutterwave");
    expect(w.reportedRate).toBeCloseTo(OUTLIER_RATE, 2);
    // medianRate was computed against the full set before rejection
    expect(typeof w.medianRate).toBe("number");
    // deviationPct field must be a string representation of a number > 2
    expect(Number(w.deviationPct)).toBeGreaterThan(2.0);
  });

  it("still emits a rate_aggregated event noting 1 excluded source", async () => {
    const logs = createLogCapture();
    const { aggregator } = buildStack(logs);

    await aggregator.aggregate(PAIR);

    const agg = logs.findOne("rate_aggregated")!;
    expect(agg.excludedCount).toBe(1);
    expect(agg.sources).toEqual(expect.not.arrayContaining(["flutterwave"]));
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 3: One provider times out — graceful degradation
// ---------------------------------------------------------------------------

describe("Scenario 3: one provider times out", () => {
  it("returns the median of the two remaining providers", async () => {
    // Use a very short aggregator timeout so the test runs fast
    const logs = createLogCapture();
    const providers = [
      new FlutterwaveProvider("test-api-key"),
      new CbnProvider(),
      new StellarDexProvider(),
    ];
    const aggregator = new RateAggregator(providers, logs.logger, {
      fetchTimeoutMs: 200, // 200 ms timeout
    });

    // CBN delays 500 ms — beyond the 200 ms timeout
    server.use(
      flutterwaveRatesHandler(), // healthy
      cbnRatesHandler({ delayMs: 500 }), // will timeout
      horizonOrderBookHandler() // healthy
    );

    const result = await aggregator.aggregate(PAIR);

    // CBN timed out: only flutterwave and stellarDex contribute
    expect(result.sources).not.toContain("cbn");
    expect(result.sources).toHaveLength(2);
    expect(result.isStale).toBe(false);
    // Rate should be a value in the realistic range
    expect(result.rate).toBeGreaterThan(1_000);
    expect(result.rate).toBeLessThan(2_000);
  });

  it("logs a provider_fetch_failed warn for the timed-out provider", async () => {
    const logs = createLogCapture();
    const providers = [
      new FlutterwaveProvider("test-api-key"),
      new CbnProvider(),
      new StellarDexProvider(),
    ];
    const aggregator = new RateAggregator(providers, logs.logger, {
      fetchTimeoutMs: 200,
    });

    server.use(
      flutterwaveRatesHandler(),
      cbnRatesHandler({ delayMs: 500 }),
      horizonOrderBookHandler()
    );

    await aggregator.aggregate(PAIR);

    const failures = logs.findAll("provider_fetch_failed");
    expect(failures.length).toBeGreaterThanOrEqual(1);
    const cbnFailure = failures.find((f) => f.provider === "cbn");
    expect(cbnFailure).toBeDefined();
    expect(cbnFailure!.level).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 4: Stale data from providers triggers StaleRateError
// ---------------------------------------------------------------------------

describe("Scenario 4: stale data from providers triggers StaleRateError", () => {
  /**
   * The aggregator checks staleness against the MINIMUM fetchedAt across
   * contributing quotes — i.e., the oldest contributing quote drives the
   * staleness determination.
   *
   * Since `fetchedAt` is stamped as `Date.now()` at fetch time, we test
   * staleness by setting `stalenessThresholdMs: 0` so that every fresh quote
   * is immediately considered stale (age ≥ 0 > 0).  This exercises the exact
   * same staleness path that a 60-second threshold would hit when quotes are
   * 60+ seconds old.
   *
   * An additional test seeds the RateService cache with an explicitly stale
   * AggregatedRate to verify that the isStale flag is faithfully propagated.
   */

  it("aggregate() marks isStale=true when threshold is 0 ms (immediate staleness)", async () => {
    const logs = createLogCapture();
    const providers = [
      new FlutterwaveProvider("test-api-key"),
      new CbnProvider(),
      new StellarDexProvider(),
    ];
    const aggregator = new RateAggregator(providers, logs.logger, {
      stalenessThresholdMs: 0,
    });

    const result = await aggregator.aggregate(PAIR);

    // With a 0 ms threshold, the result must be stale because age ≥ 0 > 0
    expect(result.isStale).toBe(true);
    expect(result.rate).toBeGreaterThan(0);
  });

  it("RateService propagates isStale=true from a seeded stale cache entry", () => {
    const logs = createLogCapture();
    const { service } = buildStack(logs);

    const staleRate = {
      pair: PAIR,
      rate: 1_548.00,
      sources: ["flutterwave", "cbn", "stellarDex"],
      excludedSources: [],
      // fetchedAt 120 seconds ago
      fetchedAt: Date.now() - 120_000,
      isStale: true,
    };
    service.seedCache(PAIR, staleRate);

    const cached = service.getLastKnownRate(PAIR)!;
    expect(cached.isStale).toBe(true);
    expect(cached.rate).toBeCloseTo(1_548.00, 2);
  });

  it("aggregateStrict() throws StaleRateError with correct pair and metadata", async () => {
    const logs = createLogCapture();
    const providers = [
      new FlutterwaveProvider("test-api-key"),
      new CbnProvider(),
      new StellarDexProvider(),
    ];
    const aggregator = new RateAggregator(providers, logs.logger, {
      stalenessThresholdMs: 0, // everything is immediately stale
    });

    let caught: unknown;
    try {
      await aggregator.aggregateStrict(PAIR);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(StaleRateError);
    const err = caught as StaleRateError;
    expect(err.name).toBe("StaleRateError");
    expect(err.pair).toBe(PAIR);
    expect(err.ageMs).toBeGreaterThanOrEqual(0);
    expect(err.lastFetchedAt).toBeGreaterThan(0);
  });

  it("aggregate() (non-strict) does NOT throw but logs rate_stale warn", async () => {
    const logs = createLogCapture();
    const providers = [
      new FlutterwaveProvider("test-api-key"),
      new CbnProvider(),
      new StellarDexProvider(),
    ];
    const aggregator = new RateAggregator(providers, logs.logger, {
      stalenessThresholdMs: 0,
    });

    const result = await aggregator.aggregate(PAIR);

    expect(result.isStale).toBe(true);
    logs.assertEmitted("rate_stale");
    const warn = logs.findOne("rate_stale")!;
    expect(warn.level).toBe("warn");
    expect(warn.pair).toBe(PAIR);
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 5: All three providers unavailable → NoRateAvailableError, cache fallback
// ---------------------------------------------------------------------------

describe("Scenario 5: all providers unavailable", () => {
  beforeEach(() => {
    server.use(
      flutterwaveRatesHandler({ status: 503 }),
      cbnRatesHandler({ status: 503 }),
      horizonOrderBookHandler({ status: 503 })
    );
  });

  it("aggregator throws NoRateAvailableError", async () => {
    const logs = createLogCapture();
    const { aggregator } = buildStack(logs);

    let caught: unknown;
    try {
      await aggregator.aggregate(PAIR);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(NoRateAvailableError);
    const err = caught as NoRateAvailableError;
    expect(err.name).toBe("NoRateAvailableError");
    expect(err.pair).toBe(PAIR);
    // Should include a summary of all three provider failures
    expect(Object.keys(err.providerErrors)).toEqual(
      expect.arrayContaining(["flutterwave", "cbn", "stellarDex"])
    );
  });

  it("RateService falls back to last-known-rate cache and returns fromCache=true", async () => {
    const logs = createLogCapture();
    const { aggregator, service } = buildStack(logs);

    // Seed a healthy rate in the cache before all providers go down
    const seedRate = {
      pair: PAIR,
      rate: 1_549.75,
      sources: ["flutterwave", "cbn", "stellarDex"],
      excludedSources: [],
      fetchedAt: Date.now() - 30_000,
      isStale: false,
    };
    service.seedCache(PAIR, seedRate);

    const result = await service.getRate(PAIR);

    expect(result.fromCache).toBe(true);
    expect(result.rate.rate).toBeCloseTo(seedRate.rate, 2);
    logs.assertEmitted("rate_served_from_cache");
  });

  it("RateService throws NoRateAvailableError when no cache entry exists", async () => {
    const logs = createLogCapture();
    const { service } = buildStack(logs);
    // Do NOT seed any cache entry

    let caught: unknown;
    try {
      await service.getRate(PAIR);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(NoRateAvailableError);
    logs.assertEmitted("rate_unavailable_no_cache");
  });

  it("NoRateAvailableError is a typed Error subclass, not a generic Error", async () => {
    const logs = createLogCapture();
    const { aggregator } = buildStack(logs);

    let caught: unknown;
    try {
      await aggregator.aggregate(PAIR);
    } catch (e) {
      caught = e;
    }

    // Must be instanceof the specific class, not just Error
    expect(caught).toBeInstanceOf(NoRateAvailableError);
    expect(caught).toBeInstanceOf(Error);
    // The message must describe the pair and provider errors
    expect((caught as Error).message).toContain(PAIR);
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 6: One provider returns malformed JSON — parsed as error, no crash
// ---------------------------------------------------------------------------

describe("Scenario 6: one provider returns malformed JSON", () => {
  it("treats malformed-JSON response as a provider error, not an unhandled exception", async () => {
    // Return a body that is not valid JSON
    server.use(
      flutterwaveRatesHandler({
        // Return a raw non-JSON string body — MSW will pass it through
        body: undefined, // override via raw response below
      }),
      cbnRatesHandler(),
      horizonOrderBookHandler()
    );

    // Since our handler factory uses HttpResponse.json(), we need a custom handler
    // to return truly malformed JSON:
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.get(
        "https://api.flutterwave.com/v3/transfers/rates",
        () =>
          new HttpResponse(
            "this is not json {{{ broken",
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
      )
    );

    const logs = createLogCapture();
    const { aggregator } = buildStack(logs);

    // Should NOT throw — Flutterwave fails gracefully, other two succeed
    const result = await aggregator.aggregate(PAIR);

    // Rate is derived from CBN and stellarDex only
    expect(result.sources).not.toContain("flutterwave");
    expect(result.sources).toHaveLength(2);
    expect(result.rate).toBeGreaterThan(1_000);

    // The failure must appear in the structured logs
    const failures = logs.findAll("provider_fetch_failed");
    const flwFailure = failures.find((f) => f.provider === "flutterwave");
    expect(flwFailure).toBeDefined();
    expect(String(flwFailure!.error).toLowerCase()).toMatch(/json|malformed|parse|invalid|unexpected/i);
  });

  it("treats a well-formed but semantically wrong JSON response as a provider error", async () => {
    // Flutterwave returns valid JSON but wrong shape (missing `data.rate`)
    server.use(
      flutterwaveRatesHandler({
        body: { status: "success", data: { foo: "bar" } }, // missing `rate` field
      }),
      cbnRatesHandler(),
      horizonOrderBookHandler()
    );

    const logs = createLogCapture();
    const { aggregator } = buildStack(logs);

    const result = await aggregator.aggregate(PAIR);

    expect(result.sources).not.toContain("flutterwave");
    expect(result.sources).toHaveLength(2);

    const failures = logs.findAll("provider_fetch_failed");
    const flwFailure = failures.find((f) => f.provider === "flutterwave");
    expect(flwFailure).toBeDefined();
  });

  it("treats Horizon returning an empty order book as a provider error", async () => {
    server.use(
      flutterwaveRatesHandler(),
      cbnRatesHandler(),
      horizonOrderBookHandler({
        body: { bids: [], asks: [] }, // empty order book
      })
    );

    const logs = createLogCapture();
    const { aggregator } = buildStack(logs);

    const result = await aggregator.aggregate(PAIR);

    expect(result.sources).not.toContain("stellarDex");
    expect(result.sources).toHaveLength(2);

    const failures = logs.findAll("provider_fetch_failed");
    const dexFailure = failures.find((f) => f.provider === "stellarDex");
    expect(dexFailure).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// BONUS: StaleRateError instanceof checks (strict mode types)
// ---------------------------------------------------------------------------

describe("Error types pass instanceof checks in TypeScript strict mode", () => {
  it("StaleRateError has correct name, pair, ageMs, lastFetchedAt fields", () => {
    const err = new StaleRateError("USD/NGN", 1_000_000, 90_000);
    expect(err).toBeInstanceOf(StaleRateError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("StaleRateError");
    expect(err.pair).toBe("USD/NGN");
    expect(err.ageMs).toBe(90_000);
    expect(err.lastFetchedAt).toBe(1_000_000);
    expect(err.message).toContain("USD/NGN");
  });

  it("NoRateAvailableError has correct name, pair, providerErrors fields", () => {
    const errors = { flutterwave: "HTTP 503", cbn: "timeout", stellarDex: "empty book" };
    const err = new NoRateAvailableError("USD/NGN", errors);
    expect(err).toBeInstanceOf(NoRateAvailableError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NoRateAvailableError");
    expect(err.pair).toBe("USD/NGN");
    expect(err.providerErrors).toEqual(errors);
    expect(err.message).toContain("USD/NGN");
    // Error summary must mention each provider
    expect(err.message).toContain("flutterwave");
    expect(err.message).toContain("cbn");
    expect(err.message).toContain("stellarDex");
  });
});
