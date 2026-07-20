/**
 * Express middleware that:
 *  1. Records HTTP request duration and count for every route.
 *  2. Exposes a GET /metrics endpoint that Prometheus scrapes.
 *
 * Mount this middleware BEFORE your route handlers:
 *
 *   import { metricsMiddleware, metricsEndpoint } from './middleware/metrics';
 *   app.use(metricsMiddleware);
 *   app.get('/metrics', metricsEndpoint);
 */

import { NextFunction, Request, Response, RequestHandler } from "express";
import {
  registry,
  httpRequestDurationSeconds,
  httpRequestsTotal,
} from "../services/metrics";

/**
 * Normalise dynamic path segments so `/escrow/abc-123/release` becomes
 * `/escrow/:id/release` in the label, keeping cardinality bounded.
 */
function normalisePath(path: string): string {
  return path
    // UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    // Stellar account IDs (G…, M…)
    .replace(/\b[GM][A-Z2-7]{54,}\b/g, ":account")
    // Pure numeric IDs
    .replace(/\/\d+/g, "/:id");
}

/**
 * Per-request timing middleware.  Attach before routes.
 */
export const metricsMiddleware: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const durationSec = durationMs / 1000;
    const route = normalisePath(req.path);
    const method = req.method;
    const statusCode = String(res.statusCode);

    httpRequestDurationSeconds.observe({ method, route, status_code: statusCode }, durationSec);
    httpRequestsTotal.inc({ method, route, status_code: statusCode });
  });

  next();
};

/**
 * Express route handler that serves the Prometheus text exposition format.
 * Register it as:  app.get('/metrics', metricsEndpoint)
 */
export const metricsEndpoint: RequestHandler = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    const metrics = await registry.metrics();
    res.set("Content-Type", registry.contentType);
    res.end(metrics);
  } catch (err) {
    res.status(500).json({ error: "failed to collect metrics" });
  }
};
