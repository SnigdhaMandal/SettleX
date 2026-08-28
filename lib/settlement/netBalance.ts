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
  amount: number;
  fromWallet?: string;
  toWallet?: string;
}

export function computeNetPayments(debts: RawDebt[]): NetPayment[] {
  const balance = new Map<string, number>();
  const wallets = new Map<string, string>();
  const names = new Map<string, string>();

  debts.forEach(({ from, fromId, to, toId, amount, fromWallet, toWallet }) => {
    balance.set(fromId, (balance.get(fromId) ?? 0) - amount);
    balance.set(toId,   (balance.get(toId)   ?? 0) + amount);
    names.set(fromId, from);
    names.set(toId, to);
    if (fromWallet) wallets.set(fromId, fromWallet);
    if (toWallet)   wallets.set(toId,   toWallet);
  });

  const creditors: Array<{ id: string; name: string; balance: number }> = [];
  const debtors:   Array<{ id: string; name: string; balance: number }> = [];

  balance.forEach((bal, id) => {
    const rounded = Math.round(bal * 1e7) / 1e7;
    const name = names.get(id) ?? id;
    if (rounded > 0.0000001)  creditors.push({ id, name, balance:  rounded });
    if (rounded < -0.0000001) debtors.push({   id, name, balance: -rounded });
  });

  creditors.sort((a, b) => b.balance - a.balance);
  debtors.sort(  (a, b) => b.balance - a.balance);

  const result: NetPayment[] = [];

  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci];
    const debtor   = debtors[di];

    const settle = Math.min(creditor.balance, debtor.balance);
    const rounded = Math.round(settle * 1e7) / 1e7;

    if (rounded > 0.0000001) {
      result.push({
        from:       debtor.name,
        fromId:     debtor.id,
        to:         creditor.name,
        toId:       creditor.id,
        amount:     rounded.toFixed(7),
        fromWallet: wallets.get(debtor.id),
        toWallet:   wallets.get(creditor.id),
      });
    }

    creditor.balance -= settle;
    debtor.balance   -= settle;

    if (creditor.balance < 0.0000001) ci++;
    if (debtor.balance   < 0.0000001) di++;
  }

  return result;
}
