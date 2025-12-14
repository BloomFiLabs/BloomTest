#!/usr/bin/env node
import 'dotenv/config';
import axios from 'axios';
import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

const GRAPH_URL = 'https://gateway.thegraph.com/api/subgraphs/id/HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1';

// Candidates to check
const CANDIDATES = [
  { symbol0: 'WETH', symbol1: 'wstETH', fee: 100, name: 'WETH/wstETH 0.01%' },
  { symbol0: 'WETH', symbol1: 'DEGEN', fee: 3000, name: 'WETH/DEGEN 0.3%' },
  { symbol0: 'WETH', symbol1: 'USDbC', fee: 500, name: 'WETH/USDbC 0.05%' }
];

async function main() {
  const apiKey = process.env.THE_GRAPH_API_KEY || process.env.GRAPH_API_KEY;
  console.log('🔬 PROFITABILITY CHECK: Net APY after Rebalancing Costs');
  console.log('='.repeat(80));

  for (const cand of CANDIDATES) {
    await analyzePool(cand, apiKey);
  }
}

async function analyzePool(cand: any, apiKey: string) {
  console.log(`\n📊 Analyzing ${cand.name}...`);

  // 1. Find Pool ID
  const queryId = `
    query {
      pools(
        where: { 
          token0_: { symbol: "${cand.symbol0}" }, 
          token1_: { symbol: "${cand.symbol1}" },
          feeTier: ${cand.fee}
        }
        orderBy: totalValueLockedUSD
        orderDirection: desc
        first: 1
      ) {
        id
        poolDayData(first: 30, orderBy: date, orderDirection: desc) {
          date
          feesUSD
          tvlUSD
          close
        }
      }
    }
  `;

  try {
    const res = await axios.post(
      GRAPH_URL,
      { query: queryId },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 30000 }
    );

    const pools = res.data.data.pools;
    if (!pools.length) {
      console.log(`   ❌ Pool not found.`);
      return;
    }
    
    const pool = pools[0];
    const days = pool.poolDayData;
    if (days.length < 10) {
      console.log(`   ⚠️  Not enough history (${days.length} days).`);
      return;
    }

    // 2. Calculate Realized APR (30d Avg)
    let totalFees = 0;
    let totalTVL = 0;
    for (const d of days) {
      totalFees += parseFloat(d.feesUSD);
      totalTVL += parseFloat(d.tvlUSD);
    }
    const avgTVL = totalTVL / days.length;
    // Avoid division by zero
    if (avgTVL === 0) {
       console.log(`   ❌ Zero TVL.`);
       return;
    }
    const apr = ((totalFees / days.length) * 365 / avgTVL) * 100;

    // 3. Calculate Volatility (30d Annualized)
    const prices = days.map((d: any) => parseFloat(d.close)).reverse();
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(Math.log(prices[i] / prices[i-1]));
    }
    
    const mean = returns.reduce((a:any, b:any) => a+b, 0) / returns.length;
    const variance = returns.reduce((s:any, r:any) => s + Math.pow(r-mean, 2), 0) / returns.length;
    const vol = Math.sqrt(variance) * Math.sqrt(365); // Annualized

    console.log(`   TVL: $${(avgTVL/1000).toFixed(0)}k`);
    console.log(`   APR: ${apr.toFixed(1)}%`);
    console.log(`   Vol: ${(vol*100).toFixed(1)}%`);

    // 4. Run Optimizer
    const costModel = {
      gasCostPerRebalance: 0.50,
      poolFeeTier: cand.fee / 1000000, // 100 -> 0.0001? No. 500 is 0.05%. 
      // Uniswap feeTier 500 = 500/1,000,000 = 0.0005.
      // So divide by 1,000,000.
      // Wait, 500 = 0.05%. 500 / 10000 = 0.05. 500 / 1,000,000 = 0.0005. Correct.
      positionValueUSD: 10000
    };
    
    // Fix fee tier calculation
    costModel.poolFeeTier = cand.fee / 1000000;

    const range = RangeOptimizer.findOptimalRange(
      35, apr, 0, 0, vol, 0.01, 0.40, costModel
    );

    console.log(`   ----------------------------------`);
    console.log(`   🏆 Best Strategy:`);
    console.log(`      Range: ${(range.optimalRangeWidth*100).toFixed(1)}%`);
    console.log(`      Net APY: ${range.netAPY?.toFixed(2)}%`);
    console.log(`      Rebal/Yr: ${range.rebalanceFrequency.toFixed(1)}`);
    
    if ((range.netAPY || 0) > 35) {
        console.log(`   ✅ MEETS TARGET (>35%)`);
    } else {
        console.log(`   ❌ MISSES TARGET`);
    }

  } catch (e) {
    console.error(`   Error: ${e.message}`);
  }
}

main();
