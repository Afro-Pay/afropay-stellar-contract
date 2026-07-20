/**
 * tests/handlers.ts
 *
 * MSW (Mock Service Worker) request handlers for the three FX rate providers.
 *
 * Usage:
 *   import { server, overrideHandlers } from "./handlers";
 *
 *   beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
 *   afterEach(() => server.resetHandlers());
 *   afterAll(() => server.close());
 *
 * Each provider has a "healthy" default handler that returns a realistic
 * response.  Tests override these using `server.use(...)` to inject specific
 * failure modes (timeouts, HTTP errors, malformed JSON, stale timestamps, etc.).
 *
 * The provider URLs must exactly match what the production providers construct:
 *   Flutterwave: https://api.flutterwave.com/v3/transfers/rates
 *   CBN:         https://www.cbn.gov.ng/api/public/rates
 *   Horizon:     https://horizon.stellar.org/order_book
 */

import { http, HttpResponse, delay } from "msw";
import { setupServer } from "msw/node";
import { STELLAR_ASSETS } from "../providers/stellarDex";

// ---------------------------------------------------------------------------
// Default ("healthy") rate values
// ---------------------------------------------------------------------------

/** Baseline USD/NGN exchange rates for each provider — intentionally close. */
export const HEALTHY_RATES = {
  flutterwave: 1_550.50,
  cbn: 1_548.00,
  stellarDex: 1_552.25,
} as const;

/** The expected median of the three healthy rates (sorted: 1548, 1550.5, 1552.25) */
export const HEALTHY_MEDIAN = 1_550.50; // lower-median of 3 = index 1

// ---------------------------------------------------------------------------
// MSW Handler factories
// - Each handler targets the exact URL + query-param pattern the provider uses
// - Default handlers respond with healthy data; tests override as needed
// ---------------------------------------------------------------------------

/**
 * Flutterwave: GET /v3/transfers/rates?source_currency=USD&destination_currency=NGN
 */
export function flutterwaveRatesHandler(overrides?: {
  status?: number;
  body?: unknown;
  delayMs?: number;
}) {
  return http.get(
    "https://api.flutterwave.com/v3/transfers/rates",
    async ({ request }) => {
      const url = new URL(request.url);
      const src = url.searchParams.get("source_currency");
      const dst = url.searchParams.get("destination_currency");

      if (overrides?.delayMs) {
        await delay(overrides.delayMs);
      }

      if (overrides?.status && overrides.status !== 200) {
        return new HttpResponse(null, { status: overrides.status });
      }

      if (overrides?.body !== undefined) {
        return HttpResponse.json(overrides.body, {
          status: overrides?.status ?? 200,
        });
      }

      return HttpResponse.json({
        status: "success",
        message: "Transfer rates fetched",
        data: {
          rate: HEALTHY_RATES.flutterwave,
          source: src ?? "USD",
          destination: dst ?? "NGN",
          fee_details: { fee: 0 },
        },
      });
    }
  );
}

/**
 * CBN: GET /api/public/rates?currency=USD
 */
export function cbnRatesHandler(overrides?: {
  status?: number;
  body?: unknown;
  delayMs?: number;
}) {
  return http.get(
    "https://www.cbn.gov.ng/api/public/rates",
    async ({ request }) => {
      const url = new URL(request.url);
      const currency = url.searchParams.get("currency") ?? "USD";

      if (overrides?.delayMs) {
        await delay(overrides.delayMs);
      }

      if (overrides?.status && overrides.status !== 200) {
        return new HttpResponse(null, { status: overrides.status });
      }

      if (overrides?.body !== undefined) {
        return HttpResponse.json(overrides.body, {
          status: overrides?.status ?? 200,
        });
      }

      return HttpResponse.json({
        success: true,
        data: [
          {
            currency: "US DOLLAR",
            code: currency.toUpperCase(),
            buyingRate: HEALTHY_RATES.cbn - 2.5,
            sellingRate: HEALTHY_RATES.cbn + 2.5,
            centralRate: HEALTHY_RATES.cbn,
          },
        ],
      });
    }
  );
}

/**
 * Horizon (Stellar DEX): GET /order_book?selling_asset_code=USDC&buying_asset_code=NGNC&...
 */
export function horizonOrderBookHandler(overrides?: {
  status?: number;
  body?: unknown;
  delayMs?: number;
}) {
  return http.get(
    "https://horizon.stellar.org/order_book",
    async ({ request }) => {
      const url = new URL(request.url);
      const sellingCode = url.searchParams.get("selling_asset_code");
      const buyingCode = url.searchParams.get("buying_asset_code");

      if (overrides?.delayMs) {
        await delay(overrides.delayMs);
      }

      if (overrides?.status && overrides.status !== 200) {
        return new HttpResponse(null, { status: overrides.status });
      }

      if (overrides?.body !== undefined) {
        return HttpResponse.json(overrides.body, {
          status: overrides?.status ?? 200,
        });
      }

      // Build a realistic order book where mid = HEALTHY_RATES.stellarDex
      const mid = HEALTHY_RATES.stellarDex;
      const spread = 0.5;

      return HttpResponse.json({
        bids: [
          {
            price: String(mid - spread),
            amount: "10000.0000000",
            price_r: { n: Math.round((mid - spread) * 10_000_000), d: 10_000_000 },
          },
        ],
        asks: [
          {
            price: String(mid + spread),
            amount: "8500.0000000",
            price_r: { n: Math.round((mid + spread) * 10_000_000), d: 10_000_000 },
          },
        ],
        selling: {
          asset_type: "credit_alphanum4",
          asset_code: sellingCode ?? STELLAR_ASSETS.USDC.code,
          asset_issuer: STELLAR_ASSETS.USDC.issuer,
        },
        buying: {
          asset_type: "credit_alphanum4",
          asset_code: buyingCode ?? STELLAR_ASSETS.NGNC.code,
          asset_issuer: STELLAR_ASSETS.NGNC.issuer,
        },
      });
    }
  );
}

// ---------------------------------------------------------------------------
// Default server — all three providers healthy
// ---------------------------------------------------------------------------

export const server = setupServer(
  flutterwaveRatesHandler(),
  cbnRatesHandler(),
  horizonOrderBookHandler()
);

// ---------------------------------------------------------------------------
// Convenience: build a full override set for a test scenario
// ---------------------------------------------------------------------------

/**
 * Override all three providers at once.  Pass `null` for a provider to leave
 * its default handler in place.
 *
 * Example: make Flutterwave return a 503 and keep others healthy:
 *   server.use(...overrideHandlers({ flutterwave: { status: 503 } }))
 */
export function overrideHandlers(opts: {
  flutterwave?: Parameters<typeof flutterwaveRatesHandler>[0] | null;
  cbn?: Parameters<typeof cbnRatesHandler>[0] | null;
  horizon?: Parameters<typeof horizonOrderBookHandler>[0] | null;
}) {
  const handlers = [];
  if (opts.flutterwave !== null && opts.flutterwave !== undefined) {
    handlers.push(flutterwaveRatesHandler(opts.flutterwave));
  }
  if (opts.cbn !== null && opts.cbn !== undefined) {
    handlers.push(cbnRatesHandler(opts.cbn));
  }
  if (opts.horizon !== null && opts.horizon !== undefined) {
    handlers.push(horizonOrderBookHandler(opts.horizon));
  }
  return handlers;
}
