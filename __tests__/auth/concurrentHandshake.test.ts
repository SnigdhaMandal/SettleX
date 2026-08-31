/** @jest-environment jsdom */

/**
 * Regression tests for "the in-flight handshake promise is not keyed by wallet
 * address".
 *
 * The bug: `inFlight` was one module-level slot. A call for wallet B arriving
 * while A's handshake was pending received A's promise, and therefore A's
 * session. Nothing downstream re-checked the address, so the UI marked B
 * authenticated while every request was signed as A.
 */
import { LS_SESSION, WALLET_CLAIM } from "@/lib/auth/constants";

const WALLET_A = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";
const WALLET_B = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

jest.mock("@/lib/freighter", () => ({
  signXDR: jest.fn(async (xdr: string) => `signed:${xdr}`),
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => ({
    realtime: { setAuth: jest.fn() },
    removeAllChannels: jest.fn(),
  })),
}));

/** Builds an unsigned JWT — only the payload matters to the client. */
function tokenFor(walletAddress: string): string {
  const b64 = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({ [WALLET_CLAIM]: walletAddress, exp: Math.floor(Date.now() / 1000) + 3600 }),
    "signature-not-checked-client-side",
  ].join(".");
}

/** Lets a test hold the /verify response open, so two handshakes overlap. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type Gate = { promise: Promise<void>; resolve: () => void };

let session: typeof import("@/lib/supabase/session");
/** Gates keyed by wallet: /verify for that wallet waits here when set. */
let verifyGates: Map<string, Gate>;
let challengeCalls: string[];
let verifyCalls: string[];

beforeEach(async () => {
  jest.resetModules();
  window.localStorage.clear();
  verifyGates = new Map();
  challengeCalls = [];
  verifyCalls = [];

  global.fetch = jest.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const wallet: string = body.walletAddress;

    if (String(url).includes("challenge")) {
      challengeCalls.push(wallet);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          transactionXdr: `xdr-for-${wallet}`,
          networkPassphrase: "Test SDF Network ; September 2015",
          challengeToken: `challenge-${wallet}`,
        }),
      };
    }

    // /verify — mint a token for whoever the handshake actually asked about.
    verifyCalls.push(wallet);
    const gate = verifyGates.get(wallet);
    if (gate) await gate.promise;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        accessToken: tokenFor(wallet),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    };
  }) as unknown as typeof fetch;

  session = await import("@/lib/supabase/session");
});

function gateVerifyFor(wallet: string): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  const gate = { promise, resolve };
  verifyGates.set(wallet, gate);
  return gate;
}

describe("concurrent handshakes for different wallets", () => {
  it("does not hand wallet B the session minted for wallet A", async () => {
    // A's handshake is in flight and parked inside /verify.
    const gateA = gateVerifyFor(WALLET_A);
    const promiseA = session.getWalletSession(WALLET_A);
    // Let A get as far as its /verify call before B arrives.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // B connects mid-handshake — this is the account-switch window.
    const promiseB = session.getWalletSession(WALLET_B);

    gateA.resolve();
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    expect(resultA?.walletAddress).toBe(WALLET_A);
    // The bug returned A's session here.
    expect(resultB?.walletAddress).toBe(WALLET_B);
    expect(resultB?.accessToken).not.toBe(resultA?.accessToken);

    // B ran a real handshake of its own rather than riding on A's.
    expect(challengeCalls).toContain(WALLET_B);
    expect(verifyCalls).toContain(WALLET_B);
  });

  it("still dedupes concurrent callers for the same wallet", async () => {
    const gate = gateVerifyFor(WALLET_A);
    const first = session.getWalletSession(WALLET_A);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const second = session.getWalletSession(WALLET_A);

    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(a?.accessToken).toBe(b?.accessToken);
    // One prompt, not two — the wallet is asked to sign only once.
    expect(challengeCalls.filter((w) => w === WALLET_A)).toHaveLength(1);
  });

  it("gives each wallet a client bearing its own token", async () => {
    const gateA = gateVerifyFor(WALLET_A);
    const clientAPromise = session.getAuthenticatedClient(WALLET_A);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const clientBPromise = session.getAuthenticatedClient(WALLET_B);

    gateA.resolve();
    await Promise.all([clientAPromise, clientBPromise]);

    const { createClient } = require("@supabase/supabase-js");
    const tokens = createClient.mock.calls.map(
      (call: [string, string, { global: { headers: Record<string, string> } }]) =>
        call[2].global.headers.Authorization,
    );
    expect(tokens).toContain(`Bearer ${tokenFor(WALLET_B)}`);
  });

  it("rejects rather than returning a session for the wrong wallet", async () => {
    // A server that ignores the requested address and always mints for A is
    // exactly what the post-await assertion exists to catch.
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (String(url).includes("challenge")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            transactionXdr: "xdr",
            networkPassphrase: "Test SDF Network ; September 2015",
            challengeToken: "challenge",
          }),
        };
      }
      void body;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          accessToken: tokenFor(WALLET_A),
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      };
    }) as unknown as typeof fetch;

    await expect(session.getWalletSession(WALLET_B)).rejects.toThrow(
      /different wallet|does not belong/i,
    );
  });

  it("clears pending handshakes on sign-out", async () => {
    const gate = gateVerifyFor(WALLET_A);
    const pending = session.getWalletSession(WALLET_A);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    session.clearWalletSession();
    gate.resolve();
    await pending.catch(() => {});

    // A fresh call after sign-out must run a new handshake, not reuse the
    // pre-sign-out one.
    window.localStorage.removeItem(LS_SESSION);
    const before = challengeCalls.filter((w) => w === WALLET_A).length;
    await session.getWalletSession(WALLET_A);
    expect(challengeCalls.filter((w) => w === WALLET_A).length).toBeGreaterThan(before);
  });
});
