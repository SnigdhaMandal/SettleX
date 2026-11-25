/**
 * SEP-10 style wallet auth challenge.
 *
 * Hands the browser an unsubmittable tx (sequence 0) with a random nonce. Only
 * the wallet's private key can sign it, proving ownership. `challengeToken`
 * binds the nonce + expiry via HMAC; `verifyChallengeShared` burns the nonce in
 * Postgres so it can't be replayed across serverless instances.
 *
 * Server-side only (uses AUTH_CHALLENGE_SECRET).
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
import { consumeNonceShared, isSharedStoreConfigured } from "@/lib/auth/sharedStore";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";

export interface Challenge {
  transactionXdr: string;
  networkPassphrase: string;
  /** Opaque HMAC proving this server issued the nonce. */
  challengeToken: string;
  expiresAt: string;
}

export type VerifyResult =
  | { ok: true; walletAddress: string }
  | { ok: false; reason: string };

interface ChallengePayload {
  w: string; // wallet address
  n: string; // nonce
  exp: number; // epoch seconds
}

function base64url(value: Buffer | string) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function isValidWalletAddress(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidEd25519PublicKey(value);
}

function mintChallengeToken(payload: ChallengePayload, secret: string) {
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
    const decoded = JSON.parse(
      Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as unknown;
    if (!decoded || typeof decoded !== "object") return null;

    const payload = decoded as ChallengePayload;
    if (typeof payload.w !== "string" || typeof payload.n !== "string") return null;
    if (typeof payload.exp !== "number") return null;
    return payload;
  } catch {
    return null;
  }
}

// Process-local replay fallback when no shared store is configured (see docs/ARCHITECTURE_AND_LIMITATIONS.md).
const usedNonces = new Map<string, number>();

function consumeNonce(nonce: string, expiresAt: number, now: number) {
  for (const [key, exp] of usedNonces) {
    if (exp * 1000 <= now) usedNonces.delete(key);
  }
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, expiresAt);
  return true;
}

/** Test hook — clears remembered nonces. */
export function resetNonceCache(): void {
  usedNonces.clear();
}

export function createChallenge(
  walletAddress: string,
  secret: string,
  now = Date.now(),
): Challenge {
  if (!isValidWalletAddress(walletAddress)) {
    throw new Error("A valid Stellar public key is required.");
  }
  if (!secret) throw new Error("A challenge secret is required.");

  const nonce = base64url(randomBytes(32));
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + CHALLENGE_TTL_SECONDS;

  // "-1" emits sequence 0 so the tx can be signed, never submitted to Stellar
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

export interface VerifyParams {
  walletAddress: string;
  signedTransactionXdr: string;
  challengeToken: string;
  secret: string;
  now?: number;
}

type CheckResult =
  | { ok: true; walletAddress: string; nonce: string; expiresAt: number }
  | { ok: false; reason: string };

// Validates everything except single-use; callers handle burning the nonce.
function checkChallenge(params: VerifyParams): CheckResult {
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

  return { ok: true, walletAddress, nonce: payload.n, expiresAt: payload.exp };
}

const REPLAYED = "This challenge has already been used.";

/**
 * Sync verification using an in-memory nonce cache (single-instance only).
 * Use `verifyChallengeShared` in multi-instance deployments.
 */
export function verifyChallenge(params: VerifyParams): VerifyResult {
  const checked = checkChallenge(params);
  if (!checked.ok) return checked;

  if (!consumeNonce(checked.nonce, checked.expiresAt, params.now ?? Date.now())) {
    return { ok: false, reason: REPLAYED };
  }
  return { ok: true, walletAddress: checked.walletAddress };
}

/**
 * Verifies the challenge and burns the nonce in Postgres so it can't be replayed
 * across instances. Degrades to in-memory if no store is configured, but fails
 * closed if a configured store is unreachable.
 */
export async function verifyChallengeShared(params: VerifyParams): Promise<VerifyResult> {
  const checked = checkChallenge(params);
  if (!checked.ok) return checked;

  if (!isSharedStoreConfigured()) return verifyChallenge(params);

  if (!(await consumeNonceShared(checked.nonce, checked.expiresAt))) {
    return { ok: false, reason: REPLAYED };
  }
  return { ok: true, walletAddress: checked.walletAddress };
}
