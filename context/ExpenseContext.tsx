"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { Expense, SplitShare } from "@/types/expense";
import { LS_EXPENSES } from "@/lib/utils/constants";
import {
  getAuthenticatedClient,
  onSessionChange,
  requireAuthenticatedClient,
} from "@/lib/supabase/session";
import type {
  RealtimePostgresChangesPayload,
  SupabaseClient,
} from "@supabase/supabase-js";
import { useWalletContext } from "./WalletContext";


interface ExpenseContextType {
  expenses: Expense[];
  addExpense: (expense: Expense) => Promise<void>;
  updateExpense: (id: string, updates: Partial<Expense>) => void;
  deleteExpense: (id: string) => void;
  markSharePaid: (expenseId: string, memberId: string, txHash: string) => Promise<void>;
  getExpense: (id: string) => Expense | undefined;
  isLoading: boolean;
}


const ExpenseContext = createContext<ExpenseContextType | null>(null);
ExpenseContext.displayName = "ExpenseContext";

function dbRowToExpense(row: any): Expense {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    totalAmount: row.total_amount,
    currency: row.currency,
    splitMode: row.split_mode,
    paidByMemberId: row.paid_by_member_id,
    members: row.members,
    shares: row.shares,
    createdAt: row.created_at,
    settled: row.settled,
  };
}

function expenseToDbRow(expense: Expense, creatorWallet: string) {
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
    members: expense.members,
    shares: expense.shares,
    created_at: expense.createdAt,
    settled: expense.settled,
    created_by_wallet: creatorWallet,
    member_wallets: allMemberWallets,
  };
}


export function ExpenseProvider({ children }: { children: React.ReactNode }) {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const { publicKey } = useWalletContext();

  // Every call is scoped by a JWT the server issues only after the wallet has
  // signed a challenge, so RLS has a wallet identity it can actually trust.
  const getClient = useCallback(async () => {
    if (!publicKey) throw new Error("Wallet not connected");
    return requireAuthenticatedClient(publicKey);
  }, [publicKey]);

  // Rebind whenever the session is established or dropped, so a re-signed
  // session never leaves this provider holding a client with a stale token.
  const [sessionGeneration, setSessionGeneration] = useState(0);
  useEffect(() => onSessionChange(() => setSessionGeneration((n) => n + 1)), []);

  // Resolve the authenticated client once per wallet so the initial load and
  // the realtime feed share it. Concurrent callers reuse a single handshake,
  // so the wallet is only ever asked to sign once.
  useEffect(() => {
    let cancelled = false;

    if (!publicKey) {
      setClient(null);
      return;
    }

    getAuthenticatedClient(publicKey)
      .then((resolved) => {
        if (!cancelled) setClient(resolved);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("Wallet sign-in failed — falling back to cached data:", err);
        setClient(null);
      });

    return () => {
      cancelled = true;
    };
  }, [publicKey, sessionGeneration]);


  useEffect(() => {
    let isMounted = true;

    async function loadExpenses() {
      // Without a proven wallet identity RLS returns nothing, so fall back to
      // whatever this browser cached rather than showing an empty list.
      if (!client) {
        try {
          const raw = localStorage.getItem(LS_EXPENSES);
          if (raw && isMounted) setExpenses(JSON.parse(raw) as Expense[]);
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
          localStorage.setItem(LS_EXPENSES, JSON.stringify(expenses));
        }
      } catch (err) {
        console.warn("Failed to load from Supabase, using localStorage:", err);
        try {
          const raw = localStorage.getItem(LS_EXPENSES);
          if (raw && isMounted) setExpenses(JSON.parse(raw) as Expense[]);
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
  }, [client]);

  // Realtime authorizes on the socket's own JWT, so the feed has to run on the
  // authenticated client too — the anon client would receive nothing.
  useEffect(() => {
    if (!client) return;

    const channel = client
      .channel("expenses-changes")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "expenses" },
        (payload: RealtimePostgresChangesPayload<any>) => {
          const newExpense = dbRowToExpense(payload.new);
          setExpenses((prev) => {
            if (prev.some((e) => e.id === newExpense.id)) return prev;
            const updated = [newExpense, ...prev];
            localStorage.setItem(LS_EXPENSES, JSON.stringify(updated));
            return updated;
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "expenses" },
        (payload: RealtimePostgresChangesPayload<any>) => {
          const updatedExpense = dbRowToExpense(payload.new);
          setExpenses((prev) => {
            const updated = prev.map((e) =>
              e.id === updatedExpense.id ? updatedExpense : e
            );
            localStorage.setItem(LS_EXPENSES, JSON.stringify(updated));
            return updated;
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "expenses" },
        (payload: RealtimePostgresChangesPayload<any>) => {
          const deletedId = (payload.old as any)?.id;
          if (!deletedId) return;
          setExpenses((prev) => {
            const updated = prev.filter((e) => e.id !== deletedId);
            localStorage.setItem(LS_EXPENSES, JSON.stringify(updated));
            return updated;
          });
        }
      )
      .subscribe();

    return () => {
      void client.removeChannel(channel);
    };
  }, [client]);

  const addExpense = useCallback(async (expense: Expense) => {
    if (!publicKey) throw new Error("Wallet not connected");

    setExpenses((prev) => {
      const updated = [expense, ...prev];
      localStorage.setItem(LS_EXPENSES, JSON.stringify(updated));
      return updated;
    });

    // Persist to Supabase — throw on failure so the caller can handle it
    const client = await getClient();
    const { error } = await client
      .from("expenses")
      .insert([expenseToDbRow(expense, publicKey)]);

    if (error) {
      setExpenses((prev) => {
        const rolled = prev.filter((e) => e.id !== expense.id);
        localStorage.setItem(LS_EXPENSES, JSON.stringify(rolled));
        return rolled;
      });
      throw error;
    }
  }, [getClient, publicKey]);

  const updateExpense = useCallback(
    async (id: string, updates: Partial<Expense>) => {
      try {
        const current = expenses.find((e) => e.id === id);
        if (!current) return;

        const merged = { ...current, ...updates };
        const dbRow = expenseToDbRow(merged, publicKey || '');

        const client = await getClient();
        const { error } = await client
          .from("expenses")
          .update(dbRow)
          .eq("id", id);

        if (error) throw error;

        setExpenses((prev) => {
          const updated = prev.map((e) => (e.id === id ? merged : e));
          localStorage.setItem(LS_EXPENSES, JSON.stringify(updated));
          return updated;
        });
      } catch (err) {
        console.error("Failed to update expense in Supabase:", err);
        setExpenses((prev) => {
          const updated = prev.map((e) =>
            e.id === id ? { ...e, ...updates } : e
          );
          localStorage.setItem(LS_EXPENSES, JSON.stringify(updated));
          return updated;
        });
      }
    },
    [expenses, getClient, publicKey]
  );

  const deleteExpense = useCallback(async (id: string) => {
    try {
      const client = await getClient();
      const { error } = await client.from("expenses").delete().eq("id", id);

      if (error) throw error;

      setExpenses((prev) => {
        const updated = prev.filter((e) => e.id !== id);
        localStorage.setItem(LS_EXPENSES, JSON.stringify(updated));
        return updated;
      });
    } catch (err) {
      console.error("Failed to delete expense from Supabase:", err);
      setExpenses((prev) => {
        const updated = prev.filter((e) => e.id !== id);
        localStorage.setItem(LS_EXPENSES, JSON.stringify(updated));
        return updated;
      });
    }
  }, [getClient]);

  const markSharePaid = useCallback(
    async (expenseId: string, memberId: string, txHash: string) => {
      const current = expenses.find((e) => e.id === expenseId);
      if (!current) throw new Error("Expense not found in state — please refresh and try again.");

      setExpenses((prev) => {
        const updated = prev.map((e) => {
          if (e.id !== expenseId) return e;
          const shares = e.shares.map((s) =>
            s.memberId === memberId ? { ...s, paid: true, txHash } : s
          );
          const settled = shares.every((s) => s.paid);
          return { ...e, shares, settled };
        });
        localStorage.setItem(LS_EXPENSES, JSON.stringify(updated));
        return updated;
      });

      try {
        const client = await getClient();

        const { data: freshData, error: fetchErr } = await client
          .from("expenses")
          .select("shares")
          .eq("id", expenseId)
          .single();

        if (fetchErr) throw fetchErr;

        const freshShares = (freshData.shares as SplitShare[]).map((s: SplitShare) =>
          s.memberId === memberId ? { ...s, paid: true, txHash } : s
        );
        const freshSettled = freshShares.every((s: SplitShare) => s.paid);

        const { data: rowsUpdated, error: updateErr } = await client
          .from("expenses")
          .update({ shares: freshShares, settled: freshSettled })
          .eq("id", expenseId)
          .select("id");

        if (updateErr) throw updateErr;
        if (!rowsUpdated || rowsUpdated.length === 0) {
          throw new Error(
            "Payment sent on Stellar but could not be recorded. " +
            "Make sure your Stellar wallet address is entered correctly in the expense member list."
          );
        }

        setExpenses((prev) => {
          const synced = prev.map((e) =>
            e.id !== expenseId ? e : { ...e, shares: freshShares, settled: freshSettled }
          );
          localStorage.setItem(LS_EXPENSES, JSON.stringify(synced));
          return synced;
        });
      } catch (err) {
        console.error("Failed to persist markSharePaid to Supabase:", err);
        setExpenses((prev) => {
          const rolled = prev.map((e) => (e.id === expenseId ? current : e));
          localStorage.setItem(LS_EXPENSES, JSON.stringify(rolled));
          return rolled;
        });
        throw err;
      }
    },
    [expenses, getClient]
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
