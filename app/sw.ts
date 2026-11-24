/// <reference lib="webworker" />
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

function getOrigin(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── DYNAMIC MONEY-SAFE ORIGINS ─────────────────────────────────────────────
// Build matchers from NEXT_PUBLIC_* origins at build time (plus custom env fallbacks).
// Deployments with custom Horizon, Soroban RPC, or self-hosted Supabase must
// be network-only to prevent serving stale balances or contract state.
const configuredOrigins = Array.from(
  new Set(
    [
      process.env.NEXT_PUBLIC_HORIZON_URL,
      process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
      typeof process !== "undefined" ? process.env?.SOROBAN_RPC_URL : undefined,
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      typeof process !== "undefined" ? process.env?.SUPABASE_URL : undefined,
      process.env.NEXT_PUBLIC_STELLAR_EXPLORER,
    ]
      .map(getOrigin)
      .filter((origin): origin is string => Boolean(origin))
  )
);

const configuredOriginMatchers = configuredOrigins.map((origin) => ({
  matcher: new RegExp(`^${escapeRegExp(origin)}(?:/|$)`),
  handler: new NetworkOnly(),
}));

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // ── MONEY-SAFE RULE ────────────────────────────────────────────────────
    // Chain reads (balances, sequence numbers, contract state) and DB writes
    // must NEVER be served from cache — a stale balance in a payments app is a
    // correctness/safety bug. Force network-only for these origins.
    // 1. Default public Stellar, Soroban, and Supabase endpoints
    { matcher: /^https:\/\/horizon(-testnet)?\.stellar\.org\//, handler: new NetworkOnly() },
    { matcher: /^https:\/\/soroban(-testnet)?\.stellar\.org\//, handler: new NetworkOnly() },
    { matcher: /^https:\/\/[^/]*sorobanrpc\.com\//, handler: new NetworkOnly() },
    { matcher: /^https:\/\/[^/]*\.supabase\.co\//, handler: new NetworkOnly() },
    // 2. Custom origins configured via NEXT_PUBLIC_* at build time
    ...configuredOriginMatchers,
    // ── API ROUTES ──────────────────────────────────────────────────────────
    // Internal API routes (auth challenges, session, payment verification,
    // Supabase proxy) must NEVER be served from cache — defaultCache would
    // otherwise apply NetworkFirst with up to a 24-hour cache.
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/") || url.pathname === "/api",
      handler: new NetworkOnly(),
    },
    { matcher: /^https?:\/\/[^/]+\/api(?:\/|$)/, handler: new NetworkOnly() },
    // Everything else (app shell, static assets, marketing) uses the sensible
    // Next.js defaults from Serwist.
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: "/~offline",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

serwist.addEventListeners();
