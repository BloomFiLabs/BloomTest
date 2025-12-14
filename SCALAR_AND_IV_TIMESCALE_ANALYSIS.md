# Scalar 1.5 and IV Timescale Analysis

## The Scalar 1.5

### What It Is
The scalar `1.5` is a **multiplier** applied to the pure quadratic formula:
```typescript
const volatilityRebalances = Math.pow(volRatio, 2) * 1.5;
```

### What It's Based On
**⚠️ HEURISTIC - NOT RIGOROUSLY VALIDATED**

The scalar was chosen to account for:
1. **Fat tails**: Crypto prices crash faster than normal distributions predict
2. **Price wicks**: Flash crashes and extreme price movements
3. **Kurtosis**: Higher probability of extreme events than normal distribution

### Impact
For a 1% range with 77% volatility:
- **Pure quadratic** (scalar 1.0): 6,570 rebalances/year
- **With scalar 1.5**: 9,854 rebalances/year (50% more)
- **With scalar 0.8**: 5,256 rebalances/year (20% less)
- **With scalar 0.5**: 3,285 rebalances/year (50% less)

### Problem
**There is NO empirical basis for 1.5** - it was an educated guess based on:
- The user's feedback suggesting it should account for "fat tails"
- General knowledge that crypto has higher kurtosis than stocks
- But no backtesting or validation was done

### Recommendation
The scalar should be:
1. **Calibrated through backtesting** against actual rebalance frequencies
2. **Made configurable** so it can be adjusted based on market conditions
3. **Validated** against historical data to see if 1.5 is actually correct

## IV Timescale

### Deribit DVOL
Deribit's DVOL (Deribit Volatility Index) is:
- **30-day implied volatility**
- **Annualized** (expressed as annual percentage)
- Based on options pricing across multiple expiration dates
- Updated in real-time

### What This Means
When we fetch `77.48%` from Deribit:
- This is the **annualized** 30-day implied volatility
- It represents market expectations for the **next 30 days**, scaled to annual
- It's NOT a 1-year forecast, but a 30-day forecast annualized

### Timescale Mismatch?
Our optimizer uses this as **annual volatility** for rebalance frequency calculations, which assumes:
- The 30-day IV will persist for the entire year
- This might be too conservative if IV is currently elevated

### Better Approach
We could:
1. **Use shorter-term IV** (7-day or 14-day) for more responsive rebalancing
2. **Blend IV with realized volatility** (already implemented)
3. **Use IV as a signal** rather than direct input to rebalance frequency
4. **Cap IV** at reasonable levels when it's extremely high

## Current Implementation Issues

1. **Scalar 1.5 is arbitrary** - no validation
2. **IV is 30-day annualized** - but we use it as if it's persistent
3. **No backtesting** to validate the formula
4. **Too conservative** - makes narrow ranges unprofitable even with high APR

## Recommendations

1. **Make scalar configurable** and test different values (0.5, 0.8, 1.0, 1.2, 1.5)
2. **Backtest** the rebalance frequency formula against actual historical rebalances
3. **Consider using shorter-term IV** or blending with realized volatility more aggressively
4. **Add logging** to track predicted vs actual rebalance frequencies










