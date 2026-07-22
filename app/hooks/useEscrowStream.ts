/**
 * Real-time escrow status via Server-Sent Events (Issue #24).
 *
 * Opens an EventSource against `GET /api/v1/escrow/:id/stream`. The browser's
 * EventSource implementation automatically retries a dropped connection and
 * resends the `Last-Event-ID` header of the last event it saw, so replay
 * after a reconnect is handled for free by keeping a single EventSource
 * instance alive across transient errors — we never construct a new one just
 * to "reconnect".
 *
 * After 3 consecutive connection failures (e.g. a corporate proxy blocking
 * SSE) we give up on the stream and fall back to polling
 * `GET /api/v1/escrow/:id` every 15 seconds.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface EscrowEvent {
  escrow_id: string;
  type: "created" | "state_changed";
  state: string;
  corridor: string;
  amount_usdc: string;
  occurred_at: string;
}

export type EscrowStreamMode = "connecting" | "live" | "reconnecting" | "polling";

export interface UseEscrowStreamResult {
  events: EscrowEvent[];
  mode: EscrowStreamMode;
  /** True once SSE has been given up on and polling has taken over. */
  liveUnavailable: boolean;
}

const MAX_CONNECTION_FAILURES = 3;
const POLL_INTERVAL_MS = 15_000;

interface EscrowStatusResponse {
  escrow_id: string;
  state: string;
  corridor: string;
  amount_usdc: string;
  state_changed_at: string;
}

export function useEscrowStream(
  escrowId: string | null | undefined,
  baseUrl = ""
): UseEscrowStreamResult {
  const [events, setEvents] = useState<EscrowEvent[]>([]);
  const [mode, setMode] = useState<EscrowStreamMode>("connecting");
  const [liveUnavailable, setLiveUnavailable] = useState(false);

  const failureCountRef = useRef(0);
  const sourceRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const appendEvent = useCallback((event: EscrowEvent) => {
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
          const res = await fetch(`${baseUrl}/api/v1/escrow/${id}`);
          if (!res.ok) return;
          const data = (await res.json()) as EscrowStatusResponse;
          appendEvent({
            escrow_id: data.escrow_id,
            type: "state_changed",
            state: data.state,
            corridor: data.corridor,
            amount_usdc: data.amount_usdc,
            occurred_at: data.state_changed_at,
          });
        } catch {
          // Network hiccup — try again on the next tick.
        }
      };

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
      const source = new EventSource(`${baseUrl}/api/v1/escrow/${id}/stream`);
      sourceRef.current = source;

      source.addEventListener("escrow_event", (evt) => {
        failureCountRef.current = 0;
        setMode("live");
        setLiveUnavailable(false);
        try {
          const parsed = JSON.parse((evt as MessageEvent<string>).data) as EscrowEvent;
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

  return { events, mode, liveUnavailable };
}
