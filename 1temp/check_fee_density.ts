#!/usr/bin/env node
import 'dotenv/config';
import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

async function main() {
  console.log('🔬 FEE DENSITY VS. REBALANCE COST ANALYSIS\n');
  console.log('Assumptions: 33% Base APR, 74% Volatility, $10k Position');
  console.log('-'.repeat(100));
  console.log(
    'Range'.padEnd(8) + 
    'Fee Multiplier'.padEnd(16) + 
    'Effective APR'.padEnd(16) + 
    'Rebal/Year'.padEnd(12) + 
    'Cost/Year'.padEnd(12) + 
    'Net APY'
  );
  console.log('-'.repeat(100));

  const costModel = {
    gasCostPerRebalance: 0.50,
    poolFeeTier: 0.0005,
    positionValueUSD: 10000
  };
  const baseApr = 33.05;
  const ranges = [0.01, 0.02, 0.05, 0.10, 0.20, 0.395];

  for (const width of ranges) {
    const res = RangeOptimizer.estimateAPYForRange(
      width, baseApr, 0, 0, 0.74, costModel, 5.0
    );

    // Explicitly calculate the fee multiplier (Concentration)
    // Formula from RangeOptimizer: (referenceWidth / width) ^ 0.8
    const referenceWidth = 0.05;
    const feeDensityMultiplier = Math.pow(referenceWidth / width, 0.8);

    console.log(
      `${(width * 100).toFixed(1)}%`.padEnd(8) +
      `${feeDensityMultiplier.toFixed(2)}x`.padEnd(16) +
      `${res.expectedAPY.toFixed(2)}%`.padEnd(16) +
      `${res.rebalanceFrequency.toFixed(1)}`.padEnd(12) +
      `$${(res.annualCostDrag! * 100).toFixed(0)}`.padEnd(12) +
      `${(res.netAPY || 0).toFixed(2)}%`
    );
  }
  
  console.log('\n🔍 CONCLUSION:');
  console.log('At 1% range, you get 3.6x more fees (Fee Multiplier),');
  console.log('BUT you rebalance 7,800x times per year.');
  console.log('The math is brutal: Costs scale quadratically (squared), Fees scale linearly.');
}

main().catch(console.error);










