import { NextRequest, NextResponse } from "next/server";

/**
 * Nonce-based Content-Security-Policy.
 *
 * A fresh nonce is generated per request and attached to Next.js's own inline
 * bootstrap scripts (Next reads the CSP from the request header and injects the
 * nonce automatically). `strict-dynamic` then lets those trusted scripts load
 * the rest of the bundle, so we never need `script-src 'unsafe-inline'` in
 * production — the single biggest XSS lever a money app must close.
 *
 * `style-src` still allows inline styles because Framer Motion and Tailwind
 * inject style attributes at runtime; there is no nonce path for those.
 */
export function middleware(request: NextRequest) {
  const isDev = process.env.NODE_ENV === "development";
  const nonce = btoa(crypto.randomUUID());

  // Network origins the app legitimately talks to.
  const connectSrc = [
    "'self'",
    "https://*.stellar.org", // Horizon (testnet/mainnet) + Soroban RPC
    "https://*.sorobanrpc.com", // production Soroban RPC providers
    "https://horizon.stellar.org",
    "https://api.stellar.expert",
    "https://*.supabase.co",
    "wss://*.supabase.co",
    "https://*.walletconnect.com",
    "https://*.walletconnect.org",
    "wss://*.walletconnect.com",
    "wss://*.walletconnect.org",
    "https://*.reown.com",
    "wss://*.reown.com",
    // Dev-only: Next.js HMR websocket + fast-refresh polling.
    ...(isDev ? ["ws://localhost:*", "http://localhost:*"] : []),
  ].join(" ");

  const scriptSrc = isDev
    ? `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval' 'unsafe-inline'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;

  const csp = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: https:`,
    `font-src 'self'`,
    `connect-src ${connectSrc}`,
    // WalletConnect verification runs in an iframe; wallet QR/deeplink modals too.
    `frame-src 'self' https://verify.walletconnect.com https://verify.walletconnect.org https://*.walletconnect.org`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ]
    .join("; ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Run on all routes except static assets and image optimizer output.
     * `missing` skips prefetch/RSC requests so we don't pay the cost twice.
     */
    {
      source: "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|gif|webp|ico|webmanifest)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
