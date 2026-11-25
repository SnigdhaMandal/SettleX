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

function getOrigin(url?: string) {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Custom Horizon, Soroban, and Supabase origins must stay network-only so stale balances/state never get cached
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
    // Never cache chain reads or DB writes — stale balances would be a bug
    { matcher: /^https:\/\/horizon(-testnet)?\.stellar\.org\//, handler: new NetworkOnly() },
    { matcher: /^https:\/\/soroban(-testnet)?\.stellar\.org\//, handler: new NetworkOnly() },
    { matcher: /^https:\/\/[^/]*sorobanrpc\.com\//, handler: new NetworkOnly() },
    { matcher: /^https:\/\/[^/]*\.supabase\.co\//, handler: new NetworkOnly() },
    ...configuredOriginMatchers, // custom env origins
    // Skip caching API routes (defaultCache would otherwise NetworkFirst them for 24h)
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/") || url.pathname === "/api",
      handler: new NetworkOnly(),
    },
    { matcher: /^https?:\/\/[^/]+\/api(?:\/|$)/, handler: new NetworkOnly() },
    ...defaultCache, // app shell, static assets, marketing
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
