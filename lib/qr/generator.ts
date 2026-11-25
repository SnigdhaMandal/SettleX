/**
 * SEP-0007 QR payment URI builder (`web+stellar:pay?...`) for Freighter, Lobstr, etc.
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 *
 * Always includes `network_passphrase` because wallets assume PUBLIC if omitted,
 * which would risk moving real XLM on a testnet QR. Uses `encodeURIComponent`
 * rather than `URLSearchParams` so spaces stay `%20` instead of `+`.
 * `origin_domain` / `signature` are omitted since this deployment doesn't host
 * a signing key in `stellar.toml`.
 */

import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import { stroopsToXlm, xlmToStroops } from "@/lib/split/calculator";

export interface QRPaymentData {
  /** Destination Stellar address (G...): the creditor receiving the XLM. */
  destination: string;
  /** XLM amount string, e.g. "300.0000000". */
  amount: string;
  /** Text memo, max 28 bytes. */
  memo?: string;
  /** Defaults to the app's configured network. */
  networkPassphrase?: string;
}

/** Exact 7-decimal amount string, e.g. "1.5" -> "1.5000000". */
export function normalizeQRAmount(amount: string): string {
  return stroopsToXlm(xlmToStroops(amount));
}

/** Builds a SEP-0007 `web+stellar:pay?...` URI to pre-fill a wallet payment. */
export function buildQRPaymentURI({
  destination,
  amount,
  memo,
  networkPassphrase = NETWORK_PASSPHRASE,
}: QRPaymentData): string {
  const params: [string, string][] = [
    ["destination", destination],
    ["amount", normalizeQRAmount(amount)],
  ];
  if (memo) {
    params.push(["memo", memo], ["memo_type", "MEMO_TEXT"]);
  }
  params.push(["network_passphrase", networkPassphrase]);

  const query = params
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  return `web+stellar:pay?${query}`;
}

/** Parses a `web+stellar:pay?...` URI back into decoded key/value pairs. */
export function parseQRPaymentURI(uri: string): Record<string, string> {
  const prefix = "web+stellar:pay?";
  if (!uri.startsWith(prefix)) return {};

  const out: Record<string, string> = {};
  for (const pair of uri.slice(prefix.length).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : pair.slice(eq + 1);
    out[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return out;
}
