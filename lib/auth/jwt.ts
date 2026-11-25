/**
 * Minimal HS256 JWT helpers for minting Supabase access tokens after wallet verification.
 * Server-side only (depends on SUPABASE_JWT_SECRET).
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import { WALLET_CLAIM } from "@/lib/auth/constants";

export interface WalletClaims {
  sub: string; // deterministic UUID from wallet address
  aud: string;
  role: string;
  iss: string;
  iat: number;
  exp: number;
  wallet_address: string;
  jti: string; // unique token id for revocation
}

function encodeSegment(value: Buffer | string) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeSegment(segment: string) {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Constant-time string comparison that handles mismatched lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function sign(input: string, secret: string) {
  return encodeSegment(createHmac("sha256", secret).update(input).digest());
}

export function signJwt(claims: Record<string, unknown>, secret: string): string {
  if (!secret) throw new Error("A signing secret is required.");
  const header = encodeSegment(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeSegment(JSON.stringify(claims));
  const body = `${header}.${payload}`;
  return `${body}.${sign(body, secret)}`;
}

/** Verifies signature, alg, and expiry; returns claims or null. */
export function verifyJwt(
  token: string,
  secret: string,
  now = Date.now(),
): Record<string, unknown> | null {
  if (!token || !secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;
  if (!safeEqual(signature, sign(`${header}.${payload}`, secret))) return null;

  let claims: Record<string, unknown>;
  try {
    const decoded = JSON.parse(decodeSegment(payload).toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    claims = decoded as Record<string, unknown>;
  } catch {
    return null;
  }

  let alg: unknown;
  try {
    alg = (JSON.parse(decodeSegment(header).toString("utf8")) as { alg?: unknown }).alg;
  } catch {
    alg = undefined;
  }
  if (alg !== "HS256") return null;

  const exp = claims.exp;
  if (typeof exp !== "number" || exp * 1000 <= now) return null;

  return claims;
}

/**
 * Derives a stable v4-shaped UUID from a wallet address so `sub` satisfies
 * PostgREST helpers like `auth.uid()` (auth still keys off `wallet_address`).
 */
export function walletToUuid(walletAddress: string): string {
  const bytes = createHash("sha256")
    .update(`settlex:wallet:${walletAddress}`)
    .digest()
    .subarray(0, 16);
  const uuid = Buffer.from(bytes);
  uuid[6] = (uuid[6] & 0x0f) | 0x40; // version 4
  uuid[8] = (uuid[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = uuid.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface AccessToken {
  token: string;
  expiresAt: string;
  jti: string;
}

/** Mints a Supabase-compatible access token for a verified wallet. */
export function issueAccessToken(params: {
  walletAddress: string;
  secret: string;
  ttlSeconds: number;
  now?: number;
}): AccessToken {
  const { walletAddress, secret, ttlSeconds } = params;
  const issuedAt = Math.floor((params.now ?? Date.now()) / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const jti = randomUUID();

  const claims: WalletClaims = {
    sub: walletToUuid(walletAddress),
    aud: "authenticated",
    role: "authenticated",
    iss: "settlex",
    iat: issuedAt,
    exp: expiresAt,
    [WALLET_CLAIM]: walletAddress,
    jti,
  };

  return {
    token: signJwt(claims as unknown as Record<string, unknown>, secret),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    jti,
  };
}
