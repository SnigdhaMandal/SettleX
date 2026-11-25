import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import type { WalletsKitAdapter } from "@/lib/stellar/walletsKit";

const E2E_WALLET_ID = "settlex-e2e-wallet";

declare global {
  interface Window {
    /** Set by Playwright before navigation; never populated by the app. */
    __SETTLEX_E2E_WALLET_SECRET?: string;
  }
}

function getTestKeypair(): Keypair {
  const secret = window.__SETTLEX_E2E_WALLET_SECRET;
  if (!secret) {
    throw new Error("The Playwright test wallet was not initialized.");
  }
  return Keypair.fromSecret(secret);
}

/**
 * Test-only substitute for the wallet-kit API. It accepts no fixed address or
 * pre-signed payload: Playwright injects a freshly generated secret and this
 * adapter signs the actual XDR produced by the running application.
 */
export function getE2EWalletAdapter(): WalletsKitAdapter {
  return {
    setWallet() {},
    getSelectedWalletId: () => E2E_WALLET_ID,
    supportsNetworkDetection: () => true,
    async openModal(options) {
      await options.onWalletSelected({ id: E2E_WALLET_ID });
    },
    async getAddress() {
      return { address: getTestKeypair().publicKey() };
    },
    async getAddressSilently() {
      return getTestKeypair().publicKey();
    },
    async signTransaction(xdr, options) {
      const transaction = TransactionBuilder.fromXDR(
        xdr,
        options?.networkPassphrase ?? NETWORK_PASSPHRASE,
      );
      transaction.sign(getTestKeypair());
      return {
        signedTxXdr: transaction.toXDR(),
        signerAddress: getTestKeypair().publicKey(),
      };
    },
    async getNetworkFromWallet() {
      return "TESTNET";
    },
  };
}
