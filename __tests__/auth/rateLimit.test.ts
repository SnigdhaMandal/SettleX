import { clientKey, rateLimit, resetRateLimits } from "@/lib/auth/rateLimit";

describe("rateLimit", () => {
  beforeEach(() => resetRateLimits());

  it("allows calls up to the limit", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(rateLimit("k", 3, 1000, 0).allowed).toBe(true);
    }
  });

  it("blocks the call past the limit and reports a retry delay", () => {
    for (let i = 0; i < 3; i += 1) rateLimit("k", 3, 10_000, 0);

    const blocked = rateLimit("k", 3, 10_000, 0);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBe(10);
  });

  it("starts a fresh window once the old one lapses", () => {
    for (let i = 0; i < 3; i += 1) rateLimit("k", 3, 1000, 0);
    expect(rateLimit("k", 3, 1000, 0).allowed).toBe(false);

    expect(rateLimit("k", 3, 1000, 1500).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 3; i += 1) rateLimit("a", 3, 1000, 0);

    expect(rateLimit("a", 3, 1000, 0).allowed).toBe(false);
    expect(rateLimit("b", 3, 1000, 0).allowed).toBe(true);
  });
});

describe("clientKey", () => {
  const request = (headers: Record<string, string>) =>
    ({ headers: { get: (name: string) => headers[name] ?? null } }) as unknown as Request;

  it("prefers the first x-forwarded-for hop", () => {
    expect(clientKey(request({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip, then to a shared bucket", () => {
    expect(clientKey(request({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientKey(request({}))).toBe("unknown");
  });
});
