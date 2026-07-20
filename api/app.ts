import express, { Express } from "express";
import { Horizon } from "@stellar/stellar-sdk";
import { config } from "./config";
import sep10Router from "./routes/sep10";
import sep12Router from "./routes/sep12";
import sep31Router from "./routes/sep31";
import escrowRouter from "./routes/escrow";
import { metricsMiddleware, metricsEndpoint } from "./middleware/metrics";

import path from "path";

// Read package version once at startup
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require(path.join(__dirname, "package.json")) as { version: string };

function mountPath(url: URL): string {
  return url.pathname.replace(/\/$/, "") || "/";
}

export function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // ------------------------------------------------------------------
  // Prometheus metrics — must be first so every route is timed
  // ------------------------------------------------------------------
  app.use(metricsMiddleware);
  app.get("/metrics", metricsEndpoint);

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
    res.type("text/plain").send(config.tomlDocument);
  });

  // ------------------------------------------------------------------
  // Structured health endpoint (Issue #32 acceptance criterion)
  // ------------------------------------------------------------------
  app.get("/health", async (_req, res) => {
    let horizonConnected = false;
    let horizonLatencyMs: number | null = null;
    try {
      const horizon = new Horizon.Server(config.horizonUrl, { allowHttp: true });
      const start = Date.now();
      await horizon.fetchBaseFee();
      horizonLatencyMs = Date.now() - start;
      horizonConnected = true;
    } catch {
      horizonConnected = false;
    }

    const body = {
      status: horizonConnected ? "ok" : "degraded",
      service: "afropay-anchor-api",
      version,
      horizon: {
        url: config.horizonUrl,
        connected: horizonConnected,
        latency_ms: horizonLatencyMs,
      },
      timestamp: new Date().toISOString(),
    };

    res.status(horizonConnected ? 200 : 503).json(body);
  });

  // Endpoint mount points are resolved from stellar.toml, never hardcoded.
  app.use(mountPath(config.webAuthEndpoint), sep10Router);
  app.use(mountPath(config.kycServer), sep12Router);
  app.use(mountPath(config.directPaymentServer), sep31Router);

  // Escrow routes (Issue #7)
  app.use("/api/v1/escrow", escrowRouter);

  return app;
}
