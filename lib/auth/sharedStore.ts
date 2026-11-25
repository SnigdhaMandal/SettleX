/**
 * Postgres-backed shared store for burned challenge nonces and rate-limit windows
 * across serverless instances (see `supabase-setup.sql`).
 *
 * Needs the service-role key (server-side only). Without it, callers fall back
 * to per-process in-memory guards.
 */

const RPC_TIMEOUT_MS = 2_000; // don't let a slow DB stall auth routes

export class SharedStoreUnavailable extends Error {}

function config() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

/** True when the shared Postgres store is configured. */
export function isSharedStoreConfigured(): boolean {
  return config() !== null;
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const settings = config();
  if (!settings) throw new SharedStoreUnavailable("No shared auth store is configured.");

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
      throw new SharedStoreUnavailable(`${fn} failed with HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof SharedStoreUnavailable) throw err;
    throw new SharedStoreUnavailable(`${fn} could not be reached: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Atomically consumes a nonce across all instances; returns false on replay. */
export async function consumeNonceShared(nonce: string, expiresAtSeconds: number): Promise<boolean> {
  const consumed = await rpc<unknown>("auth_consume_nonce", {
    p_nonce: nonce,
    p_expires_at: new Date(expiresAtSeconds * 1000).toISOString(),
  });
  return consumed === true;
}

export interface SharedRateLimitRow {
  allowed: boolean;
  retry_after: number;
}

/** Increments and checks a shared fixed-window rate limit counter. */
export async function rateLimitShared(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const rows = await rpc<SharedRateLimitRow[] | SharedRateLimitRow>("auth_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_ms: windowMs,
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || typeof row.allowed !== "boolean") {
    throw new SharedStoreUnavailable("auth_rate_limit returned an unexpected shape.");
  }
  return { allowed: row.allowed, retryAfter: Number(row.retry_after) || 0 };
}
