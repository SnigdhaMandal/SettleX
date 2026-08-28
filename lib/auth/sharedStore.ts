/**
 * Cross-instance store for the two pieces of auth state that must not be
 * per-process: burned challenge nonces and the rate-limit windows.
 *
 * Serverless deployments run many instances, so a nonce burned in one process
 * means nothing to its siblings and a per-process counter multiplies the real
 * throughput by the instance count. Both are therefore backed by Postgres
 * (Supabase) through two `security definer` functions that do the check and the
 * write in a single atomic statement — see the "Auth shared state" section of
 * `supabase-setup.sql`.
 *
 * The service-role key is required and must never be prefixed with
 * `NEXT_PUBLIC_`. When it is absent the store reports itself unavailable and
 * callers fall back to their in-memory guard, which is best-effort only.
 *
 * Server-side only.
 */

/** RPC call timeout — auth routes must not hang on a slow database. */
const RPC_TIMEOUT_MS = 2_000;

export class SharedStoreUnavailable extends Error {}

function config(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

/** True when a shared store is configured, i.e. the guards hold across instances. */
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

/**
 * Burns a nonce for every instance at once. Returns false when the nonce was
 * already used — that is a replay.
 *
 * Throws `SharedStoreUnavailable` when no store is configured or it cannot be
 * reached, so the caller can decide whether to fall back or fail closed.
 */
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

/** Counts one request against a fixed window shared by every instance. */
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
