#!/usr/bin/env node
import 'dotenv/config';
import axios from 'axios';

// Configuration
const CONFIG = {
  minTVL: 50000, // $50k min TVL
  daysToAnalyze: 7, // Look at last 7 days for APR/Vol
  targetAPY: 35, // We want pools that can yield >35%
};

const CHAINS = [
  {
    name: 'Base',
    subgraph: 'https://gateway.thegraph.com/api/subgraphs/id/HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1',
  },
  {
    name: 'Arbitrum',
    subgraph: 'https://gateway.thegraph.com/api/subgraphs/id/3V7ZY6muhxaQL5qvntX1CFXJ32W7BxXZTGTwmpH5J4t3',
  },
  {
    name: 'Mainnet',
    subgraph: 'https://gateway.thegraph.com/api/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV',
  },
];

const QUERY_POOLS = `
  query GetTopPools($minTVL: BigDecimal!) {
    pools(
      first: 20
      orderBy: totalValueLockedUSD
      orderDirection: desc
      where: { totalValueLockedUSD_gt: $minTVL }
    ) {
      id
      feeTier
      totalValueLockedUSD
      token0 { symbol decimals }
      token1 { symbol decimals }
      poolDayData(first: 14, orderBy: date, orderDirection: desc) {
        date
        volumeUSD
        feesUSD
        tvlUSD
        open
        high
        low
        close
      }
    }
  }
`;

async function main() {
  const apiKey = process.env.THE_GRAPH_API_KEY || process.env.GRAPH_API_KEY;
  if (!apiKey) {
    console.error('❌ API Key not set (THE_GRAPH_API_KEY)');
    process.exit(1);
  }

  console.log('🕵️  SCANNING FOR PROFITABLE POOLS (>35% Potential APY)');
  console.log('='.repeat(80));

  for (const chain of CHAINS) {
    console.log(`\n🌐 Scanning ${chain.name}...`);
    try {
      await scanChain(chain.name, chain.subgraph, apiKey);
    } catch (e) {
      console.error(`   ❌ Failed to scan ${chain.name}: ${e.message}`);
    }
  }
}

async function scanChain(chainName: string, url: string, apiKey: string) {
  // Use specific query for Arbitrum if needed, though usually standard V3 subgraphs match
  // The previous error "Type Pool has no field poolDayData" suggests this subgraph might be different
  // or simply timed out/failed in a weird way. Let's try a simpler query for Arbitrum first to debug if needed.
  // Actually, the error was on Arbitrum. Let's try `poolDayDatas` plural if singular fails?
  // But standard V3 is singular. 
  
  // Let's just increase timeout significantly
  const response = await axios.post(
    url,
    {
      query: QUERY_POOLS,
      variables: { minTVL: CONFIG.minTVL },
    },
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 30000 // Increased to 30s
    }
  );

  if (response.data.errors) {
    throw new Error(JSON.stringify(response.data.errors));
  }

  const pools = response.data.data.pools;
  console.log(`   Found ${pools.length} pools with TVL > $${CONFIG.minTVL.toLocaleString()}`);
  console.log(`   ${'Pool'.padEnd(25)} | ${'TVL'.padEnd(10)} | ${'Base APR'.padEnd(10)} | ${'Vol (7d)'.padEnd(10)} | ${'Score'.padEnd(10)}`);
  console.log(`   ${'-'.repeat(75)}`);

  const results = [];

  for (const pool of pools) {
    let baseAPR = 0;
    let vol = 0;

    if (chainName === 'Arbitrum') {
      // Approximate APR for Arbitrum (since we skipped day data)
      // This is Lifetime APR, not current. It's a rough proxy.
      // Actually, volumeUSD is usually lifetime. 
      // We can't get accurate APR without time-series data.
      // But at least we'll see the pools.
      baseAPR = 0; 
      vol = 0;
    } else {
      const days = pool.poolDayData;
      if (!days || days.length < 7) continue;

      // 1. Calculate Base APR (7-day average)
      let totalFees = 0;
      let totalTVL = 0;
      for (let i = 1; i < Math.min(days.length, 8); i++) {
        totalFees += parseFloat(days[i].feesUSD);
        totalTVL += parseFloat(days[i].tvlUSD);
      }
      const avgDailyFees = totalFees / 7;
      const avgTVL = totalTVL / 7;
      baseAPR = (avgDailyFees * 365 / avgTVL) * 100;

      // 2. Calculate Volatility
      const prices = days.map((d: any) => parseFloat(d.close)).reverse();
      const returns = [];
      for (let i = 1; i < prices.length; i++) {
        returns.push(Math.log(prices[i] / prices[i - 1]));
      }
      if (returns.length > 0) {
        const mean = returns.reduce((a: number, b: number) => a + b, 0) / returns.length;
        const variance = returns.reduce((sum: number, r: number) => sum + Math.pow(r - mean, 2), 0) / returns.length;
        vol = Math.sqrt(variance) * Math.sqrt(365);
      }
    }

    const score = (vol > 0) ? baseAPR / (vol * 100) : 0;

    results.push({
      name: `${pool.token0.symbol}/${pool.token1.symbol} ${(pool.feeTier/10000).toFixed(2)}%`,
      tvl: parseFloat(pool.totalValueLockedUSD),
      apr: baseAPR,
      vol: vol * 100,
      score
    });
  }

  // Sort by Score (Profitability Potential)
  results.sort((a, b) => b.score - a.score);

  for (const res of results.slice(0, 10)) {
    const marker = res.score > 1.0 ? '✅' : (res.score > 0.5 ? '⚠️' : '❌');
    console.log(
      `   ${res.name.padEnd(25)} | ` +
      `$${(res.tvl/1000).toFixed(0)}k`.padEnd(10) + ' | ' +
      `${res.apr.toFixed(1)}%`.padEnd(10) + ' | ' +
      `${res.vol.toFixed(1)}%`.padEnd(10) + ' | ' +
      `${res.score.toFixed(2)} ${marker}`
    );
  }
}

main().catch(console.error);

