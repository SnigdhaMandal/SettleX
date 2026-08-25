"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { getFreighterNetwork, isFreighterInstalled } from "@/lib/freighter";
import { getWalletsKit, FREIGHTER_ID, type WalletId } from "@/lib/stellar/walletsKit";
import { getXLMBalance } from "@/lib/stellar/getBalance";
import { LS_PUBLIC_KEY, LS_WALLET_ID } from "@/lib/utils/constants";
import type { WalletContextType } from "@/types/wallet";
import { useToast } from "@/components/ui/Toast";


const WalletContext = createContext<WalletContextType | null>(null);
WalletContext.displayName = "WalletContext";


export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey]           = useState<string | null>(null);
  const [balance, setBalance]               = useState<string | null>(null);
  const [network, setNetwork]               = useState<string | null>(null);
  const [isConnecting, setIsConnecting]     = useState(false);
  const [isLoadingBalance, setLoadingBal]   = useState(false);
  const [isHydrated, setIsHydrated]         = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);

  const isConnected = !!publicKey;
  const didMount    = useRef(false);
  const { error: toastError, success: toastSuccess, info: toastInfo } = useToast();

  const fetchBalance = useCallback(async (pk: string, silent = false) => {
    if (!silent) setLoadingBal(true);
    try {
      const bal = await getXLMBalance(pk);
      setBalance(bal);
    } catch {
      // keep last known balance on transient errors
    } finally {
      if (!silent) setLoadingBal(false);
    }
  }, []);

  const hydrateNetwork = useCallback(async () => {
    try {
      const net = await getFreighterNetwork();
      setNetwork(net);
    } catch {
      setNetwork("TESTNET");
    }
  }, []);

  // ── Auto-reconnect from localStorage ───────────────────────────────────────

  useEffect(() => {
    if (didMount.current) return;
    didMount.current = true;

    const savedKey = typeof window !== "undefined"
      ? localStorage.getItem(LS_PUBLIC_KEY)
      : null;
    const savedWalletId = (typeof window !== "undefined"
      ? localStorage.getItem(LS_WALLET_ID)
      : null) as WalletId | null;

    if (!savedKey) {
      // No saved key — nothing to restore, mark hydration done immediately
      setIsHydrated(true);
      return;
    }

    const restore = () => {
      // Point the kit at the wallet the user actually connected with, so signing
      // after a reload goes to the right extension (not always Freighter).
      try {
        getWalletsKit().setWallet(savedWalletId ?? FREIGHTER_ID);
      } catch {
        /* SSR guard — never reached in this client effect */
      }
      setPublicKey(savedKey);
      setSelectedWalletId(savedWalletId ?? FREIGHTER_ID);
      fetchBalance(savedKey);
      hydrateNetwork();
    };

    // Freighter exposes an install check, so we can verify + clear stale keys.
    // Other wallets restore optimistically (a missing wallet re-prompts on sign).
    if (!savedWalletId || savedWalletId === FREIGHTER_ID) {
      isFreighterInstalled().then((installed) => {
        if (!installed) {
          localStorage.removeItem(LS_PUBLIC_KEY);
          localStorage.removeItem(LS_WALLET_ID);
        } else {
          restore();
        }
        setIsHydrated(true);
      });
    } else {
      restore();
      setIsHydrated(true);
    }
  }, [fetchBalance, hydrateNetwork]);

  useEffect(() => {
    if (!publicKey) return;

    const interval = setInterval(() => {
      fetchBalance(publicKey, true);
    }, 15_000);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") fetchBalance(publicKey, true);
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [publicKey, fetchBalance]);


  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);

    try {
      // The kit modal handles per-wallet install detection, so we no longer
      // hard-gate on Freighter — any supported wallet can connect.
      const kit = getWalletsKit();
      let resolvedAddress = "";
      let chosenWalletId: WalletId = FREIGHTER_ID;
      let walletError: Error | null = null;

      await kit.openModal({
        modalTitle: "Connect Your Stellar Wallet",
        notAvailableText: "Install extension",

        onWalletSelected: async (wallet) => {
          kit.setWallet(wallet.id);
          chosenWalletId = wallet.id;
          const { address } = await kit.getAddress();
          resolvedAddress = address;
        },

        onClosed: () => {
          if (!resolvedAddress) walletError = new Error("Wallet selection cancelled.");
        },
      });

      if (walletError || !resolvedAddress) return;

      const net = await getFreighterNetwork().catch(() => "TESTNET");

      setPublicKey(resolvedAddress);
      setNetwork(net);
      setSelectedWalletId(chosenWalletId);
      localStorage.setItem(LS_PUBLIC_KEY, resolvedAddress);
      localStorage.setItem(LS_WALLET_ID, chosenWalletId);
      toastSuccess(
        "Wallet connected",
        `${resolvedAddress.slice(0, 6)}…${resolvedAddress.slice(-4)} on ${net === "PUBLIC" ? "Mainnet" : "Testnet"}`
      );

      fetchBalance(resolvedAddress);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to connect wallet.";
      const isCancelled =
        msg.toLowerCase().includes("cancel") ||
        msg.toLowerCase().includes("closed without");
      if (!isCancelled) {
        setError(msg);
        toastError("Connection failed", msg);
      }
    } finally {
      setIsConnecting(false);
    }
  }, [fetchBalance]);


  const disconnect = useCallback(() => {
    setPublicKey(null);
    setBalance(null);
    setNetwork(null);
    setError(null);
    setSelectedWalletId(null);
    toastInfo("Wallet disconnected");
    localStorage.removeItem(LS_PUBLIC_KEY);
  }, []);


  const refreshBalance = useCallback(async () => {
    if (!publicKey) return;
    await fetchBalance(publicKey);
  }, [publicKey, fetchBalance]);

  const clearError = useCallback(() => setError(null), []);

  const value: WalletContextType = {
    publicKey,
    balance,
    network,
    isConnected,
    isConnecting,
    isHydrated,
    isLoadingBalance,
    error,
    selectedWalletId,
    connect,
    disconnect,
    refreshBalance,
    clearError,
  };

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWalletContext(): WalletContextType {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWalletContext must be used within <WalletProvider />");
  return ctx;
}
