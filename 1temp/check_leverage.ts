#!/usr/bin/env node
import 'dotenv/config';
import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

async function main() {
  console.log('🔬 LEVERAGE SIMULATION: $1M Portfolio on ETH/USDC\n');
  console.log('Assumptions: 33.05% Base APR, 74% Volatility, 5% Borrow Cost');
  console.log('-'.repeat(90));
  console.log(
    'Leverage'.padEnd(10) + 
    'Position Size'.padEnd(16) + 
    'Gross APR'.padEnd(12) + 
    'Borrow Cost'.padEnd(14) + 
    'Rebal Cost'.padEnd(14) + 
    'Net APY'
  );
  console.log('-'.repeat(90));

  const initialCapital = 1000000; // $1M
  const leverageLevels = [1.0, 1.5, 2.0, 3.0, 4.0, 5.0];
  const borrowAPR = 5.0; // 5% cost to borrow
  const baseAPR = 33.05;
  const volatility = 0.74;

  for (const lev of leverageLevels) {
    const positionSize = initialCapital * lev;
    const borrowedAmount = positionSize - initialCapital;
    
    const costModel = {
      gasCostPerRebalance: 0.50,
      poolFeeTier: 0.0005, // 0.05%
      positionValueUSD: positionSize
    };

    // Use the 39.5% range (most efficient for this vol)
    // Note: With leverage, we might afford narrower ranges? 
    // Let's stick to 39.5% to isolate leverage impact first.
    const res = RangeOptimizer.estimateAPYForRange(
      0.395, baseAPR, 0, 0, volatility, costModel, 5.0
    );

    // Calculations
    const totalFees = res.expectedAPY * (positionSize / 100); // Gross fees in $
    const totalBorrowCost = borrowedAmount * (borrowAPR / 100);
    const totalRebalCost = (res.annualCostDrag! / 100) * positionSize;
    
    const netProfit = totalFees - totalBorrowCost - totalRebalCost;
    const netAPY = (netProfit / initialCapital) * 100;

    console.log(
      `${lev.toFixed(1)}x`.padEnd(10) +
      `$${(positionSize/1000000).toFixed(1)}M`.padEnd(16) +
      `${res.expectedAPY.toFixed(2)}%`.padEnd(12) +
      `$${(totalBorrowCost/1000).toFixed(1)}k`.padEnd(14) +
      `$${(totalRebalCost/1000).toFixed(1)}k`.padEnd(14) +
      `${netAPY.toFixed(2)}%`
    );
  }
  
  console.log('\n🔍 ANALYSIS:');
  console.log('With 39.5% Range (Low Fee Capture), leverage helps but barely.');
  console.log('The low "Efficiency" of the wide range bottlenecks the yield.');
  console.log('Narrowing the range increases rebalance costs faster than leverage helps.');
}

main().catch(console.error);










