"use client";

import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { getWalletScopedKey } from "@/lib/utils/constants";
import {
  getAuthenticatedClient,
  hasProvenSession,
  onSessionChange,
  requireAuthenticatedClient,
} from "@/lib/supabase/session";
import { logWarn, reportError } from "@/lib/observability/logger";
import { supabaseErrorFields } from "@/lib/observability/supabaseError";
import { useWalletContext } from "./WalletContext";

type CollectionTable = "expenses" | "trips";

type CollectionOptions<T> = {
  table: CollectionTable;
  storageKey: string;
  parseRow: (row: unknown) => T;
  isCachedForWallet: (item: T, walletAddress: string | null) => boolean;
  logNamespace: "expense" | "trip";
};

function hasProvenOwnership(walletAddress: string | null): boolean {
  if (!walletAddress) return false;
  try {
    return hasProvenSession(walletAddress);
  } catch {
    return false;
  }
}

function rowBelongsToWallet(row: unknown, walletAddress: string): boolean {
  if (!row || typeof row !== "object") return false;
  const candidate = row as {
    created_by_wallet?: unknown;
    member_wallets?: unknown;
    accepted_wallets?: unknown;
  };
  return candidate.created_by_wallet === walletAddress ||
    (Array.isArray(candidate.member_wallets) &&
      candidate.member_wallets.includes(walletAddress) &&
      Array.isArray(candidate.accepted_wallets) &&
      candidate.accepted_wallets.includes(walletAddress));
}

/**
 * Shared authenticated collection lifecycle for wallet-owned data.
 *
 * This keeps cache access, session rebinds, initial loading, and refresh
 * polling consistent between expenses and trips. Cache persistence deliberately
 * lives in an effect so React state updaters remain pure under Strict Mode.
 */
export function useWalletScopedCollection<T>({
  table,
  storageKey,
  parseRow,
  isCachedForWallet,
  logNamespace,
}: CollectionOptions<T>) {
  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [client, setClient] = useState<SupabaseClient<Database> | null>(null);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const [consentGeneration, setConsentGeneration] = useState(0);
  const { publicKey, reconcile } = useWalletContext();
  const cacheKey = publicKey ? getWalletScopedKey(storageKey, publicKey) : null;

  const getClient = useCallback(async () => {
    if (!publicKey) throw new Error("Wallet not connected");
    await reconcile();
    return requireAuthenticatedClient(publicKey);
  }, [publicKey, reconcile]);

  useEffect(() => onSessionChange(() => setSessionGeneration((value) => value + 1)), []);

  useEffect(() => {
    const refresh = () => setConsentGeneration((value) => value + 1);
    window.addEventListener("settlex:consent-changed", refresh);
    return () => window.removeEventListener("settlex:consent-changed", refresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!publicKey) {
      setClient(null);
      return;
    }
    getAuthenticatedClient(publicKey, { interactive: false })
      .then((resolved) => {
        if (!cancelled) setClient(resolved);
      })
      .catch((error) => {
        if (cancelled) return;
        logWarn(`${logNamespace}.signin_failed_using_cache`, {
          fields: { ...supabaseErrorFields(error), error: error instanceof Error ? error.message : String(error) },
        });
        setClient(null);
      });
    return () => {
      cancelled = true;
    };
  }, [logNamespace, publicKey, sessionGeneration]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);

    const load = async () => {
      if (!publicKey || !cacheKey) {
        if (active) setItems([]);
        return;
      }
      if (!client) {
        if (hasProvenOwnership(publicKey)) {
          try {
            const raw = localStorage.getItem(cacheKey);
            if (raw && active) {
              const cached = JSON.parse(raw) as T[];
              setItems(cached.filter((item) => isCachedForWallet(item, publicKey)));
            }
          } catch {
            // An unavailable or malformed local cache is never fatal.
          }
        } else if (active) {
          setItems([]);
        }
        return;
      }

      try {
        const { data, error } = await client.from(table).select("*").order("created_at", { ascending: false });
        if (error) throw error;
        if (active && data) setItems(data.filter((row) => rowBelongsToWallet(row, publicKey)).map(parseRow));
      } catch (error) {
        logWarn(`${logNamespace}.load_failed_using_cache`, { fields: supabaseErrorFields(error) });
        try {
          const raw = localStorage.getItem(cacheKey);
          if (raw && active) {
            const cached = JSON.parse(raw) as T[];
            setItems(cached.filter((item) => isCachedForWallet(item, publicKey)));
          }
        } catch {
          // An unavailable or malformed local cache is never fatal.
        }
      }
    };

    void load().finally(() => {
      if (active) setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [cacheKey, client, consentGeneration, isCachedForWallet, logNamespace, parseRow, publicKey, table]);

  useEffect(() => {
    if (!cacheKey || isLoading || !hasProvenOwnership(publicKey)) return;
    try {
      localStorage.setItem(cacheKey, JSON.stringify(items));
    } catch {
      // Storage can be unavailable (private browsing, quota, or policy).
    }
  }, [cacheKey, isLoading, items, publicKey]);

  useEffect(() => {
    if (!client || !publicKey) return;
    let stopped = false;
    let inFlight = false;
    let failureReported = false;
    const refresh = async () => {
      if (stopped || inFlight || document.visibilityState !== "visible" || !hasProvenSession(publicKey)) return;
      inFlight = true;
      try {
        const { data, error } = await client.from(table).select("*").order("created_at", { ascending: false });
        if (error) throw error;
        if (!stopped && data) {
          setItems(data.filter((row) => rowBelongsToWallet(row, publicKey)).map(parseRow));
          failureReported = false;
        }
      } catch (error) {
        if (!stopped && !failureReported) {
          reportError(`${logNamespace}.poll_failed`, error, { fields: supabaseErrorFields(error) });
          failureReported = true;
        }
      } finally {
        inFlight = false;
      }
    };
    const interval = setInterval(() => void refresh(), 5000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [client, logNamespace, parseRow, publicKey, table]);

  return { items, setItems, isLoading, publicKey, getClient };
}
