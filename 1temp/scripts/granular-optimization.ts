import 'dotenv/config';
import { UniswapV3Adapter, HourlyPoolData } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';

/**
 * GRANULAR OPTIMIZATION SCRIPT
 */

const POOLS = [
  { symbol: 'ETH-USDC', token1: 'USDC', fee: 0.0005 },
  { symbol: 'ETH-USDT', token1: 'USDT', fee: 0.003 },
  { symbol: 'WBTC-USDC', token1: 'USDC', fee: 0.003 },
  { symbol: 'WBTC-USDT', token1: 'USDT', fee: 0.003 },
];

const RANGE_WIDTH = 0.005; // ±0.5%
const INITIAL_POSITION = 1_000_000;
const GAS_COST = 0.01;
const INCENTIVE_APR = 15;
const FUNDING_APR = 5;

const INTERVALS = Array.from({ length: 48 }, (_, i) => i + 1);

async function loadData(symbol: string, token1: string) {
  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) throw new Error('API Key needed');

  // Determine token0 symbol (WETH or WBTC)
  let token0 = 'WETH';
  if (symbol.includes('WBTC')) token0 = 'WBTC';

  const adapter = new UniswapV3Adapter({
    apiKey,
    token0Symbol: token0,
    token1Symbol: token1,
    useUrlAuth: true,
  });

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);
  console.log(`Loading data for ${symbol}...`);
  
  try {
    return await adapter.fetchHourlyOHLCV(symbol, startDate, endDate);
  } catch (e) {
    console.warn(`Failed to load ${symbol}:`, e);
    return [];
  }
}

function simulate(data: HourlyPoolData[], interval: number, feeTier: number) {
  let pos = INITIAL_POSITION;
  let rangeCenter = data[0].close.value;
  const multiplier = Math.pow(0.05 / RANGE_WIDTH, 1.5); 

  for (let i = 0; i < data.length; i++) {
    const hour = data[i];
    const price = hour.close.value;
    const lower = rangeCenter * (1 - RANGE_WIDTH);
    const upper = rangeCenter * (1 + RANGE_WIDTH);
    const inRange = price >= lower && price <= upper;

    if (inRange && hour.tvlUSD > 0) {
      const yield_ = (hour.feesUSD / hour.tvlUSD) * multiplier;
      pos += pos * (yield_ + (INCENTIVE_APR + FUNDING_APR)/100/8760);
    } else {
      pos += pos * (FUNDING_APR/100/8760);
    }

    if (i % interval === 0) {
      const drift = Math.abs(price - rangeCenter) / rangeCenter;
      if (drift > (RANGE_WIDTH * 0.9)) {
        const cost = pos * 0.5 * feeTier + GAS_COST;
        pos -= cost;
        rangeCenter = price;
      }
    }
  }
  
  return ((pos / INITIAL_POSITION) ** (8760 / data.length) - 1) * 100;
}

async function main() {
  console.log('🚀 STARTING GRANULAR OPTIMIZATION SWEEP (1h - 48h)\n');
  
  for (const pool of POOLS) {
    const data = await loadData(pool.symbol, pool.token1);
    if (!data.length) continue;

    let best = { interval: 0, apy: -9999 };
    
    for (const interval of INTERVALS) {
      const apy = simulate(data, interval, pool.fee);
      if (apy > best.apy) best = { interval, apy };
    }

    console.log(`\n🎯 RESULTS FOR ${pool.symbol} (Fee: ${(pool.fee*100).toFixed(2)}%)`);
    console.log(`   🏆 Optimal Interval : Every ${best.interval} Hours`);
    console.log(`   💰 Projected APY    : ${best.apy.toFixed(2)}%`);
    
    if (best.interval <= 4) console.log(`   �� Bot Strategy     : SPEED (Active)`);
    else console.log(`   🛡️ Bot Strategy     : TANK (Lazy)`);
  }
}

main();
