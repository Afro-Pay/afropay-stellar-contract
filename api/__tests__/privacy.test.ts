/**
/**
 * api/__tests__/privacy.test.ts  — Part 1: pseudonymization unit tests
 *
 * Acceptance criteria verified:
 *  ✓ Pseudonymized value cannot be reversed to original without the HMAC key
 *  ✓ Different keys produce different pseudonyms for the same input
 *  ✓ Same (value, key) always produces the same output (deterministic)
 *  ✓ isPseudonymized correctly identifies already-erased values
 *  ✓ pseudonymizeFields only touches named fields; others pass through
 *  ✓ pseudonymizeFields is idempotent (double erasure is safe)
 *  ✓ pseudonymizeAccount produces a scoped pseudonym distinct from field hashes
 */

// Set env vars before any imports that trigger config.ts at module load time.
import path from "path";
process.env.STELLAR_TOML_PATH = path.resolve(
  __dirname,
  "../../public/.well-known/stellar.toml"
);
process.env.SEP10_SIGNING_SEED = "SAPIZOWDFX4OYJNP2YYP7S3RWSGBWH5LSENWAI6PLQKULS3BKVXQ3MTQ";
process.env.HOME_DOMAIN = "localhost:8000";
process.env.JWT_SECRET = "test-jwt-secret-for-privacy-tests!!";
process.env.PSEUDONYM_KEY = "test-pseudonym-key-32-bytes-pad!!";

import {
  pseudonymize,
  pseudonymizeFields,
  pseudonymizeAccount,
  isPseudonymized,
  PSEUDONYM_PREFIX,
} from "../services/privacyAudit/pseudonymize";

const KEY_A = "key-alpha-32-bytes-long-secret!!";
const KEY_B = "key-beta--32-bytes-long-secret!!";

// ---------------------------------------------------------------------------
// pseudonymize()
// ---------------------------------------------------------------------------

describe("pseudonymize()", () => {
  it("returns a string starting with the PSEUDONYM_PREFIX", () => {
    const result = pseudonymize("Amara Okafor", KEY_A);
    expect(result.startsWith(PSEUDONYM_PREFIX)).toBe(true);
  });

  it("is deterministic: same input + same key → same output", () => {
    expect(pseudonymize("Amara Okafor", KEY_A)).toBe(
      pseudonymize("Amara Okafor", KEY_A)
    );
  });

  it("different keys produce different pseudonyms for the same value", () => {
    const hashA = pseudonymize("Amara Okafor", KEY_A);
    const hashB = pseudonymize("Amara Okafor", KEY_B);
    expect(hashA).not.toBe(hashB);
  });

  it("different values produce different pseudonyms with the same key", () => {
    expect(pseudonymize("Amara Okafor", KEY_A)).not.toBe(
      pseudonymize("Chidi Nwosu", KEY_A)
    );
  });

  it("is NOT reversible: cannot recover original from output without the key", () => {
    const original = "08012345678"; // Nigerian mobile number
    const pseudonym = pseudonymize(original, KEY_A);

    // The pseudonym is a hex digest — it does not contain the original value
    expect(pseudonym).not.toContain(original);

    // Brute-forcing the key from the digest is computationally infeasible.
    // We verify the structural guarantee: the output is a fixed-length hex
    // string with no information about the input length or content.
    const hexPart = pseudonym.slice(PSEUDONYM_PREFIX.length);
    expect(hexPart).toMatch(/^[0-9a-f]{64}$/); // SHA-256 → 32 bytes → 64 hex chars
    expect(hexPart.length).toBe(64); // length is independent of input length

    // Verify that an attacker who knows the pseudonym but not the key cannot
    // re-derive it from a guessed original (wrong key → wrong digest).
    const wrongKeyAttempt = pseudonymize(original, "wrong-key-32-bytes-long-padding!");
    expect(wrongKeyAttempt).not.toBe(pseudonym);
  });

  it("handles empty string input without throwing", () => {
    expect(() => pseudonymize("", KEY_A)).not.toThrow();
    expect(pseudonymize("", KEY_A).startsWith(PSEUDONYM_PREFIX)).toBe(true);
  });

  it("handles unicode PII (e.g. Yoruba names) correctly", () => {
    const yorubaName = "Adéọlá Ọlánrewájú";
    const result = pseudonymize(yorubaName, KEY_A);
    expect(result.startsWith(PSEUDONYM_PREFIX)).toBe(true);
    expect(result).not.toContain(yorubaName);
  });
});

// ---------------------------------------------------------------------------
// isPseudonymized()
// ---------------------------------------------------------------------------

describe("isPseudonymized()", () => {
  it("returns true for a pseudonymized value", () => {
    const p = pseudonymize("test", KEY_A);
    expect(isPseudonymized(p)).toBe(true);
  });

  it("returns false for a plain PII value", () => {
    expect(isPseudonymized("Amara Okafor")).toBe(false);
    expect(isPseudonymized("08012345678")).toBe(false);
    expect(isPseudonymized("22222222222")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isPseudonymized("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pseudonymizeFields()
// ---------------------------------------------------------------------------

describe("pseudonymizeFields()", () => {
  const fields = {
    first_name: "Amara",
    last_name: "Okafor",
    email_address: "amara@example.com",
    bvn: "22222222222",
    bank_account_number: "0123456789",
    // A non-PII field that should pass through untouched
    account_type: "individual",
  };

  const PII_TO_ERASE = ["first_name", "last_name", "email_address", "bvn", "bank_account_number"];

  it("replaces only the named fields with pseudonyms", () => {
    const result = pseudonymizeFields(fields, PII_TO_ERASE, KEY_A);
    for (const field of PII_TO_ERASE) {
      expect(isPseudonymized(result[field])).toBe(true);
    }
    // Non-PII field preserved exactly
    expect(result.account_type).toBe("individual");
  });

  it("does not mutate the original fields object", () => {
    const original = { ...fields };
    pseudonymizeFields(fields, PII_TO_ERASE, KEY_A);
    expect(fields).toEqual(original);
  });

  it("is idempotent — double erasure produces the same pseudonym", () => {
    const once = pseudonymizeFields(fields, PII_TO_ERASE, KEY_A);
    const twice = pseudonymizeFields(once, PII_TO_ERASE, KEY_A);
    // Each pseudonymized field should be identical after second pass
    for (const field of PII_TO_ERASE) {
      expect(twice[field]).toBe(once[field]);
    }
  });

  it("handles a field list that includes a non-existent field gracefully", () => {
    const result = pseudonymizeFields(
      fields,
      [...PII_TO_ERASE, "nonexistent_field"],
      KEY_A
    );
    expect(result).not.toHaveProperty("nonexistent_field");
  });

  it("erases BVN (Nigerian Bank Verification Number) irreversibly", () => {
    const bvn = "22222222222";
    const result = pseudonymizeFields({ bvn }, ["bvn"], KEY_A);
    expect(result.bvn).not.toBe(bvn);
    expect(result.bvn).not.toContain(bvn);
    expect(isPseudonymized(result.bvn)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pseudonymizeAccount()
// ---------------------------------------------------------------------------

describe("pseudonymizeAccount()", () => {
  const account = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

  it("returns a pseudonym starting with PSEUDONYM_PREFIX", () => {
    expect(pseudonymizeAccount(account, KEY_A).startsWith(PSEUDONYM_PREFIX)).toBe(true);
  });

  it("is deterministic", () => {
    expect(pseudonymizeAccount(account, KEY_A)).toBe(
      pseudonymizeAccount(account, KEY_A)
    );
  });

  it("produces a different value than pseudonymize() of the raw account (scoped)", () => {
    // pseudonymizeAccount scopes with 'account:' prefix to avoid collisions
    expect(pseudonymizeAccount(account, KEY_A)).not.toBe(
      pseudonymize(account, KEY_A)
    );
  });

  it("different accounts produce different pseudonyms", () => {
    const accountB = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    expect(pseudonymizeAccount(account, KEY_A)).not.toBe(
      pseudonymizeAccount(accountB, KEY_A)
    );
  });
});

// =============================================================================
// Part 2: Privacy audit log integration tests
// =============================================================================

import {
  InMemoryPrivacyAuditLogger,
  type AuditEntry,
} from "../services/privacyAudit/index";

describe("InMemoryPrivacyAuditLogger", () => {
  let logger: InMemoryPrivacyAuditLogger;

  beforeEach(() => {
    logger = new InMemoryPrivacyAuditLogger();
  });

  const ENTRY: AuditEntry = {
    actorId: "admin@afropay.io",
    actorType: "admin",
    subjectAccount: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    fieldsAccessed: ["first_name", "last_name", "bvn"],
    purpose: "kyc_review",
    legalBasis: "legal_obligation",
    sourceIp: "10.0.0.1",
  };

  it("records an audit entry and assigns a numeric id", async () => {
    await logger.record(ENTRY);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0].id).toBe(1);
  });

  it("captures actor_id, actor_type, subject, fields, purpose, legalBasis", async () => {
    await logger.record(ENTRY);
    const recorded = logger.entries[0];
    expect(recorded.actorId).toBe("admin@afropay.io");
    expect(recorded.actorType).toBe("admin");
    expect(recorded.subjectAccount).toBe(ENTRY.subjectAccount);
    expect(recorded.fieldsAccessed).toEqual(["first_name", "last_name", "bvn"]);
    expect(recorded.purpose).toBe("kyc_review");
    expect(recorded.legalBasis).toBe("legal_obligation");
  });

  it("captures timestamp (occurredAt) automatically", async () => {
    const before = new Date();
    await logger.record(ENTRY);
    const after = new Date();
    const { occurredAt } = logger.entries[0];
    expect(occurredAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(occurredAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("auto-increments ids across multiple entries", async () => {
    await logger.record(ENTRY);
    await logger.record({ ...ENTRY, actorId: "service:kyc-provider" });
    expect(logger.entries[0].id).toBe(1);
    expect(logger.entries[1].id).toBe(2);
  });

  it("getEntriesForSubject returns only entries for that account", async () => {
    const otherAccount = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    await logger.record(ENTRY);
    await logger.record({ ...ENTRY, subjectAccount: otherAccount });
    const entries = await logger.getEntriesForSubject(ENTRY.subjectAccount);
    expect(entries).toHaveLength(1);
    expect(entries[0].subjectAccount).toBe(ENTRY.subjectAccount);
  });

  it("getEntriesForSubject returns empty array when no entries exist", async () => {
    const entries = await logger.getEntriesForSubject("GNOBODY");
    expect(entries).toEqual([]);
  });

  it("stores a deep copy of fieldsAccessed (mutation-safe)", async () => {
    const fields = ["first_name", "bvn"];
    await logger.record({ ...ENTRY, fieldsAccessed: fields });
    fields.push("email_address"); // mutate original after recording
    expect(logger.entries[0].fieldsAccessed).toEqual(["first_name", "bvn"]);
  });

  it("clear() removes all entries and resets id counter", async () => {
    await logger.record(ENTRY);
    logger.clear();
    expect(logger.entries).toHaveLength(0);
    await logger.record(ENTRY);
    expect(logger.entries[0].id).toBe(1);
  });
});

// =============================================================================
// Part 3: DSAR & erasure HTTP endpoint integration tests
// =============================================================================

import request from "supertest";
import type { Express } from "express";
// NOTE: import the store and route module statically — we do NOT use
// jest.resetModules() in this describe block so all modules share the same
// singleton Maps throughout the integration tests.
import { customers, transactions } from "../store";
import type { Customer, Sep31Transaction } from "../store";
import { configurePrivacyDependencies } from "../routes/privacy";
import { InMemoryNoticeStore } from "../services/privacyAudit/noticeVersioning";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_ACCOUNT = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const JWT_SECRET = "test-jwt-secret-for-privacy-tests!!";

/** Build a minimal HS256 JWT for the test account. */
function makeJwt(account: string = TEST_ACCOUNT): string {
  const crypto = require("crypto") as typeof import("crypto");
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ sub: account, iat, exp: iat + 86400 })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function seedCustomer(account: string = TEST_ACCOUNT): Customer {
  const customer: Customer = {
    id: `cust-${Math.random().toString(36).slice(2)}`,
    account,
    fields: {
      first_name: "Amara",
      last_name: "Okafor",
      email_address: "amara.okafor@test.example",
      bvn: "22222222222",
    },
  };
  customers.set(customer.id, customer);
  return customer;
}

function seedTransaction(creatorSub: string): Sep31Transaction {
  const now = new Date().toISOString();
  const tx: Sep31Transaction = {
    id: `tx-${Math.random().toString(36).slice(2)}`,
    creator: creatorSub,
    status: "completed",
    status_eta: null,
    status_message: null,
    amount_in: "100.00",
    amount_in_asset: "stellar:USDC",
    amount_out: "99.50",
    amount_out_asset: "stellar:USDC",
    amount_fee: "0.50",
    amount_fee_asset: "stellar:USDC",
    stellar_account_id: "GTEST",
    stellar_memo_type: "hash",
    stellar_memo: "abc123",
    started_at: now,
    updated_at: now,
    completed_at: now,
    stellar_transaction_id: "abc",
    external_transaction_id: null,
    refunded: false,
    required_info_message: null,
    required_info_updates: null,
    fields: {},
    callback_url: null,
  };
  transactions.set(tx.id, tx);
  return tx;
}

// ---------------------------------------------------------------------------
// Test setup — build the app ONCE for the integration suite.
// We do NOT call jest.resetModules() here so that the customers/transactions
// Maps imported above are the same singleton instances used by the routes.
// ---------------------------------------------------------------------------

let app: Express;
let testAuditLogger: InMemoryPrivacyAuditLogger;
let testNoticeStore: InMemoryNoticeStore;

beforeAll(async () => {
  const { buildApp } = await import("../app");
  app = buildApp();

  testAuditLogger = new InMemoryPrivacyAuditLogger();
  testNoticeStore = new InMemoryNoticeStore();
  configurePrivacyDependencies(testAuditLogger, testNoticeStore);
});

beforeEach(() => {
  // Reset stores before each test so tests are independent
  customers.clear();
  transactions.clear();
  testAuditLogger.clear();
  testNoticeStore.clear();
});

// ---------------------------------------------------------------------------
// DSAR endpoint
// ---------------------------------------------------------------------------

describe("POST /api/v1/privacy/dsar", () => {
  it("returns 403 when no JWT is provided", async () => {
    const res = await request(app).post("/api/v1/privacy/dsar");
    expect(res.status).toBe(403);
  });

  it("returns a structured export for a user with KYC data", async () => {
    const customer = seedCustomer(TEST_ACCOUNT);
    const jwt = makeJwt(TEST_ACCOUNT);

    const res = await request(app)
      .post("/api/v1/privacy/dsar")
      .set("Authorization", `Bearer ${jwt}`)
      .set("Idempotency-Key", "test-idem-dsar-1");

    expect(res.status).toBe(200);
    expect(res.body.export_version).toBe("1.0");
    expect(res.body.account).toBe(TEST_ACCOUNT);
    expect(Array.isArray(res.body.kyc_profiles)).toBe(true);
    expect(res.body.kyc_profiles[0].id).toBe(customer.id);
    expect(res.body.kyc_profiles[0].fields.first_name).toBe("Amara");
  });

  it("includes transactions belonging to the authenticated user", async () => {
    seedCustomer(TEST_ACCOUNT);
    const jwt = makeJwt(TEST_ACCOUNT);
    seedTransaction(TEST_ACCOUNT); // creator = account sub

    const res = await request(app)
      .post("/api/v1/privacy/dsar")
      .set("Authorization", `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    expect(res.body.transactions.length).toBeGreaterThanOrEqual(1);
    // Amounts and timestamps are present in the export
    expect(res.body.transactions[0]).toHaveProperty("amount_in");
    expect(res.body.transactions[0]).toHaveProperty("started_at");
  });

  it("writes an audit log entry for the DSAR access", async () => {
    seedCustomer(TEST_ACCOUNT);
    const jwt = makeJwt(TEST_ACCOUNT);

    await request(app)
      .post("/api/v1/privacy/dsar")
      .set("Authorization", `Bearer ${jwt}`);

    const auditEntries = await testAuditLogger.getEntriesForSubject(TEST_ACCOUNT);
    expect(auditEntries.length).toBeGreaterThanOrEqual(1);
    expect(auditEntries[0].purpose).toBe("dsar_export");
    expect(auditEntries[0].legalBasis).toBe("legal_obligation");
  });

  it("includes consent_history and audit_log sections", async () => {
    seedCustomer(TEST_ACCOUNT);
    const jwt = makeJwt(TEST_ACCOUNT);

    // Seed a consent record
    await testNoticeStore.publishNotice({
      version: 1,
      effectiveDate: "2026-01-01",
      noticeText: "Privacy notice v1",
      summaryOfChanges: "Initial notice",
      createdBy: "ops@afropay.io",
    });
    await testNoticeStore.recordConsent({ account: TEST_ACCOUNT, noticeVersion: 1 });

    const res = await request(app)
      .post("/api/v1/privacy/dsar")
      .set("Authorization", `Bearer ${jwt}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.consent_history)).toBe(true);
    expect(res.body.consent_history[0].notice_version).toBe(1);
    expect(Array.isArray(res.body.audit_log)).toBe(true);
  });

  it("returns 200 even when the user has no customer records (empty export)", async () => {
    const jwt = makeJwt(TEST_ACCOUNT);
    const res = await request(app)
      .post("/api/v1/privacy/dsar")
      .set("Authorization", `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(res.body.kyc_profiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Erasure endpoint
// ---------------------------------------------------------------------------

describe("POST /api/v1/privacy/erasure", () => {
  it("returns 403 when no JWT is provided", async () => {
    const res = await request(app).post("/api/v1/privacy/erasure");
    expect(res.status).toBe(403);
  });

  it("returns 404 when the account has no customer records", async () => {
    const jwt = makeJwt(TEST_ACCOUNT);
    const res = await request(app)
      .post("/api/v1/privacy/erasure")
      .set("Authorization", `Bearer ${jwt}`);
    expect(res.status).toBe(404);
  });

  it("pseudonymizes all PII fields and returns an erasure summary", async () => {
    const customer = seedCustomer(TEST_ACCOUNT);
    const jwt = makeJwt(TEST_ACCOUNT);

    const res = await request(app)
      .post("/api/v1/privacy/erasure")
      .set("Authorization", `Bearer ${jwt}`)
      .set("Idempotency-Key", "test-idem-erasure-1");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("erased");
    expect(res.body.erased_customer_ids).toContain(customer.id);
    expect(res.body.fields_erased).toContain("first_name");
    expect(res.body.fields_erased).toContain("bvn");
    expect(res.body.total_fields_erased).toBeGreaterThan(0);
  });

  it("PII fields in the store are replaced with HMAC pseudonyms after erasure", async () => {
    const customer = seedCustomer(TEST_ACCOUNT);
    const jwt = makeJwt(TEST_ACCOUNT);

    await request(app)
      .post("/api/v1/privacy/erasure")
      .set("Authorization", `Bearer ${jwt}`);

    const stored = customers.get(customer.id)!;
    expect(stored.fields.first_name).toMatch(/^erased:/);
    expect(stored.fields.last_name).toMatch(/^erased:/);
    expect(stored.fields.bvn).toMatch(/^erased:/);
    expect(stored.fields.email_address).toMatch(/^erased:/);
  });

  it("retains transaction records for CBN reporting (amounts and timestamps intact)", async () => {
    seedCustomer(TEST_ACCOUNT);
    const tx = seedTransaction(TEST_ACCOUNT);
    const jwt = makeJwt(TEST_ACCOUNT);

    await request(app)
      .post("/api/v1/privacy/erasure")
      .set("Authorization", `Bearer ${jwt}`);

    // Transaction record must not be altered
    const storedTx = transactions.get(tx.id)!;
    expect(storedTx.amount_in).toBe("100.00");
    expect(storedTx.started_at).toBe(tx.started_at);
    expect(storedTx.completed_at).toBe(tx.completed_at);
  });

  it("sets regulatory_hold=true when the account has transactions", async () => {
    seedCustomer(TEST_ACCOUNT);
    seedTransaction(TEST_ACCOUNT);
    const jwt = makeJwt(TEST_ACCOUNT);

    const res = await request(app)
      .post("/api/v1/privacy/erasure")
      .set("Authorization", `Bearer ${jwt}`);

    expect(res.body.regulatory_hold).toBe(true);
    expect(res.body.regulatory_hold_reason).toContain("CBN");
  });

  it("sets regulatory_hold=false when the account has no transactions", async () => {
    seedCustomer(TEST_ACCOUNT);
    const jwt = makeJwt(TEST_ACCOUNT);

    const res = await request(app)
      .post("/api/v1/privacy/erasure")
      .set("Authorization", `Bearer ${jwt}`);

    expect(res.body.regulatory_hold).toBe(false);
  });

  it("is idempotent — second erasure does not change already-pseudonymized fields", async () => {
    seedCustomer(TEST_ACCOUNT);
    const jwt = makeJwt(TEST_ACCOUNT);

    await request(app)
      .post("/api/v1/privacy/erasure")
      .set("Authorization", `Bearer ${jwt}`);

    // Capture the pseudonymized state after first call
    const customerId = [...customers.keys()][0];
    const afterFirst = { ...customers.get(customerId)!.fields };

    // Second call
    const res2 = await request(app)
      .post("/api/v1/privacy/erasure")
      .set("Authorization", `Bearer ${jwt}`);

    expect(res2.status).toBe(200);
    const afterSecond = { ...customers.get(customerId)!.fields };
    expect(afterSecond).toEqual(afterFirst);
  });

  it("writes an audit entry recording the erasure action", async () => {
    seedCustomer(TEST_ACCOUNT);
    const jwt = makeJwt(TEST_ACCOUNT);

    await request(app)
      .post("/api/v1/privacy/erasure")
      .set("Authorization", `Bearer ${jwt}`);

    const entries = testAuditLogger.entries.filter(
      (e) => e.metadata?.action === "erasure"
    );
    expect(entries.length).toBe(1);
    expect(entries[0].purpose).toBe("dsar_export");
  });
});

// ---------------------------------------------------------------------------
// Consent endpoints
// ---------------------------------------------------------------------------

describe("GET /api/v1/privacy/consent", () => {
  it("returns current_notice_version=null and has_consented_to_current=false when no notice published", async () => {
    const jwt = makeJwt(TEST_ACCOUNT);
    const res = await request(app)
      .get("/api/v1/privacy/consent")
      .set("Authorization", `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(res.body.current_notice_version).toBeNull();
    expect(res.body.has_consented_to_current).toBe(false);
  });

  it("returns requires_re_consent=true for a user who has not yet consented", async () => {
    await testNoticeStore.publishNotice({
      version: 1,
      effectiveDate: "2026-01-01",
      noticeText: "v1 text",
      summaryOfChanges: "",
      createdBy: "ops",
    });
    const jwt = makeJwt(TEST_ACCOUNT);
    const res = await request(app)
      .get("/api/v1/privacy/consent")
      .set("Authorization", `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(res.body.current_notice_version).toBe(1);
    expect(res.body.requires_re_consent).toBe(true);
    expect(res.body.has_consented_to_current).toBe(false);
  });
});

describe("POST /api/v1/privacy/consent", () => {
  it("records consent and returns confirmation", async () => {
    await testNoticeStore.publishNotice({
      version: 1,
      effectiveDate: "2026-01-01",
      noticeText: "v1 text",
      summaryOfChanges: "",
      createdBy: "ops",
    });
    const jwt = makeJwt(TEST_ACCOUNT);
    const res = await request(app)
      .post("/api/v1/privacy/consent")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.notice_version).toBe(1);
    expect(res.body.account).toBe(TEST_ACCOUNT);
    expect(res.body.consented_at).toBeDefined();
  });

  it("returns 400 for a missing or invalid version", async () => {
    const jwt = makeJwt(TEST_ACCOUNT);
    const res = await request(app)
      .post("/api/v1/privacy/consent")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ version: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a version that has not been published", async () => {
    const jwt = makeJwt(TEST_ACCOUNT);
    const res = await request(app)
      .post("/api/v1/privacy/consent")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ version: 99 });
    expect(res.status).toBe(404);
  });

  it("after consent, GET /consent returns has_consented_to_current=true", async () => {
    await testNoticeStore.publishNotice({
      version: 1,
      effectiveDate: "2026-01-01",
      noticeText: "v1",
      summaryOfChanges: "",
      createdBy: "ops",
    });
    const jwt = makeJwt(TEST_ACCOUNT);
    await request(app)
      .post("/api/v1/privacy/consent")
      .set("Authorization", `Bearer ${jwt}`)
      .send({ version: 1 });

    const res = await request(app)
      .get("/api/v1/privacy/consent")
      .set("Authorization", `Bearer ${jwt}`);
    expect(res.body.has_consented_to_current).toBe(true);
    expect(res.body.requires_re_consent).toBe(false);
  });
});
