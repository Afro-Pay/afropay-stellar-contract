/**
 * Transaction module (Issue #83).
 *
 * Bundles TransactionController and TransactionService for the NestJS
 * module system. In a full NestJS deployment, this module would be
 * imported into the AppModule and the @Controller/@Injectable decorators
 * would handle DI and route registration automatically.
 *
 * Because the current repo uses plain Express, this module serves as
 * the canonical grouping and can be imported directly.
 */

export { TransactionService, transactionService } from "./transaction.service";
export type {
  TransactionEvent,
  TransactionEventType,
  TransactionSettlementState,
} from "./transaction.service";
export {
  TransactionController,
  transactionController,
} from "./transaction.controller";
export type { SseMessageEvent } from "./transaction.controller";
