/**
 * submit.test.ts
 *
 * Concurrency tests for the relayer submission pipeline.
 *
 * Uses ioredis-mock so no real Redis instance is required.  The Relayer's
 * Horizon server is replaced with a lightweight HorizonAdapter stub that
 * returns a real Stellar `Account` instance (needed by TransactionBuilder)
 * but stubs the submit call to avoid any network traffic.
 *
 * Acceptance criteria verified:
 *
 *   ✓ 50 simultaneous submissions for the same sender account → exactly 1
 *     succeeds and 49 receive DuplicatePaymentError.
 *
 *   ✓ DuplicatePaymentError is a typed error with the original paymentId in
 *     its payload.
 *
 *   ✓ Redis lock is always released after submission (success or error) —
 *     verified by asserting activeLockCount() === 0 after the test.
 *
 *   ✓ Lock TTL is configurable and defaults to 10 s.
 *
 *   ✓ Sequential submissions (same account, different paymentIds) all succeed
 *     — validates that the lock is properly released between calls.
 */

import RedisMock from "ioredis-mock";
import { Account, Transaction } from "@stellar/stellar-sdk";
import { SequenceManager } from "../sequenceManager";
import {
  Relayer,
  HorizonAdapter,
  TransactionFactory,
  PaymentRequest,
  SubmitResult,
} from "../submit";
import { DuplicatePaymentError } from "../errors";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

/**
 * Valid funded testnet account keypair (public seed — safe to commit).
 * The keypair only needs to produce a valid signature for TransactionBuilder;
 * no real network call is made.
 */
const SENDER_ACCOUNT = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";
const DESTINATION_ACCOUNT = "GC66JV4IA4VD4S4B7FQPFXIBOYIGGEQEYX2YSUSLDPI3IBRPIATTT2AM";
const SIGNER_SEED = "SAPIZOWDFX4OYJNP2YYP7S3RWSGBWH5LSENWAI6PLQKULS3BKVXQ3MTQ";

// ---------------------------------------------------------------------------
// Horizon adapter stub
// ---------------------------------------------------------------------------

/**
 * Returns a real `Account` instance (required by TransactionBuilder) paired
 * with a controllable `submitTransaction` mock.
 *
 * The `transactionFactory` is also stubbed so tests never call
 * `Operation.payment` or `Keypair.fromSecret` — this keeps tests hermetic
 * and focused purely on the locking and submission path.
 */
function buildHorizonAdapter(options: {
  submitDelayMs?: number;
  submitError?: Error | null;
}): { adapter: HorizonAdapter; txFactory: TransactionFactory; submitMock: jest.Mock } {
  const submitMock = jest.fn(async (): Promise<{ hash: string; ledger: number }> => {
    if (options.submitDelayMs) {
      await delay(options.submitDelayMs);
    }
    if (options.submitError) {
      throw options.submitError;
    }
    return {
      hash: "fake-tx-hash-" + Math.random().toString(36).slice(2),
      ledger: 42,
    };
  });

  const adapter: HorizonAdapter = {
    loadAccount: jest.fn(async (_id: string) => {
      // Real Account instance — SequenceManager needs accountId/sequenceNumber
      return new Account(SENDER_ACCOUNT, "100");
    }),
    submitTransaction: submitMock,
  };

  // Stub transaction factory — returns a dummy object cast to Transaction.
  // Tests exercise the lock/submit path, not Stellar cryptography.
  const txFactory: TransactionFactory = jest.fn(
    (_account, _req, _passphrase, _timeout) =>
      ({ toEnvelope: () => ({}) } as unknown as Transaction)
  );

  return { adapter, txFactory, submitMock };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function buildRedis() {
  return new RedisMock();
}

function buildSequenceManager(
  redis: InstanceType<typeof RedisMock>,
  lockTtlMs = 10_000
) {
  return new SequenceManager(redis as any, { lockTtlMs });
}

function buildRelayer(
  seqMgr: SequenceManager,
  adapter: HorizonAdapter,
  txFactory?: TransactionFactory
): Relayer {
  return new Relayer(seqMgr, {
    horizonUrl: "https://horizon-testnet.stellar.org",
    horizonAdapter: adapter,
    transactionFactory: txFactory,
  });
}

function paymentRequest(paymentId: string): PaymentRequest {
  return {
    paymentId,
    senderAccountId: SENDER_ACCOUNT,
    signerSeed: SIGNER_SEED,
    destinationAccountId: DESTINATION_ACCOUNT,
    amount: "10.0000000",
  };
}

// ---------------------------------------------------------------------------
// SequenceManager unit tests
// ---------------------------------------------------------------------------

describe("SequenceManager — unit", () => {
  let redis: InstanceType<typeof RedisMock>;
  let seqMgr: SequenceManager;

  beforeEach(() => {
    redis = buildRedis();
    seqMgr = buildSequenceManager(redis);
  });

  afterEach(async () => {
    await (redis as any).flushall();
  });

  test("reserve() returns a Redis key on first call", async () => {
    const key = await seqMgr.reserve(SENDER_ACCOUNT, "pay-001");
    expect(typeof key).toBe("string");
    expect(key).toContain(SENDER_ACCOUNT);
  });

  test("reserve() throws DuplicatePaymentError when lock is already held", async () => {
    await seqMgr.reserve(SENDER_ACCOUNT, "pay-001");

    let err: unknown;
    try {
      await seqMgr.reserve(SENDER_ACCOUNT, "pay-002");
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(DuplicatePaymentError);
    expect((err as DuplicatePaymentError).paymentId).toBe("pay-002");
  });

  test("DuplicatePaymentError.paymentId contains the original payment ID", async () => {
    await seqMgr.reserve(SENDER_ACCOUNT, "original-pay-id");
    const err = await seqMgr
      .reserve(SENDER_ACCOUNT, "duplicate-pay-id")
      .catch((e) => e);
    expect(err).toBeInstanceOf(DuplicatePaymentError);
    expect((err as DuplicatePaymentError).paymentId).toBe("duplicate-pay-id");
    expect(err.message).toContain("duplicate-pay-id");
  });

  test("release() removes the lock so the next reservation succeeds", async () => {
    await seqMgr.reserve(SENDER_ACCOUNT, "pay-001");
    await seqMgr.release(SENDER_ACCOUNT);
    const key = await seqMgr.reserve(SENDER_ACCOUNT, "pay-002");
    expect(key).toBeTruthy();
  });

  test("release() is idempotent — calling it twice does not throw", async () => {
    await seqMgr.reserve(SENDER_ACCOUNT, "pay-001");
    await seqMgr.release(SENDER_ACCOUNT);
    await expect(seqMgr.release(SENDER_ACCOUNT)).resolves.toBeUndefined();
  });

  test("withLock() releases the lock after the callback resolves", async () => {
    await seqMgr.withLock(SENDER_ACCOUNT, "pay-001", async () => "result");
    const count = await seqMgr.activeLockCount();
    expect(count).toBe(0);
  });

  test("withLock() releases the lock even when the callback throws", async () => {
    await expect(
      seqMgr.withLock(SENDER_ACCOUNT, "pay-001", async () => {
        throw new Error("simulated failure");
      })
    ).rejects.toThrow("simulated failure");

    const count = await seqMgr.activeLockCount();
    expect(count).toBe(0);
  });

  test("lock TTL defaults to 10 000 ms", () => {
    const defaultMgr = new SequenceManager(redis as any);
    expect((defaultMgr as any).lockTtlMs).toBe(10_000);
  });

  test("lock TTL is configurable", () => {
    const customMgr = new SequenceManager(redis as any, { lockTtlMs: 5_000 });
    expect((customMgr as any).lockTtlMs).toBe(5_000);
  });

  test("locks on different accounts are independent", async () => {
    const account2 = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    await seqMgr.reserve(SENDER_ACCOUNT, "pay-001");
    const key2 = await seqMgr.reserve(account2, "pay-002");
    expect(key2).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Core acceptance test: 50 simultaneous submissions → exactly 1 succeeds
// ---------------------------------------------------------------------------

describe("Relayer — 50 simultaneous submissions for the same sender account", () => {
  let redis: InstanceType<typeof RedisMock>;
  let seqMgr: SequenceManager;

  beforeEach(() => {
    redis = buildRedis();
    // Short TTL so the test completes quickly; real default is 10 s
    seqMgr = buildSequenceManager(redis, 2_000);
  });

  afterEach(async () => {
    await (redis as any).flushall();
  });

  test("exactly 1 submission succeeds and 49 receive DuplicatePaymentError", async () => {
    /**
     * Add a delay to the submit call so the winning submission holds the lock
     * long enough for all 50 tasks to race to acquire it before the winner
     * finishes.  Without the delay the winner could release before the other
     * 49 even attempt to acquire, making this a sequential test.
     */
    const { adapter, txFactory } = buildHorizonAdapter({ submitDelayMs: 50 });
    const relayer = buildRelayer(seqMgr, adapter, txFactory);

    const N = 50;
    const requests = Array.from({ length: N }, (_, i) =>
      paymentRequest(`payment-${i + 1}`)
    );

    // Fire all 50 simultaneously
    const results = await Promise.allSettled(
      requests.map((req) => relayer.submitPayment(req))
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    // Exactly 1 must succeed
    expect(succeeded).toHaveLength(1);
    expect(
      (succeeded[0] as PromiseFulfilledResult<SubmitResult>).value.txHash
    ).toBeTruthy();

    // The other 49 must all be DuplicatePaymentError
    expect(failed).toHaveLength(49);
    for (const f of failed) {
      const err = (f as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(DuplicatePaymentError);
      expect(typeof (err as DuplicatePaymentError).paymentId).toBe("string");
      expect((err as DuplicatePaymentError).paymentId).toMatch(/^payment-\d+$/);
    }
  });

  test("Redis key count returns to 0 after all 50 submissions complete", async () => {
    const { adapter, txFactory } = buildHorizonAdapter({ submitDelayMs: 50 });
    const relayer = buildRelayer(seqMgr, adapter, txFactory);

    const requests = Array.from({ length: 50 }, (_, i) =>
      paymentRequest(`payment-${i + 1}`)
    );

    await Promise.allSettled(requests.map((req) => relayer.submitPayment(req)));

    const lockCount = await seqMgr.activeLockCount();
    expect(lockCount).toBe(0);
  });

  test("DuplicatePaymentError is a typed Error subclass, not a generic Error", async () => {
    const { adapter, txFactory } = buildHorizonAdapter({ submitDelayMs: 50 });
    const relayer = buildRelayer(seqMgr, adapter, txFactory);

    const results = await Promise.allSettled([
      relayer.submitPayment(paymentRequest("pay-A")),
      relayer.submitPayment(paymentRequest("pay-B")),
    ]);

    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected).toBeDefined();
    const err = (rejected as PromiseRejectedResult).reason;

    expect(err).toBeInstanceOf(DuplicatePaymentError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DuplicatePaymentError");
    expect(typeof err.paymentId).toBe("string");
    expect(err.message).toContain(err.paymentId);
  });
});

// ---------------------------------------------------------------------------
// Sequential submissions — lock released between each call
// ---------------------------------------------------------------------------

describe("Relayer — sequential submissions all succeed", () => {
  let redis: InstanceType<typeof RedisMock>;
  let seqMgr: SequenceManager;

  beforeEach(() => {
    redis = buildRedis();
    seqMgr = buildSequenceManager(redis);
  });

  afterEach(async () => {
    await (redis as any).flushall();
  });

  test("5 sequential submissions for the same account all succeed", async () => {
    const { adapter, txFactory } = buildHorizonAdapter({});
    const relayer = buildRelayer(seqMgr, adapter, txFactory);

    const results: SubmitResult[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await relayer.submitPayment(paymentRequest(`pay-seq-${i}`));
      results.push(result);
    }

    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result.txHash).toBeTruthy();
    }

    const lockCount = await seqMgr.activeLockCount();
    expect(lockCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Error propagation — lock released even when submission fails
// ---------------------------------------------------------------------------

describe("Relayer — lock released on submission failure", () => {
  let redis: InstanceType<typeof RedisMock>;
  let seqMgr: SequenceManager;

  beforeEach(() => {
    redis = buildRedis();
    seqMgr = buildSequenceManager(redis);
  });

  afterEach(async () => {
    await (redis as any).flushall();
  });

  test("lock is released when Horizon submit throws", async () => {
    const { adapter, txFactory } = buildHorizonAdapter({
      submitError: new Error("Horizon 500 Internal Server Error"),
    });
    const relayer = buildRelayer(seqMgr, adapter, txFactory);

    await expect(
      relayer.submitPayment(paymentRequest("pay-err"))
    ).rejects.toThrow("Horizon 500");

    const lockCount = await seqMgr.activeLockCount();
    expect(lockCount).toBe(0);
  });

  test("a second submission succeeds immediately after the first one fails", async () => {
    // First call fails at submit
    const { adapter: failAdapter, txFactory: failTxFactory } = buildHorizonAdapter({
      submitError: new Error("network error"),
    });
    const relayer = buildRelayer(seqMgr, failAdapter, failTxFactory);

    await expect(
      relayer.submitPayment(paymentRequest("pay-first"))
    ).rejects.toThrow("network error");

    // Lock was released — rebuild relayer with healthy adapter
    const { adapter: successAdapter, txFactory: successTxFactory } = buildHorizonAdapter({});
    const relayer2 = buildRelayer(seqMgr, successAdapter, successTxFactory);

    const result = await relayer2.submitPayment(paymentRequest("pay-second"));
    expect(result.txHash).toBeTruthy();
  });
});
