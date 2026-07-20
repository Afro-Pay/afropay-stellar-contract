/**
 * index.ts — Reconciliation service entry point.
 *
 * On startup:
 *   1. Runs reconciliation automatically (skipped if last run < cooldown ago).
 *   2. Exposes POST /api/v1/admin/reconcile for on-demand runs.
 *
 * Required env vars:
 *   DATABASE_URL       — Postgres connection string
 *   SOROBAN_RPC_URL    — Soroban RPC endpoint
 *   CONTRACT_ID        — Bech32 RemittanceContract ID
 *   ADMIN_JWT_SECRET   — Secret for signing/verifying admin JWTs
 *
 * Optional:
 *   NETWORK_PASSPHRASE — Stellar network passphrase (default: testnet)
 *   RECONCILE_COOLDOWN_MS — Min ms between startup runs (default: 300000)
 *   RECONCILE_CONCURRENCY — Soroban RPC parallelism (default: 50)
 *   PORT               — HTTP port (default: 8001)
 */

import express from "express";
import { Pool } from "pg";
import { Reconciler, ReconcileSkippedError } from "./reconciler";
import { buildAdminRouter } from "./adminRouter";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL") });

  const reconciler = new Reconciler({
    pool,
    sorobanRpcUrl: requireEnv("SOROBAN_RPC_URL"),
    contractId: requireEnv("CONTRACT_ID"),
    networkPassphrase: process.env.NETWORK_PASSPHRASE,
    cooldownMs: process.env.RECONCILE_COOLDOWN_MS
      ? parseInt(process.env.RECONCILE_COOLDOWN_MS, 10)
      : undefined,
    concurrency: process.env.RECONCILE_CONCURRENCY
      ? parseInt(process.env.RECONCILE_CONCURRENCY, 10)
      : undefined,
  });

  // Startup reconciliation
  try {
    console.info("[reconciler] running startup reconciliation...");
    const result = await reconciler.runOnStartup();
    console.info(
      `[reconciler] startup complete — checked=${result.totalChecked} ` +
        `matched=${result.totalMatched} discrepancies=${result.discrepancies.length} ` +
        `duration=${result.durationMs}ms`
    );
  } catch (err) {
    if (err instanceof ReconcileSkippedError) {
      console.info(`[reconciler] ${err.message}`);
    } else {
      console.error("[reconciler] startup reconciliation failed", err);
    }
  }

  // HTTP server for admin API
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", buildAdminRouter(reconciler));

  app.get("/health", (_req, res) => void res.json({ status: "ok" }));

  const port = parseInt(process.env.PORT ?? "8001", 10);
  app.listen(port, () =>
    console.info(`[reconciler] admin API listening on :${port}`)
  );

  // Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      console.info(`[reconciler] received ${sig}, shutting down`);
      await pool.end();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("[reconciler] fatal error", err);
  process.exit(1);
});
