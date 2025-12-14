#!/usr/bin/env tsx
import { RunBacktestUseCase } from '../src/application/use-cases/RunBacktest';
import { Amount } from '../src/domain/value-objects/Amount';
import { VolatilePairStrategy, StrategyMode } from '../src/infrastructure/adapters/strategies/VolatilePairStrategy';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { mergeWithDefaults } from '../src/shared/config/StrategyConfigs';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const apiKey = process.env.THE_GRAPH_API_KEY || '';

// Actual Pool TVLs (Base Network, Dec 2024)
const POOL_TVL = {
  'ETH-USDC': 180_000_000,  // $180M
  'ETH-USDT': 45_000_000,   // $45M
  'WBTC-USDC': 35_000_000,  // $35M
  'WBTC-USDT': 12_000_000,  // $12M
};

async function runCapacityBacktest() {
  console.log('\n' + '='.repeat(80));
  console.log('🔬 CAPACITY BACKTEST: Dynamic Slippage & Pool Depth Modeling');
  console.log('='.repeat(80) + '\n');

  const startDate = new Date('2025-05-25T00:00:00Z');
  const endDate = new Date('2025-08-22T00:00:00Z');

  const ethUsdcAdapter = new UniswapV3Adapter({ apiKey, token0Symbol: 'WETH', token1Symbol: 'USDC', useUrlAuth: true });
  const ethUsdtAdapter = new UniswapV3Adapter({ apiKey, token0Symbol: 'WETH', token1Symbol: 'USDT', useUrlAuth: true });
  const wbtcUsdcAdapter = new UniswapV3Adapter({ apiKey, token0Symbol: 'WBTC', token1Symbol: 'USDC', useUrlAuth: true });
  const wbtcUsdtAdapter = new UniswapV3Adapter({ apiKey, token0Symbol: 'WBTC', token1Symbol: 'USDT', useUrlAuth: true });

  const scenarios = [
    { capital: 1_000_000, label: '$1M' },
    { capital: 5_000_000, label: '$5M' },
    { capital: 10_000_000, label: '$10M' },
    { capital: 25_000_000, label: '$25M' },
    { capital: 50_000_000, label: '$50M' },
    { capital: 75_000_000, label: '$75M' },
    { capital: 100_000_000, label: '$100M' },
    { capital: 150_000_000, label: '$150M' },
    { capital: 200_000_000, label: '$200M' },
    { capital: 250_000_000, label: '$250M' },
  ];

  const results = [];

  for (const scenario of scenarios) {
    console.log(`\n📊 Testing: ${scenario.label}`);
    
    const useCase = new RunBacktestUseCase();

    const result = await useCase.execute({
      startDate,
      endDate,
      initialCapital: scenario.capital,
      dataDirectory: './data',
      strategies: [
        {
          strategy: new VolatilePairStrategy(`eth-usdc-${scenario.capital}`, 'ETH/USDC'),
          config: mergeWithDefaults('volatile-pair', {
            pair: 'ETH-USDC',
            mode: StrategyMode.SPEED,
            checkIntervalHours: 24,
            ammFeeAPR: 2.92,
            allocation: 0.25,
            dataAdapter: ethUsdcAdapter,
            costModel: {
              poolTVL: POOL_TVL['ETH-USDC'],
              slippageBps: 5,
              useDynamicSlippage: true,
              gasModel: { gasUnitsPerRebalance: 450000, gasPriceGwei: 0.001, nativeTokenPriceUSD: 3000, network: 'base' },
            },
          }),
          allocation: 0.25,
        },
        {
          strategy: new VolatilePairStrategy(`eth-usdt-${scenario.capital}`, 'ETH/USDT'),
          config: mergeWithDefaults('volatile-pair', {
            pair: 'ETH-USDT',
            mode: StrategyMode.TANK,
            checkIntervalHours: 24,
            ammFeeAPR: 2.92,
            allocation: 0.25,
            dataAdapter: ethUsdtAdapter,
            costModel: {
              poolTVL: POOL_TVL['ETH-USDT'],
              slippageBps: 5,
              useDynamicSlippage: true,
              gasModel: { gasUnitsPerRebalance: 450000, gasPriceGwei: 0.001, nativeTokenPriceUSD: 3000, network: 'base' },
            },
          }),
          allocation: 0.25,
        },
        {
          strategy: new VolatilePairStrategy(`wbtc-usdc-${scenario.capital}`, 'WBTC/USDC'),
          config: mergeWithDefaults('volatile-pair', {
            pair: 'WBTC-USDC',
            mode: StrategyMode.TANK,
            checkIntervalHours: 12,
            ammFeeAPR: 2.92,
            allocation: 0.25,
            dataAdapter: wbtcUsdcAdapter,
            costModel: {
              poolTVL: POOL_TVL['WBTC-USDC'],
              slippageBps: 5,
              useDynamicSlippage: true,
              gasModel: { gasUnitsPerRebalance: 450000, gasPriceGwei: 0.001, nativeTokenPriceUSD: 3000, network: 'base' },
            },
          }),
          allocation: 0.25,
        },
        {
          strategy: new VolatilePairStrategy(`wbtc-usdt-${scenario.capital}`, 'WBTC/USDT'),
          config: mergeWithDefaults('volatile-pair', {
            pair: 'WBTC-USDT',
            mode: StrategyMode.HYBRID,
            checkIntervalHours: 39,
            ammFeeAPR: 2.92,
            allocation: 0.25,
            dataAdapter: wbtcUsdtAdapter,
            costModel: {
              poolTVL: POOL_TVL['WBTC-USDT'],
              slippageBps: 5,
              useDynamicSlippage: true,
              gasModel: { gasUnitsPerRebalance: 450000, gasPriceGwei: 0.001, nativeTokenPriceUSD: 3000, network: 'base' },
            },
          }),
          allocation: 0.25,
        },
      ],
      customDataAdapter: ethUsdcAdapter,
      calculateIV: false,
      useRealFees: true,
      applyIL: true,
      applyCosts: true,
      costModel: {
        slippageBps: 5,
        poolTVL: 68_000_000, // Fallback average
        useDynamicSlippage: true,
        gasModel: {
          gasUnitsPerRebalance: 450000,
          gasPriceGwei: 0.001,
          nativeTokenPriceUSD: 3000,
          network: 'base',
        },
      },
      outputPath: `./results/capacity-${scenario.capital}.json`,
    });

    const finalValue = result.metrics.finalValue;
    const totalReturn = result.metrics.totalReturn;
    const totalRebalanceCosts = result.metrics.totalRebalanceCosts || 0;
    
    console.log(`   Final: $${finalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
    console.log(`   APY: ${totalReturn.toFixed(2)}%`);
    console.log(`   Trades: ${result.trades.length} | Rebalance Costs: $${totalRebalanceCosts.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);

    results.push({
      capital: scenario.capital,
      finalValue,
      apy: totalReturn,
      trades: result.trades.length,
      rebalanceCosts: totalRebalanceCosts,
    });
  }

  console.log('\n' + '='.repeat(100));
  console.log('📈 CAPACITY SCALING ANALYSIS');
  console.log('='.repeat(100));
  console.log('Capital    | Final Value      | APY       | Degradation | Rebal Costs  | Pool Share');
  console.log('-'.repeat(100));

  const baselineAPY = results[0].apy;
  
  for (const r of results) {
    const degradation = ((r.apy - baselineAPY) / baselineAPY * 100).toFixed(2);
    const degradationStr = degradation.startsWith('-') ? degradation : '+' + degradation;
    
    // Calculate average pool share for this capital level
    const allocationPerPool = (r.capital * 0.25);
    const avgTVL = (POOL_TVL['ETH-USDC'] + POOL_TVL['ETH-USDT'] + POOL_TVL['WBTC-USDC'] + POOL_TVL['WBTC-USDT']) / 4;
    const avgShare = (allocationPerPool / avgTVL * 100);
    
    console.log(
      `$${(r.capital / 1_000_000).toString().padStart(3)}M`.padEnd(11) +
      `| $${r.finalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`.padEnd(18) +
      `| ${r.apy.toFixed(3)}%`.padEnd(11) +
      `| ${degradationStr.padStart(7)}%`.padEnd(13) +
      `| $${r.rebalanceCosts.toLocaleString(undefined, { maximumFractionDigits: 0 })}`.padEnd(14) +
      `| ${avgShare.toFixed(1)}%`
    );
  }
  console.log('='.repeat(100) + '\n');
  
  console.log('📊 POOL CAPACITY ANALYSIS (at $250M):');
  console.log('-'.repeat(70));
  const largestScenario = scenarios[scenarios.length - 1];
  const allocationPerPool = (largestScenario.capital * 0.25); // 25% per strategy
  
  for (const [pool, tvl] of Object.entries(POOL_TVL)) {
    const share = (allocationPerPool / tvl * 100).toFixed(1);
    const status = allocationPerPool / tvl > 0.5 ? '⚠️  OVERSATURATED' : 
                   allocationPerPool / tvl > 0.2 ? '⚠️  HIGH' : '✅ OK';
    console.log(`${pool.padEnd(12)}: $${(allocationPerPool/1e6).toFixed(1)}M / $${(tvl/1e6).toFixed(0)}M = ${share.padStart(5)}% ${status}`);
  }
  console.log('\n✅ Backtest complete with pool-specific dilution modeling.\n');
}

runCapacityBacktest().catch(console.error);

