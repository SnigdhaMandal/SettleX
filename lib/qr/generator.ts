/**
 * SEP-0007 compliant QR payment URI builder.
 * web+stellar:pay? URIs are understood by Freighter, Lobstr, and most
 * Stellar wallets — scanning the QR auto-fills the payment form.
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 *
 * Issue #204:
 * - SEP-0007 wallets assume the PUBLIC network when `network_passphrase` is
 *   missing, so a testnet QR scanned in a Mainnet wallet could move real XLM.
 *   The passphrase is now always included.
 * - Values are percent-encoded with encodeURIComponent (`%20`, never `+`);
 *   URLSearchParams form-encoding made memos look wrong in wallets.
 * - The amount is normalised to the exact 7-decimal value being requested.
 *
 * `origin_domain` + `signature` are not emitted: they require a URI request
 * signing key published in the app's stellar.toml, which this deployment does
 * not have. Wallets therefore show the request as unsigned.
 */

import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import { stroopsToXlm, xlmToStroops } from "@/lib/split/calculator";

export interface QRPaymentData {
  /** Destination Stellar address (G…): the CREDITOR who receives the XLM. */
  destination: string;
  /** XLM amount as string e.g. "300.0000000" */
  amount: string;
  /** Text memo, at most 28 bytes (the identifying share memo). */
  memo?: string;
  /** Defaults to the app's configured network. */
  networkPassphrase?: string;
}

/** Exact 7-decimal amount string, e.g. "1.5" -> "1.5000000". */
export function normalizeQRAmount(amount: string): string {
  return stroopsToXlm(xlmToStroops(amount));
}

/**
 * Returns a `web+stellar:pay?…` URI.
 * Any SEP-0007-compatible wallet can parse this to pre-fill the payment.
 */
export function buildQRPaymentURI({
  destination,
  amount,
  memo,
  networkPassphrase = NETWORK_PASSPHRASE,
}: QRPaymentData): string {
  const params: Array<[string, string]> = [
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

/** Parses a `web+stellar:pay?…` URI back into its decoded parameters. */
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
