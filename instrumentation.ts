/**
 * Runs once on server boot before any request is served.
 * Validates auth config upfront in prod so misconfigured deployments fail fast.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // edge runtime has no env/auth

  // Set up error reporting first so failed prod boots still get captured
  const { initObservability } = await import("@/lib/observability/init");
  initObservability();

  if (process.env.NODE_ENV !== "production") return;

  const { assertAuthConfig } = await import("@/lib/auth/serverConfig");
  const { reportError } = await import("@/lib/observability/logger");

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("WARNING: SUPABASE_SERVICE_ROLE_KEY is not set. Security controls are degraded: replay protection, rate limiting, and token revocation are inactive.");
  }

  try {
    assertAuthConfig();
  } catch (err) {
    reportError("boot.config_invalid", err); // capture before crashing boot
    throw err;
  }
}
