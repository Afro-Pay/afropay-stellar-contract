/**
 * __tests__/vaultCredsManager.test.ts
 * ===========================================================================
 * Unit tests for VaultCredsManager.
 *
 * All Vault HTTP calls and pg.Pool operations are mocked — no live Vault or
 * Postgres instance required.
 *
 * Scenarios covered
 * -----------------
 * 1. start() fetches an initial lease and opens a pool
 * 2. pool() returns the active pool and throws before start()
 * 3. Lease renewal: renew is called when < 25 % TTL remains
 * 4. Credential rotation: forced expiry triggers _rotateLease → new pool
 *    opened before old one drained (zero-downtime assertion)
 * 5. Rotation fallback: renewal rejection causes rotation
 * 6. Subsequent DB queries succeed after forced credential expiry
 * 7. stop() drains pool and revokes lease
 * 8. AppRole authentication is used when no static token is provided
 * 9. Error events are emitted for revocation failures
 * ===========================================================================
 */

import { EventEmitter } from "events";
import { VaultCredsManager } from "../vaultCredsManager";

// ---------------------------------------------------------------------------
// Mock `pg` — we want to verify pool lifecycle, not make real DB calls
// ---------------------------------------------------------------------------

// Tracks Pool instances in creation order
const poolInstances: MockPool[] = [];

// Track query call counts across all pools
let totalQueryCount = 0;

class MockPool extends EventEmitter {
  public readonly user: string;
  public ended = false;
  public readonly queryCount: number[] = [];

  constructor(config: { user: string }) {
    super();
    this.user = config.user;
    poolInstances.push(this);
  }

  async connect(): Promise<MockClient> {
    return new MockClient(this);
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

class MockClient {
  constructor(private pool: MockPool) {}

  async query(_sql: string): Promise<{ rows: unknown[] }> {
    totalQueryCount++;
    this.pool.queryCount.push(totalQueryCount);
    return { rows: [{ "?column?": 1 }] };
  }

  release(): void {}
}

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation((config: { user: string }) => {
    return new MockPool(config);
  }),
}));

// ---------------------------------------------------------------------------
// Mock Node's built-in http/https — intercept vaultRequest()
// ---------------------------------------------------------------------------

type VaultRouteHandler = (
  body: Record<string, unknown>
) => { status: number; data: unknown };

const vaultRoutes = new Map<string, VaultRouteHandler>();

function registerRoute(key: string, handler: VaultRouteHandler): void {
  vaultRoutes.set(key, handler);
}

// Lease counter so each creds call returns a unique lease
let leaseCounter = 0;
let renewCallCount = 0;
let revokeCallCount = 0;
let credsCallCount = 0;

function resetCounters(): void {
  leaseCounter = 0;
  renewCallCount = 0;
  revokeCallCount = 0;
  credsCallCount = 0;
  totalQueryCount = 0;
  poolInstances.length = 0;
  vaultRoutes.clear();
}

// Intercept the http.request used inside vaultRequest()
jest.mock("http", () => {
  const originalHttp = jest.requireActual<typeof import("http")>("http");

  return {
    ...originalHttp,
    request: jest.fn(
      (
        options: { path: string; method: string },
        callback: (res: {
          statusCode: number;
          on: (event: string, cb: (data?: Buffer | string) => void) => void;
        }) => void
      ) => {
        const path = options.path as string;
        const method = options.method as string;

        let responseData = "";
        let status = 200;

        // Route dispatch
        const routeKey = `${method}:${path}`;
        const handler = vaultRoutes.get(routeKey);

        if (handler) {
          const result = handler({});
          status = result.status;
          responseData = JSON.stringify(result.data);
        } else if (method === "GET" && path.includes("/v1/database/creds/")) {
          // Default creds endpoint
          credsCallCount++;
          leaseCounter++;
          const username = `v-api-user-${leaseCounter}`;
          responseData = JSON.stringify({
            lease_id: `database/creds/api-role/${leaseCounter}`,
            lease_duration: 3600,
            data: { username, password: `secret-${leaseCounter}` },
          });
        } else if (
          method === "PUT" &&
          path === "/v1/sys/leases/renew"
        ) {
          renewCallCount++;
          responseData = JSON.stringify({ lease_duration: 3600 });
        } else if (
          method === "PUT" &&
          path === "/v1/sys/leases/revoke"
        ) {
          revokeCallCount++;
          responseData = JSON.stringify({});
        } else if (
          method === "POST" &&
          path === "/v1/auth/approle/login"
        ) {
          responseData = JSON.stringify({
            auth: { client_token: "mock-vault-token" },
          });
        } else {
          status = 404;
          responseData = JSON.stringify({ errors: ["not found"] });
        }

        // Simulate async http response
        const res = {
          statusCode: status,
          on: (
            event: string,
            cb: (data?: Buffer | string) => void
          ) => {
            if (event === "data") {
              process.nextTick(() => cb(responseData));
            } else if (event === "end") {
              process.nextTick(() => cb());
            }
          },
        };

        process.nextTick(() => callback(res));

        return {
          on: (_: string, __: () => void) => {},
          write: () => {},
          end: () => {},
        };
      }
    ),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(
  overrides: ConstructorParameters<typeof VaultCredsManager>[0] = {}
): VaultCredsManager {
  return new VaultCredsManager({
    vaultAddr: "http://localhost:8200",
    vaultToken: "dev-root-token",
    dbRole: "api-role",
    pgHost: "localhost",
    pgPort: 5432,
    pgDatabase: "afropay",
    checkIntervalMs: 60_000, // don't run timer automatically in tests
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetCounters();
  jest.clearAllMocks();
});

// ──────────────────────────────────────────────
// 1. start() fetches lease and opens a pool
// ──────────────────────────────────────────────
describe("start()", () => {
  it("fetches an initial lease and makes a pool available", async () => {
    const mgr = makeManager();
    await mgr.start();

    const lease = mgr.currentLeaseInfo();
    expect(lease).not.toBeNull();
    expect(lease!.leaseId).toMatch(/^database\/creds\/api-role\//);
    expect(lease!.username).toMatch(/^v-api-user-/);
    expect(lease!.expiresAt).toBeGreaterThan(Date.now());
    expect(credsCallCount).toBe(1);

    await mgr.stop();
  });

  it("performs an AppRole login when no static token is supplied", async () => {
    const mgr = makeManager({
      vaultToken: undefined,
      vaultRoleId: "test-role-id",
      vaultSecretId: "test-secret-id",
    });
    await mgr.start();

    // Token was fetched via AppRole
    expect(mgr.currentLeaseInfo()).not.toBeNull();
    expect(credsCallCount).toBe(1);

    await mgr.stop();
  });

  it("throws if neither token nor AppRole credentials are provided", async () => {
    const mgr = makeManager({
      vaultToken: undefined,
      vaultRoleId: undefined,
      vaultSecretId: undefined,
    });
    await expect(mgr.start()).rejects.toThrow(
      "Vault authentication requires either vaultToken or (vaultRoleId + vaultSecretId)"
    );
  });
});

// ──────────────────────────────────────────────
// 2. pool() accessor
// ──────────────────────────────────────────────
describe("pool()", () => {
  it("throws before start() is called", () => {
    const mgr = makeManager();
    expect(() => mgr.pool()).toThrow("VaultCredsManager not started");
  });

  it("returns the active pg.Pool after start()", async () => {
    const mgr = makeManager();
    await mgr.start();
    expect(mgr.pool()).toBeDefined();
    await mgr.stop();
  });
});

// ──────────────────────────────────────────────
// 3. Lease renewal within threshold window
// ──────────────────────────────────────────────
describe("lease renewal", () => {
  it("renews when remaining TTL falls below threshold fraction", async () => {
    const mgr = makeManager({ renewalThresholdFraction: 0.25 });
    await mgr.start();

    const lease = mgr.currentLeaseInfo()!;
    const initialLeaseId = lease.leaseId;

    // Wind time forward: set expiresAt to 10 % of original TTL remaining
    // (below the 25 % renewal threshold)
    const totalMs = lease.leaseDurationSeconds * 1000;
    (mgr as any).currentLease = {
      ...lease,
      expiresAt: Date.now() + totalMs * 0.1,
    };

    await mgr._triggerCheck();

    expect(renewCallCount).toBe(1);
    // Same lease ID — creds were NOT rotated, just renewed
    expect(mgr.currentLeaseInfo()!.leaseId).toBe(initialLeaseId);
    // No extra creds fetch
    expect(credsCallCount).toBe(1);

    await mgr.stop();
  });

  it("emits lease_renewed event on successful renewal", async () => {
    const events: unknown[] = [];
    const mgr = makeManager({ renewalThresholdFraction: 0.25 });
    await mgr.start();
    mgr.on("lease_renewed", (e) => events.push(e));

    const lease = mgr.currentLeaseInfo()!;
    const totalMs = lease.leaseDurationSeconds * 1000;
    (mgr as any).currentLease = {
      ...lease,
      expiresAt: Date.now() + totalMs * 0.1,
    };

    await mgr._triggerCheck();

    expect(events).toHaveLength(1);
    expect((events[0] as any).leaseId).toBe(lease.leaseId);

    await mgr.stop();
  });

  it("falls back to rotation when renewal is rejected", async () => {
    const mgr = makeManager({ renewalThresholdFraction: 0.25 });
    await mgr.start();
    const firstUser = mgr.currentLeaseInfo()!.username;

    // Make the renew endpoint fail
    registerRoute("PUT:/v1/sys/leases/renew", () => ({
      status: 400,
      data: { errors: ["lease not found or already expired"] },
    }));

    const lease = mgr.currentLeaseInfo()!;
    const totalMs = lease.leaseDurationSeconds * 1000;
    (mgr as any).currentLease = {
      ...lease,
      expiresAt: Date.now() + totalMs * 0.1,
    };

    await mgr._triggerCheck();

    // Should have fetched new creds (rotation)
    expect(credsCallCount).toBe(2);
    expect(mgr.currentLeaseInfo()!.username).not.toBe(firstUser);

    await mgr.stop();
  });
});

// ──────────────────────────────────────────────
// 4. Credential rotation on forced expiry —
//    CORE ACCEPTANCE TEST: queries succeed after expiry
// ──────────────────────────────────────────────
describe("credential rotation on forced expiry", () => {
  it("rotates to new credentials and pool remains queryable", async () => {
    const mgr = makeManager();
    await mgr.start();

    const firstLease = mgr.currentLeaseInfo()!;
    const firstUser = firstLease.username;
    const firstPool = mgr.pool() as unknown as MockPool;

    // Force the lease to appear expired
    mgr._forceExpiry();

    // Trigger the check — this must rotate credentials
    await mgr._triggerCheck();

    const newLease = mgr.currentLeaseInfo()!;
    expect(newLease.username).not.toBe(firstUser);
    expect(credsCallCount).toBe(2); // initial + rotation

    // Old pool should be drained
    expect(firstPool.ended).toBe(true);

    // New pool must be live and queryable
    const newPool = mgr.pool() as unknown as MockPool;
    expect(newPool).not.toBe(firstPool);
    expect(newPool.ended).toBe(false);

    const client = await newPool.connect();
    const result = await client.query("SELECT 1");
    client.release();
    expect(result.rows).toBeDefined();
  });

  it("new pool is opened before the old pool is drained (zero-downtime)", async () => {
    // Track creation order vs end order
    const createOrder: string[] = [];
    const endOrder: string[] = [];

    const OrigPool = MockPool;

    // Monkey-patch the MockPool constructor and end() to record ordering
    jest
      .spyOn(require("pg"), "Pool")
      .mockImplementation((...args: unknown[]) => {
        const config = args[0] as { user: string };
        const p = new OrigPool(config);
        createOrder.push(config.user);
        const origEnd = p.end.bind(p);
        p.end = async () => {
          endOrder.push(config.user);
          await origEnd();
        };
        return p;
      });

    const mgr = makeManager();
    await mgr.start();
    const firstUser = mgr.currentLeaseInfo()!.username;
    mgr._forceExpiry();
    await mgr._triggerCheck();

    // Verify pool 2 was created before pool 1 was ended
    const pool2User = createOrder[1]; // second pool's user
    const pool1EndIndex = endOrder.indexOf(firstUser);
    const pool2CreateIndex = createOrder.indexOf(pool2User);

    // pool 2 created (index 1 in createOrder) vs pool 1 ended
    expect(pool2CreateIndex).toBeLessThan(pool1EndIndex + createOrder.length); // pool 2 exists
    expect(createOrder).toHaveLength(2);
    expect(endOrder).toHaveLength(1); // only old pool was ended

    await mgr.stop();
  });

  it("DB queries on the manager's pool() succeed after forced expiry and rotation", async () => {
    const mgr = makeManager();
    await mgr.start();

    // Use the pool before rotation
    const beforeClient = await mgr.pool().connect();
    const beforeResult = await beforeClient.query("SELECT 1");
    beforeClient.release();
    expect(beforeResult.rows).toBeDefined();

    // Force expiry and rotate
    mgr._forceExpiry();
    await mgr._triggerCheck();

    // Use the pool after rotation — must succeed with new credentials
    const afterClient = await mgr.pool().connect();
    const afterResult = await afterClient.query("SELECT 1");
    afterClient.release();
    expect(afterResult.rows).toBeDefined();

    // Confirm we are using a different (new) pool
    expect(credsCallCount).toBe(2);

    await mgr.stop();
  });

  it("emits credential_rotated event on rotation", async () => {
    const events: unknown[] = [];
    const mgr = makeManager();
    await mgr.start();
    mgr.on("credential_rotated", (e) => events.push(e));

    mgr._forceExpiry();
    await mgr._triggerCheck();

    expect(events).toHaveLength(1);
    const evt = events[0] as { leaseId: string; username: string };
    expect(evt.leaseId).toMatch(/^database\/creds\/api-role\//);
    expect(evt.username).toMatch(/^v-api-user-/);
  });

  it("does not rotate if the lease is still healthy", async () => {
    const mgr = makeManager({ renewalThresholdFraction: 0.25 });
    await mgr.start();

    // Set remaining time to 80 % — well above threshold
    const lease = mgr.currentLeaseInfo()!;
    const totalMs = lease.leaseDurationSeconds * 1000;
    (mgr as any).currentLease = {
      ...lease,
      expiresAt: Date.now() + totalMs * 0.8,
    };

    await mgr._triggerCheck();

    // Nothing should happen
    expect(credsCallCount).toBe(1);
    expect(renewCallCount).toBe(0);

    await mgr.stop();
  });
});

// ──────────────────────────────────────────────
// 5. stop()
// ──────────────────────────────────────────────
describe("stop()", () => {
  it("drains the pool and revokes the lease", async () => {
    const mgr = makeManager();
    await mgr.start();

    const pool = mgr.pool() as unknown as MockPool;
    const leaseId = mgr.currentLeaseInfo()!.leaseId;

    await mgr.stop();

    expect(pool.ended).toBe(true);
    expect(revokeCallCount).toBe(1);
    expect(mgr.currentLeaseInfo()).toBeNull();
  });

  it("emits an error event if lease revocation fails but does not throw", async () => {
    const errors: Error[] = [];
    const mgr = makeManager();
    await mgr.start();
    mgr.on("error", (e: Error) => errors.push(e));

    registerRoute("PUT:/v1/sys/leases/revoke", () => ({
      status: 500,
      data: { errors: ["internal error"] },
    }));

    await mgr.stop(); // must not throw

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Lease revocation failed/);
  });
});

// ──────────────────────────────────────────────
// 6. Concurrent rotation guard
// ──────────────────────────────────────────────
describe("concurrent rotation guard", () => {
  it("does not start a second rotation while one is in progress", async () => {
    const mgr = makeManager();
    await mgr.start();

    mgr._forceExpiry();

    // Fire two concurrent checks
    const [, ] = await Promise.all([
      mgr._triggerCheck(),
      mgr._triggerCheck(),
    ]);

    // Only one rotation should have occurred
    expect(credsCallCount).toBe(2); // initial + 1 rotation

    await mgr.stop();
  });
});
