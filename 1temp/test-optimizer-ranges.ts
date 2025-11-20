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

console.log('🔍 Testing Multiple Ranges to Find True Optimum\n');

const testRanges = [0.005, 0.01, 0.02, 0.03, 0.05, 0.10, 0.15, 0.20];
const results: Array<{range: number, netAPY: number}> = [];

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
  results.push({ range: rangeWidth, netAPY });
  console.log(`±${(rangeWidth * 100).toFixed(1)}%: Net APY ${netAPY.toFixed(2)}% (Gross: ${result.expectedAPY.toFixed(2)}%, Cost Drag: ${result.annualCostDrag?.toFixed(2)}%, Rebalances: ${result.rebalanceFrequency.toFixed(1)}/year)`);
}

const best = results.reduce((best, curr) => curr.netAPY > best.netAPY ? curr : best);
console.log(`\n✅ Best Range: ±${(best.range * 100).toFixed(1)}% with ${best.netAPY.toFixed(2)}% Net APY`);

console.log(`\n🔍 Now testing optimizer:`);
const optimizerResult = RangeOptimizer.findOptimalNarrowestRange(
  baseFeeAPR,
  incentiveAPR,
  fundingAPR,
  historicalVolatility,
  0.005,
  0.20,
  costModel
);
console.log(`Optimizer found: ±${(optimizerResult.optimalRangeWidth * 100).toFixed(1)}% with ${optimizerResult.netAPY?.toFixed(2)}% Net APY`);





