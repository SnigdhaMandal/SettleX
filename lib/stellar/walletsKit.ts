import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import {
  FreighterModule,
  FREIGHTER_ID as KIT_FREIGHTER_ID,
} from "@creit.tech/stellar-wallets-kit/modules/freighter";
import {
  LobstrModule,
  LOBSTR_ID as KIT_LOBSTR_ID,
} from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import {
  RabetModule,
  RABET_ID,
} from "@creit.tech/stellar-wallets-kit/modules/rabet";
import {
  xBullModule,
  XBULL_ID,
} from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { Networks } from "@creit.tech/stellar-wallets-kit/types";
import { getE2EWalletAdapter } from "@/lib/stellar/e2eWalletAdapter";
import {
  NETWORK_PASSPHRASE,
  LS_PUBLIC_KEY,
  type StellarNetwork,
  normalizeStellarNetwork,
} from "@/lib/utils/constants";

export const FREIGHTER_ID = KIT_FREIGHTER_ID;
export const LOBSTR_ID = KIT_LOBSTR_ID;
export { XBULL_ID, RABET_ID };
export type WalletId = string;

export const TESTED_WALLET_IDS = [
  KIT_FREIGHTER_ID,
  XBULL_ID,
  KIT_LOBSTR_ID,
  RABET_ID,
] as const;

export function getTestedModules() {
  return [
    new FreighterModule(),
    new xBullModule(),
    new LobstrModule(),
    new RabetModule(),
  ];
}

export interface WalletModalOptions {
  onWalletSelected: (wallet: { id: WalletId }) => Promise<void> | void;
  onClosed?: () => void;
  modalTitle?: string;
  notAvailableText?: string;
}

export interface WalletsKitAdapter {
  setWallet(id: WalletId): void;
  getSelectedWalletId(): WalletId;
  supportsNetworkDetection(walletId?: WalletId): boolean;
  openModal(opts: WalletModalOptions): Promise<void>;
  getAddress(): Promise<{ address: string }>;
  getAddressSilently(): Promise<string | null>;
  signTransaction(
    xdr: string,
    options?: { address?: string; networkPassphrase?: string },
  ): Promise<{ signedTxXdr: string; signerAddress?: string }>;
  getNetworkFromWallet(): Promise<StellarNetwork>;
}

let initialized = false;
let selectedWalletId: WalletId = FREIGHTER_ID;

function normalizeNetworkResponse(value: unknown): StellarNetwork | null {
  const direct = normalizeStellarNetwork(value);
  if (direct || !value || typeof value !== "object") return direct;

  const response = value as Record<string, unknown>;
  return (
    normalizeStellarNetwork(response.networkPassphrase) ??
    normalizeStellarNetwork(response.passphrase) ??
    normalizeStellarNetwork(response.network)
  );
}

async function readInjectedWalletNetwork(): Promise<StellarNetwork | null> {
  if (selectedWalletId === XBULL_ID) {
    const provider = (
      window as typeof window & {
        xBullSDK?: { getNetwork?: () => Promise<unknown> };
      }
    ).xBullSDK;
    if (provider?.getNetwork) {
      return normalizeNetworkResponse(await provider.getNetwork());
    }
  }

  if (selectedWalletId === RABET_ID) {
    const provider = (
      window as typeof window & {
        rabet?: { getNetwork?: () => Promise<unknown> };
      }
    ).rabet;
    if (provider?.getNetwork) {
      return normalizeNetworkResponse(await provider.getNetwork());
    }
  }

  return null;
}

function initializeKit(): void {
  if (initialized) return;

  StellarWalletsKit.init({
    modules: getTestedModules(),
    selectedWalletId,
    network:
      NETWORK_PASSPHRASE === Networks.PUBLIC
        ? Networks.PUBLIC
        : Networks.TESTNET,
    authModal: {
      showInstallLabel: true,
      hideUnsupportedWallets: false,
    },
  });
  initialized = true;
}

/**
 * Small adapter around the v2 static API. Network reads deliberately delegate
 * to the selected wallet module and never substitute the app's configured
 * network: an unavailable read must remain "unverified" so callers fail
 * closed instead of presenting a false match.
 */
const walletsKit: WalletsKitAdapter = {
  setWallet(id: WalletId): void {
    StellarWalletsKit.setWallet(id);
    selectedWalletId = id;
  },

  getSelectedWalletId(): WalletId {
    return selectedWalletId;
  },

  supportsNetworkDetection(walletId: WalletId = selectedWalletId): boolean {
    return walletId !== KIT_LOBSTR_ID;
  },

  async openModal(opts: WalletModalOptions): Promise<void> {
    try {
      await StellarWalletsKit.authModal();
      selectedWalletId = StellarWalletsKit.selectedModule.productId;
      await opts.onWalletSelected({ id: selectedWalletId });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "object" && error && "message" in error
            ? String(error.message)
            : "";

      if (/closed|cancel/i.test(message)) {
        opts.onClosed?.();
        return;
      }
      throw error;
    }
  },

  getAddress(): Promise<{ address: string }> {
    return StellarWalletsKit.getAddress();
  },

  async getAddressSilently(): Promise<string | null> {
    if (selectedWalletId === FREIGHTER_ID) {
      try {
        const { address } = await StellarWalletsKit.selectedModule.getAddress({
          skipRequestAccess: true,
        });
        return address || null;
      } catch {
        return null;
      }
    }

    if (selectedWalletId === XBULL_ID) {
      const provider = (
        window as typeof window & {
          xBullSDK?: { getAddress?: () => Promise<{ address?: string } | string> };
        }
      ).xBullSDK;
      if (provider?.getAddress) {
        try {
          const res = await provider.getAddress();
          const addr = typeof res === "string" ? res : res?.address;
          return addr || null;
        } catch {
          return null;
        }
      }
    }

    if (selectedWalletId === RABET_ID) {
      const provider = (
        window as typeof window & {
          rabet?: { getActiveAccount?: () => Promise<string | { publicKey?: string }> };
        }
      ).rabet;
      if (provider?.getActiveAccount) {
        try {
          const res = await provider.getActiveAccount();
          const addr = typeof res === "string" ? res : res?.publicKey;
          return addr || null;
        } catch {
          return null;
        }
      }
    }

    return null;
  },

  signTransaction(
    xdr: string,
    options?: { address?: string; networkPassphrase?: string },
  ): Promise<{ signedTxXdr: string; signerAddress?: string }> {
    let address = options?.address;
    if (!address && typeof window !== "undefined") {
      address = localStorage.getItem(LS_PUBLIC_KEY) || "";
    }
    return StellarWalletsKit.signTransaction(xdr, {
      ...options,
      address: address || "",
    });
  },

  async getNetworkFromWallet(): Promise<StellarNetwork> {
    // The current kit adapters omit getNetwork for xBull and Rabet even though
    // their injected providers expose it, so read those providers directly.
    const injectedNetwork = await readInjectedWalletNetwork();
    if (injectedNetwork) return injectedNetwork;

    const result = await StellarWalletsKit.getNetwork();
    const network = normalizeNetworkResponse(result);

    if (!network) {
      throw new Error("The selected wallet returned an unsupported Stellar network.");
    }
    return network;
  },
};

export function getWalletsKit(): WalletsKitAdapter {
  if (typeof window === "undefined") {
    throw new Error("StellarWalletsKit requires a browser environment.");
  }

  // This adapter is selected only by the dedicated E2E build flag. It signs
  // real Stellar XDR with a test-generated key; production builds use the
  // actual wallet kit below.
  if (process.env.NEXT_PUBLIC_E2E_TEST_WALLET === "true") {
    return getE2EWalletAdapter();
  }

  initializeKit();
  return walletsKit;
}
