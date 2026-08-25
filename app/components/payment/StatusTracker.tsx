/**
 * Real-time settlement status tracker component (Issue #83).
 *
 * Re-exports the StatusTracker component for the Vite/React application structure in `app/`.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  useTransactionStream,
  TransactionStreamEvent,
} from "../../hooks/useTransactionStream";
import "./StatusTracker.css";

export interface StatusTrackerProps {
  escrowId: string;
  baseUrl?: string;
}

const STATE_LABELS: Record<string, string> = {
  pending_sender: "Awaiting Sender",
  pending_stellar: "Processing on Stellar",
  pending_receiver: "Awaiting Receiver",
  pending_external: "External Processing",
  oracle_signed: "Oracle Signed",
  settled: "Settled",
  refunded: "Refunded",
  completed: "Completed",
  error: "Error",
};

const STATE_ICONS: Record<string, string> = {
  pending_sender: "⏳",
  pending_stellar: "🔄",
  pending_receiver: "📨",
  pending_external: "🏦",
  oracle_signed: "✍️",
  settled: "✅",
  refunded: "↩️",
  completed: "🎉",
  error: "❌",
};

function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

function stateIcon(state: string): string {
  return STATE_ICONS[state] ?? "•";
}

function describeEvent(event: TransactionStreamEvent): string {
  switch (event.type) {
    case "TransactionCreated":
      return `Transaction created: ${event.amount_usdc} USDC on ${event.corridor} corridor.`;
    case "TransactionSettled":
      return `Settlement complete — payout signed by oracle.${
        event.stellar_tx_hash ? ` Tx: ${event.stellar_tx_hash.slice(0, 12)}…` : ""
      }`;
    case "TransactionRefunded":
      return `Transaction refunded — ${event.amount_usdc} USDC returned.`;
    case "state_changed":
      return `Status: ${stateLabel(event.state)}.`;
    default:
      return `Event: ${event.type}`;
  }
}

export function StatusTracker({ escrowId, baseUrl }: StatusTrackerProps): JSX.Element {
  const { events, mode, liveUnavailable, currentState } =
    useTransactionStream(escrowId, baseUrl);

  const [announcement, setAnnouncement] = useState("");
  const announcedCountRef = useRef(0);

  useEffect(() => {
    if (events.length > announcedCountRef.current) {
      setAnnouncement(describeEvent(events[events.length - 1]));
      announcedCountRef.current = events.length;
    }
  }, [events]);

  const isTerminal =
    currentState === "settled" ||
    currentState === "refunded" ||
    currentState === "completed";

  return (
    <div className="status-tracker" id="settlement-status-tracker">
      {liveUnavailable && (
        <div
          className="status-tracker__banner status-tracker__banner--warning"
          role="status"
        >
          ⚠️ Live updates unavailable — refreshing every 15 seconds.
        </div>
      )}

      {currentState && (
        <div
          className={`status-tracker__summary ${
            isTerminal ? "status-tracker__summary--terminal" : ""
          }`}
          id="settlement-current-state"
        >
          <span className="status-tracker__summary-icon">{stateIcon(currentState)}</span>
          <span className="status-tracker__summary-label">{stateLabel(currentState)}</span>
        </div>
      )}

      <ol className="status-tracker__timeline" id="settlement-timeline">
        {events.map((event, index) => (
          <li
            key={`${event.occurred_at}-${index}`}
            className={`status-tracker__event ${
              index === events.length - 1 ? "status-tracker__event--latest" : ""
            }`}
          >
            <span className="status-tracker__event-icon">
              {stateIcon(event.state)}
            </span>
            <div className="status-tracker__event-body">
              <span className="status-tracker__event-type">
                {stateLabel(event.state)}
              </span>
              <span className="status-tracker__event-description">
                {describeEvent(event)}
              </span>
              <time
                className="status-tracker__event-time"
                dateTime={event.occurred_at}
              >
                {new Date(event.occurred_at).toLocaleTimeString()}
              </time>
            </div>
          </li>
        ))}
      </ol>

      <div
        aria-live="polite"
        className="status-tracker__sr-only"
        id="settlement-announcements"
      >
        {announcement}
      </div>

      <p
        className="status-tracker__mode"
        data-mode={mode}
        id="settlement-connection-mode"
      >
        {mode === "live" && "🟢 Live"}
        {mode === "connecting" && "🔵 Connecting…"}
        {mode === "reconnecting" && "🟡 Reconnecting…"}
        {mode === "polling" && "🟠 Polling"}
      </p>
    </div>
  );
}

export default StatusTracker;
