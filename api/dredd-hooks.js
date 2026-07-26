/**
 * api/dredd-hooks.js
 *
 * Dredd lifecycle hooks for the AfroPay API contract tests.
 *
 * Responsibilities:
 *  - Skip endpoints that Dredd cannot drive (SSE stream, stellar.toml plain text, Prometheus metrics)
 *  - Seed shared test data (escrow IDs, customer IDs, transaction IDs) that
 *    subsequent test transactions depend on
 *  - Inject valid auth tokens, idempotency keys, and signature headers so
 *    every request satisfies the API's auth requirements
 *
 * Run by:  dredd api/openapi.yaml http://localhost:8000 --hookfiles api/dredd-hooks.js
 */

"use strict";

const hooks = require("hooks");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a fresh UUID v4. */
function uuid() {
  return crypto.randomUUID();
}

/** Build an HMAC-SHA256 hex digest (Paystack signature). */
function hmacSha256Hex(body, secret) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/** Build an HMAC-SHA512 hex digest (Flutterwave signature). */
function hmacSha512Hex(body, secret) {
  return crypto.createHmac("sha512", secret).update(body).digest("hex");
}

/** Post JSON to the running API and return parsed body + status. */
function apiPost(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: "localhost",
      port: 8000,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Idempotency-Key": uuid(),
        ...headers,
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** Get from the running API. */
function apiGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "localhost",
      port: 8000,
      path,
      method: "GET",
      headers,
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Shared test state — populated during beforeAll / seeding hooks
// ---------------------------------------------------------------------------
const state = {
  sep10Token: null,
  customerId: null,
  receiverId: null,
  transactionId: null,
  escrowId: null,
  tierId: null,
};

// ---------------------------------------------------------------------------
// Skip endpoints Dredd cannot drive
// ---------------------------------------------------------------------------
const SKIP_OPERATIONS = [
  // SSE — cannot be driven by HTTP request/response
  "streamEscrowEvents",
  // Prometheus text format — Dredd expects JSON
  "getMetrics",
  // stellar.toml — text/plain, not JSON
  "getStellarToml",
  // Admin endpoint requires out-of-band admin JWT — skipped in CI
  "runReconciliation",
];

SKIP_OPERATIONS.forEach((operationId) => {
  hooks.before(`${operationId} > *`, (transaction, done) => {
    transaction.skip = true;
    done();
  });
});

// Also skip by URL pattern for robustness
hooks.beforeEach((transaction, done) => {
  if (
    transaction.request.uri.includes("/stream") ||
    transaction.request.uri.includes("/metrics") ||
    transaction.request.uri.includes("stellar.toml") ||
    transaction.request.uri.includes("/admin/")
  ) {
    transaction.skip = true;
  }
  // Inject Idempotency-Key on every mutating request
  const method = transaction.request.method.toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    transaction.request.headers["Idempotency-Key"] = uuid();
  }
  done();
});

// ---------------------------------------------------------------------------
// beforeAll: obtain SEP-10 JWT and seed shared resources
// ---------------------------------------------------------------------------
hooks.beforeAll(async (transactions, done) => {
  try {
    // ── 1. Obtain SEP-10 JWT ─────────────────────────────────────────────
    // In CI the test keypair seed is in SEP10_SIGNING_SEED env var.
    // We cannot actually sign a challenge transaction in a hook without the
    // full Stellar SDK, so we use a pre-signed stub token that the test
    // server accepts when JWT_SECRET is the known test value.
    //
    // For real integration: call GET /auth?account=G..., sign with the
    // test keypair, then POST /auth to exchange for a token.
    //
    // We derive a minimal valid JWT manually using the test JWT_SECRET.
    const jwtSecret = process.env.JWT_SECRET || "test-jwt-secret-32-bytes-min-len";
    const testAccount = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const iat = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        iss: "http://localhost:8000/auth",
        sub: testAccount,
        iat,
        exp: iat + 86400,
        jti: crypto.randomBytes(16).toString("hex"),
      })
    ).toString("base64url");
    const sig = crypto
      .createHmac("sha256", jwtSecret)
      .update(`${header}.${payload}`)
      .digest("base64url");
    state.sep10Token = `${header}.${payload}.${sig}`;

    // ── 2. Seed a KYC customer (sender) ──────────────────────────────────
    const senderResp = await apiPost(
      "/kyc/customer",
      {
        first_name: "Amara",
        last_name: "Okafor",
        email_address: "amara.okafor@dredd.test",
      },
      { Authorization: `Bearer ${state.sep10Token}` }
    );
    if (senderResp.status === 202) {
      state.customerId = senderResp.body.id;
    }

    // ── 3. Seed a KYC customer (receiver) ────────────────────────────────
    // Use a second token representing a different account for the receiver
    const receiverPayload = Buffer.from(
      JSON.stringify({
        iss: "http://localhost:8000/auth",
        sub: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        iat,
        exp: iat + 86400,
        jti: crypto.randomBytes(16).toString("hex"),
      })
    ).toString("base64url");
    const receiverSig = crypto
      .createHmac("sha256", jwtSecret)
      .update(`${header}.${receiverPayload}`)
      .digest("base64url");
    const receiverToken = `${header}.${receiverPayload}.${receiverSig}`;

    const receiverResp = await apiPost(
      "/kyc/customer",
      {
        first_name: "Chidi",
        last_name: "Nwosu",
        email_address: "chidi.nwosu@dredd.test",
      },
      { Authorization: `Bearer ${receiverToken}` }
    );
    if (receiverResp.status === 202) {
      state.receiverId = receiverResp.body.id;
    }

    // ── 4. Seed a SEP-31 transaction ─────────────────────────────────────
    if (state.customerId && state.receiverId) {
      const txResp = await apiPost(
        "/sep31/transactions",
        {
          asset_code: "USDC",
          amount: "50.00",
          sender_id: state.customerId,
          receiver_id: state.receiverId,
          fields: {
            transaction: { receiver_account_number: "0123456789" },
          },
        },
        { Authorization: `Bearer ${state.sep10Token}` }
      );
      if (txResp.status === 201) {
        state.transactionId = txResp.body.id;
      }
    }

    // ── 5. Seed an escrow ────────────────────────────────────────────────
    const escrowResp = await apiPost("/api/v1/escrow", {
      sender_account: testAccount,
      corridor: "USD_NGN",
      amount_usdc: 25.0,
    });
    if (escrowResp.status === 201) {
      state.escrowId = escrowResp.body.escrow_id;
    }

    // ── 6. Seed a content tier ───────────────────────────────────────────
    const tierResp = await apiPost(
      "/api/v1/tiers",
      { name: "Dredd Test Tier" },
      { "X-Stellar-Account": testAccount }
    );
    if (tierResp.status === 201) {
      state.tierId = tierResp.body.tier?.id;
    }

    done();
  } catch (err) {
    done(err);
  }
});

// ---------------------------------------------------------------------------
// Per-transaction auth injection
// ---------------------------------------------------------------------------

// SEP-10 / SEP-12 / SEP-31 — inject Bearer token
[
  "sep12GetCustomer",
  "sep12PutCustomer",
  "sep12DeleteCustomer",
  "sep31CreateTransaction",
  "sep31GetTransaction",
  "sep31PatchTransaction",
  "sep31SetCallback",
  "releaseEscrow",
  "disputeEscrow",
].forEach((opId) => {
  hooks.before(`${opId} > *`, (transaction, done) => {
    transaction.request.headers["Authorization"] = `Bearer ${state.sep10Token}`;
    done();
  });
});

// Content tiers — inject X-Stellar-Account header
[
  "createTier",
  "uploadTierContent",
  "getTierContentKey",
  "rotateTierContentKey",
].forEach((opId) => {
  hooks.before(`${opId} > *`, (transaction, done) => {
    transaction.request.headers["X-Stellar-Account"] =
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    done();
  });
});

// ---------------------------------------------------------------------------
// Inject seeded IDs into path parameters
// ---------------------------------------------------------------------------

hooks.before("sep31GetTransaction > *", (transaction, done) => {
  if (state.transactionId) {
    transaction.request.uri = transaction.request.uri.replace(
      /\/sep31\/transactions\/[^/]+/,
      `/sep31/transactions/${state.transactionId}`
    );
    transaction.fullPath = transaction.request.uri;
  }
  done();
});

hooks.before("sep31PatchTransaction > *", (transaction, done) => {
  if (state.transactionId) {
    transaction.request.uri = transaction.request.uri.replace(
      /\/sep31\/transactions\/[^/]+/,
      `/sep31/transactions/${state.transactionId}`
    );
    transaction.fullPath = transaction.request.uri;
  }
  done();
});

hooks.before("sep31SetCallback > *", (transaction, done) => {
  if (state.transactionId) {
    transaction.request.uri = transaction.request.uri.replace(
      /\/sep31\/transactions\/[^/]+/,
      `/sep31/transactions/${state.transactionId}`
    );
    transaction.fullPath = transaction.request.uri;
  }
  done();
});

hooks.before("getEscrow > *", (transaction, done) => {
  if (state.escrowId) {
    transaction.request.uri = transaction.request.uri.replace(
      /\/api\/v1\/escrow\/[^/]+$/,
      `/api/v1/escrow/${state.escrowId}`
    );
    transaction.fullPath = transaction.request.uri;
  }
  done();
});

hooks.before("releaseEscrow > *", (transaction, done) => {
  if (state.escrowId) {
    transaction.request.uri = `/api/v1/escrow/${state.escrowId}/release`;
    transaction.fullPath = transaction.request.uri;
  }
  done();
});

hooks.before("disputeEscrow > *", (transaction, done) => {
  // Seed a fresh escrow specifically for the dispute test
  // (release may have already consumed the shared one)
  apiPost("/api/v1/escrow", {
    sender_account: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    corridor: "EUR_GHS",
    amount_usdc: 10.0,
  }).then((resp) => {
    if (resp.status === 201) {
      transaction.request.uri = `/api/v1/escrow/${resp.body.escrow_id}/dispute`;
      transaction.fullPath = transaction.request.uri;
    }
    done();
  }).catch(done);
});

hooks.before("uploadTierContent > *", (transaction, done) => {
  if (state.tierId) {
    transaction.request.uri = `/api/v1/tiers/${state.tierId}/content`;
    transaction.fullPath = transaction.request.uri;
    transaction.request.body = JSON.stringify({ contentUrl: "https://cdn.example.com/video.mp4" });
  }
  done();
});

hooks.before("getTierContentKey > *", (transaction, done) => {
  if (state.tierId) {
    // First create a pass so the fan has access
    apiPost("/api/v1/tiers/passes", {
      fanAccount: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      tierId: state.tierId,
    }).then(() => {
      transaction.request.uri = `/api/v1/tiers/${state.tierId}/content/key?fanPublicKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
      transaction.fullPath = transaction.request.uri;
      transaction.request.headers["X-Stellar-Account"] =
        "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
      done();
    }).catch(done);
  } else {
    done();
  }
});

hooks.before("rotateTierContentKey > *", (transaction, done) => {
  if (state.tierId) {
    transaction.request.uri = `/api/v1/tiers/${state.tierId}/content/rotate-key`;
    transaction.fullPath = transaction.request.uri;
  }
  done();
});

// ---------------------------------------------------------------------------
// Webhook signature injection
// ---------------------------------------------------------------------------

hooks.before("paystackWebhook > *", (transaction, done) => {
  const body = JSON.stringify({
    event: "charge.success",
    data: {
      id: 1234,
      reference: `dredd-test-${uuid()}`,
      status: "success",
    },
  });
  const secret = process.env.PAYSTACK_SECRET_KEY || "test-paystack-secret";
  const sig = hmacSha256Hex(body, secret);
  transaction.request.body = body;
  transaction.request.headers["x-paystack-signature"] = sig;
  transaction.request.headers["Content-Type"] = "application/json";
  done();
});

hooks.before("flutterwaveWebhook > *", (transaction, done) => {
  const txRef = `dredd-test-${uuid()}`;
  const body = JSON.stringify({
    event: "charge.completed",
    data: {
      id: 5678,
      tx_ref: txRef,
      status: "successful",
    },
  });
  const secret = process.env.FLW_WEBHOOK_SECRET || "test-flutterwave-secret";
  const sig = hmacSha512Hex(body, secret);
  transaction.request.body = body;
  transaction.request.headers["verif-hash"] = sig;
  transaction.request.headers["Content-Type"] = "application/json";
  done();
});
