# Backtest vs Live Bot - Parameter Comparison

## ✅ **Now Fully Aligned** (as of latest update)

| Parameter | Backtest Value | Live Bot | Status |
|-----------|---------------|----------|--------|
| **Base Fee APR** | 11% (from Uniswap subgraph) | ✅ **Dynamic** (queried from subgraph) | ✅ **ALIGNED** |
| **Position Value (NAV)** | $10,000-$40,000 | ✅ **Dynamic** (queried from strategy contract) | ✅ **ALIGNED** |
| **Gas Price** | 0.1-2 Gwei (Base L2) | ✅ **Dynamic** (queried from RPC) | ✅ **ALIGNED** |
| **ETH Price** | Real-time from pool | ✅ **Dynamic** (from Uniswap pool candles) | ✅ **ALIGNED** |
| **Gas Units** | 1,700,000 | ✅ 1,700,000 | ✅ **ALIGNED** |
| **Pool Fee Tier** | 0.05% | ✅ 0.05% | ✅ **ALIGNED** |
| **Swap Ratio** | 50% of position | ✅ 50% | ✅ **ALIGNED** |
| **Slippage** | 0.1% (10 bps) | ✅ 0.1% | ✅ **ALIGNED** |
| **Incentive APR** | 15% (or 0% in recent backtests) | ✅ 0% (with TODO for dynamic query) | ✅ **ALIGNED** |
| **Funding APR** | 5% (or 0% in recent backtests) | ✅ 0% (with TODO for dynamic query) | ✅ **ALIGNED** |
| **Volatility** | Historical + GARCH + Deribit IV | ✅ Same (with IV fallback) | ✅ **ALIGNED** |
| **Drift** | Statistical drift detection | ✅ Same (DriftVelocity) | ✅ **ALIGNED** |
| **Fee Density Multiplier** | `(refWidth / width)^1.5` | ✅ Same formula | ✅ **ALIGNED** |
| **Efficiency Ratio** | `max(0.1, min(0.95, 1 - (vol/range)*0.3))` | ✅ Same formula | ✅ **ALIGNED** |
| **Rebalance Threshold** | 90% of range | ✅ 90% | ✅ **ALIGNED** |
| **Diffusion Rate** | `(vol / effectiveRange) * 1.2` | ✅ Same formula | ✅ **ALIGNED** |
| **Drift Rate** | `abs(drift) / effectiveRange` | ✅ Same formula | ✅ **ALIGNED** |

---

## 🎯 **Key Formulas (Matching Backtest)**

### Total APR Calculation
```typescript
effectiveFeeApr = baseFeeApr * feeDensityMultiplier * efficiencyRatio
totalGrossApr = effectiveFeeApr + incentiveApr + fundingApr
```

### Rebalance Frequency (Annual)
```typescript
diffusionRate = (volatilityPercent / (effectiveRange * 100)) * 1.2
driftRate = (abs(drift) * 100) / (effectiveRange * 100)
rebalanceFrequency = diffusionRate + driftRate
```

### Cost Per Rebalance
```typescript
gasCost = (gasUnits * gasPriceGwei / 1e9) * ethPrice
poolFees = (positionValue * 0.5) * 0.0005  // 50% swap at 0.05% fee
slippage = (positionValue * 0.5) * 0.001   // 50% swap at 0.1% slippage
totalCost = gasCost + poolFees + slippage
```

### Net APY
```typescript
annualCost = rebalanceFrequency * totalCostPerRebalance
costDragPercent = (annualCost / positionValue) * 100
netApy = totalGrossApr - costDragPercent
```

---

## 📝 **TODO: Dynamic Queries Still Needed**

### 1. **Incentive APR** (Low Priority)
- **Source**: Protocol incentive programs (Arbitrum, Optimism, Base ecosystem)
- **Implementation**: Query token distribution contracts or indexers
- **Current**: Hardcoded to 0% (conservative)
- **Impact**: Missing 0-15% additional APR potential

### 2. **Funding APR** (Medium Priority)
- **Source**: Perpetual DEX funding rates (if implementing funding arbitrage)
- **Implementation**: Query Hyperliquid, GMX, or other perp protocols
- **Current**: Hardcoded to 0% (not yet implemented)
- **Impact**: Missing 0-5% additional APR from funding rate arb

### 3. **Pool TVL** (For Dynamic Slippage - Low Priority)
- **Source**: Uniswap subgraph
- **Implementation**: Already partially implemented in `getPoolFeeApr`
- **Current**: Using static 0.1% slippage
- **Impact**: Minor - Base L2 has deep liquidity

---

## 🚀 **What This Means**

Your live bot now uses **the exact same mathematical model** as your backtest:
- ✅ **Same cost calculations** (gas, pool fees, slippage)
- ✅ **Same rebalance frequency model** (drift-diffusion)
- ✅ **Same fee concentration formulas** (density multiplier, efficiency ratio)
- ✅ **Same APR composition** (base + incentive + funding)
- ✅ **Dynamic real-world data** (gas price, ETH price, NAV, pool fees)

The only parameters still hardcoded are:
1. **Incentive APR** = 0% (conservative, safe to ignore initially)
2. **Funding APR** = 0% (not implemented yet, requires perp integration)

These are **intentionally set to 0%** to be conservative, matching your recent backtest configuration in `cli.ts` (lines 148-149, 164-165, etc.).

