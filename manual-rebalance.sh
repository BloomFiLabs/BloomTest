#!/bin/bash

# Manual Rebalance Script for Bloom Delta Neutral Strategy
# Usage: ./manual-rebalance.sh [range_bps]
# Example: ./manual-rebalance.sh 50000  (for 0.5% range = 50 basis points)

set -e

STRATEGY_ADDRESS="0xeCBaadfEDeb5533F94DA4D680771EcCB5deFf8a6"
RPC_URL="https://base-mainnet.infura.io/v3/5ce3f0a2d7814e3c9da96f8e8ebf4d0c"
source /home/aurellius/Documents/Bloom/server/.env
PRIVATE_KEY="$KEEPER_PRIVATE_KEY"

# Default range: 50000 = 0.5% = 50 basis points
RANGE_BPS="${1:-50000}"

echo "════════════════════════════════════════════════════════"
echo "🔄 Manual Rebalance - Delta Neutral Strategy"
echo "════════════════════════════════════════════════════════"
echo ""
echo "Strategy:     $STRATEGY_ADDRESS"
echo "Range:        $RANGE_BPS ($(echo "scale=2; $RANGE_BPS / 100000" | bc)%)"
echo "Network:      Base Mainnet"
echo ""

# Check current position status
echo "📊 Checking current position status..."
cd /home/aurellius/Documents/Bloom/contracts

# Get current ETH price from pool
echo ""
echo "Getting current ETH price..."
SLOT0=$(cast call 0xd0b53D9277642d899DF5C87A3966A349A798F224 \
  "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" \
  --rpc-url https://mainnet.base.org)

CURRENT_TICK=$(echo "$SLOT0" | sed -n '2p' | tr -d '[]')
echo "Current Tick: $CURRENT_TICK"

# Get current NAV
echo ""
echo "Checking strategy NAV..."
NAV=$(cast call $STRATEGY_ADDRESS "totalAssets()(uint256)" --rpc-url $RPC_URL)
NAV_DOLLARS=$(echo "scale=2; $NAV / 1000000" | bc)
echo "Current NAV: \$$NAV_DOLLARS"

echo ""
echo "════════════════════════════════════════════════════════"
echo "⚠️  WARNING: This will execute an on-chain transaction!"
echo "════════════════════════════════════════════════════════"
echo ""
echo "Estimated costs:"
echo "  Gas: ~\$0.50-1.00"
echo "  Slippage: ~\$0.10-0.50"
echo "  Total: ~\$0.60-1.50"
echo ""
read -p "Continue with rebalance? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Rebalance cancelled."
    exit 0
fi

echo ""
echo "🚀 Executing rebalance..."

# Execute rebalance
TX_HASH=$(cast send $STRATEGY_ADDRESS \
  "rebalance(uint256)" \
  $RANGE_BPS \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --gas-limit 800000 \
  --json | jq -r '.transactionHash')

echo "✅ Transaction sent!"
echo "   TX Hash: $TX_HASH"
echo "   Explorer: https://basescan.org/tx/$TX_HASH"
echo ""
echo "Waiting for confirmation..."

# Wait for transaction
cast receipt $TX_HASH --rpc-url $RPC_URL > /dev/null 2>&1

echo "✅ Transaction confirmed!"
echo ""

# Check new NAV
echo "Checking new NAV..."
NEW_NAV=$(cast call $STRATEGY_ADDRESS "totalAssets()(uint256)" --rpc-url $RPC_URL)
NEW_NAV_DOLLARS=$(echo "scale=2; $NEW_NAV / 1000000" | bc)
echo "New NAV: \$$NEW_NAV_DOLLARS"

DIFF=$(echo "scale=4; ($NEW_NAV - $NAV) / 1000000" | bc)
echo "Change: \$$DIFF"

echo ""
echo "════════════════════════════════════════════════════════"
echo "✅ Rebalance Complete!"
echo "════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. View transaction on BaseScan"
echo "  2. Monitor position on Uniswap: https://app.uniswap.org"
echo "  3. Watch keeper bot logs for updates"
echo ""

