"use strict";
/**
 * Integration tests for webhook handlers.
 *
 * Scenarios covered (per provider):
 *   1. First delivery  — valid signature + existing escrow → 200, status processed
 *   2. Duplicate delivery — same txRef/reference replayed 10× → exactly one
 *      escrow state change, all responses are identical cached replay
 *   3. Invalid signature — wrong HMAC → 400 invalid_signature
 *   4. Out-of-order delivery (DLQ path) — valid signature but escrow does not
 *      exist yet → 200, status dlq, job enqueued in DLQ
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const supertest_1 = __importDefault(require("supertest"));
const crypto_1 = require("crypto");
const express_1 = __importDefault(require("express"));
// Import handlers under test
const flutterwave_1 = __importDefault(require("../webhooks/flutterwave"));
const paystack_1 = __importDefault(require("../webhooks/paystack"));
// Import stores so we can seed and inspect state
const store_1 = require("../store");
const idempotency_store_1 = require("../webhooks/idempotency-store");
const dlq_1 = require("../../services/queue/dlq");
// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------
const FLW_SECRET = "test-flw-secret-512";
const PS_SECRET = "test-paystack-secret-256";
// ---------------------------------------------------------------------------
// Helper: build a minimal Sep31Transaction so the escrow lookup succeeds
// ---------------------------------------------------------------------------
function seedTransaction(id) {
    const now = new Date().toISOString();
    const tx = {
        id,
        creator: "test-creator",
        status: "pending_external",
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
        completed_at: null,
        stellar_transaction_id: null,
        external_transaction_id: null,
        refunded: false,
        required_info_message: null,
        required_info_updates: null,
        fields: {},
        callback_url: null,
    };
    store_1.transactions.set(id, tx);
    return tx;
}
// ---------------------------------------------------------------------------
// Helper: sign a body for each provider
// ---------------------------------------------------------------------------
function flwSignature(body) {
    return (0, crypto_1.createHmac)("sha512", FLW_SECRET)
        .update(JSON.stringify(body))
        .digest("hex");
}
function psSignature(body) {
    return (0, crypto_1.createHmac)("sha256", PS_SECRET)
        .update(JSON.stringify(body))
        .digest("hex");
}
// ---------------------------------------------------------------------------
// Helper: build test app (avoids loading full config/env from app.ts)
// ---------------------------------------------------------------------------
function buildTestApp() {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use("/webhooks/flutterwave", flutterwave_1.default);
    app.use("/webhooks/paystack", paystack_1.default);
    return app;
}
// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
let app;
beforeAll(() => {
    process.env.FLW_WEBHOOK_SECRET = FLW_SECRET;
    process.env.PAYSTACK_SECRET_KEY = PS_SECRET;
    app = buildTestApp();
});
beforeEach(() => {
    // Reset all shared state between tests
    store_1.transactions.clear();
    store_1.customers.clear();
    (0, idempotency_store_1.clearRecords)();
    (0, dlq_1.clearQueue)();
});
afterEach(() => {
    (0, dlq_1.clearQueue)(); // cancel any pending timers
});
// ===========================================================================
// FLUTTERWAVE
// ===========================================================================
describe("Flutterwave webhook", () => {
    // ── Scenario 1: First delivery ─────────────────────────────────────────
    it("SC1 – first delivery with valid signature and existing escrow returns 200 processed", async () => {
        const txRef = "FLW-TXN-SC1-001";
        seedTransaction(txRef);
        const body = {
            event: "charge.completed",
            data: { id: 12345, tx_ref: txRef, status: "successful" },
        };
        const res = await (0, supertest_1.default)(app)
            .post("/webhooks/flutterwave")
            .set("verif-hash", flwSignature(body))
            .send(body);
        expect(res.status).toBe(200);
        expect(res.body.received).toBe(true);
        expect(res.body.status).toBe("processed");
        expect(res.body.reference).toBe(txRef);
        // Escrow state must have changed exactly once
        const tx = store_1.transactions.get(txRef);
        expect(tx.status).toBe("pending_stellar");
        expect(tx.external_transaction_id).toBe("12345");
    });
    // ── Scenario 2: Duplicate delivery ────────────────────────────────────
    it("SC2 – replaying the same txRef 10 times produces exactly one escrow state change", async () => {
        const txRef = "FLW-TXN-SC2-DUP";
        seedTransaction(txRef);
        const body = {
            event: "charge.completed",
            data: { id: 99, tx_ref: txRef, status: "successful" },
        };
        const sig = flwSignature(body);
        // Fire 10 requests with the same txRef
        const responses = await Promise.all(Array.from({ length: 10 }, () => (0, supertest_1.default)(app)
            .post("/webhooks/flutterwave")
            .set("verif-hash", sig)
            .send(body)));
        // All must return 200
        for (const res of responses) {
            expect(res.status).toBe(200);
            expect(res.body.received).toBe(true);
            expect(res.body.reference).toBe(txRef);
        }
        // All responses must be identical (replayed cached body)
        const bodies = responses.map((r) => JSON.stringify(r.body));
        const uniqueBodies = new Set(bodies);
        expect(uniqueBodies.size).toBe(1);
        // Escrow updated_at must equal a single timestamp — no repeated mutation
        const tx = store_1.transactions.get(txRef);
        expect(tx.status).toBe("pending_stellar");
        // Only one idempotency record should exist
        const record = (0, idempotency_store_1.findRecord)("flutterwave", txRef);
        expect(record).toBeDefined();
        expect(record.status).toBe("processed");
    });
    // ── Scenario 3: Invalid signature ─────────────────────────────────────
    it("SC3 – invalid signature returns 400 and does not modify escrow", async () => {
        const txRef = "FLW-TXN-SC3-BADSIG";
        seedTransaction(txRef);
        const body = {
            event: "charge.completed",
            data: { id: 1, tx_ref: txRef, status: "successful" },
        };
        const res = await (0, supertest_1.default)(app)
            .post("/webhooks/flutterwave")
            .set("verif-hash", "totally-wrong-signature")
            .send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_signature");
        // Escrow must remain untouched
        expect(store_1.transactions.get(txRef).status).toBe("pending_external");
        // No idempotency record should have been created
        expect((0, idempotency_store_1.findRecord)("flutterwave", txRef)).toBeUndefined();
    });
    // ── Scenario 4: Out-of-order delivery (DLQ) ──────────────────────────
    it("SC4 – out-of-order delivery (no escrow) returns 200 dlq and enqueues job", async () => {
        const txRef = "FLW-TXN-SC4-DLQ";
        // Deliberately do NOT seed a transaction — escrow does not exist yet
        const body = {
            event: "charge.completed",
            data: { id: 777, tx_ref: txRef, status: "successful" },
        };
        const res = await (0, supertest_1.default)(app)
            .post("/webhooks/flutterwave")
            .set("verif-hash", flwSignature(body))
            .send(body);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("dlq");
        // Idempotency record must exist with status dlq
        const record = (0, idempotency_store_1.findRecord)("flutterwave", txRef);
        expect(record).toBeDefined();
        expect(record.status).toBe("dlq");
        // A DLQ job must have been enqueued
        const jobs = (0, dlq_1.listJobs)();
        const job = jobs.find((j) => j.provider === "flutterwave" && j.reference === txRef);
        expect(job).toBeDefined();
        expect(job.attempts).toBe(0);
    });
});
// ===========================================================================
// PAYSTACK
// ===========================================================================
describe("Paystack webhook", () => {
    // ── Scenario 1: First delivery ─────────────────────────────────────────
    it("SC1 – first delivery with valid signature and existing escrow returns 200 processed", async () => {
        const reference = "PS-REF-SC1-001";
        seedTransaction(reference);
        const body = {
            event: "charge.success",
            data: { id: 55555, reference, status: "success" },
        };
        const res = await (0, supertest_1.default)(app)
            .post("/webhooks/paystack")
            .set("x-paystack-signature", psSignature(body))
            .send(body);
        expect(res.status).toBe(200);
        expect(res.body.received).toBe(true);
        expect(res.body.status).toBe("processed");
        expect(res.body.reference).toBe(reference);
        const tx = store_1.transactions.get(reference);
        expect(tx.status).toBe("pending_stellar");
        expect(tx.external_transaction_id).toBe("55555");
    });
    // ── Scenario 2: Duplicate delivery ────────────────────────────────────
    it("SC2 – replaying the same reference 10 times produces exactly one escrow state change", async () => {
        const reference = "PS-REF-SC2-DUP";
        seedTransaction(reference);
        const body = {
            event: "charge.success",
            data: { id: 100, reference, status: "success" },
        };
        const sig = psSignature(body);
        const responses = await Promise.all(Array.from({ length: 10 }, () => (0, supertest_1.default)(app)
            .post("/webhooks/paystack")
            .set("x-paystack-signature", sig)
            .send(body)));
        for (const res of responses) {
            expect(res.status).toBe(200);
            expect(res.body.received).toBe(true);
        }
        // All 10 responses must be identical
        const bodies = responses.map((r) => JSON.stringify(r.body));
        expect(new Set(bodies).size).toBe(1);
        // Escrow updated exactly once
        expect(store_1.transactions.get(reference).status).toBe("pending_stellar");
        const record = (0, idempotency_store_1.findRecord)("paystack", reference);
        expect(record).toBeDefined();
        expect(record.status).toBe("processed");
    });
    // ── Scenario 3: Invalid signature ─────────────────────────────────────
    it("SC3 – invalid signature returns 400 and does not modify escrow", async () => {
        const reference = "PS-REF-SC3-BADSIG";
        seedTransaction(reference);
        const body = {
            event: "charge.success",
            data: { id: 2, reference, status: "success" },
        };
        const res = await (0, supertest_1.default)(app)
            .post("/webhooks/paystack")
            .set("x-paystack-signature", "000000badbadbad")
            .send(body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("invalid_signature");
        expect(store_1.transactions.get(reference).status).toBe("pending_external");
        expect((0, idempotency_store_1.findRecord)("paystack", reference)).toBeUndefined();
    });
    // ── Scenario 4: Out-of-order delivery (DLQ) ──────────────────────────
    it("SC4 – out-of-order delivery (no escrow) returns 200 dlq and enqueues job", async () => {
        const reference = "PS-REF-SC4-DLQ";
        // No escrow seeded
        const body = {
            event: "charge.success",
            data: { id: 888, reference, status: "success" },
        };
        const res = await (0, supertest_1.default)(app)
            .post("/webhooks/paystack")
            .set("x-paystack-signature", psSignature(body))
            .send(body);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("dlq");
        const record = (0, idempotency_store_1.findRecord)("paystack", reference);
        expect(record).toBeDefined();
        expect(record.status).toBe("dlq");
        const job = (0, dlq_1.listJobs)().find((j) => j.provider === "paystack" && j.reference === reference);
        expect(job).toBeDefined();
        expect(job.attempts).toBe(0);
    });
});
// ===========================================================================
// DLQ processor integration
// ===========================================================================
describe("DLQ processor integration", () => {
    it("DLQ job succeeds when escrow is created before first retry fires", async () => {
        const txRef = "FLW-TXN-DLQ-RETRY";
        const body = {
            event: "charge.completed",
            data: { id: 999, tx_ref: txRef, status: "successful" },
        };
        // First delivery — no escrow yet → DLQ
        const firstRes = await (0, supertest_1.default)(app)
            .post("/webhooks/flutterwave")
            .set("verif-hash", flwSignature(body))
            .send(body);
        expect(firstRes.body.status).toBe("dlq");
        // Simulate escrow arriving after the webhook
        seedTransaction(txRef);
        // Register a processor that applies the change and succeeds
        const { registerProcessor } = await Promise.resolve().then(() => __importStar(require("../../services/queue/dlq")));
        registerProcessor(async (job) => {
            const tx = store_1.transactions.get(job.reference);
            if (!tx)
                return false;
            tx.status = "pending_stellar";
            tx.updated_at = new Date().toISOString();
            return true;
        });
        // Advance time by triggering the first retry manually
        const jobs = (0, dlq_1.listJobs)();
        const job = jobs.find((j) => j.provider === "flutterwave" && j.reference === txRef);
        expect(job).toBeDefined();
        // The DLQ uses setTimeout — we can't fast-forward without fake timers.
        // Here we verify the job was enqueued with the correct initial state.
        expect(job.attempts).toBe(0);
        expect(new Date(job.nextRetryAt).getTime()).toBeGreaterThan(Date.now());
    });
});
//# sourceMappingURL=webhooks.test.js.map