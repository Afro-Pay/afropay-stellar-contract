/**
 * errors.ts
 *
 * Typed error classes for the relayer service.
 */

/**
 * Thrown when a duplicate payment submission is detected after the sequence
 * number has already been reserved for the same sender account.
 *
 * A "duplicate" is defined as: two submissions with the same paymentId
 * arriving while a lock is held on the sender account's sequence slot.
 */
export class DuplicatePaymentError extends Error {
  /** The payment ID that was detected as a duplicate. */
  public readonly paymentId: string;

  constructor(paymentId: string) {
    super(
      `Duplicate payment detected: a submission for paymentId "${paymentId}" ` +
        `is already in progress. Concurrent submissions for the same sender ` +
        `account are not permitted.`
    );
    this.name = "DuplicatePaymentError";
    this.paymentId = paymentId;
    // Maintain proper prototype chain for instanceof checks in transpiled code.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the Stellar network rejects a transaction because the sequence
 * number used was incorrect (race condition escaped the Redis lock, or the
 * sequence was bumped by another operation outside this relayer).
 */
export class BadSequenceError extends Error {
  public readonly accountId: string;
  public readonly usedSequence: string;

  constructor(accountId: string, usedSequence: string) {
    super(
      `Stellar rejected transaction for account ${accountId} with ` +
        `TRANSACTION_BAD_SEQ (used sequence=${usedSequence}). ` +
        `The sequence number may have been incremented by a concurrent process.`
    );
    this.name = "BadSequenceError";
    this.accountId = accountId;
    this.usedSequence = usedSequence;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
