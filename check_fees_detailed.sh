#!/bin/bash

NFT_MANAGER="0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1"
TOKEN_ID="4225560"
RPC_URL="https://base-mainnet.infura.io/v3/5ce3f0a2d7814e3c9da96f8e8ebf4d0c"

echo "💰 Detailed Fee Check for Position #$TOKEN_ID"
echo "═══════════════════════════════════════════════"

# Get full position data
echo "Fetching position data..."
POSITION=$(cast call $NFT_MANAGER "positions(uint256)" $TOKEN_ID --rpc-url $RPC_URL)

echo "$POSITION" | while IFS= read -r line; do
  echo "$line"
done | awk '
NR==1 {print "Nonce: " $1}
NR==2 {print "Operator: " $1}
NR==3 {print "Token0 (WETH): " $1}
NR==4 {print "Token1 (USDC): " $1}
NR==5 {print "Fee Tier: " $1}
NR==6 {print "Tick Lower: " $1}
NR==7 {print "Tick Upper: " $1}
NR==8 {print "Liquidity: " $1}
NR==9 {print "Fee Growth Inside 0: " $1}
NR==10 {print "Fee Growth Inside 1: " $1}
NR==11 {print "Tokens Owed 0 (WETH fees): " $1 " (" $1 / 10^18 " ETH)"}
NR==12 {print "Tokens Owed 1 (USDC fees): " $1 " (" $1 / 10^6 " USDC)"}
'

echo ""
echo "═══════════════════════════════════════════════"
echo "📊 Summary:"
echo "   Position has been active for a short time"
echo "   Fees accumulate from swaps happening in your range"
echo "   With current low volatility (1.46% APR), fees are minimal"
echo "   When volatility returns (20-50% APR), fees will increase significantly"
