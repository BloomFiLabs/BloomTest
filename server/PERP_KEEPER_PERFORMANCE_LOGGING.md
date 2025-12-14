# Perp Keeper Performance Logging

## Overview

The Perp Keeper Performance Logger tracks comprehensive metrics for the perpetual funding rate arbitrage strategy, including:

- **Estimated APY**: Based on current funding rates and positions
- **Realized APY**: Based on actual funding payments received
- **Funding Metrics**: Total funding captured, paid, and net funding
- **Position Metrics**: Position counts, values, and P&L
- **Trading Metrics**: Orders placed, filled, failed, and arbitrage opportunities
- **Capital Efficiency**: Capital utilization and average position sizes
- **Risk Metrics**: Max drawdown and other risk indicators

## Features

### Automatic Logging

The system automatically logs performance metrics:

1. **Full Performance Metrics** - Every 5 minutes
   - Comprehensive breakdown of all metrics
   - Exchange-specific metrics
   - Detailed APY calculations

2. **Compact Summary** - Every 1 minute
   - One-line summary for quick monitoring
   - Shows runtime, APY, funding, positions, and P&L

### Metrics Tracked

#### APY Metrics
- **Estimated APY**: Calculated from current funding rates and position sizes
  - Formula: `(weighted_avg_funding_rate * periods_per_day * 365) * 100`
  - Updates in real-time as positions and funding rates change
- **Realized APY**: Based on actual funding payments received
  - Formula: `(total_funding / capital_deployed / runtime_days) * 365 * 100`
  - Only increases when actual funding payments are recorded

#### Funding Metrics
- **Total Funding Captured**: Sum of all positive funding payments (USD)
- **Total Funding Paid**: Sum of all negative funding payments (USD)
- **Net Funding Captured**: Net funding (received - paid)

#### Position Metrics
- **Total Positions**: Number of open positions across all exchanges
- **Total Position Value**: Total value of all positions (USD)
- **Unrealized P&L**: Current unrealized profit/loss from positions
- **Realized P&L**: Cumulative realized profit/loss from closed positions

#### Trading Metrics
- **Orders Placed**: Total number of orders placed
- **Orders Filled**: Total number of orders successfully filled
- **Orders Failed**: Total number of orders that failed
- **Arbitrage Opportunities Found**: Number of opportunities identified
- **Arbitrage Opportunities Executed**: Number of opportunities actually traded

#### Capital Efficiency
- **Capital Deployed**: Total capital allocated to positions
- **Capital Utilization**: Percentage of available capital being used
- **Average Position Size**: Average size of positions (USD)

#### Risk Metrics
- **Max Drawdown**: Maximum peak-to-trough decline (percentage)

## Usage

### Recording Funding Payments

When funding payments occur (typically every 8 hours), record them:

```typescript
// Positive amount = funding received (e.g., from short position when funding rate is positive)
performanceLogger.recordFundingPayment(ExchangeType.ASTER, 12.50);

// Negative amount = funding paid (e.g., from long position when funding rate is positive)
performanceLogger.recordFundingPayment(ExchangeType.LIGHTER, -8.25);
```

### Recording Realized P&L

When positions are closed with profit/loss:

```typescript
performanceLogger.recordRealizedPnl(150.75); // Positive = profit
```

### Updating Position Metrics

Position metrics are automatically updated during scheduled execution, but you can manually update:

```typescript
const positions = await keeperService.getAllPositions();
const fundingRates = await orchestrator.compareFundingRates('ETHUSDT');

performanceLogger.updatePositionMetrics(
  ExchangeType.ASTER,
  positions.filter(p => p.exchange === ExchangeType.ASTER),
  fundingRates.rates.filter(r => r.exchange === ExchangeType.ASTER)
);
```

### Getting Performance Metrics

```typescript
const metrics = performanceLogger.getPerformanceMetrics(capitalDeployed);

console.log(`Estimated APY: ${metrics.estimatedAPY}%`);
console.log(`Realized APY: ${metrics.realizedAPY}%`);
console.log(`Net Funding: $${metrics.netFundingCaptured}`);
```

### REST API Endpoint

Get performance metrics via HTTP:

```bash
GET /keeper/performance
```

Response includes all metrics in JSON format.

## Example Output

### Full Performance Metrics (Every 5 minutes)

```
📊 ═══════════════════════════════════════════════════════════
📊 PERP KEEPER PERFORMANCE METRICS
📊 ═══════════════════════════════════════════════════════════

⏱️  Runtime: 2.5 days (60.0 hours)

💰 APY METRICS
   📈 Estimated APY: 45.32%
   ✅ Realized APY: 38.76%
   📅 Estimated Daily Return: $12.45
   💵 Realized Daily Return: $10.64

💸 FUNDING METRICS
   💰 Total Funding Captured: $638.50
   💸 Total Funding Paid: $382.25
   📊 Net Funding Captured: $256.25

📈 POSITION METRICS
   📍 Total Positions: 3
   💵 Total Position Value: $10,500.00
   📊 Unrealized P&L: $125.50
   ✅ Realized P&L: $50.00

🔄 TRADING METRICS
   📝 Orders Placed: 15
   ✅ Orders Filled: 14
   ❌ Orders Failed: 1
   🔍 Arbitrage Opportunities Found: 8
   ⚡ Arbitrage Opportunities Executed: 6

💼 CAPITAL EFFICIENCY
   💰 Capital Deployed: $10,000.00
   📊 Capital Utilization: 105.00%
   📏 Average Position Size: $3,500.00

⚠️  RISK METRICS
   📉 Max Drawdown: 2.15%

🏦 EXCHANGE-SPECIFIC METRICS
   ASTER:
      💰 Net Funding: $125.50
      📍 Positions: 1
      💵 Position Value: $3,500.00
      📊 Unrealized P&L: $45.25
      ✅ Orders Filled: 5
   LIGHTER:
      💰 Net Funding: $80.25
      📍 Positions: 1
      💵 Position Value: $3,200.00
      📊 Unrealized P&L: $40.00
      ✅ Orders Filled: 4
   HYPERLIQUID:
      💰 Net Funding: $50.50
      📍 Positions: 1
      💵 Position Value: $3,800.00
      📊 Unrealized P&L: $40.25
      ✅ Orders Filled: 5

📊 ═══════════════════════════════════════════════════════════
```

### Compact Summary (Every 1 minute)

```
📊 [2.5d] Est APY: 45.32% | Real APY: 38.76% | Net Funding: $256.25 | Positions: 3 | P&L: $175.50
```

## Integration

The performance logger is automatically integrated into:

1. **PerpKeeperService**: Records order executions
2. **PerpKeeperScheduler**: Updates position metrics and logs performance
3. **PerpKeeperController**: Provides REST API endpoint

## Configuration

No additional configuration needed. The logger starts automatically when the perp keeper module is loaded.

## Notes

- **Estimated APY** updates in real-time based on current positions and funding rates
- **Realized APY** only increases when actual funding payments are recorded
- Funding payments should be recorded when they occur (typically every 8 hours)
- Position metrics are automatically updated during scheduled execution cycles
- All metrics are tracked in-memory and reset on application restart


