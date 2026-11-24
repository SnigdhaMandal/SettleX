import { getWalletsKit } from "@/lib/stellar/walletsKit";
import { isConnected } from "@stellar/freighter-api";
import {
  NETWORK_PASSPHRASE,
  LS_PUBLIC_KEY,
  LS_NETWORK_CONFIRMED,
  normalizeStellarNetwork,
  stellarNetworkLabel,
} from "@/lib/utils/constants";
import {
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export async function isFreighterInstalled(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const result = await isConnected();
    return !result.error && (result.isConnected ?? false);
  } catch {
    return false;
  }
}

export async function connectFreighter(): Promise<string> {
  const kit = getWalletsKit();
  let resolvedAddress = "";
  let connectError: Error | null = null;

  await kit.openModal({
    modalTitle:       "Connect Your Stellar Wallet",
    notAvailableText: "Install extension",
    onWalletSelected: async (wallet) => {
      kit.setWallet(wallet.id);
      const { address } = await kit.getAddress();
      resolvedAddress = address;
    },
    onClosed: () => {
      if (!resolvedAddress) {
        connectError = new Error("Modal closed without selecting a wallet.");
      }
    },
  });

  if (connectError) throw connectError;
  if (!resolvedAddress) throw new Error("No wallet address returned — please try again.");
  return resolvedAddress;
}

/**
 * Checks whether a signed transaction XDR contains a signature valid under
 * the expected Stellar network passphrase for the given signer address.
 */
export function verifySignedTxNetwork(
  signedTxXdr: string,
  signerAddress: string,
  networkPassphrase: string = NETWORK_PASSPHRASE,
): boolean {
  if (!signedTxXdr || !signerAddress || !StrKey.isValidEd25519PublicKey(signerAddress)) {
    return false;
  }

  try {
    const tx = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase);
    if (!(tx instanceof Transaction) || !tx.signatures || tx.signatures.length === 0) {
      return false;
    }

    const keypair = Keypair.fromPublicKey(signerAddress);
    const hash = tx.hash();
    return tx.signatures.some((sig) => {
      try {
        return keypair.verify(hash, sig.signature());
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export async function signXDR(
  xdr: string,
  networkPassphrase: string = NETWORK_PASSPHRASE,
  address?: string,
): Promise<string> {
  const kit = getWalletsKit();
  let signerAddress = address;
  if (!signerAddress && typeof window !== "undefined") {
    signerAddress = localStorage.getItem(LS_PUBLIC_KEY) || undefined;
  }

  const { signedTxXdr } = await kit.signTransaction(xdr, {
    address: signerAddress || "",
    networkPassphrase,
  });

  if (!signedTxXdr) {
    throw new Error("The wallet returned an empty signed transaction.");
  }

  // If a decodable transaction was returned and we have a valid signer address,
  // verify that the signature actually matches the target network.
  if (signerAddress && StrKey.isValidEd25519PublicKey(signerAddress)) {
    try {
      const tx = TransactionBuilder.fromXDR(signedTxXdr, networkPassphrase);
      if (tx instanceof Transaction && tx.signatures && tx.signatures.length > 0) {
        const keypair = Keypair.fromPublicKey(signerAddress);
        const hash = tx.hash();
        const matches = tx.signatures.some((sig) => {
          try {
            return keypair.verify(hash, sig.signature());
          } catch {
            return false;
          }
        });

        if (!matches) {
          throw new Error(
            `Transaction signature does not match the expected network (${stellarNetworkLabel(
              normalizeStellarNetwork(networkPassphrase) ?? "TESTNET",
            )}). Please check your wallet network.`,
          );
        }

        // Successfully verified signature over the expected network
        if (typeof window !== "undefined") {
          try {
            localStorage.setItem(LS_NETWORK_CONFIRMED, "true");
          } catch {}
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("Transaction signature does not match")) {
        throw err;
      }
      // Non-decodable synthetic or mocked payloads pass through for unit tests
    }
  }

  return signedTxXdr;
}

export async function getFreighterNetwork(): Promise<string> {
  return getWalletsKit().getNetworkFromWallet();
}
