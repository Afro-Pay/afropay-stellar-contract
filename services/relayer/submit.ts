/**
 * submit.ts
 *
 * Stellar transaction submission with atomic sequence-number reservation.
 *
 * Every payment submission goes through a four-step pipeline:
 *
 *   1. Acquire Redis sequence lock for the sender account
 *      (`SequenceManager.withLock`) — blocks any concurrent submission for
 *      the same account until this one completes.
 *
 *   2. Fetch the current sequence number from Horizon.
 *      Because the lock serialises submissions for this account, the fetch
 *      is always accurate: no other submission can increment the sequence
 *      while we hold the lock.
 *
 *   3. Build and sign the transaction using the fetched sequence number.
 *
 *   4. Submit to Horizon.
 *      On TRANSACTION_BAD_SEQ a `BadSequenceError` is thrown so the caller
 *      can retry with a fresh sequence fetch.
 *      The lock is released in the `finally` block of `withLock` regardless
 *      of outcome.
 *
 * Concurrency guarantee
 * ─────────────────────
 * With the Redis lock in place, 50 simultaneous submissions for the same
 * sender account will be serialised: exactly 1 will acquire the lock, build
 * and submit, and then release it.  The remaining 49 will receive a
 * `DuplicatePaymentError` immediately after the first lock is acquired.
 *
 * This is intentional: AfroPay does not retry on behalf of the caller.
 * The caller (e.g. the webhook processor) is responsible for deduplicating
 * requests before calling `submitPayment`.
 */

import {
  Horizon,
  Keypair,
  TransactionBuilder,
  Asset,
  BASE_FEE,
  Networks,
  Account,
  Operation,
  Memo,
  Transaction,
} from "@stellar/stellar-sdk";
import { BadSequenceError, DuplicatePaymentError } from "./errors";
import { SequenceManager } from "./sequenceManager";

export { DuplicatePaymentError, BadSequenceError };

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface PaymentRequest {
  /** Unique payment identifier — used as the Redis lock value. */
  paymentId: string;
  /** Stellar account ID of the sender (G… address). */
  senderAccountId: string;
  /** Base58-encoded secret seed of the signing keypair. */
  signerSeed: string;
  /** Destination Stellar account ID. */
  destinationAccountId: string;
  /** Asset to send (defaults to native XLM when omitted). */
  asset?: { code: string; issuer: string };
  /** Amount as a string, e.g. "100.0000000". */
  amount: string;
  /** Optional memo text (≤28 bytes). */
  memo?: string;
}

export interface SubmitResult {
  /** Horizon transaction hash. */
  txHash: string;
  /** Stellar ledger number the transaction was included in. */
  ledger: number;
}

// ---------------------------------------------------------------------------
// Horizon adapter interface — injectable for testing
// ---------------------------------------------------------------------------

/**
 * Minimal interface over Horizon.Server so tests can inject a stub without
 * importing or constructing a real Horizon server.
 */
export interface HorizonAdapter {
  loadAccount(accountId: string): Promise<Account>;
  submitTransaction(tx: Transaction): Promise<{ hash: string; ledger: number }>;
}

/**
 * Transaction builder/signer function — injectable so tests can bypass
 * Stellar SDK validation (which requires valid keypairs and destination
 * addresses) and focus purely on locking behavior.
 */
export type TransactionFactory = (
  account: Account,
  req: PaymentRequest,
  networkPassphrase: string,
  txTimeoutSeconds: number
) => Transaction;

// ---------------------------------------------------------------------------
// Default transaction factory — builds and signs a real Stellar transaction
// ---------------------------------------------------------------------------

export function defaultTransactionFactory(
  account: Account,
  req: PaymentRequest,
  networkPassphrase: string,
  txTimeoutSeconds: number
): Transaction {
  const asset = req.asset
    ? new Asset(req.asset.code, req.asset.issuer)
    : Asset.native();

  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: req.destinationAccountId,
        asset,
        amount: req.amount,
      })
    )
    .setTimeout(txTimeoutSeconds);

  if (req.memo) {
    builder.addMemo(Memo.text(req.memo));
  }

  const tx = builder.build();
  const keypair = Keypair.fromSecret(req.signerSeed);
  tx.sign(keypair);
  return tx;
}

// ---------------------------------------------------------------------------
// Relayer configuration
// ---------------------------------------------------------------------------

export interface RelayerConfig {
  /** Horizon base URL. */
  horizonUrl: string;
  /** Stellar network passphrase. Defaults to testnet. */
  networkPassphrase?: string;
  /** Transaction timeout in seconds (added to the transaction envelope). Default: 30. */
  txTimeoutSeconds?: number;
  /**
   * Override the Horizon adapter.  Used in tests to inject a stub without
   * making real network calls.
   */
  horizonAdapter?: HorizonAdapter;
  /**
   * Override the transaction factory.  Used in tests to bypass Stellar SDK
   * validation (valid keypairs, destination addresses) and focus on locking.
   */
  transactionFactory?: TransactionFactory;
}

// ---------------------------------------------------------------------------
// Default Horizon adapter backed by the real Horizon.Server
// ---------------------------------------------------------------------------

class DefaultHorizonAdapter implements HorizonAdapter {
  private readonly server: Horizon.Server;

  constructor(horizonUrl: string) {
    this.server = new Horizon.Server(horizonUrl, { allowHttp: true });
  }

  async loadAccount(accountId: string): Promise<Account> {
    return this.server.loadAccount(accountId) as Promise<Account>;
  }

  async submitTransaction(tx: Transaction): Promise<{ hash: string; ledger: number }> {
    const response = await this.server.submitTransaction(tx);
    return { hash: response.hash, ledger: response.ledger };
  }
}

// ---------------------------------------------------------------------------
// Relayer
// ---------------------------------------------------------------------------

export class Relayer {
  private readonly horizon: HorizonAdapter;
  private readonly networkPassphrase: string;
  private readonly txTimeoutSeconds: number;
  private readonly txFactory: TransactionFactory;

  constructor(
    private readonly sequenceManager: SequenceManager,
    config: RelayerConfig
  ) {
    this.networkPassphrase = config.networkPassphrase ?? Networks.TESTNET;
    this.txTimeoutSeconds = config.txTimeoutSeconds ?? 30;
    this.horizon =
      config.horizonAdapter ?? new DefaultHorizonAdapter(config.horizonUrl);
    this.txFactory = config.transactionFactory ?? defaultTransactionFactory;
  }

  /**
   * Submit a payment to the Stellar network with an atomically reserved
   * sequence number.
   *
   * @throws {DuplicatePaymentError} when a submission for the same sender
   *   account is already in progress.
   * @throws {BadSequenceError} when Horizon rejects with TRANSACTION_BAD_SEQ.
   * @throws Any other Horizon error as-is.
   */
  async submitPayment(req: PaymentRequest): Promise<SubmitResult> {
    return this.sequenceManager.withLock(
      req.senderAccountId,
      req.paymentId,
      async () => {
        // Step 2: Fetch current sequence from Horizon (lock guarantees accuracy)
        const account = await this.horizon.loadAccount(req.senderAccountId);

        // Step 3: Build and sign the transaction
        const tx = this.txFactory(
          account,
          req,
          this.networkPassphrase,
          this.txTimeoutSeconds
        );

        // Step 4: Submit and handle Horizon-specific errors
        try {
          const response = await this.horizon.submitTransaction(tx);
          return {
            txHash: response.hash,
            ledger: response.ledger,
          };
        } catch (err) {
          if (this.isHorizonError(err)) {
            const extras = (err as HorizonSubmitError).response?.data?.extras;
            const txCode = extras?.result_codes?.transaction ?? "";
            if (
              txCode === "tx_bad_seq" ||
              txCode.includes("TRANSACTION_BAD_SEQ")
            ) {
              throw new BadSequenceError(
                req.senderAccountId,
                account.sequenceNumber()
              );
            }
          }
          throw err;
        }
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isHorizonError(err: unknown): err is HorizonSubmitError {
    return (
      typeof err === "object" &&
      err !== null &&
      "response" in err &&
      typeof (err as HorizonSubmitError).response === "object"
    );
  }
}

// ---------------------------------------------------------------------------
// Internal type for Horizon submission errors
// ---------------------------------------------------------------------------

interface HorizonSubmitError {
  response?: {
    data?: {
      extras?: {
        result_codes?: {
          transaction?: string;
          operations?: string[];
        };
      };
    };
  };
}
