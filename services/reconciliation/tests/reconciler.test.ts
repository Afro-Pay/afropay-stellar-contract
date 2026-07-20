/**
 * reconciler.test.ts
 *
 * Unit tests for the Reconciler covering all four required scenarios plus the
 * startup cooldown skip, self-heal logging, and the admin API endpoint.
 *
 * All external dependencies (Postgres, Soroban RPC) are replaced with
 * in-memory mocks so tests run without any infrastructure.
 */

import { Pool, PoolClient, QueryResult } from "pg";
import { Request, Response } from "express";
import {
  Reconciler,
  ReconcileSkippedError,
  Discrepancy,
  EscrowState,
  ReconcilerConfig,
} from "../reconciler";
import { buildAdminRouter } from "../adminRouter";

// ---------------------------------------------------------------------------
// In-memory mock Postgres
// ---------------------------------------------------------------------------

interface MockEscrowRow {
  escrow_id: string;
  state: string;
}

interface MockRunRow {
  id: string;
  triggered_by: string;
  heal_requested: boolean;
  status: string;
  completed_at: Date | null;
  total_checked: number;
  total_matched: number;
  total_discrepancies: number;
  total_healed: number;
}

interface MockReportRow {
  run_id: string;
  escrow_id: string;
  scenario: string;
  db_state: string | null;
  chain_state: string | null;
  healed: boolean;
  heal_detail: string | null;
}

class MockDB {
  escrows: Map<string, MockEscrowRow> = new Map();
  runs: Map<string, MockRunRow> = new Map();
  reports: MockReportRow[] = [];
  private runSeq = 1;

  reset() {
    this.escrows.clear();
    this.runs.clear();
    this.reports = [];
    this.runSeq = 1;
  }

  seedEscrow(escrowId: string, state: string) {
    this.escrows.set(escrowId, { escrow_id: escrowId, state });
  }

  seedCompletedRun(completedAt: Date) {
    const id = String(this.runSeq++);
    this.runs.set(id, {
      id,
      triggered_by: "startup",
      heal_requested: false,
      status: "completed",
      completed_at: completedAt,
      total_checked: 0,
      total_matched: 0,
      total_discrepancies: 0,
      total_healed: 0,
    });
  }

  query(text: string, params?: unknown[]): QueryResult {
    const sql = text.trim().replace(/\s+/g, " ").toUpperCase();

    // ── Transaction control — check first to avoid false positives ──────────
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rowCount: 0, rows: [], command: sql, oid: 0, fields: [] };
    }

    // ── SELECT escrows ───────────────────────────────────────────────────────
    if (sql.startsWith("SELECT ESCROW_ID, STATE FROM ESCROWS")) {
      const rows = Array.from(this.escrows.values()).filter(
        (r) => !["Released", "Refunded", "Cancelled"].includes(r.state)
      );
      return { rowCount: rows.length, rows, command: "SELECT", oid: 0, fields: [] };
    }

    // ── SELECT last completed run ────────────────────────────────────────────
    if (sql.startsWith("SELECT COMPLETED_AT FROM RECONCILIATION_RUNS")) {
      const completed = Array.from(this.runs.values())
        .filter((r) => r.status === "completed" && r.completed_at !== null)
        .sort((a, b) => b.completed_at!.getTime() - a.completed_at!.getTime());
      if (completed.length === 0)
        return { rowCount: 0, rows: [], command: "SELECT", oid: 0, fields: [] };
      return {
        rowCount: 1,
        rows: [{ completed_at: completed[0].completed_at }],
        command: "SELECT",
        oid: 0,
        fields: [],
      };
    }

    // ── INSERT reconciliation_runs ───────────────────────────────────────────
    if (sql.startsWith("INSERT INTO RECONCILIATION_RUNS")) {
      const [triggeredBy, healRequested] = params as [string, boolean];
      const id = String(this.runSeq++);
      this.runs.set(id, {
        id,
        triggered_by: triggeredBy,
        heal_requested: healRequested,
        status: "running",
        completed_at: null,
        total_checked: 0,
        total_matched: 0,
        total_discrepancies: 0,
        total_healed: 0,
      });
      return { rowCount: 1, rows: [{ id }], command: "INSERT", oid: 0, fields: [] };
    }

    // ── UPDATE reconciliation_runs (closeRun) ────────────────────────────────
    if (sql.startsWith("UPDATE RECONCILIATION_RUNS")) {
      // params: [id, totalChecked, totalMatched, totalDiscrepancies, totalHealed, status]
      const [id, totalChecked, totalMatched, totalDiscrepancies, totalHealed, status] =
        params as [string, number, number, number, number, string];
      const run = this.runs.get(id);
      if (run) {
        run.status = status;
        run.completed_at = new Date();
        run.total_checked = totalChecked;
        run.total_matched = totalMatched;
        run.total_discrepancies = totalDiscrepancies;
        run.total_healed = totalHealed;
      }
      return { rowCount: 1, rows: [], command: "UPDATE", oid: 0, fields: [] };
    }

    // ── INSERT reconciliation_reports ────────────────────────────────────────
    if (sql.startsWith("INSERT INTO RECONCILIATION_REPORTS")) {
      const [runId, escrowId, scenario, dbState, chainState] = params as [
        string,
        string,
        string,
        string | null,
        string | null
      ];
      this.reports.push({
        run_id: runId,
        escrow_id: escrowId,
        scenario,
        db_state: dbState,
        chain_state: chainState,
        healed: false,
        heal_detail: null,
      });
      return { rowCount: 1, rows: [], command: "INSERT", oid: 0, fields: [] };
    }

    // ── UPDATE reconciliation_reports (heal detail) ──────────────────────────
    if (sql.startsWith("UPDATE RECONCILIATION_REPORTS")) {
      const [escrowId, healDetail, runId, scenario] = params as [
        string,
        string,
        string,
        string
      ];
      const report = this.reports.find(
        (r) => r.escrow_id === escrowId && r.run_id === runId && r.scenario === scenario
      );
      if (report) {
        report.healed = true;
        report.heal_detail = healDetail;
      }
      return { rowCount: 1, rows: [], command: "UPDATE", oid: 0, fields: [] };
    }

    // ── UPDATE escrows ───────────────────────────────────────────────────────
    // status_mismatch:   params = [escrowId, chainState]
    // missing_from_chain: params = [escrowId]  (literal 'ChainNotFound' in SQL)
    if (sql.startsWith("UPDATE ESCROWS")) {
      const escrowId = (params as string[])[0];
      const newState = (params as string[])[1] ?? "ChainNotFound";
      const row = this.escrows.get(escrowId);
      if (row) row.state = newState;
      return { rowCount: 1, rows: [], command: "UPDATE", oid: 0, fields: [] };
    }

    // ── INSERT escrows (missing_from_db heal stub) ───────────────────────────
    if (sql.startsWith("INSERT INTO ESCROWS")) {
      const [escrowId, state] = params as [string, string];
      if (!this.escrows.has(escrowId)) {
        this.escrows.set(escrowId, { escrow_id: escrowId, state });
      }
      return { rowCount: 1, rows: [], command: "INSERT", oid: 0, fields: [] };
    }

    throw new Error(`MockDB: unhandled SQL:\n${text}`);
  }
}

function buildMockPool(db: MockDB): Pool {
  const mockClient = {
    query: (text: string, params?: unknown[]) => Promise.resolve(db.query(text, params)),
    release: () => {},
  } as unknown as PoolClient;

  return {
    query: (text: string, params?: unknown[]) => Promise.resolve(db.query(text, params)),
    connect: () => Promise.resolve(mockClient),
    end: () => Promise.resolve(),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Test Reconciler — overrides Soroban RPC with controllable mock state
// ---------------------------------------------------------------------------

class TestReconciler extends Reconciler {
  mockChainStates: Map<string, EscrowState | null> = new Map();

  constructor(config: ReconcilerConfig) {
    super(config);
  }

  async fetchChainStates(
    escrowIds: string[]
  ): Promise<Map<string, EscrowState | null>> {
    const result = new Map<string, EscrowState | null>();
    for (const id of escrowIds) {
      // Default to null (missing_from_chain) if not explicitly seeded
      result.set(id, this.mockChainStates.has(id) ? this.mockChainStates.get(id)! : null);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONTRACT_ID = "CTEST000000000000000000000000000000000000000000000000000";

function buildTestReconciler(db: MockDB): TestReconciler {
  return new TestReconciler({
    pool: buildMockPool(db),
    sorobanRpcUrl: "http://mock-soroban",
    contractId: CONTRACT_ID,
    cooldownMs: 5 * 60 * 1000,
    concurrency: 10,
  });
}

// ---------------------------------------------------------------------------
// 1. Diff — scenario classification
// ---------------------------------------------------------------------------

describe("Reconciler.diff — scenario classification", () => {
  let db: MockDB;
  let reconciler: TestReconciler;

  beforeEach(() => {
    db = new MockDB();
    reconciler = buildTestReconciler(db);
  });

  test("no discrepancy when DB and chain states match", () => {
    const dbRows = [{ escrow_id: "esc-1", state: "Locked" }];
    const chainStates = new Map([["esc-1", "Locked" as EscrowState]]);

    const discrepancies = reconciler.diff(dbRows, chainStates);
    expect(discrepancies).toHaveLength(0);
  });

  test("no discrepancy for multiple matching escrows", () => {
    const dbRows = [
      { escrow_id: "esc-1", state: "Locked" },
      { escrow_id: "esc-2", state: "Refundable" },
    ];
    const chainStates = new Map<string, EscrowState>([
      ["esc-1", "Locked"],
      ["esc-2", "Refundable"],
    ]);
    expect(reconciler.diff(dbRows, chainStates)).toHaveLength(0);
  });

  test("reports status_mismatch when DB says Locked but chain says Released", () => {
    const dbRows = [{ escrow_id: "esc-1", state: "Locked" }];
    const chainStates = new Map([["esc-1", "Released" as EscrowState]]);

    const [d] = reconciler.diff(dbRows, chainStates);
    expect(d.scenario).toBe("status_mismatch");
    expect(d.escrowId).toBe("esc-1");
    expect(d.dbState).toBe("Locked");
    expect(d.chainState).toBe("Released");
  });

  test("reports status_mismatch when DB says Locked but chain says Refunded", () => {
    const dbRows = [{ escrow_id: "esc-2", state: "Locked" }];
    const chainStates = new Map([["esc-2", "Refunded" as EscrowState]]);

    const [d] = reconciler.diff(dbRows, chainStates);
    expect(d.scenario).toBe("status_mismatch");
    expect(d.dbState).toBe("Locked");
    expect(d.chainState).toBe("Refunded");
  });

  test("reports missing_from_db when chain knows escrow but DB does not", () => {
    const chainStates = new Map([["esc-chain-only", "Locked" as EscrowState]]);
    const [d] = reconciler.diff([], chainStates, ["esc-chain-only"]);

    expect(d.scenario).toBe("missing_from_db");
    expect(d.escrowId).toBe("esc-chain-only");
    expect(d.dbState).toBeUndefined();
    expect(d.chainState).toBe("Locked");
  });

  test("reports missing_from_chain when DB knows escrow but chain returns null", () => {
    const dbRows = [{ escrow_id: "esc-db-only", state: "Locked" }];
    const chainStates = new Map<string, EscrowState | null>([["esc-db-only", null]]);

    const [d] = reconciler.diff(dbRows, chainStates);
    expect(d.scenario).toBe("missing_from_chain");
    expect(d.escrowId).toBe("esc-db-only");
    expect(d.dbState).toBe("Locked");
    expect(d.chainState).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Startup cooldown
// ---------------------------------------------------------------------------

describe("Reconciler — startup cooldown", () => {
  let db: MockDB;
  let reconciler: TestReconciler;

  beforeEach(() => {
    db = new MockDB();
    reconciler = buildTestReconciler(db);
  });

  test("startup run proceeds when no prior run exists", async () => {
    db.seedEscrow("esc-1", "Locked");
    reconciler.mockChainStates.set("esc-1", "Locked");

    const result = await reconciler.runOnStartup();
    expect(result.triggeredBy).toBe("startup");
    expect(result.totalChecked).toBe(1);
    expect(result.totalMatched).toBe(1);
  });

  test("startup run proceeds when last run completed more than cooldown ago", async () => {
    const longAgo = new Date(Date.now() - 10 * 60 * 1000);
    db.seedCompletedRun(longAgo);
    db.seedEscrow("esc-1", "Locked");
    reconciler.mockChainStates.set("esc-1", "Locked");

    const result = await reconciler.runOnStartup();
    expect(result.triggeredBy).toBe("startup");
  });

  test("startup run is SKIPPED when last run completed less than cooldown ago", async () => {
    const recentRun = new Date(Date.now() - 2 * 60 * 1000); // 2 min ago
    db.seedCompletedRun(recentRun);

    await expect(reconciler.runOnStartup()).rejects.toThrow(ReconcileSkippedError);
  });

  test("ReconcileSkippedError carries lastRunAt and cooldownMs", async () => {
    const recentRun = new Date(Date.now() - 60 * 1000);
    db.seedCompletedRun(recentRun);

    let threw = false;
    try {
      await reconciler.runOnStartup();
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(ReconcileSkippedError);
      const e = err as ReconcileSkippedError;
      expect(e.cooldownMs).toBe(5 * 60 * 1000);
      expect(e.lastRunAt).toBeInstanceOf(Date);
    }
    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Full run — discrepancies written to DB
// ---------------------------------------------------------------------------

describe("Reconciler — full run with discrepancies written to DB", () => {
  let db: MockDB;
  let reconciler: TestReconciler;

  beforeEach(() => {
    db = new MockDB();
    reconciler = buildTestReconciler(db);
  });

  test("discrepancies are persisted to reconciliation_reports", async () => {
    db.seedEscrow("esc-mismatch", "Locked");
    db.seedEscrow("esc-ok", "Locked");
    reconciler.mockChainStates.set("esc-mismatch", "Released");
    reconciler.mockChainStates.set("esc-ok", "Locked");

    const result = await reconciler.runOnDemand(false);

    expect(result.totalChecked).toBe(2);
    expect(result.totalMatched).toBe(1);
    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0].scenario).toBe("status_mismatch");
    expect(result.discrepancies[0].escrowId).toBe("esc-mismatch");

    expect(db.reports).toHaveLength(1);
    expect(db.reports[0].scenario).toBe("status_mismatch");
    expect(db.reports[0].db_state).toBe("Locked");
    expect(db.reports[0].chain_state).toBe("Released");
  });

  test("run record is written with correct stats", async () => {
    db.seedEscrow("esc-1", "Locked");
    db.seedEscrow("esc-2", "Locked");
    reconciler.mockChainStates.set("esc-1", "Locked");
    reconciler.mockChainStates.set("esc-2", "Released"); // mismatch

    await reconciler.runOnDemand(false);

    const runs = Array.from(db.runs.values());
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].total_checked).toBe(2);
    expect(runs[0].total_matched).toBe(1);
    expect(runs[0].total_discrepancies).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Self-heal
// ---------------------------------------------------------------------------

describe("Reconciler — self-heal", () => {
  let db: MockDB;
  let reconciler: TestReconciler;
  let healLogs: string[];

  beforeEach(() => {
    db = new MockDB();
    reconciler = buildTestReconciler(db);
    healLogs = [];
    jest.spyOn(console, "info").mockImplementation((msg: string) => healLogs.push(msg));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("heal=false does not modify DB state", async () => {
    db.seedEscrow("esc-1", "Locked");
    reconciler.mockChainStates.set("esc-1", "Released");

    await reconciler.runOnDemand(false);

    expect(db.escrows.get("esc-1")?.state).toBe("Locked");
    expect(db.reports[0].healed).toBe(false);
  });

  test("heal=true updates DB state to match chain and logs the update", async () => {
    db.seedEscrow("esc-1", "Locked");
    reconciler.mockChainStates.set("esc-1", "Released");

    const result = await reconciler.runOnDemand(true);

    expect(db.escrows.get("esc-1")?.state).toBe("Released");
    expect(result.totalHealed).toBe(1);
    expect(db.reports[0].healed).toBe(true);
    expect(db.reports[0].heal_detail).toContain("esc-1");
    expect(db.reports[0].heal_detail).toContain("Locked");
    expect(db.reports[0].heal_detail).toContain("Released");
    expect(healLogs.some((l) => l.includes("esc-1") && l.includes("Released"))).toBe(true);
  });

  test("heal=true for missing_from_chain marks DB row as ChainNotFound", async () => {
    db.seedEscrow("esc-ghost", "Locked");
    reconciler.mockChainStates.set("esc-ghost", null);

    await reconciler.runOnDemand(true);

    expect(db.escrows.get("esc-ghost")?.state).toBe("ChainNotFound");
    expect(db.reports[0].healed).toBe(true);
  });

  test("heal=true for missing_from_db inserts a stub row", async () => {
    reconciler.mockChainStates.set("esc-new", "Locked");

    const chainStates = new Map<string, EscrowState | null>([["esc-new", "Locked"]]);
    const discrepancies = reconciler.diff([], chainStates, ["esc-new"]);
    expect(discrepancies[0].scenario).toBe("missing_from_db");

    // Seed run + report for the heal to update
    db.runs.set("1", {
      id: "1", triggered_by: "admin_api", heal_requested: true,
      status: "running", completed_at: null,
      total_checked: 0, total_matched: 0, total_discrepancies: 0, total_healed: 0,
    });
    db.reports.push({
      run_id: "1", escrow_id: "esc-new", scenario: "missing_from_db",
      db_state: null, chain_state: "Locked", healed: false, heal_detail: null,
    });

    await reconciler.heal(BigInt(1), discrepancies);

    expect(db.escrows.has("esc-new")).toBe(true);
    expect(db.escrows.get("esc-new")?.state).toBe("Locked");
  });

  test("every heal action is individually logged", async () => {
    db.seedEscrow("esc-a", "Locked");
    db.seedEscrow("esc-b", "Locked");
    reconciler.mockChainStates.set("esc-a", "Released");
    reconciler.mockChainStates.set("esc-b", "Refunded");

    await reconciler.runOnDemand(true);

    expect(healLogs.some((l) => l.includes("esc-a"))).toBe(true);
    expect(healLogs.some((l) => l.includes("esc-b"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Admin API route — POST /reconcile
// ---------------------------------------------------------------------------

describe("Admin API route — POST /reconcile", () => {
  let db: MockDB;
  let reconciler: TestReconciler;

  beforeEach(() => {
    db = new MockDB();
    reconciler = buildTestReconciler(db);
    process.env.ADMIN_JWT_SECRET = "test-admin-secret";
  });

  afterEach(() => {
    delete process.env.ADMIN_JWT_SECRET;
  });

  function buildMockResponse() {
    const res: Partial<Response> = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return res as Response;
  }

  function buildMockRequest(overrides: Partial<Request> = {}): Request {
    return {
      get: (_header: string) => undefined,
      query: {},
      body: {},
      ...overrides,
    } as unknown as Request;
  }

  function getLastHandler(router: ReturnType<typeof buildAdminRouter>) {
    const layer = (router as any).stack.find(
      (l: any) => l.route?.path === "/reconcile"
    );
    const handlers: any[] = layer?.route?.stack ?? [];
    return handlers[handlers.length - 1]?.handle;
  }

  test("route /reconcile is registered", () => {
    const router = buildAdminRouter(reconciler);
    const handler = getLastHandler(router);
    expect(handler).toBeDefined();
  });

  test("heal=true is parsed from query param", async () => {
    db.seedEscrow("esc-1", "Locked");
    reconciler.mockChainStates.set("esc-1", "Released");

    let healArg: boolean | undefined;
    const patchedReconciler = Object.create(reconciler) as Reconciler;
    patchedReconciler.runOnDemand = async (heal: boolean) => {
      healArg = heal;
      return reconciler.runOnDemand(heal);
    };

    const router = buildAdminRouter(patchedReconciler);
    const handler = getLastHandler(router);

    const req = buildMockRequest({ query: { heal: "true" } } as any);
    const res = buildMockResponse();
    await handler(req, res, jest.fn());

    expect(healArg).toBe(true);
  });

  test("heal=false is the default when query param is absent", async () => {
    db.seedEscrow("esc-1", "Locked");
    reconciler.mockChainStates.set("esc-1", "Locked");

    let healArg: boolean | undefined;
    const patchedReconciler = Object.create(reconciler) as Reconciler;
    patchedReconciler.runOnDemand = async (heal: boolean) => {
      healArg = heal;
      return reconciler.runOnDemand(heal);
    };

    const router = buildAdminRouter(patchedReconciler);
    const handler = getLastHandler(router);

    const req = buildMockRequest({ query: {} } as any);
    const res = buildMockResponse();
    await handler(req, res, jest.fn());

    expect(healArg).toBe(false);
  });
});
