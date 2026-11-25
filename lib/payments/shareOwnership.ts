/**
 * Ownership rules for paying a share.
 *
 * Only the debtor's own connected wallet can pay their share, because both
 * `markSharePaid` and the contract's `record_payment` / `is_paid` duplicate
 * guard key the record by the sender's wallet. Both the UI and `payShare`
 * share this check so buttons never offer an action `payShare` would reject.
 */
import type { SplitShare } from "@/types/expense";

/** Stellar account IDs are case-insensitive base32; compare them normalized. */
export function sameWallet(a?: string | null, b?: string | null): boolean {
  const x = a?.trim().toUpperCase();
  const y = b?.trim().toUpperCase();
  return Boolean(x && y && x === y);
}

export interface SharePaymentCheck {
  share: Pick<SplitShare, "walletAddress" | "name">;
  /** Currently connected wallet; null/undefined means nobody can pay. */
  connectedWallet?: string | null;
  /** Wallet of the member who paid the bill. */
  creditorWallet?: string | null;
}

/**
 * Returns a user-facing reason if the connected wallet cannot pay this share,
 * or null if it can.
 */
export function sharePaymentDenial({ share, connectedWallet, creditorWallet }: SharePaymentCheck): string | null {
  if (!connectedWallet) return "Connect your Stellar wallet to pay your share.";
  if (!share.walletAddress) return `${share.name} doesn't have a Stellar address.`;
  if (!sameWallet(connectedWallet, share.walletAddress)) {
    return `Only ${share.name} can pay this share, from their own wallet.`;
  }
  if (!creditorWallet) return "The expense creator hasn't added their Stellar address.";
  if (sameWallet(share.walletAddress, creditorWallet)) {
    return "The member who paid the bill does not owe a share to themselves.";
  }
  return null;
}

/** True only when the connected wallet owns this share and someone else is owed it. */
export function canWalletPayShare(check: SharePaymentCheck): boolean {
  return sharePaymentDenial(check) === null;
}
