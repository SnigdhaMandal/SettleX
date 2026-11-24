describe("Trip and Expense relationship lifecycle logic", () => {
  it("removes deleted expense IDs from trip expense list", () => {
    const tripExpenseIds = ["exp-1", "exp-2", "exp-3"];
    const deletedExpenseId = "exp-2";

    const cleanedExpenseIds = tripExpenseIds.filter((id) => id !== deletedExpenseId);

    expect(cleanedExpenseIds).toEqual(["exp-1", "exp-3"]);
    expect(cleanedExpenseIds).not.toContain("exp-2");
  });

  it("cascades deletion: removes all expenses belonging to a deleted trip", () => {
    const expenses = [
      { id: "exp-1", title: "Trip Hotel" },
      { id: "exp-2", title: "Trip Flight" },
      { id: "exp-3", title: "Personal Coffee" },
    ];
    const deletedTripExpenseIds = ["exp-1", "exp-2"];

    const remainingExpenses = expenses.filter(
      (e) => !deletedTripExpenseIds.includes(e.id)
    );

    expect(remainingExpenses).toHaveLength(1);
    expect(remainingExpenses[0].id).toBe("exp-3");
  });

  it("determines whether a trip can be deleted based on paid shares", () => {
    const canDeleteTrip = (tripExpenses: { shares: { paid: boolean }[] }[]) => {
      const hasPaidShares = tripExpenses.some((e) =>
        e.shares.some((s) => s.paid)
      );
      return !hasPaidShares;
    };

    const tripWithUnpaidExpenses = [
      { shares: [{ paid: false }, { paid: false }] },
    ];
    expect(canDeleteTrip(tripWithUnpaidExpenses)).toBe(true);

    const tripWithPaidExpense = [
      { shares: [{ paid: false }, { paid: true }] },
    ];
    expect(canDeleteTrip(tripWithPaidExpense)).toBe(false);
  });
});
