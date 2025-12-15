# Performance Metrics API Requirements

This document outlines which APIs must be called to populate the performance summary:

```
📊 [1.1h] Est APY: 0.00% | Real APY: 0.00% | Net Funding: $0.00 | Positions: 0 | Break-Even: N/A
```

## Required API Calls

### 1. **Positions** (`Positions: 0`)
**Source**: Exchange adapters `getPositions()` method
- **ASTER**: `AsterExchangeAdapter.getPositions()`
- **LIGHTER**: `LighterExchangeAdapter.getPositions()`
- **HYPERLIQUID**: `HyperliquidExchangeAdapter.getPositions()`
- **EXTENDED**: `ExtendedExchangeAdapter.getPositions()`

**When**: Called during execution cycle via `PerpKeeperScheduler.updatePerformanceMetrics()`
**Status**: ✅ Implemented

### 2. **Net Funding** (`Net Funding: $0.00`)
**Source**: `RealFundingPaymentsService.fetchAllFundingPayments()`
- Fetches funding payments from all exchanges:
  - **Hyperliquid**: `HyperliquidExchangeAdapter.getFundingPayments()`
  - **Aster**: `AsterExchangeAdapter.getFundingPayments()`
  - **Lighter**: `LighterExchangeAdapter.getFundingPayments()`

**When**: 
- On module init (background)
- During execution cycle via `PerpKeeperScheduler.syncFundingPayments()` (NEW)
- Payments are recorded in `PerpKeeperPerformanceLogger.recordFundingPayment()`

**Status**: ✅ Implemented (added sync during execution)

### 3. **Est APY** (`Est APY: 0.00%`)
**Source**: `PerpKeeperPerformanceLogger.calculateEstimatedAPY()`
- Calculated from:
  - Current positions (from `getPositions()`)
  - Current funding rates (from `FundingRateAggregator`)
  - Position values and sides

**When**: Calculated on-demand when `getPerformanceMetrics()` is called
**Status**: ✅ Implemented

### 4. **Real APY** (`Real APY: 0.00%`)
**Source**: `PerpKeeperPerformanceLogger.calculateRealizedAPY()`
- Calculated from:
  - Actual funding payments received (from `fetchAllFundingPayments()`)
  - Capital deployed
  - Runtime (days)

**When**: Calculated on-demand when `getPerformanceMetrics()` is called
**Status**: ✅ Implemented

### 5. **Break-Even** (`Break-Even: N/A`)
**Source**: `PerpKeeperPerformanceLogger.calculateBreakEvenHours()`
- Calculated from:
  - Total trading costs (from `RealFundingPaymentsService.getTotalTradingCosts()`)
  - Daily average funding (from funding payments)
  - Formula: `(totalTradingCosts / dailyAverage) * 24` hours

**When**: Calculated on-demand when `logCompactSummary()` is called
**Status**: ✅ Implemented (requires trading costs to be recorded)

## Trading Costs Recording

Trading costs must be recorded via `RealFundingPaymentsService.recordTradingCosts()` when:
- Orders are placed (entry fees)
- Orders are filled (slippage)
- Positions are closed (exit fees)

**Status**: ⚠️ Needs verification - costs should be recorded in `OrderExecutor` or `FundingArbitrageStrategy`

## Execution Flow

1. **Hourly Execution** (`PerpKeeperScheduler.executeHourly()`):
   - Fetches positions via `getAllPositionsWithMetrics()`
   - Syncs funding payments via `syncFundingPayments()` (NEW)
   - Updates performance metrics via `updatePerformanceMetrics()`
   - Logs compact summary via `logCompactSummary()`

2. **Performance Metrics Update** (`updatePerformanceMetrics()`):
   - Fetches all positions from exchanges
   - Fetches funding rates for symbols with positions
   - Updates `PerpKeeperPerformanceLogger` with position metrics

3. **Funding Payments Sync** (`syncFundingPayments()`):
   - Fetches funding payments from all exchanges (cached)
   - Records each payment in performance logger
   - Ensures Real APY and Net Funding are up-to-date

## Testing

Run the test script to verify all APIs are being called:

```bash
cd server
npx ts-node test-performance-metrics-sync.ts
```

This will verify:
- ✅ Positions are fetched from all exchanges
- ✅ Funding payments are fetched from all exchanges
- ✅ Trading costs are recorded
- ✅ Performance metrics are calculated correctly
- ✅ All values are populated in the summary

## Troubleshooting

### If metrics show 0.00% or N/A:

1. **Positions = 0**: Check if `getPositions()` is being called and returning data
2. **Net Funding = $0.00**: Check if `fetchAllFundingPayments()` is being called and returning payments
3. **Est APY = 0.00%**: Check if positions exist and funding rates are being fetched
4. **Real APY = 0.00%**: Check if funding payments are being recorded
5. **Break-Even = N/A**: Check if trading costs are being recorded

### Common Issues:

- **No funding payments**: May need to wait for funding periods (typically hourly)
- **No positions**: Bot may not have opened any positions yet
- **Trading costs = 0**: Costs may not be recorded when orders are placed

