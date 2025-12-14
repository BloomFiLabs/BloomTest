#!/usr/bin/env npx tsx
/**
 * Debug the optimizer calculation to see why APY is negative
 */

import { RangeOptimizer } from '../../server/src/domain/services/RangeOptimizer';
import { Volatility } from '../../server/src/domain/value-objects/Volatility';
import { DriftVelocity } from '../../server/src/domain/value-objects/DriftVelocity';

// Parameters from logs
const vol = new Volatility(0.773); // 77.3%
const drift = new DriftVelocity(5.0);
const positionValue = 37.73; // $37.73
const baseFeeApr = 32.86; // From logs
const gasPriceGwei = 0.0011;
const ethPrice = 2936.68;
const poolFeeTier = 0.0005; // 0.05% (from logs)

const optimizer = new RangeOptimizer();

console.log('');
console.log('═'.repeat(80));
console.log('🔍 DEBUGGING OPTIMIZER CALCULATION');
console.log('═'.repeat(80));
console.log('');
console.log('Input Parameters:');
console.log(`  Volatility: ${vol.value * 100}%`);
console.log(`  Drift: ${drift.clampedValue}`);
console.log(`  Position Value: $${positionValue}`);
console.log(`  Base Fee APR: ${baseFeeApr}%`);
console.log(`  Gas Price: ${gasPriceGwei} Gwei`);
console.log(`  ETH Price: $${ethPrice}`);
console.log(`  Pool Fee Tier: ${(poolFeeTier * 100).toFixed(2)}%`);
console.log('');

const result = optimizer.optimize(
  vol,
  drift,
  positionValue,
  baseFeeApr,
  gasPriceGwei,
  ethPrice,
  poolFeeTier,
  0, // incentiveApr
  0, // fundingApr
);

console.log('═'.repeat(80));
console.log('📊 OPTIMIZER RESULT');
console.log('═'.repeat(80));
console.log('');
console.log(`Optimal Range: ${(result.optimalWidth * 100).toFixed(2)}%`);
console.log(`Estimated Net APY: ${result.estimatedNetApy.toFixed(2)}%`);
console.log(`Rebalances/year: ${result.rebalanceFrequency.toFixed(1)}`);
console.log(`Annual Cost: $${result.estimatedAnnualCost.toFixed(2)}`);
console.log('');

// Manual calculation breakdown
console.log('═'.repeat(80));
console.log('🧮 MANUAL CALCULATION BREAKDOWN');
console.log('═'.repeat(80));
console.log('');

const rangeWidth = result.optimalWidth;
const rangePercent = rangeWidth * 100;
const volatilityPercent = vol.value * 100;

// Fee concentration
const referenceWidth = 0.05;
const feeDensityMultiplier = Math.pow(referenceWidth / rangeWidth, 0.8);
console.log(`Fee Density Multiplier: ${feeDensityMultiplier.toFixed(4)}x`);

// Efficiency ratio
const rangeStdDevRatio = rangePercent / volatilityPercent;
let efficiencyRatio;
if (rangeStdDevRatio > 2) {
  efficiencyRatio = 0.95;
} else if (rangeStdDevRatio > 1) {
  efficiencyRatio = 0.75 + (rangeStdDevRatio - 1) * 0.20;
} else if (rangeStdDevRatio > 0.5) {
  efficiencyRatio = 0.55 + (rangeStdDevRatio - 0.5) * 0.40;
} else {
  efficiencyRatio = 0.40 + rangeStdDevRatio * 0.30;
}
efficiencyRatio = Math.min(0.98, Math.max(0.40, efficiencyRatio));
console.log(`Range/Vol Ratio: ${rangeStdDevRatio.toFixed(4)}`);
console.log(`Efficiency Ratio: ${(efficiencyRatio * 100).toFixed(2)}%`);

// Effective APR
const effectiveFeeApr = baseFeeApr * feeDensityMultiplier * efficiencyRatio;
console.log(`Effective Fee APR: ${effectiveFeeApr.toFixed(2)}%`);
console.log(`  = ${baseFeeApr}% × ${feeDensityMultiplier.toFixed(4)} × ${(efficiencyRatio * 100).toFixed(2)}%`);

// Rebalance frequency
const rebalanceThreshold = 0.95;
const effectiveRangeHalf = (rangeWidth * rebalanceThreshold) / 2;
const dailyVol = vol.value / Math.sqrt(252);
const expectedDaysToEdge = Math.pow(effectiveRangeHalf, 2) / (2 * Math.pow(dailyVol, 2));
const expectedYearsToEdge = expectedDaysToEdge / 365;
const driftDecimal = Math.abs(drift.clampedValue) / 100;
const driftImpact = driftDecimal / (rangeWidth / 2);
const rebalanceFrequency = Math.max(1, (1 / expectedYearsToEdge) + driftImpact);
console.log('');
console.log(`Rebalance Frequency: ${rebalanceFrequency.toFixed(1)}/year`);
console.log(`  Expected days to edge: ${expectedDaysToEdge.toFixed(1)}`);
console.log(`  Drift impact: ${driftImpact.toFixed(2)}/year`);

// Costs
const gasCostPerRebalance = (450_000 * gasPriceGwei) / 1e9 * ethPrice;
const estimatedSwapNotional = positionValue * 0.5;
const poolFeePerRebalance = estimatedSwapNotional * poolFeeTier;
const slippagePerRebalance = estimatedSwapNotional * (10 / 10000);
const totalCostPerRebalance = gasCostPerRebalance + poolFeePerRebalance + slippagePerRebalance;
const annualCost = rebalanceFrequency * totalCostPerRebalance;
const costDrag = (annualCost / positionValue) * 100;

console.log('');
console.log('Cost Breakdown:');
console.log(`  Gas per rebalance: $${gasCostPerRebalance.toFixed(4)}`);
console.log(`  Pool fee per rebalance: $${poolFeePerRebalance.toFixed(4)}`);
console.log(`  Slippage per rebalance: $${slippagePerRebalance.toFixed(4)}`);
console.log(`  Total per rebalance: $${totalCostPerRebalance.toFixed(4)}`);
console.log(`  Annual cost: $${annualCost.toFixed(2)}`);
console.log(`  Cost drag: ${costDrag.toFixed(2)}%`);
console.log('');

// Net APY
const netApy = effectiveFeeApr - costDrag;
console.log('═'.repeat(80));
console.log('💰 NET APY CALCULATION');
console.log('═'.repeat(80));
console.log(`  Effective Fee APR: ${effectiveFeeApr.toFixed(2)}%`);
console.log(`  Cost Drag:        -${costDrag.toFixed(2)}%`);
console.log(`  ─────────────────────────`);
console.log(`  Net APY:          ${netApy.toFixed(2)}%`);
console.log('');

if (netApy < 35) {
  console.log('⚠️  APY is below 35% target!');
  console.log('');
  console.log('Possible issues:');
  if (costDrag > effectiveFeeApr) {
    console.log(`  ❌ Cost drag (${costDrag.toFixed(2)}%) exceeds effective APR (${effectiveFeeApr.toFixed(2)}%)`);
  }
  if (feeDensityMultiplier < 0.5) {
    console.log(`  ⚠️  Fee density multiplier is low (${feeDensityMultiplier.toFixed(4)}x) - range may be too wide`);
  }
  if (efficiencyRatio < 0.5) {
    console.log(`  ⚠️  Efficiency ratio is low (${(efficiencyRatio * 100).toFixed(2)}%) - range may be too narrow for volatility`);
  }
  if (rebalanceFrequency > 50) {
    console.log(`  ⚠️  Rebalance frequency is high (${rebalanceFrequency.toFixed(1)}/year) - costs are eating profits`);
  }
}










