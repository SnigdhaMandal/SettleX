import {
  buildPaymentTransaction,
  fetchSuggestedFee,
} from "@/lib/stellar/buildTransaction";
import { Memo, TransactionBuilder } from "@stellar/stellar-sdk";
import { MEMO_MAX_BYTES, NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import { settlementMemo, shareMemo } from "@/lib/stellar/memo";

const sourcePublicKey = "GCUOC6KXBSOHRIMBWAHOOHLNJVHJGDPVMCMRXDKKUYQ4AUO5PNX2WYVF";
const destinationPublicKey = "GCGQLYHZDOSEWXKLKHYSZXYRUWTEPGLPDHWVIZQRL5XDE2BIEJ76XVMV";

describe("buildPaymentTransaction", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("builds xdr, dynamic fee, and uses the identifying memo verbatim", async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (url.includes("/fee_stats")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            fee_charged: { p70: "200", mode: "150" },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ sequence: "12345" }),
      });
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await buildPaymentTransaction({
      sourcePublicKey,
      destinationPublicKey,
      amount: "1.25",
      memo: shareMemo("exp-1", "m2"),
    });

    expect(typeof result.xdr).toBe("string");
    expect(result.xdr.length).toBeGreaterThan(20);
    expect(result.memo).toBe(shareMemo("exp-1", "m2"));
    const tx = TransactionBuilder.fromXDR(result.xdr, NETWORK_PASSPHRASE);
    expect(tx.memo.type).toBe(Memo.text("x").type);
    expect(String(tx.memo.value)).toBe(shareMemo("exp-1", "m2"));
    // 200 * 1.5 = 300
    expect(result.fee).toBe("300");
  });

  it("does not double-prefix settlement memos", async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (url.includes("/fee_stats")) {
        return Promise.resolve({ ok: true, json: async () => ({ fee_charged: { mode: "100" } }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ sequence: "54321" }) });
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const memo = settlementMemo("trip-1", sourcePublicKey, destinationPublicKey);
    const result = await buildPaymentTransaction({
      sourcePublicKey,
      destinationPublicKey,
      amount: "0.5",
      memo,
    });

    expect(result.memo).toBe(memo);
    expect(result.memo).not.toMatch(/SettleX\|/);
    expect(new TextEncoder().encode(result.memo).length).toBeLessThanOrEqual(MEMO_MAX_BYTES);
  });

  it.each([
    "SettleX|Dinner|Aman",
    "Dinner",
    "",
  ])("rejects a memo that does not identify a share or settlement (%p)", async (memo) => {
    const fetchMock = jest.fn();
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await expect(
      buildPaymentTransaction({ sourcePublicKey, destinationPublicKey, amount: "1", memo }),
    ).rejects.toThrow("Payment memo is missing or invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when horizon account lookup fails", async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (url.includes("/fee_stats")) {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await expect(
      buildPaymentTransaction({
        sourcePublicKey,
        destinationPublicKey,
        amount: "2",
        memo: shareMemo("exp-1", "m1"),
      }),
    ).rejects.toThrow("Failed to load account from Horizon");
  });
});
