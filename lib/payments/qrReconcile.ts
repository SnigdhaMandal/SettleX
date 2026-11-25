/**
 * Reconciles a share paid via QR code in an external wallet app.
 * Because external wallets don't return a tx hash to SettleX, the user pastes
 * it in and we verify on Horizon that it succeeded, carries this share's memo
 * (to prevent reusing unrelated transfers), and moves the exact stroop amount
 * from debtor to creditor on the active network.
 */

import { verifyTransactionOnHorizon } from "@/lib/stellar/verifyPayment";
import { xlmToStroops } from "@/lib/split/calculator";

export interface QrShareExpectation {
  txHash: string;
  /** Share owner who sent the XLM. */
  debtorWallet: string;
  /** Member who paid the bill and received the XLM. */
  creditorWallet: string;
  /** Share amount in XLM. */
  amount: string;
  /** `shareMemo(expenseId, memberId)` */
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

  // Compare in stroops so formatting differences like "1.5" vs "1.5000000" still match
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
