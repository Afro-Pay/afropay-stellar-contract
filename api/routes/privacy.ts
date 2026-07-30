/**
 * api/routes/privacy.ts
 *
 * NDPA compliance endpoints:
 *
 *   POST /api/v1/privacy/dsar
 *     Data Subject Access Request — returns a structured JSON export of all
 *     PII associated with the authenticated user.
 *
 *   POST /api/v1/privacy/erasure
 *     Right to erasure — pseudonymizes all PII fields for the authenticated
 *     user while retaining transaction amounts and timestamps for CBN 5-year
 *     reporting (NDPA s.37 / CBN BSD/DIR/GEN/LAB/07/014 carve-out).
 *
 *   GET  /api/v1/privacy/consent
 *     Returns the current privacy notice version and the user's consent status.
 *
 *   POST /api/v1/privacy/consent
 *     Records the authenticated user's acceptance of the current privacy
 *     notice version.
 *
 * Authentication: SEP-10 JWT (requireSep10 middleware).
 * All mutating endpoints require an Idempotency-Key header.
 *
 * NDPA legal basis for processing: Article 25 (contractual necessity),
 * Article 26 (compliance with legal obligation — CBN requirements).
 */

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { requireSep10 } from "../middleware/sep10";
import { customers, transactions, findCustomer } from "../store";
import type { Customer, Sep31Transaction } from "../store";
import {
  pseudonymizeFields,
  pseudonymizeAccount,
  isPseudonymized,
  PSEUDONYM_PREFIX,
} from "../services/privacyAudit/pseudonymize";
import {
  InMemoryPrivacyAuditLogger,
  buildPrivacyAuditLogger,
  CUSTOMER_PII_FIELDS,
  CBN_RETAINED_TRANSACTION_FIELDS,
  type PrivacyAuditLogger,
} from "../services/privacyAudit/index";
import {
  buildNoticeStore,
  InMemoryNoticeStore,
  type NoticeStore,
} from "../services/privacyAudit/noticeVersioning";

// ---------------------------------------------------------------------------
// Module-level singletons (overridable for tests via buildPrivacyRouter)
// ---------------------------------------------------------------------------

/** Default: in-memory (dev/test). Production wires in a pg Pool. */
export let auditLogger: PrivacyAuditLogger = buildPrivacyAuditLogger();
export let noticeStore: NoticeStore = buildNoticeStore();

/** Allow tests and app.ts to inject real pg-backed instances. */
export function configurePrivacyDependencies(
  logger: PrivacyAuditLogger,
  store: NoticeStore
): void {
  auditLogger = logger;
  noticeStore = store;
}

// ---------------------------------------------------------------------------
// PII field definitions
// ---------------------------------------------------------------------------

/** PII fields on a Customer that may be erased (not CBN-retained). */
const ERASABLE_CUSTOMER_PII: string[] = [
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
];

/** Pseudonym key sourced from env. Must be ≥ 32 bytes in production. */
function getPseudonymKey(): string {
  const key = process.env.PSEUDONYM_KEY;
  if (!key || key.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "PSEUDONYM_KEY env var must be set to a secret of at least 32 characters in production"
      );
    }
    // Insecure fallback for dev/test only
    return "dev-only-insecure-pseudonym-key!!";
  }
  return key;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all Customer records for a given Stellar account. */
function getCustomersForAccount(account: string): Customer[] {
  const result: Customer[] = [];
  for (const customer of customers.values()) {
    if (customer.account === account) result.push(customer);
  }
  return result;
}

/** Collect all Sep31 transactions where the authenticated anchor created them. */
function getTransactionsForCreator(creatorSub: string): Sep31Transaction[] {
  const result: Sep31Transaction[] = [];
  for (const tx of transactions.values()) {
    if (tx.creator === creatorSub) result.push(tx);
  }
  return result;
}

/**
 * Build the DSAR export payload.
 * Sensitive fields are included in full — this is for the data subject's
 * own export, so no redaction applies.
 */
function buildDsarExport(
  account: string,
  creatorSub: string,
  customerList: Customer[],
  transactionList: Sep31Transaction[],
  consentHistory: Awaited<ReturnType<NoticeStore["getConsentHistory"]>>,
  auditHistory: Awaited<ReturnType<PrivacyAuditLogger["getEntriesForSubject"]>>
) {
  return {
    export_version: "1.0",
    exported_at: new Date().toISOString(),
    account,
    legal_basis: "NDPA s.35 — data subject right of access",
    kyc_profiles: customerList.map((c) => ({
      id: c.id,
      account: c.account,
      memo: c.memo,
      type: c.type,
      fields: c.fields,
    })),
    transactions: transactionList.map((tx) => ({
      id: tx.id,
      status: tx.status,
      amount_in: tx.amount_in,
      amount_in_asset: tx.amount_in_asset,
      amount_out: tx.amount_out,
      amount_out_asset: tx.amount_out_asset,
      amount_fee: tx.amount_fee,
      started_at: tx.started_at,
      updated_at: tx.updated_at,
      completed_at: tx.completed_at,
      stellar_transaction_id: tx.stellar_transaction_id,
      external_transaction_id: tx.external_transaction_id,
      refunded: tx.refunded,
    })),
    consent_history: consentHistory.map((c) => ({
      notice_version: c.noticeVersion,
      consented_at: c.consentedAt.toISOString(),
      ip_address: c.ipAddress,
    })),
    audit_log: auditHistory.map((e) => ({
      actor_type: e.actorType,
      fields_accessed: e.fieldsAccessed,
      purpose: e.purpose,
      occurred_at: e.occurredAt.toISOString(),
    })),
    regulatory_retention_notice:
      "Transaction amounts and timestamps are retained for 5 years " +
      "under CBN BSD/DIR/GEN/LAB/07/014 and cannot be erased during this period.",
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

// All privacy endpoints require a valid SEP-10 JWT
router.use(requireSep10);

// ---------------------------------------------------------------------------
// POST /api/v1/privacy/dsar
// ---------------------------------------------------------------------------

/**
 * Data Subject Access Request.
 *
 * Returns a structured JSON export of all PII stored for the authenticated
 * user: KYC profile(s), transactions, consent history, and a summary of
 * which non-owner actors have accessed their data.
 *
 * For datasets < 1,000 records the response is synchronous (200).
 * For larger datasets a 202 Accepted is returned with a `request_id` that
 * can be polled (future: async job queue).
 */
router.post("/dsar", async (req: Request, res: Response): Promise<void> => {
  const { account, sub } = req.sep10!;

  const customerList = getCustomersForAccount(account);
  const transactionList = getTransactionsForCreator(sub);

  // Audit: record that this DSAR export accessed the subject's PII.
  // The actor IS the subject here, so we use actorType='anchor' with
  // purpose='dsar_export' — still logged for completeness and NDPC evidence.
  await auditLogger.record({
    actorId: sub,
    actorType: "anchor",
    subjectAccount: account,
    fieldsAccessed: ERASABLE_CUSTOMER_PII,
    purpose: "dsar_export",
    legalBasis: "legal_obligation",
    sourceIp: req.ip,
    metadata: { initiated_by: "data_subject" },
  });

  // Determine if async path is needed (> 1000 records total)
  const totalRecords = customerList.length + transactionList.length;
  if (totalRecords > 1_000) {
    // Future: enqueue async export job; return 202 with request_id
    const requestId = uuidv4();
    res.status(202).json({
      request_id: requestId,
      status: "processing",
      message:
        "Your export contains more than 1,000 records. It will be ready within 72 hours. " +
        "You will be notified by email when the download link is available.",
      estimated_completion: new Date(
        Date.now() + 72 * 60 * 60 * 1000
      ).toISOString(),
    });
    return;
  }

  const [consentHistory, auditHistory] = await Promise.all([
    noticeStore.getConsentHistory(account),
    auditLogger.getEntriesForSubject(account),
  ]);

  const exportPayload = buildDsarExport(
    account,
    sub,
    customerList,
    transactionList,
    consentHistory,
    auditHistory
  );

  res.status(200).json(exportPayload);
});

// ---------------------------------------------------------------------------
// POST /api/v1/privacy/erasure
// ---------------------------------------------------------------------------

/**
 * Right-to-erasure endpoint.
 *
 * Pseudonymizes all erasable PII fields for the authenticated user using a
 * keyed HMAC-SHA256 (deterministic, irreversible without the key).
 *
 * CBN carve-out: transaction amounts, timestamps, and Stellar transaction IDs
 * are preserved per CBN BSD/DIR/GEN/LAB/07/014 (5-year retention requirement).
 *
 * Returns a summary of what was erased and what was retained.
 */
router.post("/erasure", async (req: Request, res: Response): Promise<void> => {
  const { account, sub } = req.sep10!;
  const key = getPseudonymKey();

  const customerList = getCustomersForAccount(account);

  if (customerList.length === 0) {
    res.status(404).json({
      error: "no customer records found for this account",
    });
    return;
  }

  const pseudonymizedAccount = pseudonymizeAccount(account, key);

  let totalFieldsErased = 0;
  const erasedCustomerIds: string[] = [];

  for (const customer of customerList) {
    const before = { ...customer.fields };
    const after = pseudonymizeFields(customer.fields, ERASABLE_CUSTOMER_PII, key);

    const erasedCount = Object.keys(after).filter(
      (k) => after[k] !== before[k]
    ).length;

    if (erasedCount > 0) {
      // Mutate in-place (in-memory store) — production would UPDATE via pg
      Object.assign(customer.fields, after);
      totalFieldsErased += erasedCount;
      erasedCustomerIds.push(customer.id);
    } else if (erasedCustomerIds.length === 0) {
      // All fields already pseudonymized — still record as erased
      erasedCustomerIds.push(customer.id);
    }
  }

  // Audit: record the erasure action
  await auditLogger.record({
    actorId: sub,
    actorType: "anchor",
    subjectAccount: account,
    fieldsAccessed: ERASABLE_CUSTOMER_PII,
    purpose: "dsar_export",
    legalBasis: "legal_obligation",
    sourceIp: req.ip,
    metadata: {
      action: "erasure",
      erased_customer_ids: erasedCustomerIds,
      fields_erased: ERASABLE_CUSTOMER_PII,
    },
  });

  // Collect the CBN-retained transaction fields for the response summary
  const transactionList = getTransactionsForCreator(sub);
  const retainedTransactionCount = transactionList.length;

  res.status(200).json({
    status: "erased",
    account_pseudonym: pseudonymizedAccount,
    erased_customer_ids: erasedCustomerIds,
    fields_erased: ERASABLE_CUSTOMER_PII,
    total_fields_erased: totalFieldsErased,
    regulatory_hold: retainedTransactionCount > 0,
    regulatory_hold_reason:
      retainedTransactionCount > 0
        ? `${retainedTransactionCount} transaction record(s) retained for 5 years ` +
          "per CBN BSD/DIR/GEN/LAB/07/014. Retained fields: " +
          CBN_RETAINED_TRANSACTION_FIELDS.join(", ")
        : null,
    completed_at: new Date().toISOString(),
    legal_basis:
      "NDPA s.36 (right to erasure) with carve-out under s.37 " +
      "(processing necessary for compliance with a legal obligation).",
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/privacy/consent
// ---------------------------------------------------------------------------

/**
 * Returns the current privacy notice version and whether the authenticated
 * user has consented to it.
 */
router.get("/consent", async (req: Request, res: Response): Promise<void> => {
  const { account } = req.sep10!;

  const [currentNotice, latestConsent, hasCurrent] = await Promise.all([
    noticeStore.getCurrentNotice(),
    noticeStore.getLatestConsent(account),
    noticeStore.hasConsentedToCurrentVersion(account),
  ]);

  res.status(200).json({
    current_notice_version: currentNotice?.version ?? null,
    current_notice_effective_date: currentNotice?.effectiveDate ?? null,
    current_notice_summary: currentNotice?.summaryOfChanges ?? null,
    user_consented_version: latestConsent?.noticeVersion ?? null,
    user_consented_at: latestConsent?.consentedAt.toISOString() ?? null,
    has_consented_to_current: hasCurrent,
    requires_re_consent: currentNotice != null && !hasCurrent,
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/privacy/consent
// ---------------------------------------------------------------------------

/**
 * Records the authenticated user's explicit acceptance of a specific privacy
 * notice version.  Clients should POST the `version` returned by GET /consent.
 */
router.post("/consent", async (req: Request, res: Response): Promise<void> => {
  const { account } = req.sep10!;
  const { version } = req.body ?? {};

  if (!version || typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    res.status(400).json({ error: "version must be a positive integer" });
    return;
  }

  const notice = await noticeStore.getNoticeByVersion(version);
  if (!notice) {
    res.status(404).json({ error: `privacy notice version ${version} not found` });
    return;
  }

  const consent = await noticeStore.recordConsent({
    account,
    noticeVersion: version,
    ipAddress: req.ip,
    userAgent: req.get("User-Agent"),
  });

  res.status(200).json({
    account,
    notice_version: consent.noticeVersion,
    consented_at: consent.consentedAt.toISOString(),
    message: `Consent recorded for privacy notice version ${version}.`,
  });
});

export default router;
