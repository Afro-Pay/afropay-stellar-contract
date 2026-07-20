/**
 * AfroPay k6 Smoke Profile
 * ========================
 * Purpose : Quick sanity check — must pass in CI with p95 < 500 ms and 0% error rate.
 * Profile : 5 VUs, 1 minute (constant).
 * Usage   : k6 run --env BASE_URL=http://localhost:8000 load-tests/scenarios/smoke.js
 *
 * Environment variables (all optional — defaults target localhost):
 *   BASE_URL          : API base URL         (default: http://localhost:8000)
 *   SMOKE_VUS         : Virtual user count   (default: 5)
 *   SMOKE_DURATION    : Test duration        (default: 1m)
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";
import { paymentFlow } from "../lib/payment-flow.js";
import { escrowFlow } from "../lib/escrow-flow.js";
import { ratesFetch } from "../lib/rates-fetch.js";
import { randomCorridor } from "../lib/helpers.js";

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
export const stellarSubmissionLatency = new Trend("stellar_submission_latency_ms", true);
export const horizonErrorRate = new Rate("horizon_error_rate");

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || "http://localhost:8000";
const VUS = parseInt(__ENV.SMOKE_VUS || "5", 10);
const DURATION = __ENV.SMOKE_DURATION || "1m";

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    // CI gate — must pass for the pipeline to succeed
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate==0"],
    // Custom metrics
    stellar_submission_latency_ms: ["p(95)<500"],
    horizon_error_rate: ["rate==0"],
  },
  tags: { profile: "smoke" },
};

// ---------------------------------------------------------------------------
// VU scenario — round-robin across the three payment scenarios
// ---------------------------------------------------------------------------
export default function () {
  const corridor = randomCorridor();

  // Each VU cycles through all three scenario types
  const scenario = (__VU + __ITER) % 3;

  if (scenario === 0) {
    paymentFlow(BASE_URL, corridor, stellarSubmissionLatency, horizonErrorRate);
  } else if (scenario === 1) {
    escrowFlow(BASE_URL, corridor);
  } else {
    ratesFetch(BASE_URL, corridor);
  }

  sleep(0.5);
}
