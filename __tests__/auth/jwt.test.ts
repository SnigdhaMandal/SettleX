import { issueAccessToken, safeEqual, signJwt, verifyJwt, walletToUuid } from "@/lib/auth/jwt";

const SECRET = "test-jwt-secret";

describe("signJwt / verifyJwt", () => {
  it("round-trips claims", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = signJwt({ role: "authenticated", exp }, SECRET);

    expect(verifyJwt(token, SECRET)).toMatchObject({ role: "authenticated", exp });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signJwt({ exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);

    expect(verifyJwt(token, "other-secret")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signJwt(
      { wallet_address: "GA", exp: Math.floor(Date.now() / 1000) + 60 },
      SECRET,
    );
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ wallet_address: "GB", exp: 2 ** 40 }))
      .toString("base64url");

    expect(verifyJwt(`${header}.${forged}.${signature}`, SECRET)).toBeNull();
  });

  it("rejects an unsigned (alg: none) token", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ wallet_address: "GA", exp: Math.floor(Date.now() / 1000) + 60 }),
    ).toString("base64url");

    expect(verifyJwt(`${header}.${payload}.`, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = signJwt({ exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);

    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyJwt("", SECRET)).toBeNull();
    expect(verifyJwt("a.b", SECRET)).toBeNull();
    expect(verifyJwt("a.b.c.d", SECRET)).toBeNull();
  });

  it("refuses to sign without a secret", () => {
    expect(() => signJwt({}, "")).toThrow(/secret/i);
  });
});

describe("safeEqual", () => {
  it("compares equal strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("rejects differing values and lengths", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("walletToUuid", () => {
  const wallet = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAY";

  it("is deterministic", () => {
    expect(walletToUuid(wallet)).toBe(walletToUuid(wallet));
  });

  it("produces a v4-shaped RFC 4122 UUID", () => {
    expect(walletToUuid(wallet)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("differs per wallet", () => {
    const other = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
    expect(walletToUuid(wallet)).not.toBe(walletToUuid(other));
  });
});

describe("issueAccessToken", () => {
  const wallet = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAY";

  it("carries the wallet claim RLS authorizes on", () => {
    const { token, expiresAt } = issueAccessToken({
      walletAddress: wallet,
      secret: SECRET,
      ttlSeconds: 3600,
    });

    const claims = verifyJwt(token, SECRET);
    expect(claims).toMatchObject({
      wallet_address: wallet,
      role: "authenticated",
      aud: "authenticated",
      sub: walletToUuid(wallet),
    });
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("expires after the requested lifetime", () => {
    const now = Date.now();
    const { token } = issueAccessToken({
      walletAddress: wallet,
      secret: SECRET,
      ttlSeconds: 60,
      now,
    });

    expect(verifyJwt(token, SECRET, now + 59_000)).not.toBeNull();
    expect(verifyJwt(token, SECRET, now + 61_000)).toBeNull();
  });
});
