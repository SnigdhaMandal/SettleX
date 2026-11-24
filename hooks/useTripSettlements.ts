"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import { fetchTripSettlements } from "@/lib/settlement/tripSettlements";
import type { TripSettlement } from "@/types/trip";

const POLL_INTERVAL_MS = 15_000;

export interface UseTripSettlementsResult {
  settlements: TripSettlement[];
  /** Adds a settlement this client just recorded, without waiting for a poll. */
  addSettlement: (settlement: TripSettlement) => void;
  refresh: () => Promise<void>;
}

/** Merges by tx hash (one transfer is one settlement); keeps oldest first. */
export function mergeSettlements(
  current: TripSettlement[],
  incoming: TripSettlement[],
): TripSettlement[] {
  const byHash = new Map<string, TripSettlement>();
  for (const s of current) byHash.set(s.txHash.toLowerCase(), s);
  for (const s of incoming) byHash.set(s.txHash.toLowerCase(), s);
  return Array.from(byHash.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Settle-up transfers of one trip (Issue #203). Polls while the page is
 * visible, so every member sees the balances change after anyone settles.
 */
export function useTripSettlements(tripId: string | undefined): UseTripSettlementsResult {
  const { publicKey } = useWallet();
  const [settlements, setSettlements] = useState<TripSettlement[]>([]);
  const tripIdRef = useRef(tripId);
  tripIdRef.current = tripId;

  const refresh = useCallback(async () => {
    if (!tripId || !publicKey) return;
    const rows = await fetchTripSettlements(publicKey, tripId);
    if (tripIdRef.current !== tripId) return;
    setSettlements((prev) => mergeSettlements(prev, rows));
  }, [tripId, publicKey]);

  const addSettlement = useCallback((settlement: TripSettlement) => {
    if (settlement.tripId !== tripIdRef.current) return;
    setSettlements((prev) => mergeSettlements(prev, [settlement]));
  }, []);

  useEffect(() => {
    setSettlements([]);
    if (!tripId || !publicKey) return;

    void refresh();
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void refresh();
      }
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tripId, publicKey, refresh]);

  return { settlements, addSettlement, refresh };
}
