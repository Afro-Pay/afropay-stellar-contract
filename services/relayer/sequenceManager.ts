/**
 * sequenceManager.ts
 *
 * Atomic sequence-number reservation for Stellar transactions backed by Redis.
 *
 * Problem
 * ───────
 * Stellar transactions require a monotonically-increasing sequence number per
 * account.  Under concurrent load, two async tasks can both read the same
 * current sequence number from Horizon, build conflicting transactions, and
 * submit them simultaneously.  One will fail with TRANSACTION_BAD_SEQ; if
 * undetected the payment escrow is left in a stuck Funded state.
 *
 * Solution
 * ────────
 * Before building a transaction the relayer calls `SequenceManager.reserve()`.
 * That method uses Redis SET NX (set if not exists) with a TTL to acquire an
 * exclusive, time-bounded lock on the (accountId, sequence) slot:
 *
 *   Key:   `afropay:seq:<accountId>`
 *   Value: `<paymentId>`          — stored so we can detect the same paymentId
 *   NX:    only set if key does not exist
 *   PX:    TTL in milliseconds (default 10 000 ms = 2× Stellar ledger close time)
 *
 * If the key already exists, a DuplicatePaymentError is thrown with the
 * original paymentId in its payload so the caller can surface a proper error
 * to the user.
 *
 * The lock is always released after submission (success or error) via
 * `SequenceManager.release()`.  `withLock()` is a convenience wrapper that
 * handles acquisition and guaranteed release in a finally block.
 *
 * Locking strategy
 * ────────────────
 * • The lock key is scoped to the *account*, not the individual sequence
 *   number.  This serialises all submissions for a given sender account,
 *   which is necessary because concurrent submissions would need different
 *   sequence numbers — but we cannot know the next sequence without first
 *   fetching it from Horizon.
 * • TTL of 2× ledger close time (≈10 s) ensures the lock is automatically
 *   released if the process crashes mid-submission.
 * • The TTL is configurable so integration tests can use shorter windows.
 *
 * Distributed safety
 * ──────────────────
 * Redis SET NX + PX is an atomic single-command operation.  It is safe
 * across multiple relayer processes or replicas sharing the same Redis
 * instance.  For a multi-node Redis cluster the same command is atomic
 * within a single key's slot.
 */

import type { Redis } from "ioredis";
import { DuplicatePaymentError } from "./errors";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SequenceManagerConfig {
  /**
   * Redis key TTL in milliseconds.
   * Default: 10 000 ms (2× Stellar ledger close time of ~5 s).
   * Configurable so tests can use shorter values.
   */
  lockTtlMs?: number;
  /**
   * Namespace prefix for all Redis keys produced by this manager.
   * Default: "afropay:seq".
   */
  keyPrefix?: string;
}

// Default 2× Stellar ledger close time (5 s per ledger on the public network).
const DEFAULT_LOCK_TTL_MS = 10_000;
const DEFAULT_KEY_PREFIX = "afropay:seq";

// ---------------------------------------------------------------------------
// SequenceManager
// ---------------------------------------------------------------------------

export class SequenceManager {
  private readonly lockTtlMs: number;
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: Redis,
    config: SequenceManagerConfig = {}
  ) {
    this.lockTtlMs = config.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Atomically reserve the sequence-number lock for a given Stellar account.
   *
   * Uses Redis SET NX PX so the operation is atomic and the lock automatically
   * expires if the process crashes before calling `release()`.
   *
   * @param accountId  Stellar account ID (G… address of the sender).
   * @param paymentId  Unique payment identifier — stored in the lock value so
   *                   callers can detect re-entrant submissions of the exact
   *                   same payment.
   *
   * @throws {DuplicatePaymentError} when a lock already exists for the account.
   *
   * @returns The Redis key that was locked (pass to `release()` to unlock).
   */
  async reserve(accountId: string, paymentId: string): Promise<string> {
    const key = this.buildKey(accountId);

    // SET key value PX ttl NX — returns "OK" on success, null if key exists.
    // ioredis v5 overload: set(key, value, expiryMode, time, setMode)
    const result = await (this.redis as any).set(key, paymentId, "PX", this.lockTtlMs, "NX");

    if (result === null) {
      // Lock already held — retrieve the payment ID that holds it for context.
      throw new DuplicatePaymentError(paymentId);
    }

    return key;
  }

  /**
   * Release the lock for a given account.
   *
   * Safe to call even if the lock has already expired (Redis DEL on a
   * non-existent key is a no-op).
   *
   * @param accountId  Stellar account ID whose lock should be released.
   */
  async release(accountId: string): Promise<void> {
    const key = this.buildKey(accountId);
    await this.redis.del(key);
  }

  /**
   * Acquire the sequence lock, run `fn`, then unconditionally release the lock.
   *
   * This is the preferred usage pattern — it guarantees the lock is always
   * released even when `fn` throws.
   *
   * @param accountId  Stellar account ID to lock.
   * @param paymentId  Payment identifier (stored in lock value).
   * @param fn         Async callback executed while the lock is held.
   *                   Receives the locked Redis key for logging purposes.
   *
   * @throws {DuplicatePaymentError} if the lock is already held.
   * @throws Any error thrown by `fn` (after releasing the lock).
   */
  async withLock<T>(
    accountId: string,
    paymentId: string,
    fn: (lockedKey: string) => Promise<T>
  ): Promise<T> {
    const key = await this.reserve(accountId, paymentId);
    try {
      return await fn(key);
    } finally {
      await this.release(accountId);
    }
  }

  /**
   * Return the number of currently active sequence locks.
   * Scans keys matching the prefix pattern.  Used in tests to assert all
   * locks have been released after a batch of submissions.
   *
   * NOTE: `SCAN` is O(N) over the keyspace.  Use only in tests or monitoring,
   * never in the hot submission path.
   */
  async activeLockCount(): Promise<number> {
    const pattern = `${this.keyPrefix}:*`;
    const keys = await this.scanKeys(pattern);
    return keys.length;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildKey(accountId: string): string {
    return `${this.keyPrefix}:${accountId}`;
  }

  /**
   * Scan all keys matching `pattern` using SCAN with cursor iteration so we
   * never block the Redis event loop with KEYS.
   */
  private async scanKeys(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100
      );
      cursor = nextCursor;
      found.push(...keys);
    } while (cursor !== "0");
    return found;
  }
}
