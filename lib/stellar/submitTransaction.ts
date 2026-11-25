import { TransactionBuilder } from "@stellar/stellar-sdk";
import { server } from "./client";
import { HORIZON_URL, NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import type { StellarSubmitResult, HorizonErrorResponse } from "@/types/stellar";

export type { StellarSubmitResult };

function friendlyOpError(code: string): string {
  const map: Record<string, string> = {
    op_underfunded: "Insufficient XLM balance to complete this payment.",
    op_insufficient_balance: "Insufficient XLM balance to complete this payment.",
    op_no_destination: "The recipient account doesn't exist on the Stellar network.",
    op_no_trust: "The recipient hasn't set up a trustline for this asset.",
    op_line_full: "The recipient's account cannot receive more of this asset.",
    op_not_authorized: "You are not authorised to send to this account.",
    op_malformed: "Transaction is malformed — check the amount and addresses.",
  };
  return map[code] ?? `Operation failed: ${code}`;
}

export function extractTxHash(tx: any): string {
  try {
    if (typeof tx?.hash === "function") {
      const h = tx.hash();
      return typeof h === "string" ? h : h?.toString("hex") || "";
    }
  } catch {
    // ignore if tx doesn't expose hash()
  }
  return "";
}

/**
 * Thrown when a submission's outcome is unknown: Horizon timed out, the
 * connection dropped, or it reported a sequence race, and polling by hash did
 * not find the transaction either. The transaction may still land, so callers
 * must not treat this like a definitive rejection (the money may have moved).
 */
export class SubmissionIndeterminateError extends Error {
  readonly txHash: string;

  constructor(message: string, txHash: string) {
    super(message);
    this.name = "SubmissionIndeterminateError";
    this.txHash = txHash;
  }
}

export function isSubmissionIndeterminate(err: unknown): boolean {
  return err instanceof Error && err.name === "SubmissionIndeterminateError";
}

export interface SignedTransactionInfo {
  /** Lowercase hex hash, identical to the one Horizon will report. */
  hash: string;
  /** ISO time after which the transaction can no longer be included, if bounded. */
  validUntil: string | null;
}

/**
 * Reads the hash and expiry of a signed transaction before it is submitted.
 * The hash is fixed once signed, so it can be persisted ahead of submission
 * and used to reconcile with Horizon if the app dies mid-payment.
 */
export function inspectSignedTransaction(signedXDR: string): SignedTransactionInfo {
  const tx = TransactionBuilder.fromXDR(signedXDR, NETWORK_PASSPHRASE);
  const hash = extractTxHash(tx).toLowerCase();
  if (!hash) throw new Error("Could not read the signed transaction hash.");

  const maxTime = Number((tx as { timeBounds?: { maxTime?: string } }).timeBounds?.maxTime ?? 0);
  const validUntil = Number.isFinite(maxTime) && maxTime > 0
    ? new Date(maxTime * 1000).toISOString()
    : null;

  return { hash, validUntil };
}

export async function pollTransactionByHash(
  txHash: string,
  maxWaitMs = 25000,
  intervalMs = 2000
): Promise<StellarSubmitResult | null> {
  if (!txHash) return null;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    try {
      if (typeof server?.transactions === "function" && typeof server.transactions().transaction === "function") {
        const txRecord = await server.transactions().transaction(txHash).call();
        if (txRecord && txRecord.successful !== false) {
          return {
            hash: txRecord.hash || txHash,
            ledger: (txRecord as any).ledger_attr ?? (txRecord as any).ledger ?? 0,
            successful: true,
          };
        } else if (txRecord && txRecord.successful === false) {
          throw new Error("Transaction was included in a ledger but failed on-chain.");
        }
      } else {
        const res = await fetch(`${HORIZON_URL}/transactions/${txHash}?_ts=${Date.now()}`, {
          cache: "no-store",
        });
        if (res.ok) {
          const txRecord = await res.json();
          if (txRecord && txRecord.successful !== false) {
            return {
              hash: txRecord.hash || txHash,
              ledger: txRecord.ledger_attr ?? txRecord.ledger ?? 0,
              successful: true,
            };
          }
        }
      }
    } catch (err: any) {
      if (err?.message?.includes("included in a ledger but failed")) {
        throw err;
      }
      // 404 just means it hasn't landed in a closed ledger yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return null;
}

function isDefinitiveFailure(err: unknown): { isDefinitive: boolean; message?: string } {
  const horizonErr = err as {
    response?: {
      status?: number;
      data?: HorizonErrorResponse;
    };
    status?: number;
  };

  const status = horizonErr?.response?.status ?? horizonErr?.status;
  const extras = horizonErr?.response?.data?.extras;

  // Gateway/server timeouts may still land on-chain
  if (status === 504 || status === 502 || status === 503 || status === 500) {
    return { isDefinitive: false };
  }

  if (extras?.result_codes) {
    const { transaction, operations } = extras.result_codes;
    const opCode = operations?.[0];

    if (opCode && opCode !== "op_success") {
      return { isDefinitive: true, message: friendlyOpError(opCode) };
    }

    if (transaction === "tx_insufficient_fee") {
      return { isDefinitive: true, message: "Transaction fee too low for current network conditions. Please try again." };
    }
    if (transaction === "tx_bad_auth" || transaction === "tx_bad_auth_extra") {
      return { isDefinitive: true, message: "Transaction signature is invalid." };
    }
    if (transaction === "tx_too_late") {
      return { isDefinitive: true, message: "Transaction expired before being included in a ledger. Please try again." };
    }
    if (transaction === "tx_too_early") {
      return { isDefinitive: true, message: "Transaction time bound is in the future." };
    }
    if (transaction === "tx_no_source_account") {
      return { isDefinitive: true, message: "Source account does not exist." };
    }
    if (transaction === "tx_insufficient_balance") {
      return { isDefinitive: true, message: "Insufficient XLM balance to pay transaction fees." };
    }

    // tx_bad_seq can happen on retry if the first attempt actually went through
    if (transaction === "tx_bad_seq") {
      return { isDefinitive: false, message: "Transaction sequence mismatch. Please try again." };
    }

    if (transaction && transaction !== "tx_success" && transaction !== "tx_timeout") {
      return { isDefinitive: true, message: `Transaction failed: ${transaction}` };
    }
  }

  // Network drops / timeouts without a response are indeterminate
  return { isDefinitive: false };
}

export async function submitSignedTransaction(
  signedXDR: string,
  options?: { maxPollWaitMs?: number; pollIntervalMs?: number }
): Promise<StellarSubmitResult> {
  const tx = TransactionBuilder.fromXDR(signedXDR, NETWORK_PASSPHRASE);
  const txHash = extractTxHash(tx);

  try {
    const response = await server.submitTransaction(tx);
    return {
      hash: response.hash || txHash,
      ledger: response.ledger,
      successful: true,
    };
  } catch (err: unknown) {
    const check = isDefinitiveFailure(err);

    if (check.isDefinitive && check.message) {
      throw new Error(check.message);
    }

    // Might have landed despite the error, so poll by hash before giving up
    if (txHash) {
      const pollResult = await pollTransactionByHash(
        txHash,
        options?.maxPollWaitMs ?? 25000,
        options?.pollIntervalMs ?? 2000
      );

      if (pollResult && pollResult.successful) {
        return pollResult;
      }
    }

    if (check.message) {
      throw new SubmissionIndeterminateError(check.message, txHash);
    }

    throw new SubmissionIndeterminateError(
      "Transaction submission timed out. The network might still be processing your transaction. " +
      "Please check your transaction history or wait a moment before trying again to avoid duplicate payments.",
      txHash,
    );
  }
}
