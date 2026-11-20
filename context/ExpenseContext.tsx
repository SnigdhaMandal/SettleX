"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { Expense } from "@/types/expense";
import { getWalletScopedKey, LS_EXPENSES } from "@/lib/utils/constants";
import {
  getAuthenticatedClient,
  hasProvenSession,
  onSessionChange,
  requireAuthenticatedClient,
} from "@/lib/supabase/session";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/supabase";
import { useWalletContext } from "./WalletContext";
import { logWarn, reportError } from "@/lib/observability/logger";
import { supabaseErrorFields } from "@/lib/observability/supabaseError";
import { parseExpenseRow } from "@/lib/supabase/rowGuards";
import { userFacingMessage } from "@/lib/errors/userMessage";


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


interface ExpenseContextType {
  expenses: Expense[];
  addExpense: (expense: Expense, tripId?: string) => Promise<void>;
  updateExpense: (id: string, updates: Partial<Expense>) => Promise<void>;
  deleteExpense: (id: string) => Promise<void>;
  markSharePaid: (expenseId: string, memberId: string, txHash: string) => Promise<void>;
  getExpense: (id: string) => Expense | undefined;
  isLoading: boolean;
}


const ExpenseContext = createContext<ExpenseContextType | null>(null);
ExpenseContext.displayName = "ExpenseContext";

function isRowForWallet(
  row: Partial<Database["public"]["Tables"]["expenses"]["Row"]> | null | undefined,
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

function isCachedExpenseForWallet(expense: Expense, walletAddress: string | null): boolean {
  if (!walletAddress) return false;
  return (
    expense.createdByWallet === walletAddress ||
    (!!expense.memberWallets?.includes(walletAddress) &&
      !!expense.acceptedWallets?.includes(walletAddress))
  );
}

/**
 * Raised when a write loses to a concurrent one. Distinct from a transport
 * failure: local state already holds the winning row, so the caller should
 * reapply its change rather than retry the same stale payload.
 */
export class ExpenseConflictError extends Error {}

function dbRowToExpense(row: unknown): Expense {
  return parseExpenseRow(row);
}

function expenseToDbInsertRow(
  expense: Expense,
  creatorWallet: string
): Database["public"]["Tables"]["expenses"]["Insert"] {
  const memberWallets = expense.members
    .map((m) => m.walletAddress)
    .filter((addr): addr is string => !!addr);

  const allMemberWallets =
    creatorWallet && !memberWallets.includes(creatorWallet)
      ? [creatorWallet, ...memberWallets]
      : memberWallets;

  return {
    id: expense.id,
    title: expense.title,
    description: expense.description ?? null,
    total_amount: expense.totalAmount,
    currency: expense.currency,
    split_mode: expense.splitMode,
    paid_by_member_id: expense.paidByMemberId,
    members: expense.members as unknown as Json,
    shares: expense.shares as unknown as Json,
    created_at: expense.createdAt,
    settled: expense.settled,
    version: expense.version ?? 1,
    created_by_wallet: creatorWallet,
    member_wallets: allMemberWallets,
    accepted_wallets: [creatorWallet],
    declined_wallets: [],
  };
}


export function ExpenseProvider({ children }: { children: React.ReactNode }) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
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

  // Listen for trip deletion to clean up cascaded expenses locally
  useEffect(() => {
    const handleTripDeleted = (e: Event) => {
      const customEvent = e as CustomEvent<{ tripId: string; expenseIds: string[] }>;
      const deletedIds = customEvent.detail?.expenseIds;
      if (deletedIds && deletedIds.length > 0) {
        setExpenses((prev) => {
          const updated = prev.filter((exp) => !deletedIds.includes(exp.id));
          const cacheKey = publicKey ? getWalletScopedKey(LS_EXPENSES, publicKey) : LS_EXPENSES;
          localStorage.setItem(cacheKey, JSON.stringify(updated));
          return updated;
        });
      }
    };
    window.addEventListener("settlex:trip-deleted", handleTripDeleted);
    return () => window.removeEventListener("settlex:trip-deleted", handleTripDeleted);
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
        logWarn("expense.signin_failed_using_cache", {
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

    const cacheKey = publicKey ? getWalletScopedKey(LS_EXPENSES, publicKey) : LS_EXPENSES;

    async function loadExpenses() {
      // Without a proven wallet identity RLS returns nothing, so fall back to
      // whatever this browser cached rather than showing an empty list.
      if (!client) {
        // No proven ownership means no cached rows — not even this wallet's own
        // key, which a previous holder of this browser may have populated.
        if (!hasProvenOwnership(publicKey)) {
          if (isMounted) {
            setExpenses([]);
            setIsLoading(false);
          }
          return;
        }
        try {
          const raw = localStorage.getItem(cacheKey);
          if (raw && isMounted) {
            const cached = JSON.parse(raw) as Expense[];
            setExpenses(cached.filter((expense) => isCachedExpenseForWallet(expense, publicKey)));
          }
        } catch {
          // ignore
        }
        if (isMounted) setIsLoading(false);
        return;
      }

      try {
        // Try loading from Supabase
        const { data, error } = await client
          .from("expenses")
          .select("*")
          .order("created_at", { ascending: false });

        if (error) throw error;

        if (isMounted && data) {
          const expenses = data.map(dbRowToExpense);
          setExpenses(expenses);
          localStorage.setItem(cacheKey, JSON.stringify(expenses));
        }
      } catch (err) {
        logWarn("expense.load_failed_using_cache", { fields: supabaseErrorFields(err) });
        try {
          const raw = localStorage.getItem(cacheKey);
          if (raw && isMounted) {
            const cached = JSON.parse(raw) as Expense[];
            setExpenses(cached.filter((expense) => isCachedExpenseForWallet(expense, publicKey)));
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

    loadExpenses();

    return () => {
      isMounted = false;
    };
  }, [client, publicKey, consentGeneration]);

  // The JWT stays in an HttpOnly cookie, so database changes are polled through
  // the authenticated REST proxy rather than exposed to a Realtime socket.
  useEffect(() => {
    if (!client || !publicKey) return;

    const cacheKey = getWalletScopedKey(LS_EXPENSES, publicKey);
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
          .from("expenses")
          .select("*")
          .order("created_at", { ascending: false });
        if (error) throw error;
        if (stopped || !data) return;

        const expenses = data
          .filter((row) => isRowForWallet(row, publicKey))
          .map(dbRowToExpense);
        setExpenses(expenses);
        localStorage.setItem(cacheKey, JSON.stringify(expenses));
        failureReported = false;
      } catch (error) {
        if (!stopped && !failureReported) {
          reportError("expense.poll_failed", error, {
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

  const addExpense = useCallback(
    async (expense: Expense, tripId?: string) => {
      if (!publicKey) throw new Error("Wallet not connected");

      const cacheKey = getWalletScopedKey(LS_EXPENSES, publicKey);

      const memberWallets = expense.members
        .map((member) => member.walletAddress)
        .filter((address): address is string => !!address);
      const allMemberWallets = memberWallets.includes(publicKey)
        ? memberWallets
        : [publicKey, ...memberWallets];
      const localExpense: Expense = {
        ...expense,
        createdByWallet: publicKey,
        memberWallets: allMemberWallets,
        acceptedWallets: [publicKey],
      };

      setExpenses((prev) => {
        const updated = [localExpense, ...prev];
        localStorage.setItem(cacheKey, JSON.stringify(updated));
        return updated;
      });

      try {
        const client = await getClient();
        const expensePayload = expenseToDbInsertRow(expense, publicKey);

        if (tripId) {
          // Atomic path: Use create_trip_expense RPC to create and link in one transaction
          let rpcSuccess = false;
          try {
            const { data, error } = await client.rpc("create_trip_expense", {
              p_trip_id: tripId,
              p_expense: expensePayload as unknown as Json,
            });

            if (error) {
              const msg = error.message || "";
              if (
                msg.includes("Cannot link foreign expense") ||
                msg.includes("Not authorized") ||
                msg.includes("Cannot add expenses to a settled trip") ||
                msg.includes("Trip not found")
              ) {
                throw error;
              }
            } else {
              rpcSuccess = true;
              if (data && data.length > 0) {
                const stored = dbRowToExpense(data[0]);
                setExpenses((prev) => {
                  const synced = prev.map((e) => (e.id === expense.id ? stored : e));
                  localStorage.setItem(cacheKey, JSON.stringify(synced));
                  return synced;
                });
              }
            }
          } catch (rpcErr) {
            const msg = (rpcErr as { message?: string })?.message || "";
            if (
              msg.includes("Cannot link foreign expense") ||
              msg.includes("Not authorized") ||
              msg.includes("Cannot add expenses to a settled trip") ||
              msg.includes("Trip not found")
            ) {
              throw rpcErr;
            }
            logWarn("expense.create_trip_expense_rpc_unavailable", {
              fields: { tripId, expenseId: expense.id, ...supabaseErrorFields(rpcErr) },
            });
          }

          // Fallback path if RPC is unavailable in the environment
          if (!rpcSuccess) {
            const { error: insertErr } = await client
              .from("expenses")
              .insert([expensePayload]);
            if (insertErr) throw insertErr;

            try {
              const { error: linkErr } = await client.rpc("add_expense_to_trip", {
                p_trip_id: tripId,
                p_expense_id: expense.id,
              });
              if (linkErr) throw linkErr;
            } catch (linkErr) {
              // Roll back the inserted expense from DB so we don't leave an unlinked orphan
              await client.from("expenses").delete().eq("id", expense.id).catch(() => {});
              throw linkErr;
            }
          }

          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("settlex:trip-expense-created", {
                detail: { tripId, expenseId: expense.id },
              })
            );
            window.dispatchEvent(new Event("settlex:consent-changed"));
          }
        } else {
          // Standard standalone expense insert
          const { error } = await client
            .from("expenses")
            .insert([expensePayload]);

          if (error) throw error;
        }
      } catch (err) {
        setExpenses((prev) => {
          const rolled = prev.filter((e) => e.id !== expense.id);
          localStorage.setItem(cacheKey, JSON.stringify(rolled));
          return rolled;
        });
        throw err;
      }
    },
    [getClient, publicKey]
  );

  const updateExpense = useCallback(
    async (id: string, updates: Partial<Expense>) => {
      const current = expenses.find((e) => e.id === id);
      if (!current) return;

      const cacheKey = publicKey ? getWalletScopedKey(LS_EXPENSES, publicKey) : LS_EXPENSES;
      const merged = { ...current, ...updates };

      // Optimistic update
      setExpenses((prev) => {
        const updated = prev.map((e) => (e.id === id ? merged : e));
        localStorage.setItem(cacheKey, JSON.stringify(updated));
        return updated;
      });

      try {
        const client = await getClient();

        // Build partial update payload containing only mutable fields.
        // Never send created_by_wallet, created_at, or id in an UPDATE.
        const dbUpdates: Database["public"]["Tables"]["expenses"]["Update"] = {};
        if (updates.title !== undefined) dbUpdates.title = updates.title;
        if (updates.description !== undefined) dbUpdates.description = updates.description ?? null;
        if (updates.totalAmount !== undefined) dbUpdates.total_amount = updates.totalAmount;
        if (updates.currency !== undefined) dbUpdates.currency = updates.currency;
        if (updates.splitMode !== undefined) dbUpdates.split_mode = updates.splitMode;
        if (updates.paidByMemberId !== undefined) dbUpdates.paid_by_member_id = updates.paidByMemberId;
        if (updates.members !== undefined) {
          dbUpdates.members = updates.members as unknown as Json;
          const memberWallets = updates.members
            .map((m) => m.walletAddress)
            .filter((addr): addr is string => !!addr);
          dbUpdates.member_wallets = memberWallets;
        }
        if (updates.shares !== undefined) dbUpdates.shares = updates.shares as unknown as Json;
        if (updates.settled !== undefined) dbUpdates.settled = updates.settled;

        // Guard the write with the version we based `merged` on. Without this
        // predicate two concurrent editors both read v1, both write, and the
        // later write silently discards the earlier one -- including a share
        // someone just settled on-chain, which would resurface a Pay button for
        // a payment that already happened.
        const baseVersion = current.version ?? 1;
        dbUpdates.version = baseVersion + 1;

        const { data, error } = await client
          .from("expenses")
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
            .from("expenses")
            .select("*")
            .eq("id", id)
            .single();

          if (fresh) {
            const winner = dbRowToExpense(fresh);
            setExpenses((prev) => {
              const synced = prev.map((e) => (e.id === id ? winner : e));
              localStorage.setItem(cacheKey, JSON.stringify(synced));
              return synced;
            });
          }

          throw new ExpenseConflictError(
            "This expense was changed by someone else while you were editing. " +
              "Your view has been refreshed — please reapply your change.",
          );
        }

        // Adopt the row the database actually stored, so the local version
        // token tracks the server's and the next edit is checked against it.
        const stored = dbRowToExpense(data[0]);
        setExpenses((prev) => {
          const synced = prev.map((e) => (e.id === id ? stored : e));
          localStorage.setItem(cacheKey, JSON.stringify(synced));
          return synced;
        });
      } catch (err) {
        reportError("expense.update_failed", err, {
          fields: { expenseId: id, ...supabaseErrorFields(err) },
        });
        // A conflict already replaced local state with the winning row. Rolling
        // back to `current` here would overwrite it with the very stale copy
        // this guard exists to reject.
        if (!(err instanceof ExpenseConflictError)) {
          setExpenses((prev) => {
            const rolled = prev.map((e) => (e.id === id ? current : e));
            localStorage.setItem(cacheKey, JSON.stringify(rolled));
            return rolled;
          });
        }
        throw err;
      }
    },
    [expenses, getClient, publicKey]
  );

  const deleteExpense = useCallback(
    async (id: string) => {
      const current = expenses.find((e) => e.id === id);
      if (!current) return;

      const cacheKey = publicKey ? getWalletScopedKey(LS_EXPENSES, publicKey) : LS_EXPENSES;

      // Optimistic deletion
      setExpenses((prev) => {
        const updated = prev.filter((e) => e.id !== id);
        localStorage.setItem(cacheKey, JSON.stringify(updated));
        return updated;
      });

      try {
        const client = await getClient();
        const { error } = await client.from("expenses").delete().eq("id", id);

        if (error) throw error;

        // Notify TripContext to remove dangling references in local trips
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("settlex:expense-deleted", {
              detail: { expenseId: id },
            })
          );
        }
      } catch (err) {
        reportError("expense.delete_failed", err, {
          fields: { expenseId: id, ...supabaseErrorFields(err) },
        });
        // Roll back optimistic deletion on error
        setExpenses((prev) => {
          if (prev.some((e) => e.id === id)) return prev;
          const rolled = [current, ...prev];
          localStorage.setItem(cacheKey, JSON.stringify(rolled));
          return rolled;
        });
        throw err;
      }
    },
    [expenses, getClient, publicKey]
  );

  const markSharePaid = useCallback(
    async (expenseId: string, memberId: string, txHash: string) => {
      const current = expenses.find((e) => e.id === expenseId);
      if (!current) throw new Error("Expense not found in state — please refresh and try again.");

      const cacheKey = publicKey ? getWalletScopedKey(LS_EXPENSES, publicKey) : LS_EXPENSES;
      const nowIso = new Date().toISOString();

      // Optimistic local state update
      setExpenses((prev) => {
        const updated = prev.map((e) => {
          if (e.id !== expenseId) return e;
          const shares = e.shares.map((s) =>
            s.memberId === memberId
              ? {
                  ...s,
                  paid: true,
                  txHash,
                  paidBy: publicKey || s.paidBy,
                  markedAt: s.markedAt || nowIso,
                }
              : s
          );
          const settled = shares.every((s) => s.paid);
          return { ...e, shares, settled };
        });
        localStorage.setItem(cacheKey, JSON.stringify(updated));
        return updated;
      });

      try {
        const client = await getClient();

        // Single write path: the row-locked mark_share_paid RPC. It enforces
        // the rules a direct UPDATE cannot (caller authorisation, one hash per
        // payment, no re-marking a paid share, creator restrictions SX-026 /
        // SX-028), so its rejections are final. There is deliberately no
        // client-side fallback that writes the shares array directly: that
        // would turn every business rejection into a silent bypass.
        const { data: rpcData, error: rpcErr } = await client.rpc("mark_share_paid", {
          p_expense_id: expenseId,
          p_member_id: memberId,
          p_tx_hash: txHash,
        });

        if (rpcErr) throw rpcErr;
        if (!rpcData || rpcData.length === 0) {
          throw new Error("The payment could not be recorded. Please try again.");
        }

        const updatedRow = dbRowToExpense(rpcData[0]);
        setExpenses((prev) => {
          const synced = prev.map((e) => (e.id === expenseId ? updatedRow : e));
          localStorage.setItem(cacheKey, JSON.stringify(synced));
          return synced;
        });
      } catch (err) {
        // The payment settled on Stellar but the database does not reflect it:
        // the ledger and the app now disagree about who has paid.
        // The caller (usePayment) keeps a durable pending-payment record for
        // this transfer and blocks Pay until it is recorded, so rolling the
        // share back here cannot lead to a second payment.
        reportError("expense.mark_share_paid_failed", err, {
          fields: { expenseId, ...supabaseErrorFields(err) },
        });
        // Undo only this share's optimistic update. Restoring the whole
        // snapshot would also discard anything that landed meanwhile (a poll,
        // another member's payment) and is newer than `current`.
        const previousShare = current.shares.find((s) => s.memberId === memberId);
        setExpenses((prev) => {
          const rolled = prev.map((e) => {
            if (e.id !== expenseId) return e;
            const shares = e.shares.map((s) =>
              s.memberId === memberId && s.txHash === txHash && previousShare ? previousShare : s
            );
            return { ...e, shares, settled: shares.every((s) => s.paid) };
          });
          localStorage.setItem(cacheKey, JSON.stringify(rolled));
          return rolled;
        });
        // PostgREST errors are plain objects, not Error instances, so pass the
        // message itself. Rule rejections written for users ("Share is already
        // marked as paid") survive; raw database detail becomes the generic line.
        const rawMessage = (err as { message?: unknown } | null)?.message;
        const { message } = userFacingMessage(typeof rawMessage === "string" ? rawMessage : err);
        throw new Error(message, { cause: err });
      }
    },
    [expenses, getClient, publicKey]
  );

  const getExpense = useCallback(
    (id: string) => expenses.find((e) => e.id === id),
    [expenses]
  );

  return (
    <ExpenseContext.Provider
      value={{
        expenses,
        addExpense,
        updateExpense,
        deleteExpense,
        markSharePaid,
        getExpense,
        isLoading,
      }}
    >
      {children}
    </ExpenseContext.Provider>
  );
}

export function useExpenseContext(): ExpenseContextType {
  const ctx = useContext(ExpenseContext);
  if (!ctx) throw new Error("useExpenseContext must be used within <ExpenseProvider />");
  return ctx;
}
