export interface ContractPaymentRecord {
  tripId: string;
  expenseId: string;
  payer: string;
  member: string;
  amountStroops: bigint;
  txHash: string;
  timestamp: number;
  /**
   * `true` only when a configured attestor co-signed the record, meaning the
   * Stellar transaction behind `txHash` was actually checked.
   *
   * `false` means the record is self-attested: the member supplied `payer`,
   * `amountStroops` and `txHash`, and the contract stored them without
   * verifying any of it. Never present a self-attested record as proof.
   */
  attested: boolean;
}

// Contract call status

export type ContractCallStatus =
  | { status: "idle" }
  | { status: "simulating" }
  | { status: "signing" }
  | { status: "sending" }
  | { status: "confirming" }
  | { status: "success"; ledger: number }
  | { status: "error"; message: string; code?: number };

export enum ContractErrorCode {
  InvalidAmount = 1,
  AlreadyPaid   = 2,
  EmptyId       = 3,
  AlreadyInitialized = 4,
  NotInitialized = 5,
  InvalidActor = 6,
  IdTooLong = 7,
  AmountTooLarge = 8,
  VersionMismatch = 9,
  TxHashTooLong = 10,
}

export interface ContractPaymentEvent {
  ledger: number;
  ledgerClosedAt: string;
  tripId: string;
  expenseId: string;
  member: string;
  amountStroops: string;
  txHash: string;
}

export interface GetPaymentsResult {
  payments: ContractPaymentRecord[];
  success: boolean;
  error?: string;
}

export interface IsPaidResult {
  paid: boolean;
  success: boolean;
  error?: string;
}
