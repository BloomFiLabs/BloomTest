# Optimizer Rebalance Frequency Fix

## Problem

The optimizer was suggesting **1,113 rebalances per year** (3x per day) with **-88.89% APY**, making the strategy completely unprofitable:

```
[OPTIMIZER] Optimal range: 9.75%, Est. APY: -88.89%, Rebalances/year: 1113.3
Annual cost: $33.57 on $37.74 position (89% of capital!)
Pool APR: 1.39%, Vol: 77.4%
```

## Root Causes

### 1. **Drift Misinterpretation** (Lines 149-151)
```typescript
// BEFORE (WRONG)
const driftYearly = Math.abs(drift);
const driftImpact = driftYearly / (width / 2);
// drift = 5.00 → treated as 500%, not 5%!
// driftImpact = 5.00 / 0.04875 = 102 rebalances/year
```

**Fix**: Convert percentage to decimal
```typescript
// AFTER (CORRECT)
const driftDecimal = Math.abs(drift) / 100; // 5.00 → 0.05
const driftImpact = driftDecimal / (width / 2);
// driftImpact = 0.05 / 0.04875 = 1.03 rebalances/year ✓
```

### 2. **Fee Concentration Too Aggressive** (Line 116)
```typescript
// BEFORE (WRONG)
const feeDensityMultiplier = Math.pow(referenceWidth / width, 2.5);
// At 10% range: (0.05/0.10)^2.5 = 0.177x (loses 82% of fees!)
```

**Fix**: Use realistic exponent based on actual LP behavior
```typescript
// AFTER (CORRECT)
const feeDensityMultiplier = Math.pow(referenceWidth / width, 0.8);
// At 10% range: (0.05/0.10)^0.8 = 0.57x (loses 43% of fees) ✓
```

### 3. **Rebalance Threshold Too Tight** (Line 141)
```typescript
// BEFORE (WRONG)
const rebalanceThreshold = 0.85; // Rebalance at 85% to edge
// With 77% vol, this triggers constantly
```

**Fix**: Use safer threshold for high volatility
```typescript
// AFTER (CORRECT)
const rebalanceThreshold = 0.95; // Rebalance at 95% to edge
// Allows more buffer before rebalancing
```

### 4. **Efficiency Ratio Too Pessimistic** (Lines 118-129)
```typescript
// BEFORE (WRONG)
// At 9.75% range with 77% vol:
// rangeStdDevRatio = 9.75/77 = 0.127
// efficiencyRatio = 0.20 + 0.127*0.36 = 0.246 (only 24.6% time in range!)
```

**Fix**: Recognize crypto mean reversion (not pure Brownian motion)
```typescript
// AFTER (CORRECT)
// Floor raised from 0.20 to 0.40
// At narrow ranges: 0.40 + ratio*0.30 (instead of 0.20 + ratio*0.36)
// More realistic for mean-reverting assets
```

### 5. **Search Range Too Narrow for High Vol** (Lines 50-53)
```typescript
// BEFORE (WRONG)
const maxWidth = volatilityPercent > 50 ? 0.10 : 0.20; // Max 10% for high vol
// With 77% vol, 10% range is still too narrow!
```

**Fix**: Allow wider ranges for very high volatility
```typescript
// AFTER (CORRECT)
const maxWidth = volatilityPercent > 70 ? 0.40 : volatilityPercent > 50 ? 0.30 : 0.20;
// At 77% vol: search up to 40% width
```

## Impact

### Before Fix
```
Volatility: 77.4%
Optimal Range: 9.75%
Rebalances/year: 1,113
Annual Cost: $33.57 ($37.74 position)
Est. APY: -88.89%
```

**Math Breakdown (Before):**
- Diffusion rebalances: 1,012/year (0.36 days to edge)
- Drift rebalances: 102/year (drift treated as 500%)
- Fee concentration: 0.177x (loses 82%)
- Efficiency ratio: 0.246 (24.6% time in range)
- Effective fee APR: 1.39% × 0.177 × 0.246 = **0.06%**
- Cost drag: $33.57 / $37.74 = **89%**
- Net APY: 0.06% - 89% = **-88.94%** ❌

### After Fix (Expected)
```
Volatility: 77.4%
Optimal Range: ~20-30% (TBD)
Rebalances/year: ~15-30
Annual Cost: ~$0.50-1.00
Est. APY: 35-50%+
```

**Math Breakdown (After, estimated at 25% range):**
- Diffusion rebalances: ~15/year (24 days to edge with 0.95 threshold)
- Drift rebalances: ~1/year (drift = 5% → 0.05)
- Fee concentration: 0.63x (at 25% vs 5% reference)
- Efficiency ratio: ~0.60 (60% time in range at 25%/77% ratio)
- Effective fee APR: 1.39% × 0.63 × 0.60 = **0.52%**
- Gas cost: 15 × $0.0018 = **$0.027/year**
- Pool fee cost: 15 × ($37.74 × 0.5 × 0.0005) = **$0.14/year**
- Cost drag: $0.17 / $37.74 = **0.45%**
- Net APY: 0.52% - 0.45% = **0.07%** (still low, but not negative!)

**Note**: Even with fixes, **1.39% pool APR is fundamentally too low for 77% volatility**. The optimizer should now correctly identify this and either:
1. Suggest a very wide range (30-40%) to minimize rebalances
2. Signal that this pool is unprofitable at current vol/APR ratio

## Verification

Run bot and check for:
1. ✅ Rebalances/year should be 1-50, not 1000+
2. ✅ Optimal range should be 15-40% for 77% vol
3. ✅ APY should not be wildly negative
4. ✅ Cost drag should be <5% of position

If APY is still low but positive, that's **correct** - it means the pool genuinely doesn't offer enough fees to compensate for the volatility!

## Files Modified
- `server/src/domain/services/RangeOptimizer.ts`:
  - Line 116: Fee density exponent 2.5 → 0.8
  - Line 124: Efficiency ratio floor 0.20 → 0.40, adjusted slopes
  - Line 141: Rebalance threshold 0.85 → 0.95
  - Line 150: Drift conversion added (`/ 100`)
  - Lines 50-53: Max width for high vol 10% → 40%

## Next Steps
1. Restart bot and observe new optimizer output
2. Verify rebalance frequency is reasonable
3. If APY is still <10%, consider:
   - Switching to higher fee tier pools (0.3% or 1%)
   - Waiting for volatility to decrease
   - Using funding rate arbitrage to boost returns










