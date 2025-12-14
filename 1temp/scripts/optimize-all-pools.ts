import * as dotenv from 'dotenv';
import * as path from 'path';

const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { VolatilePairStrategy, StrategyMode } from '../src/infrastructure/adapters/strategies/VolatilePairStrategy';
import { Portfolio } from '../src/domain/entities/Portfolio';
import { Amount } from '../src/domain/value-objects';

interface PoolConfig {
  name: string;
  token0: string;
  token1: string;
  asset: string;
}

const POOLS: PoolConfig[] = [
  { name: 'ETH/USDC', token0: 'WETH', token1: 'USDC', asset: 'ETH-USDC' },
  { name: 'ETH/USDT', token0: 'WETH', token1: 'USDT', asset: 'ETH-USDT' },
  { name: 'WBTC/USDC', token0: 'WBTC', token1: 'USDC', asset: 'WBTC-USDC' },
  { name: 'WBTC/USDT', token0: 'WBTC', token1: 'USDT', asset: 'WBTC-USDT' },
];

async function optimizeAllPools() {
  console.log('\n🔬 OPTIMIZING ALL POOLS\n');
  console.log('='.repeat(90));
  
  const apiKey = process.env.THE_GRAPH_API_KEY;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  
  for (const pool of POOLS) {
    console.log(`\n📊 ${pool.name}:`);
    console.log('-'.repeat(90));
    
    try {
      const adapter = new UniswapV3Adapter({
        apiKey: apiKey!,
        token0Symbol: pool.token0,
        token1Symbol: pool.token1,
        useUrlAuth: true,
      });
      
      const data = await adapter.fetchHourlyOHLCV(pool.asset, start, end);
      const apr = await adapter.calculateActualAPR(pool.asset, start, end);
      const feeTier = await adapter.fetchPoolFeeTier(pool.asset);
      
      console.log(`   Real APR: ${apr.toFixed(2)}%`);
      console.log(`   Fee Tier: ${(feeTier * 100).toFixed(2)}%`);
      console.log(`   Data Points: ${data.length} hours\n`);
      
      // Test intervals: 1h to 72h
      const intervals = [1, 3, 5, 8, 12, 17, 24, 37, 39, 48, 72];
      
      console.log('   Interval | Time-in-Range | Rebalances |  Fees  | Costs |  Net APY');
      console.log('   ' + '-'.repeat(82));
      
      const results: any[] = [];
      
      for (const interval of intervals) {
        const result = await simulateStrategy(
          data,
          apr,
          feeTier,
          interval,
          0.005, // ±0.5% range
          pool.asset
        );
        
        results.push({ interval, ...result });
        
        const color = result.netReturn > 15 ? '✅' : result.netReturn > 0 ? '🟡' : '❌';
        console.log(
          `   ${color} ${interval.toString().padStart(2)}h    |     ${result.timeInRange.toFixed(1).padStart(4)}%    |     ${result.rebalances.toString().padStart(3)}    | $${result.totalFees.toFixed(0).padStart(4)} | $${result.totalCosts.toFixed(0).padStart(4)} | ${result.netReturn >= 0 ? '+' : ''}${result.netReturn.toFixed(1)}%`
        );
      }
      
      // Find optimal
      const optimal = results.reduce((best, curr) => 
        curr.netReturn > best.netReturn ? curr : best
      );
      
      console.log(`\n   💎 OPTIMAL: ${optimal.interval}h interval → ${optimal.netReturn >= 0 ? '+' : ''}${optimal.netReturn.toFixed(1)}% APY`);
      console.log(`      Time-in-Range: ${optimal.timeInRange.toFixed(1)}%`);
      console.log(`      Rebalances: ${optimal.rebalances}`);
      console.log(`      Net Fees: $${(optimal.totalFees - optimal.totalCosts).toFixed(2)}`);
      
    } catch (error: any) {
      console.log(`   ❌ Error: ${error.message}`);
      if (error.message.includes('not find pool')) {
        console.log(`      Pool may not exist or have insufficient liquidity`);
      }
    }
  }
  
  console.log('\n' + '='.repeat(90));
  console.log('\n💡 Summary:');
  console.log('   - Optimal intervals vary by pool fee tier and volatility');
  console.log('   - Higher fee tiers (0.3%) benefit from less frequent rebalancing');
  console.log('   - Lower fee tiers (0.05%) can rebalance more frequently');
  console.log('   - Sweet spot is typically 12-24h for most pools\n');
}

async function simulateStrategy(
  data: any[],
  apr: number,
  feeTier: number,
  checkInterval: number,
  rangeWidth: number,
  asset: string
) {
  let hoursInRange = 0;
  let hoursOutOfRange = 0;
  let totalFeesEarned = 0;
  let rebalances = 0;
  let totalRebalanceCosts = 0;
  let lastCheckTime = 0;
  let entryPrice: number | null = null;
  
  const positionValue = 25000;
  const fullRangeWidth = 0.05;
  const concentrationMultiplier = Math.pow(fullRangeWidth / rangeWidth, 1.5);
  const efficiencyFactor = 0.65;
  const effectiveMultiplier = concentrationMultiplier * efficiencyFactor;
  
  for (let i = 0; i < data.length; i++) {
    const tick = data[i];
    const hoursSinceLastCheck = i - lastCheckTime;
    const isCheckTime = hoursSinceLastCheck >= checkInterval;
    
    // Initialize or check for rebalance
    if (i === 0) {
      entryPrice = tick.close.value;
      lastCheckTime = i;
    } else if (isCheckTime && entryPrice) {
      const currentPrice = tick.close.value;
      const priceChange = Math.abs((currentPrice - entryPrice) / entryPrice * 100);
      
      // Rebalance if out of range (90% threshold)
      if (priceChange > rangeWidth * 100 * 0.9) {
        rebalances++;
        entryPrice = currentPrice;
        lastCheckTime = i;
        
        const gasCost = 0; // Base network
        const poolFee = positionValue * 0.5 * feeTier;
        totalRebalanceCosts += gasCost + poolFee;
      } else {
        // Just update last check time even if not rebalancing
        lastCheckTime = i;
      }
    }
    
    // Track time-in-range every hour
    if (entryPrice) {
      const currentPrice = tick.close.value;
      const priceChange = Math.abs((currentPrice - entryPrice) / entryPrice * 100);
      const inRange = priceChange <= rangeWidth * 100;
      
      if (inRange) {
        hoursInRange++;
        const hourlyYieldRate = (apr / 100) / (365 * 24);
        const hourlyFee = positionValue * hourlyYieldRate * effectiveMultiplier;
        totalFeesEarned += hourlyFee;
      } else {
        hoursOutOfRange++;
      }
    }
  }
  
  const timeInRange = (hoursInRange / (hoursInRange + hoursOutOfRange)) * 100;
  const netFees = totalFeesEarned - totalRebalanceCosts;
  const annualizedReturn = (netFees / positionValue) * (365 * 24 / data.length) * 100;
  
  return {
    timeInRange,
    rebalances,
    netReturn: annualizedReturn,
    totalFees: totalFeesEarned,
    totalCosts: totalRebalanceCosts,
  };
}

optimizeAllPools().catch(console.error);


