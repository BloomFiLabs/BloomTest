# Test Mode - Mock Trading with APY and Volume Tracking

This document describes how to run the server in test mode with mock amounts to test strategy scaling and performance metrics.

## Overview

Test mode allows you to:
- Run the strategy with mock capital (default: $5M)
- Track APY performance without real trading
- Track trading volume
- Test strategy behavior at scale without risking real funds

## Configuration

### Environment Variables

Add these to your `.env` file:

```bash
# Enable test mode (uses mock exchange adapters)
TEST_MODE=true

# Mock capital amount (default: 5000000 = $5M)
# This will be split across 3 exchanges (Aster, Lighter, Hyperliquid)
MOCK_CAPITAL_USD=5000000

# Optional: Configure other strategy parameters
KEEPER_MIN_SPREAD=0.0001
KEEPER_MAX_POSITION_SIZE_USD=1000000
KEEPER_LEVERAGE=2.0
```

### How It Works

When `TEST_MODE=true`:
1. **Mock Exchange Adapters**: The server uses `MockExchangeAdapter` instead of real exchange adapters
2. **Simulated Trading**: Orders are simulated without real API calls
3. **Mock Balances**: Each exchange starts with `MOCK_CAPITAL_USD / 3` balance
4. **Mock Prices**: Uses simulated prices (ETH ~$3000, BTC ~$60000) with small random variations
5. **Position Tracking**: Tracks mock positions and updates unrealized P&L

## Metrics Tracked

### APY Metrics
- **Estimated APY**: Based on current funding rates and positions
- **Realized APY**: Based on actual funding payments received
- **Daily Returns**: Both estimated and realized

### Volume Metrics
- **Total Volume Traded**: Cumulative USD value of all trades
- **Daily Volume Traded**: Average daily volume
- **Average Trade Size**: Average USD value per trade

### Other Metrics
- Funding captured/paid
- Position counts and values
- Capital utilization
- Drawdown tracking

## Running Test Mode

1. **Set environment variables**:
   ```bash
   export TEST_MODE=true
   export MOCK_CAPITAL_USD=5000000
   ```

2. **Start the server**:
   ```bash
   npm run start:dev
   ```

3. **Monitor performance**:
   - Full metrics logged every 5 minutes
   - Compact summary logged every minute
   - Check logs for APY and volume metrics

## Example Output

```
📊 ═══════════════════════════════════════════════════════════
📊 PERP KEEPER PERFORMANCE METRICS
📊 ═══════════════════════════════════════════════════════════

⏱️  Runtime: 1.25 days (30.0 hours)

💰 APY METRICS
   📈 Estimated APY: 45.23%
   ✅ Realized APY: 42.18%
   📅 Estimated Daily Return: $6,250.00
   💵 Realized Daily Return: $5,833.33

📊 VOLUME METRICS
   💰 Total Volume Traded: $2,500,000.00
   📅 Daily Volume Traded: $2,000,000.00
   📏 Average Trade Size: $50,000.00
```

## Use Cases

1. **Strategy Validation**: Test if the strategy works at scale before deploying real capital
2. **Performance Projections**: Understand expected APY and volume at different capital levels
3. **Risk Assessment**: See how the strategy behaves with larger position sizes
4. **Development**: Develop and test new features without real trading

## Limitations

- Mock prices don't reflect real market conditions
- Funding rates are simulated (use real funding rate providers)
- No real slippage or market impact
- Positions don't affect real exchange order books

## Switching Back to Production

To disable test mode, simply remove or set:
```bash
TEST_MODE=false
```

The server will then use real exchange adapters and make actual trades.

