import { NextRequest, NextResponse } from "next/server";

/**
 * Sets a per-request nonce-based Content-Security-Policy on document responses.
 * `style-src` keeps 'unsafe-inline' for Framer Motion and Tailwind runtime styles;
 * document CSP lives solely here (static asset CSP is in next.config.mjs).
 */
export function middleware(request: NextRequest) {
  const isDev = process.env.NODE_ENV === "development";
  const nonce = btoa(crypto.randomUUID());

  function getOrigin(url?: string) {
    if (!url) return undefined;
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  }

  const horizonOrigin = getOrigin(process.env.NEXT_PUBLIC_HORIZON_URL);
  const sorobanOrigin = getOrigin(process.env.NEXT_PUBLIC_SOROBAN_RPC_URL);
  const supabaseOrigin = getOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);

  const connectSrc = [
    "'self'",
    horizonOrigin,
    sorobanOrigin,
    supabaseOrigin,
    supabaseOrigin ? supabaseOrigin.replace(/^http/, "ws") : undefined,
    "https://api.stellar.expert",
    "https://*.walletconnect.com",
    "https://*.walletconnect.org",
    "wss://*.walletconnect.com",
    "wss://*.walletconnect.org",
    "https://*.reown.com",
    "wss://*.reown.com",
    ...(isDev ? ["ws://localhost:*", "http://localhost:*"] : []), // Next.js HMR & fast-refresh
  ].filter(Boolean).join(" ");

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
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`, // keep in sync with X-Frame-Options: DENY in next.config.mjs
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
    // Skip static assets, image optimizer, and prefetch/RSC requests
    {
      source: "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|gif|webp|ico|webmanifest)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
