#!/usr/bin/env node
import 'dotenv/config';
import axios from 'axios';

const QUERY_BASE_POOLS = `
  query GetBasePools {
    pools(
      first: 50
      orderBy: volumeUSD
      orderDirection: desc
      where: { totalValueLockedUSD_gt: 100000 }
    ) {
      id
      feeTier
      totalValueLockedUSD
      volumeUSD
      feesUSD
      token0 { symbol }
      token1 { symbol }
    }
  }
`;

async function main() {
  const apiKey = process.env.THE_GRAPH_API_KEY || process.env.GRAPH_API_KEY;
  const url = 'https://gateway.thegraph.com/api/subgraphs/id/HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1';

  console.log('🕵️  Scanning BASE Network for High Yield Pools...');
  
  try {
    const response = await axios.post(
      url,
      { query: QUERY_BASE_POOLS },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 60000 }
    );

    const pools = response.data.data.pools;
    
    console.log(`Found ${pools.length} pools. Calculating approx APR (Fees/TVL)...`);
    console.log('Note: This is LIFETIME APR approximation (Fees / TVL). It favors older pools.');
    console.log('-'.repeat(80));
    console.log(`${'Pool'.padEnd(30)} | ${'TVL'.padEnd(10)} | ${'Fee Tier'.padEnd(10)} | ${'Est. APR'.padEnd(10)}`);
    console.log('-'.repeat(80));

    const results = pools.map((p: any) => {
      const tvl = parseFloat(p.totalValueLockedUSD);
      const fees = parseFloat(p.feesUSD);
      // Very rough lifetime APR estimation since we can't get day data easily without timeout
      // A better metric is Volume/TVL * FeeTier * 365? No, that assumes daily volume.
      // Let's just sort by Volume/TVL ratio (Capital Efficiency)
      const volume = parseFloat(p.volumeUSD);
      const efficiency = volume / tvl;
      
      return {
        name: `${p.token0.symbol}/${p.token1.symbol}`,
        tvl,
        fee: p.feeTier / 10000,
        efficiency
      };
    });

    // Sort by Capital Efficiency (Volume / TVL)
    results.sort((a: any, b: any) => b.efficiency - a.efficiency);

    for (const res of results.slice(0, 15)) {
      // Approx Daily Volume = Volume / (Age of pool? Unknown). 
      // Let's assume daily volume is ~1% of total volume? No, that's a guess.
      // Instead, let's just rank them. High Vol/TVL usually means High APR.
      console.log(
        `${res.name.padEnd(30)} | ` +
        `$${(res.tvl/1000).toFixed(0)}k`.padEnd(10) + ' | ' +
        `${res.fee.toFixed(2)}%`.padEnd(10) + ' | ' +
        `${res.efficiency.toFixed(1)}x Turnover`
      );
    }

  } catch (e) {
    console.error(e.message);
  }
}

main();










