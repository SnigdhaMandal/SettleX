# SettleX — Split Bills. Pay On-Chain.

> A decentralised expense-splitting app built on the **Stellar Network**. Add group expenses, split them by any method, and pay each member's share directly from your Freighter wallet — all settled on-chain in under 5 seconds.

---

## Table of Contents

- [Project Description](#project-description)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [How It Works](#how-it-works)
- [Setup Instructions](#setup-instructions)
- [Environment Variables](#environment-variables)
- [Project Structure](#project-structure)
- [Blockchain Integration](#blockchain-integration)
- [Screenshots](#screenshots)

---

## Project Description

SettleX solves a common problem: splitting group expenses fairly and actually collecting the money. Traditional apps (Splitwise, etc.) only track IOUs — you still have to chase people for cash. SettleX closes the loop by letting every participant pay their exact share directly via the **Stellar blockchain** in a single click.

Key differentiators:

- **No intermediary** — money moves peer-to-peer between Stellar wallets.
- **On-chain receipts** — every payment produces a real transaction hash traceable on any Stellar explorer.
- **QR code payments** — generates a SEP-0007 payment URI so anyone with a Stellar wallet can pay by scanning.
- **Trip mode** — group multiple expenses under a trip, track net balances, and settle the whole trip with one flow.
- **Non-custodial** — your private key never leaves your Freighter wallet extension; SettleX only receives the signed transaction envelope.

---

## Features

| Feature                                                    | Status  |
| ---------------------------------------------------------- | ------- |
| Wallet connect via Freighter                               | ✅ Live |
| Create & split expenses (equal, percentage, custom weight) | ✅ Live |
| **Real-time sync across all users (Supabase)**             | ✅ Live |
| Pay shares with XLM via Freighter                          | ✅ Live |
| SEP-0007 QR code generation                                | ✅ Live |
| Transaction hash receipt                                   | ✅ Live |
| Trip mode (group expenses + settle up)                     | ✅ Live |
| Net balance calculator per trip                            | ✅ Live |
| Mobile-responsive UI                                       | ✅ Live |

---

## Tech Stack

| Layer          | Technology                              |
| -------------- | --------------------------------------- |
| Framework      | Next.js 14 (App Router, TypeScript)     |
| Styling        | Tailwind CSS 3.4, Framer Motion         |
| Blockchain SDK | `@stellar/stellar-sdk` v14              |
| Wallet         | `@stellar/freighter-api` v6             |
| Network        | Stellar Testnet (Horizon API)           |
| Database       | Supabase (PostgreSQL + Realtime)        |
| QR codes       | `qrcode.react`, `qrcode`                |
| State          | React Context + Supabase + localStorage |
| UI primitives  | Radix UI, Lucide React                  |

---

## How It Works

```
User adds expense
       ↓
Defines members + split mode (equal / percent / weight)
       ↓
SDK builds a Stellar Payment operation
  • from:   payer's public key
  • to:     payee's Stellar address
  • amount: share amount in XLM
  • memo:   expense ID
       ↓
Freighter signs the transaction client-side
(private key never leaves the browser extension)
       ↓
Signed envelope submitted to Horizon REST API
       ↓
Stellar validators confirm → finalised in ~5s
       ↓
tx hash stored → share marked "paid" in app
```

---

## Setup Instructions

### Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later
- **Freighter Wallet** browser extension → [freighter.app](https://freighter.app)
  - Switch Freighter to **Testnet** in Settings → Network
- A funded Stellar **Testnet** account — get free XLM at [friendbot](https://horizon-testnet.stellar.org/friendbot?addr=YOUR_PUBLIC_KEY)

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/settlex.git
cd settlex
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up Supabase (Required for real-time sync)

**New Feature**: SettleX now syncs expenses in real-time across all users!

Follow the complete setup guide: **[docs/QUICKSTART.md](docs/QUICKSTART.md)**

Quick summary:

1. Create a free Supabase project at [supabase.com](https://supabase.com)
2. Run the SQL schema from [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md)
3. Copy your project URL and anon key to `.env.local`

### 4. Configure environment variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local` with your Supabase credentials:

See [Environment Variables](#environment-variables) below for details.

### 5. Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 6. Build for production

```bash
npm run build
npm run start
```

---

## Environment Variables

Create a `.env.local` file in the project root:

```env
# Stellar Network
NEXT_PUBLIC_STELLAR_NETWORK=TESTNET
NEXT_PUBLIC_HORIZON_URL=https://horizon-testnet.stellar.org
NEXT_PUBLIC_STELLAR_EXPLORER=https://stellar.expert/explorer/testnet

# Supabase (Get these from your Supabase project dashboard)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here

# App
NEXT_PUBLIC_APP_NAME=SettleX
NEXT_PUBLIC_APP_VERSION=1.0.0
```

> All variables are prefixed with `NEXT_PUBLIC_` because they are read client-side. The Supabase anon key is safe to expose — it only allows public access as configured in your RLS policies.

---

## Project Structure

```
settlex/
├── app/
│   ├── page.tsx              # Landing page
│   ├── dashboard/page.tsx    # Main app dashboard
│   ├── expenses/page.tsx     # Expense list + management
│   └── trips/
│       ├── page.tsx          # Trip list
│       └── [id]/page.tsx     # Trip detail (expenses + settle up)
│
├── components/
│   ├── landing/              # Hero, Features, HowItWorks, etc.
│   ├── expenses/             # ExpenseForm, SplitCalculator, PaymentRow
│   ├── payment/              # PayButton, PaymentStatus, QRCodeDisplay
│   ├── trips/                # TripCard, TripForm, ExpenseList, SettlementSummary
│   ├── wallet/               # ConnectWalletButton, WalletInfo, WalletGuard
│   └── ui/                   # Button, Modal, Badge, Spinner, Toast
│
├── context/
│   ├── ExpenseContext.tsx    # Global expense state
│   └── TripContext.tsx       # Global trip state
│
├── hooks/
│   ├── useWallet.ts          # Freighter wallet connection
│   ├── useExpense.ts         # Expense CRUD operations
│   ├── useTrip.ts            # Trip CRUD operations
│   └── usePayment.ts         # Payment flow orchestration
│
├── lib/
│   ├── stellar/
│   │   ├── buildTransaction.ts   # Constructs Stellar Payment tx
│   │   └── submitTransaction.ts  # Broadcasts to Horizon
│   ├── qr/
│   │   └── generator.ts          # SEP-0007 URI + QR generation
│   └── settlement/
│       └── netBalance.ts         # Net balance algorithm for trips
│
└── types/
    ├── expense.ts
    └── trip.ts
```

---

## Blockchain Integration

SettleX uses **Stellar's native payment protocol** — no smart contracts are required because peer-to-peer XLM transfers are a first-class primitive on the Stellar ledger.

### Payment flow (code path)

1. **`lib/stellar/buildTransaction.ts`**
   - Loads the payer's account sequence number from Horizon
   - Constructs a `TransactionBuilder` with a `Payment` operation
   - Attaches a `Memo.text(expenseId)` so the payment is traceable
   - Returns a serialised XDR transaction envelope

2. **`@stellar/freighter-api` — `signTransaction()`**
   - Sends the XDR to the Freighter extension for signing
   - User approves in the popup — private key never exposed to the app

3. **`lib/stellar/submitTransaction.ts`**
   - POSTs the signed XDR to `https://horizon-testnet.stellar.org/transactions`
   - Returns the `hash` of the confirmed transaction

4. **`hooks/usePayment.ts`**
   - Orchestrates steps 1–3
   - On success: calls `updateShare(expenseId, memberId, { paid: true, txHash })`
   - The `txHash` is shown to the user and links to [stellar.expert](https://stellar.expert/explorer/testnet)

### Why no smart contract?

Stellar's protocol natively supports trustless, atomic XLM transfers. Each `Payment` operation is:

- **Atomic** — it either fully succeeds or fully fails
- **Transparent** — publicly verifiable on any Stellar block explorer
- **Final** — confirmed within ~5 seconds, no rollback possible
- **Auditable** — the memo field ties every on-chain payment back to a specific expense

---

## Screenshots

> _Screenshots section — to be added after testnet testing._
>
> Required captures:
>
> - Wallet connected state (dashboard with public key displayed)
> - Balance displayed in wallet info panel
> - Successful testnet transaction (PaymentStatus showing tx hash)
> - Transaction result shown to user (link to stellar.expert)

---

## Testnet Notes

- This app runs entirely on **Stellar Testnet** — no real funds are used.
- Fund your Freighter testnet account via Stellar Friendbot:
  ```
  https://horizon-testnet.stellar.org/friendbot?addr=YOUR_PUBLIC_KEY
  ```
- All transactions are visible at [stellar.expert/explorer/testnet](https://stellar.expert/explorer/testnet).

---

## License

MIT © 2026 SettleX
