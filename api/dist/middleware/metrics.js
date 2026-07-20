"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.metricsEndpoint = exports.metricsMiddleware = void 0;
const metrics_1 = require("../services/metrics");
/**
 * Normalise dynamic path segments so `/escrow/abc-123/release` becomes
 * `/escrow/:id/release` in the label, keeping cardinality bounded.
 */
function normalisePath(path) {
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
const metricsMiddleware = (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        const durationSec = durationMs / 1000;
        const route = normalisePath(req.path);
        const method = req.method;
        const statusCode = String(res.statusCode);
        metrics_1.httpRequestDurationSeconds.observe({ method, route, status_code: statusCode }, durationSec);
        metrics_1.httpRequestsTotal.inc({ method, route, status_code: statusCode });
    });
    next();
};
exports.metricsMiddleware = metricsMiddleware;
/**
 * Express route handler that serves the Prometheus text exposition format.
 * Register it as:  app.get('/metrics', metricsEndpoint)
 */
const metricsEndpoint = async (_req, res) => {
    try {
        const metrics = await metrics_1.registry.metrics();
        res.set("Content-Type", metrics_1.registry.contentType);
        res.end(metrics);
    }
    catch (err) {
        res.status(500).json({ error: "failed to collect metrics" });
    }
};
exports.metricsEndpoint = metricsEndpoint;
//# sourceMappingURL=metrics.js.map