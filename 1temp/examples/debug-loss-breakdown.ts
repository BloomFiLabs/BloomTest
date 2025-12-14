/**
 * Debug script to analyze why we're losing money
 * Breaks down costs, IL, and yield separately
 */

import 'dotenv/config';
import { RunBacktestUseCase } from '../src/application/use-cases/RunBacktest';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { VolatilePairStrategy } from '../src/infrastructure/adapters/strategies';
import { mergeWithDefaults } from '../src/shared/config/StrategyConfigs';

async function debugLossBreakdown() {
  console.log('🔍 Debugging Loss Breakdown\n');

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.log('❌ THE_GRAPH_API_KEY not set');
    process.exit(1);
  }

  const adapter = new UniswapV3Adapter({
    apiKey,
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    useUrlAuth: true,
  });

  const useCase = new RunBacktestUseCase();

  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');
  const initialCapital = 100000;

  console.log(`📅 Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`💰 Initial Capital: $${initialCapital.toLocaleString()}\n`);

  // Test 1: Without costs or IL
  console.log('='.repeat(60));
  console.log('TEST 1: No Costs, No IL (Baseline)');
  console.log('='.repeat(60));
  const result1 = await useCase.execute({
    startDate,
    endDate,
    initialCapital,
    dataDirectory: './data',
    strategies: [
      {
        strategy: new VolatilePairStrategy('vp1', 'ETH/USDC'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          rangeWidth: 0.05,
          allocation: 0.4,
        }),
        allocation: 0.4,
      },
    ],
    customDataAdapter: adapter,
    useRealFees: true,
    applyIL: false,
    applyCosts: false,
    outputPath: './results/debug-no-costs.json',
  });
  console.log(`   Final Value: $${result1.metrics.finalValue.toFixed(2)}`);
  console.log(`   Return: ${result1.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Trades: ${result1.trades.length}\n`);

  // Test 2: With IL only
  console.log('='.repeat(60));
  console.log('TEST 2: With IL, No Costs');
  console.log('='.repeat(60));
  const result2 = await useCase.execute({
    startDate,
    endDate,
    initialCapital,
    dataDirectory: './data',
    strategies: [
      {
        strategy: new VolatilePairStrategy('vp1', 'ETH/USDC'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          rangeWidth: 0.05,
          allocation: 0.4,
        }),
        allocation: 0.4,
      },
    ],
    customDataAdapter: adapter,
    useRealFees: true,
    applyIL: true,
    applyCosts: false,
    outputPath: './results/debug-il-only.json',
  });
  console.log(`   Final Value: $${result2.metrics.finalValue.toFixed(2)}`);
  console.log(`   Return: ${result2.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   IL Impact: ${((result2.metrics.finalValue - result1.metrics.finalValue) / result1.metrics.finalValue * 100).toFixed(2)}%\n`);

  // Test 3: With costs only
  console.log('='.repeat(60));
  console.log('TEST 3: With Costs, No IL');
  console.log('='.repeat(60));
  const result3 = await useCase.execute({
    startDate,
    endDate,
    initialCapital,
    dataDirectory: './data',
    strategies: [
      {
        strategy: new VolatilePairStrategy('vp1', 'ETH/USDC'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          rangeWidth: 0.05,
          allocation: 0.4,
        }),
        allocation: 0.4,
      },
    ],
    customDataAdapter: adapter,
    useRealFees: true,
    applyIL: false,
    applyCosts: true,
    costModel: {
      slippageBps: 10,
      gasCostUSD: 50,
    },
    outputPath: './results/debug-costs-only.json',
  });
  console.log(`   Final Value: $${result3.metrics.finalValue.toFixed(2)}`);
  console.log(`   Return: ${result3.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Cost Impact: ${((result3.metrics.finalValue - result1.metrics.finalValue) / result1.metrics.finalValue * 100).toFixed(2)}%`);
  console.log(`   Estimated Gas Costs: $${(result3.trades.length * 50).toFixed(2)}\n`);

  // Test 4: With both IL and costs
  console.log('='.repeat(60));
  console.log('TEST 4: With IL and Costs (Full)');
  console.log('='.repeat(60));
  const result4 = await useCase.execute({
    startDate,
    endDate,
    initialCapital,
    dataDirectory: './data',
    strategies: [
      {
        strategy: new VolatilePairStrategy('vp1', 'ETH/USDC'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          rangeWidth: 0.05,
          allocation: 0.4,
        }),
        allocation: 0.4,
      },
    ],
    customDataAdapter: adapter,
    useRealFees: true,
    applyIL: true,
    applyCosts: true,
    costModel: {
      slippageBps: 10,
      gasCostUSD: 50,
    },
    outputPath: './results/debug-full.json',
  });
  console.log(`   Final Value: $${result4.metrics.finalValue.toFixed(2)}`);
  console.log(`   Return: ${result4.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Total Impact: ${((result4.metrics.finalValue - result1.metrics.finalValue) / result1.metrics.finalValue * 100).toFixed(2)}%\n`);

  // Summary
  console.log('='.repeat(60));
  console.log('📊 BREAKDOWN SUMMARY');
  console.log('='.repeat(60));
  console.log(`Baseline (no costs/IL): $${result1.metrics.finalValue.toFixed(2)}`);
  console.log(`IL Impact: $${(result2.metrics.finalValue - result1.metrics.finalValue).toFixed(2)}`);
  console.log(`Cost Impact: $${(result3.metrics.finalValue - result1.metrics.finalValue).toFixed(2)}`);
  console.log(`Combined Impact: $${(result4.metrics.finalValue - result1.metrics.finalValue).toFixed(2)}`);
  console.log(`\nFinal Value: $${result4.metrics.finalValue.toFixed(2)}`);
  console.log(`Loss: $${(initialCapital - result4.metrics.finalValue).toFixed(2)}`);
}

debugLossBreakdown().catch(console.error);

