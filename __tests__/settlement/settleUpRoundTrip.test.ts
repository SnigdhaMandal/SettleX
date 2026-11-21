import {
  computeNetPayments,
  deriveRawDebts,
  memberBalances,
  netSettledShares,
  type NetPayment,
} from "@/lib/settlement/netBalance";
import type { Expense, Member } from "@/types/expense";
import type { TripSettlement } from "@/types/trip";

/**
 * Issue #202: balances are keyed by member id, so members who share a display
 * name stay separate and every net payment carries fromId / toId.
 *
 * Issue #203: a settle-up transfer is recorded as its own settlement row and
 * balances are owed - paid shares - settlements. Paying every suggested net
 * transfer must end in "All settled up" (no remaining net payments), even
 * when debts run in both directions.
 */

const alice: Member = { id: "m-alice", name: "Alice", walletAddress: "GALICE" };
const bob: Member = { id: "m-bob", name: "Bob", walletAddress: "GBOB" };
const carol: Member = { id: "m-carol", name: "Carol", walletAddress: "GCAROL" };
const alexOne: Member = { id: "m-alex-1", name: "Alex", walletAddress: "GALEX1" };
const alexTwo: Member = { id: "m-alex-2", name: "Alex", walletAddress: "GALEX2" };

/** An expense paid by `paidBy`, with explicit per-member share amounts. */
function expense(id: string, paidBy: Member, shares: Array<[Member, string]>): Expense {
  const members = shares.map(([m]) => m);
  return {
    id,
    title: id,
    totalAmount: "0",
    currency: "XLM",
    splitMode: "custom",
    paidByMemberId: paidBy.id,
    members,
    shares: shares.map(([m, amount]) => ({
      memberId: m.id,
      name: m.name,
      walletAddress: m.walletAddress,
      amount,
      paid: m.id === paidBy.id,
    })),
    createdAt: "2026-01-01T00:00:00.000Z",
    settled: false,
  };
}

let seq = 0;
/** What record_trip_settlement stores after a suggested transfer is paid. */
function settle(payment: NetPayment): TripSettlement {
  seq += 1;
  return {
    id: `s-${seq}`,
    tripId: "trip",
    fromMemberId: payment.fromId,
    toMemberId: payment.toId,
    fromWallet: payment.fromWallet ?? "",
    toWallet: payment.toWallet ?? "",
    amount: payment.amount,
    txHash: seq.toString(16).padStart(64, "0"),
    createdAt: `2026-01-01T00:00:0${seq}.000Z`,
  };
}

/** Pays every suggested transfer, one at a time, re-deriving after each. */
function payEverySuggestedTransfer(expenses: Expense[]): TripSettlement[] {
  const settlements: TripSettlement[] = [];
  for (let guard = 0; guard < 20; guard++) {
    const next = computeNetPayments(deriveRawDebts(expenses), settlements);
    if (next.length === 0) return settlements;
    settlements.push(settle(next[0]));
  }
  throw new Error("settle-up did not converge");
}

describe("member identity in net balances (Issue #202)", () => {
  it("keeps two members with the same name as separate debtors", () => {
    const expenses = [
      expense("dinner", alice, [[alice, "10"], [alexOne, "10"], [alexTwo, "10"]]),
    ];
    const payments = computeNetPayments(deriveRawDebts(expenses));

    expect(payments).toHaveLength(2);
    const byId = new Map(payments.map((p) => [p.fromId, p]));
    expect(byId.get(alexOne.id)).toMatchObject({ from: "Alex", fromWallet: "GALEX1", toId: alice.id, amount: "10.0000000" });
    expect(byId.get(alexTwo.id)).toMatchObject({ from: "Alex", fromWallet: "GALEX2", toId: alice.id, amount: "10.0000000" });
  });

  it("keeps a creditor and a debtor with the same name separate", () => {
    // Name-keying would net Alex -> Alex to zero.
    const expenses = [expense("taxi", alexOne, [[alexOne, "4"], [alexTwo, "4"]])];
    expect(computeNetPayments(deriveRawDebts(expenses))).toEqual([
      expect.objectContaining({ fromId: alexTwo.id, toId: alexOne.id, amount: "4.0000000" }),
    ]);
  });

  it("settling one Alex leaves the other Alex's debt open", () => {
    const expenses = [
      expense("dinner", alice, [[alice, "10"], [alexOne, "10"], [alexTwo, "10"]]),
    ];
    const first = computeNetPayments(deriveRawDebts(expenses)).find((p) => p.fromId === alexTwo.id)!;
    const remaining = computeNetPayments(deriveRawDebts(expenses), [settle(first)]);
    expect(remaining).toEqual([
      expect.objectContaining({ fromId: alexOne.id, toId: alice.id, amount: "10.0000000" }),
    ]);
  });
});

describe("settlement rows close net balances (Issue #203)", () => {
  it("the issue's two-person case: A owes B 10, B owes A 4, a 6 net transfer settles both", () => {
    const expenses = [
      expense("b-paid", bob, [[bob, "0"], [alice, "10"]]),
      expense("a-paid", alice, [[alice, "0"], [bob, "4"]]),
    ];
    const [net] = computeNetPayments(deriveRawDebts(expenses));
    expect(net).toMatchObject({ fromId: alice.id, toId: bob.id, amount: "6.0000000" });

    const settlements = [settle(net)];
    expect(computeNetPayments(deriveRawDebts(expenses), settlements)).toHaveLength(0);

    // Both gross shares, including B's 4 that no transfer touched, are covered.
    const covered = netSettledShares(expenses, settlements);
    expect(covered.get(`b-paid:${alice.id}`)).toBe("net-transfer");
    expect(covered.get(`a-paid:${bob.id}`)).toBe("net-transfer");
  });

  it("3-person trip with debts in both directions reaches All settled up", () => {
    // Alice paid 30 (10 each), Bob paid 12 (4 each), Carol paid 9 (3 each).
    const expenses = [
      expense("hotel", alice, [[alice, "10"], [bob, "10"], [carol, "10"]]),
      expense("dinner", bob, [[alice, "4"], [bob, "4"], [carol, "4"]]),
      expense("taxi", carol, [[alice, "3"], [bob, "3"], [carol, "3"]]),
    ];

    const settlements = payEverySuggestedTransfer(expenses);

    expect(settlements.length).toBeGreaterThan(0);
    expect(computeNetPayments(deriveRawDebts(expenses), settlements)).toHaveLength(0);
    memberBalances(deriveRawDebts(expenses), settlements).forEach((balance) => {
      expect(balance).toBe(0n);
    });

    // No gross share was marked paid, yet every open share is covered, so no
    // Pay button reappears.
    const open = expenses.flatMap((e) => e.shares.filter((s) => !s.paid).map((s) => `${e.id}:${s.memberId}`));
    const covered = netSettledShares(expenses, settlements);
    expect(open.length).toBeGreaterThan(0);
    for (const key of open) expect(covered.has(key)).toBe(true);
  });

  it("settles amounts that do not fit whole shares, down to the stroop", () => {
    const expenses = [
      expense("a", alice, [[alice, "0.3333333"], [bob, "0.3333333"], [carol, "0.3333334"]]),
      expense("b", bob, [[alice, "0.1000001"], [bob, "0"], [carol, "0.2000002"]]),
      expense("c", carol, [[alice, "1.0000000"], [bob, "0.0000001"], [carol, "0"]]),
    ];
    const settlements = payEverySuggestedTransfer(expenses);
    expect(computeNetPayments(deriveRawDebts(expenses), settlements)).toHaveLength(0);
  });

  it("a partial settle-up only covers the member who paid", () => {
    // Bob and Carol each owe Alice 10. Only Bob settles.
    const expenses = [
      expense("hotel", alice, [[alice, "10"], [bob, "10"], [carol, "10"]]),
    ];
    const bobsTransfer = computeNetPayments(deriveRawDebts(expenses)).find((p) => p.fromId === bob.id)!;
    const settlements = [settle(bobsTransfer)];

    const covered = netSettledShares(expenses, settlements);
    expect(covered.get(`hotel:${bob.id}`)).toBe("net-transfer");
    expect(covered.has(`hotel:${carol.id}`)).toBe(false);
    expect(computeNetPayments(deriveRawDebts(expenses), settlements)).toEqual([
      expect.objectContaining({ fromId: carol.id, toId: alice.id, amount: "10.0000000" }),
    ]);
  });

  it("does not cover a zero-balance member whose creditor is still waiting", () => {
    // Chain: Alice owes Bob 5, Carol owes Alice 5. Alice nets to zero, but Bob
    // is still owed until Carol pays him.
    const expenses = [
      expense("x", bob, [[bob, "0"], [alice, "5"]]),
      expense("y", alice, [[alice, "0"], [carol, "5"]]),
    ];
    expect(netSettledShares(expenses).has(`x:${alice.id}`)).toBe(false);

    const [carolToBob] = computeNetPayments(deriveRawDebts(expenses));
    expect(carolToBob).toMatchObject({ fromId: carol.id, toId: bob.id });
    const covered = netSettledShares(expenses, [settle(carolToBob)]);
    expect(covered.get(`x:${alice.id}`)).toBe("net-transfer");
    expect(covered.get(`y:${carol.id}`)).toBe("net-transfer");
  });

  it("marks exactly cancelling debts as offset when no transfer was needed", () => {
    const expenses = [
      expense("p", bob, [[bob, "0"], [alice, "5"]]),
      expense("q", alice, [[alice, "0"], [bob, "5"]]),
    ];
    expect(computeNetPayments(deriveRawDebts(expenses))).toHaveLength(0);
    const covered = netSettledShares(expenses);
    expect(covered.get(`p:${alice.id}`)).toBe("offset");
    expect(covered.get(`q:${bob.id}`)).toBe("offset");
  });

  it("direct share payments still count: a later direct payment is not double-counted", () => {
    const expenses = [
      expense("hotel", alice, [[alice, "10"], [bob, "10"], [carol, "10"]]),
    ];
    // Carol pays her share directly (mark_share_paid), Bob settles via net transfer.
    expenses[0].shares = expenses[0].shares.map((s) => (s.memberId === carol.id ? { ...s, paid: true } : s));
    const [bobToAlice] = computeNetPayments(deriveRawDebts(expenses));
    expect(bobToAlice).toMatchObject({ fromId: bob.id, amount: "10.0000000" });
    expect(computeNetPayments(deriveRawDebts(expenses), [settle(bobToAlice)])).toHaveLength(0);
  });
});
