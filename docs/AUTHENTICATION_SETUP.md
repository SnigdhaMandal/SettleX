# Wallet Authentication Setup

SettleX authenticates a user by having a Stellar wallet sign a short-lived server challenge. The server verifies the Ed25519 signature, then issues a Supabase-compatible JWT whose `wallet_address` claim drives Row Level Security (RLS). The JWT is stored only in an HttpOnly cookie (named `__Host-settlex_session` with Secure in production); browser database calls pass through the same-origin Supabase proxy.

## Sign-in and database request flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant W as Stellar wallet
    participant A as SettleX auth routes
    participant S as Supabase / PostgREST
    B->>A: POST /api/auth/challenge (wallet address)
    A-->>B: challenge transaction + signed challengeToken
    B->>W: Ask wallet to sign transaction
    W-->>B: Signed transaction XDR
    B->>A: POST /api/auth/verify (XDR + challengeToken)
    A->>A: Verify HMAC binding, nonce, expiry and Ed25519 signature
    A->>S: Atomically consume nonce in shared store
    A->>A: Mint JWT (wallet_address, jti, exp)
    A-->>B: Set HttpOnly session cookie; return expiry metadata
    B->>A: Same-origin /api/supabase/rest/v1 request + cookie
    A->>A: Verify JWT signature and expiry
    A->>S: Forward request with verified JWT
    S->>S: Apply RLS using public.settlex_wallet(); reject revoked jti
    S-->>B: Authorized rows
```

The challenge transaction uses sequence number zero, so it can be signed but not submitted as a payment. The wallet signs locally; the private key never leaves the wallet. The challenge expires after 60 seconds and is single-use. The challenge token is HMAC-bound to the wallet, nonce, and expiry. Verification also checks the signed transaction's source and nonce data before the server issues a session.

## Session lifetime and sign-out

- `AUTH_SESSION_TTL_SECONDS` sets the JWT lifetime. The default is 3600 seconds (1 hour); values are capped at 43200 seconds (12 hours). Renewing requires signing a fresh challenge.
- Tokens include a unique `jti`. Normal sign-out revokes that token until it expires, clears the cookie, and removes the browser's in-memory session.
- “Sign out everywhere” revokes all sessions for that wallet issued before the revocation marker. It is intended for a lost device or suspected compromise.
- Revocation requires `SUPABASE_SERVICE_ROLE_KEY`. If that key or the revocation store is unavailable, the route reports sign-out failure rather than claiming that server revocation succeeded.
- The JWT is never returned in JSON, stored in localStorage, or exposed to browser JavaScript. The browser retains only wallet and expiry metadata in memory. The cookie survives reloads. HttpOnly protects token confidentiality; an active XSS can still issue authenticated actions through the page.

## Required environment variables

Set these in `.env.local` for local work and in the server's secret store for deployment:

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Required | Supabase project endpoint used by the proxy and client. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Required | Public Supabase key; RLS is the access boundary. |
| `SUPABASE_JWT_SECRET` | Required | Signs the JWT accepted by PostgREST and RLS. |
| `AUTH_CHALLENGE_SECRET` | Required in production; recommended locally | HMAC key binding issued challenges. Must differ from the JWT secret. In non-production only, it can fall back to `SUPABASE_JWT_SECRET`. Generate with `openssl rand -base64 48`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Required for shared protections and revocation | Server-only access to shared nonce consumption, rate limits, and token revocation. Never expose it to the browser. |
| `AUTH_SESSION_TTL_SECONDS` | Optional | Token lifetime in seconds; default 3600, maximum 43200. |

The service-role-backed tables and RPCs must exist before shared protections work. In the Supabase SQL Editor, run the current root [`supabase-setup.sql`](../supabase-setup.sql). That script includes `auth_nonces`, `auth_rate_limits`, and revocation functions. Without the service-role key, verification fails closed because the shared nonce cannot be consumed, rate limiting falls back to process-local memory, and sign-out cannot revoke JWTs. Configure this key for local sign-in and deployments; process-local limits do not provide cross-instance protection.

Do not prefix secrets with `NEXT_PUBLIC_`; Next.js inlines those values into browser bundles. Production also requires `AUTH_CHALLENGE_SECRET` to be set separately from `SUPABASE_JWT_SECRET`. The deployment requirements are listed in [`lib/config/requirements.ts`](../lib/config/requirements.ts).

## RLS and upgrade notes

RLS policies read the verified wallet claim through `public.settlex_wallet()`. A client-supplied `x-wallet-address` header is not accepted as identity. For an older Supabase project, rerun the current `supabase-setup.sql` and deploy the matching auth schema before using the app. See [`docs/SUPABASE_SETUP.md`](SUPABASE_SETUP.md) for the Supabase project setup walkthrough and [`docs/ARCHITECTURE_AND_LIMITATIONS.md`](ARCHITECTURE_AND_LIMITATIONS.md) for security boundaries and operational limitations.
