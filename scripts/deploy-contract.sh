#!/usr/bin/env bash
# =============================================================================
# deploy-contract.sh
#
# Builds and deploys the SettleX Soroban settlement contract to Stellar testnet.
#
# Prerequisites:
#   - Rust toolchain with wasm32-unknown-unknown target
#       rustup target add wasm32-unknown-unknown
#   - Stellar CLI v21+
#       cargo install --locked stellar-cli --features opt
#   - A funded testnet account (get test XLM at friendbot.stellar.org)
#
# Usage:
#   chmod +x scripts/deploy-contract.sh
#   ./scripts/deploy-contract.sh <YOUR_SECRET_KEY_OR_ALIAS>
#
# After successful deployment, copy the printed CONTRACT_ID to .env.local:
#   NEXT_PUBLIC_CONTRACT_ID=C...
# =============================================================================

set -euo pipefail

ACCOUNT="${1:-}"
if [[ -z "$ACCOUNT" ]]; then
  echo "❌  Usage: $0 <secret-key-or-stellar-cli-alias>"
  echo "   Example: $0 SDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  exit 1
fi

WASM_PATH="contract/target/wasm32-unknown-unknown/release/settlex_contract.wasm"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SettleX Contract Deployment"
echo "  Network : Stellar Testnet"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Build ─────────────────────────────────────────────────────────────
echo "▸ Building contract (release)…"
(
  cd contract
  cargo build \
    --target wasm32-unknown-unknown \
    --release \
    --quiet
)
echo "  ✓ Build succeeded: $WASM_PATH"
echo ""

# ── Step 2: Optimise .wasm (if stellar contract optimize is available) ────────
if stellar contract optimize --help &>/dev/null 2>&1; then
  echo "▸ Optimising .wasm…"
  stellar contract optimize --wasm "$WASM_PATH"
  echo "  ✓ Optimised"
  echo ""
fi

# ── Step 3: Deploy ────────────────────────────────────────────────────────────
echo "▸ Deploying to testnet…"
CONTRACT_ID=$(stellar contract deploy \
  --wasm      "$WASM_PATH" \
  --source    "$ACCOUNT" \
  --network   testnet \
  --fee       1000000)

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅  Deployment successful!"
echo ""
echo "  CONTRACT_ID:"
echo "  $CONTRACT_ID"
echo ""
echo "  Add this to your .env.local:"
echo "  NEXT_PUBLIC_CONTRACT_ID=$CONTRACT_ID"
echo ""
echo "  Verify on Stellar Expert:"
echo "  https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
