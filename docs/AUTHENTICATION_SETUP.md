# Authentication

## How it works today

SettleX uses **wallet-based identity**. Flow ([context/AuthContext.tsx](../context/AuthContext.tsx)):

1. User connects a Stellar wallet → the app gets their public key (`G…`).
2. **Sign up** inserts a row in the Supabase `users` table keyed by
   `wallet_address`, with a display name.
3. **Sign in** loads that row and updates `last_login_at`.
4. Supabase calls go through `createAuthenticatedClient(publicKey)`
   ([lib/supabase/client.ts](../lib/supabase/client.ts)), which attaches the
   wallet address as a header used by RLS policies.
5. The profile is cached in `localStorage` (`settlex:user`) so a refresh doesn't
   flash logged-out.

There is **no password and no email** — the wallet is the account.

## ⚠️ Known limitation (must fix before mainnet)

> The wallet address is currently **client-supplied and not cryptographically
> verified.** Nothing stops a client from claiming a wallet address it does not
> control, because the app never asks the wallet to *prove* ownership by signing
> a challenge. RLS built on that header is therefore only as strong as the
> unproven header.

This is fine for a testnet demo, **not** for a product handling real value.

### The production fix: Sign-In With Stellar (challenge–response)
1. Server issues a random nonce.
2. The user's wallet **signs** the nonce (`kit.signTransaction` / a SEP-10-style
   challenge transaction).
3. Server **verifies** the signature matches the claimed public key, then issues
   a short-lived session (e.g. a Supabase JWT).
4. RLS policies key off that verified session identity — not a raw header.

See §10.2 of [PRODUCT_CONVERSION_GUIDE.md](./PRODUCT_CONVERSION_GUIDE.md). This
requires a small backend route (challenge issue + verify) and is the foundation
for trustworthy RLS ([SUPABASE_SETUP.md](./SUPABASE_SETUP.md)).

## Configuration
Server-only env vars, all listed in
[.env.local.example](../.env.local.example) — none may be prefixed
`NEXT_PUBLIC_`:

- `SUPABASE_JWT_SECRET` — signs the access tokens RLS authorizes on.
- `AUTH_CHALLENGE_SECRET` — optional, binds a nonce to its wallet; falls back to
  the JWT secret.
- `AUTH_SESSION_TTL_SECONDS` — optional session lifetime, default 12h.
- `SUPABASE_SERVICE_ROLE_KEY` — **required on any multi-instance deployment.**
  It backs the shared replay guard and rate limiter (`auth_nonces`,
  `auth_rate_limits`). Without it both fall back to per-process memory, so a
  captured challenge can be replayed against another serverless instance within
  the 60-second challenge TTL and the 30/min limit becomes 30/min *per
  instance*.

Ensure the `users` table, its RLS policies and the auth shared-state tables from
[supabase-setup.sql](../supabase-setup.sql) are loaded.
