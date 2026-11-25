/**
 * Classifies Supabase/PostgREST errors so RLS denials, auth expiries,
 * conflicts, and network drops can be counted separately.
 *
 * Key PostgREST codes: `42501` (insufficient_privilege / RLS violation),
 * `PGRST301` (JWT expired / unauthenticated).
 */

export type SupabaseFailureKind =
  | "rls_denied"
  | "unauthenticated"
  | "conflict"
  | "network"
  | "unknown";

interface PostgrestLike {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
}

function asPostgrest(error: unknown): PostgrestLike | null {
  if (typeof error !== "object" || error === null) return null;
  return error as PostgrestLike;
}

export function classifySupabaseError(error: unknown): SupabaseFailureKind {
  const candidate = asPostgrest(error);
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const message = (
    typeof candidate?.message === "string" ? candidate.message : String(error ?? "")
  ).toLowerCase();

  if (code === "42501" || /row-level security|violates row-level/.test(message)) {
    return "rls_denied";
  }
  if (code === "PGRST301" || code === "401" || /jwt|not authenticated|unauthorized/.test(message)) {
    return "unauthenticated";
  }
  if (code === "23505" || code === "23514" || /conflict|concurrent/.test(message)) {
    return "conflict";
  }
  if (/fetch|network|timeout|econn|failed to fetch/.test(message)) {
    return "network";
  }
  return "unknown";
}

/**
 * Extracts safe log fields (`kind` and `code`) from a Supabase error,
 * omitting `details` which can leak row values like amounts or wallet addresses.
 */
export function supabaseErrorFields(error: unknown): Record<string, unknown> {
  const candidate = asPostgrest(error);
  return {
    kind: classifySupabaseError(error),
    code: typeof candidate?.code === "string" ? candidate.code : undefined,
  };
}
