/** @jest-environment jsdom */

import React from "react";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

const { render, waitFor, act } = require("@testing-library/react");

const WALLET = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

const mockReconcile = jest.fn(async () => {});
jest.mock("@/context/WalletContext", () => ({
  useWalletContext: () => ({ publicKey: WALLET, reconcile: mockReconcile }),
}));

jest.mock("@/lib/supabase/session", () => ({
  getAuthenticatedClient: jest.fn(),
  requireAuthenticatedClient: jest.fn(),
  clearWalletSession: jest.fn(),
  hasProvenSession: jest.fn(() => true),
  onSessionChange: jest.fn(() => () => {}),
}));

const { getAuthenticatedClient, requireAuthenticatedClient } = require("@/lib/supabase/session");
const { ExpenseProvider, useExpenseContext } = require("@/context/ExpenseContext");
const { TripProvider, useTripContext } = require("@/context/TripContext");

let dbExpenses: Record<string, unknown>[] = [];
let dbTrips: Record<string, unknown>[] = [];
let rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let simulateRpcUnavailable = false;
let simulateLinkFailure = false;

function resetDb() {
  dbExpenses = [
    {
      id: "exp-1",
      title: "Dinner",
      description: null,
      total_amount: "50.0000000",
      currency: "XLM",
      split_mode: "equal",
      paid_by_member_id: "m1",
      members: [{ id: "m1", name: "Alice", walletAddress: WALLET }],
      shares: [{ memberId: "m1", name: "Alice", amount: "50.0000000", paid: false }],
      created_at: "2026-01-01T00:00:00Z",
      settled: false,
      version: 1,
      created_by_wallet: WALLET,
      member_wallets: [WALLET],
      accepted_wallets: [WALLET],
      declined_wallets: [],
    },
  ];

  dbTrips = [
    {
      id: "trip-1",
      name: "Road Trip",
      description: "Weekend getaway",
      members: [{ id: "m1", name: "Alice", walletAddress: WALLET }],
      expense_ids: ["exp-1"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      settled: false,
      created_by_wallet: WALLET,
      member_wallets: [WALLET],
      accepted_wallets: [WALLET],
      declined_wallets: [],
    },
  ];
}

function makeClient() {
  return {
    rpc: jest.fn(async (fnName: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn: fnName, args });

      if (fnName === "create_trip_expense") {
        if (simulateRpcUnavailable) {
          return { data: null, error: { message: "function create_trip_expense does not exist" } };
        }
        const tripId = args.p_trip_id as string;
        const trip = dbTrips.find((t) => t.id === tripId);
        if (!trip) return { data: null, error: { message: "Trip not found" } };

        const expenseData = args.p_expense as Record<string, unknown>;
        dbExpenses.push({ ...expenseData });
        const expenseIds = (trip.expense_ids as string[]) || [];
        trip.expense_ids = [...expenseIds, expenseData.id as string];
        return { data: [{ ...expenseData }], error: null };
      }

      if (fnName === "add_expense_to_trip") {
        if (simulateLinkFailure) {
          return { data: null, error: { message: "Failed to link expense to trip" } };
        }
        const tripId = args.p_trip_id as string;
        const expenseId = args.p_expense_id as string;
        const trip = dbTrips.find((t) => t.id === tripId);
        if (trip) {
          trip.expense_ids = [...((trip.expense_ids as string[]) || []), expenseId];
          return { data: [{ ...trip }], error: null };
        }
        return { data: null, error: { message: "Trip not found" } };
      }

      return { data: null, error: null };
    }),
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        single: async () => {
          if (table === "trips") {
            const trip = dbTrips.find((t) => t.id === filters.id);
            return { data: trip ? { ...trip } : null, error: trip ? null : { message: "Not found" } };
          }
          const exp = dbExpenses.find((e) => e.id === filters.id);
          return { data: exp ? { ...exp } : null, error: exp ? null : { message: "Not found" } };
        },
        insert: async (rows: Record<string, unknown>[]) => {
          if (table === "expenses") {
            dbExpenses.push(...rows);
          } else if (table === "trips") {
            dbTrips.push(...rows);
          }
          return { error: null };
        },
        delete: () => {
          builder.__isDelete = true;
          return builder;
        },
        update: (payload: Record<string, unknown>) => {
          builder.__payload = payload;
          builder.__isUpdate = true;
          return builder;
        },
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        then: undefined,
      };

      (builder as { then: unknown }).then = (
        resolve: (value: { data: unknown; error: unknown }) => void
      ) => {
        if (builder.__isDelete) {
          if (table === "expenses") {
            const id = filters.id as string;
            const exp = dbExpenses.find((e) => e.id === id);
            // Check paid shares restriction
            const shares = (exp?.shares as { paid?: boolean }[]) || [];
            if (shares.some((s) => s.paid)) {
              resolve({ data: null, error: { message: "Cannot delete an expense with paid shares or payments" } });
              return;
            }
            dbExpenses = dbExpenses.filter((e) => e.id !== id);
            // Cascade clean from trips
            dbTrips.forEach((t) => {
              t.expense_ids = (t.expense_ids as string[]).filter((eid) => eid !== id);
            });
            resolve({ data: [], error: null });
            return;
          }
          if (table === "trips") {
            const id = filters.id as string;
            const trip = dbTrips.find((t) => t.id === id);
            // Check paid shares restriction in trip's expenses
            const tripExpenseIds = (trip?.expense_ids as string[]) || [];
            const hasPaid = dbExpenses.some(
              (e) => tripExpenseIds.includes(e.id as string) && ((e.shares as { paid?: boolean }[]) || []).some((s) => s.paid)
            );
            if (hasPaid) {
              resolve({ data: null, error: { message: "Cannot delete a trip with paid shares or payments" } });
              return;
            }
            // Cascade delete trip's expenses
            dbExpenses = dbExpenses.filter((e) => !tripExpenseIds.includes(e.id as string));
            dbTrips = dbTrips.filter((t) => t.id !== id);
            resolve({ data: [], error: null });
            return;
          }
        }

        if (builder.__isUpdate) {
          const payload = builder.__payload as Record<string, unknown>;
          if (table === "trips") {
            const trip = dbTrips.find((t) => t.id === filters.id);
            if (trip) Object.assign(trip, payload);
          }
          resolve({ data: [], error: null });
          return;
        }

        if (table === "expenses") {
          resolve({ data: [...dbExpenses], error: null });
        } else {
          resolve({ data: [...dbTrips], error: null });
        }
      };

      return builder;
    },
  };
}

let expenseCtx: ReturnType<typeof useExpenseContext>;
let tripCtx: ReturnType<typeof useTripContext>;

function TestProbe() {
  expenseCtx = useExpenseContext();
  tripCtx = useTripContext();
  return null;
}

beforeEach(async () => {
  localStorage.clear();
  rpcCalls = [];
  simulateRpcUnavailable = false;
  simulateLinkFailure = false;
  resetDb();

  const client = makeClient();
  getAuthenticatedClient.mockResolvedValue(client);
  requireAuthenticatedClient.mockResolvedValue(client);

  render(
    <ExpenseProvider>
      <TripProvider>
        <TestProbe />
      </TripProvider>
    </ExpenseProvider>
  );

  await waitFor(() => expect(expenseCtx?.expenses.length).toBeGreaterThan(0));
});

describe("Trip Expense Atomic Creation and Cascade Lifecycle", () => {
  it("creates and links an expense to a trip atomically via create_trip_expense RPC", async () => {
    const newExpense: Expense = {
      id: "exp-2",
      title: "Museum Tickets",
      totalAmount: "40.0000000",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "m1",
      members: [{ id: "m1", name: "Alice", walletAddress: WALLET }],
      shares: [{ memberId: "m1", name: "Alice", amount: "40.0000000", paid: false }],
      createdAt: new Date().toISOString(),
      settled: false,
    };

    await act(async () => {
      await expenseCtx.addExpense(newExpense, "trip-1");
    });

    // Verified RPC was invoked
    const call = rpcCalls.find((c) => c.fn === "create_trip_expense");
    expect(call).toBeDefined();
    expect(call?.args.p_trip_id).toBe("trip-1");

    // Verified expense exists and is linked in DB
    expect(dbExpenses.some((e) => e.id === "exp-2")).toBe(true);
    const trip = dbTrips.find((t) => t.id === "trip-1");
    expect(trip?.expense_ids).toContain("exp-2");

    // Verified local state updated in both contexts
    expect(expenseCtx.expenses.some((e) => e.id === "exp-2")).toBe(true);
    expect(tripCtx.getTrip("trip-1")?.expenseIds).toContain("exp-2");
  });

  it("rolls back the created expense in fallback mode if linking fails", async () => {
    simulateRpcUnavailable = true;
    simulateLinkFailure = true;

    const failingExpense: Expense = {
      id: "exp-fail",
      title: "Broken Expense",
      totalAmount: "25.0000000",
      currency: "XLM",
      splitMode: "equal",
      paidByMemberId: "m1",
      members: [{ id: "m1", name: "Alice", walletAddress: WALLET }],
      shares: [{ memberId: "m1", name: "Alice", amount: "25.0000000", paid: false }],
      createdAt: new Date().toISOString(),
      settled: false,
    };

    await expect(
      act(async () => {
        await expenseCtx.addExpense(failingExpense, "trip-1");
      })
    ).rejects.toThrow("Failed to link expense to trip");

    // Verified orphaned expense was not left in DB
    expect(dbExpenses.some((e) => e.id === "exp-fail")).toBe(false);
    // Verified optimistic local state rolled back
    expect(expenseCtx.expenses.some((e) => e.id === "exp-fail")).toBe(false);
  });

  it("cleans up trips.expense_ids when an expense is deleted", async () => {
    expect(dbTrips[0].expense_ids).toContain("exp-1");

    await act(async () => {
      await expenseCtx.deleteExpense("exp-1");
    });

    // DB verified cleaned up
    expect(dbExpenses.some((e) => e.id === "exp-1")).toBe(false);
    expect((dbTrips[0].expense_ids as string[])).not.toContain("exp-1");

    // Local state verified cleaned up in TripContext
    expect(tripCtx.getTrip("trip-1")?.expenseIds).not.toContain("exp-1");
  });

  it("cascades deletion of trip expenses when a trip is deleted", async () => {
    expect(dbExpenses.some((e) => e.id === "exp-1")).toBe(true);

    await act(async () => {
      await tripCtx.deleteTrip("trip-1");
    });

    // Trip deleted
    expect(dbTrips.some((t) => t.id === "trip-1")).toBe(false);
    // Associated expenses cascade deleted
    expect(dbExpenses.some((e) => e.id === "exp-1")).toBe(false);
    // Local expense context updated
    expect(expenseCtx.expenses.some((e) => e.id === "exp-1")).toBe(false);
  });

  it("restricts deletion of a trip when any expense has paid shares", async () => {
    // Mark share as paid
    const exp = dbExpenses.find((e) => e.id === "exp-1");
    if (exp) {
      exp.shares = [{ memberId: "m1", name: "Alice", amount: "50.0000000", paid: true }];
    }

    await expect(
      act(async () => {
        await tripCtx.deleteTrip("trip-1");
      })
    ).rejects.toThrow(/Cannot delete a trip with paid shares/i);

    // Trip and expense must still exist
    expect(dbTrips.some((t) => t.id === "trip-1")).toBe(true);
    expect(dbExpenses.some((e) => e.id === "exp-1")).toBe(true);
  });

  it("restricts deletion of an expense that has paid shares", async () => {
    const exp = dbExpenses.find((e) => e.id === "exp-1");
    if (exp) {
      exp.shares = [{ memberId: "m1", name: "Alice", amount: "50.0000000", paid: true }];
    }

    await expect(
      act(async () => {
        await expenseCtx.deleteExpense("exp-1");
      })
    ).rejects.toThrow(/Cannot delete an expense with paid shares/i);

    expect(dbExpenses.some((e) => e.id === "exp-1")).toBe(true);
  });
});
