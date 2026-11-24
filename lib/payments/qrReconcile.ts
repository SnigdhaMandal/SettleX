/**
 * Reconciles a share paid by scanning its QR code (Issue #204).
 *
 * A QR payment is made in another wallet app, so no transaction hash comes
 * back to SettleX on its own. The share owner pastes the hash, and it is
 * accepted only if Horizon shows a successful transaction that:
 *   - carries this share's identifying memo, which binds it to exactly this
 *     (expense, member) and stops an unrelated transfer being reused,
 *   - contains one native XLM payment operation from the debtor to the
 *     creditor for exactly the share amount, compared in stroops.
 *
 * The Horizon instance is network-specific, so a hash from another network
 * is simply not found.
 */

import { verifyTransactionOnHorizon } from "@/lib/stellar/verifyPayment";
import { xlmToStroops } from "@/lib/split/calculator";

export interface QrShareExpectation {
  txHash: string;
  /** The share owner, who sent the XLM. */
  debtorWallet: string;
  /** The member who paid the bill, who received it. */
  creditorWallet: string;
  /** Share amount in XLM. */
  amount: string;
  /** shareMemo(expenseId, memberId) */
  memo: string;
}

export type QrShareVerification =
  | { ok: true; ledger: number; txHash: string }
  | { ok: false; reason: string };

export function normalizeTxHash(input: string): string | null {
  const hash = input.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

const same = (a?: string, b?: string) =>
  Boolean(a && b && a.trim().toUpperCase() === b.trim().toUpperCase());

export async function verifyQrSharePayment(
  expected: QrShareExpectation,
): Promise<QrShareVerification> {
  const txHash = normalizeTxHash(expected.txHash);
  if (!txHash) {
    return { ok: false, reason: "That is not a Stellar transaction hash (64 hexadecimal characters)." };
  }

  const tx = await verifyTransactionOnHorizon(txHash);
  if (!tx.exists) {
    return {
      ok: false,
      reason: tx.error && !/not found/i.test(tx.error)
        ? "Could not reach Stellar to check this transaction. Try again shortly."
        : "No transaction with this hash exists on this network. Check the hash, and that you paid on the right network.",
    };
  }
  if (!tx.successful) {
    return { ok: false, reason: "This transaction failed on the Stellar network, so no XLM moved." };
  }
  if (tx.memo !== expected.memo) {
    return { ok: false, reason: "This transaction's memo does not match this share. Pay with this share's QR code." };
  }

  let expectedStroops: bigint;
  try {
    expectedStroops = xlmToStroops(expected.amount);
  } catch {
    return { ok: false, reason: "This share's amount is invalid." };
  }

  const matching = (tx.operations ?? []).some((op) => {
    if (op.type !== "payment" || op.assetType !== "native") return false;
    if (!same(op.to, expected.creditorWallet)) return false;
    const from = op.from ?? tx.sourceAccount;
    if (!same(from, expected.debtorWallet)) return false;
    try {
      return op.amount !== undefined && xlmToStroops(op.amount) === expectedStroops;
    } catch {
      return false;
    }
  });
  if (!matching) {
    return {
      ok: false,
      reason: "This transaction is not an XLM payment of this share's exact amount from the share's wallet to the member who paid.",
    };
  }

  return { ok: true, ledger: tx.ledger ?? 0, txHash };
}
