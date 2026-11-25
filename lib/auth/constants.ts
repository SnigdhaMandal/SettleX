/**
 * Shared non-secret constants for wallet auth (safe for client and server).
 */
import { APP_NAME } from "@/lib/utils/constants";

export const CHALLENGE_ENDPOINT = "/api/auth/challenge";
export const VERIFY_ENDPOINT = "/api/auth/verify";
export const SIGNOUT_ENDPOINT = "/api/auth/signout";

/** Challenge window in seconds — kept short to limit replay risk without a shared store. */
export const CHALLENGE_TTL_SECONDS = 60;

/**
 * Default access token lifetime in seconds. Kept short because leaked bearer
 * tokens stay valid until expiry; signing out only revokes explicit sessions.
 */
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;

/** Seconds before expiry to prompt the user to re-sign without interrupting requests. */
export const SESSION_REFRESH_SKEW_SECONDS = 5 * 60;

/** Tolerated browser/server clock drift, in seconds. */
export const CLOCK_SKEW_SECONDS = 30;

export const CHALLENGE_DATA_NAME = `${APP_NAME} auth`.slice(0, 64); // Stellar manageData key max 64 bytes

/** JWT claim carrying the verified Stellar address. */
export const WALLET_CLAIM = "wallet_address";

/** Request timeout in ms so a hung auth call doesn't stall the shared handshake promise forever. */
export const AUTH_REQUEST_TIMEOUT_MS = 15_000;

/** Legacy localStorage key removed after migrating to HttpOnly cookies. */
export const LS_SESSION = "settlex:session";
