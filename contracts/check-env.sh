#!/bin/bash

echo "==================================="
echo "Bloom Contracts - Environment Check"
echo "==================================="
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ .env file not found!"
    echo "   Copy .env.example to .env and fill in your values:"
    echo "   cp .env.example .env"
    exit 1
fi

# Source .env
source .env

# Check PRIVATE_KEY
if [ -z "$PRIVATE_KEY" ] || [ "$PRIVATE_KEY" == "your_deployer_wallet_private_key_here" ]; then
    echo "❌ PRIVATE_KEY not set"
    echo "   Set your deployer wallet private key in .env"
    echo "   PRIVATE_KEY=0x..."
    exit 1
else
    echo "✅ PRIVATE_KEY set"
fi

# Check RPC_URL
if [ -z "$RPC_URL" ]; then
    echo "❌ RPC_URL not set"
    exit 1
else
    echo "✅ RPC_URL set: $RPC_URL"
fi

# Check KEEPER_ADDRESS (optional)
if [ -z "$KEEPER_ADDRESS" ]; then
    echo "⚠️  KEEPER_ADDRESS not set (optional)"
    echo "   Keeper will need to be authorized manually after deployment"
else
    echo "✅ KEEPER_ADDRESS set: $KEEPER_ADDRESS"
fi

echo ""
echo "==================================="
echo "Ready to deploy!"
echo ""
echo "Run:"
echo "  forge script script/Deploy.s.sol --rpc-url \$RPC_URL --broadcast --verify -vvvv"
echo "==================================="

