# Architecture Assumptions and Known Limitations

## Architecture Summary

SettleX uses:

- Next.js + TypeScript frontend
- Next.js route handlers (`/api/auth/*`) for SEP-10 style wallet authentication
- Supabase for app data and realtime sync
- Stellar payment operations for value transfer
- Soroban settlement contract for immutable payment recording
- Separate pool contract for inter-contract withdraw flow

## Key Assumptions

- Users operate on Stellar testnet, not mainnet.
- Wallet extensions (Freighter, xBull, Lobstr) are available client-side.
- Supabase anon key is safe with proper RLS policies. It carries no identity of
  its own: RLS authorizes on the `wallet_address` claim of a JWT that
  `/api/auth/verify` signs with `SUPABASE_JWT_SECRET`, and that secret is only
  ever read server-side.
- `SUPABASE_JWT_SECRET` (and `AUTH_CHALLENGE_SECRET`, when set) are configured
  as server-only environment variables. Prefixing either with `NEXT_PUBLIC_`
  would let any visitor mint a token for any wallet.
- Contract IDs in env/docs are synchronized with deployed testnet contracts.

## Authentication Model

- A wallet proves key ownership by signing a server-issued challenge
  transaction built with sequence number 0, which the network can never accept.
- The challenge nonce is bound to the wallet and an expiry by an HMAC, so the
  handshake needs no shared session store.
- On success the server mints a Supabase JWT carrying `wallet_address`. Every
  RLS policy reads it through `public.settlex_wallet()`; requests without a
  valid token match no rows.
- Sessions are cached in `localStorage` and last 12 hours by default
  (`AUTH_SESSION_TTL_SECONDS`, capped at 24 hours).

## Known Limitations

- Project is testnet-oriented; mainnet operational controls are not included.
- README still needs one explicit phone viewport screenshot for final checklist completeness.
- CI merge protection enforcement is a GitHub repository setting and must be enabled manually in repo settings.
- Wallet UX depends on extension behavior and user approval flow, including the
  one-per-session signature that establishes an authenticated session.
- Challenge nonces are burned in process memory, so the single-use guard is
  per-instance. On a multi-instance deployment a captured challenge could be
  replayed against a sibling instance within its 5-minute window; TLS and that
  short TTL are what bound the exposure. A shared store (Redis, a Postgres
  table) would close it.
- Issued access tokens are bearer tokens with no revocation list. Signing out
  clears the browser's copy but a leaked token stays valid until it expires —
  shorten `AUTH_SESSION_TTL_SECONDS` if that matters for your deployment.
- Expense and trip UPDATE policies let any member rewrite the whole row,
  including `member_wallets`. Membership is therefore only as trustworthy as
  the other members of a split.
- Some screenshots in README are desktop captures; mobile screenshots should be added for evaluator clarity.
- Pool balances are internal contract accounting credits, not native XLM/token custody transfers on-chain.
- `record_payment` stores provided `tx_hash` metadata and relies on app flow integrity; it does not cryptographically verify Horizon payment details inside the contract.

## Operational Constraints

- Any contract redeployment changes contract ID and requires env + README updates.
- Incorrect wallet/account setup can block end-to-end payment tests.
- Supabase configuration errors can affect sync behavior even if chain operations work.

## Recommended Future Improvements

- Add automated e2e tests (Playwright) with mobile viewport assertions.
- Add a script to validate README proof links are live.
- Add an automated checklist CI job that verifies required docs/sections exist.
- Introduce token/native-asset backed pool settlement model (transfer in/out) for stronger economic guarantees.
- Add off-chain verifier service (or on-chain protocol changes) to bind `tx_hash` to payer/member/amount claims.
- Move challenge nonces and a token revocation list into a shared store so the
  replay guard and sign-out hold across instances.
- Narrow the expense/trip UPDATE policies so membership and creator columns can
  only be changed by the creator.
