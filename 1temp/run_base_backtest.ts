#!/usr/bin/env node
import 'dotenv/config';
import { RunBacktestUseCase } from './application/use-cases/RunBacktest';
import { UniswapV3Adapter } from './infrastructure/adapters/data/TheGraphDataAdapter';
import { TrendAwareStrategy } from './infrastructure/adapters/strategies';
import { mergeWithDefaults } from './shared/config/StrategyConfigs';

async function main() {
  console.log('🌱 Base Network Backtest - Simple Version\n');

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) throw new Error('THE_GRAPH_API_KEY not set');

  const adapter = new UniswapV3Adapter({ 
    apiKey, 
    token0Symbol: 'WETH', 
    token1Symbol: 'USDC',
    token0Address: '0x4200000000000000000000000000000000000006',
    token1Address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    useUrlAuth: true 
  });

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30); // Last 30 days only

  console.log(`📅 Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`💰 Capital: $10,000\n`);

  console.log('�� Fetching pool data...');
  const apr = await adapter.calculateActualAPR('ETH-USDC', startDate, endDate);
  console.log(`✅ Pool APR: ${apr.toFixed(2)}%\n`);

  console.log('📊 Fetching price data...');
  const ohlcv = await adapter.fetchHourlyOHLCV('ETH-USDC', startDate, endDate);
  console.log(`✅ Got ${ohlcv.length} hourly candles\n`);

  // Simple calculation
  const positionValue = 10000;
  const dailyFeesUSD = (positionValue * (apr / 100)) / 365;
  const gasRebalances = 30; // Estimate 1/day
  const gasCostsTotal = gasRebalances * 0.50; // $0.50/rebalance on Base
  const netProfit = (dailyFeesUSD * 30) - gasCostsTotal;
  const netAPY = (netProfit / positionValue) * (365 / 30) * 100;

  console.log('='.repeat(80));
  console.log('📊 ESTIMATED PERFORMANCE (30 days, $10k position)');
  console.log('='.repeat(80));
  console.log(`Pool APR:           ${apr.toFixed(2)}%`);
  console.log(`Daily Fees:         $${dailyFeesUSD.toFixed(2)}`);
  console.log(`30-Day Fees:        $${(dailyFeesUSD * 30).toFixed(2)}`);
  console.log(`Rebalance Costs:    $${gasCostsTotal.toFixed(2)} (${gasRebalances} rebalances)`);
  console.log(`Net Profit (30d):   $${netProfit.toFixed(2)}`);
  console.log(`Annualized APY:     ${netAPY.toFixed(2)}%`);
  console.log('='.repeat(80));
  
  if (netAPY > 20) {
    console.log('\n🎉 EXCELLENT! Strategy is highly profitable in these conditions.');
  } else if (netAPY > 10) {
    console.log('\n✅ GOOD! Strategy is profitable.');
  } else if (netAPY > 0) {
    console.log('\n🟡 MARGINAL. Strategy barely profitable.');
  } else {
    console.log('\n⚠️  UNPROFITABLE. Need higher volatility or more capital.');
  }
}

main().catch(console.error);
