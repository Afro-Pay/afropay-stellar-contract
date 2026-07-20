/**
 * SEP-10 authentication middleware — two variants:
 *
 *  requireSep10        — shared-secret HS256 JWT verify (existing SEP-12/31 gate).
 *  requireSep10Ed25519 — full anchor-key Ed25519 JWT verify for escrow release/dispute.
 *
 * The Ed25519 variant:
 *  • Fetches the anchor public key from stellar.toml at ANCHOR_DOMAIN (env var).
 *  • Caches the key for 1 hour to avoid a round-trip on every request.
 *  • Validates EdDSA signature via Node.js `crypto.verify`, expiry, and the
 *    `sub` claim (must be a valid Stellar G… / M… public key).
 *  • Rejects missing, expired, and tampered tokens with 401 + descriptive error.
 *
 * No signing keys are hardcoded — all config comes from environment variables.
 */

import { NextFunction, Request, Response } from "express";
import https from "https";
import http from "http";
import * as crypto from "crypto";
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
  /** Stellar G… 56-char base32 public key (SIGNING_KEY from stellar.toml). */
  publicKey: string;
  expiresAt: number;  // epoch ms
}

/** In-memory cache. Exported for testing (allows injection / invalidation). */
export let tomlKeyCache: TomlKeyCache | null = null;

/** Cache TTL — 1 hour. */
export const CACHE_TTL_MS = 60 * 60 * 1000;

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
export async function fetchAnchorPublicKey(): Promise<string> {
  const domain = process.env.ANCHOR_DOMAIN || config.homeDomain;
  // Use http for localhost (test environments), https otherwise.
  const isLocal = /^localhost(:\d+)?$/.test(domain);
  const scheme = isLocal ? "http" : "https";
  const url = `${scheme}://${domain}/.well-known/stellar.toml`;

  return new Promise((resolve, reject) => {
    const lib: typeof https | typeof http = isLocal ? http : https;
    lib
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`stellar.toml fetch returned HTTP ${res.statusCode} from ${url}`));
          res.resume();
          return;
        }
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

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/**
 * Manually verify an EdDSA JWT using Node.js `crypto.verify`.
 *
 * jsonwebtoken v9 does not support the EdDSA algorithm natively, so we parse
 * the token structure ourselves and delegate signature verification to
 * Node's built-in crypto module, which has full Ed25519 support.
 *
 * Throws a descriptive Error on any validation failure.
 */
function verifyEdDsaJwt(
  token: string,
  stellarPublicKeyBase32: string
): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("malformed JWT: expected 3 dot-separated parts");
  }
  const [headerB64, payloadB64, sigB64] = parts;

  // Parse header
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  } catch {
    throw new Error("malformed JWT header");
  }
  if (header.alg !== "EdDSA") {
    throw new Error(`unexpected JWT algorithm: ${header.alg}`);
  }

  // Parse payload
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new Error("malformed JWT payload");
  }

  // Decode signature
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(sigB64, "base64url");
  } catch {
    throw new Error("malformed JWT signature encoding");
  }

  // Convert the Stellar G… key to a Node.js KeyObject
  const rawKeyBytes = StrKey.decodeEd25519PublicKey(stellarPublicKeyBase32);
  const spkiDer = buildEd25519SpkiDer(rawKeyBytes);
  const publicKeyObj = crypto.createPublicKey({ key: spkiDer, format: "der", type: "spki" });

  // Verify the Ed25519 signature over header.payload
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const valid = crypto.verify(null, signingInput, publicKeyObj, sigBytes);
  if (!valid) {
    throw new Error("SEP-10 JWT verification failed: invalid signature");
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) {
    throw new ExpiredTokenError("SEP-10 JWT has expired");
  }

  return payload;
}

/** Sentinel error for distinguishing expiry from other failures. */
export class ExpiredTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpiredTokenError";
  }
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
 * verifies the JWT is signed with that key using Ed25519 (EdDSA).
 *
 * Returns 401 because the client sent credentials that did not pass
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

  // Peek at the JWT header to determine the algorithm
  const decodedHeader = jwt.decode(token, { complete: true });
  const alg = decodedHeader?.header?.alg;

  if (alg !== "EdDSA") {
    // Fall back to HS256 shared-secret verify for tokens issued by this server
    try {
      const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
      const { account, memo } = validateSub(payload.sub);
      req.sep10 = { sub: String(payload.sub), account, memo };
      next();
      return;
    } catch {
      res.status(401).json({ error: "invalid or expired SEP-10 JWT" });
      return;
    }
  }

  // EdDSA path: fetch anchor public key (from cache when fresh), then verify
  getAnchorPublicKey()
    .then((stellarPublicKey) => {
      let payload: Record<string, unknown>;
      try {
        payload = verifyEdDsaJwt(token, stellarPublicKey);
      } catch (err) {
        const isExpired = err instanceof ExpiredTokenError;
        const msg = isExpired
          ? (err as Error).message
          : `SEP-10 JWT verification failed: ${(err as Error).message}`;
        res.status(401).json({ error: msg });
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
      res.status(503).json({ error: `unable to fetch anchor public key: ${err.message}` });
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal DER-encoded SubjectPublicKeyInfo (SPKI) for an Ed25519 key.
 *
 * Structure per RFC 8410:
 *   SEQUENCE {
 *     SEQUENCE { OID id-Ed25519 (1.3.101.112) }
 *     BIT STRING { 0x00 || <32-byte raw public key> }
 *   }
 */
function buildEd25519SpkiDer(rawKey: Uint8Array): Buffer {
  const oid = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]);
  const algorithmSeq = Buffer.concat([Buffer.from([0x30, oid.length]), oid]);
  const bitString = Buffer.concat([
    Buffer.from([0x03, rawKey.length + 1, 0x00]),
    Buffer.from(rawKey),
  ]);
  const inner = Buffer.concat([algorithmSeq, bitString]);
  return Buffer.concat([Buffer.from([0x30, inner.length]), inner]);
}
