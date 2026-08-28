import { stroopsToXlm, xlmToStroops } from "@/lib/split/calculator";

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
  amount: number | string | bigint;
  fromWallet?: string;
  toWallet?: string;
}

export function computeNetPayments(debts: RawDebt[]): NetPayment[] {
  const balance = new Map<string, bigint>();
  const wallets = new Map<string, string>();
  const names = new Map<string, string>();

  debts.forEach(({ from, to, amount, fromWallet, toWallet }) => {
    const stroops = typeof amount === "bigint" ? amount : xlmToStroops(amount);
    balance.set(from, (balance.get(from) ?? 0n) - stroops);
    balance.set(to,   (balance.get(to)   ?? 0n) + stroops);
    if (fromWallet) wallets.set(from, fromWallet);
    if (toWallet)   wallets.set(to,   toWallet);
  });

  const creditors: Array<{ name: string; balance: bigint }> = [];
  const debtors:   Array<{ name: string; balance: bigint }> = [];

  balance.forEach((bal, name) => {
    if (bal > 0n) creditors.push({ name, balance:  bal });
    if (bal < 0n) debtors.push({   name, balance: -bal });
  });

  creditors.sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  debtors.sort(  (a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  const result: NetPayment[] = [];

  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci];
    const debtor   = debtors[di];

    const settle = creditor.balance < debtor.balance ? creditor.balance : debtor.balance;

    if (settle > 0n) {
      result.push({
        from:       debtor.name,
        fromId:     debtor.id,
        to:         creditor.name,
        amount:     stroopsToXlm(settle),
        fromWallet: wallets.get(debtor.name),
        toWallet:   wallets.get(creditor.name),
      });
    }

    creditor.balance -= settle;
    debtor.balance   -= settle;

    if (creditor.balance === 0n) ci++;
    if (debtor.balance   === 0n) di++;
  }

  return result;
}
