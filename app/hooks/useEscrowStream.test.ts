/**
 * Acceptance criteria for Issue #24 covered here:
 *  - The SSE connection is closed and cleaned up when the component unmounts
 *    (no memory leaks).
 *  - New events pushed on the `escrow_event` channel are appended.
 *  - After 3 consecutive connection failures, the hook switches to polling
 *    and reports `liveUnavailable`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useEscrowStream } from "./useEscrowStream";

type Listener = (event: { data: string }) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  closed = false;
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    this.listeners[type] = this.listeners[type] ?? [];
    this.listeners[type].push(cb);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: string): void {
    (this.listeners[type] ?? []).forEach((cb) => cb({ data }));
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  // @ts-expect-error — jsdom has no native EventSource; this test shim stands in for it.
  globalThis.EventSource = MockEventSource;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useEscrowStream", () => {
  it("closes the EventSource when the component unmounts", () => {
    const { unmount } = renderHook(() => useEscrowStream("escrow-1"));
    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0];
    expect(source.closed).toBe(false);

    unmount();

    expect(source.closed).toBe(true);
  });

  it("appends events received on the escrow_event channel and reports live mode", () => {
    const { result } = renderHook(() => useEscrowStream("escrow-1"));
    const source = MockEventSource.instances[0];

    act(() => {
      source.emit(
        "escrow_event",
        JSON.stringify({
          escrow_id: "escrow-1",
          type: "state_changed",
          state: "Released",
          corridor: "USD_NGN",
          amount_usdc: "100.0000000",
          occurred_at: new Date(0).toISOString(),
        })
      );
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].state).toBe("Released");
    expect(result.current.mode).toBe("live");
    expect(result.current.liveUnavailable).toBe(false);
  });

  it("switches to polling after 3 consecutive connection failures", () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        escrow_id: "escrow-1",
        state: "Funded",
        corridor: "USD_NGN",
        amount_usdc: "100.0000000",
        state_changed_at: new Date(0).toISOString(),
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useEscrowStream("escrow-1"));
    const source = MockEventSource.instances[0];

    act(() => {
      source.onerror?.();
      source.onerror?.();
    });
    expect(result.current.mode).toBe("reconnecting");
    expect(result.current.liveUnavailable).toBe(false);

    act(() => {
      source.onerror?.();
    });

    expect(result.current.mode).toBe("polling");
    expect(result.current.liveUnavailable).toBe(true);
    expect(source.closed).toBe(true);
  });

  it("clears the polling interval on unmount after falling back", () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        escrow_id: "escrow-1",
        state: "Funded",
        corridor: "USD_NGN",
        amount_usdc: "100.0000000",
        state_changed_at: new Date(0).toISOString(),
      }),
    }) as unknown as typeof fetch;

    const { unmount } = renderHook(() => useEscrowStream("escrow-1"));
    const source = MockEventSource.instances[0];

    act(() => {
      source.onerror?.();
      source.onerror?.();
      source.onerror?.();
    });

    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
