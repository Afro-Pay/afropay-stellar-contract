# afropay-relayer

Stellar transaction relayer with atomic Redis-backed sequence-number reservation.

## Problem

Stellar transactions require a monotonically-increasing sequence number per account. Under concurrent load, two relayer processes (or two async tasks in the same process) can both fetch the same current sequence number from Horizon, build conflicting transactions, and submit them simultaneously. One fails with `TRANSACTION_BAD_SEQ`; if undetected the payment escrow is left in a stuck `Funded` state.

## Solution: Redis SET NX Locking

Before building any transaction, the relayer atomically acquires a per-account lock via **Redis `SET NX PX`**:

```
SET afropay:seq:<accountId> <paymentId> NX PX <ttlMs>
```

- **`NX`** — only set if the key does not exist (atomic check-and-set).
- **`PX <ttlMs>`** — auto-expiry TTL so a crashed process cannot hold the lock forever.
- **`<paymentId>`** — stored as the value so duplicate submissions can be identified.

If the key already exists, a `DuplicatePaymentError` is thrown immediately — the second concurrent caller never reaches Horizon.

## Locking Strategy

```
Submission A (wins lock)         Submission B (rejected)
─────────────────────────────    ──────────────────────────
SET afropay:seq:G… → OK          SET afropay:seq:G… → null
loadAccount(G…)                  throw DuplicatePaymentError
buildTransaction(seq=101)
sign(tx)
submitTransaction(tx)
DEL afropay:seq:G…
```

### Key design decisions

| Property | Detail |
|----------|--------|
| **Lock scope** | Per sender account — serialises all submissions for a given `G…` address |
| **Lock TTL** | `2 × Stellar ledger close time` — default **10 000 ms**, configurable via `lockTtlMs` |
| **Lock value** | `paymentId` — stored for observability; not used for re-entrancy (same-payment retry goes through a separate dedup layer) |
| **Atomicity** | Single Redis command (`SET NX PX`) — no WATCH/MULTI required, safe across multiple relayer replicas sharing one Redis |
| **Release** | Always in a `finally` block via `SequenceManager.withLock()` — guaranteed release on both success and error |
| **Crash safety** | TTL ensures the lock expires automatically if the process dies before releasing |

## Files

| File | Purpose |
|------|---------|
| `sequenceManager.ts` | Redis-backed lock — `reserve()`, `release()`, `withLock()` |
| `submit.ts` | `Relayer` class — acquires lock, loads account, builds & submits transaction |
| `errors.ts` | `DuplicatePaymentError`, `BadSequenceError` typed error classes |
| `tests/submit.test.ts` | Unit + concurrency tests (50 simultaneous submissions) |

## Configuration

```typescript
import Redis from "ioredis";
import { SequenceManager } from "./sequenceManager";
import { Relayer } from "./submit";

const redis = new Redis(process.env.REDIS_URL);

const sequenceManager = new SequenceManager(redis, {
  lockTtlMs: 10_000,   // default: 10 s (2× ledger close time)
  keyPrefix: "afropay:seq", // default
});

const relayer = new Relayer(sequenceManager, {
  horizonUrl: process.env.HORIZON_URL,
  networkPassphrase: process.env.NETWORK_PASSPHRASE, // defaults to testnet
});
```

## Usage

```typescript
import { DuplicatePaymentError, BadSequenceError } from "./errors";

try {
  const result = await relayer.submitPayment({
    paymentId: "pay-uuid-here",
    senderAccountId: "G...",
    signerSeed: "S...",
    destinationAccountId: "G...",
    amount: "100.0000000",
  });
  console.log("submitted:", result.txHash, "in ledger", result.ledger);
} catch (err) {
  if (err instanceof DuplicatePaymentError) {
    // A concurrent submission for this sender is already in progress.
    // Surface 409 Conflict to the caller — do not retry automatically.
    console.warn("duplicate submission rejected:", err.paymentId);
  } else if (err instanceof BadSequenceError) {
    // Horizon rejected due to sequence mismatch — safe to retry once
    // after a short delay (the sequence will have been updated).
    console.warn("bad sequence for account:", err.accountId);
  } else {
    throw err;
  }
}
```

## Running Tests

```bash
cd services/relayer
npm install
npm test
```

### Concurrency test

`tests/submit.test.ts` contains a test that spawns **50 simultaneous payment submissions** for the same sender account and asserts:

- Exactly **1** succeeds.
- **49** receive `DuplicatePaymentError`.
- Redis key count returns to **0** after all submissions complete (lock always released).

No real Redis or Horizon instance is required — `ioredis-mock` is used for the Redis layer and the Horizon server is stubbed.
