/**
 * Jest global setup — runs before any test file is imported.
 * Sets environment variables required by config.ts so the module
 * can be imported without crashing during test collection.
 */
import path from "path";

process.env.STELLAR_TOML_PATH = path.resolve(
  __dirname,
  "../public/.well-known/stellar.toml"
);
process.env.SEP10_SIGNING_SEED = "SAPIZOWDFX4OYJNP2YYP7S3RWSGBWH5LSENWAI6PLQKULS3BKVXQ3MTQ";
process.env.HOME_DOMAIN = "localhost:8000";
process.env.JWT_SECRET = "test-sep10-jwt-secret-do-not-use-in-production";
