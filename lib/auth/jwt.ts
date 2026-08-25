/**
 * Minimal HS256 JWT signing/verification, used to mint Supabase access tokens
 * once a wallet has proven control of its private key.
 *
 * Server-side only — it needs `SUPABASE_JWT_SECRET`, which must never reach the
 * browser bundle.
 */
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { WALLET_CLAIM } from "@/lib/auth/constants";

export interface WalletClaims {
  /** Deterministic UUID derived from the wallet address. */
  sub: string;
  aud: string;
  role: string;
  iss: string;
  iat: number;
  exp: number;
  /** The Stellar address this token proves control of. */
  wallet_address: string;
}

// ─── base64url helpers ────────────────────────────────────────────────────────

function encodeSegment(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeSegment(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Constant-time comparison that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ─── Signing / verification ───────────────────────────────────────────────────

function sign(input: string, secret: string): string {
  return encodeSegment(createHmac("sha256", secret).update(input).digest());
}

export function signJwt(claims: Record<string, unknown>, secret: string): string {
  if (!secret) throw new Error("A signing secret is required.");
  const header = encodeSegment(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeSegment(JSON.stringify(claims));
  const body = `${header}.${payload}`;
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verifies signature and expiry. Returns the claims, or `null` when the token
 * is malformed, tampered with, or expired.
 */
export function verifyJwt(
  token: string,
  secret: string,
  now: number = Date.now(),
): Record<string, unknown> | null {
  if (!token || !secret) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;
  if (!safeEqual(signature, sign(`${header}.${payload}`, secret))) return null;

  let claims: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(decodeSegment(payload).toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    claims = decoded as Record<string, unknown>;
  } catch {
    return null;
  }

  const alg = (() => {
    try {
      return (JSON.parse(decodeSegment(header).toString("utf8")) as { alg?: unknown }).alg;
    } catch {
      return undefined;
    }
  })();
  if (alg !== "HS256") return null;

  const exp = claims.exp;
  if (typeof exp !== "number" || exp * 1000 <= now) return null;

  return claims;
}

// ─── Supabase access tokens ───────────────────────────────────────────────────

/**
 * Derives a stable RFC-4122 UUID from a wallet address so the `sub` claim looks
 * like a normal Supabase subject. Nothing authorizes on it — the wallet claim
 * is the identity — but PostgREST helpers such as `auth.uid()` expect a UUID.
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
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export interface AccessToken {
  token: string;
  /** Expiry as an ISO timestamp. */
  expiresAt: string;
}

/**
 * Mints a Supabase-compatible access token binding the request to a wallet that
 * has already proven key ownership. RLS policies read the `wallet_address`
 * claim; the `role` claim is what PostgREST switches the database role to.
 */
export function issueAccessToken(params: {
  walletAddress: string;
  secret: string;
  ttlSeconds: number;
  now?: number;
}): AccessToken {
  const { walletAddress, secret, ttlSeconds } = params;
  const issuedAt = Math.floor((params.now ?? Date.now()) / 1000);
  const expiresAt = issuedAt + ttlSeconds;

  const claims: WalletClaims = {
    sub: walletToUuid(walletAddress),
    aud: "authenticated",
    role: "authenticated",
    iss: "settlex",
    iat: issuedAt,
    exp: expiresAt,
    [WALLET_CLAIM]: walletAddress,
  };

  return {
    token: signJwt(claims as unknown as Record<string, unknown>, secret),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}
