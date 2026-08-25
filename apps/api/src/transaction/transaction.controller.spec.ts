/**
 * Unit tests for TransactionController (Issue #83).
 *
 * Tests the RxJS Observable-based SSE stream for settlement monitoring:
 *   - Event replay via Last-Event-ID
 *   - Live event emission on TransactionSettled and TransactionRefunded
 *   - 404 (null) for invalid escrow IDs
 *   - Observable cleanup on unsubscription
 */

import {
  TransactionService,
  TransactionEvent,
} from "./transaction.service";
import {
  TransactionController,
  SseMessageEvent,
} from "./transaction.controller";

// We test with the module-level singletons, so reset between tests
import { transactionService } from "./transaction.service";

beforeEach(() => {
  transactionService.eventStore.reset();
});

describe("TransactionController.streamSettlement()", () => {
  const controller = new TransactionController();

  it("returns null for an unknown escrow_id", () => {
    const result = controller.streamSettlement("nonexistent");
    expect(result).toBeNull();
  });

  it("replays existing events for a fresh connection (no Last-Event-ID)", (done) => {
    const escrowId = "test-escrow-1";
    transactionService.createTransaction(escrowId, "USD_NGN", "100.0000000");

    const observable = controller.streamSettlement(escrowId);
    expect(observable).not.toBeNull();

    const received: SseMessageEvent[] = [];
    const subscription = observable!.subscribe({
      next: (msg) => {
        received.push(msg);
        // After receiving the replayed event, verify and complete
        if (received.length === 1) {
          const data = JSON.parse(msg.data);
          expect(msg.id).toBe("1");
          expect(msg.type).toBe("settlement_event");
          expect(data.type).toBe("TransactionCreated");
          expect(data.state).toBe("pending_sender");
          expect(data.escrow_id).toBe(escrowId);
          subscription.unsubscribe();
          done();
        }
      },
    });
  });

  it("replays only events after Last-Event-ID", (done) => {
    const escrowId = "test-escrow-2";
    transactionService.createTransaction(escrowId, "USD_NGN", "200.0000000"); // id 1
    transactionService.settleTransaction(escrowId, "USD_NGN", "200.0000000", "tx-hash"); // id 2

    const observable = controller.streamSettlement(escrowId, "1");
    expect(observable).not.toBeNull();

    const received: SseMessageEvent[] = [];
    const subscription = observable!.subscribe({
      next: (msg) => {
        if (msg.type === "heartbeat") return; // skip heartbeats
        received.push(msg);
        if (received.length === 1) {
          const data = JSON.parse(msg.data);
          expect(msg.id).toBe("2");
          expect(data.type).toBe("TransactionSettled");
          expect(data.state).toBe("settled");
          expect(data.stellar_tx_hash).toBe("tx-hash");
          subscription.unsubscribe();
          done();
        }
      },
    });
  });

  it("pushes live TransactionSettled events to already-subscribed observers", (done) => {
    const escrowId = "test-escrow-3";
    transactionService.createTransaction(escrowId, "EUR_GHS", "50.0000000");

    const observable = controller.streamSettlement(escrowId, "1");
    expect(observable).not.toBeNull();

    const subscription = observable!.subscribe({
      next: (msg) => {
        if (msg.type === "heartbeat") return;
        const data = JSON.parse(msg.data);
        expect(data.type).toBe("TransactionSettled");
        expect(data.state).toBe("settled");
        subscription.unsubscribe();
        done();
      },
    });

    // Emit a settlement event after subscription
    setTimeout(() => {
      transactionService.settleTransaction(escrowId, "EUR_GHS", "50.0000000", "live-hash");
    }, 50);
  });

  it("pushes live TransactionRefunded events", (done) => {
    const escrowId = "test-escrow-4";
    transactionService.createTransaction(escrowId, "GBP_KES", "75.0000000");

    const observable = controller.streamSettlement(escrowId, "1");
    expect(observable).not.toBeNull();

    const subscription = observable!.subscribe({
      next: (msg) => {
        if (msg.type === "heartbeat") return;
        const data = JSON.parse(msg.data);
        expect(data.type).toBe("TransactionRefunded");
        expect(data.state).toBe("refunded");
        subscription.unsubscribe();
        done();
      },
    });

    setTimeout(() => {
      transactionService.refundTransaction(escrowId, "GBP_KES", "75.0000000");
    }, 50);
  });

  it("cleans up subscription and heartbeat on unsubscribe", (done) => {
    const escrowId = "test-escrow-5";
    transactionService.createTransaction(escrowId, "USD_NGN", "300.0000000");

    const observable = controller.streamSettlement(escrowId, "1");
    expect(observable).not.toBeNull();

    const subscription = observable!.subscribe({
      next: () => {
        // Ignore events
      },
    });

    // Unsubscribe immediately
    subscription.unsubscribe();

    // Emit an event after unsubscribe — should NOT throw or cause issues
    setTimeout(() => {
      transactionService.settleTransaction(escrowId, "USD_NGN", "300.0000000");
      // If we get here without errors, cleanup worked correctly
      done();
    }, 100);
  });
});

describe("TransactionService domain event helpers", () => {
  it("createTransaction appends a TransactionCreated event", () => {
    const event = transactionService.createTransaction("svc-test-1", "USD_NGN", "100.0000000");
    expect(event.type).toBe("TransactionCreated");
    expect(event.state).toBe("pending_sender");
    expect(event.escrowId).toBe("svc-test-1");
    expect(event.id).toBeGreaterThan(0);
    expect(event.occurredAt).toBeDefined();
  });

  it("settleTransaction appends a TransactionSettled event", () => {
    transactionService.createTransaction("svc-test-2", "USD_NGN", "200.0000000");
    const event = transactionService.settleTransaction("svc-test-2", "USD_NGN", "200.0000000", "hash-abc");
    expect(event.type).toBe("TransactionSettled");
    expect(event.state).toBe("settled");
    expect(event.stellarTxHash).toBe("hash-abc");
  });

  it("refundTransaction appends a TransactionRefunded event", () => {
    transactionService.createTransaction("svc-test-3", "EUR_GHS", "50.0000000");
    const event = transactionService.refundTransaction("svc-test-3", "EUR_GHS", "50.0000000");
    expect(event.type).toBe("TransactionRefunded");
    expect(event.state).toBe("refunded");
  });

  it("transitionState appends a state_changed event", () => {
    transactionService.createTransaction("svc-test-4", "GBP_KES", "75.0000000");
    const event = transactionService.transitionState("svc-test-4", "oracle_signed", "GBP_KES", "75.0000000");
    expect(event.type).toBe("state_changed");
    expect(event.state).toBe("oracle_signed");
  });
});
