/**
 * AfroPay k6 Load Profile
 * =======================
 * Purpose : Characterise steady-state throughput at 100 concurrent VUs over 10 minutes.
 * Profile : 30 s ramp-up → 100 VUs for 8.5 min → 30 s ramp-down.
 * Usage   : k6 run --env BASE_URL=http://staging.afropay.io load-tests/scenarios/load.js
 *
 * Environment variables:
 *   BASE_URL          : API base URL                (default: http://localhost:8000)
 *   LOAD_VUS          : Peak virtual user count     (default: 100)
 *   LOAD_DURATION     : Hold duration at peak VUs   (default: 8m30s)
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
const PEAK_VUS = parseInt(__ENV.LOAD_VUS || "100", 10);

export const options = {
  stages: [
    { duration: "30s", target: PEAK_VUS },     // ramp-up
    { duration: __ENV.LOAD_DURATION || "8m30s", target: PEAK_VUS },  // steady state
    { duration: "30s", target: 0 },             // ramp-down
  ],
  thresholds: {
    http_req_duration: ["p(95)<2000", "p(99)<5000"],
    http_req_failed: ["rate<0.01"],             // <1% error rate acceptable under load
    stellar_submission_latency_ms: ["p(95)<2000"],
    horizon_error_rate: ["rate<0.05"],
  },
  tags: { profile: "load" },
};

// ---------------------------------------------------------------------------
// VU scenario — weighted traffic mix reflecting real-world usage
//   60% payment initiation, 25% escrow polling, 15% rate fetch
// ---------------------------------------------------------------------------
export default function () {
  const corridor = randomCorridor();
  const roll = Math.random();

  if (roll < 0.60) {
    paymentFlow(BASE_URL, corridor, stellarSubmissionLatency, horizonErrorRate);
  } else if (roll < 0.85) {
    escrowFlow(BASE_URL, corridor);
  } else {
    ratesFetch(BASE_URL, corridor);
  }

  sleep(1);
}
