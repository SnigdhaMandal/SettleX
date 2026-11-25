/**
 * Server-side auth secrets, read lazily per request so missing env vars don't
 * break builds. Never prefix these with NEXT_PUBLIC_.
 */
import { DEFAULT_SESSION_TTL_SECONDS } from "@/lib/auth/constants";

export class AuthConfigError extends Error {}

/** Supabase JWT secret used to sign tokens accepted by PostgREST/Realtime. */
export function getJwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new AuthConfigError(
      "SUPABASE_JWT_SECRET is not set. Copy it from Supabase → Settings → API → JWT Secret.",
    );
  }
  return secret;
}

/**
 * HMAC secret for challenge nonces. Required in production to isolate it from
 * SUPABASE_JWT_SECRET; falls back to the JWT secret locally for convenience.
 */
export function getChallengeSecret(): string {
  const secret = process.env.AUTH_CHALLENGE_SECRET;
  if (secret) return secret;

  if (process.env.NODE_ENV === "production") {
    throw new AuthConfigError(
      "AUTH_CHALLENGE_SECRET is not set. It must be distinct from " +
        "SUPABASE_JWT_SECRET so the challenge and token-signing keys stay " +
        "separate. Generate one with: openssl rand -base64 48",
    );
  }

  return getJwtSecret();
}

/**
 * Max session lifetime (12h). Must stay below the 13h tombstone default in
 * `settlex_revoke_wallet` (supabase-setup.sql) so revoked tokens can't resurrect.
 */
export const MAX_SESSION_TTL_CAP_SECONDS = 12 * 60 * 60;

/** Access token lifetime in seconds, capped at 12h. */
export function getSessionTtlSeconds(): number {
  const raw = process.env.AUTH_SESSION_TTL_SECONDS;
  if (!raw) return DEFAULT_SESSION_TTL_SECONDS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_TTL_SECONDS;

  // Keep below the 13h revocation tombstone TTL in settlex_revoke_wallet
  return Math.min(Math.floor(parsed), MAX_SESSION_TTL_CAP_SECONDS);
}

/** Boot-time validation hook called from `instrumentation.ts`. */
export function assertAuthConfig(): void {
  getJwtSecret();
  getChallengeSecret();

  if (
    process.env.AUTH_CHALLENGE_SECRET &&
    process.env.AUTH_CHALLENGE_SECRET === process.env.SUPABASE_JWT_SECRET
  ) {
    throw new AuthConfigError(
      "AUTH_CHALLENGE_SECRET must not be the same value as SUPABASE_JWT_SECRET — " +
        "setting both to one key defeats the point of separating them.",
    );
  }
}
