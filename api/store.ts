/**
 * In-memory data store for SEP-12 customers and SEP-31 transactions.
 * Production deployments must replace this with persistent storage; the
 * interfaces below define the data shapes the SEP endpoints rely on.
 */

export type CustomerStatus = "ACCEPTED" | "NEEDS_INFO" | "PROCESSING" | "REJECTED";

export interface Customer {
  id: string;
  /** Stellar account (G... or M...) the customer was registered under */
  account: string;
  memo?: string;
  type?: string;
  fields: Record<string, string>;
}

export type Sep31Status =
  | "pending_sender"
  | "pending_stellar"
  | "pending_customer_info_update"
  | "pending_transaction_info_update"
  | "pending_receiver"
  | "pending_external"
  | "completed"
  | "refunded"
  | "expired"
  | "error";

export interface Sep31Transaction {
  id: string;
  /** SEP-10 `sub` of the sending anchor that created the transaction */
  creator: string;
  status: Sep31Status;
  status_eta: number | null;
  status_message: string | null;
  amount_in: string;
  amount_in_asset: string;
  amount_out: string | null;
  amount_out_asset: string | null;
  amount_fee: string;
  amount_fee_asset: string;
  stellar_account_id: string;
  stellar_memo_type: "hash" | "id" | "text";
  stellar_memo: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  stellar_transaction_id: string | null;
  external_transaction_id: string | null;
  refunded: boolean;
  required_info_message: string | null;
  required_info_updates: Record<string, unknown> | null;
  fields: Record<string, string>;
  callback_url: string | null;
}

export const customers = new Map<string, Customer>();
export const transactions = new Map<string, Sep31Transaction>();

export function findCustomer(query: {
  id?: string;
  account?: string;
  memo?: string;
  type?: string;
}): Customer | undefined {
  if (query.id) return customers.get(query.id);
  for (const customer of customers.values()) {
    if (
      customer.account === query.account &&
      (customer.memo ?? undefined) === (query.memo ?? undefined)
    ) {
      return customer;
    }
  }
  return undefined;
}
