/**
 * POST /api/auth/verify
 *
 * Verifies a signed challenge and, only on success, mints a Supabase access
 * token whose `wallet_address` claim carries the proven Stellar address. Every
 * RLS policy authorizes on that claim, so this route is the single place where
 * a claimed wallet becomes an authenticated one.
 */
import { NextResponse } from "next/server";
import { isValidWalletAddress, verifyChallenge } from "@/lib/auth/challenge";
import { issueAccessToken } from "@/lib/auth/jwt";
import { clientKey, rateLimit } from "@/lib/auth/rateLimit";
import {
  AuthConfigError,
  getChallengeSecret,
  getJwtSecret,
  getSessionTtlSeconds,
} from "@/lib/auth/serverConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  const limit = rateLimit(`verify:${clientKey(request)}`, 30, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many authentication attempts. Please wait a moment." },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "A JSON body is required." },
      { status: 400, headers: NO_STORE },
    );
  }

  const { walletAddress, signedTransactionXdr, challengeToken } = (body ?? {}) as {
    walletAddress?: unknown;
    signedTransactionXdr?: unknown;
    challengeToken?: unknown;
  };

  if (
    !isValidWalletAddress(walletAddress) ||
    typeof signedTransactionXdr !== "string" ||
    typeof challengeToken !== "string"
  ) {
    return NextResponse.json(
      { error: "walletAddress, signedTransactionXdr and challengeToken are required." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = verifyChallenge({
      walletAddress,
      signedTransactionXdr,
      challengeToken,
      secret: getChallengeSecret(),
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 401, headers: NO_STORE });
    }

    const { token, expiresAt } = issueAccessToken({
      walletAddress: result.walletAddress,
      secret: getJwtSecret(),
      ttlSeconds: getSessionTtlSeconds(),
    });

    return NextResponse.json(
      { accessToken: token, expiresAt, walletAddress: result.walletAddress },
      { headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof AuthConfigError) {
      console.error("Wallet auth is not configured:", err.message);
      return NextResponse.json(
        { error: "Wallet authentication is not configured on this server." },
        { status: 503, headers: NO_STORE },
      );
    }
    console.error("Failed to verify an authentication challenge:", err);
    return NextResponse.json(
      { error: "Could not verify the signed challenge." },
      { status: 500, headers: NO_STORE },
    );
  }
}
