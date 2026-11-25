/**
 * POST /api/auth/challenge
 * Hands out an unsubmittable Stellar tx for the wallet to sign.
 * Actual signature verification happens in `/api/auth/verify`.
 */
import { createChallenge, isValidWalletAddress } from "@/lib/auth/challenge";
import { clientKey, enforceRateLimit } from "@/lib/auth/rateLimit";
import { AuthConfigError, getChallengeSecret } from "@/lib/auth/serverConfig";
import { jsonWithCorrelation, requestLogger } from "@/lib/observability/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  const logger = requestLogger("POST /api/auth/challenge", request);

  const limit = await enforceRateLimit(`challenge:${clientKey(request)}`, 30, 60_000);
  if (!limit.allowed) {
    // spike here usually means someone probing the endpoint
    logger.warn("auth.challenge_rate_limited", { retryAfter: limit.retryAfter });
    logger.finish("auth.challenge_completed", 429);
    return jsonWithCorrelation(
      logger,
      { error: "Too many authentication attempts. Please wait a moment." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logger.finish("auth.challenge_completed", 400, { reason: "malformed_json" });
    return jsonWithCorrelation(logger, { error: "A JSON body is required." }, { status: 400, headers: NO_STORE });
  }

  const walletAddress = (body as { walletAddress?: unknown })?.walletAddress;
  if (!isValidWalletAddress(walletAddress)) {
    logger.finish("auth.challenge_completed", 400, { reason: "invalid_wallet_address" });
    return jsonWithCorrelation(
      logger,
      { error: "A valid Stellar public key is required." },
      { status: 400, headers: NO_STORE },
    );
  }

  const walletLimit = await enforceRateLimit(`challenge:wallet:${walletAddress}`, 15, 60_000);
  if (!walletLimit.allowed) {
    logger.warn("auth.challenge_wallet_rate_limited", {
      walletAddress,
      retryAfter: walletLimit.retryAfter,
    });
    logger.finish("auth.challenge_completed", 429);
    return jsonWithCorrelation(
      logger,
      { error: "Too many authentication attempts for this wallet. Please wait a moment." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(walletLimit.retryAfter) } },
    );
  }

  try {
    const challenge = createChallenge(walletAddress, getChallengeSecret());
    logger.finish("auth.challenge_completed", 200, { walletAddress }); // address gets redacted by logger
    return jsonWithCorrelation(logger, challenge, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthConfigError) {
      // misconfigured deploy — sign-ins will keep failing until the secret is set
      logger.error("auth.config_missing", err, { walletAddress });
      logger.finish("auth.challenge_completed", 503, { reason: "config_missing" });
      return jsonWithCorrelation(
        logger,
        { error: "Wallet authentication is not configured on this server." },
        { status: 503, headers: NO_STORE },
      );
    }
    logger.error("auth.challenge_failed", err, { walletAddress });
    logger.finish("auth.challenge_completed", 500);
    return jsonWithCorrelation(
      logger,
      { error: "Could not create an authentication challenge." },
      { status: 500, headers: NO_STORE },
    );
  }
}
