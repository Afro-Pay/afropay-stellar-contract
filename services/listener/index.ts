/**
 * index.ts — Horizon listener service entry point.
 *
 * Reads configuration from environment variables and starts the listener.
 * Required env vars:
 *   DATABASE_URL   — Postgres connection string
 *   HORIZON_URL    — Horizon base URL
 *   CONTRACT_ID    — Soroban escrow contract ID
 *
 * Optional:
 *   GAP_ALERT_THRESHOLD  — ledger gap size that triggers an alert (default: 50)
 *   RECONNECT_DELAY_MS   — ms between reconnect attempts (default: 5000)
 *   METRICS_PORT         — port to expose /metrics (default: 9090)
 */

import { Pool } from "pg";
import { createServer } from "http";
import { register as promRegistry } from "prom-client";
import { HorizonStreamListener } from "./horizonStream";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });

  // Expose Prometheus metrics on a lightweight HTTP server.
  const metricsPort = parseInt(process.env.METRICS_PORT ?? "9090", 10);
  const metricsServer = createServer(async (_req, res) => {
    res.writeHead(200, { "Content-Type": promRegistry.contentType });
    res.end(await promRegistry.metrics());
  });
  metricsServer.listen(metricsPort, () =>
    console.info(`[metrics] listening on :${metricsPort}`)
  );

  const listener = new HorizonStreamListener({
    horizonUrl: requireEnv("HORIZON_URL"),
    contractId: requireEnv("CONTRACT_ID"),
    pool,
    gapAlertThreshold: parseInt(process.env.GAP_ALERT_THRESHOLD ?? "50", 10),
    reconnectDelayMs: parseInt(process.env.RECONNECT_DELAY_MS ?? "5000", 10),
  });

  // Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      console.info(`[listener] received ${sig}, shutting down`);
      listener.stop();
      await pool.end();
      metricsServer.close();
      process.exit(0);
    });
  }

  await listener.start();
}

main().catch((err) => {
  console.error("[listener] fatal error", err);
  process.exit(1);
});
