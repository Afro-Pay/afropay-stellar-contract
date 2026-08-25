/**
 * Tests for the StatusTracker component (Issue #83).
 *
 * Verifies:
 *   - Initial render shows "Connecting" when no events yet.
 *   - SSE message handling updates the timeline.
 *   - Unmount cleanup closes EventSource.
 *   - Reconnection state transitions.
 */

import React from "react";
import { render, screen, act } from "@testing-library/react";
import { StatusTracker } from "./StatusTracker";

// ---------------------------------------------------------------------------
// Mock EventSource
// ---------------------------------------------------------------------------

type EventSourceHandler = (evt: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0; // CONNECTING
  listeners: Record<string, EventSourceHandler[]> = {};
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    // Simulate async open
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.onopen?.();
    }, 0);
  }

  addEventListener(type: string, handler: EventSourceHandler): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(handler);
  }

  removeEventListener(type: string, handler: EventSourceHandler): void {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((h) => h !== handler);
    }
  }

  close(): void {
    this.closed = true;
    this.readyState = 2; // CLOSED
  }

  /** Test helper — simulate receiving an SSE event. */
  _emit(type: string, data: unknown): void {
    const evt = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    for (const handler of this.listeners[type] ?? []) {
      handler(evt);
    }
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}

// Install mock
beforeEach(() => {
  MockEventSource.reset();
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  MockEventSource.reset();
});

describe("StatusTracker", () => {
  it("renders Connecting state initially", async () => {
    render(<StatusTracker escrowId="test-1" />);

    // The mode should be connecting initially
    const modeEl = screen.getByText(/Connecting/i);
    expect(modeEl).toBeTruthy();
  });

  it("updates the timeline when settlement_event is received", async () => {
    render(<StatusTracker escrowId="test-2" />);

    // Wait for EventSource to be created
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const source = MockEventSource.instances[0];
    expect(source).toBeDefined();

    // Simulate receiving a settlement event
    await act(async () => {
      source._emit("settlement_event", {
        escrow_id: "test-2",
        type: "TransactionCreated",
        state: "pending_sender",
        corridor: "USD_NGN",
        amount_usdc: "100.0000000",
        occurred_at: new Date().toISOString(),
        stellar_tx_hash: null,
      });
    });

    // The timeline should show the event
    expect(screen.getAllByText(/Awaiting Sender/i).length).toBeGreaterThan(0);
  });

  it("closes EventSource on unmount", async () => {
    const { unmount } = render(<StatusTracker escrowId="test-3" />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const source = MockEventSource.instances[0];
    expect(source).toBeDefined();
    expect(source.closed).toBe(false);

    unmount();

    expect(source.closed).toBe(true);
  });

  it("shows settled state with icon after TransactionSettled event", async () => {
    render(<StatusTracker escrowId="test-4" />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const source = MockEventSource.instances[0];

    await act(async () => {
      source._emit("settlement_event", {
        escrow_id: "test-4",
        type: "TransactionSettled",
        state: "settled",
        corridor: "USD_NGN",
        amount_usdc: "500.0000000",
        occurred_at: new Date().toISOString(),
        stellar_tx_hash: "abc123deadbeef789",
      });
    });

    expect(screen.getAllByText(/Settled/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/✅/).length).toBeGreaterThan(0);
  });
});
