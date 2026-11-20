"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchContractEvents, fetchTripPaymentHistory } from "@/lib/stellar/events";
import { sorobanServer } from "@/lib/stellar/soroban";
import type { ContractPaymentEvent } from "@/types/contract";
import { CONTRACT_ID } from "@/lib/utils/constants";
import { userFacingMessage } from "@/lib/errors/userMessage";

const POLL_INTERVAL_MS = 10_000;

interface UseContractEventsResult {
  events: ContractPaymentEvent[];
  latestLedger: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useContractEvents(tripId: string | undefined): UseContractEventsResult {
  const [events, setEvents]             = useState<ContractPaymentEvent[]>([]);
  const [latestLedger, setLatestLedger] = useState(0);
  const [isLoading, setIsLoading]       = useState(false);
  const [error, setError]               = useState<string | null>(null);

  const ledgerRef = useRef(0);
  ledgerRef.current = latestLedger;

  const currentTripIdRef = useRef(tripId);
  currentTripIdRef.current = tripId;

  const pollEvents = useCallback(async () => {
    if (!tripId || !CONTRACT_ID) return;

    try {
      const result = await fetchContractEvents(ledgerRef.current, tripId);
      if (currentTripIdRef.current !== tripId) return;

      if (result.events.length > 0) {
        setEvents((prev) => {
          const known   = new Set(prev.map((e) => e.txHash));
          const newEvts = result.events.filter((e) => !known.has(e.txHash));
          return newEvts.length > 0 ? [...prev, ...newEvts] : prev;
        });
      }

      if (result.latestLedger > ledgerRef.current) {
        setLatestLedger(result.latestLedger);
        ledgerRef.current = result.latestLedger;
      }
      setError(null);
    } catch (err) {
      if (currentTripIdRef.current === tripId) {
        setError(userFacingMessage(err).message);
      }
    }
  }, [tripId]);

  const loadInitialHistory = useCallback(async () => {
    if (!tripId || !CONTRACT_ID) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // 1. Load persistent history from get_payments (filtering voided)
      const historyEvents = await fetchTripPaymentHistory(tripId);
      if (currentTripIdRef.current !== tripId) return;

      // 2. Query current latest ledger sequence to start polling from
      let currentLedger = 0;
      try {
        const latest = await sorobanServer.getLatestLedger();
        currentLedger = typeof latest?.sequence === "number" ? latest.sequence : 0;
      } catch {
        currentLedger = 0;
      }

      if (currentTripIdRef.current !== tripId) return;

      setEvents(historyEvents);
      if (currentLedger > 0) {
        setLatestLedger(currentLedger);
        ledgerRef.current = currentLedger;
      }
      setError(null);
    } catch (err) {
      if (currentTripIdRef.current === tripId) {
        setError(userFacingMessage(err).message);
      }
    } finally {
      if (currentTripIdRef.current === tripId) {
        setIsLoading(false);
      }
    }
  }, [tripId]);

  useEffect(() => {
    // Reset state immediately on tripId change
    setEvents([]);
    setLatestLedger(0);
    ledgerRef.current = 0;
    setError(null);

    if (!tripId || !CONTRACT_ID) {
      setIsLoading(false);
      return;
    }

    let isCancelled = false;

    loadInitialHistory();

    const interval = setInterval(() => {
      if (!isCancelled) pollEvents();
    }, POLL_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible" && !isCancelled) {
        pollEvents();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      isCancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tripId, loadInitialHistory, pollEvents]);

  const refresh = useCallback(async () => {
    if (ledgerRef.current === 0) {
      await loadInitialHistory();
    } else {
      await pollEvents();
    }
  }, [loadInitialHistory, pollEvents]);

  return { events, latestLedger, isLoading, error, refresh };
}
