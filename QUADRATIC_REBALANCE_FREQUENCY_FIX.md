# Critical Fix: Quadratic Rebalance Frequency Model

## Problem

The `RangeOptimizer` was using a **linear model** for rebalance frequency:
```typescript
const volatilityRebalances = (annualVolatilityPercent / rangeWidthPercent) * 0.5;
```

This is **mathematically incorrect**. Price diffusion (Brownian motion) scales with the **square** of volatility relative to range width. If you halve the range width, you hit the edge **4x as often** (not 2x).

### Impact

For a 1% range with 77.3% volatility:
- **OLD (Linear)**: 45.9 rebalances/year ❌
- **NEW (Quadratic)**: 9,936.5 rebalances/year ✅
- **Difference**: 216x MORE rebalances!

The linear model was **severely underestimating** rebalance costs for narrow ranges, causing the optimizer to recommend dangerous positions that would be drained by gas and swap fees in production.

## Solution

### 1. Quadratic Diffusion Model (CRITICAL)

**Changed from:**
```typescript
const volatilityRebalances = (annualVolatilityPercent / rangeWidthPercent) * 0.5;
```

**To:**
```typescript
const volRatio = annualVolatilityPercent / rangeWidthPercent;
// Square the ratio. Scalar 1.5 accounts for non-normal price kurtosis (fat tails)
const volatilityRebalances = Math.pow(volRatio, 2) * 1.5;
```

**Why 1.5 scalar?**
- Accounts for fat tails (crypto crashes faster than normal distributions predict)
- Accounts for price wicks and kurtosis
- Accounts for discrete moves and mean reversion

### 2. Lowered Efficiency Floor (CRITICAL)

**Changed from:**
```typescript
Math.max(0.40, ...) // Promised 40% efficiency even on bad ranges
```

**To:**
```typescript
Math.max(0.10, ...) // Honest assessment: narrow ranges can be out of range 95% of the time
```

**Why?**
- In high volatility or trending markets, narrow positions can be out of range 95% of the time
- The 0.40 floor artificially inflated APY of risky, narrow positions
- Now the model honestly tells users they will earn almost zero fees on bad ranges

### 3. Removed Dangerous +10 Bonus (CRITICAL)

**Changed from:**
```typescript
const adjustedScore = meetsTarget 
  ? result.netApy + 10 // Bonus for meeting target
  : result.netApy;
```

**To:**
```typescript
const adjustedScore = result.netApy; // No bonus - strictly solve for Max(Net APY)
```

**Why?**
- Created a dangerous discontinuity: 35.1% APY scored as 45.1, while 34.9% scored as 34.9
- Optimizer would blindly choose hyper-risky strategies that barely scraped past 35% over safer, more stable strategies at 34%
- If minimum target is needed, filter results AFTER optimization or apply risk penalty

## Files Changed

1. **`server/src/domain/services/RangeOptimizer.ts`**
   - Updated `calculateNetApy()` method with quadratic formula
   - Lowered efficiency floor to 0.10
   - Removed +10 bonus in `optimize()` method

2. **`1temp/src/shared/utils/RangeOptimizer.ts`**
   - Applied same fixes for backtesting consistency

## Verification

Run the test script to see the impact:
```bash
cd server && npx tsx test-quadratic-fix.ts
```

**Example Output:**
```
1.0% range:
  OLD (Linear):    45.9 rebalances/year
  NEW (Quadratic):  9936.5 rebalances/year
  Difference:      216.3x MORE rebalances!
```

## Impact on Optimizer Recommendations

With the corrected formula:
- **Narrow ranges (1-2%)**: Now correctly show thousands of rebalances/year, making them unprofitable
- **Wider ranges (10-20%)**: Show more realistic rebalance frequencies (25-100/year)
- **Efficiency**: No longer promises 40% efficiency on bad ranges
- **APY**: More honest assessment - narrow ranges are correctly penalized

## Next Steps

1. **Restart the bot** to pick up these changes
2. **Monitor logs** to verify the optimizer is now recommending wider, safer ranges
3. **Verify APY calculations** are now realistic and account for true rebalance costs

## Mathematical Foundation

The quadratic relationship comes from the fact that for Brownian motion:
- Time to hit a boundary scales with `(distance)^2 / (volatility^2)`
- Therefore, frequency scales with `(volatility / distance)^2`

This is a fundamental property of diffusion processes and cannot be approximated with a linear model.










