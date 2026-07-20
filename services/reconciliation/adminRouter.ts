/**
 * adminRouter.ts
 *
 * Express router that exposes the admin reconciliation endpoint.
 * Lives inside the reconciliation service so it compiles cleanly against
 * the service's own node_modules (express, pg, jsonwebtoken).
 *
 * POST /reconcile
 *   Requires a valid admin JWT (role: "admin") in the Authorization header.
 *
 *   Query parameters:
 *     ?heal=true  — apply self-heal updates for every discrepancy found
 *
 *   Response 200:
 *   {
 *     run_id, triggered_by, total_checked, total_matched,
 *     total_discrepancies, total_healed, duration_ms,
 *     discrepancies: [{ escrow_id, scenario, db_state, chain_state }]
 *   }
 *
 *   Response 409 — a run is already in progress
 *   Response 500 — reconciliation failed
 */

import { Router, Request, Response } from "express";
import { Pool } from "pg";
import { Reconciler } from "./reconciler";
import { requireAdmin } from "./middleware/adminAuth";

// ─── Factory accepting an injected Reconciler (for tests) ──────────────────

export function buildAdminRouter(reconciler: Reconciler): Router {
  const router = Router();

  // Simple in-process lock — prevents two concurrent runs within the same process
  let reconcileRunning = false;

  /**
   * POST /reconcile
   */
  router.post("/reconcile", requireAdmin, async (req: Request, res: Response) => {
    if (reconcileRunning) {
      res.status(409).json({ error: "A reconciliation run is already in progress" });
      return;
    }

    const heal = req.query["heal"] === "true";

    reconcileRunning = true;
    try {
      const result = await reconciler.runOnDemand(heal);

      res.json({
        run_id: result.runId.toString(),
        triggered_by: result.triggeredBy,
        total_checked: result.totalChecked,
        total_matched: result.totalMatched,
        total_discrepancies: result.discrepancies.length,
        total_healed: result.totalHealed,
        duration_ms: result.durationMs,
        discrepancies: result.discrepancies.map((d) => ({
          escrow_id: d.escrowId,
          scenario: d.scenario,
          db_state: d.dbState ?? null,
          chain_state: d.chainState ?? null,
        })),
      });
    } catch (err) {
      console.error("[admin] reconciliation failed", err);
      res.status(500).json({
        error: "Reconciliation failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      reconcileRunning = false;
    }
  });

  return router;
}

// ─── Convenience factory from env vars (used by index.ts / anchor api) ─────

export function buildAdminRouterFromEnv(): Router {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      (() => {
        throw new Error("DATABASE_URL is required");
      })(),
  });

  const reconciler = new Reconciler({
    pool,
    sorobanRpcUrl:
      process.env.SOROBAN_RPC_URL ??
      (() => {
        throw new Error("SOROBAN_RPC_URL is required");
      })(),
    contractId:
      process.env.CONTRACT_ID ??
      (() => {
        throw new Error("CONTRACT_ID is required");
      })(),
    networkPassphrase: process.env.NETWORK_PASSPHRASE,
  });

  return buildAdminRouter(reconciler);
}
