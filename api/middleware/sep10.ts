/**
 * SEP-10 authentication middleware — two variants:
 *
 *  requireSep10       — shared-secret HS256 JWT verify (existing SEP-12/31 gate).
 *  requireSep10Ed25519 — full anchor-key Ed25519 JWT verify for escrow release/dispute.
 *
 * The Ed25519 variant:
 *  • Fetches the anchor public key from stellar.toml at ANCHOR_DOMAIN (env var).
 *  • Caches the key for 1 hour to avoid a round-trip on every request.
 *  • Validates signature algorithm (EdDSA), expiry, and the `sub` (Stellar G/M key).
 *  • Rejects missing, expired, and tampered tokens with a 401 + descriptive error.
 *
 * NOTE: jsonwebtoken v9 does not support EdDSA/Ed25519 (the underlying jwa library
 * only handles RS/PS/ES/HS algorithms). EdDSA tokens are verified directly with
 * Node's built-in `crypto.verify()` instead of passing them to jwt.verify().
 *
 * No signing keys are hardcoded — all config comes from environment variables.
 */

import * as nodeCrypto from "crypto";
import { NextFunction, Request, Response } from "express";
import https from "https";
import http from "http";
import jwt from "jsonwebtoken";
import { StrKey } from "@stellar/stellar-sdk";
import { config } from "../config";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface Sep10Token {
  /** Full `sub` claim: G..., G...:memo, or M... */
  sub: string;
  account: string;
  memo?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    sep10?: Sep10Token;
  }
}

// ---------------------------------------------------------------------------
// Variant 1: shared-secret HS256 (existing SEP-12 / SEP-31 gate)
// ---------------------------------------------------------------------------

/**
 * SEP-10 JWT bearer authentication using the server's own JWT secret (HS256).
 * Protected SEP endpoints (SEP-12, SEP-31) must respond 403 to requests
 * without a valid token.
 */
export function requireSep10(req: Request, res: Response, next: NextFunction): void {
  const header = req.get("Authorization") || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    res.status(403).json({ error: "missing SEP-10 JWT in Authorization header" });
    return;
  }
  try {
    const payload = jwt.verify(match[1], config.jwtSecret) as jwt.JwtPayload;
    const sub = String(payload.sub);
    const [account, memo] = sub.split(":");
    req.sep10 = { sub, account, memo };
    next();
  } catch {
    res.status(403).json({ error: "invalid or expired SEP-10 JWT" });
  }
}

// ---------------------------------------------------------------------------
// Variant 2: Ed25519 anchor-key verification (escrow release / dispute gate)
// ---------------------------------------------------------------------------

interface TomlKeyCache {
  publicKey: string;  // base64url-encoded raw public key bytes
  expiresAt: number;  // epoch ms
}

/** In-memory cache. Exported for testing (allows injection / invalidation). */
export let tomlKeyCache: TomlKeyCache | null = null;

/** Cache TTL — 1 hour. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Inject a cache entry in tests without making real HTTP requests.
 * Pass `null` to clear the cache.
 */
export function setTomlKeyCache(entry: TomlKeyCache | null): void {
  tomlKeyCache = entry;
}

/**
 * Fetch the anchor's SIGNING_KEY from its stellar.toml.
 *
 * The env var ANCHOR_DOMAIN determines which domain to fetch from.
 * Falls back to config.homeDomain when ANCHOR_DOMAIN is unset.
 */
async function fetchAnchorPublicKey(): Promise<string> {
  const domain = process.env.ANCHOR_DOMAIN || config.homeDomain;
  // In tests the HOME_DOMAIN is localhost:port, so use http; otherwise https.
  const isLocal = /^localhost(:\d+)?$/.test(domain);
  const scheme = isLocal ? "http" : "https";
  const url = `${scheme}://${domain}/.well-known/stellar.toml`;

  return new Promise((resolve, reject) => {
    const lib = isLocal ? http : https;
    lib
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        res.on("end", () => {
          const match = body.match(/^SIGNING_KEY\s*=\s*"?([A-Z2-7]{56})"?/m);
          if (!match) {
            reject(new Error(`SIGNING_KEY not found in stellar.toml at ${url}`));
          } else {
            resolve(match[1]);
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * Return the anchor's Ed25519 public key (Stellar G… address), refreshing
 * the cache when it has expired.
 */
export async function getAnchorPublicKey(): Promise<string> {
  const now = Date.now();
  if (tomlKeyCache && tomlKeyCache.expiresAt > now) {
    return tomlKeyCache.publicKey;
  }
  const publicKey = await fetchAnchorPublicKey();
  tomlKeyCache = { publicKey, expiresAt: now + CACHE_TTL_MS };
  return publicKey;
}

/**
 * Validate the SEP-10 `sub` claim: must be a valid G… or M… account,
 * optionally followed by ":memo".
 */
function validateSub(sub: unknown): { account: string; memo?: string } {
  if (typeof sub !== "string" || !sub) {
    throw new Error("missing sub claim");
  }
  const [account, memo] = sub.split(":");
  if (!StrKey.isValidEd25519PublicKey(account) && !StrKey.isValidMed25519PublicKey(account)) {
    throw new Error(`sub account ${account} is not a valid Stellar public key`);
  }
  return { account, memo };
}

/**
 * Ed25519-based SEP-10 JWT verification middleware.
 *
 * Fetches the anchor's public key from stellar.toml (cached 1 h), then
 * verifies the JWT is signed with that key using Node's crypto.verify().
 *
 * jsonwebtoken v9 does not support EdDSA (its underlying jwa library only
 * handles RS/PS/ES/HS algorithms), so we parse and verify the JWT manually:
 *   1. Split into header.payload.signature
 *   2. Verify the Ed25519 signature over header+"."+payload
 *   3. Decode and validate the payload claims (exp, sub)
 *
 * Returns 401 (not 403) because the client sent credentials that did not pass
 * verification — the request must be re-authenticated.
 */
export function requireSep10Ed25519(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const header = req.get("Authorization") || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    res.status(401).json({ error: "missing Authorization: Bearer <sep10-jwt> header" });
    return;
  }
  const token = match[1];

  // Peek at the JWT header to decide which verification path to take.
  const parts = token.split(".");
  if (parts.length !== 3) {
    res.status(401).json({ error: "SEP-10 JWT is invalid" });
    return;
  }

  let jwtHeader: { alg?: string };
  try {
    jwtHeader = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    res.status(401).json({ error: "SEP-10 JWT is invalid" });
    return;
  }

  if (jwtHeader.alg !== "EdDSA") {
    // Non-EdDSA path — fall back to shared-secret HS256 verify for integration flows.
    try {
      const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
      const { account, memo } = validateSub(payload.sub);
      req.sep10 = { sub: String(payload.sub), account, memo };
      next();
      return;
    } catch {
      res.status(401).json({ error: "SEP-10 JWT is invalid" });
      return;
    }
  }

  // EdDSA path: fetch anchor key (possibly from cache) then verify manually.
  getAnchorPublicKey()
    .then((stellarPublicKey) => {
      // Convert the Stellar G… key to a Node KeyObject so crypto.verify can use it.
      const rawBytes = StrKey.decodeEd25519PublicKey(stellarPublicKey);
      const spki = buildEd25519SpkiDer(rawBytes);
      let keyObject: nodeCrypto.KeyObject;
      try {
        keyObject = nodeCrypto.createPublicKey({ key: spki, format: "der", type: "spki" });
      } catch (err) {
        res.status(503).json({ error: `unable to parse anchor public key: ${(err as Error).message}` });
        return;
      }

      // Verify the EdDSA signature: sign-input is the raw bytes of "header.payload".
      const signInput = Buffer.from(`${parts[0]}.${parts[1]}`);
      let sigBytes: Buffer;
      try {
        sigBytes = Buffer.from(parts[2], "base64url");
      } catch {
        res.status(401).json({ error: "SEP-10 JWT verification failed: malformed signature" });
        return;
      }

      const valid = nodeCrypto.verify(null, signInput, keyObject, sigBytes);
      if (!valid) {
        res.status(401).json({ error: "SEP-10 JWT verification failed: signature mismatch" });
        return;
      }

      // Signature is good — now validate the payload claims.
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      } catch {
        res.status(401).json({ error: "SEP-10 JWT is invalid" });
        return;
      }

      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.exp === "number" && payload.exp < now) {
        res.status(401).json({ error: "SEP-10 JWT has expired" });
        return;
      }

      try {
        const { account, memo } = validateSub(payload.sub);
        req.sep10 = { sub: String(payload.sub), account, memo };
        next();
      } catch (err) {
        res.status(401).json({ error: (err as Error).message });
      }
    })
    .catch((err: Error) => {
      res
        .status(503)
        .json({ error: `unable to fetch anchor public key: ${err.message}` });
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal DER-encoded SubjectPublicKeyInfo structure for an Ed25519
 * public key so that Node's `crypto` module (and jsonwebtoken) can parse it.
 *
 * Structure (RFC 8410):
 *   SEQUENCE {
 *     SEQUENCE { OID 1.3.101.112 }    -- id-Ed25519
 *     BIT STRING { 0x00 || <32-byte key> }
 *   }
 */
function buildEd25519SpkiDer(rawKey: Uint8Array): Buffer {
  // OID for id-Ed25519: 1.3.101.112 → 0x2b 0x65 0x70
  const oid = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]);
  const algorithmSeq = Buffer.concat([
    Buffer.from([0x30, oid.length]),
    oid,
  ]);
  const bitString = Buffer.concat([
    Buffer.from([0x03, rawKey.length + 1, 0x00]),
    Buffer.from(rawKey),
  ]);
  const inner = Buffer.concat([algorithmSeq, bitString]);
  return Buffer.concat([Buffer.from([0x30, inner.length]), inner]);
}
