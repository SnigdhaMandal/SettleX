/** @jest-environment jsdom */

import { buildPaymentTransaction } from "@/lib/stellar/buildTransaction";
import {
  inspectSignedTransaction,
  isSubmissionIndeterminate,
  submitSignedTransaction,
} from "@/lib/stellar/submitTransaction";
import { checkIsPaid, recordPaymentOnChain } from "@/lib/stellar/contract";
import { signXDR } from "@/lib/freighter";
import { shareMemo } from "@/lib/stellar/memo";
import type { SplitShare } from "@/types/expense";

const { act, renderHook, waitFor } = require("@testing-library/react");

jest.mock("@/lib/stellar/buildTransaction");
jest.mock("@/lib/stellar/submitTransaction");
jest.mock("@/lib/stellar/contract", () => ({
  checkIsPaid: jest.fn(),
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
// No database session in tests: the pending-payment mirror is best-effort, so
// these tests exercise the localStorage path that survives a reload.
jest.mock("@/lib/supabase/session", () => ({
  getAuthenticatedClient: jest.fn(async () => null),
}));

const SIGNED_HASH = "a".repeat(64);
const PENDING_KEY = "settlex:pendingPayments:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("usePayment integration flow", () => {
  const { usePayment } = require("@/hooks/usePayment") as typeof import("@/hooks/usePayment");
  const mockedUseWallet = (jest.requireMock("@/hooks/useWallet") as { useWallet: jest.Mock }).useWallet;
  const mockedUseExpense = (jest.requireMock("@/hooks/useExpense") as { useExpense: jest.Mock }).useExpense;
  const mockedUseToast = (jest.requireMock("@/components/ui/Toast") as { useToast: jest.Mock }).useToast;

  const mockRefreshBalance = jest.fn();
  const mockRefreshNetwork = jest.fn(async () => "TESTNET");
  const mockReconcile = jest.fn(async () => {});
  const mockMarkSharePaid = jest.fn(async (_expenseId: string, _memberId: string, _txHash: string) => {});
  const mockToastSuccess = jest.fn();
  const mockToastError = jest.fn();
  const mockToastInfo = jest.fn();

  const share: SplitShare = {
    memberId: "member-1",
    name: "Bob",
    walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    amount: "1.5000000",
    paid: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockedUseWallet.mockReturnValue({
      publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      refreshBalance: mockRefreshBalance,
      refreshNetwork: mockRefreshNetwork,
      reconcile: mockReconcile,
      isNetworkCompatible: true,
      networkStatus: "matched",
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
      memo: "SettleX|Dinner",
      fee: "100",
    });
    jest.mocked(signXDR).mockResolvedValue("signed-xdr");
    jest.mocked(submitSignedTransaction).mockResolvedValue({
      hash: "tx-hash-123",
      ledger: 321,
      successful: true,
    });
    jest.mocked(checkIsPaid).mockResolvedValue({ paid: false, success: true });
    jest.mocked(recordPaymentOnChain).mockResolvedValue({ success: true, ledger: 322 });
    jest.mocked(inspectSignedTransaction).mockReturnValue({
      hash: SIGNED_HASH,
      validUntil: new Date(Date.now() + 180_000).toISOString(),
    });
    jest.mocked(isSubmissionIndeterminate).mockReturnValue(false);
    mockMarkSharePaid.mockImplementation(async () => {});
    window.localStorage.clear();
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      status: 404,
      ok: false,
      json: async () => ({}),
    }));
  });

  it("completes payment and records on-chain successfully", async () => {
    const { result } = renderHook(() => usePayment({ expenseId: "exp-1" }));

    await act(async () => {
      await result.current.payShare({
        share,
        expenseTitle: "Dinner",
        payerWalletAddress: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
        tripId: "trip-1",
      });
    });

    await waitFor(() => {
      expect(result.current.paymentState.status).toBe("success");
    });

    expect(mockMarkSharePaid).toHaveBeenCalledWith("exp-1", "member-1", "tx-hash-123");
    // The memo identifies the share (Issue #207), not the title or name.
    expect(buildPaymentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ memo: shareMemo("exp-1", "member-1") }),
    );
    expect(recordPaymentOnChain).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it("does not mark a share paid when transaction submission times out unconfirmed", async () => {
    jest.mocked(submitSignedTransaction).mockRejectedValue(
      new Error("Transaction submission timed out."),
    );
    const { result } = renderHook(() => usePayment({ expenseId: "exp-timeout" }));

    await act(async () => {
      await result.current.payShare({
        share,
        expenseTitle: "Dinner",
        payerWalletAddress: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      });
    });

    expect(result.current.paymentState.status).toBe("error");
    expect(mockMarkSharePaid).not.toHaveBeenCalled();
    expect(recordPaymentOnChain).not.toHaveBeenCalled();
  });

  it("does not build or submit a payment when the wallet network mismatches", async () => {
    mockedUseWallet.mockReturnValue({
      publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      refreshBalance: mockRefreshBalance,
      refreshNetwork: jest.fn(async () => "PUBLIC"),
      reconcile: mockReconcile,
      isNetworkCompatible: false,
      networkStatus: "mismatched",
      expectedNetwork: "TESTNET",
    });
    const { result } = renderHook(() => usePayment({ expenseId: "exp-network" }));

    await act(async () => {
      await result.current.payShare({
        share,
        expenseTitle: "Dinner",
        payerWalletAddress: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      });
    });

    expect(buildPaymentTransaction).not.toHaveBeenCalled();
    expect(signXDR).not.toHaveBeenCalled();
    expect(submitSignedTransaction).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      "Payment blocked",
      "Switch your wallet to Testnet before paying.",
    );
  });

  it("supports retry when on-chain recording initially fails", async () => {
    jest.mocked(recordPaymentOnChain)
      .mockResolvedValueOnce({ success: false, error: "Pool balance too low" })
      .mockResolvedValueOnce({ success: true, ledger: 400 });

    const { result } = renderHook(() => usePayment({ expenseId: "exp-2" }));

    await act(async () => {
      await result.current.payShare({
        share,
        expenseTitle: "Taxi",
        payerWalletAddress: "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
        tripId: "trip-2",
      });
    });

    await waitFor(() => {
      expect(result.current.paymentState.status).toBe("partial_success");
    });

    await act(async () => {
      await result.current.retryOnChainRecord();
    });

    await waitFor(() => {
      expect(result.current.paymentState.status).toBe("success");
    });

    expect(recordPaymentOnChain).toHaveBeenCalledTimes(2);
  });
  // ─── Issue #205: money moved but the share stays unpaid on a DB error ───────

  const payStandalone = async (result: { current: ReturnType<typeof usePayment> }) => {
    await act(async () => {
      await result.current.payShare({
        share,
        expenseTitle: "Dinner",
        payerWalletAddress: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      });
    });
  };

  it("persists the signed hash before submitting the transfer", async () => {
    let storedAtSubmit: string | null = null;
    jest.mocked(submitSignedTransaction).mockImplementation(async () => {
      storedAtSubmit = window.localStorage.getItem(PENDING_KEY);
      return { hash: SIGNED_HASH, ledger: 321, successful: true };
    });
    const { result } = renderHook(() => usePayment({ expenseId: "exp-durable" }));

    await payStandalone(result);

    expect(storedAtSubmit).not.toBeNull();
    const entry = JSON.parse(storedAtSubmit!)["exp-durable:member-1"];
    expect(entry).toMatchObject({ txHash: SIGNED_HASH, status: "signed", memberId: "member-1" });
    // Recorded successfully, so the pending entry is gone again.
    expect(result.current.paymentState.status).toBe("success");
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(result.current.pendingShareIds).toEqual([]);
  });

  it("shows 'Payment sent — recording pending' and keeps Pay disabled when markSharePaid rejects after the transfer", async () => {
    jest.mocked(submitSignedTransaction).mockResolvedValue({
      hash: SIGNED_HASH,
      ledger: 321,
      successful: true,
    });
    mockMarkSharePaid.mockRejectedValue(new Error("JWT expired"));
    const { result } = renderHook(() => usePayment({ expenseId: "exp-unrecorded" }));

    await payStandalone(result);

    expect(result.current.paymentState.status).toBe("paid_unrecorded");
    expect(result.current.paymentState).toMatchObject({ hash: SIGNED_HASH });
    expect(mockToastInfo).toHaveBeenCalledWith(
      "Payment sent — recording pending",
      expect.stringContaining("do not pay again"),
    );
    expect(mockToastError).not.toHaveBeenCalledWith("Payment failed", expect.anything());
    expect(result.current.pendingShareIds).toEqual(["member-1"]);
    expect(result.current.hasPendingPayment("member-1")).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(PENDING_KEY)!)["exp-unrecorded:member-1"])
      .toMatchObject({ txHash: SIGNED_HASH, status: "submitted" });

    // The duplicate guard holds for a standalone expense (no contract check).
    jest.mocked(buildPaymentTransaction).mockClear();
    jest.mocked(signXDR).mockClear();
    await payStandalone(result);
    expect(buildPaymentTransaction).not.toHaveBeenCalled();
    expect(signXDR).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Payment already sent", expect.any(String));
  });

  it("records the share on 'Retry recording' and then unblocks the share", async () => {
    jest.mocked(submitSignedTransaction).mockResolvedValue({
      hash: SIGNED_HASH,
      ledger: 321,
      successful: true,
    });
    mockMarkSharePaid.mockRejectedValueOnce(new Error("Failed to fetch"));
    const { result } = renderHook(() => usePayment({ expenseId: "exp-retry" }));

    await payStandalone(result);
    expect(result.current.paymentState.status).toBe("paid_unrecorded");

    await act(async () => {
      await result.current.retryRecording();
    });

    expect(mockMarkSharePaid).toHaveBeenLastCalledWith("exp-retry", "member-1", SIGNED_HASH);
    expect(result.current.paymentState.status).toBe("success");
    expect(result.current.pendingShareIds).toEqual([]);
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("keeps the share blocked when the submission outcome is unknown", async () => {
    jest.mocked(submitSignedTransaction).mockRejectedValue(
      new Error("Transaction submission timed out."),
    );
    jest.mocked(isSubmissionIndeterminate).mockReturnValue(true);
    const { result } = renderHook(() => usePayment({ expenseId: "exp-unknown" }));

    await payStandalone(result);

    expect(result.current.paymentState.status).toBe("pending_confirmation");
    expect(mockMarkSharePaid).not.toHaveBeenCalled();
    expect(result.current.pendingShareIds).toEqual(["member-1"]);
  });

  it("clears the pending entry when the submission definitively failed", async () => {
    jest.mocked(submitSignedTransaction).mockRejectedValue(
      new Error("Insufficient XLM balance to complete this payment."),
    );
    const { result } = renderHook(() => usePayment({ expenseId: "exp-definitive" }));

    await payStandalone(result);

    expect(result.current.paymentState.status).toBe("error");
    expect(result.current.pendingShareIds).toEqual([]);
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  describe("after a reload", () => {
    const seed = (overrides: Record<string, unknown> = {}) => {
      window.localStorage.setItem(PENDING_KEY, JSON.stringify({
        "exp-reload:member-1": {
          expenseId: "exp-reload",
          memberId: "member-1",
          txHash: SIGNED_HASH,
          payerWallet: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          destinationWallet: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          amount: "1.5000000",
          tripId: null,
          status: "signed",
          ledger: null,
          validUntil: new Date(Date.now() + 120_000).toISOString(),
          onChainRecorded: false,
          createdAt: new Date().toISOString(),
          ...overrides,
        },
      }));
    };

    it("reconciles a pending payment that landed on Horizon and records the share", async () => {
      seed();
      (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ successful: true, ledger: 999 }),
      }));

      const { result } = renderHook(() => usePayment({ expenseId: "exp-reload" }));
      // Blocked straight away, before Horizon answers.
      expect(result.current.pendingShareIds).toEqual(["member-1"]);

      await waitFor(() => {
        expect(result.current.paymentState.status).toBe("success");
      });
      expect((global as unknown as { fetch: jest.Mock }).fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/transactions/${SIGNED_HASH}`),
        expect.anything(),
      );
      expect(mockMarkSharePaid).toHaveBeenCalledWith("exp-reload", "member-1", SIGNED_HASH);
      expect(result.current.pendingShareIds).toEqual([]);
      expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
    });

    it("stays paid_unrecorded with Pay blocked if recording still fails after reload", async () => {
      seed({ status: "submitted", ledger: 500 });
      mockMarkSharePaid.mockRejectedValue(new Error("offline"));

      const { result } = renderHook(() => usePayment({ expenseId: "exp-reload" }));

      await waitFor(() => {
        expect(result.current.paymentState.status).toBe("paid_unrecorded");
      });
      // A submitted transfer is known to have landed; no Horizon lookup needed.
      expect((global as unknown as { fetch: jest.Mock }).fetch).not.toHaveBeenCalled();
      expect(result.current.pendingShareIds).toEqual(["member-1"]);
    });

    it("treats an 'already marked as paid' response as recorded", async () => {
      seed({ status: "submitted", ledger: 500 });
      mockMarkSharePaid.mockRejectedValue(new Error("Share is already marked as paid"));

      const { result } = renderHook(() => usePayment({ expenseId: "exp-reload" }));

      await waitFor(() => {
        expect(result.current.paymentState.status).toBe("success");
      });
      expect(result.current.pendingShareIds).toEqual([]);
    });

    it("drops a pending payment that failed on the ledger without recording it", async () => {
      seed();
      (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
        status: 200,
        ok: true,
        json: async () => ({ successful: false, ledger: 999 }),
      }));

      const { result } = renderHook(() => usePayment({ expenseId: "exp-reload" }));

      await waitFor(() => {
        expect(result.current.pendingShareIds).toEqual([]);
      });
      expect(mockMarkSharePaid).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
    });

    it("drops a signed payment that expired without ever reaching Horizon", async () => {
      seed({ validUntil: new Date(Date.now() - 10 * 60_000).toISOString() });

      const { result } = renderHook(() => usePayment({ expenseId: "exp-reload" }));

      await waitFor(() => {
        expect(result.current.pendingShareIds).toEqual([]);
      });
      expect(result.current.paymentState.status).toBe("idle");
      expect(mockMarkSharePaid).not.toHaveBeenCalled();
    });

    it("keeps a signed payment blocked while Horizon has not seen it yet", async () => {
      seed();

      const { result } = renderHook(() => usePayment({ expenseId: "exp-reload" }));

      await waitFor(() => {
        expect(result.current.paymentState.status).toBe("pending_confirmation");
      });
      expect(result.current.pendingShareIds).toEqual(["member-1"]);
      expect(mockMarkSharePaid).not.toHaveBeenCalled();
    });
  });
});
