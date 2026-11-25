# Supabase Setup

SettleX requires Supabase for wallet authentication and application data, including
local development. Pages are protected by `AuthGuard`; the app does not fall back
to browser-only storage when Supabase is unavailable. Expense and trip updates
are refreshed by polling while a page is visible.

## 1. Create a project

1. Create a project at [supabase.com](https://supabase.com) and wait for it to finish provisioning.
2. In the project dashboard, open **Project Settings → API** and copy the **Project URL** and **anon public** key.

## 2. Load the schema and policies

1. Open the project's **SQL Editor**.
2. Run the full [`supabase-setup.sql`](../supabase-setup.sql) file from this repository.

The script creates the application tables and Row Level Security (RLS) policies,
as well as the shared authentication nonce, rate-limit, and token-revocation
stores and functions. Re-run the checked-in script when setting up a new project
or upgrading an existing one. Do not disable RLS.

## 3. Configure the JWT signing secret

SettleX currently creates and verifies wallet session tokens with **HS256**,
using one shared secret in `SUPABASE_JWT_SECRET`. Supabase projects using an
asymmetric signing key (such as ES256 or RS256) are not compatible with this
implementation. Use the project's **legacy JWT secret** for this setting; do
not use an asymmetric signing key's public key or key ID.

In the dashboard, open **Project Settings → JWT Keys** and locate the **Legacy JWT Secret** section. Copy that secret to `SUPABASE_JWT_SECRET`. Supabase's newer signing-key system does not`r`nlet you retrieve the private key for an asymmetric key, so it cannot be used by
this app to mint its own HS256 tokens. If the legacy secret is unavailable for
your project, this app's current auth implementation cannot use that project's
JWT configuration.

Supabase documents the distinction between its legacy JWT secret and signing
keys in its [JWT Signing Keys guide](https://supabase.com/docs/guides/auth/signing-keys).

## 4. Add application environment variables

Copy `.env.local.example` to `.env.local`, then set these values:

```env
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
SUPABASE_JWT_SECRET=YOUR_LEGACY_JWT_SECRET
AUTH_CHALLENGE_SECRET=YOUR_DISTINCT_RANDOM_SECRET
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
AUTH_SESSION_TTL_SECONDS=3600
```

`AUTH_CHALLENGE_SECRET` must be different from `SUPABASE_JWT_SECRET` and is
required in production. Generate a value with `openssl rand -base64 48`.
`AUTH_SESSION_TTL_SECONDS` is optional; the default is one hour and the maximum
is 12 hours.

`SUPABASE_SERVICE_ROLE_KEY` is the legacy JWT-based `service_role` key from **Project Settings → API Keys** and is server-only. It backs shared challenge replay
protection, rate limiting, and sign-out revocation. Set it for local use as
well as deployment: without it, challenge verification fails closed, sign-out
cannot revoke server-side, and rate limiting can only fall back to process-local
memory. Never prefix server secrets with `NEXT_PUBLIC_`.

For wallet challenge, cookie, and token behavior, see
[Authentication Setup](AUTHENTICATION_SETUP.md). The full environment reference
is in the [README](../README.md#environment-variables).

## 5. Run locally

Start the app with `npm run dev`, then open <http://localhost:3000> and sign in
with a supported Stellar wallet. The server verifies the wallet-signed
challenge before creating the session used by RLS.

No Supabase Realtime publication setup is required. SettleX uses authenticated
same-origin REST requests through its Next.js proxy and polls for shared expense
and trip changes because the session JWT stays in an HttpOnly cookie.

## Security checks before production

The anon key is public; RLS policies are the row-level access boundary. Before
real users:

1. Confirm RLS is enabled on every application table.
2. Verify that policies authorize using the verified `wallet_address` JWT claim
   through `public.settlex_wallet()`, not a client-supplied wallet address.
3. Test that one wallet cannot read or modify another wallet's rows.
4. Keep the service-role key, JWT secret, and challenge secret only in the
   server's secret store.

Use separate Supabase projects for testnet staging and mainnet production.
