/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import ExpensesPage from "@/app/expenses/page";
import { usePayment } from "@/hooks/usePayment";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children: React.ReactNode; href: string }) => (
    <a href={href} onClick={onClick} {...props}>
      {children}
    </a>
  ),
}));

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

jest.mock("@/components/auth/AuthGuard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock("@/components/wallet/ConnectWalletButton", () => ({
  ConnectWalletButton: () => <button>Connect Wallet</button>,
}));

jest.mock("@/components/expenses/ExpenseForm", () => ({
  ExpenseForm: () => <div>ExpenseForm</div>,
}));

jest.mock("@/components/expenses/SplitCalculator", () => ({
  SplitCalculator: ({
    shares,
    onPay,
  }: {
    shares: Array<{ memberId: string; name: string; amount: string; paid: boolean }>;
    onPay: (share: { memberId: string; name: string; amount: string; paid: boolean }) => void;
  }) => (
    <div>
      {shares.map((s) => (
        <button key={s.memberId} onClick={() => onPay(s)}>
          Pay {s.name}
        </button>
      ))}
    </div>
  ),
}));

jest.mock("@/components/payment/PaymentStatus", () => ({
  PaymentStatus: () => <div>PaymentStatus</div>,
}));

jest.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({
    publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  }),
}));

jest.mock("@/context/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "user-1", displayName: "Alice" },
  }),
}));

jest.mock("@/hooks/useToast", () => ({
  useToast: () => ({
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  }),
}));

jest.mock("@/hooks/useExpense", () => ({
  useExpense: jest.fn(),
}));

jest.mock("@/hooks/useTrip", () => ({
  useTrip: jest.fn(),
}));

jest.mock("@/hooks/usePayment", () => ({
  usePayment: jest.fn(),
}));

describe("ExpensesPage trip linking (Issue #210)", () => {
  const mockedUseExpense = jest.requireMock("@/hooks/useExpense").useExpense;
  const mockedUseTrip = jest.requireMock("@/hooks/useTrip").useTrip;
  const mockedUsePayment = jest.requireMock("@/hooks/usePayment").usePayment;

  const mockPayShare = jest.fn();

  const tripExpense: Expense = {
    id: "exp-trip",
    title: "Trip Dinner",
    totalAmount: "30.0000000",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "m1",
    members: [
      { id: "m1", name: "Alice", walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { id: "m2", name: "Bob", walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
    ],
    shares: [
      { memberId: "m1", name: "Alice", amount: "15.0000000", paid: true },
      { memberId: "m2", name: "Bob", amount: "15.0000000", paid: false },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    settled: false,
  };

  const standaloneExpense: Expense = {
    id: "exp-standalone",
    title: "Coffee",
    totalAmount: "10.0000000",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "m1",
    members: [
      { id: "m1", name: "Alice", walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { id: "m2", name: "Bob", walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
    ],
    shares: [
      { memberId: "m1", name: "Alice", amount: "5.0000000", paid: true },
      { memberId: "m2", name: "Bob", amount: "5.0000000", paid: false },
    ],
    createdAt: "2026-01-02T00:00:00.000Z",
    settled: false,
  };

  const trips: Trip[] = [
    {
      id: "trip-999",
      name: "Road Trip",
      description: "Fun road trip",
      currency: "XLM",
      members: [],
      expenseIds: ["exp-trip"],
      createdAt: "2026-01-01T00:00:00.000Z",
      settled: false,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    mockedUseExpense.mockReturnValue({
      expenses: [tripExpense, standaloneExpense],
      deleteExpense: jest.fn(),
    });

    mockedUseTrip.mockReturnValue({
      trips,
    });

    mockedUsePayment.mockReturnValue({
      payShare: mockPayShare,
      paymentState: { status: "idle" },
      reset: jest.fn(),
      retryOnChainRecord: jest.fn(),
      retryRecording: jest.fn(),
      pendingShareIds: [],
    });
  });

  it("renders 'Trip: Road Trip' chip for trip expenses and links to /trips/trip-999", () => {
    render(<ExpensesPage />);

    const tripChip = screen.getByRole("link", { name: "Trip: Road Trip" });
    expect(tripChip).toBeTruthy();
    expect(tripChip.getAttribute("href")).toBe("/trips/trip-999");
  });

  it("passes tripId to payShare and hides the not-linked banner for trip expenses", () => {
    render(<ExpensesPage />);

    // Expand trip expense
    fireEvent.click(screen.getByText("Trip Dinner"));

    // The "Not linked to a trip" banner should NOT appear for trip expenses
    expect(screen.queryByText(/Not linked to a trip/i)).toBeNull();

    // Clicking pay calls payShare with tripId
    fireEvent.click(screen.getByRole("button", { name: "Pay Bob" }));
    expect(mockPayShare).toHaveBeenCalledWith(
      expect.objectContaining({
        share: tripExpense.shares[1],
        tripId: "trip-999",
      })
    );
  });

  it("shows the not-linked banner and omits tripId for standalone expenses", () => {
    render(<ExpensesPage />);

    // Expand standalone expense
    fireEvent.click(screen.getByText("Coffee"));

    // The "Not linked to a trip" banner SHOULD appear for standalone expenses
    expect(screen.getByText(/Not linked to a trip/i)).toBeTruthy();

    // Clicking pay calls payShare without tripId (undefined)
    fireEvent.click(screen.getByRole("button", { name: "Pay Bob" }));
    expect(mockPayShare).toHaveBeenCalledWith(
      expect.objectContaining({
        share: standaloneExpense.shares[1],
        tripId: undefined,
      })
    );
  });
});
