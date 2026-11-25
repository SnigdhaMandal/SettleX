/**
 * Server-side token revocation via `public.revoked_tokens`.
 *
 * Clearing cookies alone doesn't invalidate captured bearer tokens, so sign-out
 * writes the token's `jti` to a denylist checked by `settlex_wallet()` in RLS.
 * Requires the service role key (server-side only).
 */

/** Thrown when the denylist can't be updated so callers can fail closed. */
export class RevocationUnavailable extends Error {}

const RPC_TIMEOUT_MS = 2_000; // keep sign-out from hanging on a slow DB

function config() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/[/]+$/, ""), key };
}

/** True when sign-out can actually revoke tokens server-side. */
export function isRevocationConfigured(): boolean {
  return config() !== null;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const settings = config();
  if (!settings) throw new RevocationUnavailable("No service role key is configured.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const response = await fetch(`${settings.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: settings.key,
        Authorization: `Bearer ${settings.key}`,
      },
      body: JSON.stringify(args),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new RevocationUnavailable(`${fn} failed with HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof RevocationUnavailable) throw err;
    throw new RevocationUnavailable(`${fn} could not be reached: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Revokes a single token id until `expiresAt`. */
export async function revokeToken(params: {
  jti: string;
  walletAddress: string;
  expiresAt: number;
}): Promise<void> {
  try {
    await rpc<unknown>("settlex_revoke_token", {
      p_jti: params.jti,
      p_wallet_address: params.walletAddress,
      p_expires_at: new Date(params.expiresAt * 1000).toISOString(),
    });
  } catch (err) {
    if (err instanceof RevocationUnavailable) throw err;
    throw new RevocationUnavailable(String(err));
  }
}

/**
 * Revokes all tokens issued to a wallet before now (sign out everywhere).
 *
 * @param walletAddress Stellar address to revoke
 * @param ttlSeconds Tombstone lifetime in seconds (DB defaults to 13h, outliving the 12h session cap)
 */
export async function revokeWallet(
  walletAddress: string,
  ttlSeconds?: number,
): Promise<number> {
  try {
    const params: { p_wallet_address: string; p_ttl_seconds?: number } = {
      p_wallet_address: walletAddress,
    };
    if (typeof ttlSeconds === "number" && ttlSeconds > 0) {
      params.p_ttl_seconds = ttlSeconds;
    }
    return await rpc<number>("settlex_revoke_wallet", params);
  } catch (err) {
    if (err instanceof RevocationUnavailable) throw err;
    throw new RevocationUnavailable(String(err));
  }
}
