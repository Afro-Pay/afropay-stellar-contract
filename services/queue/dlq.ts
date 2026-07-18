/**
 * Dead-Letter Queue (DLQ) for out-of-order webhook deliveries.
 *
 * When a webhook arrives before its escrow record has been created the handler
 * enqueues it here instead of dropping it.  The DLQ retries processing up to
 * MAX_ATTEMPTS times using exponential back-off:
 *
 *   Attempt 1 → 30 s delay
 *   Attempt 2 → 2 min (120 s) delay
 *   Attempt 3 → 10 min (600 s) delay
 *   After attempt 3 → alert (console.error) and mark failed
 *
 * The retry delays satisfy: delay[n] = BACKOFF_DELAYS_MS[n]
 *
 * This implementation is intentionally in-memory (no Redis dependency) so it
 * is usable in the current project environment.  Replace `scheduleRetry` with
 * a BullMQ/SQS enqueue call when a persistent queue is available.
 */

import { updateRecord, WebhookProvider } from "../../api/webhooks/idempotency-store";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_ATTEMPTS = 3;

/** Retry delays in milliseconds: 30 s, 2 min, 10 min */
export const BACKOFF_DELAYS_MS: readonly number[] = [
  30_000,   // attempt 1
  120_000,  // attempt 2
  600_000,  // attempt 3
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DlqJob {
  /** Unique job id */
  id: string;
  provider: WebhookProvider;
  /** Provider-supplied idempotency reference (txRef / reference) */
  reference: string;
  /** Raw request body as received from the provider */
  rawBody: Record<string, unknown>;
  /** Number of delivery attempts already made (0-based) */
  attempts: number;
  /** ISO-8601 timestamp of the next scheduled retry */
  nextRetryAt: string;
}

// ---------------------------------------------------------------------------
// In-memory queue state
// ---------------------------------------------------------------------------

/** Live jobs indexed by id. */
const jobs = new Map<string, DlqJob>();

/** Timer handles indexed by job id — kept so tests can clear them. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// Processor registry
// ---------------------------------------------------------------------------

type JobProcessor = (job: DlqJob) => Promise<boolean>;

let registeredProcessor: JobProcessor | null = null;

/**
 * Register the function that attempts to process a DLQ job.
 * Should return `true` when the job was handled successfully, `false` when
 * the escrow still does not exist (triggers another retry).
 */
export function registerProcessor(processor: JobProcessor): void {
  registeredProcessor = processor;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue a webhook for deferred processing.
 *
 * The job is scheduled for its first retry after BACKOFF_DELAYS_MS[0].
 */
export function enqueue(job: Omit<DlqJob, "attempts" | "nextRetryAt">): void {
  const fullJob: DlqJob = {
    ...job,
    attempts: 0,
    nextRetryAt: new Date(Date.now() + BACKOFF_DELAYS_MS[0]).toISOString(),
  };
  jobs.set(fullJob.id, fullJob);
  scheduleRetry(fullJob);
}

/**
 * Return a snapshot of all live DLQ jobs (useful for monitoring endpoints).
 */
export function listJobs(): DlqJob[] {
  return Array.from(jobs.values());
}

/**
 * Remove a job from the queue (e.g. after successful processing).
 * Also cancels any pending timer for that job.
 */
export function removeJob(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  jobs.delete(id);
}

/**
 * Clear all jobs and timers — intended for test teardown only.
 */
export function clearQueue(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
  jobs.clear();
}

// ---------------------------------------------------------------------------
// Internal retry logic
// ---------------------------------------------------------------------------

function scheduleRetry(job: DlqJob): void {
  const delayMs = BACKOFF_DELAYS_MS[job.attempts];
  if (delayMs === undefined) {
    // Should not happen — handled in processJob — but guard defensively.
    handleExhausted(job);
    return;
  }

  const timer = setTimeout(() => {
    timers.delete(job.id);
    void processJob(job);
  }, delayMs);

  timers.set(job.id, timer);
}

async function processJob(job: DlqJob): Promise<void> {
  const currentJob = jobs.get(job.id);
  if (!currentJob) {
    // Job was removed externally (e.g. by a test) — nothing to do.
    return;
  }

  const attempt = currentJob.attempts + 1;
  const updatedJob: DlqJob = { ...currentJob, attempts: attempt };
  jobs.set(job.id, updatedJob);

  let success = false;
  try {
    if (registeredProcessor) {
      success = await registeredProcessor(updatedJob);
    }
  } catch (err) {
    console.error(
      `[DLQ] processor threw on attempt ${attempt} for ` +
        `${updatedJob.provider}::${updatedJob.reference}:`,
      err
    );
  }

  if (success) {
    removeJob(job.id);
    return;
  }

  if (attempt >= MAX_ATTEMPTS) {
    handleExhausted(updatedJob);
  } else {
    const nextDelay = BACKOFF_DELAYS_MS[attempt];
    const nextJob: DlqJob = {
      ...updatedJob,
      nextRetryAt: new Date(Date.now() + nextDelay).toISOString(),
    };
    jobs.set(job.id, nextJob);
    scheduleRetry(nextJob);
  }
}

function handleExhausted(job: DlqJob): void {
  console.error(
    `[DLQ] ALERT: webhook exhausted ${MAX_ATTEMPTS} retries and will not be ` +
      `retried. provider=${job.provider} reference=${job.reference} ` +
      `jobId=${job.id}`
  );

  // Update idempotency record status to 'failed' so operators can query it.
  try {
    updateRecord(job.provider, job.reference, {
      status: "failed",
      responseBody: JSON.stringify({ error: "dlq_exhausted", jobId: job.id }),
    });
  } catch {
    // Record may not exist if the handler never inserted it — log and move on.
    console.error(
      `[DLQ] could not update idempotency record for ` +
        `${job.provider}::${job.reference} after exhaustion`
    );
  }

  removeJob(job.id);
}
