"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  clearWalletSession,
  getAuthenticatedClient,
  requireAuthenticatedClient,
} from "@/lib/supabase/session";
import { useWalletContext } from "./WalletContext";
import { LS_USER } from "@/lib/utils/constants";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  walletAddress: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /**
   * Set when the wallet could not prove ownership of its key (signature
   * declined, server unreachable). Every database call fails while this is set,
   * so the UI should ask the user to re-authenticate rather than carry on.
   */
  sessionError: string | null;
  signUp: (displayName: string) => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => void;
  /** Re-runs the wallet signing handshake. */
  refreshSession: () => Promise<void>;
  updateProfile: (updates: Partial<Pick<User, "displayName">>) => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | null>(null);
AuthContext.displayName = "AuthContext";

// ─── Helper: Convert DB row to User ───────────────────────────────────────────

function dbRowToUser(row: any): User {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

// ─── localStorage helpers ────────────────────────────────────────────────────

function saveUserToCache(user: User) {
  try { localStorage.setItem(LS_USER, JSON.stringify(user)); } catch {}
}

function loadUserFromCache(): User | null {
  try {
    const raw = localStorage.getItem(LS_USER);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch { return null; }
}

function clearUserCache() {
  try { localStorage.removeItem(LS_USER); } catch {}
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    // Restore user immediately from cache on first render (avoids flash on refresh)
    if (typeof window !== "undefined") return loadUserFromCache();
    return null;
  });
  const [isLoading, setIsLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // Bumped by refreshSession() to re-run the handshake effect below.
  const [sessionNonce, setSessionNonce] = useState(0);
  const { publicKey, isConnected, isHydrated } = useWalletContext();

  const isAuthenticated = !!user && isConnected;

  // ── Load user profile when wallet connects ────────────────────────────────────────────────────────

  useEffect(() => {
    // Wait for wallet hydration to complete before making auth decisions
    if (!isHydrated) return;

    if (!publicKey) {
      setUser(null);
      clearUserCache();
      clearWalletSession();
      setSessionError(null);
      setIsLoading(false);
      return;
    }

    async function loadUser(wallet: string) {
      // Prove key ownership before touching the database — the profile table is
      // readable only by an authenticated wallet. This prompts the wallet to
      // sign once per session, not once per page load.
      const client = await getAuthenticatedClient(wallet).catch((err: unknown) => {
        setSessionError(
          err instanceof Error ? err.message : "Could not verify your wallet."
        );
        return null;
      });

      if (!client) {
        setIsLoading(false);
        return;
      }
      setSessionError(null);

      try {
        const { data, error } = await client
          .from("users")
          .select("*")
          .eq("wallet_address", wallet)
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            // No user found - user needs to sign up
            setUser(null);
            clearUserCache();
          }
          // On network errors, keep the cached user (don't log out)
        } else if (data) {
          const loadedUser = dbRowToUser(data);
          setUser(loadedUser);
          saveUserToCache(loadedUser);
        }
      } catch (err) {
        // Network error - keep cached user so user stays logged in
      } finally {
        setIsLoading(false);
      }
    }

    loadUser(publicKey);
  }, [publicKey, isHydrated, sessionNonce]);

  // ── Sign up: Create new user profile ──────────────────────────────────────

  const signUp = useCallback(
    async (displayName: string) => {
      if (!publicKey) {
        throw new Error("Wallet not connected");
      }

      if (!displayName || !displayName.trim()) {
        throw new Error("Display name is required");
      }

      try {
        const client = await requireAuthenticatedClient(publicKey);
        setSessionError(null);

        const { data, error } = await client
          .from("users")
          .insert({
            wallet_address: publicKey,
            display_name: displayName.trim(),
          })
          .select()
          .single();

        if (error) {
          if (error.code === '23505') {
            throw new Error("This wallet is already registered. Please sign in instead.");
          } else if (error.message.includes('permission denied') || error.message.includes('policy')) {
            throw new Error("Access denied. Please make sure your database is properly configured.");
          } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            throw new Error("Cannot connect to the server. Please check your internet connection.");
          } else {
            throw new Error(error.message || "Failed to create account. Please try again.");
          }
        }

        if (data) {
          const newUser = dbRowToUser(data);
          setUser(newUser);
          saveUserToCache(newUser);
        }
      } catch (err: any) {
        // Check for network errors
        if (err?.message?.includes('Failed to fetch') || err?.name === 'TypeError') {
          throw new Error("Cannot connect to server. Please check your internet connection or try again later.");
        }
        throw err;
      }
    },
    [publicKey]
  );

  // ── Sign in: Update last login time ───────────────────────────────────────

  const signIn = useCallback(async () => {
    if (!publicKey) {
      throw new Error("Wallet not connected");
    }

    try {
      // The JWT minted by the signing handshake is what RLS authorizes on.
      const client = await requireAuthenticatedClient(publicKey);
      setSessionError(null);

      const { data, error } = await client
        .from("users")
        .update({ last_login_at: new Date().toISOString() })
        .eq("wallet_address", publicKey)
        .select()
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          throw new Error("No account found. Please sign up first.");
        }
        if (error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError')) {
          throw new Error("Cannot connect to server. Please check your internet connection.");
        }
        throw new Error(error.message || "Sign in failed");
      }

      if (data) {
        const signedInUser = dbRowToUser(data);
        setUser(signedInUser);
        saveUserToCache(signedInUser);
      }
    } catch (err: any) {
      // Check for network errors
      if (err?.message?.includes('Failed to fetch') || err?.name === 'TypeError') {
        throw new Error("Cannot connect to server. Please check your internet connection and try again.");
      }
      throw err;
    }
  }, [publicKey]);

  // ── Sign out: Clear user state ──────────────────────────────────────────

  const signOut = useCallback(() => {
    setUser(null);
    clearUserCache();
    clearWalletSession();
    setSessionError(null);
  }, []);

  // ── Refresh session: re-run the wallet signing handshake ──────────────────

  const refreshSession = useCallback(async () => {
    clearWalletSession();
    setSessionError(null);
    setIsLoading(true);
    setSessionNonce((n) => n + 1);
  }, []);

  // ── Update profile ─────────────────────────────────────────────────────────

  const updateProfile = useCallback(
    async (updates: Partial<Pick<User, "displayName">>) => {
      if (!publicKey || !user) {
        throw new Error("Not authenticated");
      }

      try {
        const client = await requireAuthenticatedClient(publicKey);
        setSessionError(null);

        const { data, error } = await client
          .from("users")
          .update({
            display_name: updates.displayName ?? user.displayName,
          })
          .eq("wallet_address", publicKey)
          .select()
          .single();

        if (error) {
          throw new Error(error.message || "Failed to update profile");
        }

        if (data) {
          const updatedUser = dbRowToUser(data);
          setUser(updatedUser);
          saveUserToCache(updatedUser);
        }
      } catch (err: any) {
        throw err;
      }
    },
    [publicKey, user]
  );

  // ──────────────────────────────────────────────────────────────────────────

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated,
    sessionError,
    signUp,
    signIn,
    signOut,
    refreshSession,
    updateProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
