# 🔧 RangeOptimizer Refactor - Removing Hardcoded Values

## Problem

The `RangeOptimizer` had **critical hardcoded values** that caused incorrect APY calculations:

1. **POOL_FEE_TIER = 0.01** (hardcoded to 1%, but we were using 0.05% pool before)
2. **REBALANCE_GAS_UNITS = 450_000** (should be configurable)
3. **ESTIMATED_SWAP_RATIO = 0.5** (should be configurable)
4. **SLIPPAGE_BPS = 10** (should be configurable)
5. **referenceWidth = 0.05** (hardcoded in calculation)
6. **rebalanceThreshold = 0.95** (hardcoded)
7. **TARGET_MIN_APY = 0.35** (hardcoded)

## Solution

### 1. Made Pool Fee Tier Dynamic ✅

**Before:**
```typescript
private readonly POOL_FEE_TIER = 0.01; // Hardcoded!
const poolFeePerRebalance = estimatedSwapNotional * this.POOL_FEE_TIER;
```

**After:**
```typescript
// Added to IMarketDataProvider
getPoolFeeTier(poolAddress: string): Promise<number>;

// In BotService
const poolFeeTier = await this.marketData.getPoolFeeTier(pool.address);

// In RangeOptimizer.optimize()
optimize(..., poolFeeTier: number, ...): OptimizationResult {
  const poolFeePerRebalance = estimatedSwapNotional * poolFeeTier;
}
```

### 2. Made Other Constants Configurable ✅

**Before:**
```typescript
export class RangeOptimizer {
  private readonly REBALANCE_GAS_UNITS = 450_000;
  private readonly ESTIMATED_SWAP_RATIO = 0.5;
  private readonly SLIPPAGE_BPS = 10;
  // ...
}
```

**After:**
```typescript
export interface RangeOptimizerConfig {
  rebalanceGasUnits?: number; // Default: 450,000
  estimatedSwapRatio?: number; // Default: 0.5
  slippageBps?: number; // Default: 10
  targetMinApy?: number; // Default: 35.0
  referenceWidth?: number; // Default: 0.05
  rebalanceThreshold?: number; // Default: 0.95
}

export class RangeOptimizer {
  constructor(config: RangeOptimizerConfig = {}) {
    // Uses defaults if not provided
  }
}
```

### 3. Updated BotService to Fetch Fee Tier ✅

```typescript
// Fetch pool fee tier dynamically (CRITICAL: was hardcoded!)
let poolFeeTier = 0.0005; // Fallback to 0.05%
try {
  poolFeeTier = await this.marketData.getPoolFeeTier(pool.address);
  this.logger.log(`💰 Pool Fee Tier: ${(poolFeeTier * 100).toFixed(2)}%`);
} catch (error) {
  this.logger.warn(`Could not fetch pool fee tier, using fallback 0.05%: ${error.message}`);
}

const optimization = this.optimizer.optimize(
  robustVolatility,
  analysis.drift,
  positionValueUSD,
  baseFeeApr,
  gasPriceGwei,
  ethPrice,
  poolFeeTier, // ✅ Now passed dynamically
  incentiveApr,
  fundingApr,
);
```

## Impact

### Before (Hardcoded 1% Fee Tier):
- **0.05% pool**: Optimizer thought rebalance cost = $0.19 (1% fee)
- **Actual cost**: $0.0095 (0.05% fee) - **20x too high!**
- Result: Optimizer suggested **39.50% range** (way too wide) to minimize "expensive" rebalances

### After (Dynamic Fee Tier):
- **0.05% pool**: Optimizer uses actual 0.05% fee tier
- **1% pool**: Optimizer uses actual 1% fee tier
- Result: Optimizer suggests **correct range** based on actual costs

## Files Changed

1. ✅ `server/src/domain/ports/IMarketDataProvider.ts` - Added `getPoolFeeTier()`
2. ✅ `server/src/infrastructure/adapters/graph/UniswapGraphAdapter.ts` - Implemented `getPoolFeeTier()`
3. ✅ `server/src/domain/services/RangeOptimizer.ts` - Refactored to accept config and poolFeeTier parameter
4. ✅ `server/src/application/services/BotService.ts` - Fetches and passes poolFeeTier dynamically
5. ✅ `server/src/domain/services/RangeOptimizer.spec.ts` - Updated tests

## Remaining Hardcoded Values (Now Configurable)

All previously hardcoded values are now configurable via `RangeOptimizerConfig`:

| Parameter | Default | Can Override? |
|-----------|---------|---------------|
| `rebalanceGasUnits` | 450,000 | ✅ Yes |
| `estimatedSwapRatio` | 0.5 | ✅ Yes |
| `slippageBps` | 10 | ✅ Yes |
| `targetMinApy` | 35.0 | ✅ Yes |
| `referenceWidth` | 0.05 | ✅ Yes |
| `rebalanceThreshold` | 0.95 | ✅ Yes |
| `poolFeeTier` | **N/A** | ✅ **Required parameter** (fetched dynamically) |

## Next Steps

1. ✅ **DONE**: Remove hardcoded pool fee tier
2. ✅ **DONE**: Make all constants configurable
3. ✅ **DONE**: Fetch fee tier from pool data
4. ⚠️ **TODO**: Consider making `rebalanceGasUnits` dynamic (fetch from contract estimate)
5. ⚠️ **TODO**: Consider making `estimatedSwapRatio` dynamic (based on actual rebalance behavior)

## Testing

After this refactor, the optimizer should:
- ✅ Correctly calculate costs for **any** pool fee tier
- ✅ Suggest appropriate ranges based on **actual** rebalance costs
- ✅ Work correctly for **0.05%**, **0.3%**, **1%**, or **any** fee tier

---

**Result**: No more hardcoded footguns! 🎯










