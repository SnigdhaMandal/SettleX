/** @jest-environment jsdom */

/**
 * Issue #206: markSharePaid must have a single write path.
 *
 * It used to treat any mark_share_paid RPC error as "RPC unavailable" and fall
 * back to a direct UPDATE of the whole shares array, so a deliberate rejection
 * ("Not authorized…", "Transaction hash already used…") was silently bypassed,
 * and an error mentioning "version" triggered an update with no version guard.
 * These tests pin that a rejection is surfaced and nothing else is written.
 */
import React from "react";
import type { Expense } from "@/types/expense";
import { GENERIC_USER_MESSAGE } from "@/lib/errors/userMessage";

const { render, screen, waitFor, act } = require("@testing-library/react");

const WALLET = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const TX_HASH = "c".repeat(64);

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

jest.mock("@/lib/observability/logger", () => ({
  logWarn: jest.fn(),
  reportError: jest.fn(),
}));

const { getAuthenticatedClient, requireAuthenticatedClient } = require("@/lib/supabase/session");
const { ExpenseProvider, useExpenseContext } = require("@/context/ExpenseContext");

function baseRow() {
  return {
    id: "exp-1",
    title: "Team Dinner",
    description: null,
    total_amount: "100.0000000",
    currency: "XLM",
    split_mode: "equal",
    paid_by_member_id: "m1",
    members: [
      { id: "m1", name: "Alice", walletAddress: "GALICE" },
      { id: "m2", name: "Bob", walletAddress: WALLET },
    ],
    shares: [
      { memberId: "m1", name: "Alice", amount: "50.0000000", paid: false },
      { memberId: "m2", name: "Bob", amount: "50.0000000", paid: false, walletAddress: WALLET },
    ],
    created_at: "2026-01-01T00:00:00Z",
    settled: false,
    version: 1,
    created_by_wallet: WALLET,
    member_wallets: [WALLET],
    accepted_wallets: [WALLET],
  };
}

/** Every write the provider attempts outside the RPC. */
let directWrites: { table: string; op: string; payload?: unknown }[] = [];
let rpcResult: { data: unknown; error: unknown };
const rpc = jest.fn(async () => rpcResult);

function makeClient() {
  return {
    rpc,
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      const write = (op: string) => (payload?: unknown) => {
        directWrites.push({ table, op, payload });
        return builder;
      };
      Object.assign(builder, {
        select: chain,
        order: chain,
        eq: chain,
        single: async () => ({ data: baseRow(), error: null }),
        update: write("update"),
        insert: write("insert"),
        upsert: write("upsert"),
        delete: write("delete"),
        then: (resolve: (value: { data: unknown; error: unknown }) => void) =>
          resolve({ data: [baseRow()], error: null }),
      });
      return builder;
    },
  };
}

let ctx: {
  expenses: Expense[];
  markSharePaid: (expenseId: string, memberId: string, txHash: string) => Promise<void>;
};

function Probe() {
  ctx = useExpenseContext();
  return <div data-testid="titles">{ctx.expenses.map((e) => e.title).join("|")}</div>;
}

const bobShare = () => ctx.expenses[0].shares.find((s) => s.memberId === "m2")!;

beforeEach(async () => {
  localStorage.clear();
  directWrites = [];
  rpc.mockClear();
  rpcResult = { data: null, error: null };

  const client = makeClient();
  getAuthenticatedClient.mockResolvedValue(client);
  requireAuthenticatedClient.mockResolvedValue(client);

  render(
    <ExpenseProvider>
      <Probe />
    </ExpenseProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("titles").textContent).toBe("Team Dinner"));
});

async function markExpectingRejection(): Promise<Error> {
  let caught: unknown = null;
  await act(async () => {
    try {
      await ctx.markSharePaid("exp-1", "m2", TX_HASH);
    } catch (err) {
      caught = err;
    }
  });
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

describe("markSharePaid single write path (Issue #206)", () => {
  it.each([
    "Not authorized to mark this share as paid",
    "Transaction hash already used on another share",
    "Share is already marked as paid",
    "Accept the expense invitation before recording a payment",
  ])("surfaces the RPC rejection %p and issues no direct UPDATE", async (rejection) => {
    rpcResult = { data: null, error: { message: rejection, code: "P0001" } };

    const err = await markExpectingRejection();

    expect(rpc).toHaveBeenCalledWith("mark_share_paid", {
      p_expense_id: "exp-1",
      p_member_id: "m2",
      p_tx_hash: TX_HASH,
    });
    expect(directWrites).toEqual([]);
    expect(err.message).toBe(rejection);
    // The optimistic update is rolled back.
    expect(bobShare().paid).toBe(false);
  });

  it("does not fall back to an unguarded update when the error mentions 'version'", async () => {
    rpcResult = {
      data: null,
      error: { message: 'column "version" of relation "expenses" does not exist', code: "42703" },
    };

    const err = await markExpectingRejection();

    expect(directWrites).toEqual([]);
    // Raw database detail is not shown to the user.
    expect(err.message).toBe(GENERIC_USER_MESSAGE);
  });

  it("does not fall back when the RPC itself is unavailable", async () => {
    rpcResult = {
      data: null,
      error: { message: "Could not find the function public.mark_share_paid in the schema cache", code: "PGRST202" },
    };

    const err = await markExpectingRejection();

    expect(directWrites).toEqual([]);
    expect(err.message).toBe(GENERIC_USER_MESSAGE);
  });

  it("treats an empty RPC result as a failure rather than writing directly", async () => {
    rpcResult = { data: [], error: null };

    const err = await markExpectingRejection();

    expect(directWrites).toEqual([]);
    expect(err.message).toBe("The payment could not be recorded. Please try again.");
    expect(bobShare().paid).toBe(false);
  });

  it("applies the row returned by the RPC on success, with no direct write", async () => {
    const row = baseRow();
    row.shares[1] = { ...row.shares[1], paid: true, txHash: TX_HASH } as typeof row.shares[1];
    rpcResult = { data: [row], error: null };

    await act(async () => {
      await ctx.markSharePaid("exp-1", "m2", TX_HASH);
    });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(directWrites).toEqual([]);
    expect(bobShare()).toMatchObject({ paid: true, txHash: TX_HASH });
  });
});
