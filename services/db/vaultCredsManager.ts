/**
 * vaultCredsManager.ts
 * ===========================================================================
 * Dynamic Postgres credential manager backed by HashiCorp Vault's database
 * secrets engine.
 *
 * Features
 * --------
 *  • Fetches a short-lived Postgres username/password lease from Vault.
 *  • Renews the lease before TTL expiry (configurable renewal window).
 *  • On renewal failure or expiry, obtains a fresh lease and reconnects the
 *    pg.Pool transparently — zero downtime for callers.
 *  • Exposes a pool() accessor that always returns a live, authenticated pool.
 *  • Emits structured events (credential_rotated, lease_renewed, error) for
 *    Prometheus / alerting integration.
 *
 * Usage
 * -----
 *  import { VaultCredsManager } from './vaultCredsManager';
 *
 *  const mgr = new VaultCredsManager({
 *    vaultAddr: process.env.VAULT_ADDR!,
 *    vaultToken: process.env.VAULT_TOKEN!,   // or use AppRole
 *    dbRole: 'api-role',
 *    pgHost: process.env.PGHOST!,
 *    pgPort: 5432,
 *    pgDatabase: process.env.PGDATABASE!,
 *  });
 *
 *  await mgr.start();
 *  const client = await mgr.pool().connect();
 *  // ... use client
 *  client.release();
 *
 *  // On shutdown:
 *  await mgr.stop();
 *
 * Environment overrides (all optional — prefer constructor params in code)
 * ------------------------------------------------------------------------
 *  VAULT_ADDR            Vault HTTP/S address  (default: http://localhost:8200)
 *  VAULT_TOKEN           Static token          (prefer AppRole in production)
 *  VAULT_ROLE_ID         AppRole role_id
 *  VAULT_SECRET_ID       AppRole secret_id
 *  VAULT_DB_ROLE         Vault DB role name    (default: api-role)
 *  PGHOST                Postgres host
 *  PGPORT                Postgres port
 *  PGDATABASE            Postgres database name
 *  PGSSL                 'true' to enable SSL  (default: false in dev)
 * ===========================================================================
 */

import { EventEmitter } from "events";
import { Pool, PoolConfig } from "pg";
import https from "https";
import http from "http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VaultCredsManagerOptions {
  /** Full Vault address, e.g. http://localhost:8200 */
  vaultAddr?: string;
  /** Static Vault token (for dev/testing). Prefer AppRole in production. */
  vaultToken?: string;
  /** AppRole role_id — used when vaultToken is absent */
  vaultRoleId?: string;
  /** AppRole secret_id — used when vaultToken is absent */
  vaultSecretId?: string;
  /** Vault database role to use, e.g. "api-role" */
  dbRole?: string;
  /** Vault database secrets mount path */
  dbMount?: string;
  /** Postgres host */
  pgHost?: string;
  /** Postgres port */
  pgPort?: number;
  /** Postgres database */
  pgDatabase?: number | string;
  /** Enable Postgres TLS */
  pgSsl?: boolean;
  /** Max connections in pool */
  pgPoolSize?: number;
  /**
   * Fraction of TTL remaining that triggers a renewal attempt.
   * Default 0.25 — renew when 25 % of TTL is left.
   */
  renewalThresholdFraction?: number;
  /**
   * How often (ms) the background timer checks lease state.
   * Default 10 000 (10 s).  Keep well below min expected TTL (1 h).
   */
  checkIntervalMs?: number;
}

export interface VaultLease {
  leaseId: string;
  username: string;
  password: string;
  /** Absolute epoch-ms at which the lease expires */
  expiresAt: number;
  /** Original TTL in seconds as returned by Vault */
  leaseDurationSeconds: number;
}

// ---------------------------------------------------------------------------
// HTTP helper (no external fetch dependency — works in any Node version)
// ---------------------------------------------------------------------------

interface VaultHttpOptions {
  method: "GET" | "POST" | "PUT";
  url: string;
  token: string;
  body?: Record<string, unknown>;
}

function vaultRequest<T = unknown>(opts: VaultHttpOptions): Promise<T> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(opts.url);
    const transport = parsedUrl.protocol === "https:" ? https : http;
    const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;

    const req = transport.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: opts.method,
        headers: {
          "X-Vault-Token": opts.token,
          "Content-Type": "application/json",
          ...(bodyStr
            ? { "Content-Length": Buffer.byteLength(bodyStr).toString() }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data) as T);
            } catch {
              resolve(data as unknown as T);
            }
          } else {
            reject(
              new Error(
                `Vault HTTP ${res.statusCode} on ${opts.method} ${opts.url}: ${data}`
              )
            );
          }
        });
      }
    );

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// VaultCredsManager
// ---------------------------------------------------------------------------

export class VaultCredsManager extends EventEmitter {
  private readonly vaultAddr: string;
  private readonly dbRole: string;
  private readonly dbMount: string;
  private readonly pgHost: string;
  private readonly pgPort: number;
  private readonly pgDatabase: string;
  private readonly pgSsl: boolean;
  private readonly pgPoolSize: number;
  private readonly renewalThresholdFraction: number;
  private readonly checkIntervalMs: number;

  private vaultToken: string;
  private readonly vaultRoleId?: string;
  private readonly vaultSecretId?: string;

  private currentLease: VaultLease | null = null;
  private currentPool: Pool | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rotating = false;

  constructor(opts: VaultCredsManagerOptions = {}) {
    super();

    this.vaultAddr =
      opts.vaultAddr ?? process.env.VAULT_ADDR ?? "http://localhost:8200";
    this.vaultToken = opts.vaultToken ?? process.env.VAULT_TOKEN ?? "";
    this.vaultRoleId =
      opts.vaultRoleId ?? process.env.VAULT_ROLE_ID ?? undefined;
    this.vaultSecretId =
      opts.vaultSecretId ?? process.env.VAULT_SECRET_ID ?? undefined;
    this.dbRole = opts.dbRole ?? process.env.VAULT_DB_ROLE ?? "api-role";
    this.dbMount = opts.dbMount ?? "database";
    this.pgHost = opts.pgHost ?? process.env.PGHOST ?? "localhost";
    this.pgPort = opts.pgPort ?? parseInt(process.env.PGPORT ?? "5432", 10);
    this.pgDatabase = String(
      opts.pgDatabase ?? process.env.PGDATABASE ?? "afropay"
    );
    this.pgSsl = opts.pgSsl ?? process.env.PGSSL === "true";
    this.pgPoolSize = opts.pgPoolSize ?? 10;
    this.renewalThresholdFraction = opts.renewalThresholdFraction ?? 0.25;
    this.checkIntervalMs = opts.checkIntervalMs ?? 10_000;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Initialise: authenticate with Vault, fetch the first credential lease,
   * open a pg.Pool, and start the background renewal timer.
   */
  async start(): Promise<void> {
    await this._ensureToken();
    await this._rotateLease();
    this._startTimer();
  }

  /**
   * Returns the currently-active pg.Pool.
   * Throws if start() has not been called yet.
   */
  pool(): Pool {
    if (!this.currentPool) {
      throw new Error(
        "VaultCredsManager not started — call start() before pool()"
      );
    }
    return this.currentPool;
  }

  /**
   * Returns the current Vault lease metadata (for observability).
   */
  currentLeaseInfo(): Readonly<VaultLease> | null {
    return this.currentLease;
  }

  /**
   * Graceful shutdown: drain pool, revoke lease, stop timer.
   */
  async stop(): Promise<void> {
    this._stopTimer();
    if (this.currentPool) {
      await this.currentPool.end();
      this.currentPool = null;
    }
    if (this.currentLease) {
      await this._revokeLease(this.currentLease.leaseId).catch((err) =>
        this.emit("error", new Error(`Lease revocation failed: ${err.message}`))
      );
      this.currentLease = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: Vault authentication
  // -------------------------------------------------------------------------

  private async _ensureToken(): Promise<void> {
    if (this.vaultToken) return; // static token — nothing to do

    if (!this.vaultRoleId || !this.vaultSecretId) {
      throw new Error(
        "Vault authentication requires either vaultToken or (vaultRoleId + vaultSecretId)"
      );
    }
    await this._appRoleLogin();
  }

  private async _appRoleLogin(): Promise<void> {
    interface AppRoleResponse {
      auth: { client_token: string };
    }
    const resp = await vaultRequest<AppRoleResponse>({
      method: "POST",
      url: `${this.vaultAddr}/v1/auth/approle/login`,
      token: "",
      body: {
        role_id: this.vaultRoleId,
        secret_id: this.vaultSecretId,
      },
    });
    this.vaultToken = resp.auth.client_token;
  }

  // -------------------------------------------------------------------------
  // Internal: lease lifecycle
  // -------------------------------------------------------------------------

  private async _rotateLease(): Promise<void> {
    if (this.rotating) return;
    this.rotating = true;

    try {
      const lease = await this._fetchNewLease();
      const oldPool = this.currentPool;
      const oldLease = this.currentLease;

      // Open new pool BEFORE closing the old one — zero downtime
      this.currentPool = this._createPool(lease.username, lease.password);
      this.currentLease = lease;

      // Warm up: verify the new credentials actually work
      await this._verifyPool(this.currentPool);

      this.emit("credential_rotated", {
        leaseId: lease.leaseId,
        username: lease.username,
        expiresAt: lease.expiresAt,
      });

      // Now drain old pool (in-flight queries complete) then revoke old lease
      if (oldPool) {
        await oldPool.end();
      }
      if (oldLease) {
        await this._revokeLease(oldLease.leaseId).catch((err) =>
          this.emit(
            "error",
            new Error(`Old lease revocation failed: ${err.message}`)
          )
        );
      }
    } catch (err) {
      this.rotating = false;
      throw err;
    }

    this.rotating = false;
  }

  private async _fetchNewLease(): Promise<VaultLease> {
    interface DbCredsResponse {
      lease_id: string;
      lease_duration: number;
      data: { username: string; password: string };
    }

    const resp = await vaultRequest<DbCredsResponse>({
      method: "GET",
      url: `${this.vaultAddr}/v1/${this.dbMount}/creds/${this.dbRole}`,
      token: this.vaultToken,
    });

    const nowMs = Date.now();
    return {
      leaseId: resp.lease_id,
      username: resp.data.username,
      password: resp.data.password,
      leaseDurationSeconds: resp.lease_duration,
      expiresAt: nowMs + resp.lease_duration * 1000,
    };
  }

  private async _renewLease(leaseId: string): Promise<number> {
    interface RenewResponse {
      lease_duration: number;
    }
    const resp = await vaultRequest<RenewResponse>({
      method: "PUT",
      url: `${this.vaultAddr}/v1/sys/leases/renew`,
      token: this.vaultToken,
      body: { lease_id: leaseId },
    });
    return resp.lease_duration;
  }

  private async _revokeLease(leaseId: string): Promise<void> {
    await vaultRequest({
      method: "PUT",
      url: `${this.vaultAddr}/v1/sys/leases/revoke`,
      token: this.vaultToken,
      body: { lease_id: leaseId },
    });
  }

  // -------------------------------------------------------------------------
  // Internal: pool management
  // -------------------------------------------------------------------------

  private _createPool(username: string, password: string): Pool {
    const config: PoolConfig = {
      host: this.pgHost,
      port: this.pgPort,
      database: this.pgDatabase,
      user: username,
      password,
      max: this.pgPoolSize,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    };
    if (this.pgSsl) {
      config.ssl = { rejectUnauthorized: false };
    }
    return new Pool(config);
  }

  private async _verifyPool(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Internal: background renewal timer
  // -------------------------------------------------------------------------

  private _startTimer(): void {
    this.timer = setInterval(
      () => this._checkAndRenew().catch((err) => this.emit("error", err)),
      this.checkIntervalMs
    );
    // Don't keep the process alive on timer alone
    if (this.timer.unref) this.timer.unref();
  }

  private _stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async _checkAndRenew(): Promise<void> {
    if (!this.currentLease || this.rotating) return;

    const nowMs = Date.now();
    const remainingMs = this.currentLease.expiresAt - nowMs;
    const totalMs = this.currentLease.leaseDurationSeconds * 1000;
    const thresholdMs = totalMs * this.renewalThresholdFraction;

    if (remainingMs <= 0) {
      // Already expired — must rotate (get new creds)
      this.emit("warn", {
        message: "Lease expired; forcing credential rotation",
        leaseId: this.currentLease.leaseId,
      });
      await this._rotateLease();
      return;
    }

    if (remainingMs <= thresholdMs) {
      // Within renewal window — try to extend the existing lease
      try {
        const newDurationSeconds = await this._renewLease(
          this.currentLease.leaseId
        );
        this.currentLease = {
          ...this.currentLease,
          leaseDurationSeconds: newDurationSeconds,
          expiresAt: Date.now() + newDurationSeconds * 1000,
        };
        this.emit("lease_renewed", {
          leaseId: this.currentLease.leaseId,
          newExpiresAt: this.currentLease.expiresAt,
        });
      } catch (renewErr) {
        // Renewal rejected (e.g. max TTL reached) — fall back to rotation
        this.emit("warn", {
          message: "Lease renewal rejected; rotating to new credentials",
          error: (renewErr as Error).message,
        });
        await this._rotateLease();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers for testing
  // -------------------------------------------------------------------------

  /**
   * Force the current lease to expire immediately.
   * TEST USE ONLY — do not call in production code.
   */
  _forceExpiry(): void {
    if (this.currentLease) {
      this.currentLease = { ...this.currentLease, expiresAt: Date.now() - 1 };
    }
  }

  /**
   * Manually trigger a check-and-renew cycle.
   * TEST USE ONLY — lets tests drive the renewal loop without real timers.
   */
  async _triggerCheck(): Promise<void> {
    await this._checkAndRenew();
  }
}
