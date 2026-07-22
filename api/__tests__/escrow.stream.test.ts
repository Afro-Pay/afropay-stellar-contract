/**
 * Acceptance criteria for Issue #24:
 *  - SSE endpoint replays all events since Last-Event-ID on reconnect, with no
 *    events missed.
 *  - New events are pushed to already-connected clients as they are written
 *    to the event store.
 *  - The SSE `id:` field is the event store's monotonic sequence id.
 *  - Unknown escrow ids 404 instead of opening a stream.
 *  - The connection (and its heartbeat/subscription) is cleaned up when the
 *    client disconnects.
 */

import http from "http";
import type { AddressInfo } from "net";
import path from "path";
import type { Express } from "express";

let app: Express;
let server: http.Server;
let port: number;

beforeEach(async () => {
  jest.resetModules();

  process.env.STELLAR_TOML_PATH = path.resolve(__dirname, "../../public/.well-known/stellar.toml");
  process.env.SEP10_SIGNING_SEED = "SAPIZOWDFX4OYJNP2YYP7S3RWSGBWH5LSENWAI6PLQKULS3BKVXQ3MTQ";
  process.env.HOME_DOMAIN = "localhost:8000";
  process.env.JWT_SECRET = "test-jwt-secret-for-escrow-stream-tests";

  const { buildApp } = await import("../app");
  app = buildApp();

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createEscrow(): Promise<string> {
  const { escrows } = await import("../routes/escrow");
  const id = "escrow-under-test";
  const now = new Date();
  escrows.set(id, {
    id,
    senderAccount: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
    corridor: "USD_NGN",
    amountUsdc: "100.0000000",
    state: "Funded",
    createdAt: now,
    stateChangedAt: now,
  });

  const { escrowEventStore } = await import("../services/eventStore");
  escrowEventStore.append(id, {
    type: "created",
    state: "Funded",
    corridor: "USD_NGN",
    amountUsdc: "100.0000000",
  });

  return id;
}

/**
 * Opens a raw HTTP connection to the SSE endpoint, accumulating response
 * text until `predicate` is satisfied (or `timeoutMs` elapses), then tears
 * down the socket so the test doesn't hang open.
 */
function streamUntil(
  urlPath: string,
  headers: Record<string, string>,
  predicate: (text: string) => boolean,
  timeoutMs = 3000
): Promise<{ statusCode: number | undefined; text: string }> {
  return new Promise((resolve) => {
    let text = "";
    let statusCode: number | undefined;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ statusCode, text });
    };

    const req = http.get({ port, path: urlPath, headers }, (res) => {
      statusCode = res.statusCode;
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        if (predicate(text)) finish();
      });
      res.on("close", finish);
      res.on("end", finish);
    });

    req.on("error", finish);
    const timer = setTimeout(finish, timeoutMs);
  });
}

describe("GET /api/v1/escrow/:id/stream", () => {
  it("404s for an unknown escrow id", async () => {
    const { statusCode } = await streamUntil(
      "/api/v1/escrow/does-not-exist/stream",
      {},
      () => true,
      1000
    );
    expect(statusCode).toBe(404);
  });

  it("sets text/event-stream headers", async () => {
    await createEscrow();
    let headers: http.IncomingHttpHeaders = {};
    await new Promise<void>((resolve) => {
      const req = http.get({ port, path: "/api/v1/escrow/escrow-under-test/stream" }, (res) => {
        headers = res.headers;
        req.destroy();
        resolve();
      });
    });
    expect(headers["content-type"]).toMatch(/text\/event-stream/);
    expect(headers["cache-control"]).toMatch(/no-cache/);
  });

  it("replays the created event immediately for a fresh connection (Last-Event-ID absent)", async () => {
    await createEscrow();
    const { text } = await streamUntil(
      "/api/v1/escrow/escrow-under-test/stream",
      {},
      (t) => t.includes("data:") && t.trimEnd().endsWith("}")
    );
    expect(text).toContain("id: 1");
    expect(text).toContain('"type":"created"');
    expect(text).toContain('"state":"Funded"');
  });

  it("replays only events after Last-Event-ID on reconnect — no missed events", async () => {
    const id = await createEscrow(); // event id 1 ("created")
    const { escrowEventStore } = await import("../services/eventStore");

    // Simulate two state transitions that happened while the client was offline.
    escrowEventStore.append(id, { type: "state_changed", state: "Released", corridor: "USD_NGN", amountUsdc: "100.0000000" }); // id 2
    escrowEventStore.append(id, { type: "state_changed", state: "Refundable", corridor: "USD_NGN", amountUsdc: "100.0000000" }); // id 3

    const { text } = await streamUntil(
      "/api/v1/escrow/escrow-under-test/stream",
      { "Last-Event-ID": "1" },
      (t) => (t.match(/^id: /gm) ?? []).length >= 2
    );

    // Missed events (2 and 3) must both be present, in order, with no duplicates.
    expect(text).toContain("id: 2");
    expect(text).toContain("id: 3");
    expect(text).not.toContain("id: 1");
    expect(text.indexOf("id: 2")).toBeLessThan(text.indexOf("id: 3"));
    expect(text).toContain('"state":"Released"');
    expect(text).toContain('"state":"Refundable"');
  });

  it("also accepts lastEventId as a query param for non-browser clients", async () => {
    const id = await createEscrow();
    const { escrowEventStore } = await import("../services/eventStore");
    escrowEventStore.append(id, { type: "state_changed", state: "Released", corridor: "USD_NGN", amountUsdc: "100.0000000" });

    const { text } = await streamUntil(
      "/api/v1/escrow/escrow-under-test/stream?lastEventId=1",
      {},
      (t) => t.includes("data:") && t.trimEnd().endsWith("}")
    );
    expect(text).toContain("id: 2");
    expect(text).not.toContain("id: 1");
  });

  it("pushes new events to an already-connected client in real time", async () => {
    const id = await createEscrow();

    const streamPromise = streamUntil(
      "/api/v1/escrow/escrow-under-test/stream",
      { "Last-Event-ID": "1" }, // skip the replay of the initial "created" event
      (t) => t.includes("data:") && t.trimEnd().endsWith("}")
    );

    // Give the connection a moment to be established and subscribed.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { escrowEventStore } = await import("../services/eventStore");
    escrowEventStore.append(id, {
      type: "state_changed",
      state: "Released",
      corridor: "USD_NGN",
      amountUsdc: "100.0000000",
    });

    const { text } = await streamPromise;
    expect(text).toContain("id: 2");
    expect(text).toContain('"state":"Released"');
  });
});
