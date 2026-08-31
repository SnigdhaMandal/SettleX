/**
 * Runs once when the server boots, before any request is served.
 *
 * Secrets are otherwise read lazily inside request handlers so a missing value
 * fails one request rather than the whole build. That is right for a local
 * checkout, but in production a misconfigured deployment should not come up
 * healthy and then fail the first time someone tries to sign in — by then it is
 * serving traffic and the operator has moved on.
 */
export async function register() {
  // Only the Node.js runtime has the env and the auth code; the edge runtime
  // (middleware) imports neither.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production") return;

  const { assertAuthConfig } = await import("@/lib/auth/serverConfig");
  assertAuthConfig();
}
