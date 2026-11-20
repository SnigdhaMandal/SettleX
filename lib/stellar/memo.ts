/**
 * Payment memos that identify what a payment pays (Issue #207).
 *
 * Every SettleX payment, whether paid in-app or by scanning the QR code, carries a
 * MEMO_TEXT built here, and nowhere else:
 *
 *   SX1S:<23 base32 chars>   one expense share   sha256("settlex:share:v1:<expenseId>:<memberId>")
 *   SX1N:<23 base32 chars>   one net settlement  sha256("settlex:settle:v1:<tripId>:<FROM>:<TO>")
 *
 * That is exactly 28 bytes, the MEMO_TEXT limit. The digest is a one-way
 * identifier: the memo reveals no titles or names on the public ledger, yet
 * anyone who already knows the expense (every member) can recompute it and
 * match a transaction to its share, which is what verification (SX-028,
 * SX-045) needs. 115 bits of digest makes accidental collisions irrelevant.
 *
 * MEMO_TEXT (not MEMO_HASH) is used because SEP-0007 wallets handle text memos
 * far more consistently when a payment is made from the QR code.
 */
import { hash } from "@stellar/stellar-sdk";
import { HORIZON_URL, MEMO_MAX_BYTES } from "@/lib/utils/constants";
import type { Expense } from "@/types/expense";

export const MEMO_VERSION = "SX1";
export const SHARE_MEMO_PREFIX = `${MEMO_VERSION}S:`;
export const SETTLEMENT_MEMO_PREFIX = `${MEMO_VERSION}N:`;

const DIGEST_CHARS = MEMO_MAX_BYTES - SHARE_MEMO_PREFIX.length; // 23
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const MEMO_PATTERN = new RegExp(`^${MEMO_VERSION}([SN]):([A-Z2-7]{${DIGEST_CHARS}})$`);

function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

function digest(input: string): string {
  const bytes = hash(Buffer.from(input, "utf8"));
  return base32(new Uint8Array(bytes)).slice(0, DIGEST_CHARS);
}

function requireId(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Cannot build a payment memo without a ${field}.`);
  }
  return value.trim();
}

/** Memo for paying one member's share of one expense. */
export function shareMemo(expenseId: string, memberId: string): string {
  const e = requireId(expenseId, "expense id");
  const m = requireId(memberId, "member id");
  return SHARE_MEMO_PREFIX + digest(`settlex:share:v1:${e}:${m}`);
}

/** Memo for a netted trip settlement from one wallet to another. */
export function settlementMemo(tripId: string, fromWallet: string, toWallet: string): string {
  const t = requireId(tripId, "trip id");
  const from = requireId(fromWallet, "payer wallet").toUpperCase();
  const to = requireId(toWallet, "recipient wallet").toUpperCase();
  return SETTLEMENT_MEMO_PREFIX + digest(`settlex:settle:v1:${t}:${from}:${to}`);
}

export type ParsedMemo = { kind: "share" | "settlement"; memo: string };

/** Recognises a SettleX memo; anything else (including legacy memos) is null. */
export function parsePaymentMemo(memo: string | null | undefined): ParsedMemo | null {
  if (typeof memo !== "string") return null;
  const match = MEMO_PATTERN.exec(memo.trim());
  if (!match) return null;
  return { kind: match[1] === "S" ? "share" : "settlement", memo: match[0] };
}

export function isPaymentMemo(memo: string | null | undefined): boolean {
  return parsePaymentMemo(memo) !== null;
}

// ─── Resolving a transaction to what it pays ─────────────────────────────────

export interface ShareRef {
  expenseId: string;
  memberId: string;
}

export type PaymentTarget =
  | { kind: "share"; expenseId: string; memberId: string; matchedBy: "memo" | "record" }
  | {
      kind: "settlement";
      tripId: string;
      fromWallet: string;
      toWallet: string;
      /** Shares the database recorded against this transaction. */
      shares: ShareRef[];
      matchedBy: "memo";
    };

export interface TripRef {
  id: string;
  expenseIds: string[];
  members?: { walletAddress?: string }[];
}

export interface ResolveContext {
  expenses: Expense[];
  trips?: TripRef[];
}

function sharesRecordedWith(txHash: string | undefined, expenses: Expense[]): ShareRef[] {
  if (!txHash) return [];
  const needle = txHash.toLowerCase();
  const out: ShareRef[] = [];
  for (const expense of expenses) {
    for (const share of expense.shares) {
      if (share.txHash?.toLowerCase() === needle) {
        out.push({ expenseId: expense.id, memberId: share.memberId });
      }
    }
  }
  return out;
}

function tripWallets(trip: TripRef, expenses: Expense[]): string[] {
  const wallets = new Set<string>();
  const add = (w?: string) => { if (w) wallets.add(w.toUpperCase()); };
  trip.members?.forEach((m) => add(m.walletAddress));
  for (const expense of expenses) {
    if (!trip.expenseIds.includes(expense.id)) continue;
    expense.members.forEach((m) => add(m.walletAddress));
    expense.shares.forEach((s) => add(s.walletAddress));
  }
  return Array.from(wallets);
}

/**
 * Finds the share or settlement a payment pays, from its memo and/or hash.
 *
 * The memo is matched by recomputing candidate memos for the expenses and trips
 * the caller can see. When the memo is absent or predates this scheme, a share
 * whose recorded txHash equals the transaction hash is used instead.
 */
export function resolvePaymentTarget(
  { memo, txHash }: { memo?: string | null; txHash?: string },
  { expenses, trips = [] }: ResolveContext,
): PaymentTarget | null {
  const parsed = parsePaymentMemo(memo);

  if (parsed?.kind === "share") {
    for (const expense of expenses) {
      for (const share of expense.shares) {
        if (shareMemo(expense.id, share.memberId) === parsed.memo) {
          return { kind: "share", expenseId: expense.id, memberId: share.memberId, matchedBy: "memo" };
        }
      }
    }
  }

  if (parsed?.kind === "settlement") {
    for (const trip of trips) {
      const wallets = tripWallets(trip, expenses);
      for (const from of wallets) {
        for (const to of wallets) {
          if (from === to) continue;
          if (settlementMemo(trip.id, from, to) === parsed.memo) {
            return {
              kind: "settlement",
              tripId: trip.id,
              fromWallet: from,
              toWallet: to,
              shares: sharesRecordedWith(txHash, expenses),
              matchedBy: "memo",
            };
          }
        }
      }
    }
  }

  const recorded = sharesRecordedWith(txHash, expenses);
  if (recorded.length === 1) {
    return { kind: "share", ...recorded[0], matchedBy: "record" };
  }
  return null;
}

/**
 * Given only a transaction hash, reads its memo from Horizon and resolves what
 * it pays. Returns null when the transaction or its target cannot be found.
 */
export async function lookupPaymentByTxHash(
  txHash: string,
  context: ResolveContext,
): Promise<PaymentTarget | null> {
  if (!/^[0-9a-fA-F]{64}$/.test(txHash)) return null;
  let memo: string | null = null;
  try {
    const res = await fetch(`${HORIZON_URL}/transactions/${txHash.toLowerCase()}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const tx = (await res.json()) as { memo?: string; memo_type?: string };
      if (tx.memo_type === "text" && typeof tx.memo === "string") memo = tx.memo;
    }
  } catch {
    // Fall through to the recorded-hash match below.
  }
  return resolvePaymentTarget({ memo, txHash }, context);
}
