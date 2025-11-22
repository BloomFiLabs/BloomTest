import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

const baseFeeAPR = 11.0;
const incentiveAPR = 15.0;
const fundingAPR = 5.0;
const historicalVolatility = 0.6;
const positionValueUSD = 40000;
const gasCostPerRebalance = 0.01;
const poolFeeTier = 0.003;

const costModel = {
  gasCostPerRebalance,
  poolFeeTier,
  positionValueUSD,
};

console.log('🔍 Testing EXTREME Narrow Ranges\n');
console.log('Question: Can we go narrower than ±0.5% for even higher APY?\n');

// Test very narrow ranges
const testRanges = [0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009, 0.01, 0.015, 0.02];
const results: Array<{range: number, netAPY: number, grossAPY: number, rebalances: number, costDrag: number}> = [];

console.log('Range     | Fee Density | Efficiency | Gross APY | Rebalances | Cost Drag | Net APY');
console.log('-'.repeat(90));

for (const rangeWidth of testRanges) {
  const result = RangeOptimizer.estimateAPYForRange(
    rangeWidth,
    baseFeeAPR,
    incentiveAPR,
    fundingAPR,
    historicalVolatility,
    costModel
  );
  const netAPY = result.netAPY ?? result.expectedAPY;
  const feeDensity = Math.pow(0.05 / rangeWidth, 1.5);
  
  results.push({ 
    range: rangeWidth, 
    netAPY, 
    grossAPY: result.expectedAPY,
    rebalances: result.rebalanceFrequency,
    costDrag: result.annualCostDrag || 0
  });
  
  console.log(
    `±${(rangeWidth * 100).toFixed(2)}%`.padEnd(10) +
    `| ${feeDensity.toFixed(1)}x`.padEnd(12) +
    `| ${result.feeCaptureEfficiency.toFixed(1)}%`.padEnd(11) +
    `| ${result.expectedAPY.toFixed(1)}%`.padEnd(10) +
    `| ${result.rebalanceFrequency.toFixed(0)}/yr`.padEnd(11) +
    `| ${(result.annualCostDrag || 0).toFixed(1)}%`.padEnd(10) +
    `| ${netAPY.toFixed(1)}%`
  );
}

const best = results.reduce((best, curr) => curr.netAPY > best.netAPY ? curr : best);
console.log('\n' + '='.repeat(90));
console.log(`\n🏆 MAXIMUM NET APY: ${best.netAPY.toFixed(2)}% at ±${(best.range * 100).toFixed(2)}% range`);
console.log(`   Gross APY: ${best.grossAPY.toFixed(2)}%`);
console.log(`   Rebalances: ${best.rebalances.toFixed(0)} times/year`);
console.log(`   Cost Drag: ${best.costDrag.toFixed(2)}%`);

// Find the theoretical maximum (no cost model)
console.log('\n' + '='.repeat(90));
console.log('\n💎 THEORETICAL MAXIMUM (No Costs):\n');

const noCostResults: Array<{range: number, grossAPY: number}> = [];
for (const rangeWidth of testRanges) {
  const result = RangeOptimizer.estimateAPYForRange(
    rangeWidth,
    baseFeeAPR,
    incentiveAPR,
    fundingAPR,
    historicalVolatility
  );
  noCostResults.push({ range: rangeWidth, grossAPY: result.expectedAPY });
}

const bestNoCost = noCostResults.reduce((best, curr) => curr.grossAPY > best.grossAPY ? curr : best);
console.log(`   Maximum Gross APY: ${bestNoCost.grossAPY.toFixed(2)}% at ±${(bestNoCost.range * 100).toFixed(2)}% range`);
console.log(`   (This assumes zero rebalancing costs)`);

// Show the curve
console.log('\n' + '='.repeat(90));
console.log('\n📈 APY CURVE ANALYSIS:\n');

const sortedByRange = [...results].sort((a, b) => a.range - b.range);
let prevAPY = 0;
for (const r of sortedByRange) {
  const delta = r.netAPY - prevAPY;
  const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
  console.log(`   ±${(r.range * 100).toFixed(2)}%: ${r.netAPY.toFixed(2)}% ${arrow} ${Math.abs(delta).toFixed(2)}%`);
  prevAPY = r.netAPY;
}

console.log('\n💡 INSIGHTS:');
console.log('   1. Net APY peaks somewhere between these ranges');
console.log('   2. Below optimal: Fee density gains > Cost increases');
console.log('   3. Above optimal: Cost increases > Fee density gains');
console.log('   4. The "sweet spot" balances extreme fee concentration with manageable costs');







