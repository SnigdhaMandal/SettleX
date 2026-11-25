/**
 * Settle-up transfers recorded as their own rows (Issue #203).
 *
 * A net settle-up payment is stored in `trip_settlements` via the
 * `record_trip_settlement` RPC and subtracted from member balances; it never
 * marks gross shares paid. Direct share payments still go through
 * `mark_share_paid`.
 *
 * Between submitting the Stellar transfer and recording the row, the transfer
 * is kept in localStorage as a pending settlement, so a failed write or a
 * reload cannot lead the debtor to pay again.
 */

import { getAuthenticatedClient, requireAuthenticatedClient } from "@/lib/supabase/session";
import { logWarn } from "@/lib/observability/logger";
import { supabaseErrorFields } from "@/lib/observability/supabaseError";
import type { Database } from "@/types/supabase";
import type { TripSettlement } from "@/types/trip";

type SettlementRow = Database["public"]["Tables"]["trip_settlements"]["Row"];

export function rowToSettlement(row: SettlementRow): TripSettlement {
  return {
    id: row.id,
    tripId: row.trip_id,
    fromMemberId: row.from_member_id,
    toMemberId: row.to_member_id,
    fromWallet: row.from_wallet,
    toWallet: row.to_wallet,
    amount: row.amount,
    txHash: row.tx_hash,
    createdAt: row.created_at,
  };
}

/**
 * Contract `expense_id` for the on-chain receipt of one settlement. The
 * contract keys records by (expense_id, member), so each settlement gets its
 * own deterministic id derived from the transfer hash (60 chars, under the
 * contract's 64-char limit).
 */
export function settlementContractExpenseId(txHash: string): string {
  return `stl-${txHash.toLowerCase().slice(0, 56)}`;
}

/** True for the RPC's "this transfer is already recorded" rejection. */
export function isSettlementAlreadyRecorded(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? "";
  return /settlement already recorded/i.test(message);
}

/** All settlements of a trip, oldest first. Never throws; [] on failure. */
export async function fetchTripSettlements(
  walletAddress: string,
  tripId: string,
): Promise<TripSettlement[]> {
  let client;
  try {
    client = await getAuthenticatedClient(walletAddress, { interactive: false });
  } catch {
    return [];
  }
  if (!client) return [];
  try {
    const { data, error } = await client
      .from("trip_settlements")
      .select("*")
      .eq("trip_id", tripId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => rowToSettlement(row as SettlementRow));
  } catch (err) {
    logWarn("settlement.fetch_failed", {
      fields: { tripId, ...supabaseErrorFields(err) },
    });
    return [];
  }
}

export interface RecordTripSettlementParams {
  tripId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: string;
  txHash: string;
}

/** Records one settle-up transfer. Throws on rejection. */
export async function recordTripSettlement(
  walletAddress: string,
  params: RecordTripSettlementParams,
): Promise<TripSettlement> {
  const client = await requireAuthenticatedClient(walletAddress);
  const { data, error } = await client.rpc("record_trip_settlement", {
    p_trip_id: params.tripId,
    p_from_member_id: params.fromMemberId,
    p_to_member_id: params.toMemberId,
    p_amount: params.amount,
    p_tx_hash: params.txHash.toLowerCase(),
  });
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error("The settlement could not be recorded. Please try again.");
  }
  return rowToSettlement(data[0]);
}

// Pending settlements cached in localStorage

export const LS_PENDING_SETTLEMENTS = "settlex:pendingSettlements";

export interface PendingSettlement extends RecordTripSettlementParams {
  /** The debtor's wallet, which signed the transfer. */
  fromWallet: string;
  toWallet: string;
  status: "signed" | "submitted";
  ledger: number | null;
  createdAt: string;
}

function storageKey(walletAddress: string) {
  return `${LS_PENDING_SETTLEMENTS}:${walletAddress}`;
}

export function pendingSettlementKey(tripId: string, fromMemberId: string, toMemberId: string): string {
  return `${tripId}:${fromMemberId}:${toMemberId}`;
}

function readStore(walletAddress: string): Record<string, PendingSettlement> {
  if (typeof window === "undefined" || !walletAddress) return {};
  try {
    const raw = window.localStorage.getItem(storageKey(walletAddress));
    const parsed = raw ? (JSON.parse(raw) as Record<string, PendingSettlement>) : {};
    const out: Record<string, PendingSettlement> = {};
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (
        value &&
        typeof value.txHash === "string" &&
        typeof value.tripId === "string" &&
        value.fromWallet === walletAddress
      ) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(walletAddress: string, store: Record<string, PendingSettlement>) {
  if (typeof window === "undefined" || !walletAddress) return;
  try {
    if (Object.keys(store).length === 0) {
      window.localStorage.removeItem(storageKey(walletAddress));
    } else {
      window.localStorage.setItem(storageKey(walletAddress), JSON.stringify(store));
    }
  } catch {
    // ignore storage errors (private mode, quota)
  }
}

export function savePendingSettlement(entry: PendingSettlement): void {
  const store = readStore(entry.fromWallet);
  store[pendingSettlementKey(entry.tripId, entry.fromMemberId, entry.toMemberId)] = entry;
  writeStore(entry.fromWallet, store);
}

export function getPendingSettlement(
  walletAddress: string,
  tripId: string,
  fromMemberId: string,
  toMemberId: string,
): PendingSettlement | null {
  return readStore(walletAddress)[pendingSettlementKey(tripId, fromMemberId, toMemberId)] ?? null;
}

/** Removes the entry, only if it still refers to `txHash`. */
export function removePendingSettlement(
  walletAddress: string,
  tripId: string,
  fromMemberId: string,
  toMemberId: string,
  txHash: string,
): void {
  const store = readStore(walletAddress);
  const key = pendingSettlementKey(tripId, fromMemberId, toMemberId);
  if (store[key]?.txHash !== txHash) return;
  delete store[key];
  writeStore(walletAddress, store);
}
