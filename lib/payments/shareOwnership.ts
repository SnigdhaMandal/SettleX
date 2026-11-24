/**
 * Who may pay which share (Issue #208).
 *
 * A share is paid by its debtor, the member whose wallet is on the share, to
 * the expense's creditor, the member who paid the bill. Only the debtor's own
 * connected wallet may pay it:
 *
 *  - the payment is recorded against the share as the debtor's (`markSharePaid`
 *    and the contract's `record_payment` both key the record by the sender),
 *    so a third party paying would record the wrong person;
 *  - the on-chain duplicate guard (`is_paid`) is keyed by the debtor's wallet,
 *    so it only works when sender and share owner are the same account.
 *
 * The UI (whether a Pay button or QR code is shown) and `payShare` both use
 * this one rule, so the button can never offer what the action would refuse.
 */
import type { SplitShare } from "@/types/expense";

/** Stellar account ids are case-insensitive base32; compare them normalised. */
export function sameWallet(a?: string | null, b?: string | null): boolean {
  const x = a?.trim().toUpperCase();
  const y = b?.trim().toUpperCase();
  return Boolean(x && y && x === y);
}

export interface SharePaymentCheck {
  share: Pick<SplitShare, "walletAddress" | "name">;
  /** The wallet connected right now; null/undefined means nobody may pay. */
  connectedWallet?: string | null;
  /** The creditor: the wallet of the member who paid the bill. */
  creditorWallet?: string | null;
}

/**
 * Why the connected wallet may not pay this share, or null if it may.
 * The messages are written for users and safe to show in a toast.
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
