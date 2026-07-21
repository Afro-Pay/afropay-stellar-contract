/**
 * Real-time escrow timeline (Issue #24).
 *
 * Consumes `useEscrowStream` and animates new events in with a CSS
 * `@keyframes` entrance (skipped under `prefers-reduced-motion`) rather than
 * pulling in framer-motion for a single fade/slide. Each new event is also
 * announced through an `aria-live="polite"` region so screen-reader users
 * get the same real-time update sighted users see in the visual timeline.
 */

import { useEffect, useRef, useState } from "react";
import { useEscrowStream, EscrowEvent } from "../../hooks/useEscrowStream";
import "./EscrowTimeline.css";

export interface EscrowTimelineProps {
  escrowId: string;
  /** API origin override — defaults to same-origin. */
  baseUrl?: string;
}

function describeEvent(event: EscrowEvent): string {
  if (event.type === "created") {
    return `Escrow funded with ${event.amount_usdc} USDC on the ${event.corridor} corridor.`;
  }
  return `Escrow state changed to ${event.state}.`;
}

export function EscrowTimeline({ escrowId, baseUrl }: EscrowTimelineProps): JSX.Element {
  const { events, mode, liveUnavailable } = useEscrowStream(escrowId, baseUrl);
  const [announcement, setAnnouncement] = useState("");
  const announcedCountRef = useRef(0);

  useEffect(() => {
    if (events.length > announcedCountRef.current) {
      setAnnouncement(describeEvent(events[events.length - 1]));
      announcedCountRef.current = events.length;
    }
  }, [events]);

  return (
    <div className="escrow-timeline">
      {liveUnavailable && (
        <div className="escrow-timeline__banner" role="status">
          Live updates unavailable — refreshing every 15 seconds.
        </div>
      )}

      <ol className="escrow-timeline__list">
        {events.map((event, index) => (
          <li key={`${event.occurred_at}-${index}`} className="escrow-timeline__item">
            <span className="escrow-timeline__state">{event.state}</span>
            <span className="escrow-timeline__description">{describeEvent(event)}</span>
            <time className="escrow-timeline__time" dateTime={event.occurred_at}>
              {new Date(event.occurred_at).toLocaleTimeString()}
            </time>
          </li>
        ))}
      </ol>

      {/* Screen-reader-only live region — visually hidden, always announced. */}
      <div aria-live="polite" className="escrow-timeline__sr-only">
        {announcement}
      </div>

      <p className="escrow-timeline__mode" data-mode={mode}>
        {mode === "live" && "Live"}
        {mode === "connecting" && "Connecting…"}
        {mode === "reconnecting" && "Reconnecting…"}
        {mode === "polling" && "Polling"}
      </p>
    </div>
  );
}
