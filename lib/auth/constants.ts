/**
 * Shared, non-secret constants for the SEP-10 style wallet authentication
 * handshake. Safe to import from both client and server code.
 */
import { APP_NAME } from "@/lib/utils/constants";

/** Route that hands out a challenge transaction to sign. */
export const CHALLENGE_ENDPOINT = "/api/auth/challenge";

/** Route that verifies a signed challenge and mints a Supabase access token. */
export const VERIFY_ENDPOINT = "/api/auth/verify";

/** How long a challenge stays signable, in seconds. */
export const CHALLENGE_TTL_SECONDS = 300;

/** Default lifetime of an issued Supabase access token, in seconds. */
export const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * Re-authenticate this many seconds before the token actually expires so a
 * long-running request never lands on the server with a stale token.
 */
export const SESSION_REFRESH_SKEW_SECONDS = 60;

/** Tolerated clock drift between the browser and the server, in seconds. */
export const CLOCK_SKEW_SECONDS = 30;

/** `manage_data` key carried by the challenge transaction (max 64 bytes). */
export const CHALLENGE_DATA_NAME = `${APP_NAME} auth`.slice(0, 64);

/** JWT claim that carries the proven Stellar address. */
export const WALLET_CLAIM = "wallet_address";

/** localStorage key holding the cached access token. */
export const LS_SESSION = "settlex:session";
