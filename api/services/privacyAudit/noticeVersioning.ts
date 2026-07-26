/**
 * services/privacyAudit/noticeVersioning.ts
 *
 * Privacy Notice versioning system for NDPA compliance.
 *
 * NDPA s.24 requires that data controllers obtain fresh, informed consent
 * whenever the purpose or terms of processing change materially.  This module:
 *
 *  1. Stores published privacy notice versions.
 *  2. Records per-user consent (account → notice version → timestamp).
 *  3. Exposes helpers to check whether a user has consented to the *current*
 *     version and to flag users who have not (for re-consent prompts).
 *
 * In production the PgNoticeStore reads/writes the `privacy_notices` and
 * `user_consent_versions` tables created by migration 003.
 * In tests the InMemoryNoticeStore is used.
 */

// pg is an optional peer dep — installed in services that use PgNoticeStore.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pool = any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrivacyNotice {
  version: number;
  effectiveDate: string;   // ISO date string "YYYY-MM-DD"
  noticeText: string;
  summaryOfChanges: string;
  createdAt: Date;
  createdBy: string;
}

export interface UserConsent {
  account: string;
  noticeVersion: number;
  consentedAt: Date;
  ipAddress?: string;
  userAgent?: string;
}

export interface NoticeStore {
  /** Publish a new notice version.  Version must be > all existing versions. */
  publishNotice(notice: Omit<PrivacyNotice, "createdAt">): Promise<PrivacyNotice>;

  /** Return the notice with the highest version number. */
  getCurrentNotice(): Promise<PrivacyNotice | null>;

  /** Return a notice by version number. */
  getNoticeByVersion(version: number): Promise<PrivacyNotice | null>;

  /** Record that `account` has accepted `noticeVersion`. */
  recordConsent(consent: Omit<UserConsent, "consentedAt">): Promise<UserConsent>;

  /**
   * Return the highest notice version the account has consented to,
   * or null if they have never consented.
   */
  getLatestConsent(account: string): Promise<UserConsent | null>;

  /**
   * Return true when the account has explicitly consented to the current
   * notice version (or a higher one — future-proof for partial rollouts).
   */
  hasConsentedToCurrentVersion(account: string): Promise<boolean>;

  /** Return all consent records for an account (for DSAR export). */
  getConsentHistory(account: string): Promise<UserConsent[]>;
}

// ---------------------------------------------------------------------------
// In-memory store (tests)
// ---------------------------------------------------------------------------

export class InMemoryNoticeStore implements NoticeStore {
  private notices: PrivacyNotice[] = [];
  private consents: UserConsent[] = [];

  async publishNotice(
    notice: Omit<PrivacyNotice, "createdAt">
  ): Promise<PrivacyNotice> {
    const current = await this.getCurrentNotice();
    if (current && notice.version <= current.version) {
      throw new Error(
        `Notice version ${notice.version} must be greater than current version ${current.version}`
      );
    }
    const full: PrivacyNotice = { ...notice, createdAt: new Date() };
    this.notices.push(full);
    return full;
  }

  async getCurrentNotice(): Promise<PrivacyNotice | null> {
    if (this.notices.length === 0) return null;
    return this.notices.reduce((a, b) => (a.version > b.version ? a : b));
  }

  async getNoticeByVersion(version: number): Promise<PrivacyNotice | null> {
    return this.notices.find((n) => n.version === version) ?? null;
  }

  async recordConsent(consent: Omit<UserConsent, "consentedAt">): Promise<UserConsent> {
    // Idempotent: if a record already exists for (account, version), return it.
    const existing = this.consents.find(
      (c) => c.account === consent.account && c.noticeVersion === consent.noticeVersion
    );
    if (existing) return existing;

    const full: UserConsent = { ...consent, consentedAt: new Date() };
    this.consents.push(full);
    return full;
  }

  async getLatestConsent(account: string): Promise<UserConsent | null> {
    const accountConsents = this.consents.filter((c) => c.account === account);
    if (accountConsents.length === 0) return null;
    return accountConsents.reduce((a, b) =>
      a.noticeVersion > b.noticeVersion ? a : b
    );
  }

  async hasConsentedToCurrentVersion(account: string): Promise<boolean> {
    const current = await this.getCurrentNotice();
    if (!current) return false;
    const latest = await this.getLatestConsent(account);
    if (!latest) return false;
    return latest.noticeVersion >= current.version;
  }

  async getConsentHistory(account: string): Promise<UserConsent[]> {
    return this.consents
      .filter((c) => c.account === account)
      .sort((a, b) => b.noticeVersion - a.noticeVersion);
  }

  clear(): void {
    this.notices = [];
    this.consents = [];
  }
}

// ---------------------------------------------------------------------------
// PG-backed store (production)
// ---------------------------------------------------------------------------

export class PgNoticeStore implements NoticeStore {
  constructor(private readonly pool: Pool) {}

  async publishNotice(
    notice: Omit<PrivacyNotice, "createdAt">
  ): Promise<PrivacyNotice> {
    const sql = `
      INSERT INTO privacy_notices (version, effective_date, notice_text, summary_of_changes, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    const result = await this.pool.query(sql, [
      notice.version,
      notice.effectiveDate,
      notice.noticeText,
      notice.summaryOfChanges,
      notice.createdBy,
    ]);
    const row = result.rows[0];
    return this.rowToNotice(row);
  }

  async getCurrentNotice(): Promise<PrivacyNotice | null> {
    const result = await this.pool.query(
      "SELECT * FROM privacy_notices ORDER BY version DESC LIMIT 1"
    );
    if (result.rows.length === 0) return null;
    return this.rowToNotice(result.rows[0]);
  }

  async getNoticeByVersion(version: number): Promise<PrivacyNotice | null> {
    const result = await this.pool.query(
      "SELECT * FROM privacy_notices WHERE version = $1",
      [version]
    );
    if (result.rows.length === 0) return null;
    return this.rowToNotice(result.rows[0]);
  }

  async recordConsent(consent: Omit<UserConsent, "consentedAt">): Promise<UserConsent> {
    const sql = `
      INSERT INTO user_consent_versions (account, notice_version, ip_address, user_agent)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (account, notice_version) DO UPDATE
        SET ip_address = EXCLUDED.ip_address,
            user_agent = EXCLUDED.user_agent
      RETURNING *
    `;
    const result = await this.pool.query(sql, [
      consent.account,
      consent.noticeVersion,
      consent.ipAddress ?? null,
      consent.userAgent ?? null,
    ]);
    return this.rowToConsent(result.rows[0]);
  }

  async getLatestConsent(account: string): Promise<UserConsent | null> {
    const result = await this.pool.query(
      `SELECT * FROM user_consent_versions WHERE account = $1
       ORDER BY notice_version DESC LIMIT 1`,
      [account]
    );
    if (result.rows.length === 0) return null;
    return this.rowToConsent(result.rows[0]);
  }

  async hasConsentedToCurrentVersion(account: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM   user_consent_versions ucv
         JOIN   (SELECT MAX(version) AS v FROM privacy_notices) cur ON ucv.notice_version >= cur.v
         WHERE  ucv.account = $1
       ) AS has_consent`,
      [account]
    );
    return result.rows[0]?.has_consent === true;
  }

  async getConsentHistory(account: string): Promise<UserConsent[]> {
    const result = await this.pool.query(
      `SELECT * FROM user_consent_versions WHERE account = $1
       ORDER BY notice_version DESC`,
      [account]
    );
    return result.rows.map((r: Record<string, unknown>) => this.rowToConsent(r));
  }

  private rowToNotice(row: Record<string, unknown>): PrivacyNotice {
    return {
      version: row.version as number,
      effectiveDate: String(row.effective_date).slice(0, 10),
      noticeText: row.notice_text as string,
      summaryOfChanges: row.summary_of_changes as string,
      createdAt: new Date(row.created_at as string),
      createdBy: row.created_by as string,
    };
  }

  private rowToConsent(row: Record<string, unknown>): UserConsent {
    return {
      account: row.account as string,
      noticeVersion: row.notice_version as number,
      consentedAt: new Date(row.consented_at as string),
      ipAddress: (row.ip_address as string | null) ?? undefined,
      userAgent: (row.user_agent as string | null) ?? undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildNoticeStore(pool?: Pool): NoticeStore {
  if (pool) return new PgNoticeStore(pool);
  return new InMemoryNoticeStore();
}
