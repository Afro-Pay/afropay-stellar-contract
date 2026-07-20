/**
 * providers/cbn.ts
 *
 * Fetches exchange rates from the Central Bank of Nigeria (CBN) rate API.
 *
 * Endpoint:
 *   GET https://www.cbn.gov.ng/api/public/rates?currency={baseCurrency}
 *
 * Response shape (simplified):
 *   {
 *     "success": true,
 *     "data": [
 *       {
 *         "currency": "US DOLLAR",
 *         "code": "USD",
 *         "buyingRate": 1548.00,
 *         "sellingRate": 1553.00,
 *         "centralRate": 1550.50
 *       }
 *     ]
 *   }
 *
 * The aggregator uses `centralRate` (mid-market).  The CBN API only covers
 * NGN as the quote currency; requests for other quote currencies return an
 * error result.
 */

import { ProviderResult, RateProvider } from "../types";

export const CBN_BASE_URL = "https://www.cbn.gov.ng";

interface CbnRateEntry {
  currency: string;
  code: string;
  buyingRate: number;
  sellingRate: number;
  centralRate: number;
}

interface CbnRatesResponse {
  success: boolean;
  data: CbnRateEntry[];
}

export class CbnProvider implements RateProvider {
  readonly name = "cbn";

  constructor(private readonly baseUrl: string = CBN_BASE_URL) {}

  async fetchRate(pair: string, signal?: AbortSignal): Promise<ProviderResult> {
    const [base, quote] = pair.split("/");
    if (!base || !quote) {
      return { ok: false, provider: this.name, error: `Invalid pair: ${pair}` };
    }

    // CBN only publishes NGN rates
    if (quote !== "NGN") {
      return {
        ok: false,
        provider: this.name,
        error: `CBN provider only supports NGN as quote currency; got ${quote}`,
      };
    }

    const url = new URL(`${this.baseUrl}/api/public/rates`);
    url.searchParams.set("currency", base);

    let res: Response;
    try {
      res = await fetch(url.toString(), { signal });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, provider: this.name, error: `Network error: ${msg}` };
    }

    if (!res.ok) {
      return {
        ok: false,
        provider: this.name,
        error: `HTTP ${res.status} from CBN`,
      };
    }

    let body: CbnRatesResponse;
    try {
      body = (await res.json()) as CbnRatesResponse;
    } catch {
      return {
        ok: false,
        provider: this.name,
        error: "Malformed JSON from CBN",
      };
    }

    if (!body.success || !Array.isArray(body.data) || body.data.length === 0) {
      return {
        ok: false,
        provider: this.name,
        error: `CBN returned success=${body.success} with ${body.data?.length ?? 0} entries`,
      };
    }

    // Find the matching currency entry
    const entry = body.data.find(
      (e) => e.code.toUpperCase() === base.toUpperCase()
    );
    if (!entry) {
      return {
        ok: false,
        provider: this.name,
        error: `No ${base} entry in CBN response`,
      };
    }

    if (typeof entry.centralRate !== "number" || entry.centralRate <= 0) {
      return {
        ok: false,
        provider: this.name,
        error: `Invalid centralRate: ${entry.centralRate}`,
      };
    }

    return {
      ok: true,
      quote: {
        pair,
        rate: entry.centralRate,
        fetchedAt: Date.now(),
        provider: this.name,
      },
    };
  }
}
