#!/bin/bash

# Bloom Keeper Bot - Live Log Viewer
# Usage: ./watch-logs.sh [option]
# Options: all, performance, rebalance, errors

LOG_FILE="/home/aurellius/Documents/Bloom/server/keeper-bot-live.log"

case "${1:-all}" in
  all)
    echo "📺 Watching ALL logs (Press Ctrl+C to stop)..."
    echo ""
    tail -f "$LOG_FILE"
    ;;
    
  performance|perf)
    echo "📊 Watching PERFORMANCE metrics only..."
    echo ""
    tail -f "$LOG_FILE" | grep --line-buffered -E "Performance|NAV|APY|Fees|Profit|ROI|Rebalance Count"
    ;;
    
  rebalance)
    echo "🔄 Watching REBALANCE events only..."
    echo ""
    tail -f "$LOG_FILE" | grep --line-buffered -i "rebalance\|trigger"
    ;;
    
  errors)
    echo "⚠️  Watching ERRORS and WARNINGS only..."
    echo ""
    tail -f "$LOG_FILE" | grep --line-buffered -E "ERROR|WARN"
    ;;
    
  compact)
    echo "💰 Watching COMPACT metrics only..."
    echo ""
    tail -f "$LOG_FILE" | grep --line-buffered "💰"
    ;;
    
  *)
    echo "Usage: $0 [all|performance|rebalance|errors|compact]"
    echo ""
    echo "Options:"
    echo "  all         - Show all logs (default)"
    echo "  performance - Show only performance metrics"
    echo "  rebalance   - Show only rebalance events"
    echo "  errors      - Show only errors and warnings"
    echo "  compact     - Show only compact performance lines"
    exit 1
    ;;
esac

