# Wallet Integration

SettleX uses the maintained
[`@creit.tech/stellar-wallets-kit`](https://github.com/Creit-Tech/Stellar-Wallets-Kit)
package for wallet discovery, connection UI, address access, and transaction
signing.

The small adapter in
[`lib/stellar/walletsKit.ts`](../lib/stellar/walletsKit.ts) initializes the kit
with tested modules and preserves the app-facing API used by
`WalletContext` and the transaction helpers. Wallet-specific behavior and the
accessible connection modal remain owned by the upstream package.

The npm distribution is used intentionally, so this project does not need a
JSR registry override in `.npmrc`.

## Tested wallet modules (SX-079)

Rather than exposing untested upstream modules from `defaultModules()`, SettleX
limits enabled modules to wallets that have been verified end-to-end:
**Freighter**, **xBull**, **LOBSTR**, and **Rabet**.

The selected wallet ID is stored under `settlex:walletId`. On reload, SettleX
selects that module before reconciling the saved account, ensuring subsequent
signing requests go back to the wallet the user connected.

## Wallet Support Matrix

| Wallet | Platform | Connect | Sign Transaction | Network Detection | Account-Switch Detection |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Freighter** | Browser Extension | Supported | Supported | Automatic (`@stellar/freighter-api`) | Automatic (silent polling via `skipRequestAccess`) |
| **xBull** | Browser Extension / Web | Supported | Supported (passes signer address) | Automatic (injected `window.xBullSDK.getNetwork()`) | Supported (injected provider read when unlocked) |
| **Rabet** | Browser Extension | Supported | Supported | Automatic (injected `window.rabet.getNetwork()`) | Automatic (event listener on `accountChanged`) |
| **LOBSTR** | Signer Extension | Supported | Supported | Explicit confirmation / Signed Tx verification | Manual reconnect (prompts on account switch) |

### Notes on Wallet Quirks

- **Signer address passing**: Modules such as `xBull` require the signer public key to be passed explicitly in `opts.address` during `signTransaction`. SettleX passes the currently connected public key to all transaction signing operations.
- **Network detection without `getNetwork` (LOBSTR)**: The LOBSTR signer extension API does not implement a `getNetwork()` method. SettleX provides a two-layer verification mechanism:
  1. **User confirmation banner**: When network reporting is unavailable, the user can review and explicitly confirm their wallet is set to Testnet via the network guard banner, immediately unblocking payment actions.
  2. **Signed transaction verification**: When the wallet signs a transaction XDR, SettleX cryptographically verifies that the resulting signature base matches the expected network passphrase before broadcasting.
- **Account switch detection**: Freighter provides silent address access via `skipRequestAccess: true`. Rabet emits an `accountChanged` event that triggers immediate session invalidation and re-authentication. For extensions requiring user interaction for account reads, session state remains optimistic until challenged.

## Passkey smart wallets

For users without a Stellar wallet, a passkey-based Soroban smart wallet is a
separate onboarding path. See the product roadmap in
[`PRODUCT_CONVERSION_GUIDE.md`](./PRODUCT_CONVERSION_GUIDE.md).
