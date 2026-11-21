/** @jest-environment jsdom */

/**
 * Issue #203: a share covered by trip netting needs no direct payment. It
 * shows as settled, and neither Pay nor the QR code is offered, so the Pay
 * button no longer reappears after a net settle-up.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { PaymentRow } from "@/components/expenses/PaymentRow";
import type { SplitShare } from "@/types/expense";

jest.mock("framer-motion", () => ({
  motion: {
    div: ({
      children,
      layout,
      initial,
      animate,
      exit,
      transition,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>) => <div {...props}>{children}</div>,
  },
}));
jest.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ isNetworkCompatible: true }),
}));
jest.mock("@/components/payment/QRCodeDisplay", () => ({
  QRToggle: () => <div data-testid="qr-toggle" />,
}));
jest.mock("@/components/expenses/ReceiptModal", () => ({
  ReceiptModal: () => null,
}));

const OWNER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CREDITOR = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const share: SplitShare = {
  memberId: "m2",
  name: "Bob",
  walletAddress: OWNER,
  amount: "10.0000000",
  paid: false,
};

const renderRow = (netSettled?: "net-transfer" | "offset") =>
  render(
    <PaymentRow
      share={share}
      expenseId="exp-1"
      index={0}
      onPay={jest.fn()}
      connectedWalletAddress={OWNER}
      payerWalletAddress={CREDITOR}
      netSettled={netSettled}
    />,
  );

describe("PaymentRow for a share covered by netting", () => {
  it("still offers Pay to the owner when nothing covers the share", () => {
    renderRow();
    expect(screen.getByRole("button", { name: /pay 10/i })).toBeTruthy();
    expect(screen.getByTestId("qr-toggle")).toBeTruthy();
  });

  it("shows 'Settled via net transfer' and no Pay or QR after a settle-up transfer", () => {
    renderRow("net-transfer");
    expect(screen.getByText(/settled via net transfer/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /pay/i })).toBeNull();
    expect(screen.queryByTestId("qr-toggle")).toBeNull();
  });

  it("shows 'Offset by netting' when the debts cancelled out", () => {
    renderRow("offset");
    expect(screen.getByText(/offset by netting/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /pay/i })).toBeNull();
  });
});
