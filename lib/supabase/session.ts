/**
 * Wallet-authenticated Supabase sessions.
 *
 * A Supabase client is only trusted with a wallet identity after the wallet has
 * signed a server-issued challenge (`/api/auth/challenge` → `/api/auth/verify`)
 * and the server has minted a JWT carrying a `wallet_address` claim. RLS
 * policies read that claim, so an access token cannot be forged client-side the
 * way the old `x-wallet-address` request header could.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  CHALLENGE_ENDPOINT,
  LS_SESSION,
  SESSION_REFRESH_SKEW_SECONDS,
  VERIFY_ENDPOINT,
  WALLET_CLAIM,
} from "@/lib/auth/constants";
import { signXDR } from "@/lib/freighter";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export interface WalletSession {
  walletAddress: string;
  accessToken: string;
  /** Expiry in milliseconds since the epoch. */
  expiresAt: number;
}

/** Raised when the handshake could not complete (rejected signature, etc.). */
export class WalletSessionError extends Error {}

// ─── Token claims ─────────────────────────────────────────────────────────────

/**
 * The parts of the token this client trusts. They come from the JWT payload
 * itself, never from the JSON fields stored beside it.
 */
interface TokenClaims {
  walletAddress: string;
  /** Expiry in milliseconds since the epoch. */
  expiresAt: number;
}

/**
 * Decodes a JWT payload without verifying the signature.
 *
 * The signature cannot be checked here — the secret is server-side, which is
 * the whole point. That is fine: this is not an authorization decision. The
 * server re-verifies the token on every request and RLS authorizes on the real
 * claim, so a forged token gets the browser nothing. What reading the claims
 * *does* buy is that the UI shows the identity the token actually carries,
 * instead of a sibling JSON field an attacker could set to any address.
 */
function decodeTokenClaims(accessToken: string): TokenClaims | null {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return null;

    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const claims: unknown = JSON.parse(json);
    if (!claims || typeof claims !== "object") return null;

    const record = claims as Record<string, unknown>;
    const walletAddress = record[WALLET_CLAIM];
    const exp = record.exp;
    if (typeof walletAddress !== "string" || !walletAddress) return null;
    if (typeof exp !== "number") return null;

    return { walletAddress, expiresAt: exp * 1000 };
  } catch {
    return null;
  }
}

// ─── Cached session ───────────────────────────────────────────────────────────

/**
 * Freshness measured against the token's own `exp`, so editing the stored
 * `expiresAt` cannot make a dead token look alive.
 */
function isFresh(session: WalletSession, now = Date.now()): boolean {
  const claims = decodeTokenClaims(session.accessToken);
  if (!claims) return false;
  return claims.expiresAt - SESSION_REFRESH_SKEW_SECONDS * 1000 > now;
}

/**
 * Returns the stored session only if the token itself proves it belongs to
 * `walletAddress` and has not expired.
 *
 * The stored `walletAddress`/`expiresAt` fields are a cache hint and nothing
 * more: pairing a victim's address with an attacker's valid token used to make
 * the UI mark the victim's wallet as verified, because these checks read the
 * JSON beside the token rather than the claims inside it.
 */
export function readStoredSession(walletAddress: string): WalletSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_SESSION);
    if (!raw) return null;
    const stored = JSON.parse(raw) as WalletSession;
    if (!stored?.accessToken || typeof stored.accessToken !== "string") return null;

    const claims = decodeTokenClaims(stored.accessToken);
    if (!claims) return null;
    if (claims.walletAddress !== walletAddress) return null;

    // Rebuild from the claims so nothing downstream can read a forged field.
    const session: WalletSession = {
      walletAddress: claims.walletAddress,
      accessToken: stored.accessToken,
      expiresAt: claims.expiresAt,
    };
    if (!isFresh(session)) return null;
    return session;
  } catch {
    return null;
  }
}

function storeSession(session: WalletSession): void {
  try {
    window.localStorage.setItem(LS_SESSION, JSON.stringify(session));
  } catch {
    // Private-mode browsers refuse writes — the in-memory copy still works.
  }
}

/** Drops the cached token so the next authenticated call re-runs the handshake. */
export function clearWalletSession(): void {
  memoizedSession = null;
  inFlight = null;
  if (memoizedClient) {
    void memoizedClient.client.removeAllChannels();
    memoizedClient = null;
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(LS_SESSION);
    } catch {
      // ignore
    }
  }
  notifySessionChange();
}

let memoizedSession: WalletSession | null = null;
let inFlight: Promise<WalletSession> | null = null;

// ─── Change notifications ─────────────────────────────────────────────────────

const listeners = new Set<() => void>();

function notifySessionChange(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Notifies subscribers whenever the session is established or dropped, so
 * anything holding a client (a realtime subscription, say) can rebind to the
 * new token instead of quietly running on a stale one.
 *
 * Returns an unsubscribe function.
 */
export function onSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ─── Handshake ────────────────────────────────────────────────────────────────

async function postJson<T>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new WalletSessionError(
      "Cannot reach the SettleX server to sign in. Please check your connection.",
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // fall through to the status-based message below
  }

  if (!response.ok) {
    const message = (payload as { error?: unknown } | null)?.error;
    throw new WalletSessionError(
      typeof message === "string" ? message : `Sign-in failed (HTTP ${response.status}).`,
    );
  }

  return payload as T;
}

async function runHandshake(walletAddress: string): Promise<WalletSession> {
  const challenge = await postJson<{
    transactionXdr: string;
    networkPassphrase: string;
    challengeToken: string;
  }>(CHALLENGE_ENDPOINT, { walletAddress });

  let signedTransactionXdr: string;
  try {
    signedTransactionXdr = await signXDR(challenge.transactionXdr, challenge.networkPassphrase);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    throw new WalletSessionError(
      /reject|denied|cancel|declined/i.test(message)
        ? "Sign-in was cancelled in your wallet."
        : message || "Your wallet could not sign the sign-in request.",
    );
  }

  const verified = await postJson<{ accessToken: string; expiresAt: string }>(VERIFY_ENDPOINT, {
    walletAddress,
    signedTransactionXdr,
    challengeToken: challenge.challengeToken,
  });

  // Derive identity and expiry from the token, not the surrounding JSON, so
  // the stored blob always agrees with what the token actually says.
  const claims = decodeTokenClaims(verified.accessToken);
  if (!claims || claims.walletAddress !== walletAddress) {
    throw new WalletSessionError("The server returned a token for a different wallet.");
  }

  const session: WalletSession = {
    walletAddress: claims.walletAddress,
    accessToken: verified.accessToken,
    expiresAt: claims.expiresAt,
  };

  memoizedSession = session;
  storeSession(session);
  notifySessionChange();
  return session;
}

export interface SessionOptions {
  /**
   * Whether the wallet may be prompted for a signature. Pass `false` on
   * background reads so the app never pops a wallet dialog unprompted.
   */
  interactive?: boolean;
}

/**
 * Returns a valid session for `walletAddress`, running the signing handshake if
 * no cached token is usable. Concurrent callers share one handshake, so the
 * wallet is only ever asked to sign once.
 */
export async function getWalletSession(
  walletAddress: string,
  options: SessionOptions = {},
): Promise<WalletSession | null> {
  if (!walletAddress) throw new WalletSessionError("Wallet not connected.");

  // The memoized copy is rebuilt from claims when it is stored, but re-check
  // ownership against the token so this path cannot drift from the stored one.
  const memoized =
    memoizedSession &&
    decodeTokenClaims(memoizedSession.accessToken)?.walletAddress === walletAddress &&
    isFresh(memoizedSession)
      ? memoizedSession
      : null;
  const cached = memoized ?? readStoredSession(walletAddress);

  if (cached) {
    memoizedSession = cached;
    return cached;
  }

  if (options.interactive === false) return null;

  if (!inFlight) {
    inFlight = runHandshake(walletAddress).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

// ─── Authenticated client ─────────────────────────────────────────────────────

let memoizedClient: { token: string; client: SupabaseClient } | null = null;

function buildClient(accessToken: string): SupabaseClient {
  if (memoizedClient?.token === accessToken) return memoizedClient.client;

  if (memoizedClient) {
    void memoizedClient.client.removeAllChannels();
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  // Realtime authorizes on its own socket, so it needs the token too — without
  // this, RLS-guarded change feeds deliver nothing.
  client.realtime.setAuth(accessToken);

  memoizedClient = { token: accessToken, client };
  return client;
}

/**
 * Supabase client bound to a proven wallet identity. Returns `null` only when
 * `interactive: false` was requested and no cached session exists.
 */
export async function getAuthenticatedClient(
  walletAddress: string,
  options: SessionOptions = {},
): Promise<SupabaseClient | null> {
  const session = await getWalletSession(walletAddress, options);
  if (!session) return null;
  return buildClient(session.accessToken);
}

/**
 * Same as `getAuthenticatedClient`, but always prompts when no cached session
 * exists. Use it for writes, where proceeding unauthenticated is never right.
 */
export async function requireAuthenticatedClient(
  walletAddress: string,
): Promise<SupabaseClient> {
  const client = await getAuthenticatedClient(walletAddress, { interactive: true });
  if (!client) throw new WalletSessionError("Wallet sign-in is required.");
  return client;
}
