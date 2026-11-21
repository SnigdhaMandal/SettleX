import type { Expense, Member } from "./expense";

export interface Trip {
  id: string;
  name: string;
  description?: string;
  members: Member[];
  expenseIds: string[];
  createdAt: string;
  createdByWallet?: string;
  memberWallets?: string[];
  acceptedWallets?: string[];
  declinedWallets?: string[];
  settled: boolean;
  version?: number;
}

export type TripFormData = {
  name: string;
  description: string;
  members: Member[];
};

/**
 * A settle-up transfer recorded as its own row (Issue #203). It reduces the
 * sender's net debt and the receiver's net credit by `amount`; it never marks
 * individual shares paid.
 */
export interface TripSettlement {
  id: string;
  tripId: string;
  fromMemberId: string;
  toMemberId: string;
  fromWallet: string;
  toWallet: string;
  /** XLM, 7-decimal string. */
  amount: string;
  txHash: string;
  createdAt: string;
}
