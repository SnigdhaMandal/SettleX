#!/usr/bin/env bash
# Build, deploy and initialize the SettleX settlement contract.
#
# Prerequisites:
#   - Rust with the wasm32v1-none target
#   - Stellar CLI with constructor support
#   - A funded account (the account is also the immutable contract admin)
#
# Usage:
#   ./scripts/deploy-contract.sh <secret-key-or-alias> [network]
#
# The settlement constructor initializes its admin atomically, so the deploy
# cannot be front-run. There is no second contract to wire up: the settlement
# contract is a pure payment ledger and makes no cross-contract calls (the
# former pool contract was removed in Issue #178).

set -euo pipefail

ACCOUNT="${1:-}"
NETWORK="${2:-testnet}"
INCLUSION_FEE="${INCLUSION_FEE:-1000000}"
# 1,000,000 stroops is an upper bound for inclusion, not a contract fee.

if [[ -z "$ACCOUNT" ]]; then
  echo "Usage: $0 <secret-key-or-stellar-cli-alias> [network]" >&2
  exit 1
fi

case "$NETWORK" in
  testnet|mainnet|futurenet|local)
    ;;
  *)
    echo "Unsupported network: $NETWORK" >&2
    exit 1
    ;;
esac

SETTLEMENT_WASM="contract/target/wasm32v1-none/release/settlex_contract.wasm"
SETTLEMENT_SALT="534554544c455800000000000000000000000000000000000000000000000001"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Building settlement contract for $NETWORK..."
stellar contract build \
  --manifest-path contract/Cargo.toml \
  --package settlex-contract \
  --optimize

if [[ ! -f "$SETTLEMENT_WASM" ]]; then
  echo "Expected WASM was not produced: $SETTLEMENT_WASM" >&2
  exit 1
fi

echo "Deploying settlement contract with atomic constructor..."
stellar contract deploy \
    --wasm "$SETTLEMENT_WASM" \
    --source-account "$ACCOUNT" \
    --network "$NETWORK" \
    --salt "$SETTLEMENT_SALT" \
    --inclusion-fee "$INCLUSION_FEE" \
    -- --admin "$ACCOUNT" 2>&1 | tee "$TMP_DIR/settlement-deploy.log"
SETTLEMENT_ID="$(grep -Eo 'C[A-Z2-7]{55}' "$TMP_DIR/settlement-deploy.log" | tail -n 1)"
SETTLEMENT_TX_HASH="$(grep -Eio '[a-f0-9]{64}' "$TMP_DIR/settlement-deploy.log" | tail -n 1 || true)"

if [[ ! "$SETTLEMENT_ID" =~ ^C[A-Z2-7]{55}$ ]]; then
  echo "Could not parse settlement contract ID: $SETTLEMENT_ID" >&2
  exit 1
fi

echo ""
echo "Deployment and initialization succeeded."
echo "Network: $NETWORK"
echo "Settlement contract: $SETTLEMENT_ID"
echo "Settlement deployment transaction hash: ${SETTLEMENT_TX_HASH:-see output below}"
echo "Settlement deployment transaction:"
cat "$TMP_DIR/settlement-deploy.log"
echo ""
echo "Set NEXT_PUBLIC_CONTRACT_ID=$SETTLEMENT_ID"
