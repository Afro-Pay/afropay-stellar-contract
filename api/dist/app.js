"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildApp = buildApp;
const express_1 = __importDefault(require("express"));
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const config_1 = require("./config");
const sep10_1 = __importDefault(require("./routes/sep10"));
const sep12_1 = __importDefault(require("./routes/sep12"));
const sep31_1 = __importDefault(require("./routes/sep31"));
const escrow_1 = __importDefault(require("./routes/escrow"));
const content_1 = __importDefault(require("./routes/content"));
const metrics_1 = require("./middleware/metrics");
const path_1 = __importDefault(require("path"));
// Read package version once at startup
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require(path_1.default.join(__dirname, "package.json"));
function mountPath(url) {
    return url.pathname.replace(/\/$/, "") || "/";
}
function buildApp() {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use(express_1.default.urlencoded({ extended: true }));
    // ------------------------------------------------------------------
    // Prometheus metrics — must be first so every route is timed
    // ------------------------------------------------------------------
    app.use(metrics_1.metricsMiddleware);
    app.get("/metrics", metrics_1.metricsEndpoint);
    // SEP-1: every response is CORS-enabled so wallets/anchors can call from browsers.
    app.use((_req, res, next) => {
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.set("Access-Control-Allow-Methods", "GET, PUT, POST, PATCH, DELETE, OPTIONS");
        next();
    });
    app.options(/.*/, (_req, res) => void res.status(204).end());
    // SEP-1: stellar.toml served as text/plain at the well-known path.
    app.get("/.well-known/stellar.toml", (_req, res) => {
        res.type("text/plain").send(config_1.config.tomlDocument);
    });
    // ------------------------------------------------------------------
    // Structured health endpoint (Issue #32 acceptance criterion)
    // ------------------------------------------------------------------
    app.get("/health", async (_req, res) => {
        let horizonConnected = false;
        let horizonLatencyMs = null;
        try {
            const horizon = new stellar_sdk_1.Horizon.Server(config_1.config.horizonUrl, { allowHttp: true });
            const start = Date.now();
            await horizon.fetchBaseFee();
            horizonLatencyMs = Date.now() - start;
            horizonConnected = true;
        }
        catch {
            horizonConnected = false;
        }
        const body = {
            status: horizonConnected ? "ok" : "degraded",
            service: "afropay-anchor-api",
            version,
            horizon: {
                url: config_1.config.horizonUrl,
                connected: horizonConnected,
                latency_ms: horizonLatencyMs,
            },
            timestamp: new Date().toISOString(),
        };
        res.status(horizonConnected ? 200 : 503).json(body);
    });
    // Endpoint mount points are resolved from stellar.toml, never hardcoded.
    app.use(mountPath(config_1.config.webAuthEndpoint), sep10_1.default);
    app.use(mountPath(config_1.config.kycServer), sep12_1.default);
    app.use(mountPath(config_1.config.directPaymentServer), sep31_1.default);
    // Escrow routes (Issue #7)
    app.use("/api/v1/escrow", escrow_1.default);
    // Content delivery routes
    app.use("/api/v1/tiers", content_1.default);
    return app;
}
//# sourceMappingURL=app.js.map