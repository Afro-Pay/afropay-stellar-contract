/**
 * Acceptance criteria for Issue #83 — Transaction SSE Settlement Monitoring:
 *
 *  - SSE endpoint replays all events since Last-Event-ID on reconnect, with
 *    no events missed.
 *  - New events are pushed to already-connected clients as they are written
 *    to the event store.
 *  - The SSE `id:` field is the event store's monotonic sequence id.
 *  - Unknown escrow/transaction ids 404 instead of opening a stream.
 *  - The connection (heartbeat & subscription) is cleaned up when the client
 *    disconnects.
 *  - TransactionSettled and TransactionRefunded events are supported.
 *  - Polling fallback status endpoint works for non-SSE clients.
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
  process.env.JWT_SECRET = "test-jwt-secret-for-transaction-stream-tests";

  const { buildApp } = await import("../app");
  app = buildApp();

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  const { transactionEventStore } = await import("../services/transactionEventStore");
  transactionEventStore.reset();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function seedTransaction(): Promise<string> {
  const { transactionEventStore } = await import("../services/transactionEventStore");
  const id = "tx-under-test";

  transactionEventStore.append(id, {
    type: "TransactionCreated",
    state: "pending_sender",
    corridor: "USD_NGN",
    amountUsdc: "250.0000000",
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

describe("GET /transactions/stream/:escrow_id (Issue #83)", () => {
  it("404s for an unknown transaction id", async () => {
    const { statusCode } = await streamUntil(
      "/transactions/stream/does-not-exist",
      {},
      () => true,
      1000
    );
    expect(statusCode).toBe(404);
  });

  it("also 404s on /api/v1/ path for unknown ids", async () => {
    const { statusCode } = await streamUntil(
      "/api/v1/transactions/stream/does-not-exist",
      {},
      () => true,
      1000
    );
    expect(statusCode).toBe(404);
  });

  it("sets text/event-stream headers", async () => {
    await seedTransaction();
    let headers: http.IncomingHttpHeaders = {};
    await new Promise<void>((resolve) => {
      const req = http.get(
        { port, path: "/transactions/stream/tx-under-test" },
        (res) => {
          headers = res.headers;
          req.destroy();
          resolve();
        }
      );
    });
    expect(headers["content-type"]).toMatch(/text\/event-stream/);
    expect(headers["cache-control"]).toMatch(/no-cache/);
  });

  it("replays the TransactionCreated event immediately for a fresh connection", async () => {
    await seedTransaction();
    const { text } = await streamUntil(
      "/transactions/stream/tx-under-test",
      {},
      (t) => t.includes("data:") && t.trimEnd().endsWith("}")
    );
    expect(text).toContain("id: 1");
    expect(text).toContain('"type":"TransactionCreated"');
    expect(text).toContain('"state":"pending_sender"');
  });

  it("replays only events after Last-Event-ID on reconnect — no missed events", async () => {
    const id = await seedTransaction(); // event id 1
    const { transactionEventStore } = await import("../services/transactionEventStore");

    // Simulate settlement events while the client was offline
    transactionEventStore.append(id, {
      type: "state_changed",
      state: "oracle_signed",
      corridor: "USD_NGN",
      amountUsdc: "250.0000000",
    }); // id 2
    transactionEventStore.append(id, {
      type: "TransactionSettled",
      state: "settled",
      corridor: "USD_NGN",
      amountUsdc: "250.0000000",
      stellarTxHash: "abc123deadbeef",
    }); // id 3

    const { text } = await streamUntil(
      "/transactions/stream/tx-under-test",
      { "Last-Event-ID": "1" },
      (t) => (t.match(/^id: /gm) ?? []).length >= 2
    );

    // Missed events (2 and 3) must both be present, in order, no duplicates
    expect(text).toContain("id: 2");
    expect(text).toContain("id: 3");
    expect(text).not.toContain("id: 1");
    expect(text.indexOf("id: 2")).toBeLessThan(text.indexOf("id: 3"));
    expect(text).toContain('"state":"oracle_signed"');
    expect(text).toContain('"state":"settled"');
    expect(text).toContain('"type":"TransactionSettled"');
  });

  it("accepts lastEventId as a query param for non-browser clients", async () => {
    const id = await seedTransaction();
    const { transactionEventStore } = await import("../services/transactionEventStore");
    transactionEventStore.append(id, {
      type: "TransactionSettled",
      state: "settled",
      corridor: "USD_NGN",
      amountUsdc: "250.0000000",
    });

    const { text } = await streamUntil(
      "/transactions/stream/tx-under-test?lastEventId=1",
      {},
      (t) => t.includes("data:") && t.trimEnd().endsWith("}")
    );
    expect(text).toContain("id: 2");
    expect(text).not.toContain("id: 1");
  });

  it("pushes new events to an already-connected client in real time", async () => {
    const id = await seedTransaction();

    const streamPromise = streamUntil(
      "/transactions/stream/tx-under-test",
      { "Last-Event-ID": "1" },
      (t) => t.includes("data:") && t.trimEnd().endsWith("}")
    );

    // Give the connection a moment to be established and subscribed.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const { transactionEventStore } = await import("../services/transactionEventStore");
    transactionEventStore.append(id, {
      type: "TransactionSettled",
      state: "settled",
      corridor: "USD_NGN",
      amountUsdc: "250.0000000",
      stellarTxHash: "deadbeef123",
    });

    const { text } = await streamPromise;
    expect(text).toContain("id: 2");
    expect(text).toContain('"type":"TransactionSettled"');
    expect(text).toContain('"state":"settled"');
    expect(text).toContain('"stellar_tx_hash":"deadbeef123"');
  });

  it("includes TransactionRefunded event type", async () => {
    const id = await seedTransaction();
    const { transactionEventStore } = await import("../services/transactionEventStore");

    transactionEventStore.append(id, {
      type: "TransactionRefunded",
      state: "refunded",
      corridor: "USD_NGN",
      amountUsdc: "250.0000000",
    });

    const { text } = await streamUntil(
      "/transactions/stream/tx-under-test?lastEventId=1",
      {},
      (t) => t.includes("data:") && t.trimEnd().endsWith("}")
    );
    expect(text).toContain('"type":"TransactionRefunded"');
    expect(text).toContain('"state":"refunded"');
  });

  it("uses 'settlement_event' as the SSE event name", async () => {
    await seedTransaction();
    const { text } = await streamUntil(
      "/transactions/stream/tx-under-test",
      {},
      (t) => t.includes("event: settlement_event")
    );
    expect(text).toContain("event: settlement_event");
  });
});

describe("GET /transactions/:escrow_id/status (Issue #83 polling fallback)", () => {
  it("returns the latest state for a known transaction", async () => {
    const id = await seedTransaction();
    const { transactionEventStore } = await import("../services/transactionEventStore");

    transactionEventStore.append(id, {
      type: "TransactionSettled",
      state: "settled",
      corridor: "USD_NGN",
      amountUsdc: "250.0000000",
      stellarTxHash: "feedfacebeef",
    });

    const res = await new Promise<{ statusCode: number; body: Record<string, unknown> }>(
      (resolve) => {
        http.get(
          { port, path: "/api/v1/transactions/tx-under-test/status" },
          (response) => {
            let data = "";
            response.on("data", (chunk) => (data += chunk.toString()));
            response.on("end", () => {
              resolve({
                statusCode: response.statusCode!,
                body: JSON.parse(data),
              });
            });
          }
        );
      }
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.state).toBe("settled");
    expect(res.body.stellar_tx_hash).toBe("feedfacebeef");
  });

  it("404s for an unknown transaction", async () => {
    const res = await new Promise<{ statusCode: number }>((resolve) => {
      http.get(
        { port, path: "/transactions/unknown-id/status" },
        (response) => {
          response.resume();
          response.on("end", () =>
            resolve({ statusCode: response.statusCode! })
          );
        }
      );
    });

    expect(res.statusCode).toBe(404);
  });
});
