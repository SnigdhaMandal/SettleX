/**
 * Strips secrets and PII before anything hits a log line or error reporter.
 *
 * Auth and payment catch paths handle signed XDR, bearer tokens, JWT secrets,
 * and wallet addresses, so redaction happens centrally before emit. Wallet
 * addresses are truncated to a short prefix/suffix so requests can still be
 * correlated without exposing full addresses alongside amounts.
 */

const SECRET_KEY_PATTERN =
  /secret|token|password|passphrase|authorization|auth[-_]?key|api[-_]?key|cookie|signature|signed|xdr|private|seed|mnemonic|jwt|credential/i;

// PostgREST sticks rejected row data (amounts, wallet addresses) in details/hint,
// so drop these raw fields at the boundary.
const ROW_DATA_KEY_PATTERN = /^(details|hint|body|payload|row|values)$/i;

const WALLET_KEY_PATTERN = /wallet|publickey|public[-_]key|address|account/i;

export const REDACTED = "[redacted]";

const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 512; // prevents huge XDR blobs from flooding logs

/** Truncates a Stellar address to `GABC12…WXYZ` so it's correlatable without leaking the full key. */
export function maskWalletAddress(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

const STELLAR_ADDRESS_IN_TEXT = /\b[GC][A-Z2-7]{55}\b/g;
const BEARER_IN_TEXT = /\bBearer\s+[\w-]+\.?[\w-]*\.?[\w-]*/gi;
const JWT_IN_TEXT = /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}\b/g;

/** Scrubs tokens, JWTs, and Stellar addresses out of free-text strings (e.g. error messages). */
export function redactText(input: string): string {
  let out = input
    .replace(JWT_IN_TEXT, REDACTED)
    .replace(BEARER_IN_TEXT, `Bearer ${REDACTED}`)
    .replace(STELLAR_ADDRESS_IN_TEXT, (match) => maskWalletAddress(match));

  if (out.length > MAX_STRING_LENGTH) {
    out = `${out.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
  }
  return out;
}

/**
 * Deep-copies `value`, masking wallet addresses and replacing secret-looking
 * fields with `[redacted]`. Non-plain objects collapse to their type name so
 * clients/request instances don't accidentally dump credentials.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();

  if (depth >= MAX_DEPTH) return "[depth limit]";

  if (value instanceof Error) {
    // Allowlist only safe Error fields — PostgREST errors attach row values in details/hint
    const code = (value as Error & { code?: unknown }).code;
    return {
      name: value.name,
      message: redactText(value.message),
      code: typeof code === "string" || typeof code === "number" ? code : undefined,
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => redact(entry, depth + 1));
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source); // own enumerable keys only
    if (keys.length === 0) return {};

    const out: Record<string, unknown> = {};
    for (const key of keys.slice(0, 50)) {
      const entry = source[key];

      if (SECRET_KEY_PATTERN.test(key) || ROW_DATA_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
        continue;
      }

      if (WALLET_KEY_PATTERN.test(key) && typeof entry === "string") {
        out[key] = maskWalletAddress(entry);
        continue;
      }

      out[key] = redact(entry, depth + 1);
    }
    return out;
  }

  return `[${typeof value}]`;
}
