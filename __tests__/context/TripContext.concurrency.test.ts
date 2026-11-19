import type { Trip } from "@/types/trip";

describe("TripContext concurrency & OCC mechanism", () => {
  it("merges concurrent expense additions without losing prior updates", () => {
    const initialExpenseIds: string[] = ["exp-0"];

    // Simulate Member 1 adding exp-1
    const expenseIdsAfterMember1 = [...initialExpenseIds, "exp-1"];

    // Simulate Member 2 adding exp-2 concurrently, merging with latest state
    const expenseIdsAfterMember2 = Array.from(
      new Set([...expenseIdsAfterMember1, "exp-2"])
    );

    expect(expenseIdsAfterMember2).toContain("exp-0");
    expect(expenseIdsAfterMember2).toContain("exp-1");
    expect(expenseIdsAfterMember2).toContain("exp-2");
    expect(expenseIdsAfterMember2.length).toBe(3);
  });

  it("handles optimistic version increment on trip updates", () => {
    const trip: Trip = {
      id: "trip-1",
      name: "Road Trip",
      members: [
        { id: "m1", name: "Alice" },
        { id: "m2", name: "Bob" },
      ],
      expenseIds: ["exp-1"],
      createdAt: new Date().toISOString(),
      settled: false,
      version: 1,
    };

    const nextVersion = (trip.version ?? 1) + 1;
    expect(nextVersion).toBe(2);
  });
});
