const simulateTransactionMock = jest.fn();
const sendTransactionMock = jest.fn();
const getTransactionMock = jest.fn();

jest.mock("@/lib/stellar/soroban", () => ({
  sorobanServer: {
    simulateTransaction: (...args: unknown[]) => simulateTransactionMock(...args),
    sendTransaction: (...args: unknown[]) => sendTransactionMock(...args),
    getTransaction: (...args: unknown[]) => getTransactionMock(...args),
  },
}));

jest.mock("@/lib/freighter", () => ({
  signXDR: jest.fn().mockResolvedValue("mock-signed-xdr"),
}));

jest.mock("@/lib/observability/logger", () => ({
  logWarn: jest.fn(),
  reportError: jest.fn(),
}));

jest.mock("@/lib/utils/constants", () => ({
  CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
}));

import { checkIsPaid, getContractPayments, recordPaymentOnChain } from "@/lib/stellar/contract";
import { rpc } from "@stellar/stellar-sdk";

describe("contract client error handling and unfunded simulation (#211)", () => {
  const DEBTOR = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
  const CREDITOR = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAY";
  const UNFUNDED_CALLER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe("unfunded simulation reads", () => {
    it("checkIsPaid simulates read without calling Horizon loadAccount", async () => {
      simulateTransactionMock.mockResolvedValue({
        result: { retval: { switch: () => ({ name: "scvBool" }), value: () => true } },
      });

      const result = await checkIsPaid(UNFUNDED_CALLER, "exp-123", DEBTOR);

      expect(global.fetch).not.toHaveBeenCalled();
      expect(simulateTransactionMock).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.paid).toBe(true);
    });

    it("getContractPayments simulates read without calling Horizon loadAccount", async () => {
      simulateTransactionMock.mockResolvedValue({
        result: {
          retval: {
            switch: () => ({ name: "scvMap" }),
            value: () => [],
          },
        },
      });

      const result = await getContractPayments(UNFUNDED_CALLER, "trip-123");

      expect(global.fetch).not.toHaveBeenCalled();
      expect(simulateTransactionMock).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.payments).toEqual([]);
    });
  });

  describe("recordPaymentOnChain send status handling", () => {
    beforeEach(() => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ sequence: "12345" }),
      });
      simulateTransactionMock.mockResolvedValue({
        status: "SUCCESS",
        results: [{ auth: [] }],
        transactionData: { build: () => ({}) },
        minResourceFee: "100",
      });
    });

    it("rejects immediately with user-friendly error when sendResult is TRY_AGAIN_LATER", async () => {
      sendTransactionMock.mockResolvedValue({
        status: "TRY_AGAIN_LATER",
      });

      const result = await recordPaymentOnChain({
        debtorPublicKey: DEBTOR,
        tripId: "trip-1",
        expenseId: "exp-1",
        creditorPublicKey: CREDITOR,
        amountXlm: "10",
        txHash: "a".repeat(64),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("The network is currently busy. Please try submitting again later.");
      expect(getTransactionMock).not.toHaveBeenCalled();
    });

    it("rejects immediately with user-friendly error when sendResult is DUPLICATE", async () => {
      sendTransactionMock.mockResolvedValue({
        status: "DUPLICATE",
        hash: "b".repeat(64),
      });

      const result = await recordPaymentOnChain({
        debtorPublicKey: DEBTOR,
        tripId: "trip-1",
        expenseId: "exp-1",
        creditorPublicKey: CREDITOR,
        amountXlm: "10",
        txHash: "a".repeat(64),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Transaction is a duplicate and was already submitted.");
      expect(getTransactionMock).not.toHaveBeenCalled();
    });
  });

  describe("recordPaymentOnChain poll failure error decoding", () => {
    beforeEach(() => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ sequence: "12345" }),
      });
      simulateTransactionMock.mockResolvedValue({
        status: "SUCCESS",
        results: [{ auth: [] }],
        transactionData: { build: () => ({}) },
        minResourceFee: "100",
      });
      sendTransactionMock.mockResolvedValue({
        status: "PENDING",
        hash: "tx-hash-123",
      });
    });

    it("decodes resultXdr to base64 instead of [object Object] when transaction fails on-chain", async () => {
      const mockResultXdr = {
        toXDR: jest.fn().mockReturnValue("BASE64_RESULT_XDR"),
      };

      getTransactionMock.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        resultXdr: mockResultXdr,
      });

      const result = await recordPaymentOnChain({
        debtorPublicKey: DEBTOR,
        tripId: "trip-1",
        expenseId: "exp-1",
        creditorPublicKey: CREDITOR,
        amountXlm: "10",
        txHash: "a".repeat(64),
      });

      expect(result.success).toBe(false);
      expect(result.error).not.toContain("[object Object]");
      expect(result.error).toContain("BASE64_RESULT_XDR");
    });

    it("decodes contract error from diagnostic events when transaction fails on-chain", async () => {
      getTransactionMock.mockResolvedValue({
        status: rpc.Api.GetTransactionStatus.FAILED,
        resultXdr: { toXDR: () => "BASE64_RESULT_XDR" },
        diagnosticEventsXdr: ["HostError: Error(Contract, #2)"],
      });

      const result = await recordPaymentOnChain({
        debtorPublicKey: DEBTOR,
        tripId: "trip-1",
        expenseId: "exp-1",
        creditorPublicKey: CREDITOR,
        amountXlm: "10",
        txHash: "a".repeat(64),
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("This expense was already settled on-chain. No double payment needed.");
    });
  });
});
