/**
 * Server-side secrets for the wallet authentication handshake.
 *
 * Every value here is read lazily inside a request handler so a missing secret
 * fails that request rather than the whole build. None of these may ever be
 * prefixed with `NEXT_PUBLIC_` — that would ship them in the browser bundle and
 * let anyone mint their own tokens.
 */
import { DEFAULT_SESSION_TTL_SECONDS } from "@/lib/auth/constants";

export class AuthConfigError extends Error {}

/**
 * The Supabase project's JWT secret (Dashboard → Settings → API → JWT Secret).
 * Tokens signed with it are accepted by PostgREST and Realtime.
 */
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
 * Key used to bind a challenge nonce to a wallet. Falls back to the JWT secret
 * so a minimal deployment only has to configure one value.
 */
export function getChallengeSecret(): string {
  return process.env.AUTH_CHALLENGE_SECRET || getJwtSecret();
}

/** Lifetime of an issued access token, in seconds. */
export function getSessionTtlSeconds(): number {
  const raw = process.env.AUTH_SESSION_TTL_SECONDS;
  if (!raw) return DEFAULT_SESSION_TTL_SECONDS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_TTL_SECONDS;

  // Cap at 12h so a typo cannot mint a near-permanent token. Tokens are
  // bearer credentials for a money app; the denylist only helps for sessions
  // the user explicitly signs out of, so the ceiling stays low.
  return Math.min(Math.floor(parsed), 12 * 60 * 60);
}
