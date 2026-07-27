import http from "http";
import type { AddressInfo } from "net";
import path from "path";
import type { Express } from "express";

let app: Express;
let server: http.Server;
let port: number;

const EXISTING_ID = "escrow-timing-existing";
const NON_EXISTING_ID = "escrow-timing-nonexistent";

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

beforeEach(async () => {
  jest.resetModules();

  process.env.STELLAR_TOML_PATH = path.resolve(__dirname, "../../../public/.well-known/stellar.toml");
  process.env.SEP10_SIGNING_SEED = "SAPIZOWDFX4OYJNP2YYP7S3RWSGBWH5LSENWAI6PLQKULS3BKVXQ3MTQ";
  process.env.HOME_DOMAIN = "localhost:8000";
  process.env.JWT_SECRET = "test-jwt-secret-for-timing-tests";
  process.env.RATE_LIMIT_MAX_REQUESTS = "10000";

  const { buildApp } = await import("../../app");
  app = buildApp();

  const { escrows } = await import("../../routes/escrow");
  const now = new Date();
  escrows.set(EXISTING_ID, {
    id: EXISTING_ID,
    senderAccount: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
    corridor: "USD_NGN",
    amountUsdc: "100.0000000",
    state: "Funded",
    createdAt: now,
    stateChangedAt: now,
  });

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  agent.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function timeRequest(urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = process.hrtime.bigint();
    const req = http.get({ port, path: urlPath, agent }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => {
        const end = process.hrtime.bigint();
        resolve(Number(end - start) / 1e6);
      });
    });
    req.on("error", reject);
  });
}

function medianSorted(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

describe("Adversarial: Account Enumeration Timing", () => {
  jest.setTimeout(60_000);

  it("response time delta between existing and non-existing escrow must be < 5ms over 100 paired requests", async () => {
    const warmup = 10;
    for (let i = 0; i < warmup; i++) {
      await timeRequest(`/api/v1/escrow/${EXISTING_ID}`);
      await timeRequest(`/api/v1/escrow/${NON_EXISTING_ID}`);
    }

    const existingTimes: number[] = [];
    const nonExistingTimes: number[] = [];
    const iterations = 100;

    for (let i = 0; i < iterations; i++) {
      const tExist = await timeRequest(`/api/v1/escrow/${EXISTING_ID}`);
      const tNonExist = await timeRequest(`/api/v1/escrow/${NON_EXISTING_ID}`);
      existingTimes.push(tExist);
      nonExistingTimes.push(tNonExist);
    }

    existingTimes.sort((a, b) => a - b);
    nonExistingTimes.sort((a, b) => a - b);

    const medianExist = medianSorted(existingTimes);
    const medianNonExist = medianSorted(nonExistingTimes);
    const medianDelta = Math.abs(medianExist - medianNonExist);

    expect(medianDelta).toBeLessThan(5);

    const p95Exist = existingTimes[Math.floor(existingTimes.length * 0.95)];
    const p95NonExist = nonExistingTimes[Math.floor(nonExistingTimes.length * 0.95)];
    const p95Delta = Math.abs(p95Exist - p95NonExist);

    expect(p95Delta).toBeLessThan(5);
  });
});
