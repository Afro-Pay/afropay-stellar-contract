/**
 * RateDisplay — shows the current FX rate for a corridor (Issue #21).
 *
 * Displays a non-blocking warning banner when the cached rate is more than
 * 60 seconds old.  The banner disappears automatically when a fresh rate is
 * loaded.
 *
 * Props:
 *  - corridor: e.g. "USD_NGN"
 *  - apiBaseUrl: base URL for /api/v1/rates (defaults to same-origin)
 *  - pollIntervalMs: how often to refresh (default 30 000 ms / 30 s)
 */

import React, { useEffect, useRef, useState } from "react";
import "./RateDisplay.css";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateData {
  corridor: string;
  rate: number;
  fetchedAt: number; // epoch milliseconds
}

export interface RateDisplayProps {
  corridor: string;
  apiBaseUrl?: string;
  /** Override for testing — default 30 000 ms */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Stale threshold
// ---------------------------------------------------------------------------

const STALE_THRESHOLD_MS = 60_000; // 60 seconds

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RateDisplay({
  corridor,
  apiBaseUrl = "",
  pollIntervalMs = 30_000,
}: RateDisplayProps) {
  const [rateData, setRateData] = useState<RateData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stalenessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fetch the current rate ───────────────────────────────────────────────

  async function fetchRate(): Promise<void> {
    try {
      const url = `${apiBaseUrl}/api/v1/rates?corridor=${encodeURIComponent(corridor)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const fetched: RateData = {
        corridor,
        rate: Number(json.rate),
        fetchedAt: Date.now(),
      };
      setRateData(fetched);
      setIsStale(false);
      setError(null);
      scheduleStaleCheck(fetched.fetchedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rate unavailable");
    }
  }

  // ── Schedule the stale-data timer ────────────────────────────────────────

  function scheduleStaleCheck(fetchedAt: number): void {
    if (stalenessTimerRef.current) clearTimeout(stalenessTimerRef.current);
    const elapsed = Date.now() - fetchedAt;
    const remaining = STALE_THRESHOLD_MS - elapsed;
    if (remaining <= 0) {
      setIsStale(true);
      return;
    }
    stalenessTimerRef.current = setTimeout(() => {
      setIsStale(true);
    }, remaining);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  useEffect(() => {
    void fetchRate();
    intervalRef.current = setInterval(() => void fetchRate(), pollIntervalMs);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (stalenessTimerRef.current) clearTimeout(stalenessTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corridor, apiBaseUrl, pollIntervalMs]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="rate-display" data-testid="rate-display">
      {/* Stale-rate banner — visible only when the displayed rate is > 60 s old */}
      {isStale && (
        <div
          className="rate-display__stale-banner"
          role="status"
          aria-live="polite"
          data-testid="stale-rate-banner"
        >
          ⚠️ Rate data may be outdated. Refreshing…
        </div>
      )}

      {error ? (
        <div className="rate-display__error" role="alert" data-testid="rate-error">
          {error}
        </div>
      ) : rateData ? (
        <div className="rate-display__value" data-testid="rate-value">
          <span className="rate-display__corridor">{rateData.corridor.replace("_", " / ")}</span>
          <span className="rate-display__rate">{rateData.rate.toLocaleString()}</span>
        </div>
      ) : (
        <div className="rate-display__loading" aria-busy="true" data-testid="rate-loading">
          Loading rate…
        </div>
      )}
    </div>
  );
}

export default RateDisplay;
