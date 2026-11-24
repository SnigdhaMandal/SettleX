"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { Trip } from "@/types/trip";
import { getWalletScopedKey, LS_TRIPS } from "@/lib/utils/constants";
import {
  getAuthenticatedClient,
  hasProvenSession,
  onSessionChange,
  requireAuthenticatedClient,
} from "@/lib/supabase/session";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/supabase";
import { useWalletContext } from "./WalletContext";
import { parseTripRow } from "@/lib/supabase/rowGuards";
import { logWarn, reportError } from "@/lib/observability/logger";
import { supabaseErrorFields } from "@/lib/observability/supabaseError";


/**
 * True only after the server has confirmed an active session for this wallet.
 *
 * The offline cache is readable by anyone at this keyboard, so possession of an
 * address alone must not unlock it: otherwise a wallet that connects and never
 * signs (or declines to) would be shown the rows of whichever account cached
 * them. The cookie itself is never read by browser code; the server verifies it
 * before this in-memory marker is set.
 */
function hasProvenOwnership(walletAddress: string | null): boolean {
  if (!walletAddress) return false;
  try {
    return hasProvenSession(walletAddress);
  } catch {
    return false;
  }
}


interface TripContextType {
  trips: Trip[];
  addTrip: (trip: Trip) => Promise<void>;
  updateTrip: (id: string, updates: Partial<Trip>) => Promise<void>;
  deleteTrip: (id: string) => Promise<void>;
  addExpenseToTrip: (tripId: string, expenseId: string) => Promise<void>;
  settleTrip: (id: string) => Promise<void>;
  getTrip: (id: string) => Trip | undefined;
  isLoading: boolean;
}


const TripContext = createContext<TripContextType | null>(null);
TripContext.displayName = "TripContext";

function isRowForWallet(
  row: Partial<Database["public"]["Tables"]["trips"]["Row"]> | null | undefined,
  walletAddress: string | null
): boolean {
  if (!walletAddress || !row) return false;
  return (
    row.created_by_wallet === walletAddress ||
    (Array.isArray(row.member_wallets) &&
      row.member_wallets.includes(walletAddress) &&
      Array.isArray(row.accepted_wallets) &&
      row.accepted_wallets.includes(walletAddress))
  );
}

function isCachedTripForWallet(trip: Trip, walletAddress: string | null): boolean {
  if (!walletAddress) return false;
  return (
    trip.createdByWallet === walletAddress ||
    (!!trip.memberWallets?.includes(walletAddress) &&
      !!trip.acceptedWallets?.includes(walletAddress))
  );
}

/**
 * Raised when a write loses to a concurrent one. Local state already holds the
 * winning row, so the caller should reapply its change rather than retry the
 * same stale payload.
 */
export class TripConflictError extends Error {}

function dbRowToTrip(row: unknown): Trip {
  return parseTripRow(row);
}

function tripToDbInsertRow(
  trip: Trip,
  creatorWallet: string
): Database["public"]["Tables"]["trips"]["Insert"] {
  const memberWallets = trip.members
    .map((m) => m.walletAddress)
    .filter((addr): addr is string => !!addr);

  const allMemberWallets = creatorWallet && !memberWallets.includes(creatorWallet)
    ? [creatorWallet, ...memberWallets]
    : memberWallets;

  return {
    id: trip.id,
    name: trip.name,
    description: trip.description ?? null,
    members: trip.members as unknown as Json,
    expense_ids: trip.expenseIds,
    created_at: trip.createdAt,
    settled: trip.settled,
    version: trip.version ?? 1,
    created_by_wallet: creatorWallet,
    member_wallets: allMemberWallets,
    accepted_wallets: [creatorWallet],
    declined_wallets: [],
  };
}


export function TripProvider({ children }: { children: React.ReactNode }) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [client, setClient] = useState<SupabaseClient<Database> | null>(null);
  const { publicKey, reconcile } = useWalletContext();

  // Every call is scoped by a JWT the server issues only after the wallet has
  // signed a challenge, so RLS has a wallet identity it can actually trust.
  const getClient = useCallback(async () => {
    if (!publicKey) throw new Error("Wallet not connected");
    await reconcile();
    return requireAuthenticatedClient(publicKey);
  }, [publicKey, reconcile]);

  // Rebind whenever the session is established or dropped, so a re-signed
  // session never leaves this provider holding a client with a stale token.
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const [consentGeneration, setConsentGeneration] = useState(0);
  useEffect(() => onSessionChange(() => setSessionGeneration((n) => n + 1)), []);
  useEffect(() => {
    const refresh = () => setConsentGeneration((n) => n + 1);
    window.addEventListener("settlex:consent-changed", refresh);
    return () => window.removeEventListener("settlex:consent-changed", refresh);
  }, []);

  // Listen for atomic expense creations in trips
  useEffect(() => {
    const handleExpenseCreated = (e: Event) => {
      const customEvent = e as CustomEvent<{ tripId: string; expenseId: string }>;
      const { tripId, expenseId } = customEvent.detail || {};
      if (tripId && expenseId) {
        setTrips((prev) => {
          const updated = prev.map((t) => {
            if (t.id !== tripId) return t;
            if (t.expenseIds.includes(expenseId)) return t;
            return { ...t, expenseIds: [...t.expenseIds, expenseId] };
          });
          const cacheKey = publicKey ? getWalletScopedKey(LS_TRIPS, publicKey) : LS_TRIPS;
          localStorage.setItem(cacheKey, JSON.stringify(updated));
          return updated;
        });
      }
    };

    const handleExpenseDeleted = (e: Event) => {
      const customEvent = e as CustomEvent<{ expenseId: string }>;
      const expenseId = customEvent.detail?.expenseId;
      if (expenseId) {
        setTrips((prev) => {
          const updated = prev.map((t) => {
            if (!t.expenseIds.includes(expenseId)) return t;
            return {
              ...t,
              expenseIds: t.expenseIds.filter((id) => id !== expenseId),
            };
          });
          const cacheKey = publicKey ? getWalletScopedKey(LS_TRIPS, publicKey) : LS_TRIPS;
          localStorage.setItem(cacheKey, JSON.stringify(updated));
          return updated;
        });
      }
    };

    window.addEventListener("settlex:trip-expense-created", handleExpenseCreated);
    window.addEventListener("settlex:expense-deleted", handleExpenseDeleted);
    return () => {
      window.removeEventListener("settlex:trip-expense-created", handleExpenseCreated);
      window.removeEventListener("settlex:expense-deleted", handleExpenseDeleted);
    };
  }, [publicKey]);

  // Resolve the authenticated client once per wallet so the initial load and
  // periodic refresh share it. Concurrent callers reuse a single handshake,
  // so the wallet is only ever asked to sign once.
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
      .catch((err) => {
        if (cancelled) return;
        logWarn("trip.signin_failed_using_cache", {
          fields: { ...supabaseErrorFields(err), error: err instanceof Error ? err.message : String(err) },
        });
        setClient(null);
      });

    return () => {
      cancelled = true;
    };
  }, [publicKey, sessionGeneration]);

  useEffect(() => {
    let isMounted = true;

    const cacheKey = publicKey ? getWalletScopedKey(LS_TRIPS, publicKey) : LS_TRIPS;

    async function loadTrips() {
      // Without a proven wallet identity RLS returns nothing, so fall back to
      // whatever this browser cached rather than showing an empty list.
      if (!client) {
        // No proven ownership means no cached rows — not even this wallet's own
        // key, which a previous holder of this browser may have populated.
        if (!hasProvenOwnership(publicKey)) {
          if (isMounted) {
            setTrips([]);
            setIsLoading(false);
          }
          return;
        }
        try {
          const raw = localStorage.getItem(cacheKey);
          if (raw && isMounted) {
            const cached = JSON.parse(raw) as Trip[];
            setTrips(cached.filter((trip) => isCachedTripForWallet(trip, publicKey)));
          }
        } catch {
          // ignore
        }
        if (isMounted) setIsLoading(false);
        return;
      }

      try {
        const { data, error } = await client
          .from("trips")
          .select("*")
          .order("created_at", { ascending: false });

        if (error) throw error;

        if (isMounted && data) {
          const trips = data.map(dbRowToTrip);
          setTrips(trips);
          localStorage.setItem(cacheKey, JSON.stringify(trips));
        }
      } catch (err) {
        logWarn("trip.load_failed_using_cache", { fields: supabaseErrorFields(err) });
        try {
          const raw = localStorage.getItem(cacheKey);
          if (raw && isMounted) {
            const cached = JSON.parse(raw) as Trip[];
            setTrips(cached.filter((trip) => isCachedTripForWallet(trip, publicKey)));
          }
        } catch {
          // ignore
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadTrips();

    return () => {
      isMounted = false;
    };
  }, [client, publicKey, consentGeneration]);


  // The JWT stays in an HttpOnly cookie, so database changes are polled through
  // the authenticated REST proxy rather than exposed to a Realtime socket.
  useEffect(() => {
    if (!client || !publicKey) return;

    const cacheKey = getWalletScopedKey(LS_TRIPS, publicKey);
    let stopped = false;
    let inFlight = false;
    let failureReported = false;

    const refresh = async () => {
      if (
        stopped ||
        inFlight ||
        document.visibilityState !== "visible" ||
        !hasProvenSession(publicKey)
      ) return;
      inFlight = true;
      try {
        const { data, error } = await client
          .from("trips")
          .select("*")
          .order("created_at", { ascending: false });
        if (error) throw error;
        if (stopped || !data) return;

        const trips = data
          .filter((row) => isRowForWallet(row, publicKey))
          .map(dbRowToTrip);
        setTrips(trips);
        localStorage.setItem(cacheKey, JSON.stringify(trips));
        failureReported = false;
      } catch (error) {
        if (!stopped && !failureReported) {
          reportError("trip.poll_failed", error, {
            fields: supabaseErrorFields(error),
          });
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
  }, [client, publicKey]);

  const addTrip = useCallback(async (trip: Trip) => {
    if (!publicKey) throw new Error("Wallet not connected");

    const cacheKey = getWalletScopedKey(LS_TRIPS, publicKey);

    const memberWallets = trip.members
      .map((member) => member.walletAddress)
      .filter((address): address is string => !!address);
    const allMemberWallets = memberWallets.includes(publicKey)
      ? memberWallets
      : [publicKey, ...memberWallets];
    const localTrip: Trip = {
      ...trip,
      createdByWallet: publicKey,
      memberWallets: allMemberWallets,
      acceptedWallets: [publicKey],
    };

    setTrips((prev) => {
      const updated = [localTrip, ...prev];
      localStorage.setItem(cacheKey, JSON.stringify(updated));
      return updated;
    });

    // Persist to Supabase — throw on failure so the caller can handle it
    const client = await getClient();
    const { error } = await client
      .from("trips")
      .insert([tripToDbInsertRow(trip, publicKey)]);

    if (error) {
      setTrips((prev) => {
        const rolled = prev.filter((t) => t.id !== trip.id);
        localStorage.setItem(cacheKey, JSON.stringify(rolled));
        return rolled;
      });
      throw error;
    }
  }, [getClient, publicKey]);

  const updateTrip = useCallback(
    async (id: string, updates: Partial<Trip>) => {
      const current = trips.find((t) => t.id === id);
      if (!current) return;

      const cacheKey = publicKey ? getWalletScopedKey(LS_TRIPS, publicKey) : LS_TRIPS;
      const merged = { ...current, ...updates };

      // Optimistic update
      setTrips((prev) => {
        const updated = prev.map((t) => (t.id === id ? merged : t));
        localStorage.setItem(cacheKey, JSON.stringify(updated));
        return updated;
      });

      try {
        const client = await getClient();

        // Build partial update payload containing only mutable fields.
        // Never send created_by_wallet, created_at, or id in an UPDATE.
        const dbUpdates: Database["public"]["Tables"]["trips"]["Update"] = {};
        if (updates.name !== undefined) dbUpdates.name = updates.name;
        if (updates.description !== undefined) dbUpdates.description = updates.description ?? null;
        if (updates.members !== undefined) {
          dbUpdates.members = updates.members as unknown as Json;
          const memberWallets = updates.members
            .map((m) => m.walletAddress)
            .filter((addr): addr is string => !!addr);
          dbUpdates.member_wallets = memberWallets;
        }
        if (updates.expenseIds !== undefined) dbUpdates.expense_ids = updates.expenseIds;
        if (updates.settled !== undefined) dbUpdates.settled = updates.settled;

        // Guard the write with the version we based `merged` on.
        const baseVersion = current.version ?? 1;
        dbUpdates.version = baseVersion + 1;

        const { data, error } = await client
          .from("trips")
          .update(dbUpdates)
          .eq("id", id)
          .eq("version", baseVersion)
          .select("*");

        if (error) throw error;

        // Zero rows means the predicate did not match: someone else wrote first.
        // Re-read so the caller sees the winning row rather than a stale local
        // copy, and fail loudly instead of pretending the edit landed.
        if (!data || data.length === 0) {
          const { data: fresh } = await client
            .from("trips")
            .select("*")
            .eq("id", id)
            .single();

          if (fresh) {
            const winner = dbRowToTrip(fresh);
            setTrips((prev) => {
              const synced = prev.map((t) => (t.id === id ? winner : t));
              localStorage.setItem(cacheKey, JSON.stringify(synced));
              return synced;
            });
          }

          throw new TripConflictError(
            "This trip was changed by someone else while you were editing. " +
              "Your view has been refreshed — please reapply your change."
          );
        }

        // Adopt the row the database actually stored
        const stored = dbRowToTrip(data[0]);
        setTrips((prev) => {
          const synced = prev.map((t) => (t.id === id ? stored : t));
          localStorage.setItem(cacheKey, JSON.stringify(synced));
          return synced;
        });
      } catch (err) {
        reportError("trip.update_failed", err, {
          fields: { tripId: id, ...supabaseErrorFields(err) },
        });
        // A conflict already replaced local state with the winning row.
        if (!(err instanceof TripConflictError)) {
          setTrips((prev) => {
            const rolled = prev.map((t) => (t.id === id ? current : t));
            localStorage.setItem(cacheKey, JSON.stringify(rolled));
            return rolled;
          });
        }
        throw err;
      }
    },
    [trips, getClient, publicKey]
  );

  const deleteTrip = useCallback(
    async (id: string) => {
      const current = trips.find((t) => t.id === id);
      if (!current) return;

      const cacheKey = publicKey ? getWalletScopedKey(LS_TRIPS, publicKey) : LS_TRIPS;

      // Optimistic deletion
      setTrips((prev) => {
        const updated = prev.filter((t) => t.id !== id);
        localStorage.setItem(cacheKey, JSON.stringify(updated));
        return updated;
      });

      try {
        const client = await getClient();
        const { error } = await client.from("trips").delete().eq("id", id);

        if (error) throw error;

        // Notify ExpenseContext that this trip and its expenses were deleted
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("settlex:trip-deleted", {
              detail: { tripId: id, expenseIds: current.expenseIds },
            })
          );
        }
      } catch (err) {
        reportError("trip.delete_failed", err, {
          fields: { tripId: id, ...supabaseErrorFields(err) },
        });
        // Roll back optimistic deletion on error
        setTrips((prev) => {
          if (prev.some((t) => t.id === id)) return prev;
          const rolled = [current, ...prev];
          localStorage.setItem(cacheKey, JSON.stringify(rolled));
          return rolled;
        });
        throw err;
      }
    },
    [trips, getClient, publicKey]
  );

  const addExpenseToTrip = useCallback(
    async (tripId: string, expenseId: string) => {
      const cacheKey = publicKey ? getWalletScopedKey(LS_TRIPS, publicKey) : LS_TRIPS;

      // Optimistic update: use functional update so concurrent calls merge expenseIds
      let alreadyIncluded = false;
      setTrips((prev) => {
        const target = prev.find((t) => t.id === tripId);
        if (!target) return prev;
        if (target.expenseIds.includes(expenseId)) {
          alreadyIncluded = true;
          return prev;
        }
        const updated = prev.map((t) =>
          t.id === tripId ? { ...t, expenseIds: [...t.expenseIds, expenseId] } : t
        );
        localStorage.setItem(cacheKey, JSON.stringify(updated));
        return updated;
      });

      if (alreadyIncluded) return;

      try {
        const client = await getClient();

        // 1. Primary path: Call validated server-side RPC add_expense_to_trip
        let rpcSucceeded = false;
        try {
          const { data: rpcData, error: rpcErr } = await client.rpc("add_expense_to_trip", {
            p_trip_id: tripId,
            p_expense_id: expenseId,
          });

          if (rpcErr) {
            const msg = rpcErr.message || "";
            if (
              msg.includes("Cannot link foreign expense") ||
              msg.includes("Not authorized") ||
              msg.includes("Invalid expense ID") ||
              msg.includes("Cannot add expenses to a settled trip")
            ) {
              throw rpcErr;
            }
          } else {
            rpcSucceeded = true;
            if (rpcData) {
              const rows = Array.isArray(rpcData) ? rpcData : [rpcData];
              if (rows.length > 0) {
                const storedTrip = dbRowToTrip(rows[0]);
                setTrips((prev) => {
                  const updated = prev.map((t) => {
                    if (t.id !== tripId) return t;
                    // Preserve any local in-flight additions while adopting server state
                    const mergedExpenseIds = Array.from(
                      new Set([...storedTrip.expenseIds, ...t.expenseIds])
                    );
                    return {
                      ...t,
                      ...storedTrip,
                      expenseIds: mergedExpenseIds,
                    };
                  });
                  localStorage.setItem(cacheKey, JSON.stringify(updated));
                  return updated;
                });
              }
            }
          }
        } catch (rpcErr) {
          const msg = (rpcErr as { message?: string })?.message || "";
          if (
            msg.includes("Cannot link foreign expense") ||
            msg.includes("Not authorized") ||
            msg.includes("Invalid expense ID") ||
            msg.includes("Cannot add expenses to a settled trip")
          ) {
            throw rpcErr;
          }
          logWarn("trip.add_expense_rpc_unavailable", {
            fields: { tripId, ...supabaseErrorFields(rpcErr) },
          });
        }

        // 2. Fallback path: Direct guarded OCC update with retry if RPC not present in environment
        if (!rpcSucceeded) {
          const maxRetries = 3;
          let success = false;
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            const { data: freshRow, error: fetchErr } = await client
              .from("trips")
              .select("*")
              .eq("id", tripId)
              .single();

            if (fetchErr) throw fetchErr;
            if (!freshRow) throw new Error("Trip not found");

            const freshTrip = dbRowToTrip(freshRow);
            if (freshTrip.settled) {
              throw new Error("Cannot add expenses to a settled trip");
            }

            if (freshTrip.expenseIds.includes(expenseId)) {
              success = true;
              setTrips((prev) => {
                const updated = prev.map((t) => (t.id === tripId ? { ...t, ...freshTrip } : t));
                localStorage.setItem(cacheKey, JSON.stringify(updated));
                return updated;
              });
              break;
            }

            const baseVersion = freshTrip.version ?? 1;
            const nextExpenseIds = [...freshTrip.expenseIds, expenseId];

            const { data: updateData, error: updateErr } = await client
              .from("trips")
              .update({
                expense_ids: nextExpenseIds,
                version: baseVersion + 1,
              })
              .eq("id", tripId)
              .eq("version", baseVersion)
              .select("*");

            if (updateErr) throw updateErr;

            if (updateData && updateData.length > 0) {
              const stored = dbRowToTrip(updateData[0]);
              setTrips((prev) => {
                const updated = prev.map((t) => {
                  if (t.id !== tripId) return t;
                  const mergedExpenseIds = Array.from(
                    new Set([...stored.expenseIds, ...t.expenseIds])
                  );
                  return { ...t, ...stored, expenseIds: mergedExpenseIds };
                });
                localStorage.setItem(cacheKey, JSON.stringify(updated));
                return updated;
              });
              success = true;
              break;
            }
          }

          if (!success) {
            throw new TripConflictError(
              "Failed to add expense to trip due to concurrent updates"
            );
          }
        }

        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("settlex:consent-changed"));
        }
      } catch (err) {
        reportError("trip.add_expense_failed", err, {
          fields: { tripId, ...supabaseErrorFields(err) },
        });
        // Roll back ONLY the failed expenseId from optimistic state
        setTrips((prev) => {
          const updated = prev.map((t) => {
            if (t.id !== tripId) return t;
            return {
              ...t,
              expenseIds: t.expenseIds.filter((id) => id !== expenseId),
            };
          });
          localStorage.setItem(cacheKey, JSON.stringify(updated));
          return updated;
        });
        throw err;
      }
    },
    [getClient, publicKey]
  );

  const settleTrip = useCallback(
    async (id: string) => {
      const current = trips.find((t) => t.id === id);
      if (!current || current.settled) return;

      const cacheKey = publicKey ? getWalletScopedKey(LS_TRIPS, publicKey) : LS_TRIPS;

      // Optimistic update
      setTrips((prev) => {
        const updated = prev.map((t) => (t.id === id ? { ...t, settled: true } : t));
        localStorage.setItem(cacheKey, JSON.stringify(updated));
        return updated;
      });

      try {
        const client = await getClient();
        const baseVersion = current.version ?? 1;
        const { data, error } = await client
          .from("trips")
          .update({ settled: true, version: baseVersion + 1 })
          .eq("id", id)
          .eq("version", baseVersion)
          .select("*");

        if (error) throw error;

        if (!data || data.length === 0) {
          const { data: fresh } = await client
            .from("trips")
            .select("*")
            .eq("id", id)
            .single();

          if (fresh) {
            const winner = dbRowToTrip(fresh);
            setTrips((prev) => {
              const synced = prev.map((t) => (t.id === id ? winner : t));
              localStorage.setItem(cacheKey, JSON.stringify(synced));
              return synced;
            });
          }

          throw new TripConflictError(
            "This trip was changed by someone else. Your view has been refreshed."
          );
        }

        const stored = dbRowToTrip(data[0]);
        setTrips((prev) => {
          const synced = prev.map((t) => (t.id === id ? stored : t));
          localStorage.setItem(cacheKey, JSON.stringify(synced));
          return synced;
        });
      } catch (err) {
        reportError("trip.settle_failed", err, {
          fields: { tripId: id, ...supabaseErrorFields(err) },
        });
        // Roll back optimistic update on error if not conflict
        if (!(err instanceof TripConflictError)) {
          setTrips((prev) => {
            const rolled = prev.map((t) => (t.id === id ? current : t));
            localStorage.setItem(cacheKey, JSON.stringify(rolled));
            return rolled;
          });
        }
        throw err;
      }
    },
    [trips, getClient, publicKey]
  );

  const getTrip = useCallback(
    (id: string) => trips.find((t) => t.id === id),
    [trips]
  );

  return (
    <TripContext.Provider
      value={{
        trips,
        addTrip,
        updateTrip,
        deleteTrip,
        addExpenseToTrip,
        settleTrip,
        getTrip,
        isLoading,
      }}
    >
      {children}
    </TripContext.Provider>
  );
}

export function useTripContext(): TripContextType {
  const ctx = useContext(TripContext);
  if (!ctx) throw new Error("useTripContext must be used inside <TripProvider>");
  return ctx;
}
