/**
 * POST /api/auth/signout
 * Revokes the caller's token server-side (verified via the HttpOnly cookie).
 * Pass `everywhere: true` to revoke all tokens issued to the wallet so far.
 */
import { verifyJwt } from "@/lib/auth/jwt";
import { WALLET_CLAIM } from "@/lib/auth/constants";
import { clearSessionCookie, getSessionCookie } from "@/lib/auth/sessionCookie";
import { clientKey, enforceRateLimit } from "@/lib/auth/rateLimit";
import {
  RevocationUnavailable,
  isRevocationConfigured,
  revokeToken,
  revokeWallet,
} from "@/lib/auth/revocation";
import { AuthConfigError, getJwtSecret } from "@/lib/auth/serverConfig";
import { countMetric } from "@/lib/observability/logger";
import { jsonWithCorrelation, requestLogger } from "@/lib/observability/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  const logger = requestLogger("POST /api/auth/signout", request);
  const signoutResponse = (
    body: unknown,
    init: { status?: number; headers?: Record<string, string> } = {},
  ) => {
    const response = jsonWithCorrelation(logger, body, init);
    clearSessionCookie(response);
    return response;
  };

  const limit = await enforceRateLimit(`signout:${clientKey(request)}`, 30, 60_000);
  if (!limit.allowed) {
    logger.warn("auth.signout_rate_limited", { retryAfter: limit.retryAfter });
    logger.finish("auth.signout_completed", 429);
    return jsonWithCorrelation(
      logger,
      { error: "Too many requests. Please wait a moment." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfter) } },
    );
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    logger.warn("auth.signout_origin_rejected");
    logger.finish("auth.signout_completed", 403, { reason: "cross_origin" });
    return jsonWithCorrelation(logger, { error: "Cross-origin requests are not allowed." }, { status: 403, headers: NO_STORE });
  }

  const token = getSessionCookie(request);
  if (!token) {
    logger.finish("auth.signout_completed", 401, { reason: "missing_token" });
    return signoutResponse({ error: "An authenticated session is required." }, { status: 401, headers: NO_STORE });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // empty body just means single-token signout
  }
  const everywhere = (body as { everywhere?: unknown } | null)?.everywhere === true;

  try {
    // only valid tokens need revoking; expired/forged ones are already useless
    const claims = verifyJwt(token, getJwtSecret());
    if (!claims) {
      logger.warn("auth.signout_rejected", { reason: "invalid_token" });
      logger.finish("auth.signout_completed", 401, { reason: "invalid_token" });
      return signoutResponse({ error: "That access token is not valid." }, { status: 401, headers: NO_STORE });
    }

    const walletAddress = claims[WALLET_CLAIM];
    const jti = claims.jti;
    const exp = claims.exp;
    if (typeof walletAddress !== "string" || typeof exp !== "number") {
      logger.warn("auth.signout_rejected", { reason: "malformed_claims" });
      logger.finish("auth.signout_completed", 401, { reason: "malformed_claims" });
      return signoutResponse({ error: "That access token is not valid." }, { status: 401, headers: NO_STORE });
    }

    if (!isRevocationConfigured()) {
      // fail loudly so we don't report a signout that never actually happened
      logger.error("auth.revocation_not_configured", undefined, {
        walletAddress,
        detail: "SUPABASE_SERVICE_ROLE_KEY is not set.",
      });
      logger.finish("auth.signout_completed", 503, { reason: "revocation_not_configured" });
      return signoutResponse(
        { error: "Server-side sign-out is not configured on this server." },
        { status: 503, headers: NO_STORE },
      );
    }

    if (everywhere) {
      await revokeWallet(walletAddress);
    } else {
      if (typeof jti !== "string") {
        // legacy tokens minted before jti existed can't be revoked individually
        logger.warn("auth.signout_rejected", { walletAddress, reason: "no_jti" });
        logger.finish("auth.signout_completed", 409, { reason: "no_jti" });
        return signoutResponse(
          { error: "This session predates revocation support — sign out everywhere instead." },
          { status: 409, headers: NO_STORE },
        );
      }
      await revokeToken({ jti, walletAddress, expiresAt: exp });
    }

    countMetric("auth.session_revoked", { everywhere });
    logger.finish("auth.signout_completed", 200, { walletAddress, everywhere });
    return signoutResponse({ revoked: true, everywhere }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthConfigError) {
      logger.error("auth.config_missing", err);
      logger.finish("auth.signout_completed", 503, { reason: "config_missing" });
      return signoutResponse(
        { error: "Wallet authentication is not configured on this server." },
        { status: 503, headers: NO_STORE },
      );
    }
    if (err instanceof RevocationUnavailable) {
      // don't tell the browser sign-out worked if revocation failed
      logger.error("auth.revocation_failed", err);
      logger.finish("auth.signout_completed", 503, { reason: "revocation_unavailable" });
      return signoutResponse(
        { error: "Could not sign out. Please try again." },
        { status: 503, headers: { ...NO_STORE, "Retry-After": "5" } },
      );
    }
    logger.error("auth.signout_failed", err);
    logger.finish("auth.signout_completed", 500);
    return signoutResponse({ error: "Could not sign out." }, { status: 500, headers: NO_STORE });
  }
}
