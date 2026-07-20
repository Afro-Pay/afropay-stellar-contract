/**
 * tests/logCapture.ts
 *
 * Structured log capture utility for the FX rate oracle integration tests.
 *
 * The aggregator and rate service accept an injected `Logger` function, making
 * it trivial to capture all emitted log payloads in tests without monkey-
 * patching console or any third-party logger.
 *
 * Usage:
 *
 *   const logs = createLogCapture();
 *
 *   const aggregator = new RateAggregator(providers, logs.logger, config);
 *
 *   await aggregator.aggregate("USD/NGN");
 *
 *   // Query captured logs by event name or field
 *   const outlier = logs.findOne("outlier_rejected");
 *   expect(outlier?.provider).toBe("flutterwave");
 *   expect(Number(outlier?.deviationPct)).toBeGreaterThan(2);
 */

import { LogPayload } from "../types";

export interface LogCapture {
  /** The logger function to inject into aggregator / rate service */
  logger: (payload: LogPayload) => void;
  /** All captured log payloads since the last reset(), oldest first. */
  all: () => LogPayload[];
  /** Find the first captured log with the given event name */
  findOne: (event: string) => LogPayload | undefined;
  /** Find all captured logs with the given event name */
  findAll: (event: string) => LogPayload[];
  /** Find all captured logs with a given level */
  findByLevel: (level: LogPayload["level"]) => LogPayload[];
  /** Assert that at least one log with the event name was captured */
  assertEmitted: (event: string) => void;
  /** Assert that no log with the event name was captured */
  assertNotEmitted: (event: string) => void;
  /** Clear all captured payloads */
  reset: () => void;
}

export function createLogCapture(): LogCapture {
  const captured: LogPayload[] = [];

  const logger = (payload: LogPayload): void => {
    captured.push({ ...payload });
  };

  return {
    logger,
    all: () => [...captured],
    findOne: (event) => captured.find((p) => p["event"] === event),
    findAll: (event) => captured.filter((p) => p["event"] === event),
    findByLevel: (level) => captured.filter((p) => p.level === level),
    assertEmitted: (event) => {
      const found = captured.some((p) => p["event"] === event);
      if (!found) {
        const events = captured.map((p) => p["event"]).join(", ");
        throw new Error(
          `Expected log event "${event}" to be emitted but it was not. ` +
            `Captured events: [${events}]`
        );
      }
    },
    assertNotEmitted: (event) => {
      const found = captured.some((p) => p["event"] === event);
      if (found) {
        throw new Error(
          `Expected log event "${event}" NOT to be emitted but it was.`
        );
      }
    },
    reset: () => {
      captured.length = 0;
    },
  };
}
