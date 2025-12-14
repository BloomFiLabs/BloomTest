#!/usr/bin/env node
import 'dotenv/config';
import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

// Helper to simulate a specific scenario
function getBestAPYForVol(vol: number) {
  const costModel = {
    gasCostPerRebalance: 0.50,
    poolFeeTier: 0.0005, // 0.05% pool
    positionValueUSD: 10000
  };
  const baseApr = 33.05;
  const ranges = [0.01, 0.02, 0.05, 0.10, 0.20, 0.395];
  
  let bestNet = -Infinity;
  
  for (const width of ranges) {
    const res = RangeOptimizer.estimateAPYForRange(
      width, baseApr, 0, 0, vol, costModel, 5.0
    );
    if ((res.netAPY || -Infinity) > bestNet) {
      bestNet = res.netAPY || -Infinity;
    }
  }
  return bestNet;
}

console.log('📉 VOLATILITY REQUIREMENT ANALYSIS (Target: 35% APY)\n');
console.log('Assumptions: Base APR 33.05%, 0.05% Fee Tier, $10k Position');
console.log('-'.repeat(60));
console.log('Volatility | Best Possible Net APY');
console.log('-'.repeat(60));

// Sweep volatility from 80% down to 5%
for (let v = 80; v >= 5; v -= 5) {
  const volDecimal = v / 100;
  const apy = getBestAPYForVol(volDecimal);
  
  const marker = apy >= 35 ? '✅ TARGET HIT' : '';
  console.log(`${v.toString().padStart(3)}%        | ${apy.toFixed(2).padStart(6)}% ${marker}`);
}










