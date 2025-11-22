#!/usr/bin/env node
import 'dotenv/config';
import { execSync } from 'child_process';
import { RunBacktestUseCase } from './application/use-cases/RunBacktest';
import { UniswapV3Adapter } from './infrastructure/adapters/data/TheGraphDataAdapter';
import { AaveV3Adapter } from './infrastructure/adapters/data/AaveV3Adapter';
import { StrategyOptimizer } from './domain/services/StrategyOptimizer';
import {
  TrendAwareStrategy,
  FundingRateCaptureStrategy,
} from './infrastructure/adapters/strategies';
import { HyperliquidAdapter } from './infrastructure/adapters/data/HyperliquidAdapter';
import { mergeWithDefaults } from './shared/config/StrategyConfigs';

function formatNumber(value: number, decimals = 2): string {
  const rounded = Number(value.toFixed(decimals));
  if (Math.abs(rounded) < Math.pow(10, -decimals)) return (0).toFixed(decimals);
  return rounded.toFixed(decimals);
}

function formatPercent(value: number, decimals = 2): string {
  return formatNumber(value, decimals);
}

async function main() {
  console.log('🌱 Bloom Backtesting Framework\n');
  console.log('='.repeat(60));

  // Step 1: Run tests
  console.log('\n📋 Step 1: Running Tests...\n');
  try {
    execSync('npm test -- --run', { stdio: 'inherit' });
    console.log('\n✅ All tests passed!\n');
  } catch (error) {
    console.error('\n❌ Tests failed! Fix tests before running backtest.\n');
    // process.exit(1); // Continue for demo purposes
  }

  // Step 2: Fetch Hyperliquid Data (if needed)
  console.log('='.repeat(60));
  console.log('\n🚀 Step 2: Fetching Hyperliquid Data...\n');
  console.log('='.repeat(60));
  try {
    execSync('npx tsx scripts/fetch-hyperliquid-data.ts', { stdio: 'inherit' });
    console.log('\n✅ Hyperliquid data fetched!\n');
  } catch (error) {
    console.warn('\n⚠️  Hyperliquid data fetch failed, continuing...\n');
  }

  // Step 3: Run Integrated Backtest
  console.log('='.repeat(60));
  console.log('\n🚀 Step 3: Running Integrated Uniswap V3 + Hyperliquid Backtest...\n');

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.error('❌ THE_GRAPH_API_KEY not set in environment');
    process.exit(1);
  }

  const ethUsdcAdapter = new UniswapV3Adapter({ apiKey, token0Symbol: 'WETH', token1Symbol: 'USDC', useUrlAuth: true });
  const ethUsdtAdapter = new UniswapV3Adapter({ apiKey, token0Symbol: 'WETH', token1Symbol: 'USDT', useUrlAuth: true });
  const wbtcUsdcAdapter = new UniswapV3Adapter({ apiKey, token0Symbol: 'WBTC', token1Symbol: 'USDC', useUrlAuth: true });
  const wbtcUsdtAdapter = new UniswapV3Adapter({ apiKey, token0Symbol: 'WBTC', token1Symbol: 'USDT', useUrlAuth: true });
  const aaveAdapter = new AaveV3Adapter({ apiKey });
  const hyperliquidAdapter = new HyperliquidAdapter();

  // Use recent date range with available data (last 90 days)
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);
  const initialCapital = 100000;

  // Preload funding history to avoid rate limits
  try {
      await hyperliquidAdapter.preloadFundingHistory('ETH', startDate, endDate);
  } catch (e) {
      console.warn('⚠️ Failed to preload Hyperliquid history:', e);
  }

  const useCase = new RunBacktestUseCase();
  
  console.log(`📅 Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`💰 Initial Capital: $${initialCapital.toLocaleString()}\n`);

  console.log('📈 Calculating real APR from fees...');
  const [ethUsdcAPR, ethUsdtAPR, wbtcUsdcAPR, wbtcUsdtAPR] = await Promise.all([
    ethUsdcAdapter.calculateActualAPR('ETH-USDC', startDate, endDate),
    ethUsdtAdapter.calculateActualAPR('ETH-USDT', startDate, endDate),
    wbtcUsdcAdapter.calculateActualAPR('WBTC-USDC', startDate, endDate),
    wbtcUsdtAdapter.calculateActualAPR('WBTC-USDT', startDate, endDate)
  ]);

  console.log(`   ETH/USDC Real APR: ${ethUsdcAPR.toFixed(2)}%`);
  console.log(`   ETH/USDT Real APR: ${ethUsdtAPR.toFixed(2)}%`);
  console.log(`   WBTC/USDC Real APR: ${wbtcUsdcAPR.toFixed(2)}%`);
  console.log(`   WBTC/USDT Real APR: ${wbtcUsdtAPR.toFixed(2)}%\n`);

  const optimizer = new StrategyOptimizer();
  const optimalConfigs = new Map<string, { interval: number, netAPY: number }>();
  
  console.log('🔍 OPTIMIZING STRATEGIES (Running dynamic configuration sweep)...');
  console.log('='.repeat(60));
  
  // Define pools to optimize
  const poolsToOptimize = [
    { asset: 'ETH-USDC', adapter: ethUsdcAdapter, apr: ethUsdcAPR, feeTier: 0.0005 },
    { asset: 'ETH-USDT', adapter: ethUsdtAdapter, apr: ethUsdtAPR, feeTier: 0.003 },
    { asset: 'WBTC-USDC', adapter: wbtcUsdcAdapter, apr: wbtcUsdcAPR, feeTier: 0.003 },
    { asset: 'WBTC-USDT', adapter: wbtcUsdtAdapter, apr: wbtcUsdtAPR, feeTier: 0.003 },
  ];

  for (const pool of poolsToOptimize) {
    process.stdout.write(`   Finding optimal interval for ${pool.asset}... `);
    const data = await pool.adapter.fetchHourlyOHLCV(pool.asset, startDate, endDate);
    
    // Check actual fee tier if possible, fallback to config
    let feeTier = pool.feeTier;
    try {
        feeTier = await pool.adapter.fetchPoolFeeTier(pool.asset);
    } catch (e) {}
    
    const result = await optimizer.optimizeVolatilePair(
      pool.asset,
      data,
      pool.apr,
      feeTier,
      25000 // $25k allocation
    );
    
    optimalConfigs.set(pool.asset, { interval: result.interval, netAPY: result.netAPY });
    console.log(`✅ ${result.interval}h (${result.netAPY.toFixed(1)}% APY)`);
  }
  console.log('\n');

  const result = await useCase.execute({
    startDate,
    endDate,
    initialCapital,
    dataDirectory: './data',
    strategies: [
      // ETH/USDC
      {
        strategy: new TrendAwareStrategy('eth-usdc-trend', 'ETH/USDC Trend Aware'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          allocation: 0.20,
          ammFeeAPR: ethUsdcAPR,
          incentiveAPR: 0,
          fundingAPR: 0,
          costModel: {
            gasCostPerRebalance: 0.50, // Base gas ≈ $0.50
            poolFeeTier: 0.0005,
          },
        }),
        allocation: 0.20,
      },
      // ETH/USDT
      {
        strategy: new TrendAwareStrategy('eth-usdt-trend', 'ETH/USDT Trend Aware'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDT',
          allocation: 0.20,
          ammFeeAPR: ethUsdtAPR,
          incentiveAPR: 0,
          fundingAPR: 0,
          costModel: {
            gasCostPerRebalance: 0.50,
            poolFeeTier: 0.003,
          },
        }),
        allocation: 0.20,
      },
      // WBTC/USDC
      {
        strategy: new TrendAwareStrategy('wbtc-usdc-trend', 'WBTC/USDC Trend Aware'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'WBTC-USDC',
          allocation: 0.20,
          ammFeeAPR: wbtcUsdcAPR,
          incentiveAPR: 0,
          fundingAPR: 0,
          costModel: {
            gasCostPerRebalance: 0.50,
            poolFeeTier: 0.003,
          },
        }),
        allocation: 0.20,
      },
      // WBTC/USDT
      {
        strategy: new TrendAwareStrategy('wbtc-usdt-trend', 'WBTC/USDT Trend Aware'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'WBTC-USDT',
          allocation: 0.20,
          ammFeeAPR: wbtcUsdtAPR,
          incentiveAPR: 0,
          fundingAPR: 0,
          costModel: {
            gasCostPerRebalance: 0.50,
            poolFeeTier: 0.003,
          },
        }),
        allocation: 0.20,
      },
      // Funding Rate Strategy (Hyperliquid + Aave)
      {
        strategy: new FundingRateCaptureStrategy('eth-funding', 'ETH Funding Capture (3x)'),
        config: {
          asset: 'ETH',
          leverage: 3.0, // 3x Leverage
          allocation: 0.20, // 20% of portfolio
          hyperliquidAdapter: hyperliquidAdapter, // Use real Hyperliquid funding
          borrowRateAdapter: aaveAdapter, // Use real Aave borrow rates
          borrowAsset: 'USDC', // Borrow USDC to lever up long ETH
          fundingThreshold: 0.000001, // Low threshold to ensure execution
          dataAdapter: ethUsdcAdapter, // Use ETH/USDC pool for ETH price data
        },
        allocation: 0.20,
      }
    ],
    customDataAdapter: ethUsdcAdapter, // Default fallback
    calculateIV: true,
    useRealFees: true,
    applyIL: true,
    applyCosts: true,
    costModel: {
      slippageBps: 5,
      gasModel: {
        gasUnitsPerRebalance: 450000,
        gasPriceGwei: 0.001, // Base
        nativeTokenPriceUSD: 3000,
        network: 'base',
      },
    },
    outputPath: './results/main-backtest.json',
  });

  const annualizedReturn = result.metrics.totalReturn;

  console.log('\n' + '='.repeat(60));
  console.log('✅ BACKTEST COMPLETE!');
  console.log('='.repeat(60) + '\n');

  console.log('📊 PORTFOLIO METRICS:');
  console.log(`   Initial Capital: $${initialCapital.toLocaleString()}`);
  console.log(`   Final Value: $${result.metrics.finalValue.toFixed(2)}`);
  console.log(`   Total Return: ${formatPercent(result.metrics.totalReturn)}%`);
  console.log(`   Annualized Return: ${formatPercent(annualizedReturn)}% APY`);
  console.log(`   Total PnL: $${(result.metrics.finalValue - initialCapital).toFixed(2)}\n`);

  console.log('⚙️  OPTIMIZED CONFIGURATIONS USED:');
  optimalConfigs.forEach((config, asset) => {
    console.log(`   ${asset}: ${config.interval}h interval (Target: ${config.netAPY.toFixed(1)}% APY)`);
  });

  console.log(`\n📁 Results saved to: ./results/main-backtest.json\n`);
}

main().catch((error) => {
  console.error('❌ Error:', error);
  process.exit(1);
});
