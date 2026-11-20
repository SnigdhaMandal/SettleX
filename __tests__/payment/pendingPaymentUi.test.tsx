/** @jest-environment jsdom */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { PaymentStatus } from "@/components/payment/PaymentStatus";
import { PaymentRow } from "@/components/expenses/PaymentRow";
import type { SplitShare } from "@/types/expense";

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
jest.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ isNetworkCompatible: true }),
}));
jest.mock("@/components/payment/QRCodeDisplay", () => ({
  QRToggle: () => <div data-testid="qr-toggle" />,
}));
jest.mock("@/components/expenses/ReceiptModal", () => ({
  ReceiptModal: () => null,
}));

const HASH = "b".repeat(64);
const WALLET = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CREDITOR = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const share: SplitShare = {
  memberId: "member-1",
  name: "Bob",
  walletAddress: WALLET,
  amount: "1.5000000",
  paid: false,
};

describe("Pending payment UI (Issue #205)", () => {
  it("shows 'Payment sent — recording pending' with a Retry recording action, not 'Payment failed'", () => {
    const onRetryRecording = jest.fn();
    render(
      <PaymentStatus
        state={{ status: "paid_unrecorded", hash: HASH, ledger: 10, onChain: false, message: "Session expired" }}
        onRetryRecording={onRetryRecording}
        onReset={jest.fn()}
      />,
    );

    expect(screen.getByText("Payment sent — recording pending")).toBeTruthy();
    expect(screen.queryByText("Payment failed")).toBeNull();
    // No dismiss: the state must stay visible until the transfer is recorded.
    expect(screen.queryByText("Dismiss")).toBeNull();

    fireEvent.click(screen.getByText("Retry recording"));
    expect(onRetryRecording).toHaveBeenCalledTimes(1);
  });

  it("shows an awaiting-confirmation state with a Check again action", () => {
    const onRetryRecording = jest.fn();
    render(
      <PaymentStatus
        state={{ status: "pending_confirmation", hash: HASH, message: "Not confirmed yet." }}
        onRetryRecording={onRetryRecording}
      />,
    );

    expect(screen.getByText("Payment awaiting confirmation")).toBeTruthy();
    fireEvent.click(screen.getByText("Check again"));
    expect(onRetryRecording).toHaveBeenCalledTimes(1);
  });

  it("disables Pay and hides the QR payment option while a payment is pending", () => {
    const onPay = jest.fn();
    render(
      <PaymentRow
        share={share}
        index={0}
        onPay={onPay}
        hasPendingPayment
        connectedWalletAddress={WALLET}
        payerWalletAddress={CREDITOR}
        expenseId="exp-1"
      />,
    );

    const button = screen.getByRole("button", { name: /payment pending/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onPay).not.toHaveBeenCalled();
    expect(screen.queryByTestId("qr-toggle")).toBeNull();
  });

  it("keeps Pay enabled when nothing is pending", () => {
    render(
      <PaymentRow
        share={share}
        index={0}
        onPay={jest.fn()}
        connectedWalletAddress={WALLET}
        payerWalletAddress={CREDITOR}
      />,
    );

    const button = screen.getByRole("button", { name: /pay 1\.5/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
