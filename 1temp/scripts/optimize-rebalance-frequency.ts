import * as dotenv from 'dotenv';
import * as path from 'path';

const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { VolatilePairStrategy, StrategyMode } from '../src/infrastructure/adapters/strategies/VolatilePairStrategy';
import { Portfolio } from '../src/domain/entities/Portfolio';
import { Amount } from '../src/domain/value-objects';

async function optimizeFrequency() {
  console.log('\n🔬 OPTIMIZING REBALANCE FREQUENCY\n');
  console.log('='.repeat(70));
  
  const apiKey = process.env.THE_GRAPH_API_KEY;
  const ethUsdcAdapter = new UniswapV3Adapter({
    apiKey: apiKey!,
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    useUrlAuth: true,
  });
  
  const ethUsdtAdapter = new UniswapV3Adapter({
    apiKey: apiKey!,
    token0Symbol: 'WETH',
    token1Symbol: 'USDT',
    useUrlAuth: true,
  });

  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  
  const ethUsdcData = await ethUsdcAdapter.fetchHourlyOHLCV('ETH-USDC', start, end);
  const ethUsdtData = await ethUsdtAdapter.fetchHourlyOHLCV('ETH-USDT', start, end);
  
  const ethUsdcAPR = await ethUsdcAdapter.calculateActualAPR('ETH-USDC', start, end);
  const ethUsdtAPR = await ethUsdtAdapter.calculateActualAPR('ETH-USDT', start, end);
  
  const ethUsdcFeeTier = await ethUsdcAdapter.fetchPoolFeeTier('ETH-USDC');
  const ethUsdtFeeTier = await ethUsdtAdapter.fetchPoolFeeTier('ETH-USDT');
  
  console.log(`\n📊 Pool Data:`);
  console.log(`   ETH/USDC: ${ethUsdcAPR.toFixed(2)}% APR, ${(ethUsdcFeeTier * 100).toFixed(2)}% fee`);
  console.log(`   ETH/USDT: ${ethUsdtAPR.toFixed(2)}% APR, ${(ethUsdtFeeTier * 100).toFixed(2)}% fee`);
  
  // Test different rebalance intervals
  const intervals = [1, 2, 3, 5, 8, 12, 24, 39, 72]; // hours
  
  console.log(`\n🧪 Testing ETH/USDC (0.05% fee tier):\n`);
  
  for (const interval of intervals) {
    const result = await simulateStrategy(
      ethUsdcData,
      ethUsdcAPR,
      ethUsdcFeeTier,
      interval,
      0.005, // rangeWidth
      'ETH-USDC'
    );
    
    console.log(`   ${interval}h: ${result.timeInRange.toFixed(1)}% in range, ${result.rebalances} rebalances, ${result.netReturn.toFixed(2)}% return`);
  }
  
  console.log(`\n🧪 Testing ETH/USDT (0.30% fee tier):\n`);
  
  for (const interval of intervals) {
    const result = await simulateStrategy(
      ethUsdtData,
      ethUsdtAPR,
      ethUsdtFeeTier,
      interval,
      0.005, // rangeWidth
      'ETH-USDT'
    );
    
    console.log(`   ${interval}h: ${result.timeInRange.toFixed(1)}% in range, ${result.rebalances} rebalances, ${result.netReturn.toFixed(2)}% return`);
  }
  
  console.log('\n' + '='.repeat(70));
}

async function simulateStrategy(
  data: any[],
  apr: number,
  feeTier: number,
  checkInterval: number,
  rangeWidth: number,
  asset: string
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
  
  const positionValue = 25000; // 25% allocation
  const concentrationMultiplier = Math.pow(0.05 / rangeWidth, 1.5);
  const efficiencyFactor = 0.65;
  const effectiveMultiplier = concentrationMultiplier * efficiencyFactor;
  
  for (let i = 0; i < data.length; i++) {
    const tick = data[i];
    const hoursSinceLastCheck = i - lastCheckTime;
    
    const marketData = {
      timestamp: tick.timestamp,
      price: tick.close,
      volume: tick.volume,
    };
    
    // Only check/rebalance at interval
    const isCheckTime = hoursSinceLastCheck >= checkInterval;
    
    if (i === 0 || isCheckTime) {
      const result = await strategy.execute(portfolio, marketData, {
        pair: asset,
        mode: StrategyMode.SPEED,
        checkIntervalHours: checkInterval,
        rangeWidth,
        allocation: 0.25,
        ammFeeAPR: apr,
        incentiveAPR: 0,
        fundingAPR: 0,
      });
      
      if (result.positions.length > 0) {
        const existing = portfolio.getPosition(result.positions[0].id);
        if (!existing) {
          portfolio.addPosition(result.positions[0]);
        } else {
          portfolio.updatePosition(result.positions[0]);
        }
        
        if (result.shouldRebalance && i > 0) {
          rebalances++;
          const gasCost = 0; // Base network
          const poolFee = positionValue * 0.5 * feeTier;
          totalRebalanceCosts += gasCost + poolFee;
        }
      }
      
      lastCheckTime = i;
    }
    
    // Check if in range every hour (for tracking)
    const pos = portfolio.positions[0];
    if (pos) {
      const entryPrice = pos.entryPrice.value;
      const currentPrice = tick.close.value;
      const priceChange = Math.abs((currentPrice - entryPrice) / entryPrice * 100);
      const inRange = priceChange <= (rangeWidth * 100);
      
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

optimizeFrequency().catch(console.error);


