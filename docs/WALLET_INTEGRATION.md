# Wallet Integration

SettleX uses the maintained
[`@creit.tech/stellar-wallets-kit`](https://github.com/Creit-Tech/Stellar-Wallets-Kit)
package for wallet discovery, connection UI, address access, and transaction
signing. The adapter in [`lib/stellar/walletsKit.ts`](../lib/stellar/walletsKit.ts)
intentionally registers only the four wallet modules verified by this app. The
kit's other available modules are not enabled just because they are available
upstream.

The npm distribution is used intentionally, so this project does not need a
JSR registry override in `.npmrc`.

## Supported wallet matrix (SX-053)

| Wallet | Connection and signing | Network detection | Account-switch detection |
| :--- | :--- | :--- | :--- |
| **Freighter** | Browser extension; connection and transaction signing supported. | Automatic through the wallet kit. | Silent address reads are polled while connected and on reload; a changed address clears the app session. |
| **xBull** | Browser extension; signing passes the connected public key to the signer. | Automatic through `window.xBullSDK.getNetwork()` when the provider exposes it; otherwise the kit result is used. | Silent `window.xBullSDK.getAddress()` reads are polled when available. If the provider cannot read silently, a switch may only be discovered on a later signed challenge. |
| **Rabet** | Browser extension; connection and transaction signing supported. | Automatic through `window.rabet.getNetwork()` when available; otherwise the kit result is used. | `accountChanged` is handled when emitted, with silent active-account polling when available. |
| **LOBSTR** | Signer extension; connection and transaction signing supported. | No reliable wallet network getter. The user must confirm the configured network in SettleX; signed transaction verification still checks the network before broadcast. | No reliable silent account read. The app cannot detect a switch immediately; signing/authentication must succeed for the connected address before privileged actions can proceed. Reconnect after switching accounts. |

Network checks are compared with SettleX's configured Stellar network. An
unavailable or mismatched network blocks payment until it is verified or, for
LOBSTR, explicitly confirmed. Account-change polling is best-effort because
wallet providers expose different APIs; authentication still proves wallet
ownership with a signed challenge.

## WalletConnect for mobile wallets

WalletConnect support is **not currently enabled** in SettleX. The active
adapter does not register a WalletConnect module and does not read a project
ID. The README's four supported wallets are the shipped and tested integrations;
WalletConnect is an additional integration to enable and test before it is
advertised as available. No new package is needed for the WalletConnect
dependencies already present through the wallet kit.

To enable it in a deployment and the adapter:

1. Create a project in [Reown Cloud](https://cloud.reown.com/) and copy its
   project ID. Add the production site origin to that project's allowed
   origins.
2. Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<project-id>` in the local
   environment and in each deployment environment that should offer
   WalletConnect. This value is public configuration, not a secret. The
   application currently does not consume it; the wallet-kit adapter must be
   updated to pass it to the WalletConnect module using the API for the pinned
   kit version before this variable takes effect.
3. Register the WalletConnect module in `getTestedModules()` and add it to the
   tested-wallet list only after mobile QR/deep-link connection, account
   changes, network detection, challenge signing, and transaction signing have
   been verified. Keep the four existing modules enabled.
4. Keep the WalletConnect/Reown relay origins in the document `connect-src`
   policy in [`middleware.ts`](../middleware.ts). The current policy already
   allows `https://*.walletconnect.com`, `https://*.walletconnect.org`,
   `wss://*.walletconnect.com`, `wss://*.walletconnect.org`,
   `https://*.reown.com`, and `wss://*.reown.com`. If the integration uses
   another origin, add only the required origin there and in the static-asset
   policy as appropriate.
5. Test on a real mobile wallet and on desktop QR pairing. Confirm cancelling
   a pairing leaves the app disconnected, a network mismatch blocks payment,
   and reconnecting or switching accounts cannot reuse the previous wallet's
   authenticated session.

Do not describe a wallet as supported solely because it appears in the kit's
upstream default module list. SettleX's app-specific network and account
reconciliation behavior must be verified for each newly enabled module.

## Passkey smart wallets

For users without a Stellar wallet, a passkey-based Soroban smart wallet is a
separate onboarding path. See the product roadmap in
[`PRODUCT_CONVERSION_GUIDE.md`](./PRODUCT_CONVERSION_GUIDE.md).
