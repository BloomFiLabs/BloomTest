import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

// Test parameters (from actual backtest)
const baseFeeAPR = 11.0; // Real APR from Uniswap
const incentiveAPR = 15.0;
const fundingAPR = 5.0;
const historicalVolatility = 0.6; // 60% annual volatility for ETH
const positionValueUSD = 40000; // 40% of $100k
const gasCostPerRebalance = 0.01; // ~$0.01 on Base
const poolFeeTier = 0.003; // 0.3% fee tier

console.log('🔍 Finding Optimal Range Width (Cost-Aware)\n');
console.log('Parameters:');
console.log(`  Base Fee APR: ${baseFeeAPR}%`);
console.log(`  Incentive APR: ${incentiveAPR}%`);
console.log(`  Funding APR: ${fundingAPR}%`);
console.log(`  Historical Volatility: ${historicalVolatility * 100}%`);
console.log(`  Position Value: $${positionValueUSD.toLocaleString()}`);
console.log(`  Gas Cost/Rebalance: $${gasCostPerRebalance}`);
console.log(`  Pool Fee Tier: ${poolFeeTier * 100}%\n`);

// Debug: Calculate what the analytical solution should be
const referenceRangeWidth = 0.05;
const costDragCoefficient = (gasCostPerRebalance + (positionValueUSD * 0.5 * poolFeeTier)) * historicalVolatility * 12 * 100 / positionValueUSD;
const numerator = 2 * baseFeeAPR * referenceRangeWidth * historicalVolatility * 0.3;
const denominator = baseFeeAPR * referenceRangeWidth - costDragCoefficient;
console.log(`\n🔬 Analytical Solution Debug:`);
console.log(`   Cost drag coefficient: ${costDragCoefficient.toFixed(6)}`);
console.log(`   Numerator: ${numerator.toFixed(6)}`);
console.log(`   Denominator: ${denominator.toFixed(6)}`);
if (Math.abs(denominator) > 1e-10) {
  const analyticalRange = numerator / denominator;
  console.log(`   Analytical optimal range: ±${(analyticalRange * 100).toFixed(3)}%`);
} else {
  console.log(`   ⚠️  Analytical solution invalid (denominator too small)`);
}

const result = RangeOptimizer.findOptimalNarrowestRange(
  baseFeeAPR,
  incentiveAPR,
  fundingAPR,
  historicalVolatility,
  0.005, // min ±0.5%
  0.20,  // max ±20%
  {
    gasCostPerRebalance,
    poolFeeTier,
    positionValueUSD,
  }
);

console.log('\n✅ OPTIMAL RANGE FOUND:');
console.log(`   Range Width: ±${(result.optimalRangeWidth * 100).toFixed(3)}%`);
console.log(`   Gross APY: ${result.expectedAPY.toFixed(2)}%`);
console.log(`   Net APY (after costs): ${result.netAPY?.toFixed(2)}%`);
console.log(`   Cost Drag: ${result.annualCostDrag?.toFixed(2)}%`);
console.log(`   Fee Capture Efficiency: ${result.feeCaptureEfficiency.toFixed(1)}%`);
console.log(`   Est. Rebalances/Year: ${result.rebalanceFrequency.toFixed(1)}`);

// Show why this is optimal - test a few nearby ranges
console.log('\n📊 Comparison with nearby ranges:');
const testRanges = [
  result.optimalRangeWidth * 0.8, // 20% narrower
  result.optimalRangeWidth * 0.9, // 10% narrower
  result.optimalRangeWidth,        // optimal
  result.optimalRangeWidth * 1.1, // 10% wider
  result.optimalRangeWidth * 1.2, // 20% wider
];

for (const rangeWidth of testRanges) {
  const test = RangeOptimizer.estimateAPYForRange(
    rangeWidth,
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
  const diff = (test.netAPY ?? test.expectedAPY) - (result.netAPY ?? result.expectedAPY);
  console.log(`   ±${(rangeWidth * 100).toFixed(2)}%: Net APY ${(test.netAPY ?? test.expectedAPY).toFixed(2)}% (${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%)`);
}

