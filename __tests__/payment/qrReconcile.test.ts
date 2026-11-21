/**
 * Issue #204: a QR payment is reconciled from a pasted transaction hash only
 * when Horizon shows exactly this share's payment.
 */
import { normalizeTxHash, verifyQrSharePayment } from "@/lib/payments/qrReconcile";

const DEBTOR = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CREDITOR = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const OTHER = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
const HASH = "ab".repeat(32);
const MEMO = "SX1S:ABCDEFGHIJKLMNOPQRSTUVW";

const expected = {
  txHash: HASH,
  debtorWallet: DEBTOR,
  creditorWallet: CREDITOR,
  amount: "1.5000000",
  memo: MEMO,
};

type Op = Record<string, unknown>;

function mockHorizon({
  status = 200,
  tx = {},
  ops = [],
}: {
  status?: number;
  tx?: Record<string, unknown>;
  ops?: Op[];
}) {
  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes("/operations")) {
      return { ok: true, status: 200, json: async () => ({ _embedded: { records: ops } }) } as Response;
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({
        successful: true,
        ledger: 777,
        memo: MEMO,
        memo_type: "text",
        source_account: DEBTOR,
        ...tx,
      }),
    } as Response;
  }) as unknown as typeof fetch;
}

const payment = (overrides: Op = {}): Op => ({
  type: "payment",
  asset_type: "native",
  from: DEBTOR,
  to: CREDITOR,
  amount: "1.5000000",
  ...overrides,
});

describe("verifyQrSharePayment", () => {
  it("accepts the share's exact native payment from debtor to creditor", async () => {
    mockHorizon({ ops: [payment()] });
    await expect(verifyQrSharePayment(expected)).resolves.toEqual({ ok: true, ledger: 777, txHash: HASH });
  });

  it("accepts an upper-case or padded hash and normalises it", async () => {
    mockHorizon({ ops: [payment()] });
    const res = await verifyQrSharePayment({ ...expected, txHash: `  ${HASH.toUpperCase()} ` });
    expect(res).toEqual({ ok: true, ledger: 777, txHash: HASH });
  });

  it("compares amounts in stroops, so 1.5 equals 1.5000000", async () => {
    mockHorizon({ ops: [payment({ amount: "1.5" })] });
    expect((await verifyQrSharePayment(expected)).ok).toBe(true);
  });

  it.each([
    ["the memo is for another share", { tx: { memo: "SX1S:ZZZZZZZZZZZZZZZZZZZZZZZ" }, ops: [payment()] }, /memo does not match/],
    ["there is no memo", { tx: { memo: undefined, memo_type: "none" }, ops: [payment()] }, /memo does not match/],
    ["it pays the debtor back (the old QR bug)", { ops: [payment({ to: DEBTOR })] }, /not an XLM payment/],
    ["it pays someone else", { ops: [payment({ to: OTHER })] }, /not an XLM payment/],
    ["it is sent from another account", { tx: { source_account: OTHER }, ops: [payment({ from: OTHER })] }, /not an XLM payment/],
    ["the amount is one stroop short", { ops: [payment({ amount: "1.4999999" })] }, /exact amount/],
    ["it is not XLM", { ops: [payment({ asset_type: "credit_alphanum4" })] }, /not an XLM payment/],
    ["it is not a payment", { ops: [payment({ type: "create_account" })] }, /not an XLM payment/],
    ["it failed on-chain", { tx: { successful: false }, ops: [payment()] }, /failed on the Stellar network/],
  ])("rejects when %s", async (_label, horizon, reason) => {
    mockHorizon(horizon as Parameters<typeof mockHorizon>[0]);
    const res = await verifyQrSharePayment(expected);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(reason);
  });

  it("rejects a hash that does not exist on this network", async () => {
    mockHorizon({ status: 404 });
    const res = await verifyQrSharePayment(expected);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/right network/);
  });

  it("reports Horizon being unreachable separately", async () => {
    mockHorizon({ status: 503 });
    const res = await verifyQrSharePayment(expected);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/Could not reach Stellar/);
  });

  it("rejects malformed input without calling Horizon", async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const res = await verifyQrSharePayment({ ...expected, txHash: "not-a-hash" });
    expect(res.ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(normalizeTxHash("xyz")).toBeNull();
  });
});
