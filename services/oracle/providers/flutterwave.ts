/**
 * providers/flutterwave.ts
 *
 * Fetches exchange rates from the Flutterwave FX API.
 *
 * Endpoint:
 *   GET https://api.flutterwave.com/v3/transfers/rates
 *     ?amount=1&destination_currency={quoteCurrency}&source_currency={baseCurrency}
 *
 * The response shape we care about:
 *   {
 *     "status": "success",
 *     "data": {
 *       "rate": 1550.5
 *     }
 *   }
 */

import { ProviderResult, RateProvider } from "../types";

// Base URL is a constant so tests can override it via MSW without touching
// implementation code.
export const FLUTTERWAVE_BASE_URL = "https://api.flutterwave.com";

/**
 * Wire shape returned by the Flutterwave rates endpoint.
 * Any field not listed here is ignored.
 */
interface FlutterwaveRatesResponse {
  status: string;
  data: {
    rate: number;
  };
}

export class FlutterwaveProvider implements RateProvider {
  readonly name = "flutterwave";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = FLUTTERWAVE_BASE_URL
  ) {}

  async fetchRate(pair: string, signal?: AbortSignal): Promise<ProviderResult> {
    const [base, quote] = pair.split("/");
    if (!base || !quote) {
      return { ok: false, provider: this.name, error: `Invalid pair: ${pair}` };
    }

    const url = new URL(`${this.baseUrl}/v3/transfers/rates`);
    url.searchParams.set("amount", "1");
    url.searchParams.set("source_currency", base);
    url.searchParams.set("destination_currency", quote);

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, provider: this.name, error: `Network error: ${msg}` };
    }

    if (!res.ok) {
      return {
        ok: false,
        provider: this.name,
        error: `HTTP ${res.status} from Flutterwave`,
      };
    }

    let body: FlutterwaveRatesResponse;
    try {
      body = (await res.json()) as FlutterwaveRatesResponse;
    } catch {
      return {
        ok: false,
        provider: this.name,
        error: "Malformed JSON from Flutterwave",
      };
    }

    if (body.status !== "success" || typeof body.data?.rate !== "number") {
      return {
        ok: false,
        provider: this.name,
        error: `Unexpected response shape: status=${body.status}`,
      };
    }

    return {
      ok: true,
      quote: {
        pair,
        rate: body.data.rate,
        fetchedAt: Date.now(),
        provider: this.name,
      },
    };
  }
}
