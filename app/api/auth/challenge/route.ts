/**
 * POST /api/auth/challenge
 *
 * Hands out an unsubmittable transaction for the caller's wallet to sign.
 * Requesting a challenge proves nothing on its own — `/api/auth/verify` is
 * where the signature is checked.
 */
import { NextResponse } from "next/server";
import { createChallenge, isValidWalletAddress } from "@/lib/auth/challenge";
import { clientKey, enforceRateLimit } from "@/lib/auth/rateLimit";
import { AuthConfigError, getChallengeSecret } from "@/lib/auth/serverConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  const limit = await enforceRateLimit(`challenge:${clientKey(request)}`, 30, 60_000);
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

  const walletAddress = (body as { walletAddress?: unknown })?.walletAddress;
  if (!isValidWalletAddress(walletAddress)) {
    return NextResponse.json(
      { error: "A valid Stellar public key is required." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const challenge = createChallenge(walletAddress, getChallengeSecret());
    return NextResponse.json(challenge, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof AuthConfigError) {
      console.error("Wallet auth is not configured:", err.message);
      return NextResponse.json(
        { error: "Wallet authentication is not configured on this server." },
        { status: 503, headers: NO_STORE },
      );
    }
    console.error("Failed to create an authentication challenge:", err);
    return NextResponse.json(
      { error: "Could not create an authentication challenge." },
      { status: 500, headers: NO_STORE },
    );
  }
}
