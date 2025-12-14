#!/usr/bin/env npx tsx
/**
 * Compare All Pool Fee Tiers
 * 
 * The trade-off: Higher fee tier = Higher APR BUT Higher rebalance costs
 */

import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

const POSITION_VALUE = 500; // Use $500 for realistic example
const VOLATILITY = 0.774;
const GAS_PRICE_GWEI = 0.0014;
const ETH_PRICE = 2943;
const GAS_UNITS = 450_000;

const gasCostPerRebalance = (GAS_UNITS * GAS_PRICE_GWEI) / 1e9 * ETH_PRICE;

console.log('');
console.log('═'.repeat(100));
console.log('📊 COMPARING ALL ETH/USDC POOLS ON BASE');
console.log('═'.repeat(100));
console.log('');
console.log(`Position: $${POSITION_VALUE} | Volatility: ${(VOLATILITY * 100).toFixed(1)}%`);
console.log('');

interface PoolConfig {
  name: string;
  apr: number;
  feeTier: number;
  tvl: number;
  address: string;
}

const pools: PoolConfig[] = [
  {
    name: '0.05% Tier',
    apr: 1.17,
    feeTier: 0.0005,
    tvl: 21_663_743,
    address: '0xd0b53d9277642d899df5c87a3966a349a798f224',
  },
  {
    name: '0.30% Tier',
    apr: 1.54,
    feeTier: 0.003,
    tvl: 9_344_646,
    address: '0x6c561b446416e1a00e8e93e221854d6ea4171372',
  },
  {
    name: '1.00% Tier',
    apr: 101.32,
    feeTier: 0.01,
    tvl: 93_019,
    address: '0x0b1c2dcbbfa744ebd3fc17ff1a96a1e1eb4b2d69',
  },
];

console.log('Pool         | Base APR | Fee/Swap | TVL          | Optimal Range | Rebal/Yr | Net APY');
console.log('-'.repeat(100));

const results: Array<{pool: PoolConfig; result: any}> = [];

for (const pool of pools) {
  const result = RangeOptimizer.findOptimalNarrowestRange(
    pool.apr,
    0,
    0,
    VOLATILITY,
    0.01,
    0.50,
    {
      gasCostPerRebalance,
      poolFeeTier: pool.feeTier,
      positionValueUSD: POSITION_VALUE,
    },
    0.05
  );

  results.push({ pool, result });

  console.log(
    `${pool.name.padEnd(12)} | ` +
    `${pool.apr.toFixed(2).padStart(8)}% | ` +
    `${(pool.feeTier * 100).toFixed(2).padStart(8)}% | ` +
    `$${pool.tvl.toLocaleString().padStart(12)} | ` +
    `${(result.optimalRangeWidth * 100).toFixed(1).padStart(13)}% | ` +
    `${result.rebalanceFrequency.toFixed(1).padStart(8)} | ` +
    `${(result.netAPY || 0).toFixed(2).padStart(7)}%`
  );
}

console.log('');
console.log('═'.repeat(100));
console.log('💡 KEY INSIGHT: THE PARADOX OF HIGH FEE TIERS');
console.log('═'.repeat(100));
console.log('');

// Find best
const best = results.reduce((best, curr) => 
  (curr.result.netAPY || -Infinity) > (best.result.netAPY || -Infinity) ? curr : best
);

console.log('The 1% pool has 101% APR BUT you pay 1% every time you rebalance!');
console.log('');
console.log('Cost breakdown for 1% pool at 31 rebalances/year:');
console.log(`  - Gas costs:        ${31} × $${gasCostPerRebalance.toFixed(4)} = $${(31 * gasCostPerRebalance).toFixed(2)}/year`);
console.log(`  - Pool fee costs:   ${31} × $${(POSITION_VALUE * 0.5 * 0.01).toFixed(2)} = $${(31 * POSITION_VALUE * 0.5 * 0.01).toFixed(2)}/year`);
console.log(`  - Total costs:      $${(31 * (gasCostPerRebalance + POSITION_VALUE * 0.5 * 0.01)).toFixed(2)}/year`);
console.log(`  - Cost drag:        ${(31 * (gasCostPerRebalance + POSITION_VALUE * 0.5 * 0.01) / POSITION_VALUE * 100).toFixed(2)}%`);
console.log('');
console.log('The 101% APR - 32% cost drag = only 69% net (but we lose more from inefficiency)');
console.log('');

console.log('✅ BEST POOL:');
console.log('-'.repeat(100));
console.log(`${best.pool.name} (${best.pool.address})`);
console.log(`Base APR:     ${best.pool.apr.toFixed(2)}%`);
console.log(`Net APY:      ${(best.result.netAPY || 0).toFixed(2)}%`);
console.log(`Annual Profit: $${(POSITION_VALUE * (best.result.netAPY || 0) / 100).toFixed(2)}`);
console.log('');

console.log('═'.repeat(100));
console.log('🎯 FINAL RECOMMENDATION');
console.log('═'.repeat(100));
console.log('');

if ((best.result.netAPY || 0) < 5) {
  console.log('⚠️  Even the best pool on Base is unprofitable for this volatility!');
  console.log('');
  console.log('The fundamental problem: 77% volatility needs 15-20% APR minimum.');
  console.log('');
  console.log('OPTIONS:');
  console.log('  1. ✅ ADD FUNDING RATE ARBITRAGE (10-30% additional APY)');
  console.log('  2. ✅ INCREASE POSITION TO $5,000+ (reduces cost % impact)');
  console.log('  3. ✅ CHECK ARBITRUM/OPTIMISM (typically 3-5x higher volume)');
  console.log('  4. ⏸️  WAIT for lower volatility (<50%)');
} else {
  console.log(`✅ Switch to ${best.pool.name} for ${(best.result.netAPY || 0).toFixed(2)}% APY!`);
}
console.log('');










