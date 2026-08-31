import type { Expense, SplitShare } from "@/types/expense";
import type { Trip } from "@/types/trip";

describe("Column-Level Access Control & Authorization (Issue #47)", () => {
  const creatorWallet = "GCREATOR111111111111111111111111111111111111111111111111111";
  const memberWallet1 = "GMEMBER111111111111111111111111111111111111111111111111111";
  const memberWallet2 = "GMEMBER222222222222222222222222222222222222222222222222222";
  const attackerWallet = "GATTACKER111111111111111111111111111111111111111111111111";

  const initialExpense: Expense = {
    id: "exp-1234",
    title: "Team Dinner",
    description: "Dinner at Bistro",
    totalAmount: "100.0000000",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "m-creator",
    members: [
      { id: "m-creator", name: "Alice (Creator)", walletAddress: creatorWallet },
      { id: "m-1", name: "Bob", walletAddress: memberWallet1 },
      { id: "m-2", name: "Charlie", walletAddress: memberWallet2 },
    ],
    shares: [
      { memberId: "m-creator", name: "Alice", walletAddress: creatorWallet, amount: "33.3333334", paid: true },
      { memberId: "m-1", name: "Bob", walletAddress: memberWallet1, amount: "33.3333333", paid: false },
      { memberId: "m-2", name: "Charlie", walletAddress: memberWallet2, amount: "33.3333333", paid: false },
    ],
    createdAt: "2026-08-30T10:00:00.000Z",
    settled: false,
    version: 1,
  };

  /**
   * Evaluator mirroring PostgreSQL BEFORE UPDATE trigger: validate_expense_update()
   */
  function simulateExpenseUpdateTrigger(
    oldRow: Expense & { created_by_wallet: string; member_wallets: string[] },
    newRow: Expense & { created_by_wallet: string; member_wallets: string[] },
    callerWallet: string
  ): { allowed: boolean; error?: string } {
    // 1. Immutable fields
    if (newRow.id !== oldRow.id) return { allowed: false, error: "Cannot modify expense id" };
    if (newRow.createdAt !== oldRow.createdAt) return { allowed: false, error: "Cannot modify expense created_at" };
    if (newRow.created_by_wallet !== oldRow.created_by_wallet) {
      return { allowed: false, error: "Cannot modify expense creator (created_by_wallet)" };
    }

    const isCreator = callerWallet === oldRow.created_by_wallet;

    // 2. Creator checks
    if (isCreator) {
      if (!newRow.member_wallets.includes(oldRow.created_by_wallet)) {
        return { allowed: false, error: "Creator cannot be removed from member_wallets" };
      }
      return { allowed: true };
    }

    // 3. Non-creator checks
    if (newRow.title !== oldRow.title) return { allowed: false, error: "Only the expense creator can modify title" };
    if (newRow.description !== oldRow.description) return { allowed: false, error: "Only the expense creator can modify description" };
    if (newRow.totalAmount !== oldRow.totalAmount) return { allowed: false, error: "Only the expense creator can modify total_amount" };
    if (newRow.currency !== oldRow.currency) return { allowed: false, error: "Only the expense creator can modify currency" };
    if (newRow.splitMode !== oldRow.splitMode) return { allowed: false, error: "Only the expense creator can modify split_mode" };
    if (newRow.paidByMemberId !== oldRow.paidByMemberId) return { allowed: false, error: "Only the expense creator can modify paid_by_member_id" };
    if (JSON.stringify(newRow.members) !== JSON.stringify(oldRow.members)) {
      return { allowed: false, error: "Only the expense creator can modify members" };
    }
    if (JSON.stringify(newRow.member_wallets) !== JSON.stringify(oldRow.member_wallets)) {
      return { allowed: false, error: "Only the expense creator can modify member_wallets" };
    }

    // Shares validation for non-creators
    if (JSON.stringify(newRow.shares) !== JSON.stringify(oldRow.shares)) {
      if (newRow.shares.length !== oldRow.shares.length) {
        return { allowed: false, error: "Cannot add or remove shares" };
      }

      let diffCount = 0;
      for (let i = 0; i < oldRow.shares.length; i++) {
        const oldShare = oldRow.shares[i];
        const newShare = newRow.shares[i];

        if (JSON.stringify(oldShare) !== JSON.stringify(newShare)) {
          diffCount++;
          if (oldShare.walletAddress !== callerWallet) {
            return { allowed: false, error: "Cannot modify shares belonging to other members" };
          }
          if (
            oldShare.memberId !== newShare.memberId ||
            oldShare.amount !== newShare.amount
          ) {
            return { allowed: false, error: "Cannot modify share amounts or split allocation" };
          }
          if (oldShare.paid && !newShare.paid) {
            return { allowed: false, error: "Cannot unmark a paid share" };
          }
          if (newShare.paid && (!newShare.txHash || newShare.txHash.trim() === "")) {
            return { allowed: false, error: "Valid transaction hash is required when marking share as paid" };
          }
        }
      }

      if (diffCount > 1) {
        return { allowed: false, error: "Cannot modify multiple shares at once" };
      }
    }

    // Settled validation
    if (newRow.settled !== oldRow.settled) {
      const allPaid = newRow.shares.every((s) => s.paid);
      if (newRow.settled && !allPaid) {
        return { allowed: false, error: "Cannot mark expense as settled while unpaid shares remain" };
      }
      if (oldRow.settled && !newRow.settled) {
        return { allowed: false, error: "Cannot reopen a settled expense" };
      }
    }

    return { allowed: true };
  }

  const baseDbExpense = {
    ...initialExpense,
    created_by_wallet: creatorWallet,
    member_wallets: [creatorWallet, memberWallet1, memberWallet2],
  };

  describe("Expense Column Protection", () => {
    it("allows the creator to update expense metadata and total amount", () => {
      const updated = {
        ...baseDbExpense,
        title: "Updated Dinner Title",
        totalAmount: "120.0000000",
      };
      const result = simulateExpenseUpdateTrigger(baseDbExpense, updated, creatorWallet);
      expect(result.allowed).toBe(true);
    });

    it("rejects non-creator attempting to take over ownership (created_by_wallet)", () => {
      const hijacked = {
        ...baseDbExpense,
        created_by_wallet: memberWallet1,
      };
      const result = simulateExpenseUpdateTrigger(baseDbExpense, hijacked, memberWallet1);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain("Cannot modify expense creator");
    });

    it("rejects non-creator attempting to alter total_amount or split_mode", () => {
      const tampered = {
        ...baseDbExpense,
        totalAmount: "0.0000001",
      };
      const result = simulateExpenseUpdateTrigger(baseDbExpense, tampered, memberWallet1);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain("Only the expense creator can modify total_amount");
    });

    it("rejects non-creator attempting to drop creator from member_wallets", () => {
      const tampered = {
        ...baseDbExpense,
        member_wallets: [memberWallet1, memberWallet2],
      };
      const result = simulateExpenseUpdateTrigger(baseDbExpense, tampered, memberWallet1);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain("Only the expense creator can modify member_wallets");
    });

    it("rejects non-creator marking another member's share as paid", () => {
      const tamperedShares: SplitShare[] = baseDbExpense.shares.map((s) =>
        s.memberId === "m-2" ? { ...s, paid: true, txHash: "fake-tx" } : s
      );
      const tampered = {
        ...baseDbExpense,
        shares: tamperedShares,
      };
      const result = simulateExpenseUpdateTrigger(baseDbExpense, tampered, memberWallet1);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain("Cannot modify shares belonging to other members");
    });

    it("rejects non-creator marking their own share paid without a transaction hash", () => {
      const tamperedShares: SplitShare[] = baseDbExpense.shares.map((s) =>
        s.memberId === "m-1" ? { ...s, paid: true, txHash: "" } : s
      );
      const tampered = {
        ...baseDbExpense,
        shares: tamperedShares,
      };
      const result = simulateExpenseUpdateTrigger(baseDbExpense, tampered, memberWallet1);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain("Valid transaction hash is required");
    });

    it("allows non-creator member to mark their own share paid with a valid txHash", () => {
      const updatedShares: SplitShare[] = baseDbExpense.shares.map((s) =>
        s.memberId === "m-1" ? { ...s, paid: true, txHash: "tx-bob-valid-hash" } : s
      );
      const updated = {
        ...baseDbExpense,
        shares: updatedShares,
      };
      const result = simulateExpenseUpdateTrigger(baseDbExpense, updated, memberWallet1);
      expect(result.allowed).toBe(true);
    });

    it("rejects non-creator marking expense as settled when other shares are still unpaid", () => {
      const updated = {
        ...baseDbExpense,
        settled: true,
      };
      const result = simulateExpenseUpdateTrigger(baseDbExpense, updated, memberWallet1);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain("Cannot mark expense as settled while unpaid shares remain");
    });
  });

  describe("Trip Column Protection", () => {
    const initialTrip: Trip & { created_by_wallet: string; member_wallets: string[] } = {
      id: "trip-123",
      name: "Tokyo Trip",
      description: "Sightseeing",
      members: [
        { id: "m-creator", name: "Alice", walletAddress: creatorWallet },
        { id: "m-1", name: "Bob", walletAddress: memberWallet1 },
      ],
      expenseIds: ["exp-1"],
      createdAt: "2026-08-30T10:00:00.000Z",
      settled: false,
      created_by_wallet: creatorWallet,
      member_wallets: [creatorWallet, memberWallet1],
    };

    function simulateTripUpdateTrigger(
      oldRow: typeof initialTrip,
      newRow: typeof initialTrip,
      callerWallet: string
    ): { allowed: boolean; error?: string } {
      if (newRow.id !== oldRow.id) return { allowed: false, error: "Cannot modify trip id" };
      if (newRow.createdAt !== oldRow.createdAt) return { allowed: false, error: "Cannot modify trip created_at" };
      if (newRow.created_by_wallet !== oldRow.created_by_wallet) {
        return { allowed: false, error: "Cannot modify trip creator (created_by_wallet)" };
      }

      const isCreator = callerWallet === oldRow.created_by_wallet;
      if (isCreator) {
        if (!newRow.member_wallets.includes(oldRow.created_by_wallet)) {
          return { allowed: false, error: "Creator cannot be removed from member_wallets" };
        }
        return { allowed: true };
      }

      if (newRow.name !== oldRow.name) return { allowed: false, error: "Only trip creator can modify trip name" };
      if (newRow.description !== oldRow.description) return { allowed: false, error: "Only trip creator can modify trip description" };
      if (JSON.stringify(newRow.members) !== JSON.stringify(oldRow.members)) {
        return { allowed: false, error: "Only trip creator can modify trip members" };
      }
      if (JSON.stringify(newRow.member_wallets) !== JSON.stringify(oldRow.member_wallets)) {
        return { allowed: false, error: "Only trip creator can modify member_wallets" };
      }

      // Cannot remove existing expenses
      const hasAllOld = oldRow.expenseIds.every((id) => newRow.expenseIds.includes(id));
      if (!hasAllOld) {
        return { allowed: false, error: "Cannot remove existing expenses from trip" };
      }

      return { allowed: true };
    }

    it("allows non-creator member to append a new expense to the trip", () => {
      const updated = {
        ...initialTrip,
        expenseIds: [...initialTrip.expenseIds, "exp-2"],
      };
      const result = simulateTripUpdateTrigger(initialTrip, updated, memberWallet1);
      expect(result.allowed).toBe(true);
    });

    it("rejects non-creator attempting to delete/remove existing expenses from the trip", () => {
      const tampered = {
        ...initialTrip,
        expenseIds: [],
      };
      const result = simulateTripUpdateTrigger(initialTrip, tampered, memberWallet1);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain("Cannot remove existing expenses");
    });

    it("rejects non-creator attempting to rename the trip or modify trip members", () => {
      const tampered = {
        ...initialTrip,
        name: "Hacked Trip Name",
      };
      const result = simulateTripUpdateTrigger(initialTrip, tampered, memberWallet1);
      expect(result.allowed).toBe(false);
      expect(result.error).toContain("Only trip creator can modify trip name");
    });
  });
});
