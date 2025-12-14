import 'dotenv/config';
import { UniswapV3Adapter, HourlyPoolData } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';

/**
 * Optimization script to find the best "Check Interval" (Rebalance Frequency)
 */

// Constants
const RANGE_WIDTH = 0.005; // ±0.5%
const INITIAL_POSITION = 1_000_000;
const GAS_COST = 0.01; // Negligible on L2
const INCENTIVE_APR = 15;
const FUNDING_APR = 5;

// Test Candidates
const INTERVALS_TO_TEST = [1, 2, 4, 6, 8, 12, 24, 48, 72];

interface SimResult {
  intervalHours: number;
  rebalances: number;
  cost: number;
  timeInRangePct: number;
  netAPY: number;
  finalValue: number;
}

async function loadData(symbol: string, token1: string) {
  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) throw new Error('API Key needed');

  const adapter = new UniswapV3Adapter({
    apiKey,
    token0Symbol: 'WETH',
    token1Symbol: token1,
    useUrlAuth: true,
  });

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);
  console.log(`Loading 1 year of hourly data for ${symbol}...`);
  return await adapter.fetchHourlyOHLCV(symbol, startDate, endDate);
}

function runSimulation(data: HourlyPoolData[], checkIntervalHours: number, poolFeeTier: number): SimResult {
  let positionValue = INITIAL_POSITION;
  let totalRebalances = 0;
  let totalSwapFeesPaid = 0;
  let hoursInRange = 0;

  let rangeCenter = data[0].close.value;
  let lower = rangeCenter * (1 - RANGE_WIDTH);
  let upper = rangeCenter * (1 + RANGE_WIDTH);

  const feeDensityMultiplier = Math.pow(0.05 / RANGE_WIDTH, 1.5); 

  for (let i = 0; i < data.length; i++) {
    const hour = data[i];
    const price = hour.close.value;

    const inRange = price >= lower && price <= upper;
    if (inRange) hoursInRange++;

    if (inRange && hour.tvlUSD > 0) {
      const baseYield = hour.feesUSD / hour.tvlUSD;
      const feeEarnings = positionValue * baseYield * feeDensityMultiplier;
      const incentives = positionValue * ((INCENTIVE_APR + FUNDING_APR) / 100 / 365 / 24);
      positionValue += (feeEarnings + incentives);
    } else {
      positionValue += positionValue * (FUNDING_APR / 100 / 365 / 24);
    }

    if (i % checkIntervalHours === 0) {
      const drift = Math.abs(price - rangeCenter) / rangeCenter;
      
      if (drift > (RANGE_WIDTH * 0.9)) {
        totalRebalances++;
        
        const cost = positionValue * 0.5 * poolFeeTier + GAS_COST;
        totalSwapFeesPaid += cost;
        positionValue -= cost;

        rangeCenter = price;
        lower = rangeCenter * (1 - RANGE_WIDTH);
        upper = rangeCenter * (1 + RANGE_WIDTH);
      }
    }
  }

  const netAPY = ((positionValue / INITIAL_POSITION) ** (8760 / data.length) - 1) * 100;

  return {
    intervalHours: checkIntervalHours,
    rebalances: totalRebalances,
    cost: totalSwapFeesPaid,
    timeInRangePct: (hoursInRange / data.length) * 100,
    netAPY,
    finalValue: positionValue
  };
}

async function main() {
  try {
    const usdtData = await loadData('ETH-USDT', 'USDT');
    console.log('\n--- OPTIMIZATION: ETH/USDT (0.3% Fee Tier) ---');
    console.log('Interval | Rebalances | TimeInRange | Costs ($) | Net APY');
    console.log('---------------------------------------------------------');
    
    let bestUSDT = { apy: -999, interval: 0 };

    for (const interval of INTERVALS_TO_TEST) {
      const res = runSimulation(usdtData, interval, 0.003); 
      console.log(
        `${res.intervalHours}h`.padEnd(9) + 
        `| ${res.rebalances.toString().padEnd(10)} ` +
        `| ${res.timeInRangePct.toFixed(1)}%`.padEnd(12) +
        `| $${(res.cost/1000).toFixed(1)}k`.padEnd(10) +
        `| ${res.netAPY.toFixed(2)}%`
      );
      if (res.netAPY > bestUSDT.apy) bestUSDT = { apy: res.netAPY, interval: res.intervalHours };
    }
    console.log(`\n🏆 OPTIMAL CHECK WINDOW for ETH/USDT: Every ${bestUSDT.interval} Hours`);

    const usdcData = await loadData('ETH-USDC', 'USDC');
    console.log('\n\n--- OPTIMIZATION: ETH/USDC (0.05% Fee Tier) ---');
    console.log('Interval | Rebalances | TimeInRange | Costs ($) | Net APY');
    console.log('---------------------------------------------------------');

    let bestUSDC = { apy: -999, interval: 0 };

    for (const interval of INTERVALS_TO_TEST) {
      const res = runSimulation(usdcData, interval, 0.0005); 
      console.log(
        `${res.intervalHours}h`.padEnd(9) + 
        `| ${res.rebalances.toString().padEnd(10)} ` +
        `| ${res.timeInRangePct.toFixed(1)}%`.padEnd(12) +
        `| $${(res.cost/1000).toFixed(1)}k`.padEnd(10) +
        `| ${res.netAPY.toFixed(2)}%`
      );
      if (res.netAPY > bestUSDC.apy) bestUSDC = { apy: res.netAPY, interval: res.intervalHours };
    }
    console.log(`\n🏆 OPTIMAL CHECK WINDOW for ETH/USDC: Every ${bestUSDC.interval} Hours`);

  } catch (e) {
    console.error(e);
  }
}

main();
