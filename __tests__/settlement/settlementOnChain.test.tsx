/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettlementSummary } from "@/components/trips/SettlementSummary";
import { buildPaymentTransaction } from "@/lib/stellar/buildTransaction";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import { recordPaymentOnChain } from "@/lib/stellar/contract";
import { signXDR } from "@/lib/freighter";
import { settlementMemo } from "@/lib/stellar/memo";
import type { Trip } from "@/types/trip";
import type { Expense } from "@/types/expense";

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

jest.mock("@/hooks/useExpense", () => ({
  useExpense: jest.fn(),
}));

jest.mock("@/components/ui/Toast", () => ({
  useToast: jest.fn(),
}));

jest.mock("@/lib/supabase/session", () => ({
  getAuthenticatedClient: jest.fn(async () => null),
}));

const SENDER_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RECEIVER_WALLET = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TX_HASH = "c".repeat(64);

const trip: Trip = {
  id: "trip-1",
  name: "Beach Trip",
  description: "Weekend beach trip",
  currency: "XLM",
  members: [
    { id: "member-alice", name: "Alice", walletAddress: RECEIVER_WALLET },
    { id: "member-bob", name: "Bob", walletAddress: SENDER_WALLET },
  ],
  expenseIds: ["exp-1"],
  settled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const expenses: Expense[] = [
  {
    id: "exp-1",
    title: "Dinner",
    totalAmount: "20.0000000",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "member-alice",
    members: [
      { id: "member-alice", name: "Alice", walletAddress: RECEIVER_WALLET },
      { id: "member-bob", name: "Bob", walletAddress: SENDER_WALLET },
    ],
    shares: [
      {
        memberId: "member-alice",
        name: "Alice",
        walletAddress: RECEIVER_WALLET,
        amount: "10.0000000",
        paid: true,
      },
      {
        memberId: "member-bob",
        name: "Bob",
        walletAddress: SENDER_WALLET,
        amount: "10.0000000",
        paid: false,
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    settled: false,
  },
];

describe("Settlement on-chain recording (Issue #209)", () => {
  const mockedUseWallet = jest.requireMock("@/hooks/useWallet").useWallet;
  const mockedUseExpense = jest.requireMock("@/hooks/useExpense").useExpense;
  const mockedUseToast = jest.requireMock("@/components/ui/Toast").useToast;

  const mockRefreshNetwork = jest.fn(async () => "TESTNET");
  const mockMarkSharePaid = jest.fn(async () => {});
  const mockToastSuccess = jest.fn();
  const mockToastError = jest.fn();
  const mockToastInfo = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();

    mockedUseWallet.mockReturnValue({
      publicKey: SENDER_WALLET,
      isNetworkCompatible: true,
      refreshNetwork: mockRefreshNetwork,
      expectedNetwork: "TESTNET",
    });

    mockedUseExpense.mockReturnValue({
      markSharePaid: mockMarkSharePaid,
    });

    mockedUseToast.mockReturnValue({
      success: mockToastSuccess,
      error: mockToastError,
      info: mockToastInfo,
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

    jest.mocked(recordPaymentOnChain).mockResolvedValue({
      success: true,
      ledger: 12346,
    });
  });

  it("records settlement payment on-chain per covered share and marks share paid", async () => {
    render(<SettlementSummary trip={trip} expenses={expenses} />);

    const payButton = screen.getByRole("button", { name: /pay 10/i });
    fireEvent.click(payButton);

    await waitFor(() => {
      expect(buildPaymentTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePublicKey: SENDER_WALLET,
          destinationPublicKey: RECEIVER_WALLET,
          amount: "10.0000000",
          memo: settlementMemo("trip-1", SENDER_WALLET, RECEIVER_WALLET),
        })
      );
    });

    await waitFor(() => {
      expect(submitSignedTransaction).toHaveBeenCalledWith("signed-xdr");
    });

    await waitFor(() => {
      expect(recordPaymentOnChain).toHaveBeenCalledWith(
        expect.objectContaining({
          debtorPublicKey: SENDER_WALLET,
          tripId: "trip-1",
          expenseId: "exp-1",
          creditorPublicKey: RECEIVER_WALLET,
          amountXlm: "10.0000000",
          txHash: TX_HASH,
        })
      );
    });

    await waitFor(() => {
      expect(mockMarkSharePaid).toHaveBeenCalledWith("exp-1", "member-bob", TX_HASH);
    });

    await waitFor(() => {
      expect(screen.getByText(/paid/i)).toBeTruthy();
      expect(screen.getByText(/payment successful!/i)).toBeTruthy();
    });
  });

  it("handles contract recording failure with partial_success pending state and allows retry", async () => {
    jest.mocked(recordPaymentOnChain).mockResolvedValueOnce({
      success: false,
      error: "Contract simulation failed.",
    });

    render(<SettlementSummary trip={trip} expenses={expenses} />);

    const payButton = screen.getByRole("button", { name: /pay 10/i });
    fireEvent.click(payButton);

    await waitFor(() => {
      expect(screen.getByText("Payment sent, contract record pending")).toBeTruthy();
      expect(screen.getByText("Retry on-chain record")).toBeTruthy();
    });

    // Mark share paid in DB still occurred since money moved
    expect(mockMarkSharePaid).toHaveBeenCalledWith("exp-1", "member-bob", TX_HASH);

    // Clicking retry on-chain record recovers and succeeds
    jest.mocked(recordPaymentOnChain).mockResolvedValueOnce({
      success: true,
      ledger: 12347,
    });

    fireEvent.click(screen.getByText("Retry on-chain record"));

    await waitFor(() => {
      expect(recordPaymentOnChain).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/payment successful!/i)).toBeTruthy();
    });
  });

  it("settles the right member when two members share a display name (Issue #202)", async () => {
    const ALEX_ONE_WALLET = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const ALEX_TWO_WALLET = SENDER_WALLET;
    const alice = { id: "member-alice", name: "Alice", walletAddress: RECEIVER_WALLET };
    const alexOne = { id: "member-alex-1", name: "Alex", walletAddress: ALEX_ONE_WALLET };
    const alexTwo = { id: "member-alex-2", name: "Alex", walletAddress: ALEX_TWO_WALLET };
    const dupTrip: Trip = { ...trip, members: [alice, alexOne, alexTwo] };
    const dupExpenses: Expense[] = [{
      ...expenses[0],
      totalAmount: "30.0000000",
      members: [alice, alexOne, alexTwo],
      shares: [
        { memberId: alice.id, name: alice.name, walletAddress: alice.walletAddress, amount: "10.0000000", paid: true },
        { memberId: alexOne.id, name: alexOne.name, walletAddress: alexOne.walletAddress, amount: "10.0000000", paid: false },
        { memberId: alexTwo.id, name: alexTwo.name, walletAddress: alexTwo.walletAddress, amount: "10.0000000", paid: false },
      ],
    }];

    render(<SettlementSummary trip={dupTrip} expenses={dupExpenses} />);

    // Two Alexes stay two debts, not one merged 20 XLM debt.
    const buttons = screen.getAllByRole("button", { name: /pay 10/i });
    expect(buttons).toHaveLength(2);
    const enabled = buttons.filter((b) => !(b as HTMLButtonElement).disabled);
    expect(enabled).toHaveLength(1);

    fireEvent.click(enabled[0]);

    await waitFor(() => {
      expect(mockMarkSharePaid).toHaveBeenCalledWith("exp-1", "member-alex-2", TX_HASH);
    });
    expect(mockMarkSharePaid).toHaveBeenCalledTimes(1);
    expect(recordPaymentOnChain).toHaveBeenCalledWith(
      expect.objectContaining({
        debtorPublicKey: ALEX_TWO_WALLET,
        creditorPublicKey: RECEIVER_WALLET,
        expenseId: "exp-1",
      }),
    );
  });
});
