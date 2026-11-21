/** @jest-environment jsdom */

import React, { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettlementSummary } from "@/components/trips/SettlementSummary";
import { buildPaymentTransaction } from "@/lib/stellar/buildTransaction";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import { recordPaymentOnChain } from "@/lib/stellar/contract";
import { signXDR } from "@/lib/freighter";
import { settlementMemo } from "@/lib/stellar/memo";
import {
  getPendingSettlement,
  recordTripSettlement,
  settlementContractExpenseId,
} from "@/lib/settlement/tripSettlements";
import type { Trip, TripSettlement } from "@/types/trip";
import type { Expense, Member } from "@/types/expense";

jest.mock("framer-motion", () => {
  const strip = ({
    children,
    layout,
    initial,
    animate,
    exit,
    transition,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  );
  return {
    motion: { div: strip },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

jest.mock("@/lib/stellar/buildTransaction", () => ({
  buildPaymentTransaction: jest.fn(),
}));

jest.mock("@/lib/stellar/submitTransaction", () => ({
  submitSignedTransaction: jest.fn(),
  inspectSignedTransaction: jest.fn(() => ({
    hash: "a".repeat(64),
    validUntil: null,
  })),
  isSubmissionIndeterminate: jest.fn(() => false),
}));

jest.mock("@/lib/stellar/contract", () => ({
  recordPaymentOnChain: jest.fn(),
}));

jest.mock("@/lib/freighter", () => ({
  signXDR: jest.fn(),
}));

jest.mock("@/hooks/useWallet", () => ({
  useWallet: jest.fn(),
}));

jest.mock("@/components/ui/Toast", () => ({
  useToast: jest.fn(),
}));

jest.mock("@/lib/supabase/session", () => ({
  getAuthenticatedClient: jest.fn(async () => null),
  requireAuthenticatedClient: jest.fn(async () => {
    throw new Error("not used: recordTripSettlement is mocked");
  }),
}));

// Real localStorage pending-settlement helpers, mocked database write.
jest.mock("@/lib/settlement/tripSettlements", () => ({
  ...jest.requireActual("@/lib/settlement/tripSettlements"),
  recordTripSettlement: jest.fn(),
}));

const SENDER_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RECEIVER_WALLET = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CAROL_WALLET = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const TX_HASH = "c".repeat(64);

const alice: Member = { id: "member-alice", name: "Alice", walletAddress: RECEIVER_WALLET };
const bob: Member = { id: "member-bob", name: "Bob", walletAddress: SENDER_WALLET };
const carol: Member = { id: "member-carol", name: "Carol", walletAddress: CAROL_WALLET };

function makeTrip(members: Member[], expenseIds = ["exp-1"]): Trip {
  return {
    id: "trip-1",
    name: "Beach Trip",
    description: "Weekend beach trip",
    members,
    expenseIds,
    settled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeExpense(id: string, paidBy: Member, shares: Array<[Member, string]>): Expense {
  return {
    id,
    title: id,
    totalAmount: "0",
    currency: "XLM",
    splitMode: "custom",
    paidByMemberId: paidBy.id,
    members: shares.map(([m]) => m),
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

const trip = makeTrip([alice, bob]);
const expenses: Expense[] = [
  makeExpense("exp-1", alice, [[alice, "10.0000000"], [bob, "10.0000000"]]),
];

let settlementSeq = 0;
function settlementFrom(
  params: { tripId: string; fromMemberId: string; toMemberId: string; amount: string; txHash: string },
  wallets: Record<string, string> = {},
): TripSettlement {
  settlementSeq += 1;
  return {
    id: `settlement-${settlementSeq}`,
    tripId: params.tripId,
    fromMemberId: params.fromMemberId,
    toMemberId: params.toMemberId,
    fromWallet: wallets[params.fromMemberId] ?? "",
    toWallet: wallets[params.toMemberId] ?? "",
    amount: params.amount,
    txHash: params.txHash,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, settlementSeq)).toISOString(),
  };
}

/** Holds recorded settlements in state, as the trip page does. */
function Harness({ trip: t, expenses: e }: { trip: Trip; expenses: Expense[] }) {
  const [settlements, setSettlements] = useState<TripSettlement[]>([]);
  return (
    <SettlementSummary
      trip={t}
      expenses={e}
      settlements={settlements}
      onSettlementRecorded={(s) => setSettlements((prev) => [...prev, s])}
    />
  );
}

describe("Settle-up records one settlement per net transfer (Issues #203, #209)", () => {
  const mockedUseWallet = jest.requireMock("@/hooks/useWallet").useWallet;
  const mockedUseToast = jest.requireMock("@/components/ui/Toast").useToast;

  const mockRefreshNetwork = jest.fn(async () => "TESTNET");
  const connectAs = (publicKey: string) =>
    mockedUseWallet.mockReturnValue({
      publicKey,
      isNetworkCompatible: true,
      refreshNetwork: mockRefreshNetwork,
      expectedNetwork: "TESTNET",
    });

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    connectAs(SENDER_WALLET);

    mockedUseToast.mockReturnValue({
      success: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    });

    jest.mocked(buildPaymentTransaction).mockResolvedValue({
      xdr: "unsigned-xdr",
      memo: settlementMemo("trip-1", SENDER_WALLET, RECEIVER_WALLET),
      fee: "100",
    });
    jest.mocked(signXDR).mockResolvedValue("signed-xdr");
    jest.mocked(submitSignedTransaction).mockResolvedValue({
      hash: TX_HASH,
      ledger: 12345,
      successful: true,
    });
    jest.mocked(recordPaymentOnChain).mockResolvedValue({ success: true, ledger: 12346 });
    jest.mocked(recordTripSettlement).mockImplementation(async (_wallet, params) =>
      settlementFrom(params),
    );
  });

  it("records the net transfer as a settlement row and one on-chain receipt for the exact amount", async () => {
    const onRecorded = jest.fn();
    render(
      <SettlementSummary trip={trip} expenses={expenses} onSettlementRecorded={onRecorded} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /pay 10/i }));

    await waitFor(() => {
      expect(screen.getByText(/payment successful!/i)).toBeTruthy();
    });

    expect(buildPaymentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePublicKey: SENDER_WALLET,
        destinationPublicKey: RECEIVER_WALLET,
        amount: "10.0000000",
        memo: settlementMemo("trip-1", SENDER_WALLET, RECEIVER_WALLET),
      }),
    );
    expect(submitSignedTransaction).toHaveBeenCalledWith("signed-xdr");

    // One receipt for the net amount, under a per-settlement contract id.
    expect(recordPaymentOnChain).toHaveBeenCalledTimes(1);
    expect(recordPaymentOnChain).toHaveBeenCalledWith(
      expect.objectContaining({
        debtorPublicKey: SENDER_WALLET,
        creditorPublicKey: RECEIVER_WALLET,
        tripId: "trip-1",
        expenseId: settlementContractExpenseId(TX_HASH),
        amountXlm: "10.0000000",
        txHash: TX_HASH,
      }),
    );

    expect(recordTripSettlement).toHaveBeenCalledWith(SENDER_WALLET, {
      tripId: "trip-1",
      fromMemberId: bob.id,
      toMemberId: alice.id,
      amount: "10.0000000",
      txHash: TX_HASH,
    });
    expect(onRecorded).toHaveBeenCalledWith(expect.objectContaining({ txHash: TX_HASH }));
    // Nothing pending is left behind once recorded.
    expect(getPendingSettlement(SENDER_WALLET, "trip-1", bob.id, alice.id)).toBeNull();
  });

  it("a recorded settlement brings the trip to All settled up without marking shares", async () => {
    render(<Harness trip={trip} expenses={expenses} />);

    fireEvent.click(screen.getByRole("button", { name: /pay 10/i }));

    await waitFor(() => {
      expect(screen.getByText("All settled up!")).toBeTruthy();
    });
    expect(screen.getByText("Recorded settlements")).toBeTruthy();
  });

  it("3-person trip with debts in both directions reaches All settled up after every suggested transfer", async () => {
    const tripMembers = [alice, bob, carol];
    const threeTrip = makeTrip(tripMembers, ["hotel", "dinner", "taxi"]);
    // Everyone paid something: Alice 30, Bob 12, Carol 9 (equal thirds).
    const threeExpenses = [
      makeExpense("hotel", alice, [[alice, "10"], [bob, "10"], [carol, "10"]]),
      makeExpense("dinner", bob, [[alice, "4"], [bob, "4"], [carol, "4"]]),
      makeExpense("taxi", carol, [[alice, "3"], [bob, "3"], [carol, "3"]]),
    ];
    const walletById = Object.fromEntries(tripMembers.map((m) => [m.id, m.walletAddress!]));

    let n = 0;
    jest.mocked(submitSignedTransaction).mockImplementation(async () => {
      n += 1;
      return { hash: n.toString(16).padStart(64, "0"), ledger: 100 + n, successful: true };
    });
    jest.mocked(recordTripSettlement).mockImplementation(async (_w, params) =>
      settlementFrom(params, walletById),
    );

    const { rerender } = render(<Harness trip={threeTrip} expenses={threeExpenses} />);

    // Netting leaves two transfers: Carol -> Alice 8 and Bob -> Alice 5.
    expect(screen.getAllByRole("button", { name: /pay/i })).toHaveLength(2);

    // Each suggested transfer can only be paid by its debtor: connect each in turn.
    for (const debtor of [carol, bob]) {
      connectAs(debtor.walletAddress!);
      rerender(<Harness trip={threeTrip} expenses={threeExpenses} />);
      const enabled = screen
        .getAllByRole("button", { name: /pay/i })
        .filter((b) => !(b as HTMLButtonElement).disabled);
      expect(enabled).toHaveLength(1);
      fireEvent.click(enabled[0]);
      await waitFor(() => {
        expect(recordTripSettlement).toHaveBeenCalledWith(
          debtor.walletAddress,
          expect.objectContaining({ fromMemberId: debtor.id }),
        );
      });
    }

    await waitFor(() => {
      expect(screen.getByText("All settled up!")).toBeTruthy();
    });
    const recorded = jest
      .mocked(recordTripSettlement)
      .mock.calls.map(([, p]) => [p.fromMemberId, p.toMemberId, p.amount]);
    expect(recorded).toEqual([
      [carol.id, alice.id, "8.0000000"],
      [bob.id, alice.id, "5.0000000"],
    ]);
  });

  it("keeps the settlement recorded when the on-chain receipt fails, and lets it be retried", async () => {
    jest.mocked(recordPaymentOnChain).mockResolvedValueOnce({
      success: false,
      error: "Contract simulation failed.",
    });

    render(<SettlementSummary trip={trip} expenses={expenses} />);
    fireEvent.click(screen.getByRole("button", { name: /pay 10/i }));

    await waitFor(() => {
      expect(screen.getByText("Payment sent, contract record pending")).toBeTruthy();
      expect(screen.getByText("Retry on-chain record")).toBeTruthy();
    });
    // The money moved, so the settlement is recorded regardless.
    expect(recordTripSettlement).toHaveBeenCalledTimes(1);

    jest.mocked(recordPaymentOnChain).mockResolvedValueOnce({ success: true, ledger: 12347 });
    fireEvent.click(screen.getByText("Retry on-chain record"));

    await waitFor(() => {
      expect(recordPaymentOnChain).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("Retry on-chain record")).toBeNull();
    });
  });

  it("keeps a durable pending settlement when the database write fails, and blocks paying again", async () => {
    jest.mocked(recordTripSettlement).mockRejectedValueOnce(new Error("Network request failed"));

    const { unmount } = render(<SettlementSummary trip={trip} expenses={expenses} />);
    fireEvent.click(screen.getByRole("button", { name: /pay 10/i }));

    await waitFor(() => {
      expect(screen.getByText("Retry recording")).toBeTruthy();
    });
    expect(getPendingSettlement(SENDER_WALLET, "trip-1", bob.id, alice.id)).toMatchObject({
      txHash: TX_HASH,
      status: "submitted",
      amount: "10.0000000",
    });

    // A reload shows the unrecorded transfer instead of a fresh Pay button.
    unmount();
    render(<SettlementSummary trip={trip} expenses={expenses} />);
    await waitFor(() => {
      expect(screen.getByText("Retry recording")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /pay 10/i })).toBeNull();

    fireEvent.click(screen.getByText("Retry recording"));
    await waitFor(() => {
      expect(screen.getByText(/payment successful!/i)).toBeTruthy();
    });
    expect(buildPaymentTransaction).toHaveBeenCalledTimes(1);
    expect(recordTripSettlement).toHaveBeenCalledTimes(2);
    expect(getPendingSettlement(SENDER_WALLET, "trip-1", bob.id, alice.id)).toBeNull();
  });

  it("settles the right member when two members share a display name (Issue #202)", async () => {
    const alexOne = { id: "member-alex-1", name: "Alex", walletAddress: CAROL_WALLET };
    const alexTwo = { id: "member-alex-2", name: "Alex", walletAddress: SENDER_WALLET };
    const dupTrip = makeTrip([alice, alexOne, alexTwo]);
    const dupExpenses = [
      makeExpense("exp-1", alice, [
        [alice, "10.0000000"],
        [alexOne, "10.0000000"],
        [alexTwo, "10.0000000"],
      ]),
    ];

    render(<SettlementSummary trip={dupTrip} expenses={dupExpenses} />);

    // Two Alexes stay two debts, not one merged 20 XLM debt.
    const buttons = screen.getAllByRole("button", { name: /pay 10/i });
    expect(buttons).toHaveLength(2);
    const enabled = buttons.filter((b) => !(b as HTMLButtonElement).disabled);
    expect(enabled).toHaveLength(1);

    fireEvent.click(enabled[0]);

    await waitFor(() => {
      expect(recordTripSettlement).toHaveBeenCalledWith(
        SENDER_WALLET,
        expect.objectContaining({ fromMemberId: "member-alex-2", toMemberId: alice.id }),
      );
    });
    expect(recordTripSettlement).toHaveBeenCalledTimes(1);
  });
});
