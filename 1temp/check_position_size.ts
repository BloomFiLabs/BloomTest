#!/usr/bin/env node
import 'dotenv/config';
import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

async function main() {
  console.log('🔬 POSITION SIZE ANALYSIS: Impact on Net APY\n');
  console.log('Assumptions: 33% Base APR, 74% Volatility, 39.5% Range');
  console.log('-'.repeat(80));
  console.log('Position Size | Rebal Cost (Gas) | Swap Fees | Total Cost % | Net APY');
  console.log('-'.repeat(80));

  const sizes = [50, 100, 500, 1000, 5000, 10000, 50000, 100000];
  
  for (const size of sizes) {
    const costModel = {
      gasCostPerRebalance: 0.50,
      poolFeeTier: 0.0005, // 0.05%
      positionValueUSD: size
    };

    // Use 39.5% range (the "best" current one)
    const res = RangeOptimizer.estimateAPYForRange(
      0.395, 33.05, 0, 0, 0.74, costModel, 5.0
    );

    const rebalFreq = res.rebalanceFrequency;
    const totalGas = rebalFreq * 0.50;
    const totalSwapFees = rebalFreq * (size * 0.5 * 0.0005); // Assuming 50% swapped
    const totalCost = totalGas + totalSwapFees;
    const costPercent = (totalCost / size) * 100;
    const netAPY = (res.netAPY || 0);

    console.log(
      `$${size.toLocaleString().padEnd(12)} | ` +
      `$${totalGas.toFixed(2).padEnd(15)} | ` +
      `$${totalSwapFees.toFixed(2).padEnd(8)} | ` +
      `${costPercent.toFixed(2)}%`.padEnd(12) + ' | ' +
      `${netAPY.toFixed(2)}%`
    );
  }
  
  console.log('\n🔍 INTERPRETATION:');
  console.log('Below $500: Gas costs eat >2% of your yield.');
  console.log('Above $5,000: Gas is negligible. Swap fees dominate.');
}

main().catch(console.error);










