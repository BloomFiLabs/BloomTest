# Fee Tracking & Performance Metrics

## Overview

The bot now tracks **actual fees collected** from Uniswap V3 positions and displays them in all performance metrics.

## New Metrics Added

### PerformanceMetrics Interface

```typescript
export interface PerformanceMetrics {
  // ... existing fields ...
  totalFeesCollected: number;      // Actual fees harvested from Uniswap
  harvestCount: number;             // Number of fee collections
  lastHarvestTime?: Date;           // When last harvest occurred
  lastHarvestAmount?: number;       // Amount collected in last harvest
  feesPerHarvest: number;           // Average fees per harvest
}
```

## How It Works

### 1. Fee Collection Tracking

When `harvest()` is called:

1. **Execute harvest transaction** on the strategy contract
2. **Wait for confirmation** (3 seconds)
3. **Query blockchain events** for `ManagerFeeTaken` event
4. **Calculate total fees**:
   - Manager gets 20% of fees
   - Total = ManagerFee / 0.2
5. **Record in tracker**: `performanceTracker.recordHarvest(address, amount)`

### 2. Event Querying

The bot queries the last 100 blocks (~200 seconds on Base) for `ManagerFeeTaken` events:

```typescript
// From EthersStrategyExecutor.getLastHarvestAmount()
const EVENT_ABI = ['event ManagerFeeTaken(uint256 amount)'];
const contract = new Contract(strategyAddress, EVENT_ABI, provider);
const events = await contract.queryFilter(filter, fromBlock, latestBlock);

if (events.length > 0) {
  const managerFee = formatUnits(lastEvent.args.amount, 6); // USDC
  const totalCollected = managerFee / 0.2; // 20% = manager, 80% = users
  return totalCollected;
}
```

### 3. Performance Tracking

Fees are tracked across multiple dimensions:

| Metric | Description | Formula |
|--------|-------------|---------|
| **Total Fees Collected** | Cumulative fees harvested | Sum of all harvest amounts |
| **Harvest Count** | Number of successful harvests | Count of harvest events |
| **Fees Per Day** | Daily fee rate | Total Fees / Days Running |
| **Fees Per Harvest** | Average per harvest | Total Fees / Harvest Count |
| **Last Harvest Amount** | Most recent collection | From last `ManagerFeeTaken` event |
| **Last Harvest Time** | When last collected | Timestamp of last harvest |

## Logging Output

### Full Performance Metrics

```
═══════════════════════════════════════════════════════════
📊 PERFORMANCE METRICS: ETH/USDC 0.05%
═══════════════════════════════════════════════════════════
💰 Initial Deposit:        $10000.00
📈 Current NAV:            $10025.50
✨ Total Fees Earned:      $25.5000
💵 Fees Collected:         $1.2500 (5 harvests)
⛽ Total Gas Costs:        $2.0000
💵 Net Profit:             $23.5000 (0.24% ROI)
───────────────────────────────────────────────────────────
📊 Daily APY:              0.24%
📊 Annualized APY:         87.60%
📅 Fees Per Day:           $0.2500
💰 Avg Per Harvest:        $0.2500
🕐 Last Harvest:           $0.0021 (45 min ago)
───────────────────────────────────────────────────────────
🔄 Rebalance Count:        2
💰 Harvest Count:          5
⚡ Avg Rebalance Cost:     $1.0000
⏱️  Time Running:           5.00 hours
═══════════════════════════════════════════════════════════
```

### Compact Metrics (Every Minute)

```
💰 ETH/USDC 0.05% | NAV: $10025.50 | P&L: $23.50 (0.24%) | APY: 87.6% | Harvests: 5 ($1.2500) | Rebalances: 2
```

### Individual Harvest Logs

```
💰 Harvest #1 completed | Fees: $0.2500 | Total: $0.2500
💰 Harvest #2 completed | Fees: $0.3000 | Total: $0.5500
💰 Harvest #3 completed | Fees: $0.2000 | Total: $0.7500
...
```

## API Methods

### PerformanceTracker

```typescript
// Record a harvest event
recordHarvest(strategyAddress: string, feesCollectedUSD: number): void

// Get metrics for a strategy
getMetrics(strategyAddress: string): PerformanceMetrics | undefined

// Log full performance report
logPerformance(strategyName: string, metrics: PerformanceMetrics): void

// Log compact one-liner
logCompactMetrics(strategyName: string, metrics: PerformanceMetrics): void
```

### IStrategyExecutor

```typescript
// Execute harvest and return tx hash
harvest(strategyAddress: string): Promise<string>

// Query amount from last harvest (optional method)
getLastHarvestAmount?(strategyAddress: string): Promise<number>
```

## Example Usage

### In BotService

```typescript
@Cron('0 */6 * * *') // Every 6 hours
async harvestFees() {
  for (const pool of POOLS) {
    // Execute harvest
    const txHash = await this.executor.harvest(pool.strategyAddress);
    
    // Wait for confirmation
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Query actual amount collected
    const feesCollected = await this.executor.getLastHarvestAmount(pool.strategyAddress);
    
    // Record in performance tracker
    this.performanceTracker.recordHarvest(pool.strategyAddress, feesCollected);
  }
}
```

## Data Persistence

Currently, fee tracking is **in-memory** only. Metrics are reset when the bot restarts.

### Future Enhancements:

1. **Persist to Database**: Store harvest events in PostgreSQL/SQLite
2. **Historical Charts**: Track fee trends over time
3. **Fee Forecasting**: Predict future earnings based on historical data
4. **Per-User Attribution**: Track fees earned per vault depositor

## Monitoring & Alerts

### Watch For:

- **Declining Fees Per Day**: May indicate position out of range
- **Increasing Harvest Count**: More frequent harvests (good!)
- **Low Last Harvest Amount**: Position may be out of range or low volume period
- **No Harvests in 24h**: Something may be wrong

### Expected Values (for $10k position):

| Time Period | Expected Fees | Harvest Frequency |
|-------------|---------------|-------------------|
| **Per Hour** | ~$0.125 | Every 6 hours |
| **Per Harvest** | ~$0.75 | 4x per day |
| **Per Day** | ~$3.00 | Continuous |
| **Per Week** | ~$21.00 | 28 harvests |

*(Based on 11% APR pool with 80% user share)*

## Troubleshooting

### "Fees collected: $0.00"

**Causes**:
1. Position just opened (no time to accumulate)
2. Position out of range (not earning fees)
3. Very low trading volume
4. Event query failed (check logs)

**Solution**: Wait 24h and check again

### "No ManagerFeeTaken events found"

**Causes**:
1. Query timing too tight (looking in wrong blocks)
2. No fees to collect
3. RPC rate limit

**Solution**: Increase event query window or use paid RPC

### "Last Harvest: undefined"

**Causes**:
1. Bot just started (no harvests yet)
2. Harvest failed to record

**Solution**: Wait for next harvest cron (every 6h)

---

**Summary**: The bot now provides complete visibility into fee generation and collection, with real-time tracking and detailed historical metrics!


