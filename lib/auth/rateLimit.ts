/**
 * Fixed-window rate limiter for auth routes.
 *
 * Uses Postgres via `lib/auth/sharedStore` across instances when configured,
 * falling back to an in-memory map per process. Not a substitute for WAF/edge limits.
 */
import { isSharedStoreConfigured, rateLimitShared } from "@/lib/auth/sharedStore";
import { reportError } from "@/lib/observability/logger";

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  for (const [existing, window] of windows) {
    if (window.resetAt <= now) windows.delete(existing);
  }

  const window = windows.get(key);
  if (!window || window.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }

  window.count += 1;
  if (window.count > limit) {
    return { allowed: false, retryAfter: Math.ceil((window.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

/** Test hook — clears tracked windows. */
export function resetRateLimits(): void {
  windows.clear();
}

/**
 * Checks the shared rate limit and falls back to the local window if the DB
 * isn't configured or fails (better to degrade throttling than lock everyone out).
 */
export async function enforceRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  if (isSharedStoreConfigured()) {
    try {
      return await rateLimitShared(key, limit, windowMs);
    } catch (err) {
      // Fallback widens the effective limit to limit * instances, so surface it.
      reportError("auth.shared_rate_limit_unavailable", err, {
        fields: { fallback: "in_memory" },
      });
    }
  }
  return rateLimit(key, limit, windowMs);
}

/**
 * Resolves client IP for rate limiting: platform `request.ip`, `x-real-ip`,
 * then the last hop in `x-forwarded-for` (added by the nearest proxy).
 */
export function clientKey(request: Request): string {
  const directIp = (request as { ip?: string }).ip;
  if (directIp && directIp.trim()) return directIp.trim();

  const realIp = request.headers.get("x-real-ip");
  if (realIp && realIp.trim()) return realIp.trim();

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }

  return "unknown";
}
