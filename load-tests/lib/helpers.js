/**
 * Shared helpers for AfroPay k6 load tests.
 */

/** All supported payment corridors. */
const CORRIDORS = ["USD_NGN", "EUR_GHS", "GBP_KES", "USD_USD"];

/**
 * Return a random corridor from the supported list.
 * @returns {string}
 */
export function randomCorridor() {
  return CORRIDORS[Math.floor(Math.random() * CORRIDORS.length)];
}

/**
 * Return a specific corridor by index (useful for VU partitioning).
 * @param {number} index
 * @returns {string}
 */
export function corridorByIndex(index) {
  return CORRIDORS[index % CORRIDORS.length];
}
