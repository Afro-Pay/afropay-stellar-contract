/**
 * Integration tests for the SEP-10 Ed25519 middleware (Issue #7).
 *
 * Acceptance criteria verified here:
 *  ✓ POST /api/v1/escrow/:id/release and /dispute return 401 without a valid SEP-10 JWT
 *  ✓ JWT signature verified against anchor public key fetched from stellar.toml (not hardcoded)
 *  ✓ All 4 token scenarios pass: valid, expired, tampered signature, missing header
 *  ✓ Anchor public key cached for 1 h — TOML endpoint called exactly once for two
 *    sequential requests within the cache window
 *  ✓ No secrets hardcoded — all config via environment variables
 *
 * Approach:
 *  - Use Node.js `crypto.generateKeyPairSync('ed25519')` to create a throw-away
 *    Ed25519 keypair for the test suite.
 *  - Convert the raw public key to a Stellar G… address via StrKey so it passes
 *    the `sub` validation and matches the SIGNING_KEY the middleware fetches.
 *  - Pre-seed `setTomlKeyCache` in beforeEach to avoid real HTTP round-trips.
 *  - For the caching test, spin up a local HTTP server serving a mock stellar.toml
 *    and count how many times the endpoint is called.
 */

import * as crypto from "crypto";
import * as http from "http";
import request from "supertest";
import { Express } from "express";
import { StrKey } from "@stellar/stellar-sdk";
import { setTomlKeyCache } from "../middleware/sep10";

// ---------------------------------------------------------------------------
// Test Ed25519 keypair — generated once per suite
// ---------------------------------------------------------------------------

const { privateKey: testPrivateKey, publicKey: testPublicKey } =
  crypto.generateKeyPairSync("ed25519");

/** Convert the test public key to a Stellar G… address for use as SIGNING_KEY. */
const testPublicKeySpki = testPublicKey.export({ type: "spki", format: "der" }) as Buffer;
const testRawPublicKey = testPublicKeySpki.slice(-32);
const testStellarPublicKey: string = StrKey.encodeEd25519PublicKey(testRawPublicKey);

// A valid Stellar G… account to use as the JWT `sub`
const VALID_SUB = testStellarPublicKey;

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/** Sign a minimal EdDSA JWT with the test private key. */
function signEdDsaJwt(
  sub: string,
  opts: { expired?: boolean } = {}
): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = opts.expired ? now - 60 : now + 3600;
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, iat: now, exp })).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const sig = crypto.sign(null, Buffer.from(sigInput), testPrivateKey);
  return `${sigInput}.${sig.toString("base64url")}`;
}

/** Return a copy of the token with the signature's first byte flipped. */
function tamperedToken(token: string): string {
  const parts = token.split(".");
  const sigBytes = Buffer.from(parts[2], "base64url");
  sigBytes[0] ^= 0xff;
  parts[2] = sigBytes.toString("base64url");
  return parts.join(".");
}

// ---------------------------------------------------------------------------
// App setup — rebuild app before each test with fresh module cache
// ---------------------------------------------------------------------------

let app: Express;

beforeEach(async () => {
  jest.resetModules();

  // Pre-seed the TOML key cache — prevents real HTTP fetch in most tests
  const { setTomlKeyCache: freshSetCache } = await import("../middleware/sep10");
  freshSetCache({
    publicKey: testStellarPublicKey,
    expiresAt: Date.now() + 3_600_000,
  });

  const { buildApp } = await import("../app");
  app = buildApp();
});

afterEach(() => {
  setTomlKeyCache(null);
  delete process.env.ANCHOR_DOMAIN;
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
async function createEscrow(): Promise<string> {
  const res = await request(app)
    .post("/api/v1/escrow")
    .send({
      sender_account: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
      corridor: "USD_NGN",
      amount_usdc: "100",
    });
  if (res.status !== 201) {
    throw new Error(`createEscrow failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.escrow_id as string;
}

// ===========================================================================
// Scenario 1 — Missing Authorization header → 401
// ===========================================================================
describe("missing Authorization header", () => {
  it("POST /release returns 401 without token", async () => {
    const id = await createEscrow();
    const res = await request(app).post(`/api/v1/escrow/${id}/release`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing Authorization/i);
  });

  it("POST /dispute returns 401 without token", async () => {
    const id = await createEscrow();
    const res = await request(app).post(`/api/v1/escrow/${id}/dispute`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing Authorization/i);
  });
});

// ===========================================================================
// Scenario 2 — Valid EdDSA token → 200
// ===========================================================================
describe("valid EdDSA SEP-10 token", () => {
  it("POST /release returns 200 and transitions escrow to Released", async () => {
    const id = await createEscrow();
    const token = signEdDsaJwt(VALID_SUB);
    const res = await request(app)
      .post(`/api/v1/escrow/${id}/release`)
      .set("Authorization", `Bearer ${token}`);
    if (res.status !== 200) console.log("ERROR BODY:", res.body);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("Released");
  });

  it("POST /dispute returns 200 and transitions escrow to Refundable", async () => {
    const id = await createEscrow();
    const token = signEdDsaJwt(VALID_SUB);
    const res = await request(app)
      .post(`/api/v1/escrow/${id}/dispute`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("Refundable");
  });
});

// ===========================================================================
// Scenario 3 — Expired token → 401
// ===========================================================================
describe("expired SEP-10 token", () => {
  it("POST /release returns 401 with expiry error", async () => {
    const id = await createEscrow();
    const token = signEdDsaJwt(VALID_SUB, { expired: true });
    const res = await request(app)
      .post(`/api/v1/escrow/${id}/release`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  it("POST /dispute returns 401 with expiry error", async () => {
    const id = await createEscrow();
    const token = signEdDsaJwt(VALID_SUB, { expired: true });
    const res = await request(app)
      .post(`/api/v1/escrow/${id}/dispute`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });
});

// ===========================================================================
// Scenario 4 — Tampered signature → 401
// ===========================================================================
describe("tampered JWT signature", () => {
  it("POST /release returns 401 when signature is tampered", async () => {
    const id = await createEscrow();
    const token = tamperedToken(signEdDsaJwt(VALID_SUB));
    const res = await request(app)
      .post(`/api/v1/escrow/${id}/release`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/verification failed|invalid/i);
  });

  it("POST /dispute returns 401 when signature is tampered", async () => {
    const id = await createEscrow();
    const token = tamperedToken(signEdDsaJwt(VALID_SUB));
    const res = await request(app)
      .post(`/api/v1/escrow/${id}/dispute`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/verification failed|invalid/i);
  });
});

// ===========================================================================
// TOML key caching — called exactly once for two requests within the window
// ===========================================================================
describe("anchor public key TOML caching", () => {
  it("fetches stellar.toml exactly once for two consecutive requests within the 1-hour TTL", async () => {
    // Clear the pre-seeded cache so the middleware actually fetches
    setTomlKeyCache(null);

    let tomlFetchCount = 0;
    const tomlServer = http.createServer((req, res) => {
      if (req.url === "/.well-known/stellar.toml") {
        tomlFetchCount++;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(`SIGNING_KEY = "${testStellarPublicKey}"\n`);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => tomlServer.listen(0, "127.0.0.1", resolve));
    const { port } = tomlServer.address() as { port: number };
    process.env.ANCHOR_DOMAIN = `localhost:${port}`;

    // Rebuild app + clear cache with fresh modules so ANCHOR_DOMAIN is picked up
    jest.resetModules();
    const { setTomlKeyCache: freshSet } = await import("../middleware/sep10");
    freshSet(null);
    const { buildApp: freshBuild } = await import("../app");
    const freshApp = freshBuild();

    async function makeEscrow(): Promise<string> {
      const r = await request(freshApp)
        .post("/api/v1/escrow")
        .send({
          sender_account: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
          corridor: "USD_NGN",
          amount_usdc: "50",
        });
      return r.body.escrow_id as string;
    }

    const token = signEdDsaJwt(VALID_SUB);
    const id1 = await makeEscrow();
    const id2 = await makeEscrow();

    // First request — should trigger exactly one TOML fetch
    const res1 = await request(freshApp)
      .post(`/api/v1/escrow/${id1}/release`)
      .set("Authorization", `Bearer ${token}`);
    expect(res1.status).toBe(200);

    // Second request within the 1-hour window — must NOT trigger another fetch
    const res2 = await request(freshApp)
      .post(`/api/v1/escrow/${id2}/release`)
      .set("Authorization", `Bearer ${token}`);
    expect(res2.status).toBe(200);

    expect(tomlFetchCount).toBe(1);

    await new Promise<void>((resolve) => tomlServer.close(() => resolve()));
  });
});

// ===========================================================================
// Unprotected endpoints are unaffected
// ===========================================================================
describe("unprotected endpoints", () => {
  it("POST /api/v1/escrow (create) works without a token", async () => {
    const res = await request(app)
      .post("/api/v1/escrow")
      .send({
        sender_account: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
        corridor: "EUR_GHS",
        amount_usdc: "200",
      });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("escrow_id");
  });

  it("GET /api/v1/escrow/:id (poll) works without a token", async () => {
    const id = await createEscrow();
    const res = await request(app).get(`/api/v1/escrow/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("Funded");
  });
});
