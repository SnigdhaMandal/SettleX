/** @jest-environment jsdom */

/**
 * Issue #204: the QR code must pay the CREDITOR, must name the network (a
 * SEP-0007 URI without network_passphrase defaults to Mainnet), must be
 * percent-encoded, and must show the exact amount it requests.
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { PaymentRow } from "@/components/expenses/PaymentRow";
import { buildQRPaymentURI, parseQRPaymentURI } from "@/lib/qr/generator";
import { shareMemo } from "@/lib/stellar/memo";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import type { SplitShare } from "@/types/expense";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";

jest.mock("framer-motion", () => {
  const strip = ({
    children,
    layout,
    initial,
    animate,
    exit,
    transition,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>) => <div {...props}>{children}</div>;
  return {
    motion: { div: strip },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});
jest.mock("@/hooks/useWallet", () => ({
  useWallet: () => ({ isNetworkCompatible: true }),
}));
jest.mock("@/components/expenses/ReceiptModal", () => ({
  ReceiptModal: () => null,
}));
const mockQrValues: string[] = [];
jest.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => {
    mockQrValues.push(value);
    return <svg data-testid="qr-svg" />;
  },
}));

const DEBTOR = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CREDITOR = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

describe("buildQRPaymentURI (SEP-0007)", () => {
  it("defaults to the testnet passphrase in this (testnet) build", () => {
    expect(NETWORK_PASSPHRASE).toBe(TESTNET_PASSPHRASE);
    const params = parseQRPaymentURI(buildQRPaymentURI({ destination: CREDITOR, amount: "1" }));
    expect(params.network_passphrase).toBe(TESTNET_PASSPHRASE);
  });

  it("names the Mainnet passphrase explicitly when asked", () => {
    const params = parseQRPaymentURI(
      buildQRPaymentURI({ destination: CREDITOR, amount: "1", networkPassphrase: PUBLIC_PASSPHRASE }),
    );
    expect(params.network_passphrase).toBe(PUBLIC_PASSPHRASE);
  });

  it("percent-encodes with %20, never +", () => {
    const uri = buildQRPaymentURI({ destination: CREDITOR, amount: "1", memo: "a b+c" });
    expect(uri).not.toContain("+");
    expect(uri).toContain("memo=a%20b%2Bc");
    expect(uri).toContain("network_passphrase=Test%20SDF%20Network%20%3B%20September%202015");
    expect(parseQRPaymentURI(uri).memo).toBe("a b+c");
  });

  it("requests the exact 7-decimal amount", () => {
    const params = parseQRPaymentURI(buildQRPaymentURI({ destination: CREDITOR, amount: "1.2345678" }));
    expect(params.amount).toBe("1.2345678");
    expect(parseQRPaymentURI(buildQRPaymentURI({ destination: CREDITOR, amount: "2.5" })).amount).toBe("2.5000000");
  });

  it("orders the parameters as SEP-0007 shows them", () => {
    const uri = buildQRPaymentURI({ destination: CREDITOR, amount: "1", memo: "m" });
    expect(uri).toBe(
      `web+stellar:pay?destination=${CREDITOR}&amount=1.0000000&memo=m&memo_type=MEMO_TEXT` +
        "&network_passphrase=Test%20SDF%20Network%20%3B%20September%202015",
    );
  });
});

describe("the QR shown on a share pays the creditor on the right network", () => {
  const share: SplitShare = {
    memberId: "m-debtor",
    name: "Bob",
    walletAddress: DEBTOR,
    amount: "1.2345678",
    paid: false,
  };

  beforeEach(() => {
    mockQrValues.length = 0;
  });

  it("encodes the creditor as destination and the testnet passphrase", () => {
    render(
      <PaymentRow
        share={share}
        expenseId="exp-1"
        index={0}
        onPay={jest.fn()}
        connectedWalletAddress={DEBTOR}
        payerWalletAddress={CREDITOR}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /qr code/i }));

    expect(mockQrValues.length).toBeGreaterThan(0);
    const params = parseQRPaymentURI(mockQrValues[mockQrValues.length - 1]);
    expect(params.destination).toBe(CREDITOR);
    expect(params.destination).not.toBe(DEBTOR);
    expect(params.network_passphrase).toBe(TESTNET_PASSPHRASE);
    expect(params.amount).toBe("1.2345678");
    expect(params.memo).toBe(shareMemo("exp-1", "m-debtor"));
    expect(params.memo_type).toBe("MEMO_TEXT");

    // The label shows exactly what is requested, not a 4-decimal rounding.
    expect(screen.getByText("Scan to pay 1.2345678 XLM")).toBeTruthy();
    expect(screen.getByText(/stellar testnet only/i)).toBeTruthy();
  });

  it("offers the paste-the-hash reconciliation path next to the QR", () => {
    render(
      <PaymentRow
        share={share}
        expenseId="exp-1"
        index={0}
        onPay={jest.fn()}
        onReconcileQr={jest.fn(async () => true)}
        connectedWalletAddress={DEBTOR}
        payerWalletAddress={CREDITOR}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /i paid via qr/i }));
    const input = screen.getByLabelText("Transaction hash");
    const submit = screen.getByRole("button", { name: /verify & record/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "f".repeat(64) } });
    expect(submit.disabled).toBe(false);
  });
});
