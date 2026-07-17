#!/usr/bin/env node
/**
 * SEP-1 stellar.toml validator.
 *
 * Fails (exit 1) if public/.well-known/stellar.toml is missing, malformed,
 * or lacks the fields AfroPay's anchor integrations require. Run from the
 * repository root after `npm ci --prefix api` (reuses the API's dependencies).
 */
import { createRequire } from "module";
import { readFileSync, statSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repoRoot, "api", "package.json"));
const TOML = require("@iarna/toml");
const { StrKey, Networks } = require("@stellar/stellar-sdk");

const tomlPath = path.join(repoRoot, "public", ".well-known", "stellar.toml");
const errors = [];

let parsed = {};
try {
  const size = statSync(tomlPath).size;
  if (size >= 100 * 1024) {
    errors.push(`stellar.toml is ${size} bytes; SEP-1 requires < 100KB`);
  }
  parsed = TOML.parse(readFileSync(tomlPath, "utf8"));
} catch (e) {
  console.error(`FAIL: could not read/parse ${tomlPath}: ${e.message}`);
  process.exit(1);
}

const REQUIRED = [
  "NETWORK_PASSPHRASE",
  "SIGNING_KEY",
  "WEB_AUTH_ENDPOINT",
  "DIRECT_PAYMENT_SERVER",
  "KYC_SERVER",
];
for (const field of REQUIRED) {
  if (!parsed[field]) errors.push(`missing required field ${field}`);
}

if (
  parsed.NETWORK_PASSPHRASE &&
  ![Networks.PUBLIC, Networks.TESTNET].includes(parsed.NETWORK_PASSPHRASE)
) {
  errors.push(`NETWORK_PASSPHRASE is not a known Stellar network passphrase`);
}

if (parsed.SIGNING_KEY && !StrKey.isValidEd25519PublicKey(parsed.SIGNING_KEY)) {
  errors.push(`SIGNING_KEY is not a valid ed25519 public key`);
}

for (const field of ["WEB_AUTH_ENDPOINT", "KYC_SERVER", "DIRECT_PAYMENT_SERVER"]) {
  const value = parsed[field];
  if (!value) continue;
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${field} is not a valid URL: ${value}`);
    continue;
  }
  if (url.protocol !== "https:") errors.push(`${field} must use https`);
  if (value.endsWith("/")) errors.push(`${field} must not end with a slash`);
}

for (const account of parsed.ACCOUNTS ?? []) {
  if (!StrKey.isValidEd25519PublicKey(account)) {
    errors.push(`ACCOUNTS entry is not a valid public key: ${account}`);
  }
}

if (!Array.isArray(parsed.CURRENCIES) || parsed.CURRENCIES.length === 0) {
  errors.push("CURRENCIES section is missing or empty");
} else {
  for (const currency of parsed.CURRENCIES) {
    if (!currency.code) errors.push("a CURRENCIES entry is missing 'code'");
    if (!currency.issuer || !StrKey.isValidEd25519PublicKey(currency.issuer)) {
      errors.push(`CURRENCIES entry ${currency.code ?? "?"} has a missing/invalid issuer`);
    }
  }
}

if (errors.length > 0) {
  console.error("stellar.toml validation FAILED:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log("stellar.toml validation passed");
