#!/bin/bash

# Quick start script for Uniswap backtesting
# Usage: ./start-uniswap-backtest.sh

echo "🚀 Starting Uniswap V4 Backtest"
echo ""

# Check if API key is set
if [ -z "$THE_GRAPH_API_KEY" ]; then
  echo "⚠️  Warning: THE_GRAPH_API_KEY not set"
  echo "   You can get one from: https://thegraph.com/studio/"
  echo "   Set it with: export THE_GRAPH_API_KEY=your-key"
  echo ""
fi

# Check if example file exists
if [ ! -f "examples/backtest-with-uniswap-v4.ts" ]; then
  echo "❌ Error: examples/backtest-with-uniswap-v4.ts not found"
  exit 1
fi

echo "📝 Make sure to edit examples/backtest-with-uniswap-v4.ts with your pool address!"
echo ""
read -p "Press Enter to continue or Ctrl+C to cancel..."

# Run the backtest
echo ""
echo "▶️  Running backtest..."
npm run dev examples/backtest-with-uniswap-v4.ts


