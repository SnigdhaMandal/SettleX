/**
 * Fixed-window, in-memory rate limiter for the unauthenticated auth routes.
 *
 * Both routes do public-key cryptography on caller-supplied input, so they are
 * worth throttling. State lives in the process, which means the limit applies
 * per serverless instance — enough to blunt casual abuse, not a substitute for
 * an edge/WAF rate limit in front of the deployment.
 */
interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may retry. */
  retryAfter: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
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

/** Test hook — drops every tracked window. */
export function resetRateLimits(): void {
  windows.clear();
}

/**
 * Best-effort client identity for rate limiting. Proxy headers are spoofable,
 * so this only ever widens the key space — it never grants access.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
