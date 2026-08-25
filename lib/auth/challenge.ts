/**
 * SEP-10 style wallet authentication challenge.
 *
 * The server hands the browser a transaction that can never be submitted
 * (sequence number 0) carrying a random nonce. Only the holder of the wallet's
 * private key can produce a valid signature over it, which is what turns a
 * claimed address into a proven one.
 *
 * The nonce is bound to the wallet and an expiry by an HMAC (`challengeToken`),
 * so the handshake stays stateless and works across serverless instances
 * without a shared session store.
 *
 * Server-side only — it needs `AUTH_CHALLENGE_SECRET`.
 */
import { createHmac, randomBytes } from "crypto";
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  CHALLENGE_DATA_NAME,
  CHALLENGE_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
} from "@/lib/auth/constants";
import { safeEqual } from "@/lib/auth/jwt";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";

export interface Challenge {
  transactionXdr: string;
  networkPassphrase: string;
  /** Opaque HMAC that proves this server issued the nonce. */
  challengeToken: string;
  expiresAt: string;
}

export type VerifyResult =
  | { ok: true; walletAddress: string }
  | { ok: false; reason: string };

interface ChallengePayload {
  /** Wallet address the challenge was issued to. */
  w: string;
  /** Random nonce embedded in the transaction. */
  n: string;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function base64url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function isValidWalletAddress(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidEd25519PublicKey(value);
}

function mintChallengeToken(payload: ChallengePayload, secret: string): string {
  const body = base64url(JSON.stringify(payload));
  const mac = base64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

function readChallengeToken(token: string, secret: string): ChallengePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [body, mac] = parts;
  const expected = base64url(createHmac("sha256", secret).update(body).digest());
  if (!safeEqual(mac, expected)) return null;

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    if (!decoded || typeof decoded !== "object") return null;
    const payload = decoded as ChallengePayload;
    if (typeof payload.w !== "string" || typeof payload.n !== "string") return null;
    if (typeof payload.exp !== "number") return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Single-use nonce tracking ────────────────────────────────────────────────

/**
 * Best-effort replay guard. Serverless deployments run several instances, so a
 * nonce burned here may still be unknown to a sibling instance — the short
 * challenge TTL is what bounds the exposure. See
 * `docs/ARCHITECTURE_AND_LIMITATIONS.md`.
 */
const usedNonces = new Map<string, number>();

function consumeNonce(nonce: string, expiresAt: number, now: number): boolean {
  for (const [key, exp] of usedNonces) {
    if (exp * 1000 <= now) usedNonces.delete(key);
  }
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, expiresAt);
  return true;
}

/** Test hook — drops every remembered nonce. */
export function resetNonceCache(): void {
  usedNonces.clear();
}

// ─── Challenge creation ───────────────────────────────────────────────────────

export function createChallenge(
  walletAddress: string,
  secret: string,
  now: number = Date.now(),
): Challenge {
  if (!isValidWalletAddress(walletAddress)) {
    throw new Error("A valid Stellar public key is required.");
  }
  if (!secret) throw new Error("A challenge secret is required.");

  const nonce = base64url(randomBytes(32));
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + CHALLENGE_TTL_SECONDS;

  // Sequence "-1" makes the builder emit sequence 0, which the network always
  // rejects — the challenge can be signed but never submitted.
  const source = new Account(walletAddress, "-1");

  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.manageData({
        name: CHALLENGE_DATA_NAME,
        value: nonce,
        source: walletAddress,
      }),
    )
    .setTimebounds(issuedAt - CLOCK_SKEW_SECONDS, expiresAt)
    .build();

  return {
    transactionXdr: transaction.toXDR(),
    networkPassphrase: NETWORK_PASSPHRASE,
    challengeToken: mintChallengeToken({ w: walletAddress, n: nonce, exp: expiresAt }, secret),
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

// ─── Challenge verification ───────────────────────────────────────────────────

export function verifyChallenge(params: {
  walletAddress: string;
  signedTransactionXdr: string;
  challengeToken: string;
  secret: string;
  now?: number;
}): VerifyResult {
  const { walletAddress, signedTransactionXdr, challengeToken, secret } = params;
  const now = params.now ?? Date.now();
  const nowSeconds = Math.floor(now / 1000);

  if (!isValidWalletAddress(walletAddress)) {
    return { ok: false, reason: "A valid Stellar public key is required." };
  }
  if (!signedTransactionXdr || !challengeToken) {
    return { ok: false, reason: "A signed challenge is required." };
  }

  const payload = readChallengeToken(challengeToken, secret);
  if (!payload) return { ok: false, reason: "This challenge was not issued by this server." };
  if (payload.w !== walletAddress) {
    return { ok: false, reason: "This challenge was issued to a different wallet." };
  }
  if (payload.exp <= nowSeconds) {
    return { ok: false, reason: "This challenge has expired — please try again." };
  }

  let transaction: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(signedTransactionXdr, NETWORK_PASSPHRASE);
    if (!(parsed instanceof Transaction)) {
      return { ok: false, reason: "Fee-bump transactions are not valid challenges." };
    }
    transaction = parsed;
  } catch {
    return { ok: false, reason: "The signed challenge could not be decoded." };
  }

  if (transaction.source !== walletAddress) {
    return { ok: false, reason: "The challenge was modified before signing." };
  }
  if (transaction.sequence !== "0") {
    return { ok: false, reason: "A challenge must carry sequence number 0." };
  }
  if (transaction.operations.length !== 1) {
    return { ok: false, reason: "The challenge was modified before signing." };
  }

  const operation = transaction.operations[0];
  if (operation.type !== "manageData" || operation.name !== CHALLENGE_DATA_NAME) {
    return { ok: false, reason: "The challenge was modified before signing." };
  }
  if (operation.source && operation.source !== walletAddress) {
    return { ok: false, reason: "The challenge was modified before signing." };
  }
  if (!operation.value || operation.value.toString("utf8") !== payload.n) {
    return { ok: false, reason: "The challenge nonce does not match." };
  }

  const bounds = transaction.timeBounds;
  if (!bounds) return { ok: false, reason: "The challenge was modified before signing." };
  const minTime = Number(bounds.minTime);
  const maxTime = Number(bounds.maxTime);
  if (nowSeconds + CLOCK_SKEW_SECONDS < minTime || nowSeconds - CLOCK_SKEW_SECONDS > maxTime) {
    return { ok: false, reason: "This challenge has expired — please try again." };
  }

  const keypair = Keypair.fromPublicKey(walletAddress);
  const hash = transaction.hash();
  const signed = transaction.signatures.some((signature) => {
    try {
      return keypair.verify(hash, signature.signature());
    } catch {
      return false;
    }
  });
  if (!signed) {
    return { ok: false, reason: "The signature does not match this wallet address." };
  }

  if (!consumeNonce(payload.n, payload.exp, now)) {
    return { ok: false, reason: "This challenge has already been used." };
  }

  return { ok: true, walletAddress };
}
