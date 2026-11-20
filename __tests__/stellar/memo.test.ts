/**
 * Issue #207: every payment memo identifies the share or settlement it pays,
 * and the app can go from a transaction hash back to that share/settlement.
 */
import {
  isPaymentMemo,
  lookupPaymentByTxHash,
  parsePaymentMemo,
  resolvePaymentTarget,
  settlementMemo,
  shareMemo,
} from "@/lib/stellar/memo";
import { MEMO_MAX_BYTES } from "@/lib/utils/constants";
import type { Expense } from "@/types/expense";

const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const CAROL = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const TX = "d".repeat(64);

function expense(id: string, overrides: Partial<Expense> = {}): Expense {
  return {
    id,
    title: "Dinner",
    totalAmount: "30",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "m1",
    members: [
      { id: "m1", name: "Alice", walletAddress: ALICE },
      { id: "m2", name: "Bob", walletAddress: BOB },
      { id: "m3", name: "Carol", walletAddress: CAROL },
    ],
    shares: [
      { memberId: "m1", name: "Alice", amount: "10", paid: false, walletAddress: ALICE },
      { memberId: "m2", name: "Bob", amount: "10", paid: false, walletAddress: BOB },
      { memberId: "m3", name: "Carol", amount: "10", paid: false, walletAddress: CAROL },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    settled: false,
    ...overrides,
  } as Expense;
}

describe("payment memo format", () => {
  it("matches independently computed vectors (sha256 + RFC 4648 base32)", () => {
    // Computed outside this codebase with Python's hashlib + base64.b32encode.
    expect(shareMemo("exp-1", "m2")).toBe("SX1S:IYSQJ54ZOZFR6QU6KNX5DFK");
    expect(shareMemo("dinner", "aman")).toBe("SX1S:3K7EKTE3UQP44CE5TWSJM6L");
    expect(settlementMemo("trip-1", "GAAA", "GBBB")).toBe("SX1N:77ZXWNY32PFTKAUN5NOBHU6");
  });

  it("fits MEMO_TEXT exactly and contains no titles or names", () => {
    const memo = shareMemo("6f1c1c4e-1111-4b2b-9c1d-0123456789ab", "member-with-a-long-id");
    expect(new TextEncoder().encode(memo).length).toBe(MEMO_MAX_BYTES);
    expect(memo).toMatch(/^SX1S:[A-Z2-7]{23}$/);
  });

  it("is stable and distinct per share and per settlement direction", () => {
    expect(shareMemo("e", "m")).toBe(shareMemo("e", "m"));
    expect(shareMemo("e", "m1")).not.toBe(shareMemo("e", "m2"));
    expect(shareMemo("e1", "m")).not.toBe(shareMemo("e2", "m"));
    expect(settlementMemo("t", ALICE, BOB)).not.toBe(settlementMemo("t", BOB, ALICE));
    // Wallet case does not change the identifier.
    expect(settlementMemo("t", ALICE.toLowerCase(), BOB)).toBe(settlementMemo("t", ALICE, BOB));
  });

  it("never produces the old double-prefixed settle-up memo", () => {
    expect(settlementMemo("trip-1", ALICE, BOB)).not.toMatch(/SettleX/);
  });

  it("refuses to build a memo without ids", () => {
    expect(() => shareMemo("", "m1")).toThrow();
    expect(() => settlementMemo("t", "", BOB)).toThrow();
  });

  it("parses only SettleX memos", () => {
    expect(parsePaymentMemo(shareMemo("e", "m"))?.kind).toBe("share");
    expect(parsePaymentMemo(settlementMemo("t", ALICE, BOB))?.kind).toBe("settlement");
    expect(parsePaymentMemo("SettleX|Dinner|Aman")).toBeNull();
    expect(parsePaymentMemo("SX1S:tooshort")).toBeNull();
    expect(isPaymentMemo(undefined)).toBe(false);
  });
});

describe("resolving a payment to what it pays", () => {
  const expenses = [expense("exp-1"), expense("exp-2")];
  const trips = [{ id: "trip-1", expenseIds: ["exp-1", "exp-2"] }];

  it("finds the share from a share memo", () => {
    expect(resolvePaymentTarget({ memo: shareMemo("exp-2", "m3") }, { expenses })).toEqual({
      kind: "share",
      expenseId: "exp-2",
      memberId: "m3",
      matchedBy: "memo",
    });
  });

  it("finds the settlement, and the shares recorded against it, from a settlement memo", () => {
    const settled = [
      expense("exp-1", {
        shares: expense("exp-1").shares.map((s) => (s.memberId === "m2" ? { ...s, paid: true, txHash: TX } : s)),
      }),
      expense("exp-2"),
    ];

    expect(
      resolvePaymentTarget({ memo: settlementMemo("trip-1", BOB, ALICE), txHash: TX }, { expenses: settled, trips }),
    ).toEqual({
      kind: "settlement",
      tripId: "trip-1",
      fromWallet: BOB,
      toWallet: ALICE,
      shares: [{ expenseId: "exp-1", memberId: "m2" }],
      matchedBy: "memo",
    });
  });

  it("falls back to the recorded txHash for legacy memos", () => {
    const legacy = [
      expense("exp-1", {
        shares: expense("exp-1").shares.map((s) => (s.memberId === "m3" ? { ...s, paid: true, txHash: TX } : s)),
      }),
    ];
    expect(resolvePaymentTarget({ memo: "SettleX|Dinner|Carol", txHash: TX }, { expenses: legacy })).toEqual({
      kind: "share",
      expenseId: "exp-1",
      memberId: "m3",
      matchedBy: "record",
    });
  });

  it("returns null for a memo the caller has no matching share for", () => {
    expect(resolvePaymentTarget({ memo: shareMemo("other", "m1") }, { expenses })).toBeNull();
  });

  describe("given only a transaction hash", () => {
    afterEach(() => {
      delete (global as { fetch?: unknown }).fetch;
    });

    it("reads the memo from Horizon and returns the share it pays", async () => {
      const fetchMock = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ memo_type: "text", memo: shareMemo("exp-1", "m2") }),
      }));
      (global as unknown as { fetch: unknown }).fetch = fetchMock;

      await expect(lookupPaymentByTxHash(TX, { expenses, trips })).resolves.toEqual({
        kind: "share",
        expenseId: "exp-1",
        memberId: "m2",
        matchedBy: "memo",
      });
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/transactions/${TX}`), expect.anything());
    });

    it("reads a settlement memo from Horizon and returns the settlement", async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ memo_type: "text", memo: settlementMemo("trip-1", CAROL, ALICE) }),
      }));

      await expect(lookupPaymentByTxHash(TX, { expenses, trips })).resolves.toMatchObject({
        kind: "settlement",
        tripId: "trip-1",
        fromWallet: CAROL,
        toWallet: ALICE,
      });
    });

    it("returns null when Horizon does not know the transaction and nothing recorded it", async () => {
      (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      }));

      await expect(lookupPaymentByTxHash(TX, { expenses, trips })).resolves.toBeNull();
    });

    it("rejects malformed hashes without a network call", async () => {
      const fetchMock = jest.fn();
      (global as unknown as { fetch: unknown }).fetch = fetchMock;

      await expect(lookupPaymentByTxHash("not-a-hash", { expenses })).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
