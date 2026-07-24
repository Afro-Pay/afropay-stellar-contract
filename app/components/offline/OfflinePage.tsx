/**
 * OfflinePage — graceful offline fallback (Issue #21).
 *
 * Rendered by the service worker when the user navigates while offline and
 * there is no cached version of the requested page.  Also used as the
 * top-level offline state page in the SPA when navigator.onLine is false.
 *
 * Features:
 * - Clear "you're offline" messaging
 * - Live connectivity indicator: updates in real-time as the connection
 *   comes and goes without requiring a page reload
 * - Shows how many payments are queued for background retry
 */

import React, { useEffect, useState } from "react";
import { listPending, drainOutbox } from "../../sw/outbox";
import "./OfflinePage.css";

export function OfflinePage() {
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [queuedCount, setQueuedCount] = useState<number>(0);
  const [draining, setDraining] = useState(false);

  // ── Connectivity listeners ───────────────────────────────────────────────

  useEffect(() => {
    function onOnline() {
      setIsOnline(true);
      // Attempt to drain the outbox as soon as we come back online.
      setDraining(true);
      drainOutbox()
        .then(() => refreshQueueCount())
        .finally(() => setDraining(false));
    }

    function onOffline() {
      setIsOnline(false);
    }

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // ── Outbox queue count ───────────────────────────────────────────────────

  async function refreshQueueCount(): Promise<void> {
    const items = await listPending();
    setQueuedCount(items.length);
  }

  useEffect(() => {
    void refreshQueueCount();
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <main className="offline-page" role="main" aria-label="Offline status">
      <div className="offline-page__card">
        {/* Connectivity indicator */}
        <div
          className={`offline-page__indicator offline-page__indicator--${
            isOnline ? "online" : "offline"
          }`}
          role="status"
          aria-live="polite"
          data-testid="connectivity-indicator"
        >
          <span
            className="offline-page__dot"
            aria-hidden="true"
          />
          {isOnline ? "Back online" : "No internet connection"}
        </div>

        {!isOnline && (
          <>
            <h1 className="offline-page__title">You're offline</h1>
            <p className="offline-page__body">
              AfroPay needs an internet connection to show live exchange rates
              and escrow status. Payments you've already filled in have been
              saved and will be sent automatically when you reconnect.
            </p>

            {queuedCount > 0 && (
              <div
                className="offline-page__queue"
                aria-live="polite"
                data-testid="queued-count"
              >
                {queuedCount} payment{queuedCount !== 1 ? "s" : ""} waiting to
                send
              </div>
            )}

            <ul className="offline-page__available" aria-label="Available offline">
              <li>✓ View your saved payment forms</li>
              <li>✓ Check your recent transaction history (cached)</li>
            </ul>
          </>
        )}

        {isOnline && (
          <>
            <h1 className="offline-page__title">Connection restored</h1>
            <p className="offline-page__body">
              {draining
                ? "Submitting your queued payments…"
                : "Your queued payments have been submitted. You can continue using AfroPay."}
            </p>
            <a href="/" className="offline-page__cta">
              Return to AfroPay
            </a>
          </>
        )}
      </div>
    </main>
  );
}

export default OfflinePage;
