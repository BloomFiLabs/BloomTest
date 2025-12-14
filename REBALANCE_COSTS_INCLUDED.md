# Rebalance Costs Now Included in APY Calculation

## ✅ Fixed: Using Range Optimizer with GARCH + Drift

The projected APY now **correctly includes** all rebalance costs calculated using:
- **GARCH Volatility** (from statistical analysis)
- **Drift** (trend velocity)
- **Real gas prices** (fetched from chain)
- **Pool fee tier** (from pool data)
- **Position size** (actual deployed capital)

---

## How Rebalance Costs Are Calculated

### Step 1: Range Optimizer Uses GARCH + Drift

```typescript
optimalRange = rangeOptimizer.optimize(
  analysis.garchVolatility,  // ✅ GARCH volatility (not simple vol)
  analysis.drift,            // ✅ Drift velocity
  totalCapital,              // ✅ Actual position size
  poolAPR,                   // ✅ Base pool APR
  gasPriceGwei,              // ✅ Real gas price from chain
  funding.markPrice,         // ✅ Current price
  feeTier,                   // ✅ Pool fee tier (e.g., 0.0005 = 0.05%)
  fundingAPY                 // ✅ Funding APY
);
```

### Step 2: Rebalance Frequency Calculation

The optimizer calculates rebalance frequency using **quadratic diffusion model**:

```typescript
// Volatility component: QUADRATIC scaling (vol/width)^2
const volRatio = annualVolatilityPercent / rangeWidthPercent;
const volatilityRebalances = Math.pow(volRatio, 2) * 1.20;

// Drift component: Linear (velocity / distance)
const driftRebalances = (driftDecimal * 100) / rangeWidthPercent;

// Total rebalance frequency per year
const rebalanceFrequency = volatilityRebalances + driftRebalances;
```

**Why quadratic?** If you halve the range width, you hit the edge **4x as often** (not 2x) due to Brownian motion.

### Step 3: Cost Per Rebalance

```typescript
// 1. Gas cost
const gasCostPerRebalance = (450_000 gas * gasPriceGwei) / 1e9 * ethPrice;

// 2. Pool fee cost (THIS IS WHAT YOU ASKED ABOUT!)
const estimatedSwapNotional = positionValue * 0.5; // Swap ~50% of position
const poolFeePerRebalance = estimatedSwapNotional * poolFeeTier;

// 3. Slippage cost
const slippagePerRebalance = estimatedSwapNotional * 0.001; // 0.1% slippage

// Total cost per rebalance
const totalCostPerRebalance = gasCost + poolFee + slippage;
```

### Step 4: Annual Rebalance Costs

```typescript
// Annual cost in USD
const annualCost = rebalanceFrequency * totalCostPerRebalance;

// Cost drag as APY percentage
const costDrag = (annualCost / positionValue) * 100;
```

### Step 5: Net APY (After Costs)

```typescript
// Gross APY (from fees + funding)
const grossFeeApr = effectiveFeeApr + fundingApr;

// Net APY (after rebalance costs)
const netApy = grossFeeApr - costDrag;
```

---

## Example Calculation

Given:
- Position: $11.58
- GARCH Volatility: 60% annual
- Drift: 0.05%/hr
- Optimal Range: ±5%
- Pool Fee Tier: 0.05% (0.0005)
- Gas Price: 0.01 Gwei
- ETH Price: $36

**Step 1: Rebalance Frequency**
```
Range width: 5% * 0.95 = 4.75% (effective)
Vol ratio: 60% / 4.75% = 12.63
Vol rebalances: 12.63² * 1.20 = 191.3x/year
Drift rebalances: (0.05 * 100) / 4.75 = 1.05x/year
Total: 192.4x/year
```

**Step 2: Cost Per Rebalance**
```
Swap notional: $11.58 * 0.5 = $5.79
Gas cost: (450K * 0.01) / 1e9 * $36 = $0.00016
Pool fee: $5.79 * 0.0005 = $0.0029
Slippage: $5.79 * 0.001 = $0.0058
Total per rebalance: $0.0089
```

**Step 3: Annual Costs**
```
Annual cost: 192.4 * $0.0089 = $1.71
Cost drag: ($1.71 / $11.58) * 100 = 14.8% APY
```

**Step 4: Net APY**
```
Gross APY: 31.67% (pool + funding)
Cost drag: -14.8%
Net Base APY: 16.87%
```

---

## What's Included in the Projected APY

✅ **Base Pool APR** - 7-day average from subgraph  
✅ **Funding APY** - Real-time from HyperLiquid API  
✅ **Range Width Effects** - Fee density multiplier based on optimal range  
✅ **Time-in-Range Efficiency** - Based on volatility vs range width  
✅ **Rebalance Frequency** - Calculated from GARCH vol + drift (quadratic model)  
✅ **Gas Costs** - Real gas price from chain × rebalance frequency  
✅ **Pool Fee Costs** - `(positionValue * 0.5 * poolFeeTier) * rebalanceFrequency`  
✅ **Slippage Costs** - `(positionValue * 0.5 * 0.001) * rebalanceFrequency`  
✅ **Leverage** - Applied to net base APY  
✅ **Borrow Costs** - Subtracted from leveraged yield  

---

## Verification

The projected APY now matches the **Uniswap Base strategy** approach:
- ✅ Uses GARCH volatility (not simple volatility)
- ✅ Uses drift velocity
- ✅ Calculates rebalance frequency from vol/drift model
- ✅ Includes pool fees × rebalance frequency
- ✅ Includes gas costs × rebalance frequency
- ✅ Fetches real gas price from chain
- ✅ Uses actual position size

**All rebalance costs are now properly included!** 🎯


