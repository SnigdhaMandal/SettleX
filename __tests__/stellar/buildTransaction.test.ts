import {
  buildPaymentTransaction,
  fetchSuggestedFee,
} from "@/lib/stellar/buildTransaction";
import { MEMO_MAX_BYTES, MEMO_PREFIX } from "@/lib/utils/constants";

const sourcePublicKey = "GCUOC6KXBSOHRIMBWAHOOHLNJVHJGDPVMCMRXDKKUYQ4AUO5PNX2WYVF";
const destinationPublicKey = "GCGQLYHZDOSEWXKLKHYSZXYRUWTEPGLPDHWVIZQRL5XDE2BIEJ76XVMV";

describe("buildPaymentTransaction", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("builds xdr, dynamic fee, and prefixes memo", async () => {
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
      memoText: "Dinner",
    });

    expect(typeof result.xdr).toBe("string");
    expect(result.xdr.length).toBeGreaterThan(20);
    expect(result.memo).toBe(`${MEMO_PREFIX}|Dinner`);
    // 200 * 1.5 = 300
    expect(result.fee).toBe("300");
  });

  it("trims long memo text to byte limit", async () => {
    const fetchMock = jest.fn().mockImplementation((url: string) => {
      if (url.includes("/fee_stats")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ fee_charged: { mode: "100" } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ sequence: "54321" }),
      });
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const longMemo = "very-long-note-".repeat(10);
    const result = await buildPaymentTransaction({
      sourcePublicKey,
      destinationPublicKey,
      amount: "0.5",
      memoText: longMemo,
    });

    const memoBytes = new TextEncoder().encode(result.memo).length;
    expect(result.memo.startsWith(`${MEMO_PREFIX}|`)).toBe(true);
    expect(memoBytes).toBeLessThanOrEqual(MEMO_MAX_BYTES);
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
      }),
    ).rejects.toThrow("Failed to load account from Horizon");
  });
});
