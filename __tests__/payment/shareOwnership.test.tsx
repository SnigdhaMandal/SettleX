/** @jest-environment jsdom */

/**
 * Issue #208: Pay is never shown or allowed for a share the connected wallet
 * does not own. The hook-level refusal is covered in
 * usePayment.integration.test.tsx; this file covers the rule and the UI.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { PaymentRow } from "@/components/expenses/PaymentRow";
import { canWalletPayShare, sameWallet, sharePaymentDenial } from "@/lib/payments/shareOwnership";
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
const mockQrData: unknown[] = [];
jest.mock("@/components/payment/QRCodeDisplay", () => ({
  QRToggle: ({ data }: { data: unknown }) => {
    mockQrData.push(data);
    return <div data-testid="qr-toggle" />;
  },
}));
jest.mock("@/components/expenses/ReceiptModal", () => ({
  ReceiptModal: () => null,
}));

const OWNER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const OTHER = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const CREDITOR = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const share: SplitShare = {
  memberId: "m2",
  name: "Bob",
  walletAddress: OWNER,
  amount: "5.0000000",
  paid: false,
};

describe("share ownership rule", () => {
  it("allows only the share's own wallet, paying someone else", () => {
    expect(canWalletPayShare({ share, connectedWallet: OWNER, creditorWallet: CREDITOR })).toBe(true);
    expect(canWalletPayShare({ share, connectedWallet: OWNER.toLowerCase(), creditorWallet: CREDITOR })).toBe(true);
  });

  it.each([
    ["no wallet is connected (the old show-for-everyone fallback)", { connectedWallet: null }],
    ["an undefined wallet", { connectedWallet: undefined }],
    ["another member's wallet", { connectedWallet: OTHER }],
    ["the creditor's wallet", { connectedWallet: CREDITOR }],
  ])("denies when %s", (_label, overrides) => {
    expect(canWalletPayShare({ share, creditorWallet: CREDITOR, ...overrides })).toBe(false);
  });

  it("denies a share without a wallet, the creditor's own share, and a missing creditor", () => {
    expect(sharePaymentDenial({ share: { ...share, walletAddress: undefined }, connectedWallet: OWNER, creditorWallet: CREDITOR }))
      .toMatch(/doesn't have a Stellar address/);
    expect(sharePaymentDenial({ share: { ...share, walletAddress: CREDITOR }, connectedWallet: CREDITOR, creditorWallet: CREDITOR }))
      .toMatch(/does not owe a share to themselves/);
    expect(sharePaymentDenial({ share, connectedWallet: OWNER, creditorWallet: "" }))
      .toMatch(/hasn't added their Stellar address/);
  });

  it("compares wallets case-insensitively and never matches empty values", () => {
    expect(sameWallet(OWNER, OWNER.toLowerCase())).toBe(true);
    expect(sameWallet("", "")).toBe(false);
    expect(sameWallet(undefined, undefined)).toBe(false);
  });
});

describe("PaymentRow only offers payment to the share's owner", () => {
  beforeEach(() => {
    mockQrData.length = 0;
  });

  const renderRow = (connectedWalletAddress: string | null | undefined, rowShare: SplitShare = share) =>
    render(
      <PaymentRow
        share={rowShare}
        expenseId="exp-1"
        index={0}
        onPay={jest.fn()}
        connectedWalletAddress={connectedWalletAddress}
        payerWalletAddress={CREDITOR}
      />,
    );

  it("shows Pay and a QR code that pays the creditor when the owner is connected", () => {
    renderRow(OWNER);

    expect(screen.getByRole("button", { name: /pay 5\.00 xlm/i })).toBeTruthy();
    expect(screen.getByTestId("qr-toggle")).toBeTruthy();
    // The QR must send to the member who paid the bill, not back to the share's owner.
    expect(mockQrData).toContainEqual(expect.objectContaining({ destination: CREDITOR, amount: "5.0000000" }));
    expect(mockQrData).not.toContainEqual(expect.objectContaining({ destination: OWNER }));
  });

  it.each([
    ["no wallet is connected", null],
    ["the wallet is undefined", undefined],
    ["another member is connected", OTHER],
    ["the creditor is connected", CREDITOR],
  ])("shows neither Pay nor a QR code when %s", (_label, connected) => {
    renderRow(connected);

    expect(screen.queryByRole("button", { name: /pay/i })).toBeNull();
    expect(screen.queryByTestId("qr-toggle")).toBeNull();
    expect(screen.getByText("Awaiting")).toBeTruthy();
  });

  it("never shows Pay on the creditor's own row, even to the creditor", () => {
    renderRow(CREDITOR, { ...share, walletAddress: CREDITOR, name: "Alice" });

    expect(screen.queryByRole("button", { name: /pay/i })).toBeNull();
    expect(screen.queryByTestId("qr-toggle")).toBeNull();
  });
});
