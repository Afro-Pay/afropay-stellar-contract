"use strict";
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
exports.config = void 0;
exports.loadConfig = loadConfig;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const toml_1 = __importDefault(require("@iarna/toml"));
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const crypto = __importStar(require("crypto"));
const crypto_1 = require("./services/crypto");
const TOML_PATH = process.env.STELLAR_TOML_PATH ||
    path.join(__dirname, "..", "..", "public", ".well-known", "stellar.toml");
function rewriteOrigin(raw, homeDomain, scheme) {
    const url = new URL(raw);
    const rewritten = new URL(`${scheme}://${homeDomain}`);
    rewritten.pathname = url.pathname;
    return rewritten;
}
function loadConfig() {
    const rawToml = fs.readFileSync(TOML_PATH, "utf8");
    const parsed = toml_1.default.parse(rawToml);
    for (const field of [
        "NETWORK_PASSPHRASE",
        "SIGNING_KEY",
        "WEB_AUTH_ENDPOINT",
        "DIRECT_PAYMENT_SERVER",
        "KYC_SERVER",
    ]) {
        if (!parsed[field]) {
            throw new Error(`stellar.toml is missing required field ${field}`);
        }
    }
    const networkPassphrase = process.env.NETWORK_PASSPHRASE || parsed.NETWORK_PASSPHRASE;
    const signingSeed = process.env.SEP10_SIGNING_SEED;
    if (!signingSeed) {
        throw new Error("SEP10_SIGNING_SEED is required (secret seed matching stellar.toml SIGNING_KEY)");
    }
    const signingKeypair = stellar_sdk_1.Keypair.fromSecret(signingSeed);
    // HOME_DOMAIN override lets the same committed stellar.toml serve local/CI runs:
    // endpoint origins and SIGNING_KEY are rewritten to match the running instance.
    const homeDomainOverride = process.env.HOME_DOMAIN;
    const scheme = homeDomainOverride ? "http" : "https";
    let webAuthEndpoint = new URL(parsed.WEB_AUTH_ENDPOINT);
    let kycServer = new URL(parsed.KYC_SERVER);
    let directPaymentServer = new URL(parsed.DIRECT_PAYMENT_SERVER);
    if (homeDomainOverride) {
        webAuthEndpoint = rewriteOrigin(parsed.WEB_AUTH_ENDPOINT, homeDomainOverride, scheme);
        kycServer = rewriteOrigin(parsed.KYC_SERVER, homeDomainOverride, scheme);
        directPaymentServer = rewriteOrigin(parsed.DIRECT_PAYMENT_SERVER, homeDomainOverride, scheme);
        parsed.WEB_AUTH_ENDPOINT = webAuthEndpoint.toString();
        parsed.KYC_SERVER = kycServer.toString();
        parsed.DIRECT_PAYMENT_SERVER = directPaymentServer.toString();
        parsed.SIGNING_KEY = signingKeypair.publicKey();
        if (networkPassphrase !== parsed.NETWORK_PASSPHRASE) {
            parsed.NETWORK_PASSPHRASE = networkPassphrase;
        }
    }
    else if (parsed.SIGNING_KEY !== signingKeypair.publicKey()) {
        throw new Error("SEP10_SIGNING_SEED does not match the SIGNING_KEY published in stellar.toml");
    }
    const homeDomain = homeDomainOverride || new URL(parsed.WEB_AUTH_ENDPOINT).host;
    const horizonUrl = process.env.HORIZON_URL ||
        (networkPassphrase === stellar_sdk_1.Networks.PUBLIC
            ? "https://horizon.stellar.org"
            : "https://horizon-testnet.stellar.org");
    // Master encryption key
    let masterEncryptionKey;
    const masterKeyBase64 = process.env.MASTER_ENCRYPTION_KEY;
    if (masterKeyBase64) {
        masterEncryptionKey = Buffer.from(masterKeyBase64, "base64");
        if (masterEncryptionKey.length !== 32) {
            throw new Error("MASTER_ENCRYPTION_KEY must be 32 bytes (base64 encoded)");
        }
    }
    else {
        masterEncryptionKey = crypto.randomBytes(32);
    }
    // Server X25519 key pair
    const { publicKey: serverX25519PublicKey, privateKey: serverX25519PrivateKey } = (0, crypto_1.generateServerX25519KeyPair)();
    return {
        port: parseInt(process.env.PORT || "8000", 10),
        networkPassphrase,
        horizonUrl,
        signingKeypair,
        jwtSecret: process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex"),
        jwtExpirySeconds: 24 * 60 * 60,
        challengeTimeoutSeconds: 900,
        homeDomain,
        webAuthDomain: webAuthEndpoint.host,
        webAuthEndpoint,
        kycServer,
        directPaymentServer,
        tomlDocument: toml_1.default.stringify(parsed),
        masterEncryptionKey,
        serverX25519PublicKey,
        serverX25519PrivateKey,
    };
}
exports.config = loadConfig();
//# sourceMappingURL=config.js.map