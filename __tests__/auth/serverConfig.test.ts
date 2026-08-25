import { DEFAULT_SESSION_TTL_SECONDS } from "@/lib/auth/constants";
import {
  AuthConfigError,
  getChallengeSecret,
  getJwtSecret,
  getSessionTtlSeconds,
} from "@/lib/auth/serverConfig";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("getJwtSecret", () => {
  it("returns the configured secret", () => {
    process.env.SUPABASE_JWT_SECRET = "shhh";
    expect(getJwtSecret()).toBe("shhh");
  });

  it("fails loudly when unset rather than signing with a blank key", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    expect(() => getJwtSecret()).toThrow(AuthConfigError);
  });
});

describe("getChallengeSecret", () => {
  it("prefers its own secret", () => {
    process.env.SUPABASE_JWT_SECRET = "jwt";
    process.env.AUTH_CHALLENGE_SECRET = "challenge";
    expect(getChallengeSecret()).toBe("challenge");
  });

  it("falls back to the JWT secret", () => {
    process.env.SUPABASE_JWT_SECRET = "jwt";
    delete process.env.AUTH_CHALLENGE_SECRET;
    expect(getChallengeSecret()).toBe("jwt");
  });
});

describe("getSessionTtlSeconds", () => {
  it("defaults when unset or unparseable", () => {
    delete process.env.AUTH_SESSION_TTL_SECONDS;
    expect(getSessionTtlSeconds()).toBe(DEFAULT_SESSION_TTL_SECONDS);

    process.env.AUTH_SESSION_TTL_SECONDS = "abc";
    expect(getSessionTtlSeconds()).toBe(DEFAULT_SESSION_TTL_SECONDS);

    process.env.AUTH_SESSION_TTL_SECONDS = "-5";
    expect(getSessionTtlSeconds()).toBe(DEFAULT_SESSION_TTL_SECONDS);
  });

  it("honours a configured lifetime", () => {
    process.env.AUTH_SESSION_TTL_SECONDS = "3600";
    expect(getSessionTtlSeconds()).toBe(3600);
  });

  it("caps a typo at 24 hours", () => {
    process.env.AUTH_SESSION_TTL_SECONDS = "99999999";
    expect(getSessionTtlSeconds()).toBe(24 * 60 * 60);
  });
});
