/**
 * FX rate fetch flow — GET /api/v1/rates
 *
 * Simulates a sender checking the current exchange rate before initiating a payment.
 *
 * @param {string} baseUrl   - API base URL
 * @param {string} corridor  - Payment corridor e.g. "GBP_KES"
 */
export function ratesFetch(baseUrl, corridor) {
  const res = http.get(`${baseUrl}/api/v1/rates/${corridor}`, {
    headers: { Accept: "application/json" },
    tags: { scenario: "fx_rate_fetch", corridor },
  });

  check(res, {
    // The rates endpoint may not exist in testnet; accept 200 or 404 (no rate for corridor)
    "rates status 200 or 404": (r) => r.status === 200 || r.status === 404,
    // Must never return a 5xx
    "rates no server error": (r) => r.status < 500,
  });
}

import http from "k6/http";
import { check } from "k6";
