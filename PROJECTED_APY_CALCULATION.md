# Projected APY Calculation - What's Actually Included

## ✅ FIXED: Now Includes All Factors

The projected APY calculation has been **updated** to include all the factors you mentioned:

### What's Now Included:

1. **Base Pool APR** ✅
   - 7-day average of daily fees / average TVL
   - Annualized: `(avgDailyFees / avgTvl) * 365 * 100`

2. **Position Range Width** ✅
   - Fee density multiplier: `(referenceWidth / actualWidth)^0.8`
   - Efficiency ratio: Time-in-range based on volatility
   - Both affect the effective fee APR

3. **Rebalance Costs** ✅
   - Gas costs: `(gasUnits * gasPriceGwei / 1e9) * ethPrice * rebalanceFrequency`
   - Pool fees: `positionValue * swapRatio * poolFeeTier * rebalanceFrequency`
   - Slippage: `positionValue * swapRatio * slippageBps / 10000 * rebalanceFrequency`
   - **All subtracted from gross APY**

4. **Rebalance Frequency** ✅
   - Calculated using quadratic diffusion model
   - Based on volatility and drift relative to range width
   - Used to calculate annual rebalance costs

5. **Funding APY** ✅
   - From funding rate: `fundingRate * 8760 * 100`
   - Included in the optimized base APY

6. **Leverage** ✅
   - Multiplies the net base APY (after all costs)
   - Uses actual leverage or target leverage

7. **Borrow Debt Costs** ✅
   - `(leverage - 1) * borrowAPY`
   - Subtracted from leveraged gross yield

## Calculation Flow

### With Range Optimization (Preferred):

```
1. Range Optimizer calculates:
   - Effective fee APR = baseAPR * feeDensity * efficiency
   - Gross APR = effectiveFeeAPR + fundingAPY
   - Rebalance costs = (gas + poolFees + slippage) * frequency
   - Net Base APY = grossAPR - rebalanceCosts

2. Apply leverage:
   - Leveraged Gross = netBaseAPY * leverage
   - Borrow Cost = (leverage - 1) * borrowAPY
   - NET LEVERAGED APY = leveragedGross - borrowCost
```

### Without Range Optimization (Fallback):

```
1. Simple calculation:
   - Gross = (poolAPR + fundingAPY) * leverage
   - Borrow Cost = (leverage - 1) * borrowAPY
   - NET LEVERAGED APY = gross - borrowCost
```

## Example Calculation

Given:
- Base Pool APR: 15%
- Funding APY: 10%
- Range Width: ±5%
- Volatility: 60%
- Position Value: $10,000
- Leverage: 2.0x
- Borrow APY: 5.5%

**Step 1: Range Optimization**
- Fee density: `(0.05 / 0.05)^0.8 = 1.0`
- Efficiency: ~75% (range is 1σ wide)
- Effective fee APR: `15% * 1.0 * 0.75 = 11.25%`
- Gross APR: `11.25% + 10% = 21.25%`
- Rebalance frequency: ~12x/year (from volatility/drift model)
- Rebalance costs: `($0.11 gas + $0.50 poolFee) * 12 = $7.32/year`
- Cost drag: `$7.32 / $10,000 * 100 = 0.073%`
- **Net Base APY: `21.25% - 0.073% = 21.18%`**

**Step 2: Apply Leverage**
- Leveraged gross: `21.18% * 2.0 = 42.36%`
- Borrow cost: `(2.0 - 1) * 5.5% = 5.5%`
- **NET LEVERAGED APY: `42.36% - 5.5% = 36.86%`**

## What Changed

### Before (Incorrect):
- ❌ Used simple formula: `(poolAPR + fundingAPY) * leverage - borrowCost`
- ❌ Ignored range width effects
- ❌ Ignored rebalance costs
- ❌ Ignored efficiency/time-in-range

### After (Fixed):
- ✅ Uses range-optimized APY when available
- ✅ Includes range width effects (fee density, efficiency)
- ✅ Subtracts rebalance costs (gas, pool fees, slippage)
- ✅ Uses actual rebalance frequency from volatility/drift model
- ✅ Falls back to simple calculation if optimization unavailable

## Verification

The projected APY is now **realistic** because it accounts for:
1. ✅ Actual position range width
2. ✅ Time-in-range efficiency
3. ✅ Rebalance frequency (based on volatility/drift)
4. ✅ All rebalance costs (gas, fees, slippage)
5. ✅ Leverage and borrow costs

This matches the backtest cost model and should give accurate projections!


