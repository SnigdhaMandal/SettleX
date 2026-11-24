/** @jest-environment jsdom */

/**
 * Issue #204: "I paid via QR — paste the transaction hash". A verified hash
 * is recorded exactly like an in-app payment; anything else records nothing.
 */
import { recordPaymentOnChain } from "@/lib/stellar/contract";
import { shareMemo } from "@/lib/stellar/memo";
import type { SplitShare } from "@/types/expense";

const { act, renderHook } = require("@testing-library/react");

jest.mock("@/lib/stellar/buildTransaction");
jest.mock("@/lib/stellar/submitTransaction");
jest.mock("@/lib/stellar/contract", () => ({
  checkIsPaid: jest.fn(),
  recordPaymentOnChain: jest.fn(),
}));
jest.mock("@/lib/freighter", () => ({ signXDR: jest.fn() }));
jest.mock("@/hooks/useWallet", () => ({ useWallet: jest.fn() }));
jest.mock("@/hooks/useExpense", () => ({ useExpense: jest.fn() }));
jest.mock("@/components/ui/Toast", () => ({ useToast: jest.fn() }));
jest.mock("@/lib/supabase/session", () => ({
  getAuthenticatedClient: jest.fn(async () => null),
}));

const DEBTOR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CREDITOR = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const HASH = "d".repeat(64);
const EXPENSE_ID = "exp-qr";

const share: SplitShare = {
  memberId: "member-1",
  name: "Bob",
  walletAddress: DEBTOR,
  amount: "1.5000000",
  paid: false,
};

function mockHorizon(memo: string, to = CREDITOR) {
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string) => {
    if (String(url).includes("/operations")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          _embedded: {
            records: [{ type: "payment", asset_type: "native", from: DEBTOR, to, amount: "1.5000000" }],
          },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ successful: true, ledger: 900, memo, memo_type: "text", source_account: DEBTOR }),
    };
  });
}

describe("usePayment.reconcileQrPayment", () => {
  const { usePayment } = require("@/hooks/usePayment") as typeof import("@/hooks/usePayment");
  const mockedUseWallet = (jest.requireMock("@/hooks/useWallet") as { useWallet: jest.Mock }).useWallet;
  const mockedUseExpense = (jest.requireMock("@/hooks/useExpense") as { useExpense: jest.Mock }).useExpense;
  const mockedUseToast = (jest.requireMock("@/components/ui/Toast") as { useToast: jest.Mock }).useToast;
  const mockMarkSharePaid = jest.fn(async () => {});
  const toastError = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockedUseWallet.mockReturnValue({
      publicKey: DEBTOR,
      refreshBalance: jest.fn(),
      refreshNetwork: jest.fn(async () => "TESTNET"),
      reconcile: jest.fn(async () => {}),
      isNetworkCompatible: true,
      expectedNetwork: "TESTNET",
    });
    mockedUseExpense.mockReturnValue({ markSharePaid: mockMarkSharePaid });
    mockedUseToast.mockReturnValue({ success: jest.fn(), error: toastError, info: jest.fn() });
    jest.mocked(recordPaymentOnChain).mockResolvedValue({ success: true, ledger: 901 });
  });

  it("records a verified QR payment as paid, on-chain and in the database", async () => {
    mockHorizon(shareMemo(EXPENSE_ID, share.memberId));
    const { result } = renderHook(() => usePayment({ expenseId: EXPENSE_ID }));

    let ok = false;
    await act(async () => {
      ok = await result.current.reconcileQrPayment({
        share,
        payerWalletAddress: CREDITOR,
        tripId: "trip-1",
        txHash: HASH.toUpperCase(),
      });
    });

    expect(ok).toBe(true);
    expect(recordPaymentOnChain).toHaveBeenCalledWith(
      expect.objectContaining({
        debtorPublicKey: DEBTOR,
        creditorPublicKey: CREDITOR,
        expenseId: EXPENSE_ID,
        amountXlm: "1.5000000",
        txHash: HASH,
      }),
    );
    expect(mockMarkSharePaid).toHaveBeenCalledWith(EXPENSE_ID, share.memberId, HASH);
    expect(result.current.paymentState).toEqual(expect.objectContaining({ status: "success", hash: HASH }));
  });

  it("records nothing when the transaction pays the wrong person", async () => {
    mockHorizon(shareMemo(EXPENSE_ID, share.memberId), DEBTOR);
    const { result } = renderHook(() => usePayment({ expenseId: EXPENSE_ID }));

    let ok = true;
    await act(async () => {
      ok = await result.current.reconcileQrPayment({
        share,
        payerWalletAddress: CREDITOR,
        tripId: "trip-1",
        txHash: HASH,
      });
    });

    expect(ok).toBe(false);
    expect(mockMarkSharePaid).not.toHaveBeenCalled();
    expect(recordPaymentOnChain).not.toHaveBeenCalled();
    expect(result.current.paymentState.status).toBe("error");
    expect(toastError).toHaveBeenCalledWith("Payment not verified", expect.any(String));
  });

  it("records nothing for a transaction whose memo belongs to another share", async () => {
    mockHorizon(shareMemo(EXPENSE_ID, "someone-else"));
    const { result } = renderHook(() => usePayment({ expenseId: EXPENSE_ID }));

    await act(async () => {
      await result.current.reconcileQrPayment({
        share,
        payerWalletAddress: CREDITOR,
        txHash: HASH,
      });
    });

    expect(mockMarkSharePaid).not.toHaveBeenCalled();
    expect(result.current.paymentState.status).toBe("error");
  });

  it("refuses a share the connected wallet does not own", async () => {
    mockHorizon(shareMemo(EXPENSE_ID, share.memberId));
    const { result } = renderHook(() => usePayment({ expenseId: EXPENSE_ID }));

    await act(async () => {
      await result.current.reconcileQrPayment({
        share: { ...share, walletAddress: "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" },
        payerWalletAddress: CREDITOR,
        txHash: HASH,
      });
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockMarkSharePaid).not.toHaveBeenCalled();
  });
});
