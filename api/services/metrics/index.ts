/**
 * AfroPay shared Prometheus metrics registry.
 *
 * All services (API, relayer, oracle, Horizon listener) import their metrics
 * from this module so label names and metric names stay consistent across the
 * entire observability stack.
 *
 * Usage:
 *   import { registry, paymentSubmissionsTotal } from '../../services/metrics';
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

// ---------------------------------------------------------------------------
// Shared registry — never use the global default registry so tests can reset
// ---------------------------------------------------------------------------
export const registry = new Registry();

// Collect Node.js process and GC metrics into the shared registry
collectDefaultMetrics({ register: registry });

// ---------------------------------------------------------------------------
// Payment funnel
// ---------------------------------------------------------------------------

/**
 * Total payment submissions, partitioned by outcome and remittance corridor.
 * Labels:
 *   status  – "success" | "failure" | "pending"
 *   corridor – e.g. "USD_NGN", "EUR_GHS", "GBP_KES", "USD_USD"
 */
export const paymentSubmissionsTotal = new Counter({
  name: "payment_submissions_total",
  help: "Total payment submission attempts labelled by status and remittance corridor",
  labelNames: ["status", "corridor"] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Escrow lifecycle
// ---------------------------------------------------------------------------

/**
 * Time (in seconds) an escrow spends in each state before transitioning.
 * Labels:
 *   state – "Funded" | "Released" | "Refundable" | "Refunded" | "Cancelled"
 */
export const escrowStateDurationSeconds = new Histogram({
  name: "escrow_state_duration_seconds",
  help: "Duration an escrow spends in each lifecycle state before transitioning",
  labelNames: ["state"] as const,
  buckets: [
    30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400,
  ], // 30s → 4h
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Horizon stream
// ---------------------------------------------------------------------------

/**
 * Current lag between the latest ledger closed on Horizon and the last ledger
 * the event listener processed.  High lag means the listener is behind.
 */
export const horizonStreamLagLedgers = new Gauge({
  name: "horizon_stream_lag_ledgers",
  help: "Number of ledgers the Horizon event listener is behind the chain tip",
  registers: [registry],
});

// ---------------------------------------------------------------------------
// FX / oracle freshness
// ---------------------------------------------------------------------------

/**
 * Seconds since the oracle last published a fresh rate for a given corridor.
 * Labels:
 *   corridor – same format as paymentSubmissionsTotal
 */
export const rateOracleStalenessSeconds = new Gauge({
  name: "rate_oracle_staleness_seconds",
  help: "Seconds since the rate oracle last refreshed the FX rate for a corridor",
  labelNames: ["corridor"] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// HTTP instrumentation helpers (used by api/middleware/metrics.ts)
// ---------------------------------------------------------------------------

export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});
