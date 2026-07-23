/**
 * BackgroundSyncQueue — offline payment outbox (Issue #21)
 *
 * Stores pending POST /api/v1/payments requests in IndexedDB while the device
 * is offline and retries them automatically on reconnect.
 *
 * Idempotency guarantee: every queued request retains its original
 * `Idempotency-Key` header so duplicate network submissions are detected and
 * deduplicated server-side even if the SW retries more than once.
 *
 * Usage (from the payment form):
 *
 *   import { enqueuePayment, drainOutbox } from '../sw/outbox';
 *
 *   // When offline or the request fails due to network:
 *   await enqueuePayment({ url, body, idempotencyKey });
 *
 *   // The SW calls drainOutbox() automatically on 'online'; you can also
 *   // call it manually in tests.
 */

import { openDB, DBSchema, IDBPDatabase } from "idb";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueuedPayment {
  /** Unique DB record identifier (auto-incremented). */
  id?: number;
  /** Full URL for the payment endpoint, e.g. /api/v1/payments */
  url: string;
  /** Serialised JSON body. */
  body: string;
  /** Idempotency key — preserved across retries to prevent double-submits. */
  idempotencyKey: string;
  /** ISO 8601 timestamp when the item was queued. */
  queuedAt: string;
  /** Number of delivery attempts so far. */
  attempts: number;
}

interface OutboxSchema extends DBSchema {
  outbox: {
    key: number;
    value: QueuedPayment;
  };
}

// ---------------------------------------------------------------------------
// DB singleton
// ---------------------------------------------------------------------------

const DB_NAME = "afropay-outbox";
const DB_VERSION = 1;
const STORE = "outbox" as const;
const MAX_ATTEMPTS = 5;

let dbPromise: Promise<IDBPDatabase<OutboxSchema>> | null = null;

function getDb(): Promise<IDBPDatabase<OutboxSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<OutboxSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        }
      },
    });
  }
  return dbPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a payment request to the persistent outbox.
 *
 * Call this when a POST /api/v1/payments fails because the device is offline
 * or when navigator.onLine is false before the request is even sent.
 */
export async function enqueuePayment(
  payload: Omit<QueuedPayment, "id" | "queuedAt" | "attempts">
): Promise<number> {
  const db = await getDb();
  const record: QueuedPayment = {
    ...payload,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };
  const id = await db.add(STORE, record);
  return id as number;
}

/**
 * Return all queued payments without removing them.
 */
export async function listPending(): Promise<QueuedPayment[]> {
  const db = await getDb();
  return db.getAll(STORE);
}

/**
 * Remove a queued payment by its DB id (call after successful delivery).
 */
export async function removeQueued(id: number): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
}

/**
 * Drain the outbox: attempt to POST every queued payment.
 *
 * - Successful requests are removed from the DB.
 * - Failed requests have their `attempts` counter incremented.
 * - Requests that exceed MAX_ATTEMPTS are dropped with a console warning.
 *
 * Returns the number of successfully delivered payments.
 */
export async function drainOutbox(): Promise<number> {
  const pending = await listPending();
  if (pending.length === 0) return 0;

  let delivered = 0;

  for (const item of pending) {
    if (item.attempts >= MAX_ATTEMPTS) {
      console.warn(
        `[outbox] Dropping payment ${item.idempotencyKey} after ${item.attempts} failed attempts`
      );
      await removeQueued(item.id!);
      continue;
    }

    try {
      const response = await fetch(item.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Preserve the original idempotency key on every retry so the server
          // can deduplicate without side effects.
          "Idempotency-Key": item.idempotencyKey,
        },
        body: item.body,
      });

      if (response.ok || response.status === 409) {
        // 409 Conflict means the server already processed this idempotency key —
        // treat it as success (deduplication worked).
        await removeQueued(item.id!);
        delivered += 1;
      } else {
        await incrementAttempts(item);
      }
    } catch {
      // Network error — device may have gone offline again mid-drain.
      await incrementAttempts(item);
    }
  }

  return delivered;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function incrementAttempts(item: QueuedPayment): Promise<void> {
  const db = await getDb();
  const updated: QueuedPayment = { ...item, attempts: item.attempts + 1 };
  await db.put(STORE, updated);
}

// ---------------------------------------------------------------------------
// Connectivity listener — drain automatically on reconnect
// ---------------------------------------------------------------------------

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    drainOutbox().then((n) => {
      if (n > 0) {
        console.info(`[outbox] Drained ${n} queued payment(s) on reconnect`);
      }
    });
  });
}
