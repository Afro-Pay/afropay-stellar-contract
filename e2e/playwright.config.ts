import path from "path";
import { defineConfig } from "@playwright/test";
import { API_PORT, APP_PORT, APP_BASE_URL, JWT_SECRET } from "./testConfig";

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: APP_BASE_URL,
  },
  webServer: [
    {
      // Transpile-only: the whole-project `tsc` build currently fails on
      // unrelated pre-existing rootDir violations in routes/admin.ts and the
      // payment webhooks (they import from the top-level services/ tree).
      // ts-node --transpile-only sidesteps that program-wide check and just
      // runs the server, which is all a webServer needs.
      command: "node node_modules/ts-node/dist/bin.js --transpile-only server.ts",
      cwd: "../api",
      port: API_PORT,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: String(API_PORT),
        HOME_DOMAIN: `localhost:${API_PORT}`,
        STELLAR_TOML_PATH: path.resolve(__dirname, "../public/.well-known/stellar.toml"),
        SEP10_SIGNING_SEED: "SAPIZOWDFX4OYJNP2YYP7S3RWSGBWH5LSENWAI6PLQKULS3BKVXQ3MTQ",
        JWT_SECRET,
      },
    },
    {
      command: `npm run dev -- --port ${APP_PORT} --strictPort`,
      cwd: "../app",
      port: APP_PORT,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
