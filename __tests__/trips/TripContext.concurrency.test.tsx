/** @jest-environment jsdom */

import React from "react";
import type { Trip } from "@/types/trip";
import { TripConflictError } from "@/context/TripContext";

const { render, screen, waitFor, act } = require("@testing-library/react");

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
const { TripProvider, useTripContext } = require("@/context/TripContext");

let dbTripRow: Record<string, unknown>;
let updatePayloads: Record<string, unknown>[] = [];
let rpcCalls: Record<string, unknown>[] = [];
let simulateRpcUnavailable = false;

function baseTripRow() {
  return {
    id: "trip-1",
    name: "Summer Vacation",
    description: "Trip to mountains",
    members: [
      { id: "m1", name: "Alice", walletAddress: WALLET },
      { id: "m2", name: "Bob", walletAddress: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H" },
    ],
    expense_ids: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    settled: false,
    version: 1,
    created_by_wallet: WALLET,
    member_wallets: [WALLET, "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"],
    accepted_wallets: [WALLET, "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"],
    declined_wallets: [],
  };
}

function makeClient() {
  return {
    rpc: jest.fn(async (fnName: string, args: Record<string, unknown>) => {
      if (simulateRpcUnavailable) {
        return { data: null, error: { message: "function add_expense_to_trip does not exist" } };
      }
      if (fnName === "add_expense_to_trip") {
        rpcCalls.push(args);
        const expenseId = args.p_expense_id as string;
        const currentIds = (dbTripRow.expense_ids as string[]) || [];
        if (!currentIds.includes(expenseId)) {
          dbTripRow.expense_ids = [...currentIds, expenseId];
          dbTripRow.version = ((dbTripRow.version as number) ?? 1) + 1;
        }
        return { data: [{ ...dbTripRow }], error: null };
      }
      return { data: null, error: null };
    }),
    from: () => {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        insert: () => builder,
        delete: () => builder,
        order: () => builder,
        update: (payload: Record<string, unknown>) => {
          builder.__payload = payload;
          builder.__isUpdate = true;
          return builder;
        },
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        single: async () => ({ data: { ...dbTripRow }, error: null }),
        then: undefined,
      };

      (builder as { then: unknown }).then = (
        resolve: (value: { data: unknown; error: unknown }) => void,
      ) => {
        if (!builder.__isUpdate) {
          resolve({ data: [{ ...dbTripRow }], error: null });
          return;
        }

        const payload = builder.__payload as Record<string, unknown>;
        updatePayloads.push(payload);

        if ("version" in filters && filters.version !== dbTripRow.version) {
          resolve({ data: [], error: null }); // Predicate missed
          return;
        }

        Object.assign(dbTripRow, payload);
        resolve({ data: [{ ...dbTripRow }], error: null });
      };

      return builder;
    },
  };
}

let ctx: {
  trips: Trip[];
  getTrip: (id: string) => Trip | undefined;
  updateTrip: (id: string, u: Partial<Trip>) => Promise<void>;
  addExpenseToTrip: (tripId: string, expenseId: string) => Promise<void>;
  settleTrip: (id: string) => Promise<void>;
};

function Probe() {
  ctx = useTripContext();
  return <div data-testid="trips">{ctx.trips.map((t) => t.name).join("|")}</div>;
}

beforeEach(async () => {
  localStorage.clear();
  updatePayloads = [];
  rpcCalls = [];
  simulateRpcUnavailable = false;
  dbTripRow = baseTripRow();

  const client = makeClient();
  getAuthenticatedClient.mockResolvedValue(client);
  requireAuthenticatedClient.mockResolvedValue(client);

  render(
    <TripProvider>
      <Probe />
    </TripProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("trips").textContent).toBe("Summer Vacation"));
});

describe("TripContext concurrency", () => {
  it("keeps both ids when two addExpenseToTrip calls occur concurrently (via RPC)", async () => {
    await act(async () => {
      await Promise.all([
        ctx.addExpenseToTrip("trip-1", "exp-1"),
        ctx.addExpenseToTrip("trip-1", "exp-2"),
      ]);
    });

    const trip = ctx.getTrip("trip-1");
    expect(trip?.expenseIds).toContain("exp-1");
    expect(trip?.expenseIds).toContain("exp-2");
    expect(trip?.expenseIds.length).toBe(2);

    expect(dbTripRow.expense_ids).toContain("exp-1");
    expect(dbTripRow.expense_ids).toContain("exp-2");
    expect((dbTripRow.expense_ids as string[]).length).toBe(2);
  });

  it("keeps both ids when two addExpenseToTrip calls occur concurrently in fallback mode", async () => {
    simulateRpcUnavailable = true;

    await act(async () => {
      await Promise.all([
        ctx.addExpenseToTrip("trip-1", "exp-1"),
        ctx.addExpenseToTrip("trip-1", "exp-2"),
      ]);
    });

    const trip = ctx.getTrip("trip-1");
    expect(trip?.expenseIds).toContain("exp-1");
    expect(trip?.expenseIds).toContain("exp-2");
    expect(trip?.expenseIds.length).toBe(2);

    expect(dbTripRow.expense_ids).toContain("exp-1");
    expect(dbTripRow.expense_ids).toContain("exp-2");
    expect((dbTripRow.expense_ids as string[]).length).toBe(2);
  });

  it("guards the write with the version it read on updateTrip", async () => {
    await act(async () => {
      await ctx.updateTrip("trip-1", { name: "Renamed Trip" });
    });

    expect(updatePayloads[0].version).toBe(2);
    expect(dbTripRow.name).toBe("Renamed Trip");
  });

  it("detects conflict on updateTrip and refreshes local state to the winning row", async () => {
    // Simulate concurrent writer bumping version to 2 and renaming to Winner
    dbTripRow.version = 2;
    dbTripRow.name = "Winner";

    let thrown: unknown;
    await act(async () => {
      thrown = await ctx.updateTrip("trip-1", { name: "Loser" }).catch((e: unknown) => e);
    });

    expect(thrown).toBeInstanceOf(TripConflictError);
    expect((thrown as Error).message).toMatch(/changed by someone else/i);
    expect(ctx.getTrip("trip-1")?.name).toBe("Winner");
  });

  it("guards settleTrip with version", async () => {
    await act(async () => {
      await ctx.settleTrip("trip-1");
    });

    expect(dbTripRow.settled).toBe(true);
    expect(dbTripRow.version).toBe(2);
    expect(ctx.getTrip("trip-1")?.settled).toBe(true);
  });
});
