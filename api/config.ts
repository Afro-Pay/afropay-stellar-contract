import * as fs from "fs";
import * as path from "path";
import TOML from "@iarna/toml";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import * as crypto from "crypto";
import { generateServerX25519KeyPair } from "./services/crypto";

const TOML_PATH =
  process.env.STELLAR_TOML_PATH ||
  path.join(__dirname, "..", "..", "public", ".well-known", "stellar.toml");

export interface AnchorConfig {
  port: number;
  networkPassphrase: string;
  horizonUrl: string;
  signingKeypair: Keypair;
  jwtSecret: string;
  jwtExpirySeconds: number;
  challengeTimeoutSeconds: number;
  /** host[:port] used as the challenge home domain, e.g. "api.afropay.io" or "localhost:8000" */
  homeDomain: string;
  /** host[:port] of the web auth endpoint (SEP-10 web_auth_domain) */
  webAuthDomain: string;
  webAuthEndpoint: URL;
  kycServer: URL;
  directPaymentServer: URL;
  /** The stellar.toml document as served, with any local-run overrides applied */
  tomlDocument: string;
  masterEncryptionKey: Buffer;
  serverX25519PublicKey: Buffer;
  serverX25519PrivateKey: Buffer;
}

function rewriteOrigin(raw: string, homeDomain: string, scheme: string): URL {
  const url = new URL(raw);
  const rewritten = new URL(`${scheme}://${homeDomain}`);
  rewritten.pathname = url.pathname;
  return rewritten;
}

export function loadConfig(): AnchorConfig {
  const rawToml = fs.readFileSync(TOML_PATH, "utf8");
  const parsed = TOML.parse(rawToml) as Record<string, any>;

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

  const networkPassphrase =
    process.env.NETWORK_PASSPHRASE || (parsed.NETWORK_PASSPHRASE as string);

  const signingSeed = process.env.SEP10_SIGNING_SEED;
  if (!signingSeed) {
    throw new Error(
      "SEP10_SIGNING_SEED is required (secret seed matching stellar.toml SIGNING_KEY)"
    );
  }
  const signingKeypair = Keypair.fromSecret(signingSeed);

  // HOME_DOMAIN override lets the same committed stellar.toml serve local/CI runs:
  // endpoint origins and SIGNING_KEY are rewritten to match the running instance.
  const homeDomainOverride = process.env.HOME_DOMAIN;
  const scheme = homeDomainOverride ? "http" : "https";

  let webAuthEndpoint = new URL(parsed.WEB_AUTH_ENDPOINT as string);
  let kycServer = new URL(parsed.KYC_SERVER as string);
  let directPaymentServer = new URL(parsed.DIRECT_PAYMENT_SERVER as string);

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
  } else if (parsed.SIGNING_KEY !== signingKeypair.publicKey()) {
    throw new Error(
      "SEP10_SIGNING_SEED does not match the SIGNING_KEY published in stellar.toml"
    );
  }

  const homeDomain = homeDomainOverride || new URL(parsed.WEB_AUTH_ENDPOINT).host;

  const horizonUrl =
    process.env.HORIZON_URL ||
    (networkPassphrase === Networks.PUBLIC
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org");

  // Master encryption key
  let masterEncryptionKey: Buffer;
  const masterKeyBase64 = process.env.MASTER_ENCRYPTION_KEY;
  if (masterKeyBase64) {
    masterEncryptionKey = Buffer.from(masterKeyBase64, "base64");
    if (masterEncryptionKey.length !== 32) {
      throw new Error("MASTER_ENCRYPTION_KEY must be 32 bytes (base64 encoded)");
    }
  } else {
    masterEncryptionKey = crypto.randomBytes(32);
  }

  // Server X25519 key pair
  const { publicKey: serverX25519PublicKey, privateKey: serverX25519PrivateKey } = generateServerX25519KeyPair();

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
    tomlDocument: TOML.stringify(parsed),
    masterEncryptionKey,
    serverX25519PublicKey,
    serverX25519PrivateKey,
  };
}

export const config = loadConfig();
