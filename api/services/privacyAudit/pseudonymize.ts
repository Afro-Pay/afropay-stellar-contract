/**
 * services/privacyAudit/pseudonymize.ts
 *
 * Deterministic, keyed pseudonymization for NDPA right-to-erasure.
 *
 * ## Why HMAC-SHA256 (not encryption)?
 *
 * NDPA s.65 requires erasure that makes data "no longer attributable to an
 * identified or identifiable natural person without the use of additional
 * information."  HMAC-SHA256 with a secret key satisfies this:
 *
 *  - Without the key the hash is computationally irreversible.
 *  - With the key the same input always produces the same output, so
 *    pseudonymized records remain joinable for CBN audit purposes without
 *    exposing the original PII.
 *  - The key is stored separately from the data (env var / secret manager),
 *    so it can be destroyed post-retention to achieve full anonymisation.
 *
 * ## Usage
 *
 * ```ts
 * import { pseudonymize, pseudonymizeFields } from './pseudonymize';
 *
 * // Single field
 * const hash = pseudonymize('Amara Okafor', process.env.PSEUDONYM_KEY!);
 * // → "hmac:a3f1b2..."   (prefixed so pseudonyms are distinguishable from real values)
 *
 * // Bulk field replacement on a Customer record
 * const erased = pseudonymizeFields(customer.fields, process.env.PSEUDONYM_KEY!);
 * ```
 */

import { createHmac } from "crypto";

/** Prefix applied to every pseudonymized value so it is visibly identifiable. */
export const PSEUDONYM_PREFIX = "erased:";

/**
 * Compute a deterministic HMAC-SHA256 pseudonym for a PII value.
 *
 * @param value  The original PII string (e.g. "Amara Okafor").
 * @param key    Secret HMAC key (32+ bytes recommended; read from env var).
 * @returns      `"erased:<hex-digest>"` — always the same for the same
 *               (value, key) pair.
 */
export function pseudonymize(value: string, key: string): string {
  const digest = createHmac("sha256", key).update(value, "utf8").digest("hex");
  return `${PSEUDONYM_PREFIX}${digest}`;
}

/**
 * Returns true when a field value has already been pseudonymized.
 * Used to make erasure idempotent.
 */
export function isPseudonymized(value: string): boolean {
  return value.startsWith(PSEUDONYM_PREFIX);
}

/**
 * Apply pseudonymization to a set of named PII fields.
 *
 * Only fields whose names are in `fieldsToErase` are replaced.
 * Fields not in the set are returned unchanged.
 * Already-pseudonymized values are left intact (idempotent).
 *
 * @param fields        Original field map (e.g. customer.fields).
 * @param fieldsToErase Names of fields to replace with pseudonyms.
 * @param key           HMAC key (from PSEUDONYM_KEY env var).
 * @returns             New field map with erased fields replaced.
 */
export function pseudonymizeFields(
  fields: Record<string, string>,
  fieldsToErase: string[],
  key: string
): Record<string, string> {
  const erased: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (fieldsToErase.includes(name) && !isPseudonymized(value)) {
      erased[name] = pseudonymize(value, key);
    } else {
      erased[name] = value;
    }
  }
  return erased;
}

/**
 * Derive a stable per-account pseudonym for use in references that survive
 * erasure (e.g. `customer.account` stored in transaction records).
 *
 * This is separate from `pseudonymize()` so its output is keyed on both the
 * account address AND a fixed domain string — preventing cross-domain hash
 * collisions if the same key is reused elsewhere.
 */
export function pseudonymizeAccount(account: string, key: string): string {
  const scoped = `account:${account}`;
  return pseudonymize(scoped, key);
}
