/**
 * Real-time transaction settlement stream via Server-Sent Events (Issue #83).
 *
 * Opens an EventSource against `GET /transactions/stream/:escrow_id`. The
 * browser's EventSource implementation automatically retries a dropped
 * connection and resends the `Last-Event-ID` header, so replay after a
 * reconnect is handled automatically.
 *
 * After 3 consecutive connection failures (e.g. a corporate proxy blocking
 * SSE) we give up on the stream and fall back to polling
 * `GET /transactions/:escrow_id/status` every 15 seconds.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransactionStreamEvent {
  escrow_id: string;
  type: "TransactionCreated" | "TransactionSettled" | "TransactionRefunded" | "state_changed";
  state: string;
  corridor: string;
  amount_usdc: string;
  occurred_at: string;
  stellar_tx_hash: string | null;
}

export type StreamMode = "connecting" | "live" | "reconnecting" | "polling";

export interface UseTransactionStreamResult {
  events: TransactionStreamEvent[];
  mode: StreamMode;
  /** True once SSE has been given up on and polling has taken over. */
  liveUnavailable: boolean;
  /** The latest transaction state, derived from the most recent event. */
  currentState: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONNECTION_FAILURES = 3;
const POLL_INTERVAL_MS = 15_000;

interface StatusPollResponse {
  escrow_id: string;
  state: string;
  corridor: string | null;
  amount_usdc: string;
  updated_at: string;
  stellar_tx_hash: string | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTransactionStream(
  escrowId: string | null | undefined,
  baseUrl = ""
): UseTransactionStreamResult {
  const [events, setEvents] = useState<TransactionStreamEvent[]>([]);
  const [mode, setMode] = useState<StreamMode>("connecting");
  const [liveUnavailable, setLiveUnavailable] = useState(false);

  const failureCountRef = useRef(0);
  const sourceRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const appendEvent = useCallback((event: TransactionStreamEvent) => {
    setEvents((prev) => [...prev, event]);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      setMode("polling");
      setLiveUnavailable(true);

      const poll = async () => {
        try {
          const res = await fetch(`${baseUrl}/transactions/${id}/status`);
          if (!res.ok) return;
          const data = (await res.json()) as StatusPollResponse;
          appendEvent({
            escrow_id: data.escrow_id,
            type: "state_changed",
            state: data.state,
            corridor: data.corridor ?? "",
            amount_usdc: data.amount_usdc,
            occurred_at: data.updated_at,
            stellar_tx_hash: data.stellar_tx_hash,
          });
        } catch {
          // Network hiccup — try again on the next tick.
        }
      };

      poll();
      pollTimerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    },
    [appendEvent, baseUrl, stopPolling]
  );

  const closeSource = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const connect = useCallback(
    (id: string) => {
      const source = new EventSource(`${baseUrl}/transactions/stream/${id}`);
      sourceRef.current = source;

      source.addEventListener("settlement_event", (evt) => {
        failureCountRef.current = 0;
        setMode("live");
        setLiveUnavailable(false);
        try {
          const parsed = JSON.parse(
            (evt as MessageEvent<string>).data
          ) as TransactionStreamEvent;
          appendEvent(parsed);
        } catch {
          // Malformed payload — drop it, the connection itself is still healthy.
        }
      });

      source.onopen = () => {
        failureCountRef.current = 0;
        setMode("live");
        setLiveUnavailable(false);
      };

      source.onerror = () => {
        failureCountRef.current += 1;
        if (failureCountRef.current >= MAX_CONNECTION_FAILURES) {
          closeSource();
          startPolling(id);
          return;
        }
        setMode("reconnecting");
      };
    },
    [appendEvent, baseUrl, closeSource, startPolling]
  );

  useEffect(() => {
    if (!escrowId) return undefined;

    failureCountRef.current = 0;
    setEvents([]);
    setMode("connecting");
    setLiveUnavailable(false);

    connect(escrowId);

    return () => {
      closeSource();
      stopPolling();
    };
  }, [escrowId, connect, closeSource, stopPolling]);

  const currentState =
    events.length > 0 ? events[events.length - 1].state : null;

  return { events, mode, liveUnavailable, currentState };
}
