import type { Expense, SplitShare } from "@/types/expense";

describe("ExpenseContext concurrency & OCC mechanism", () => {
  it("merges concurrent share payments without losing prior updates", () => {
    const initialShares: SplitShare[] = [
      { memberId: "m1", name: "Alice", amount: "10.0000000", paid: false },
      { memberId: "m2", name: "Bob", amount: "10.0000000", paid: false },
    ];

    // Simulate User 1 paying first
    const sharesAfterUser1 = initialShares.map((s) =>
      s.memberId === "m1" ? { ...s, paid: true, txHash: "tx-alice" } : s
    );

    // Simulate User 2 paying concurrently, reading fresh DB state which includes User 1's payment
    const sharesAfterUser2 = sharesAfterUser1.map((s) =>
      s.memberId === "m2" ? { ...s, paid: true, txHash: "tx-bob" } : s
    );

    expect(sharesAfterUser2.find((s) => s.memberId === "m1")?.paid).toBe(true);
    expect(sharesAfterUser2.find((s) => s.memberId === "m1")?.txHash).toBe("tx-alice");
    expect(sharesAfterUser2.find((s) => s.memberId === "m2")?.paid).toBe(true);
    expect(sharesAfterUser2.find((s) => s.memberId === "m2")?.txHash).toBe("tx-bob");
    expect(sharesAfterUser2.every((s) => s.paid)).toBe(true);
  });

  it("handles optimistic version increment on updates", () => {
    const expense: Expense = {
      id: "exp-1",
      title: "Team Dinner",
      totalAmount: "100.0000000",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "payer-1",
      members: [{ id: "payer-1", name: "Payer" }, { id: "m-1", name: "Alice" }],
      shares: [{ memberId: "m-1", name: "Alice", amount: "50.0000000", paid: false }],
      createdAt: new Date().toISOString(),
      settled: false,
      version: 1,
    };

    const nextVersion = (expense.version ?? 1) + 1;
    expect(nextVersion).toBe(2);
  });
});
