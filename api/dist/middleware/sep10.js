"use strict";
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
 * No signing keys are hardcoded — all config comes from environment variables.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tomlKeyCache = void 0;
exports.requireSep10 = requireSep10;
exports.setTomlKeyCache = setTomlKeyCache;
exports.getAnchorPublicKey = getAnchorPublicKey;
exports.requireSep10Ed25519 = requireSep10Ed25519;
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const config_1 = require("../config");
// ---------------------------------------------------------------------------
// Variant 1: shared-secret HS256 (existing SEP-12 / SEP-31 gate)
// ---------------------------------------------------------------------------
/**
 * SEP-10 JWT bearer authentication using the server's own JWT secret (HS256).
 * Protected SEP endpoints (SEP-12, SEP-31) must respond 403 to requests
 * without a valid token.
 */
function requireSep10(req, res, next) {
    const header = req.get("Authorization") || "";
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
        res.status(403).json({ error: "missing SEP-10 JWT in Authorization header" });
        return;
    }
    try {
        const payload = jsonwebtoken_1.default.verify(match[1], config_1.config.jwtSecret);
        const sub = String(payload.sub);
        const [account, memo] = sub.split(":");
        req.sep10 = { sub, account, memo };
        next();
    }
    catch {
        res.status(403).json({ error: "invalid or expired SEP-10 JWT" });
    }
}
/** In-memory cache. Exported for testing (allows injection / invalidation). */
exports.tomlKeyCache = null;
/** Cache TTL — 1 hour. */
const CACHE_TTL_MS = 60 * 60 * 1000;
/**
 * Inject a cache entry in tests without making real HTTP requests.
 * Pass `null` to clear the cache.
 */
function setTomlKeyCache(entry) {
    exports.tomlKeyCache = entry;
}
/**
 * Fetch the anchor's SIGNING_KEY from its stellar.toml.
 *
 * The env var ANCHOR_DOMAIN determines which domain to fetch from.
 * Falls back to config.homeDomain when ANCHOR_DOMAIN is unset.
 */
async function fetchAnchorPublicKey() {
    const domain = process.env.ANCHOR_DOMAIN || config_1.config.homeDomain;
    // In tests the HOME_DOMAIN is localhost:port, so use http; otherwise https.
    const isLocal = /^localhost(:\d+)?$/.test(domain);
    const scheme = isLocal ? "http" : "https";
    const url = `${scheme}://${domain}/.well-known/stellar.toml`;
    return new Promise((resolve, reject) => {
        const lib = isLocal ? http_1.default : https_1.default;
        lib
            .get(url, (res) => {
            let body = "";
            res.on("data", (chunk) => { body += chunk.toString(); });
            res.on("end", () => {
                const match = body.match(/^SIGNING_KEY\s*=\s*"?([A-Z2-7]{56})"?/m);
                if (!match) {
                    reject(new Error(`SIGNING_KEY not found in stellar.toml at ${url}`));
                }
                else {
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
async function getAnchorPublicKey() {
    const now = Date.now();
    if (exports.tomlKeyCache && exports.tomlKeyCache.expiresAt > now) {
        return exports.tomlKeyCache.publicKey;
    }
    const publicKey = await fetchAnchorPublicKey();
    exports.tomlKeyCache = { publicKey, expiresAt: now + CACHE_TTL_MS };
    return publicKey;
}
/**
 * Validate the SEP-10 `sub` claim: must be a valid G… or M… account,
 * optionally followed by ":memo".
 */
function validateSub(sub) {
    if (typeof sub !== "string" || !sub) {
        throw new Error("missing sub claim");
    }
    const [account, memo] = sub.split(":");
    if (!stellar_sdk_1.StrKey.isValidEd25519PublicKey(account) && !stellar_sdk_1.StrKey.isValidMed25519PublicKey(account)) {
        throw new Error(`sub account ${account} is not a valid Stellar public key`);
    }
    return { account, memo };
}
/**
 * Ed25519-based SEP-10 JWT verification middleware.
 *
 * Fetches the anchor's public key from stellar.toml (cached 1 h), then
 * verifies the JWT is signed with that key using EdDSA.
 *
 * Returns 401 (not 403) because the client sent credentials that did not pass
 * verification — the request must be re-authenticated.
 */
function requireSep10Ed25519(req, res, next) {
    const header = req.get("Authorization") || "";
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
        res.status(401).json({ error: "missing Authorization: Bearer <sep10-jwt> header" });
        return;
    }
    const token = match[1];
    // Decode header without verifying to check algorithm before fetching the key.
    const decoded = jsonwebtoken_1.default.decode(token, { complete: true });
    if (!decoded || decoded.header.alg !== "EdDSA") {
        // Also accept HS256 tokens issued by this same server (integration flows).
        // If not EdDSA, fall through to shared-secret verify.
        try {
            const payload = jsonwebtoken_1.default.verify(token, config_1.config.jwtSecret);
            const { account, memo } = validateSub(payload.sub);
            req.sep10 = { sub: String(payload.sub), account, memo };
            next();
            return;
        }
        catch {
            res.status(401).json({ error: "invalid or expired SEP-10 JWT" });
            return;
        }
    }
    // EdDSA path: fetch anchor key (possibly from cache) then verify.
    getAnchorPublicKey()
        .then((stellarPublicKey) => {
        // Convert Stellar G… key to raw 32-byte Ed25519 public key in PEM form
        // so jsonwebtoken's EdDSA support can use it.
        const rawBytes = stellar_sdk_1.StrKey.decodeEd25519PublicKey(stellarPublicKey);
        // Node's crypto expects the key as a KeyObject or as a PEM for EdDSA.
        // Build a minimal SubjectPublicKeyInfo DER envelope and export as PEM.
        const spki = buildEd25519SpkiDer(rawBytes);
        const pem = "-----BEGIN PUBLIC KEY-----\n" +
            spki.toString("base64").match(/.{1,64}/g).join("\n") +
            "\n-----END PUBLIC KEY-----";
        let payload;
        try {
            payload = jsonwebtoken_1.default.verify(token, pem, { algorithms: ["EdDSA"] });
        }
        catch (err) {
            const msg = err instanceof jsonwebtoken_1.default.TokenExpiredError
                ? "SEP-10 JWT has expired"
                : err instanceof jsonwebtoken_1.default.JsonWebTokenError
                    ? `SEP-10 JWT verification failed: ${err.message}`
                    : "SEP-10 JWT is invalid";
            res.status(401).json({ error: msg });
            return;
        }
        try {
            const { account, memo } = validateSub(payload.sub);
            req.sep10 = { sub: String(payload.sub), account, memo };
            next();
        }
        catch (err) {
            res.status(401).json({ error: err.message });
        }
    })
        .catch((err) => {
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
function buildEd25519SpkiDer(rawKey) {
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
//# sourceMappingURL=sep10.js.map