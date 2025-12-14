import * as dotenv from 'dotenv';
import * as path from 'path';

const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { VolatilePairStrategy, StrategyMode } from '../src/infrastructure/adapters/strategies/VolatilePairStrategy';
import { Portfolio } from '../src/domain/entities/Portfolio';
import { Amount } from '../src/domain/value-objects';

async function optimizeRangeWidth() {
  console.log('\n🔬 OPTIMIZING RANGE WIDTH vs TIME-IN-RANGE\n');
  console.log('='.repeat(80));
  
  const apiKey = process.env.THE_GRAPH_API_KEY;
  const ethUsdcAdapter = new UniswapV3Adapter({
    apiKey: apiKey!,
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    useUrlAuth: true,
  });

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  
  const ethUsdcData = await ethUsdcAdapter.fetchHourlyOHLCV('ETH-USDC', start, end);
  const ethUsdcAPR = await ethUsdcAdapter.calculateActualAPR('ETH-USDC', start, end);
  const ethUsdcFeeTier = await ethUsdcAdapter.fetchPoolFeeTier('ETH-USDC');
  
  console.log(`\n📊 ETH/USDC Pool:`);
  console.log(`   APR: ${ethUsdcAPR.toFixed(2)}%`);
  console.log(`   Fee Tier: ${(ethUsdcFeeTier * 100).toFixed(2)}%`);
  console.log(`   Data Points: ${ethUsdcData.length} hours\n`);
  
  // Test different range widths
  const rangeWidths = [0.005, 0.01, 0.02, 0.03, 0.05, 0.10]; // 0.5%, 1%, 2%, 3%, 5%, 10%
  const checkIntervals = [5, 12, 24]; // Test a few intervals
  
  console.log('Range Width | Interval | Time-in-Range | Rebalances | Net APY | Fees | Costs');
  console.log('-'.repeat(80));
  
  for (const rangeWidth of rangeWidths) {
    for (const interval of checkIntervals) {
      const result = await simulateStrategy(
        ethUsdcData,
        ethUsdcAPR,
        ethUsdcFeeTier,
        interval,
        rangeWidth
      );
      
      console.log(
        `   ±${(rangeWidth * 100).toFixed(1)}%    |   ${interval}h   |     ${result.timeInRange.toFixed(1)}%     |     ${result.rebalances}    | ${result.netReturn >= 0 ? '+' : ''}${result.netReturn.toFixed(1)}% | $${result.totalFees.toFixed(0)} | $${result.totalCosts.toFixed(0)}`
      );
    }
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('\n💡 Key Insights:');
  console.log('   - Narrower ranges = Higher concentration multiplier but lower time-in-range');
  console.log('   - Wider ranges = Lower concentration multiplier but higher time-in-range');
  console.log('   - Need to find the sweet spot where (multiplier × time-in-range) is maximized');
  console.log('   - Rebalance costs increase with frequency, reducing net returns\n');
}

async function simulateStrategy(
  data: any[],
  apr: number,
  feeTier: number,
  checkInterval: number,
  rangeWidth: number
) {
  const strategy = new VolatilePairStrategy('test', 'Test');
  const portfolio = Portfolio.create({
    id: 'test',
    initialCapital: Amount.create(100000)
  });
  
  let hoursInRange = 0;
  let hoursOutOfRange = 0;
  let totalFeesEarned = 0;
  let rebalances = 0;
  let totalRebalanceCosts = 0;
  let lastCheckTime = 0;
  let entryPrice: number | null = null;
  
  const positionValue = 25000;
  const fullRangeWidth = 0.05; // Assume full range is ±5%
  const concentrationMultiplier = Math.pow(fullRangeWidth / rangeWidth, 1.5);
  const efficiencyFactor = 0.65;
  const effectiveMultiplier = concentrationMultiplier * efficiencyFactor;
  
  for (let i = 0; i < data.length; i++) {
    const tick = data[i];
    const hoursSinceLastCheck = i - lastCheckTime;
    const isCheckTime = hoursSinceLastCheck >= checkInterval;
    
    // Initialize or rebalance
    if (i === 0) {
      entryPrice = tick.close.value;
      lastCheckTime = i;
    } else if (isCheckTime && entryPrice) {
      const currentPrice = tick.close.value;
      const priceChange = Math.abs((currentPrice - entryPrice) / entryPrice * 100);
      
      // Rebalance if out of range
      if (priceChange > rangeWidth * 100 * 0.9) {
        rebalances++;
        entryPrice = currentPrice;
        lastCheckTime = i;
        
        const gasCost = 0;
        const poolFee = positionValue * 0.5 * feeTier;
        totalRebalanceCosts += gasCost + poolFee;
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

optimizeRangeWidth().catch(console.error);


