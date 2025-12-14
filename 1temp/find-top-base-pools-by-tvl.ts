#!/usr/bin/env npx tsx
/**
 * Find Top Pools on Base by TVL
 * 
 * Search for ALL pools with >$10M TVL and calculate their APR
 * to determine if LP strategies are viable on Base
 */

import 'dotenv/config';
import { gql, GraphQLClient } from 'graphql-request';

const apiKey = process.env.THE_GRAPH_API_KEY;
if (!apiKey) {
  console.error('❌ THE_GRAPH_API_KEY not set in environment');
  process.exit(1);
}

const SUBGRAPH_URL = 'https://gateway.thegraph.com/api/subgraphs/id/HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1';

const client = new GraphQLClient(SUBGRAPH_URL, {
  headers: {
    'Authorization': `Bearer ${apiKey}`,
  },
});

interface PoolData {
  id: string;
  token0: {
    symbol: string;
    id: string;
  };
  token1: {
    symbol: string;
    id: string;
  };
  feeTier: string;
  totalValueLockedUSD: string;
  volumeUSD: string;
  txCount: string;
  poolDayData: Array<{
    date: number;
    feesUSD: string;
    tvlUSD: string;
    volumeUSD: string;
  }>;
}

async function findTopPools(minTvl: number): Promise<PoolData[]> {
  const query = gql`
    query FindTopPools {
      pools(
        where: {
          totalValueLockedUSD_gte: "${minTvl}"
        }
        orderBy: totalValueLockedUSD
        orderDirection: desc
        first: 50
      ) {
        id
        token0 {
          symbol
          id
        }
        token1 {
          symbol
          id
        }
        feeTier
        totalValueLockedUSD
        volumeUSD
        txCount
        poolDayData(
          orderBy: date
          orderDirection: desc
          first: 7
        ) {
          date
          feesUSD
          tvlUSD
          volumeUSD
        }
      }
    }
  `;

  try {
    const data = await client.request<{ pools: PoolData[] }>(query);
    return data.pools || [];
  } catch (error) {
    console.error(`Error fetching pools:`, error);
    return [];
  }
}

function calculateAPR(pool: PoolData): { daily: number; weekly: number } {
  if (pool.poolDayData.length === 0) return { daily: 0, weekly: 0 };
  
  // Calculate daily APR (last 24h)
  const lastDayData = pool.poolDayData[0];
  const dailyFees = Number(lastDayData.feesUSD);
  const dailyTvl = Number(lastDayData.tvlUSD);
  const dailyAPR = dailyTvl > 0 ? (dailyFees / dailyTvl) * 365 * 100 : 0;
  
  // Calculate weekly average APR (last 7 days)
  let totalFees = 0;
  let totalTvl = 0;
  let daysCount = 0;
  
  for (const dayData of pool.poolDayData) {
    totalFees += Number(dayData.feesUSD);
    totalTvl += Number(dayData.tvlUSD);
    daysCount++;
  }
  
  const avgDailyFees = totalFees / daysCount;
  const avgTvl = totalTvl / daysCount;
  const weeklyAPR = avgTvl > 0 ? (avgDailyFees / avgTvl) * 365 * 100 : 0;
  
  return { daily: dailyAPR, weekly: weeklyAPR };
}

function formatFeeTier(feeTier: string): string {
  const bps = Number(feeTier) / 10000;
  return `${bps.toFixed(2)}%`;
}

console.log('');
console.log('═'.repeat(120));
console.log('🔍 TOP POOLS ON BASE NETWORK (>$10M TVL)');
console.log('═'.repeat(120));
console.log('');

async function main() {
  const MIN_TVL = 10_000_000; // $10M minimum
  
  console.log(`Searching for pools with >$${(MIN_TVL / 1_000_000).toFixed(0)}M TVL...\n`);
  
  const pools = await findTopPools(MIN_TVL);
  
  if (pools.length === 0) {
    console.log('⚠️  No pools found with >$10M TVL on Base');
    console.log('');
    console.log('This suggests Base has very low liquidity overall.');
    console.log('Consider switching to:');
    console.log('  - Arbitrum (much higher TVL)');
    console.log('  - Optimism');
    console.log('  - Mainnet Ethereum');
    return;
  }

  // Calculate APRs and sort by weekly APR
  const poolsWithAPR = pools.map(pool => ({
    ...pool,
    apr: calculateAPR(pool),
    tvl: Number(pool.totalValueLockedUSD),
    volume24h: pool.poolDayData.length > 0 ? Number(pool.poolDayData[0].volumeUSD) : 0,
  })).sort((a, b) => b.apr.weekly - a.apr.weekly);

  console.log('Rank | Pair                    | Fee   | TVL             | 24h Volume      | Daily APR | Weekly APR | Profitable?');
  console.log('-'.repeat(120));

  for (let i = 0; i < poolsWithAPR.length; i++) {
    const pool = poolsWithAPR[i];
    const pair = `${pool.token0.symbol}/${pool.token1.symbol}`.padEnd(23);
    const feeTier = formatFeeTier(pool.feeTier).padEnd(5);
    const tvlStr = `$${pool.tvl.toLocaleString()}`.padEnd(15);
    const volumeStr = `$${pool.volume24h.toLocaleString()}`.padEnd(15);
    const dailyAPR = pool.apr.daily.toFixed(2).padStart(9) + '%';
    const weeklyAPR = pool.apr.weekly.toFixed(2).padStart(10) + '%';
    
    // Determine profitability (need >15% for 77% vol, >5% for <40% vol)
    let profitability = '❌ Too Low';
    if (pool.apr.weekly > 15) {
      profitability = '✅ EXCELLENT';
    } else if (pool.apr.weekly > 10) {
      profitability = '✨ GOOD';
    } else if (pool.apr.weekly > 5) {
      profitability = '⚠️  MARGINAL';
    }
    
    console.log(
      `${(i + 1).toString().padStart(4)} | ` +
      `${pair} | ` +
      `${feeTier} | ` +
      `${tvlStr} | ` +
      `${volumeStr} | ` +
      `${dailyAPR} | ` +
      `${weeklyAPR} | ` +
      profitability
    );
  }

  console.log('');
  console.log('═'.repeat(120));
  console.log('📊 ANALYSIS');
  console.log('═'.repeat(120));
  console.log('');

  const excellent = poolsWithAPR.filter(p => p.apr.weekly > 15);
  const good = poolsWithAPR.filter(p => p.apr.weekly > 10 && p.apr.weekly <= 15);
  const marginal = poolsWithAPR.filter(p => p.apr.weekly > 5 && p.apr.weekly <= 10);
  const poor = poolsWithAPR.filter(p => p.apr.weekly <= 5);

  console.log(`Total pools analyzed:        ${poolsWithAPR.length}`);
  console.log(`✅ Excellent (>15% APR):     ${excellent.length} pools`);
  console.log(`✨ Good (10-15% APR):        ${good.length} pools`);
  console.log(`⚠️  Marginal (5-10% APR):    ${marginal.length} pools`);
  console.log(`❌ Too Low (<5% APR):        ${poor.length} pools`);
  console.log('');

  if (excellent.length > 0) {
    console.log('🎯 BEST OPPORTUNITIES:');
    console.log('-'.repeat(120));
    for (const pool of excellent.slice(0, 3)) {
      console.log(`\n  ${pool.token0.symbol}/${pool.token1.symbol} (${formatFeeTier(pool.feeTier)})`);
      console.log(`  APR:     ${pool.apr.weekly.toFixed(2)}%`);
      console.log(`  TVL:     $${pool.tvl.toLocaleString()}`);
      console.log(`  Address: ${pool.id}`);
      console.log(`  Volume:  $${pool.volume24h.toLocaleString()}/day`);
    }
    console.log('');
  } else if (good.length > 0) {
    console.log('⚠️  No excellent pools, but some good options:');
    console.log('-'.repeat(120));
    for (const pool of good.slice(0, 3)) {
      console.log(`\n  ${pool.token0.symbol}/${pool.token1.symbol} (${formatFeeTier(pool.feeTier)})`);
      console.log(`  APR:     ${pool.apr.weekly.toFixed(2)}%`);
      console.log(`  TVL:     $${pool.tvl.toLocaleString()}`);
      console.log(`  Address: ${pool.id}`);
    }
    console.log('');
  } else {
    console.log('═'.repeat(120));
    console.log('🚨 CRITICAL FINDING: NO PROFITABLE LP POOLS ON BASE');
    console.log('═'.repeat(120));
    console.log('');
    console.log('All pools with >$10M TVL have APR <10%, which is insufficient for:');
    console.log('  - High volatility markets (need 15-20% APR)');
    console.log('  - Moderate volatility markets (need 10-15% APR)');
    console.log('');
    console.log('🎯 RECOMMENDED ACTIONS:');
    console.log('');
    console.log('1. ✅ SWITCH TO ARBITRUM OR OPTIMISM');
    console.log('   - 3-5x higher trading volume');
    console.log('   - 10-50% APR on major pairs');
    console.log('');
    console.log('2. ✅ ADD FUNDING RATE ARBITRAGE');
    console.log('   - 10-30% APY from perp funding rates');
    console.log('   - Already implemented in your codebase');
    console.log('   - Works on ANY chain');
    console.log('');
    console.log('3. ✅ FOCUS ON PURE DELTA-NEUTRAL STRATEGIES');
    console.log('   - LP fees are just a bonus');
    console.log('   - Main profit from funding rate capture');
    console.log('   - Aave borrow rates + Hyperliquid funding');
    console.log('');
    console.log('4. ⏸️  WAIT FOR BASE ECOSYSTEM TO MATURE');
    console.log('   - More protocols launching');
    console.log('   - Higher trading volume expected');
    console.log('   - Check again in 3-6 months');
    console.log('');
  }

  // Calculate average APR
  const avgAPR = poolsWithAPR.reduce((sum, p) => sum + p.apr.weekly, 0) / poolsWithAPR.length;
  
  console.log('═'.repeat(120));
  console.log('📈 BASE NETWORK STATISTICS');
  console.log('═'.repeat(120));
  console.log('');
  console.log(`Average APR (>$10M pools):   ${avgAPR.toFixed(2)}%`);
  console.log(`Total TVL in analyzed pools: $${poolsWithAPR.reduce((sum, p) => sum + p.tvl, 0).toLocaleString()}`);
  console.log(`Total 24h Volume:            $${poolsWithAPR.reduce((sum, p) => sum + p.volume24h, 0).toLocaleString()}`);
  console.log('');
  
  if (avgAPR < 10) {
    console.log('⚠️  WARNING: Average APR is below profitability threshold');
    console.log('    Base network is currently NOT SUITABLE for LP strategies');
  }
  
  console.log('');
}

main().catch(console.error);










