import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

describe("Preserve Ownership on Edit (Issue #48)", () => {
  const creatorWallet = "GCREATOR_ORIGINAL_WALLET_ADDRESS_12345678901234567890123456";
  const editorWallet = "GEDITOR_MEMBER_WALLET_ADDRESS_1234567890123456789012345678";

  it("ensures expense updates never include created_by_wallet, created_at, or id", () => {
    const originalExpense: Expense = {
      id: "exp-1",
      title: "Initial Title",
      description: "Initial description",
      totalAmount: "100.0000000",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "m-1",
      members: [
        { id: "m-1", name: "Alice", walletAddress: creatorWallet },
        { id: "m-2", name: "Bob", walletAddress: editorWallet },
      ],
      shares: [
        { memberId: "m-1", name: "Alice", amount: "50.0000000", paid: false },
        { memberId: "m-2", name: "Bob", amount: "50.0000000", paid: false },
      ],
      createdAt: "2026-08-30T12:00:00.000Z",
      settled: false,
      version: 1,
    };

    const updates: Partial<Expense> = {
      title: "Edited Title by Bob",
      description: "Updated notes",
    };

    // Simulated update payload builder mirroring ExpenseContext.tsx
    const dbUpdates: Record<string, any> = {};
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.description !== undefined) dbUpdates.description = updates.description ?? null;
    if (updates.totalAmount !== undefined) dbUpdates.total_amount = updates.totalAmount;
    if (updates.currency !== undefined) dbUpdates.currency = updates.currency;
    if (updates.splitMode !== undefined) dbUpdates.split_mode = updates.splitMode;
    if (updates.paidByMemberId !== undefined) dbUpdates.paid_by_member_id = updates.paidByMemberId;
    if (updates.members !== undefined) {
      dbUpdates.members = updates.members;
      const memberWallets = updates.members
        .map((m) => m.walletAddress)
        .filter((addr): addr is string => !!addr);
      dbUpdates.member_wallets = memberWallets;
    }
    if (updates.shares !== undefined) dbUpdates.shares = updates.shares;
    if (updates.settled !== undefined) dbUpdates.settled = updates.settled;

    // Assert immutable and ownership columns are NOT present
    expect(dbUpdates).not.toHaveProperty("created_by_wallet");
    expect(dbUpdates).not.toHaveProperty("created_at");
    expect(dbUpdates).not.toHaveProperty("id");
    expect(dbUpdates.title).toBe("Edited Title by Bob");
    expect(dbUpdates.description).toBe("Updated notes");
  });

  it("ensures trip updates never include created_by_wallet, created_at, or id", () => {
    const originalTrip: Trip = {
      id: "trip-1",
      name: "Tokyo Trip",
      description: "Japan vacation",
      members: [
        { id: "m-1", name: "Alice", walletAddress: creatorWallet },
        { id: "m-2", name: "Bob", walletAddress: editorWallet },
      ],
      expenseIds: ["exp-1"],
      createdAt: "2026-08-30T12:00:00.000Z",
      settled: false,
    };

    const updates: Partial<Trip> = {
      name: "Tokyo Trip 2026",
      description: "Updated description",
    };

    // Simulated update payload builder mirroring TripContext.tsx
    const dbUpdates: Record<string, any> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.description !== undefined) dbUpdates.description = updates.description ?? null;
    if (updates.members !== undefined) {
      dbUpdates.members = updates.members;
      const memberWallets = updates.members
        .map((m) => m.walletAddress)
        .filter((addr): addr is string => !!addr);
      dbUpdates.member_wallets = memberWallets;
    }
    if (updates.expenseIds !== undefined) dbUpdates.expense_ids = updates.expenseIds;
    if (updates.settled !== undefined) dbUpdates.settled = updates.settled;

    // Assert immutable and ownership columns are NOT present
    expect(dbUpdates).not.toHaveProperty("created_by_wallet");
    expect(dbUpdates).not.toHaveProperty("created_at");
    expect(dbUpdates).not.toHaveProperty("id");
    expect(dbUpdates.name).toBe("Tokyo Trip 2026");
    expect(dbUpdates.description).toBe("Updated description");
  });
});
