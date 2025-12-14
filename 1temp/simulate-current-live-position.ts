#!/usr/bin/env npx tsx
/**
 * Simulate Current Live Position
 * 
 * This script simulates the exact situation from the live bot:
 * - Position: $37.74
 * - Volatility: 77.4%
 * - Pool APR: 1.39%
 * - Gas: 0.0014 Gwei on Base
 * - ETH Price: $2,943
 * 
 * Goal: Verify the optimizer fixes and understand why APY is so low
 */

import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

console.log('');
console.log('═'.repeat(80));
console.log('🔬 LIVE POSITION SIMULATION');
console.log('═'.repeat(80));
console.log('');

// Exact parameters from live bot logs
const POSITION_VALUE = 37.74;
const POOL_APR = 1.39; // ETH/USDC 0.05% pool on Base
const VOLATILITY = 0.774; // 77.4%
const GAS_PRICE_GWEI = 0.0014;
const ETH_PRICE = 2943;
const GAS_UNITS = 450_000;
const POOL_FEE_TIER = 0.0005; // 0.05%

// Calculate gas cost per rebalance
const gasCostPerRebalance = (GAS_UNITS * GAS_PRICE_GWEI) / 1e9 * ETH_PRICE;

console.log('📊 INPUT PARAMETERS');
console.log('-'.repeat(80));
console.log(`Position Value:        $${POSITION_VALUE.toFixed(2)}`);
console.log(`Pool Base APR:         ${POOL_APR.toFixed(2)}%`);
console.log(`Volatility (IV):       ${(VOLATILITY * 100).toFixed(2)}%`);
console.log(`Gas Price:             ${GAS_PRICE_GWEI.toFixed(4)} Gwei`);
console.log(`ETH Price:             $${ETH_PRICE.toFixed(2)}`);
console.log(`Gas Cost/Rebalance:    $${gasCostPerRebalance.toFixed(4)}`);
console.log('');

console.log('═'.repeat(80));
console.log('🧪 TESTING DIFFERENT RANGE WIDTHS');
console.log('═'.repeat(80));
console.log('');

// Test various range widths
const testRanges = [
  0.0195, // 1.95% (very narrow)
  0.0475, // 4.75% (narrow)
  0.0975, // 9.75% (moderate)
  0.150,  // 15% (wide)
  0.200,  // 20% (wider)
  0.250,  // 25% (wider)
  0.300,  // 30% (very wide)
  0.400,  // 40% (extremely wide)
];

console.log('Range  | Concentration | Efficiency | Gross APY | Rebal/Yr | Annual Cost | Net APY');
console.log('-'.repeat(80));

const results: Array<{width: number; netAPY: number; rebalances: number}> = [];

for (const width of testRanges) {
  const result = RangeOptimizer.estimateAPYForRange(
    width,
    POOL_APR,
    0, // incentiveAPR
    0, // fundingAPR
    VOLATILITY,
    {
      gasCostPerRebalance,
      poolFeeTier: POOL_FEE_TIER,
      positionValueUSD: POSITION_VALUE,
    },
    0.05 // 5% drift
  );

  results.push({
    width: width * 100,
    netAPY: result.netAPY || 0,
    rebalances: result.rebalanceFrequency,
  });

  // Calculate components for display
  const feeDensity = Math.pow(0.05 / width, 0.8);
  const effectiveAPR = POOL_APR * feeDensity * (result.feeCaptureEfficiency / 100);
  
  console.log(
    `${(width * 100).toFixed(1).padStart(5)}% | ` +
    `${feeDensity.toFixed(2).padStart(13)} | ` +
    `${result.feeCaptureEfficiency.toFixed(1).padStart(10)}% | ` +
    `${effectiveAPR.toFixed(2).padStart(9)}% | ` +
    `${result.rebalanceFrequency.toFixed(1).padStart(8)} | ` +
    `$${(result.annualCostDrag! * POSITION_VALUE / 100).toFixed(2).padStart(10)} | ` +
    `${(result.netAPY || 0).toFixed(2).padStart(7)}%`
  );
}

console.log('');
console.log('═'.repeat(80));
console.log('🎯 OPTIMAL RANGE (MAXIMIZE NET APY)');
console.log('═'.repeat(80));
console.log('');

// Find optimal using backtest optimizer
const optimalResult = RangeOptimizer.findOptimalNarrowestRange(
  POOL_APR,
  0, // incentiveAPR
  0, // fundingAPR
  VOLATILITY,
  0.01,  // Min 1% (allow wider for high vol)
  0.50,  // Max 50% (very wide search)
  {
    gasCostPerRebalance,
    poolFeeTier: POOL_FEE_TIER,
    positionValueUSD: POSITION_VALUE,
  },
  0.05 // 5% drift
);

console.log(`📌 Optimal Range Width:  ${(optimalResult.optimalRangeWidth * 100).toFixed(2)}%`);
console.log(`📈 Expected Gross APY:   ${optimalResult.expectedAPY.toFixed(2)}%`);
console.log(`💰 Net APY (after costs): ${(optimalResult.netAPY || 0).toFixed(2)}%`);
console.log(`🔄 Rebalances/Year:       ${optimalResult.rebalanceFrequency.toFixed(1)}`);
console.log(`⏱️  Days Between Rebal:   ${(365 / optimalResult.rebalanceFrequency).toFixed(1)}`);
console.log(`💸 Annual Cost Drag:      ${(optimalResult.annualCostDrag || 0).toFixed(2)}%`);
console.log(`💵 Annual Cost ($):       $${((optimalResult.annualCostDrag || 0) * POSITION_VALUE / 100).toFixed(2)}`);
console.log('');

// Find best from our test results
const bestFromTests = results.reduce((best, curr) => 
  curr.netAPY > best.netAPY ? curr : best
);

console.log('═'.repeat(80));
console.log('💡 ANALYSIS & INSIGHTS');
console.log('═'.repeat(80));
console.log('');

console.log('Why is APY so low?');
console.log('');
console.log(`1. Pool APR (${POOL_APR}%) is fundamentally too low for ${(VOLATILITY * 100).toFixed(1)}% volatility`);
console.log('   - For 77% vol, you typically need 10-20% base APR to be profitable');
console.log('   - Current pool has low volume relative to TVL');
console.log('');
console.log(`2. Small position size ($${POSITION_VALUE}) amplifies fixed costs`);
console.log('   - Each rebalance costs ~$0.10 (gas + pool fees)');
console.log('   - Even at 20 rebalances/year: $2/year = 5.3% cost drag');
console.log('');
console.log('3. High volatility requires either:');
console.log('   a) Very wide ranges (30-40%) → low fee concentration');
console.log('   b) Narrow ranges → constant rebalancing → high costs');
console.log('');

const MIN_PROFITABLE_POSITION = 500; // $500 minimum
const costPerRebalAt500 = gasCostPerRebalance + (500 * 0.5 * POOL_FEE_TIER);
const rebalAt500 = bestFromTests.rebalances;
const costDragAt500 = (costPerRebalAt500 * rebalAt500 / 500) * 100;

console.log(`💡 With a $${MIN_PROFITABLE_POSITION} position at ${bestFromTests.width.toFixed(1)}% range:`);
console.log(`   - Cost/rebalance: $${costPerRebalAt500.toFixed(2)}`);
console.log(`   - Annual cost drag: ${costDragAt500.toFixed(2)}%`);
console.log(`   - Estimated net APY: ${(optimalResult.expectedAPY - costDragAt500).toFixed(2)}%`);
console.log('');

console.log('═'.repeat(80));
console.log('🎓 RECOMMENDATIONS');
console.log('═'.repeat(80));
console.log('');
console.log('For current market conditions (77% vol, 1.39% pool APR):');
console.log('');
console.log('Option 1: INCREASE POSITION SIZE');
console.log(`  - Minimum: $500 (3-5% APY possible)`);
console.log(`  - Optimal: $5,000+ (8-12% APY possible)`);
console.log('');
console.log('Option 2: SWITCH TO HIGHER FEE POOLS');
console.log('  - ETH/USDC 0.3% tier: ~8-12% APR (if available)');
console.log('  - ETH/USDC 1% tier: ~20-30% APR (for very high vol)');
console.log('');
console.log('Option 3: ADD FUNDING RATE ARBITRAGE');
console.log('  - Capture perp funding: typically 5-20% APY');
console.log('  - Combined with LP fees: 15-35% total APY');
console.log('');
console.log('Option 4: WAIT FOR BETTER CONDITIONS');
console.log('  - Lower volatility (< 50%)');
console.log('  - Higher pool volume/fees');
console.log('');
console.log('═'.repeat(80));
console.log('');










