#!/bin/bash

STRATEGY_ADDRESS="0xeCBaadfEDeb5533F94DA4D680771EcCB5deFf8a6"
VAULT_ADDRESS="0x16D604867DaaE1Bc3b76370db38DF9FD78eac457"
RPC_URL="https://base-mainnet.infura.io/v3/5ce3f0a2d7814e3c9da96f8e8ebf4d0c"

echo "💰 ═══════════════════════════════════════"
echo "   Checking Rewards & Performance"
echo "═══════════════════════════════════════"
echo ""

# Check strategy NAV
echo "📊 Strategy NAV:"
NAV=$(cast call $STRATEGY_ADDRESS "totalAssets()(uint256)" --rpc-url $RPC_URL)
NAV_USD=$(echo "scale=2; $NAV / 1000000" | bc)
echo "   Total Assets: \$$NAV_USD"
echo ""

# Check vault balance
echo "💵 Vault Total Deposits:"
USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
VAULT_BAL=$(cast call $USDC "balanceOf(address)(uint256)" $VAULT_ADDRESS --rpc-url $RPC_URL)
VAULT_BAL_USD=$(echo "scale=2; $VAULT_BAL / 1000000" | bc)
echo "   USDC in Vault: \$$VAULT_BAL_USD"
echo ""

# Check if position exists
echo "🔍 Checking Active Position:"
LRM=$(cast call $STRATEGY_ADDRESS "liquidityManager()(address)" --rpc-url $RPC_URL)
NFT_MANAGER="0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1"
BALANCE=$(cast call $NFT_MANAGER "balanceOf(address)(uint256)" $LRM --rpc-url $RPC_URL)
echo "   LRM NFT Balance: $BALANCE"

if [ "$BALANCE" != "0" ]; then
  TOKEN_ID=$(cast call $NFT_MANAGER "tokenOfOwnerByIndex(address,uint256)(uint256)" $LRM 0 --rpc-url $RPC_URL)
  echo "   Position Token ID: #$TOKEN_ID"
  
  # Get position details
  POSITION=$(cast call $NFT_MANAGER "positions(uint256)(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)" $TOKEN_ID --rpc-url $RPC_URL)
  echo ""
  echo "📈 Position Details:"
  echo "$POSITION" | awk 'NR==8 {print "   Liquidity: " $1}'
  echo "$POSITION" | awk 'NR==11 {print "   Fees Token0: " $1}'
  echo "$POSITION" | awk 'NR==12 {print "   Fees Token1: " $1}'
else
  echo "   ⚠️  No active position found"
fi

echo ""
echo "═══════════════════════════════════════"
