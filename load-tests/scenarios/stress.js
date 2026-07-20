/**
 * AfroPay k6 Stress Profile
 * =========================
 * Purpose : Find the VU cliff where the first errors appear.
 *           Ramp from 100 → 500 VUs over 20 minutes, then soak at peak for 5 min.
 * Usage   : k6 run --env BASE_URL=http://staging.afropay.io load-tests/scenarios/stress.js
 *
 * Environment variables:
 *   BASE_URL           : API base URL               (default: http://localhost:8000)
 *   STRESS_START_VUS   : Starting VU count          (default: 100)
 *   STRESS_MAX_VUS     : Maximum VU count           (default: 500)
 *
 * Note: This profile is NOT a CI gate. Run it manually against staging and
 * record the cliff VU in load-tests/BASELINE.md.
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";
import { paymentFlow } from "../lib/payment-flow.js";
import { escrowFlow } from "../lib/escrow-flow.js";
import { ratesFetch } from "../lib/rates-fetch.js";
import { randomCorridor } from "../lib/helpers.js";

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
export const stellarSubmissionLatency = new Trend("stellar_submission_latency_ms", true);
export const horizonErrorRate = new Rate("horizon_error_rate");
export const dbTimeoutErrors = new Counter("db_timeout_errors_total");
export const redisTimeoutErrors = new Counter("redis_timeout_errors_total");

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------
const BASE_URL = __ENV.BASE_URL || "http://localhost:8000";
const START_VUS = parseInt(__ENV.STRESS_START_VUS || "100", 10);
const MAX_VUS = parseInt(__ENV.STRESS_MAX_VUS || "500", 10);

export const options = {
  stages: [
    // Start at baseline load
    { duration: "2m", target: START_VUS },
    // Ramp to maximum over 15 min (identify the cliff)
    { duration: "15m", target: MAX_VUS },
    // Soak at peak to identify sustained-load degradation
    { duration: "5m", target: MAX_VUS },
    // Cool down
    { duration: "2m", target: 0 },
  ],
  // Stress profile thresholds — more lenient; we want to observe degradation, not gate on it
  thresholds: {
    // Track latency but don't fail the run — we're documenting the cliff
    http_req_duration: ["p(95)<10000"],
    // Track error rate — document the VU count where this first exceeds 0
    http_req_failed: ["rate<0.5"],
    stellar_submission_latency_ms: ["p(95)<10000"],
  },
  tags: { profile: "stress" },
};

// ---------------------------------------------------------------------------
// VU scenario — payment-heavy mix (worst case for DB and Stellar)
// ---------------------------------------------------------------------------
export default function () {
  const corridor = randomCorridor();
  const roll = Math.random();

  if (roll < 0.70) {
    // Heavy payment initiation to stress DB pool and Stellar submission queue
    const result = paymentFlow(BASE_URL, corridor, stellarSubmissionLatency, horizonErrorRate);
    // Detect specific bottleneck error responses
    if (result && result.status === 503) {
      if (result.body && String(result.body).includes("db")) {
        dbTimeoutErrors.add(1);
      } else if (result.body && String(result.body).includes("redis")) {
        redisTimeoutErrors.add(1);
      }
    }
  } else if (roll < 0.90) {
    escrowFlow(BASE_URL, corridor);
  } else {
    ratesFetch(BASE_URL, corridor);
  }

  // Reduced sleep to increase RPS at high VU counts
  sleep(0.2);
}
