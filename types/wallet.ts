import type { StellarNetwork } from "@/lib/utils/constants";

export type WalletNetworkStatus =
  | "idle"
  | "checking"
  | "matched"
  | "mismatched"
  | "unavailable";

export interface WalletState {
  publicKey: string | null;
  balance: string | null;
  isConnecting: boolean;
  isConnected: boolean;
  isLoadingBalance: boolean;
  isHydrated: boolean;
  network: StellarNetwork | null;
  expectedNetwork: StellarNetwork;
  networkStatus: WalletNetworkStatus;
  isNetworkCompatible: boolean;
  networkMismatch: boolean;
  error: string | null;
  selectedWalletId: string | null;
}

export interface WalletActions {
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => Promise<void>;
  refreshNetwork: () => Promise<StellarNetwork | null>;
  confirmNetwork: () => void;
  clearError: () => void;
  reconcile: () => Promise<void>;
}

export type WalletContextType = WalletState & WalletActions;

export const WALLET_IDS = {
  FREIGHTER: "freighter",
  XBULL: "xbull",
  LOBSTR: "lobstr",
  RABET: "rabet",
} as const;

export type WalletId = (typeof WALLET_IDS)[keyof typeof WALLET_IDS] | string;
