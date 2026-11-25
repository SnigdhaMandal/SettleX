/**
 * Tracks share payments whose XLM transfer may have gone through before the DB
 * marked the share paid, preventing accidental double-payments.
 *
 * Entries move from "signed" (pre-submit, hash already known) -> "submitted"
 * (accepted by Horizon) -> removed once marked paid or confirmed dead.
 * Stored synchronously in localStorage and mirrored best-effort to `pending_payments`.
 */

import { HORIZON_URL } from "@/lib/utils/constants";
import { getAuthenticatedClient } from "@/lib/supabase/session";
import { logWarn } from "@/lib/observability/logger";
import { supabaseErrorFields } from "@/lib/observability/supabaseError";
import type { Database } from "@/types/supabase";

export const LS_PENDING_PAYMENTS = "settlex:pendingPayments";

const EXPIRY_GRACE_MS = 60_000; // wait past tx max time before declaring it dead
const UNBOUNDED_EXPIRY_MS = 15 * 60_000; // fallback lifetime when tx has no time bounds
const REMOTE_TIMEOUT_MS = 4_000; // never let remote mirror calls stall a payment

export type PendingPaymentStatus = "signed" | "submitted";

export interface PendingPayment {
  expenseId: string;
  memberId: string;
  txHash: string;
  /** Share owner (debtor) who sent the transfer. */
  payerWallet: string;
  /** Member who paid the bill (creditor). */
  destinationWallet: string;
  amount: string;
  tripId: string | null;
  status: PendingPaymentStatus;
  ledger: number | null;
  validUntil: string | null;
  /** Set once the Soroban contract call succeeds (trip expenses only). */
  onChainRecorded: boolean;
  createdAt: string;
}

type PendingRow = Database["public"]["Tables"]["pending_payments"]["Row"];

// localStorage store

function storageKey(walletAddress: string) {
  return `${LS_PENDING_PAYMENTS}:${walletAddress}`;
}

function entryKey(expenseId: string, memberId: string) {
  return `${expenseId}:${memberId}`;
}

function isPendingPayment(value: unknown): value is PendingPayment {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.expenseId === "string" &&
    typeof v.memberId === "string" &&
    typeof v.txHash === "string" &&
    typeof v.payerWallet === "string" &&
    (v.status === "signed" || v.status === "submitted")
  );
}

function readStore(walletAddress: string): Record<string, PendingPayment> {
  if (typeof window === "undefined" || !walletAddress) return {};
  try {
    const raw = window.localStorage.getItem(storageKey(walletAddress));
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, PendingPayment> = {};
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (isPendingPayment(value) && value.payerWallet === walletAddress) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(walletAddress: string, store: Record<string, PendingPayment>): void {
  if (typeof window === "undefined" || !walletAddress) return;
  try {
    if (Object.keys(store).length === 0) {
      window.localStorage.removeItem(storageKey(walletAddress));
    } else {
      window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(store));
    }
  } catch {
    // Private mode / quota exceeded; fall back to the DB mirror
  }
}

export function listPendingPayments(walletAddress: string, expenseId?: string): PendingPayment[] {
  const all = Object.values(readStore(walletAddress));
  return expenseId ? all.filter((p) => p.expenseId === expenseId) : all;
}

export function getPendingPayment(
  walletAddress: string,
  expenseId: string,
  memberId: string,
): PendingPayment | null {
  return readStore(walletAddress)[entryKey(expenseId, memberId)] ?? null;
}

export function savePendingPaymentLocal(entry: PendingPayment): void {
  const store = readStore(entry.payerWallet);
  store[entryKey(entry.expenseId, entry.memberId)] = entry;
  writeStore(entry.payerWallet, store);
}

/**
 * Removes an entry. If `txHash` is passed, only removes if it matches so a
 * stale reconcile won't wipe out a newer attempt.
 */
export function removePendingPaymentLocal(
  walletAddress: string,
  expenseId: string,
  memberId: string,
  txHash?: string,
): void {
  const store = readStore(walletAddress);
  const key = entryKey(expenseId, memberId);
  const existing = store[key];
  if (!existing) return;
  if (txHash && existing.txHash !== txHash) return;

  delete store[key];
  writeStore(walletAddress, store);
}

// Best-effort database mirror

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function remoteClient(walletAddress: string) {
  try {
    return await withTimeout(
      getAuthenticatedClient(walletAddress, { interactive: false }),
      REMOTE_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
}

function rowToEntry(row: PendingRow): PendingPayment {
  return {
    expenseId: row.expense_id,
    memberId: row.member_id,
    txHash: row.tx_hash,
    payerWallet: row.payer_wallet,
    destinationWallet: row.destination_wallet,
    amount: row.amount,
    tripId: row.trip_id,
    status: row.status,
    ledger: row.ledger,
    validUntil: row.valid_until,
    onChainRecorded: false,
    createdAt: row.created_at,
  };
}

/** Upserts the entry's row. Never throws; returns whether it succeeded. */
export async function syncPendingPaymentRemote(entry: PendingPayment): Promise<boolean> {
  const client = await remoteClient(entry.payerWallet);
  if (!client) return false;
  try {
    const { error } = await withTimeout(
      Promise.resolve(
        client.from("pending_payments").upsert(
          {
            expense_id: entry.expenseId,
            member_id: entry.memberId,
            tx_hash: entry.txHash,
            payer_wallet: entry.payerWallet,
            destination_wallet: entry.destinationWallet,
            amount: entry.amount,
            trip_id: entry.tripId,
            status: entry.status,
            ledger: entry.ledger,
            valid_until: entry.validUntil,
          },
          { onConflict: "expense_id,member_id" },
        ),
      ),
      REMOTE_TIMEOUT_MS,
    );
    if (error) throw error;
    return true;
  } catch (err) {
    logWarn("payment.pending_sync_failed", {
      fields: { expenseId: entry.expenseId, ...supabaseErrorFields(err) },
    });
    return false;
  }
}

/** Deletes the entry's row if it still points to `txHash`. Never throws. */
export async function deletePendingPaymentRemote(
  walletAddress: string,
  expenseId: string,
  memberId: string,
  txHash: string,
): Promise<void> {
  const client = await remoteClient(walletAddress);
  if (!client) return;
  try {
    const { error } = await withTimeout(
      Promise.resolve(
        client
          .from("pending_payments")
          .delete()
          .eq("expense_id", expenseId)
          .eq("member_id", memberId)
          .eq("tx_hash", txHash),
      ),
      REMOTE_TIMEOUT_MS,
    );
    if (error) throw error;
  } catch (err) {
    logWarn("payment.pending_delete_failed", {
      fields: { expenseId, ...supabaseErrorFields(err) },
    });
  }
}

/** Fetches pending rows for this wallet and expense from the DB. Never throws. */
export async function fetchPendingPaymentsRemote(
  walletAddress: string,
  expenseId: string,
): Promise<PendingPayment[]> {
  const client = await remoteClient(walletAddress);
  if (!client) return [];
  try {
    const { data, error } = await withTimeout(
      Promise.resolve(
        client
          .from("pending_payments")
          .select("*")
          .eq("expense_id", expenseId)
          .eq("payer_wallet", walletAddress),
      ),
      REMOTE_TIMEOUT_MS,
    );
    if (error) throw error;
    return (data ?? []).map((row) => rowToEntry(row as PendingRow));
  } catch (err) {
    logWarn("payment.pending_fetch_failed", {
      fields: { expenseId, ...supabaseErrorFields(err) },
    });
    return [];
  }
}

// Horizon reconciliation

export type HorizonTxStatus =
  | { state: "confirmed"; ledger: number }
  | { state: "failed" }
  | { state: "not_found" }
  | { state: "unknown" };

export async function checkTransactionOnHorizon(txHash: string): Promise<HorizonTxStatus> {
  try {
    const res = await fetch(`${HORIZON_URL}/transactions/${txHash.toLowerCase()}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (res.status === 404) return { state: "not_found" };
    if (!res.ok) return { state: "unknown" };

    const tx = (await res.json()) as { successful?: boolean; ledger?: number; ledger_attr?: number };
    if (tx.successful === false) return { state: "failed" };
    return { state: "confirmed", ledger: Number(tx.ledger_attr ?? tx.ledger ?? 0) };
  } catch {
    return { state: "unknown" };
  }
}

/**
 * True once a transaction missing from Horizon can no longer make it into a
 * ledger, so its pending entry can safely be dropped.
 */
export function isPastValidity(entry: PendingPayment, now = Date.now()): boolean {
  const deadline = entry.validUntil
    ? Date.parse(entry.validUntil)
    : Date.parse(entry.createdAt) + UNBOUNDED_EXPIRY_MS;
  if (!Number.isFinite(deadline)) return false;
  return now > deadline + EXPIRY_GRACE_MS;
}

/** Merges remote DB rows with local entries; local wins since it's fresher. */
export function mergePendingPayments(
  local: PendingPayment[],
  remote: PendingPayment[],
): PendingPayment[] {
  const byKey = new Map<string, PendingPayment>();
  for (const entry of remote) byKey.set(entryKey(entry.expenseId, entry.memberId), entry);
  for (const entry of local) byKey.set(entryKey(entry.expenseId, entry.memberId), entry);
  return Array.from(byKey.values());
}
