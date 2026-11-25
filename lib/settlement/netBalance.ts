import { stroopsToXlm, xlmToStroops } from "@/lib/split/calculator";
import type { Expense } from "@/types/expense";
import type { ContractPaymentEvent } from "@/types/contract";
import type { TripSettlement } from "@/types/trip";

/**
 * Balances are keyed by member id, never by display name (Issue #202): two
 * members called "Alex" are different people. `fromId` / `toId` are the
 * member ids a recorded settlement is stored under, so they must always be
 * set.
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
  const debts: RawDebt[] = [];
  forEachOpenShare(expenses, onChainEvents, (_expense, share, payer) => {
    debts.push({
      from: share.name,
      fromId: share.memberId,
      to: payer.name,
      toId: payer.id,
      amount: share.amount,
      fromWallet: share.walletAddress,
      toWallet: payer.walletAddress,
    });
  });
  return debts;
}

// Skips payer's own share, already-paid shares, and attested on-chain payments
function forEachOpenShare(
  expenses: Expense[],
  onChainEvents: ContractPaymentEvent[],
  fn: (expense: Expense, share: Expense["shares"][number], payer: Expense["members"][number]) => void,
) {
  const attestedOnChainSet = new Set(
    onChainEvents
      .filter((e) => e.attested === true)
      .map((e) => `${e.expenseId}-${e.member.toLowerCase()}`),
  );

  for (const expense of expenses) {
    const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
    if (!payer) continue;

    for (const share of expense.shares) {
      if (share.memberId === payer.id) continue;

      const isPaidOnChain =
        share.walletAddress &&
        attestedOnChainSet.has(`${expense.id}-${share.walletAddress.toLowerCase()}`);
      if (share.paid || isPaidOnChain) continue;

      fn(expense, share, payer);
    }
  }
}

/** Settlement fields the balance model needs. */
export type SettlementLike = Pick<TripSettlement, "fromMemberId" | "toMemberId" | "amount"> &
  Partial<Pick<TripSettlement, "fromWallet" | "toWallet">>;

/**
 * Each member's net position in stroops (Issue #203):
 *   positive = is owed money, negative = owes money.
 *
 *   balance = owed to me - I owe   (unpaid shares, i.e. owed - paid)
 *           + settlements I sent - settlements I received
 */
export function memberBalances(
  debts: RawDebt[],
  settlements: SettlementLike[] = [],
): Map<string, bigint> {
  const balance = new Map<string, bigint>();
  const add = (id: string, delta: bigint) => balance.set(id, (balance.get(id) ?? 0n) + delta);

  for (const { fromId, toId, amount } of debts) {
    const stroops = typeof amount === "bigint" ? amount : xlmToStroops(amount);
    add(fromId, -stroops);
    add(toId, stroops);
  }
  for (const s of settlements) {
    const stroops = xlmToStroops(s.amount);
    add(s.fromMemberId, stroops);
    add(s.toMemberId, -stroops);
  }
  return balance;
}

/**
 * Minimal set of transfers that brings every balance to zero. Recorded
 * settlements are subtracted first, so paying every suggested transfer and
 * recording it always ends with an empty result ("All settled up").
 */
export function computeNetPayments(
  debts: RawDebt[],
  settlements: SettlementLike[] = [],
): NetPayment[] {
  const balance = memberBalances(debts, settlements);
  const wallets = new Map<string, string>();
  const names = new Map<string, string>();

  debts.forEach(({ from, fromId, to, toId, fromWallet, toWallet }) => {
    names.set(fromId, from);
    names.set(toId, to);
    if (fromWallet) wallets.set(fromId, fromWallet);
    if (toWallet) wallets.set(toId, toWallet);
  });
  // Fall back to settlement wallets when a member has no open debts left
  for (const { fromMemberId, toMemberId, fromWallet, toWallet } of settlements) {
    if (fromWallet && !wallets.has(fromMemberId)) wallets.set(fromMemberId, fromWallet);
    if (toWallet && !wallets.has(toMemberId)) wallets.set(toMemberId, toWallet);
  }

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

export type NetSettledReason = "net-transfer" | "offset";

/**
 * Unpaid shares that no longer need a direct payment because netting covers
 * them (Issue #203). Keyed `${expenseId}:${memberId}`.
 *
 * A share D -> K (debtor D owes creditor K) is covered when D owes nothing on
 * net (balance(D) >= 0) and either K is owed nothing on net
 * (balance(K) <= 0) or D has already sent a settlement. The second case covers
 * a debtor who paid their full net amount while the creditor is still waiting
 * on someone else.
 *
 * `net-transfer` means a recorded settlement involves D or K; `offset` means
 * the debts cancelled out and no transfer was needed.
 */
export function netSettledShares(
  expenses: Expense[],
  settlements: SettlementLike[] = [],
  onChainEvents: ContractPaymentEvent[] = [],
): Map<string, NetSettledReason> {
  const debts = deriveRawDebts(expenses, onChainEvents);
  const balance = memberBalances(debts, settlements);
  const involved = new Set<string>();
  const sent = new Set<string>();
  for (const s of settlements) {
    involved.add(s.fromMemberId);
    involved.add(s.toMemberId);
    sent.add(s.fromMemberId);
  }

  const covered = new Map<string, NetSettledReason>();
  forEachOpenShare(expenses, onChainEvents, (expense, share, payer) => {
    const debtorBal = balance.get(share.memberId) ?? 0n;
    const creditorBal = balance.get(payer.id) ?? 0n;
    if (debtorBal < 0n) return;
    if (creditorBal > 0n && !sent.has(share.memberId)) return;
    covered.set(
      `${expense.id}:${share.memberId}`,
      involved.has(share.memberId) || involved.has(payer.id) ? "net-transfer" : "offset",
    );
  });
  return covered;
}
