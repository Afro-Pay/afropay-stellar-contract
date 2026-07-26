/**
 * services/privacyAudit/index.ts
 *
 * Privacy audit logger for NDPA compliance.
 *
 * Records every read of PII fields by a **non-owner** actor — i.e. any access
 * that is NOT the data subject themselves querying their own record.  Owner
 * self-reads are exempt from the audit log because NDPA Article 26 only
 * requires logging of third-party data processing activities.
 *
 * ## Design
 *
 * PrivacyAuditLogger is injected into route handlers and admin services.
 * In production it writes to the `privacy_audit_log` table via a pg Pool.
 * In tests an InMemoryPrivacyAuditLogger is used to inspect emitted entries
 * without a database.
 *
 * ## Usage
 *
 * ```ts
 * import { buildPrivacyAuditLogger } from 'services/privacyAudit';
 *
 * const auditLog = buildPrivacyAuditLogger(pgPool);
 *
 * // In an admin handler that reads KYC fields:
 * await auditLog.record({
 *   actorId:        req.adminJwt.sub,
 *   actorType:      'admin',
 *   subjectAccount: customer.account,
 *   fieldsAccessed: ['first_name', 'last_name', 'bvn'],
 *   purpose:        'kyc_review',
 *   legalBasis:     'legal_obligation',
 *   sourceIp:       req.ip,
 * });
 * ```
 */

// pg is an optional peer dependency — installed in services that use
// PgPrivacyAuditLogger directly (services/reconciliation, services/listener).
// We use `any` here so the api package compiles without requiring pg.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgPool = any;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ActorType = "admin" | "service" | "anchor" | "operator";

export type AuditPurpose =
  | "kyc_review"
  | "aml_screening"
  | "dsar_export"
  | "support_lookup"
  | "fraud_investigation"
  | "reconciliation";

export type LegalBasis =
  | "legitimate_interest"
  | "legal_obligation"
  | "consent"
  | "vital_interest"
  | "public_task";

export interface AuditEntry {
  actorId: string;
  actorType: ActorType;
  subjectAccount: string;
  /** Names of PII fields that were read, e.g. ['first_name', 'bvn'] */
  fieldsAccessed: string[];
  purpose: AuditPurpose;
  legalBasis: LegalBasis;
  /** Optional correlation to a dsar_requests.id or support ticket. */
  requestId?: string;
  sourceIp?: string;
  /** Arbitrary extra context stored as JSONB. */
  metadata?: Record<string, unknown>;
}

export interface AuditRecord extends AuditEntry {
  id: number;
  occurredAt: Date;
}

/** Public interface satisfied by both the pg-backed and in-memory loggers. */
export interface PrivacyAuditLogger {
  /**
   * Record a PII field access by a non-owner actor.
   *
   * Implementations must be non-throwing: if the underlying store is
   * unavailable the error is logged to stderr and the caller is not
   * interrupted.
   */
  record(entry: AuditEntry): Promise<void>;

  /**
   * Retrieve all audit entries for a given subject account.
   * Used by the DSAR export endpoint to include audit history in the export.
   */
  getEntriesForSubject(subjectAccount: string): Promise<AuditRecord[]>;
}

// ---------------------------------------------------------------------------
// PG-backed logger (production)
// ---------------------------------------------------------------------------

export class PgPrivacyAuditLogger implements PrivacyAuditLogger {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly pool: PgPool) {}

  async record(entry: AuditEntry): Promise<void> {
    const sql = `
      INSERT INTO privacy_audit_log
        (actor_id, actor_type, subject_account, fields_accessed, purpose,
         legal_basis, request_id, source_ip, metadata, occurred_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    `;
    const params = [
      entry.actorId,
      entry.actorType,
      entry.subjectAccount,
      entry.fieldsAccessed.join(","),
      entry.purpose,
      entry.legalBasis,
      entry.requestId ?? null,
      entry.sourceIp ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ];

    try {
      await this.pool.query(sql, params);
    } catch (err) {
      // Never throw from audit logging — a DB hiccup must not break the
      // primary business operation. Alert ops via stderr so monitoring
      // can detect the pattern.
      console.error("[privacyAudit] failed to write audit entry:", err);
    }
  }

  async getEntriesForSubject(subjectAccount: string): Promise<AuditRecord[]> {
    const sql = `
      SELECT id, actor_id, actor_type, subject_account, fields_accessed,
             purpose, legal_basis, request_id, source_ip, metadata, occurred_at
      FROM   privacy_audit_log
      WHERE  subject_account = $1
      ORDER  BY occurred_at DESC
    `;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await this.pool.query(sql, [subjectAccount]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return result.rows.map((row: any) => ({
      id: row.id as number,
      actorId: row.actor_id as string,
      actorType: row.actor_type as ActorType,
      subjectAccount: row.subject_account as string,
      fieldsAccessed: (row.fields_accessed as string).split(",").filter(Boolean),
      purpose: row.purpose as AuditPurpose,
      legalBasis: row.legal_basis as LegalBasis,
      requestId: (row.request_id as string | null) ?? undefined,
      sourceIp: (row.source_ip as string | null) ?? undefined,
      metadata: row.metadata as Record<string, unknown>,
      occurredAt: row.occurred_at as Date,
    }));
  }
}

// ---------------------------------------------------------------------------
// In-memory logger (test / development)
// ---------------------------------------------------------------------------

/**
 * Thread-local in-memory implementation for unit and integration tests.
 * All records are stored in a plain array accessible via `entries`.
 */
export class InMemoryPrivacyAuditLogger implements PrivacyAuditLogger {
  public readonly entries: AuditRecord[] = [];
  private nextId = 1;

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push({
      ...entry,
      fieldsAccessed: [...entry.fieldsAccessed],
      metadata: entry.metadata ? { ...entry.metadata } : {},
      id: this.nextId++,
      occurredAt: new Date(),
    });
  }

  async getEntriesForSubject(subjectAccount: string): Promise<AuditRecord[]> {
    return this.entries
      .filter((e) => e.subjectAccount === subjectAccount)
      .map((e) => ({ ...e }));
  }

  /** Remove all entries (call in afterEach). */
  clear(): void {
    this.entries.length = 0;
    this.nextId = 1;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a production pg-backed logger from a Pool, or fall back to the
 * in-memory logger when the pool is not available (dev / test).
 */
export function buildPrivacyAuditLogger(pool?: PgPool): PrivacyAuditLogger {
  if (pool) return new PgPrivacyAuditLogger(pool);
  console.warn(
    "[privacyAudit] No pg Pool provided — using in-memory logger. " +
      "Do not use this in production."
  );
  return new InMemoryPrivacyAuditLogger();
}

// ---------------------------------------------------------------------------
// Well-known PII field sets (used by routes and tests)
// ---------------------------------------------------------------------------

/** All PII field names stored on a SEP-12 Customer record. */
export const CUSTOMER_PII_FIELDS = [
  "first_name",
  "last_name",
  "email_address",
  "phone_number",
  "bvn",
  "bank_account_number",
  "bank_name",
  "date_of_birth",
  "address",
  "id_type",
  "id_number",
] as const;

export type CustomerPiiField = (typeof CUSTOMER_PII_FIELDS)[number];

/** Transaction fields retained for CBN 5-year window (NOT pseudonymized). */
export const CBN_RETAINED_TRANSACTION_FIELDS = [
  "amount_in",
  "amount_out",
  "amount_fee",
  "started_at",
  "completed_at",
  "stellar_transaction_id",
  "external_transaction_id",
  "corridor",
] as const;
