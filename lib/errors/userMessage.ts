/**
 * Allowlist for what `app/error.tsx` can safely show a user.
 *
 * Some app paths throw human-readable errors ("Wallet not connected",
 * "Lobstr extension is not installed"), while Supabase/PostgREST paths re-throw
 * raw DB errors that leak schema or RLS details. Only messages that look
 * intentionally written for users pass through; everything else falls back to
 * a generic line while the raw error goes to the logger.
 */

/** Fallback shown when the underlying error isn't safe to expose. */
export const GENERIC_USER_MESSAGE =
  "An unexpected error occurred. Please try again.";

// Disqualifies machine-generated or internal text before prose checks run.
const INTERNAL_MARKERS = [
  // Postgres / PostgREST
  /row-level security/i,
  /violates .*constraint/i,
  /duplicate key value/i,
  /relation ".*" does not exist/i,
  /column ".*" of relation/i,
  /permission denied for (table|relation|schema)/i,
  /\bpgrst\d+\b/i,
  /\bsqlstate\b/i,
  /^\d{5}$/, // bare Postgres error code, e.g. "42501"
  /supabase/i,
  /postgrest/i,
  // Stack traces, file paths, framework internals
  /\bat [\w$.]+ \(/,
  /\.(ts|tsx|js|jsx|mjs):\d+/,
  /node_modules/,
  /webpack/i,
  /\bhydrat(e|ion)\b/i,
  /minified react error/i,
  // Transport failures
  /^(typeerror|referenceerror|syntaxerror|rangeerror|networkerror)\b/i,
  /failed to fetch/i,
  /\bnetworkerror\b/i,
  /\beconnrefused\b|\betimedout\b|\benotfound\b/i,
  // JSON / serialized payloads
  /^[[{]/,
  /\{"[\w]+":/,
  // Tokens or Stellar keys that shouldn't appear in UI copy
  /\beyJ[\w-]{6,}\./,
  /\bbearer\b/i,
  /\b[GC][A-Z2-7]{55}\b/,
  // Dev-facing invariants
  /must be used within/i,
  /is not a function\b/i,
  /cannot read propert/i,
  /undefined is not/i,
  // Infra/auth jargon — session expiry copy belongs in the auth flow
  /\bjwt\b/i,
  /\b(access|refresh|bearer) token\b/i,
  /\brls\b/i,
  /\brole\b.*\bkey\b/i,
  /\bapi key\b/i,
  /\bclaim\b/i,
  /\b(5\d{2}|4\d{2}) (error|status)\b/i,
];

// Prose check: starts with a cap or digit, no braces/angle brackets/backticks/double quotes.
// '#' is allowed for numbered contract fallbacks like "Contract error #137.".
const LOOKS_LIKE_PROSE = /^[A-Z0-9][A-Za-z0-9 ,.'’\-—–:()!?/%+#]*$/;

const MIN_LENGTH = 8;
const MAX_LENGTH = 160;

/** Returns true when `message` is safe to show to a user. */
export function isUserFacingMessage(message: unknown): message is string {
  if (typeof message !== "string") return false;

  const trimmed = message.trim();
  if (trimmed.length < MIN_LENGTH || trimmed.length > MAX_LENGTH) return false;
  if (/[\r\n]/.test(trimmed)) return false; // multi-line text is usually a stack/dump

  for (const marker of INTERNAL_MARKERS) {
    if (marker.test(trimmed)) return false;
  }

  return LOOKS_LIKE_PROSE.test(trimmed);
}

/**
 * Returns a user-safe message for `error`, plus `wasSuppressed` so callers
 * can log when internal details were hidden.
 */
export function userFacingMessage(error: unknown): {
  message: string;
  wasSuppressed: boolean;
} {
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : undefined;

  if (isUserFacingMessage(raw)) {
    return { message: raw.trim(), wasSuppressed: false };
  }

  return { message: GENERIC_USER_MESSAGE, wasSuppressed: true };
}
