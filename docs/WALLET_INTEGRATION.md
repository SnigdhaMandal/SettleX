# Wallet Integration

## As built (works today)

SettleX connects wallets through `getWalletsKit()` in
[lib/stellar/walletsKit.ts](../lib/stellar/walletsKit.ts). Supported out of the box:

| Wallet | Type | Detection |
|---|---|---|
| Freighter | Browser extension | `@stellar/freighter-api` |
| xBull | Browser extension | `window.xBulls` |
| Lobstr | Browser extension | `window.lobstr` |
| Rabet | Browser extension | `window.rabet` |

Connection state lives in [context/WalletContext.tsx](../context/WalletContext.tsx).
It now:
- opens the wallet chooser for **any** supported wallet (no longer hard-gated on
  Freighter), and
- persists **which** wallet you connected with (`settlex:walletId`) so signing
  after a page reload targets the correct extension.

## Adding WalletConnect (mobile & "global" wallets like Trust Wallet)

> **Why this is a separate, deliberate step.** `package.json` pins
> `@creit-tech/stellar-wallets-kit@^2.0.0-beta.9`, a pre-1.0/beta line whose
> exported API has been in flux (the classic `new StellarWalletsKit({...})`
> instance API vs. a newer static `StellarWalletsKit.init({...})` /
> `createButton` API). Do this after `npm install` so you can confirm the exact
> API of the version that actually resolves, instead of shipping an import that
> might not match. Everything else in the product does not depend on it.

WalletConnect is what brings in **mobile wallets** (scan-to-connect) — this is the
realistic path to "use your phone wallet," including Trust Wallet where it exposes
Stellar over WalletConnect. (MetaMask is EVM-only and reaches Stellar only via the
third-party [Stellar Snap](https://snaps.metamask.io/snap/npm/stellar-snap/); treat
it as an optional, clearly-labeled extra, not your primary path.)

### Step 1 — get a project id
Create a free project at <https://dashboard.reown.com> and set:
```env
NEXT_PUBLIC_WC_PROJECT_ID=your-project-id
```

### Step 2 — confirm the installed kit's API
```bash
npm install
node -e "const k=require('@creit-tech/stellar-wallets-kit'); console.log(Object.keys(k))"
```
Note whether it exports `StellarWalletsKit` as an instance class (classic) or a
static (`init`/`createButton`), and where the WalletConnect module lives
(commonly `@creit-tech/stellar-wallets-kit/modules/walletconnect.module`).

### Step 3 — wire the module (classic instance API shown)
In [lib/stellar/walletsKit.ts](../lib/stellar/walletsKit.ts), back `getWalletsKit()`
with the real kit and register modules, e.g.:
```ts
import { StellarWalletsKit, WalletNetwork, allowAllModules } from "@creit-tech/stellar-wallets-kit";
import { WalletConnectModule, WalletConnectAllowedMethods } from "@creit-tech/stellar-wallets-kit/modules/walletconnect.module";

const modules = [
  ...allowAllModules(),
  ...(process.env.NEXT_PUBLIC_WC_PROJECT_ID
    ? [new WalletConnectModule({
        projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID,
        url: process.env.NEXT_PUBLIC_SITE_URL ?? "https://settlex.app",
        name: "SettleX",
        description: "Split & settle expenses on Stellar",
        icons: ["/pwa-icon?size=512"],
        method: WalletConnectAllowedMethods.SIGN,
        network: WalletNetwork.TESTNET,
      })]
    : []),
];
```
Keep the existing exported adapter shape (`openModal`, `getAddress`,
`signTransaction`, `getNetworkFromWallet`) so `WalletContext` and
[lib/freighter/index.ts](../lib/freighter/index.ts) keep working unchanged.

### Step 4 — verify
```bash
npm run build
npm run dev   # then connect via QR from a phone wallet
```

## Roadmap: passkey smart wallets (mainstream onboarding)
For users with no wallet at all, the biggest UX unlock is a passkey-based Soroban
smart wallet (Face ID / Touch ID, no seed phrase) via
[passkey-kit](https://github.com/kalepail/passkey-kit). See §7.4 of
[PRODUCT_CONVERSION_GUIDE.md](./PRODUCT_CONVERSION_GUIDE.md).
