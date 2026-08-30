import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { createChallenge, resetNonceCache, verifyChallengeShared } from "@/lib/auth/challenge";
import { enforceRateLimit, resetRateLimits } from "@/lib/auth/rateLimit";
import {
  SharedStoreUnavailable,
  consumeNonceShared,
  isSharedStoreConfigured,
  rateLimitShared,
} from "@/lib/auth/sharedStore";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";

const SECRET = "test-challenge-secret";
const SERVICE_KEY = "test-service-role-key";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function mockFetch(handler: (fn: string, args: Record<string, unknown>) => Response): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init: RequestInit) => {
    const fn = String(url).split("/rpc/")[1];
    return handler(fn, JSON.parse(String(init.body)));
  });
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  return fetchMock as unknown as jest.Mock;
}

function signChallenge(xdr: string, keypair: Keypair): string {
  const transaction = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE) as Transaction;
  transaction.sign(keypair);
  return transaction.toXDR();
}

const originalFetch = global.fetch;

describe("sharedStore", () => {
  beforeEach(() => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
    resetNonceCache();
    resetRateLimits();
  });

  afterEach(() => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("is configured only when the service role key is present", () => {
    expect(isSharedStoreConfigured()).toBe(true);

    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(isSharedStoreConfigured()).toBe(false);
  });

  it("authenticates the RPC call with the service role key, never the anon key", async () => {
    const fetchMock = mockFetch(() => jsonResponse(true));
    await consumeNonceShared("nonce", 1000);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/rest/v1/rpc/auth_consume_nonce");
    expect((init.headers as Record<string, string>).apikey).toBe(SERVICE_KEY);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SERVICE_KEY}`);
  });

  it("reports a replayed nonce as not consumed", async () => {
    mockFetch(() => jsonResponse(false));
    await expect(consumeNonceShared("nonce", 1000)).resolves.toBe(false);
  });

  it("raises SharedStoreUnavailable when the RPC fails", async () => {
    mockFetch(() => jsonResponse({ message: "boom" }, 500));
    await expect(consumeNonceShared("nonce", 1000)).rejects.toBeInstanceOf(SharedStoreUnavailable);
  });

  it("reads the rate-limit row Postgres returns as a single-row table", async () => {
    mockFetch(() => jsonResponse([{ allowed: false, retry_after: 42 }]));

    await expect(rateLimitShared("k", 30, 60_000)).resolves.toEqual({
      allowed: false,
      retryAfter: 42,
    });
  });
});

describe("verifyChallengeShared", () => {
  beforeEach(() => {
    resetNonceCache();
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  });

  afterEach(() => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    global.fetch = originalFetch;
  });

  function signedChallenge() {
    const keypair = Keypair.random();
    const challenge = createChallenge(keypair.publicKey(), SECRET);
    return {
      walletAddress: keypair.publicKey(),
      signedTransactionXdr: signChallenge(challenge.transactionXdr, keypair),
      challengeToken: challenge.challengeToken,
      secret: SECRET,
    };
  }

  it("accepts a signed challenge and burns its nonce in the shared store", async () => {
    const burned = new Set<string>();
    const fetchMock = mockFetch((_fn, args) => {
      const nonce = String(args.p_nonce);
      const fresh = !burned.has(nonce);
      burned.add(nonce);
      return jsonResponse(fresh);
    });

    const params = signedChallenge();
    await expect(verifyChallengeShared(params)).resolves.toEqual({
      ok: true,
      walletAddress: params.walletAddress,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a replay even though this process never saw the nonce", async () => {
    // The whole point: process memory is empty, the shared store is not.
    mockFetch(() => jsonResponse(false));

    await expect(verifyChallengeShared(signedChallenge())).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(/already been used/i),
    });
  });

  it("fails closed when the shared store is unreachable", async () => {
    mockFetch(() => jsonResponse({}, 503));

    await expect(verifyChallengeShared(signedChallenge())).rejects.toBeInstanceOf(
      SharedStoreUnavailable,
    );
  });

  it("falls back to the in-memory guard when no shared store is configured", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const params = signedChallenge();

    await expect(verifyChallengeShared(params)).resolves.toEqual({
      ok: true,
      walletAddress: params.walletAddress,
    });
    await expect(verifyChallengeShared(params)).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(/already been used/i),
    });
  });
});

describe("enforceRateLimit", () => {
  beforeEach(() => resetRateLimits());

  afterEach(() => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("uses the shared window when one is configured", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
    mockFetch(() => jsonResponse([{ allowed: false, retry_after: 7 }]));

    await expect(enforceRateLimit("k", 30, 60_000)).resolves.toEqual({
      allowed: false,
      retryAfter: 7,
    });
  });

  it("falls back to the in-memory window when the shared store errors", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockFetch(() => jsonResponse({}, 500));

    await expect(enforceRateLimit("k", 1, 60_000)).resolves.toEqual({
      allowed: true,
      retryAfter: 0,
    });
    expect((await enforceRateLimit("k", 1, 60_000)).allowed).toBe(false);
  });

  it("uses the in-memory window when nothing is configured", async () => {
    await expect(enforceRateLimit("k", 1, 60_000)).resolves.toEqual({
      allowed: true,
      retryAfter: 0,
    });
    expect((await enforceRateLimit("k", 1, 60_000)).allowed).toBe(false);
  });
});
