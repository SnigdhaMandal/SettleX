import { computeNetPayments, deriveRawDebts } from "@/lib/settlement/netBalance";
import { selectCoveredShares } from "@/lib/settlement/shareBudget";
import type { Expense, Member } from "@/types/expense";

/**
 * Issue #202: balances were keyed by display name and fromId/toId were never
 * set, so selectCoveredShares matched nothing and settle-up never marked a
 * share paid. These tests run the whole pure pipeline:
 * expenses -> raw debts -> net payments -> covered shares -> marked paid.
 */

const alice: Member = { id: "m-alice", name: "Alice", walletAddress: "GALICE" };
const alexOne: Member = { id: "m-alex-1", name: "Alex", walletAddress: "GALEX1" };
const alexTwo: Member = { id: "m-alex-2", name: "Alex", walletAddress: "GALEX2" };

function expense(
  id: string,
  paidBy: Member,
  members: Member[],
  perShare: string,
): Expense {
  return {
    id,
    title: id,
    totalAmount: perShare,
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: paidBy.id,
    members,
    shares: members.map((m) => ({
      memberId: m.id,
      name: m.name,
      walletAddress: m.walletAddress,
      amount: perShare,
      paid: m.id === paidBy.id,
    })),
    createdAt: "2026-01-01T00:00:00.000Z",
    settled: false,
  };
}

/** Applies covered shares the way markSharePaid does, returning new expenses. */
function markPaid(
  expenses: Expense[],
  covered: Array<{ expenseId: string; memberId: string }>,
): Expense[] {
  const key = new Set(covered.map((c) => `${c.expenseId}:${c.memberId}`));
  return expenses.map((e) => ({
    ...e,
    shares: e.shares.map((s) =>
      key.has(`${e.id}:${s.memberId}`) ? { ...s, paid: true, txHash: "h" } : s,
    ),
  }));
}

describe("settle-up round trip (Issue #202)", () => {
  const members = [alice, alexOne, alexTwo];

  it("keeps two members with the same name as separate debtors", () => {
    const expenses = [expense("dinner", alice, members, "10.0000000")];
    const payments = computeNetPayments(deriveRawDebts(expenses));

    expect(payments).toHaveLength(2);
    const byId = new Map(payments.map((p) => [p.fromId, p]));
    expect(byId.get(alexOne.id)).toMatchObject({
      from: "Alex",
      fromWallet: "GALEX1",
      toId: alice.id,
      toWallet: "GALICE",
      amount: "10.0000000",
    });
    expect(byId.get(alexTwo.id)).toMatchObject({
      from: "Alex",
      fromWallet: "GALEX2",
      toId: alice.id,
      amount: "10.0000000",
    });
  });

  it("keeps a creditor and a debtor with the same name separate", () => {
    // Alex #1 paid; Alex #2 owes Alex #1. Name-keying would net this to zero.
    const expenses = [expense("taxi", alexOne, [alexOne, alexTwo], "4.0000000")];
    const payments = computeNetPayments(deriveRawDebts(expenses));

    expect(payments).toEqual([
      expect.objectContaining({
        fromId: alexTwo.id,
        toId: alexOne.id,
        amount: "4.0000000",
      }),
    ]);
  });

  it("always sets fromId and toId on every net payment", () => {
    const expenses = [
      expense("dinner", alice, members, "10.0000000"),
      expense("taxi", alexOne, members, "3.0000000"),
    ];
    for (const p of computeNetPayments(deriveRawDebts(expenses))) {
      expect(p.fromId).toEqual(expect.any(String));
      expect(p.toId).toEqual(expect.any(String));
      expect(members.map((m) => m.id)).toContain(p.fromId);
      expect(members.map((m) => m.id)).toContain(p.toId);
    }
  });

  it("marks covered shares paid after each settle-up payment until nothing is owed", () => {
    let expenses = [
      expense("dinner", alice, members, "10.0000000"),
      expense("museum", alice, members, "5.0000000"),
    ];

    const payments = computeNetPayments(deriveRawDebts(expenses));
    expect(payments).toHaveLength(2);

    for (const payment of payments) {
      const covered = selectCoveredShares(payment, expenses);
      // Each net payment closes that debtor's two shares and nobody else's.
      expect(covered).toHaveLength(2);
      expect(covered.every((c) => c.memberId === payment.fromId)).toBe(true);
      expenses = markPaid(expenses, covered);
    }

    for (const e of expenses) {
      expect(e.shares.every((s) => s.paid)).toBe(true);
    }
    expect(computeNetPayments(deriveRawDebts(expenses))).toHaveLength(0);
  });

  it("skips shares that already have an attested on-chain record", () => {
    const expenses = [expense("dinner", alice, members, "10.0000000")];
    const debts = deriveRawDebts(expenses, [
      {
        ledger: 1,
        ledgerClosedAt: "",
        tripId: "t",
        expenseId: "dinner",
        member: "galex1",
        amountStroops: "100000000",
        txHash: "h",
        attested: true,
      },
    ]);
    expect(debts.map((d) => d.fromId)).toEqual([alexTwo.id]);
  });
});
