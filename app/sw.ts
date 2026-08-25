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
    { matcher: /^https:\/\/horizon(-testnet)?\.stellar\.org\//, handler: new NetworkOnly() },
    { matcher: /^https:\/\/soroban(-testnet)?\.stellar\.org\//, handler: new NetworkOnly() },
    { matcher: /^https:\/\/[^/]*sorobanrpc\.com\//, handler: new NetworkOnly() },
    { matcher: /^https:\/\/[^/]*\.supabase\.co\//, handler: new NetworkOnly() },
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
