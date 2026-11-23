# Quickstart

This path takes about ten minutes when a Supabase project, its API credentials, a deployed settlement contract ID, and a funded testnet wallet are ready. SettleX requires Supabase and wallet authentication to use the app; it does not fall back to local-only expense storage.

## Prerequisites

- Node.js 20 or newer and npm 10 (the repository declares Node.js `>=20` and npm `10.8.2`).
- A Supabase project with its Project URL, anon key, JWT secret, and service-role key.
- A deployed Soroban settlement contract ID on Stellar Testnet. The repo has a historical deployed testnet ID in the README; verify it is still available before using it, or deploy a contract with [`../scripts/deploy-contract.sh`](../scripts/deploy-contract.sh).
- A Stellar wallet on Testnet with enough test XLM for fees and the share payment. Fund it with [Friendbot](https://horizon-testnet.stellar.org/friendbot).
- A second, distinct Stellar public address to use as the creditor in the sample expense. Only the connected wallet needs funds for this payment.

## 1. Clone and install

```bash
git clone https://github.com/SnigdhaMandal/SettleX.git
cd SettleX
npm install
```

## 2. Prepare Supabase

Create a project, open its SQL Editor, and run the complete [`supabase-setup.sql`](../supabase-setup.sql) from the repository root. This creates the application schema, RLS policies, shared auth nonce and rate-limit stores, and revocation functions. Keep the SQL in sync with the checked-in setup file when updating an existing project.

From **Project Settings -> API**, copy the Project URL, anon key, JWT secret, and service-role key. Keep the service-role key server-side only.

## 3. Configure the app

Copy the example environment file:

```bash
cp .env.local.example .env.local
```

Set these values in `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY
SUPABASE_JWT_SECRET=YOUR_SUPABASE_JWT_SECRET
AUTH_CHALLENGE_SECRET=GENERATE_A_DIFFERENT_RANDOM_SECRET
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
AUTH_SESSION_TTL_SECONDS=3600
NEXT_PUBLIC_CONTRACT_ID=YOUR_DEPLOYED_TESTNET_CONTRACT_ID
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

Generate a distinct challenge secret with `openssl rand -base64 48`. The JWT secret and challenge secret must differ. The RPC and Horizon URLs in the example point to Testnet, but the contract ID is intentionally empty; the app cannot perform Soroban settlement until you set it. Never prefix server secrets with `NEXT_PUBLIC_`. See [Authentication Setup](AUTHENTICATION_SETUP.md) for cookie, token, and revocation details.

## 4. Start and sign in

```bash
npm run dev
```

Open <http://localhost:3000>, connect your Testnet wallet, then complete the sign-in request by reviewing and signing the challenge in the wallet. The server verifies the signature and sets the session cookie. If sign-in fails, check the server configuration and `/api/health` response.

## 5. Create and pay a share

1. Fund the wallet with Testnet XLM using Friendbot and wait for the balance to appear.
2. Open Expenses and create a small expense with two members. Enter the connected wallet for the member who owes a share, enter the second public address for the creditor, and select the creditor in the form's **Paid by** field. Use an equal split to keep the first payment straightforward.
3. Save the expense, then choose **Pay XLM** for the connected wallet's share. Review the payment in your wallet and sign it.
4. Wait for Horizon confirmation. The app records the transaction hash and marks that share paid; open the transaction link to verify it on the Stellar Testnet explorer.

The transfer is a direct Stellar payment from the connected wallet to the creditor. The Soroban contract stores a settlement receipt; it does not move XLM or independently verify the Horizon transaction. See [Architecture and Limitations](ARCHITECTURE_AND_LIMITATIONS.md).

## Common setup problems

- **Sign-in returns a configuration error:** check the Supabase URL and anon key, `SUPABASE_JWT_SECRET`, and (in production) distinct `AUTH_CHALLENGE_SECRET`.
- **Health check reports missing configuration:** check `/api/health` and set each required variable from [`lib/config/requirements.ts`](../lib/config/requirements.ts).
- **Auth replay/rate limits or sign-out revocation are unavailable:** verify `supabase-setup.sql` was applied and `SUPABASE_SERVICE_ROLE_KEY` is set server-side.
- **Contract interaction fails:** confirm that `NEXT_PUBLIC_CONTRACT_ID` names a deployed contract on the same Testnet as the configured Soroban RPC.
- **Wallet has no balance:** fund its public key through Friendbot and confirm the wallet is on Testnet.
- **Service worker changes do not appear during development:** service worker registration is disabled by design in `npm run dev`.
