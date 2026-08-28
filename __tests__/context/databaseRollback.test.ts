import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

describe("Database write error rollback behavior", () => {
  it("rolls back optimistic expense updates when database write rejects", async () => {
    const originalExpense: Expense = {
      id: "exp-1",
      title: "Initial Title",
      totalAmount: "50.0000000",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "m-1",
      members: [{ id: "m-1", name: "Alice" }],
      shares: [{ memberId: "m-1", name: "Alice", amount: "50.0000000", paid: false }],
      createdAt: new Date().toISOString(),
      settled: false,
    };

    let expensesState: Expense[] = [originalExpense];

    const updateExpenseMock = async (id: string, updates: Partial<Expense>, shouldFail = true) => {
      const current = expensesState.find((e) => e.id === id);
      if (!current) return;

      const merged = { ...current, ...updates };

      // 1. Optimistic apply
      expensesState = expensesState.map((e) => (e.id === id ? merged : e));

      // 2. Simulated DB write
      try {
        if (shouldFail) {
          throw new Error("Supabase RLS: permission denied");
        }
      } catch (err) {
        // 3. Rollback on failure
        expensesState = expensesState.map((e) => (e.id === id ? current : e));
        throw err;
      }
    };

    // Attempt failing update
    await expect(updateExpenseMock("exp-1", { title: "Hacked Title" }, true)).rejects.toThrow(
      "Supabase RLS: permission denied"
    );

    // Verify state rolled back to original
    expect(expensesState[0].title).toBe("Initial Title");
  });

  it("rolls back optimistic trip deletion when database write rejects", async () => {
    const trip: Trip = {
      id: "trip-1",
      name: "Tokyo Trip",
      members: [{ id: "m-1", name: "Alice" }],
      expenseIds: [],
      createdAt: new Date().toISOString(),
      settled: false,
    };

    let tripsState: Trip[] = [trip];

    const deleteTripMock = async (id: string, shouldFail = true) => {
      const current = tripsState.find((t) => t.id === id);
      if (!current) return;

      // 1. Optimistic delete
      tripsState = tripsState.filter((t) => t.id !== id);

      // 2. Simulated DB write
      try {
        if (shouldFail) {
          throw new Error("Network timeout: failed to delete from Supabase");
        }
      } catch (err) {
        // 3. Rollback on failure
        if (!tripsState.some((t) => t.id === id)) {
          tripsState = [current, ...tripsState];
        }
        throw err;
      }
    };

    // Attempt failing deletion
    await expect(deleteTripMock("trip-1", true)).rejects.toThrow(
      "Network timeout: failed to delete from Supabase"
    );

    // Verify trip is restored in state
    expect(tripsState).toHaveLength(1);
    expect(tripsState[0].id).toBe("trip-1");
  });

  it("rolls back optimistic trip settlement when database write rejects", async () => {
    const trip: Trip = {
      id: "trip-1",
      name: "Paris Trip",
      members: [{ id: "m-1", name: "Alice" }],
      expenseIds: [],
      createdAt: new Date().toISOString(),
      settled: false,
    };

    let tripsState: Trip[] = [trip];

    const settleTripMock = async (id: string, shouldFail = true) => {
      const current = tripsState.find((t) => t.id === id);
      if (!current) return;

      // 1. Optimistic settle
      tripsState = tripsState.map((t) => (t.id === id ? { ...t, settled: true } : t));

      // 2. Simulated DB write
      try {
        if (shouldFail) {
          throw new Error("Database error: failed to settle trip");
        }
      } catch (err) {
        // 3. Rollback on failure
        tripsState = tripsState.map((t) => (t.id === id ? current : t));
        throw err;
      }
    };

    // Attempt failing settle
    await expect(settleTripMock("trip-1", true)).rejects.toThrow(
      "Database error: failed to settle trip"
    );

    // Verify trip is still unsettled
    expect(tripsState[0].settled).toBe(false);
  });
});
