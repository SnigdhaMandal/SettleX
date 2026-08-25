import { Keypair, TransactionBuilder, Transaction } from "@stellar/stellar-sdk";
import {
  createChallenge,
  isValidWalletAddress,
  resetNonceCache,
  verifyChallenge,
} from "@/lib/auth/challenge";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";

const SECRET = "test-challenge-secret";

function signChallenge(xdr: string, keypair: Keypair): string {
  const transaction = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction;
  transaction.sign(keypair);
  return transaction.toXDR();
}

describe("isValidWalletAddress", () => {
  it("accepts an ed25519 public key", () => {
    expect(isValidWalletAddress(Keypair.random().publicKey())).toBe(true);
  });

  it("rejects secrets, contract ids and junk", () => {
    expect(isValidWalletAddress(Keypair.random().secret())).toBe(false);
    expect(isValidWalletAddress("not-a-key")).toBe(false);
    expect(isValidWalletAddress("")).toBe(false);
    expect(isValidWalletAddress(42)).toBe(false);
  });
});

describe("createChallenge", () => {
  it("builds an unsubmittable transaction for the wallet", () => {
    const keypair = Keypair.random();
    const challenge = createChallenge(keypair.publicKey(), SECRET);
    const transaction = TransactionBuilder.fromXDR(
      challenge.transactionXdr,
      NETWORK_PASSPHRASE,
    ) as Transaction;

    // Sequence 0 is always below an account's real sequence, so the network
    // can never accept this transaction.
    expect(transaction.sequence).toBe("0");
    expect(transaction.source).toBe(keypair.publicKey());
    expect(transaction.operations).toHaveLength(1);
    expect(transaction.signatures).toHaveLength(0);
  });

  it("issues a fresh nonce every time", () => {
    const wallet = Keypair.random().publicKey();

    expect(createChallenge(wallet, SECRET).transactionXdr).not.toBe(
      createChallenge(wallet, SECRET).transactionXdr,
    );
  });

  it("rejects an invalid wallet address", () => {
    expect(() => createChallenge("nope", SECRET)).toThrow(/valid Stellar public key/i);
  });
});

describe("verifyChallenge", () => {
  beforeEach(() => resetNonceCache());

  it("accepts a challenge signed by the matching wallet", () => {
    const keypair = Keypair.random();
    const challenge = createChallenge(keypair.publicKey(), SECRET);

    expect(
      verifyChallenge({
        walletAddress: keypair.publicKey(),
        signedTransactionXdr: signChallenge(challenge.transactionXdr, keypair),
        challengeToken: challenge.challengeToken,
        secret: SECRET,
      }),
    ).toEqual({ ok: true, walletAddress: keypair.publicKey() });
  });

  it("rejects an unsigned challenge", () => {
    const keypair = Keypair.random();
    const challenge = createChallenge(keypair.publicKey(), SECRET);

    const result = verifyChallenge({
      walletAddress: keypair.publicKey(),
      signedTransactionXdr: challenge.transactionXdr,
      challengeToken: challenge.challengeToken,
      secret: SECRET,
    });

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/signature/i) });
  });

  it("rejects a challenge signed by a different key", () => {
    const victim = Keypair.random();
    const attacker = Keypair.random();
    const challenge = createChallenge(victim.publicKey(), SECRET);

    const result = verifyChallenge({
      walletAddress: victim.publicKey(),
      signedTransactionXdr: signChallenge(challenge.transactionXdr, attacker),
      challengeToken: challenge.challengeToken,
      secret: SECRET,
    });

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/signature/i) });
  });

  it("rejects claiming someone else's wallet with your own signature", () => {
    const victim = Keypair.random();
    const attacker = Keypair.random();
    const challenge = createChallenge(attacker.publicKey(), SECRET);

    const result = verifyChallenge({
      walletAddress: victim.publicKey(),
      signedTransactionXdr: signChallenge(challenge.transactionXdr, attacker),
      challengeToken: challenge.challengeToken,
      secret: SECRET,
    });

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/different wallet/i) });
  });

  it("rejects a challenge token this server did not issue", () => {
    const keypair = Keypair.random();
    const forged = createChallenge(keypair.publicKey(), "attacker-secret");

    const result = verifyChallenge({
      walletAddress: keypair.publicKey(),
      signedTransactionXdr: signChallenge(forged.transactionXdr, keypair),
      challengeToken: forged.challengeToken,
      secret: SECRET,
    });

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/not issued/i) });
  });

  it("rejects a nonce swapped in from another challenge", () => {
    const keypair = Keypair.random();
    const mine = createChallenge(keypair.publicKey(), SECRET);
    const other = createChallenge(keypair.publicKey(), SECRET);

    const result = verifyChallenge({
      walletAddress: keypair.publicKey(),
      signedTransactionXdr: signChallenge(other.transactionXdr, keypair),
      challengeToken: mine.challengeToken,
      secret: SECRET,
    });

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/nonce/i) });
  });

  it("rejects an expired challenge", () => {
    const keypair = Keypair.random();
    const challenge = createChallenge(keypair.publicKey(), SECRET);

    const result = verifyChallenge({
      walletAddress: keypair.publicKey(),
      signedTransactionXdr: signChallenge(challenge.transactionXdr, keypair),
      challengeToken: challenge.challengeToken,
      secret: SECRET,
      now: Date.now() + 10 * 60 * 1000,
    });

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/expired/i) });
  });

  it("rejects replaying a challenge that was already used", () => {
    const keypair = Keypair.random();
    const challenge = createChallenge(keypair.publicKey(), SECRET);
    const signed = signChallenge(challenge.transactionXdr, keypair);

    const args = {
      walletAddress: keypair.publicKey(),
      signedTransactionXdr: signed,
      challengeToken: challenge.challengeToken,
      secret: SECRET,
    };

    expect(verifyChallenge(args).ok).toBe(true);
    expect(verifyChallenge(args)).toEqual({
      ok: false,
      reason: expect.stringMatching(/already been used/i),
    });
  });

  it("rejects undecodable input", () => {
    const keypair = Keypair.random();
    const challenge = createChallenge(keypair.publicKey(), SECRET);

    expect(
      verifyChallenge({
        walletAddress: keypair.publicKey(),
        signedTransactionXdr: "not-xdr",
        challengeToken: challenge.challengeToken,
        secret: SECRET,
      }),
    ).toEqual({ ok: false, reason: expect.stringMatching(/decoded/i) });
  });

  it("rejects missing arguments and bad addresses", () => {
    expect(
      verifyChallenge({
        walletAddress: "nope",
        signedTransactionXdr: "x",
        challengeToken: "y",
        secret: SECRET,
      }).ok,
    ).toBe(false);

    expect(
      verifyChallenge({
        walletAddress: Keypair.random().publicKey(),
        signedTransactionXdr: "",
        challengeToken: "",
        secret: SECRET,
      }).ok,
    ).toBe(false);
  });
});
