/**
 * Build an unsigned Stellar payment transaction (XDR).
 */
import {
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  Networks,
  Account,
} from "@stellar/stellar-sdk";
import {
  NETWORK_PASSPHRASE,
  TX_BASE_FEE,
  TX_TIMEOUT_SECONDS,
  TX_MAX_FEE_STROOPS,
  MEMO_MAX_BYTES,
  MEMO_PREFIX,
  HORIZON_URL,
} from "@/lib/utils/constants";

export interface BuildTxParams {
  sourcePublicKey: string;
  destinationPublicKey: string;
  amount: string;
  memoText?: string;
  customFee?: string;
}

export interface BuildTxResult {
  xdr: string;
  memo: string;
  fee: string;
}

export async function fetchSuggestedFee(): Promise<string> {
  try {
    const res = await fetch(`${HORIZON_URL}/fee_stats?_ts=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (res.ok) {
      const stats = (await res.json()) as {
        fee_charged?: { mode?: string; p70?: string; p90?: string; min?: string };
        min_accepted_fee?: string;
      };
      const rawCandidate = Number(
        stats.fee_charged?.p70 ||
          stats.fee_charged?.mode ||
          stats.min_accepted_fee ||
          TX_BASE_FEE
      );
      if (!isNaN(rawCandidate) && rawCandidate > 0) {
        // Apply 1.5x congestion multiplier with reasonable ceiling
        const buffered = Math.ceil(rawCandidate * 1.5);
        const clamped = Math.min(Math.max(TX_BASE_FEE, buffered), TX_MAX_FEE_STROOPS);
        return String(clamped);
      }
    }
  } catch {
    // Fall back to a safe default above network minimum during offline/mock tests
  }
  return String(Math.max(TX_BASE_FEE, 1000));
}

function trimToMemoBytes(text: string, maxBytes: number = MEMO_MAX_BYTES): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

export async function buildPaymentTransaction({
  sourcePublicKey,
  destinationPublicKey,
  amount,
  memoText,
  customFee,
}: BuildTxParams): Promise<BuildTxResult> {
  const [acctRes, suggestedFee] = await Promise.all([
    fetch(`${HORIZON_URL}/accounts/${sourcePublicKey}?_ts=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    }),
    customFee ? Promise.resolve(customFee) : fetchSuggestedFee(),
  ]);

  if (!acctRes.ok) {
    throw new Error(
      `Failed to load account from Horizon (${acctRes.status}). Check your Stellar address and network.`
    );
  }
  const acctData = (await acctRes.json()) as { sequence: string };
  const account = new Account(sourcePublicKey, acctData.sequence);

  const rawMemo = memoText ? `${MEMO_PREFIX}|${memoText}` : MEMO_PREFIX;
  const safeMemo = trimToMemoBytes(rawMemo);

  const tx = new TransactionBuilder(account, {
    fee: suggestedFee,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: Asset.native(),
        amount,
      })
    )
    .addMemo(Memo.text(safeMemo))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  return { xdr: tx.toXDR(), memo: safeMemo, fee: suggestedFee };
}
