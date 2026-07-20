/**
 * providers/stellarDex.ts
 *
 * Derives an exchange rate from the Stellar DEX order-book via Horizon.
 * Uses a time-weighted average price (TWAP) approach by querying the
 * order-book mid-price.
 *
 * Endpoint:
 *   GET https://horizon.stellar.org/order_book
 *     ?selling_asset_type=credit_alphanum4
 *     &selling_asset_code={base}
 *     &selling_asset_issuer={baseIssuer}
 *     &buying_asset_type=credit_alphanum4
 *     &buying_asset_code={quote}
 *     &buying_asset_issuer={quoteIssuer}
 *
 * For the USD/NGN corridor AfroPay uses USDC (Circle) and NGNC (Cowrie) on Stellar.
 *
 * The mid-price is computed as the average of the best bid and best ask.
 */

import { ProviderResult, RateProvider } from "../types";

export const HORIZON_BASE_URL = "https://horizon.stellar.org";

/** Stellar asset descriptor */
export interface StellarAsset {
  code: string;
  issuer: string;
}

/** Known asset map keyed by currency code */
export const STELLAR_ASSETS: Record<string, StellarAsset> = {
  USDC: {
    code: "USDC",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  },
  NGNC: {
    code: "NGNC",
    issuer: "GAWODAROMJ33V5YDFY3AFYYM64GWHBMEZTMK6JKZVSQ86ZJIOKGQNOL",
  },
};

/**
 * Horizon order-book response (relevant fields only).
 */
interface HorizonOrderBookResponse {
  bids: Array<{ price: string; amount: string }>;
  asks: Array<{ price: string; amount: string }>;
}

/**
 * Maps a currency pair to Stellar asset codes used on the DEX.
 * Returns null if the pair is not supported.
 */
function pairToStellarAssets(
  pair: string
): { selling: StellarAsset; buying: StellarAsset } | null {
  const [base, quote] = pair.split("/");
  if (!base || !quote) return null;

  // USD → USDC, NGN → NGNC
  const sellingCode = base === "USD" ? "USDC" : base;
  const buyingCode = quote === "NGN" ? "NGNC" : quote;

  const selling = STELLAR_ASSETS[sellingCode];
  const buying = STELLAR_ASSETS[buyingCode];

  if (!selling || !buying) return null;
  return { selling, buying };
}

export class StellarDexProvider implements RateProvider {
  readonly name = "stellarDex";

  constructor(private readonly horizonBaseUrl: string = HORIZON_BASE_URL) {}

  async fetchRate(pair: string, signal?: AbortSignal): Promise<ProviderResult> {
    const assets = pairToStellarAssets(pair);
    if (!assets) {
      return {
        ok: false,
        provider: this.name,
        error: `Pair ${pair} not supported on Stellar DEX`,
      };
    }

    const url = new URL(`${this.horizonBaseUrl}/order_book`);
    url.searchParams.set("selling_asset_type", "credit_alphanum4");
    url.searchParams.set("selling_asset_code", assets.selling.code);
    url.searchParams.set("selling_asset_issuer", assets.selling.issuer);
    url.searchParams.set("buying_asset_type", "credit_alphanum4");
    url.searchParams.set("buying_asset_code", assets.buying.code);
    url.searchParams.set("buying_asset_issuer", assets.buying.issuer);
    url.searchParams.set("limit", "1");

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
        error: `HTTP ${res.status} from Horizon`,
      };
    }

    let body: HorizonOrderBookResponse;
    try {
      body = (await res.json()) as HorizonOrderBookResponse;
    } catch {
      return {
        ok: false,
        provider: this.name,
        error: "Malformed JSON from Horizon",
      };
    }

    const bestBid = body.bids?.[0]?.price;
    const bestAsk = body.asks?.[0]?.price;

    if (!bestBid || !bestAsk) {
      return {
        ok: false,
        provider: this.name,
        error: "Empty order book — no bids or asks",
      };
    }

    const bid = parseFloat(bestBid);
    const ask = parseFloat(bestAsk);

    if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) {
      return {
        ok: false,
        provider: this.name,
        error: `Non-numeric prices: bid=${bestBid} ask=${bestAsk}`,
      };
    }

    // Mid-price as the DEX TWAP proxy
    const midPrice = (bid + ask) / 2;

    return {
      ok: true,
      quote: {
        pair,
        rate: midPrice,
        fetchedAt: Date.now(),
        provider: this.name,
      },
    };
  }
}
