import { stroopsToXlm, xlmToStroops } from "@/lib/split/calculator";
import type { Expense } from "@/types/expense";
import type { ContractPaymentEvent } from "@/types/contract";

/**
 * Balances are keyed by member id, never by display name (Issue #202): two
 * members called "Alex" are different people. `fromId` / `toId` are the
 * member ids that `selectCoveredShares` matches against `share.memberId` and
 * `expense.paidByMemberId`, so they must always be set.
 */
export interface NetPayment {
  from: string;
  fromId: string;
  to: string;
  toId: string;
  amount: string;
  fromWallet?: string;
  toWallet?: string;
}

export interface RawDebt {
  from: string;
  fromId: string;
  to: string;
  toId: string;
  amount: number | string | bigint;
  fromWallet?: string;
  toWallet?: string;
}

/**
 * One gross debt per unpaid share: share owner -> member who paid the expense.
 * Shares already marked paid, or with an attested on-chain record, are skipped.
 */
export function deriveRawDebts(
  expenses: Expense[],
  onChainEvents: ContractPaymentEvent[] = [],
): RawDebt[] {
  const attestedOnChainSet = new Set(
    onChainEvents
      .filter((e) => e.attested === true)
      .map((e) => `${e.expenseId}-${e.member.toLowerCase()}`),
  );

  const debts: RawDebt[] = [];
  for (const expense of expenses) {
    const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
    if (!payer) continue;

    for (const share of expense.shares) {
      if (share.memberId === payer.id) continue;

      const isPaidOnChain =
        share.walletAddress &&
        attestedOnChainSet.has(`${expense.id}-${share.walletAddress.toLowerCase()}`);
      if (share.paid || isPaidOnChain) continue;

      debts.push({
        from:       share.name,
        fromId:     share.memberId,
        to:         payer.name,
        toId:       payer.id,
        amount:     share.amount,
        fromWallet: share.walletAddress,
        toWallet:   payer.walletAddress,
      });
    }
  }
  return debts;
}

export function computeNetPayments(debts: RawDebt[]): NetPayment[] {
  const balance = new Map<string, bigint>();
  const wallets = new Map<string, string>();
  const names = new Map<string, string>();

  debts.forEach(({ from, fromId, to, toId, amount, fromWallet, toWallet }) => {
    const stroops = typeof amount === "bigint" ? amount : xlmToStroops(amount);
    balance.set(fromId, (balance.get(fromId) ?? 0n) - stroops);
    balance.set(toId, (balance.get(toId) ?? 0n) + stroops);
    names.set(fromId, from);
    names.set(toId, to);
    if (fromWallet) wallets.set(fromId, fromWallet);
    if (toWallet) wallets.set(toId, toWallet);
  });

  const creditors: Array<{ id: string; balance: bigint }> = [];
  const debtors: Array<{ id: string; balance: bigint }> = [];

  balance.forEach((amount, id) => {
    if (amount > 0n) creditors.push({ id, balance: amount });
    if (amount < 0n) debtors.push({ id, balance: -amount });
  });

  creditors.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  debtors.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  const result: NetPayment[] = [];
  let ci = 0;
  let di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci];
    const debtor = debtors[di];
    const settle = creditor.balance < debtor.balance ? creditor.balance : debtor.balance;

    if (settle > 0n) {
      result.push({
        from: names.get(debtor.id) ?? debtor.id,
        fromId: debtor.id,
        to: names.get(creditor.id) ?? creditor.id,
        toId: creditor.id,
        amount: stroopsToXlm(settle),
        fromWallet: wallets.get(debtor.id),
        toWallet: wallets.get(creditor.id),
      });
    }

    creditor.balance -= settle;
    debtor.balance -= settle;
    if (creditor.balance === 0n) ci++;
    if (debtor.balance === 0n) di++;
  }

  return result;
}
