import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

// Test with narrow range like the backtest showed
const baseFeeAPR = 11.0; // Real APR from Uniswap
const incentiveAPR = 15.0;
const fundingAPR = 5.0;
const historicalVolatility = 0.6; // 60% annual volatility for ETH
const positionValueUSD = 40000; // 40% of $100k
const gasCostPerRebalance = 0.01; // ~$0.01 on Base
const poolFeeTier = 0.003; // 0.3% fee tier

console.log('🔍 Testing Narrow Range (±1%) vs Wide Range (±20%)\n');
console.log('Parameters:');
console.log(`  Base Fee APR: ${baseFeeAPR}%`);
console.log(`  Position Value: $${positionValueUSD.toLocaleString()}`);
console.log(`  Gas Cost/Rebalance: $${gasCostPerRebalance}`);
console.log(`  Pool Fee Tier: ${poolFeeTier * 100}%\n`);

// Test narrow range (±1%)
const narrowResult = RangeOptimizer.estimateAPYForRange(
  0.01, // ±1% range
  baseFeeAPR,
  incentiveAPR,
  fundingAPR,
  historicalVolatility,
  {
    gasCostPerRebalance,
    poolFeeTier,
    positionValueUSD,
  }
);

// Test wide range (±20%)
const wideResult = RangeOptimizer.estimateAPYForRange(
  0.20, // ±20% range
  baseFeeAPR,
  incentiveAPR,
  fundingAPR,
  historicalVolatility,
  {
    gasCostPerRebalance,
    poolFeeTier,
    positionValueUSD,
  }
);

console.log('📊 COMPARISON:\n');
console.log(`Narrow Range (±1%):`);
console.log(`  Gross APY: ${narrowResult.expectedAPY.toFixed(2)}%`);
console.log(`  Net APY: ${narrowResult.netAPY?.toFixed(2)}%`);
console.log(`  Fee Capture Efficiency: ${narrowResult.feeCaptureEfficiency.toFixed(1)}%`);
console.log(`  Rebalances/Year: ${narrowResult.rebalanceFrequency.toFixed(1)}`);
console.log(`  Cost Drag: ${narrowResult.annualCostDrag?.toFixed(2)}%`);
const narrowFeeDensity = Math.pow(0.05 / 0.01, 1.5);
console.log(`  Fee Density Multiplier: ${narrowFeeDensity.toFixed(1)}x (${(narrowFeeDensity).toFixed(1)}x more concentrated)`);

console.log(`\nWide Range (±20%):`);
console.log(`  Gross APY: ${wideResult.expectedAPY.toFixed(2)}%`);
console.log(`  Net APY: ${wideResult.netAPY?.toFixed(2)}%`);
console.log(`  Fee Capture Efficiency: ${wideResult.feeCaptureEfficiency.toFixed(1)}%`);
console.log(`  Rebalances/Year: ${wideResult.rebalanceFrequency.toFixed(1)}`);
console.log(`  Cost Drag: ${wideResult.annualCostDrag?.toFixed(2)}%`);
const wideFeeDensity = Math.pow(0.05 / 0.20, 1.5);
console.log(`  Fee Density Multiplier: ${wideFeeDensity.toFixed(2)}x (${wideFeeDensity.toFixed(2)}x less concentrated)`);

console.log(`\n💡 Key Insight:`);
const densityRatio = narrowFeeDensity / wideFeeDensity;
console.log(`  Narrow range has ${densityRatio.toFixed(1)}x higher fee density`);
console.log(`  But efficiency drops from ${wideResult.feeCaptureEfficiency.toFixed(1)}% to ${narrowResult.feeCaptureEfficiency.toFixed(1)}%`);
console.log(`  And rebalances increase from ${wideResult.rebalanceFrequency.toFixed(0)} to ${narrowResult.rebalanceFrequency.toFixed(0)} per year`);

console.log(`\n🔬 Fee Density Analysis (with 1.5 power scaling):`);
console.log(`  Narrow range fee density: ${narrowFeeDensity.toFixed(1)}x`);
console.log(`  Wide range fee density: ${wideFeeDensity.toFixed(2)}x`);
console.log(`  Ratio: ${densityRatio.toFixed(1)}x more fees per dollar in narrow range`);
console.log(`  Narrow range efficiency: ${narrowResult.feeCaptureEfficiency.toFixed(1)}% vs wide: ${wideResult.feeCaptureEfficiency.toFixed(1)}%`);
console.log(`  Effective fee multiplier: ${(narrowFeeDensity * narrowResult.feeCaptureEfficiency / 100).toFixed(2)}x vs ${(wideFeeDensity * wideResult.feeCaptureEfficiency / 100).toFixed(2)}x`);
console.log(`\n⚠️  Issue: Rebalance frequency still too high (${narrowResult.rebalanceFrequency.toFixed(0)}/year)`);
console.log(`   With 0.9% threshold on 1% range, should rebalance ~${(60 / 0.9 * 12).toFixed(0)} times/year`);
console.log(`   But model shows ${narrowResult.rebalanceFrequency.toFixed(0)} - need to fix rebalance frequency calculation`);

