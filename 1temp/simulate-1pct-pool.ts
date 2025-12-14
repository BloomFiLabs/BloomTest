#!/usr/bin/env npx tsx
/**
 * Simulate WETH/USDC 1% Fee Tier Pool
 * APR: 101.32% vs current 1.39%
 */

import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

const POSITION_VALUE = 37.74;
const POOL_APR = 101.32; // 1% fee tier
const VOLATILITY = 0.774;
const GAS_PRICE_GWEI = 0.0014;
const ETH_PRICE = 2943;
const GAS_UNITS = 450_000;
const POOL_FEE_TIER = 0.01; // 1% (vs 0.05%)

const gasCostPerRebalance = (GAS_UNITS * GAS_PRICE_GWEI) / 1e9 * ETH_PRICE;

console.log('');
console.log('═'.repeat(80));
console.log('🚀 WETH/USDC 1% POOL SIMULATION');
console.log('═'.repeat(80));
console.log('');
console.log(`Position: $${POSITION_VALUE} | Vol: ${(VOLATILITY * 100).toFixed(1)}% | Pool APR: ${POOL_APR}%`);
console.log('');

const result = RangeOptimizer.findOptimalNarrowestRange(
  POOL_APR,
  0,
  0,
  VOLATILITY,
  0.01,
  0.50,
  {
    gasCostPerRebalance,
    poolFeeTier: POOL_FEE_TIER,
    positionValueUSD: POSITION_VALUE,
  },
  0.05
);

console.log('🎯 OPTIMAL STRATEGY:');
console.log('-'.repeat(80));
console.log(`Range Width:           ${(result.optimalRangeWidth * 100).toFixed(2)}%`);
console.log(`Expected Gross APY:    ${result.expectedAPY.toFixed(2)}%`);
console.log(`Net APY (after costs): ${(result.netAPY || 0).toFixed(2)}%`);
console.log(`Rebalances/Year:       ${result.rebalanceFrequency.toFixed(1)}`);
console.log(`Days Between Rebal:    ${(365 / result.rebalanceFrequency).toFixed(1)}`);
console.log(`Annual Cost:           $${((result.annualCostDrag || 0) * POSITION_VALUE / 100).toFixed(2)}`);
console.log('');

console.log('💰 PROFITABILITY:');
console.log('-'.repeat(80));
const annualProfit = POSITION_VALUE * (result.netAPY || 0) / 100;
const monthlyProfit = annualProfit / 12;
const dailyProfit = annualProfit / 365;

console.log(`Daily Profit:          $${dailyProfit.toFixed(4)}`);
console.log(`Monthly Profit:        $${monthlyProfit.toFixed(2)}`);
console.log(`Annual Profit:         $${annualProfit.toFixed(2)}`);
console.log('');

console.log('📈 COMPARISON TO 0.05% POOL:');
console.log('-'.repeat(80));
console.log(`Old Pool APR:          1.39%  → New: ${POOL_APR}% (${(POOL_APR / 1.39).toFixed(0)}x better)`);
console.log(`Old Net APY:           -0.79% → New: ${(result.netAPY || 0).toFixed(2)}%`);
console.log(`Improvement:           +${((result.netAPY || 0) + 0.79).toFixed(2)}% APY`);
console.log('');

// Simulate with $500 position
console.log('═'.repeat(80));
console.log('💎 WITH $500 POSITION:');
console.log('═'.repeat(80));
console.log('');

const result500 = RangeOptimizer.findOptimalNarrowestRange(
  POOL_APR,
  0,
  0,
  VOLATILITY,
  0.01,
  0.50,
  {
    gasCostPerRebalance,
    poolFeeTier: POOL_FEE_TIER,
    positionValueUSD: 500,
  },
  0.05
);

const annualProfit500 = 500 * (result500.netAPY || 0) / 100;
console.log(`Net APY:               ${(result500.netAPY || 0).toFixed(2)}%`);
console.log(`Annual Profit:         $${annualProfit500.toFixed(2)}`);
console.log(`Monthly Profit:        $${(annualProfit500 / 12).toFixed(2)}`);
console.log('');

console.log('✅ RECOMMENDATION: SWITCH TO 1% POOL IMMEDIATELY!');
console.log('');










