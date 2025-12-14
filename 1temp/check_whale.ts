#!/usr/bin/env node
import 'dotenv/config';
import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

async function main() {
  console.log('🔬 WHALE SIMULATION ($1M+ Position)\n');
  
  const costModel = {
    gasCostPerRebalance: 0.50,
    poolFeeTier: 0.0005, // 0.05%
    positionValueUSD: 1000000 // $1 Million
  };

  const res = RangeOptimizer.estimateAPYForRange(
    0.395, 33.05, 0, 0, 0.74, costModel, 5.0
  );

  console.log(`Position: $1,000,000`);
  console.log(`Gas Cost: $${(res.rebalanceFrequency * 0.50).toFixed(2)} (0.00%)`);
  console.log(`Swap Fees: $${(res.rebalanceFrequency * 1000000 * 0.5 * 0.0005).toFixed(2)} (0.45%)`);
  console.log(`Net APY: ${res.netAPY?.toFixed(2)}%`);
}

main().catch(console.error);










