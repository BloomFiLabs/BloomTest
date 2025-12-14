#!/usr/bin/env npx tsx
/**
 * Find Best Pools on Base Network
 * 
 * Search for ETH/USDC and cbBTC/USDC pools across all fee tiers
 * to find the most profitable options for current volatility
 */

import 'dotenv/config';
import { gql, GraphQLClient } from 'graphql-request';

const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const USDbC_BASE = '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca'; // Bridged USDC
const cbBTC_BASE = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';

const apiKey = process.env.THE_GRAPH_API_KEY;
if (!apiKey) {
  console.error('❌ THE_GRAPH_API_KEY not set in environment');
  process.exit(1);
}

// Base network Uniswap V3 subgraph
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
    feesUSD: string;
    tvlUSD: string;
    volumeUSD: string;
  }>;
}

async function findPools(token0: string, token1: string): Promise<PoolData[]> {
  // Uniswap orders tokens lexicographically
  const [tokenA, tokenB] = token0.toLowerCase() < token1.toLowerCase() 
    ? [token0.toLowerCase(), token1.toLowerCase()]
    : [token1.toLowerCase(), token0.toLowerCase()];

  const query = gql`
    query FindPools($token0: String!, $token1: String!) {
      pools(
        where: {
          token0: $token0
          token1: $token1
        }
        orderBy: totalValueLockedUSD
        orderDirection: desc
        first: 10
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
          first: 1
        ) {
          feesUSD
          tvlUSD
          volumeUSD
        }
      }
    }
  `;

  try {
    const data = await client.request<{ pools: PoolData[] }>(query, {
      token0: tokenA,
      token1: tokenB,
    });
    return data.pools || [];
  } catch (error) {
    console.error(`Error fetching pools for ${token0}/${token1}:`, error);
    return [];
  }
}

function calculateAPR(pool: PoolData): number {
  if (pool.poolDayData.length === 0) return 0;
  
  const dayData = pool.poolDayData[0];
  const dailyFees = Number(dayData.feesUSD);
  const tvl = Number(dayData.tvlUSD);
  
  if (tvl === 0 || !dailyFees) return 0;
  
  const dailyRate = dailyFees / tvl;
  const apr = dailyRate * 365 * 100;
  
  return apr;
}

function formatFeeTier(feeTier: string): string {
  const bps = Number(feeTier) / 10000;
  return `${bps.toFixed(2)}%`;
}

console.log('');
console.log('═'.repeat(100));
console.log('🔍 SEARCHING BASE NETWORK POOLS');
console.log('═'.repeat(100));
console.log('');

async function main() {
  console.log('Searching for pools...\n');

  // Search for ETH/USDC pools
  console.log('📊 ETH/USDC Pools:');
  console.log('-'.repeat(100));
  const ethUsdcPools = await findPools(WETH_BASE, USDC_BASE);
  
  if (ethUsdcPools.length === 0) {
    console.log('  ⚠️  No ETH/USDC pools found');
  } else {
    for (const pool of ethUsdcPools) {
      const apr = calculateAPR(pool);
      const tvl = Number(pool.totalValueLockedUSD);
      const volume = pool.poolDayData.length > 0 ? Number(pool.poolDayData[0].volumeUSD) : 0;
      
      console.log(`\n  Fee Tier: ${formatFeeTier(pool.feeTier).padEnd(8)} | TVL: $${tvl.toLocaleString().padEnd(15)} | APR: ${apr.toFixed(2).padStart(6)}%`);
      console.log(`  Address:  ${pool.id}`);
      console.log(`  24h Vol:  $${volume.toLocaleString()}`);
      console.log(`  Tx Count: ${pool.txCount}`);
    }
  }

  console.log('\n');
  console.log('-'.repeat(100));
  console.log('');

  // Search for ETH/USDbC pools (bridged USDC)
  console.log('📊 ETH/USDbC Pools (Bridged USDC):');
  console.log('-'.repeat(100));
  const ethUSDbCPools = await findPools(WETH_BASE, USDbC_BASE);
  
  if (ethUSDbCPools.length === 0) {
    console.log('  ⚠️  No ETH/USDbC pools found');
  } else {
    for (const pool of ethUSDbCPools) {
      const apr = calculateAPR(pool);
      const tvl = Number(pool.totalValueLockedUSD);
      const volume = pool.poolDayData.length > 0 ? Number(pool.poolDayData[0].volumeUSD) : 0;
      
      console.log(`\n  Fee Tier: ${formatFeeTier(pool.feeTier).padEnd(8)} | TVL: $${tvl.toLocaleString().padEnd(15)} | APR: ${apr.toFixed(2).padStart(6)}%`);
      console.log(`  Address:  ${pool.id}`);
      console.log(`  24h Vol:  $${volume.toLocaleString()}`);
      console.log(`  Tx Count: ${pool.txCount}`);
    }
  }

  console.log('\n');
  console.log('-'.repeat(100));
  console.log('');

  // Search for cbBTC/USDC pools
  console.log('📊 cbBTC/USDC Pools:');
  console.log('-'.repeat(100));
  const cbBtcUsdcPools = await findPools(cbBTC_BASE, USDC_BASE);
  
  if (cbBtcUsdcPools.length === 0) {
    console.log('  ⚠️  No cbBTC/USDC pools found');
  } else {
    for (const pool of cbBtcUsdcPools) {
      const apr = calculateAPR(pool);
      const tvl = Number(pool.totalValueLockedUSD);
      const volume = pool.poolDayData.length > 0 ? Number(pool.poolDayData[0].volumeUSD) : 0;
      
      console.log(`\n  Fee Tier: ${formatFeeTier(pool.feeTier).padEnd(8)} | TVL: $${tvl.toLocaleString().padEnd(15)} | APR: ${apr.toFixed(2).padStart(6)}%`);
      console.log(`  Address:  ${pool.id}`);
      console.log(`  24h Vol:  $${volume.toLocaleString()}`);
      console.log(`  Tx Count: ${pool.txCount}`);
    }
  }

  console.log('\n');
  console.log('═'.repeat(100));
  console.log('💡 RECOMMENDATIONS');
  console.log('═'.repeat(100));
  console.log('');

  // Find best pool for high volatility (77%)
  const allPools = [...ethUsdcPools, ...ethUSDbCPools, ...cbBtcUsdcPools];
  const poolsWithAPR = allPools.map(pool => ({
    ...pool,
    apr: calculateAPR(pool),
    tvl: Number(pool.totalValueLockedUSD),
  })).filter(p => p.apr > 0);

  if (poolsWithAPR.length === 0) {
    console.log('⚠️  No pools with valid APR data found.');
    console.log('');
    console.log('This could mean:');
    console.log('  1. The pools have very low volume');
    console.log('  2. The subgraph data is stale');
    console.log('  3. We need to check other networks (Arbitrum, Optimism)');
    return;
  }

  // Sort by APR
  poolsWithAPR.sort((a, b) => b.apr - a.apr);

  console.log('For 77% volatility, you need 15-20% APR minimum.');
  console.log('');
  console.log('Best pools on Base:');
  console.log('');

  let foundGood = false;
  for (const pool of poolsWithAPR.slice(0, 5)) {
    const rating = pool.apr >= 15 ? '✅ EXCELLENT' : pool.apr >= 10 ? '✨ GOOD' : pool.apr >= 5 ? '⚠️  MARGINAL' : '❌ TOO LOW';
    console.log(`${rating}`);
    console.log(`  ${pool.token0.symbol}/${pool.token1.symbol} ${formatFeeTier(pool.feeTier)}`);
    console.log(`  APR: ${pool.apr.toFixed(2)}% | TVL: $${pool.tvl.toLocaleString()}`);
    console.log(`  Address: ${pool.id}`);
    console.log('');
    
    if (pool.apr >= 10) foundGood = true;
  }

  if (!foundGood) {
    console.log('═'.repeat(100));
    console.log('⚠️  WARNING: No pools with adequate APR found on Base');
    console.log('═'.repeat(100));
    console.log('');
    console.log('Consider:');
    console.log('  1. Checking Arbitrum (typically has 2-3x higher volume)');
    console.log('  2. Checking Optimism');
    console.log('  3. Using funding rate arbitrage (10-30% APY)');
    console.log('  4. Waiting for lower volatility period');
    console.log('');
  }
}

main().catch(console.error);










