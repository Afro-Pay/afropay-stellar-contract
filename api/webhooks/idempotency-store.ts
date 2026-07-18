/**
 * In-memory idempotency store for webhook deduplication.
 *
 * In production this should be backed by the webhook_idempotency table
 * (see api/migrations/001_webhook_idempotency.sql).  The interface is
 * identical so the store can be swapped for a DB implementation without
 * touching the webhook handlers.
 */

export type WebhookProvider = "flutterwave" | "paystack";
export type WebhookStatus = "processed" | "dlq" | "failed";

export interface IdempotencyRecord {
  id: string;
  provider: WebhookProvider;
  reference: string;
  receivedAt: string; // ISO-8601 UTC
  status: WebhookStatus;
  responseBody: string; // JSON string cached for replay
}

/** Composite key → record */
const store = new Map<string, IdempotencyRecord>();

function key(provider: WebhookProvider, reference: string): string {
  return `${provider}::${reference}`;
}

/**
 * Look up an existing record. Returns undefined when no record is found
 * (i.e. this is the first delivery for this (provider, reference) pair).
 */
export function findRecord(
  provider: WebhookProvider,
  reference: string
): IdempotencyRecord | undefined {
  return store.get(key(provider, reference));
}

/**
 * Persist a new record.  Throws if the (provider, reference) pair already
 * exists — mirrors the DB UNIQUE constraint behaviour so callers must call
 * findRecord first.
 */
export function insertRecord(record: IdempotencyRecord): void {
  const k = key(record.provider, record.reference);
  if (store.has(k)) {
    throw new Error(
      `Duplicate idempotency record for ${record.provider}::${record.reference}`
    );
  }
  store.set(k, record);
}

/**
 * Update the status and (optionally) response body of an existing record.
 * Used by the DLQ service to mark retried webhooks as processed or failed.
 */
export function updateRecord(
  provider: WebhookProvider,
  reference: string,
  patch: Partial<Pick<IdempotencyRecord, "status" | "responseBody">>
): void {
  const k = key(provider, reference);
  const existing = store.get(k);
  if (!existing) {
    throw new Error(`No idempotency record found for ${provider}::${reference}`);
  }
  store.set(k, { ...existing, ...patch });
}

/** Wipe all records — used by tests to reset state between cases. */
export function clearRecords(): void {
  store.clear();
}
