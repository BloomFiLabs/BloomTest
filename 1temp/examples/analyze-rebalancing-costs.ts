/**
 * Analyze rebalancing costs and impact
 */

import 'dotenv/config';
import { RunBacktestUseCase } from '../src/application/use-cases/RunBacktest';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { VolatilePairStrategy } from '../src/infrastructure/adapters/strategies';
import { mergeWithDefaults } from '../src/shared/config/StrategyConfigs';

async function analyzeRebalancingCosts() {
  console.log('🔍 Analyzing Rebalancing Costs\n');

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

  // Test 1: No rebalancing (wider range)
  console.log('='.repeat(60));
  console.log('TEST 1: Wide Range (±20%) - Minimal Rebalancing');
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
          rangeWidth: 0.20, // ±20% - very wide, minimal rebalancing
          allocation: 0.4,
        }),
        allocation: 0.4,
      },
    ],
    customDataAdapter: adapter,
    useRealFees: true,
    applyIL: true,
    applyCosts: false,
    outputPath: './results/no-rebalance.json',
  });
  
  const rebalances1 = result1.positionMetrics?.get('vp1-ETH-USDC')?.rebalanceCount || 0;
  console.log(`   Final Value: $${result1.metrics.finalValue.toFixed(2)}`);
  console.log(`   Return: ${result1.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Rebalances: ${rebalances1}\n`);

  // Test 2: Moderate rebalancing (±10%)
  console.log('='.repeat(60));
  console.log('TEST 2: Moderate Range (±10%) - Moderate Rebalancing');
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
          rangeWidth: 0.10, // ±10%
          allocation: 0.4,
        }),
        allocation: 0.4,
      },
    ],
    customDataAdapter: adapter,
    useRealFees: true,
    applyIL: true,
    applyCosts: false,
    outputPath: './results/moderate-rebalance.json',
  });
  
  const rebalances2 = result2.positionMetrics?.get('vp1-ETH-USDC')?.rebalanceCount || 0;
  console.log(`   Final Value: $${result2.metrics.finalValue.toFixed(2)}`);
  console.log(`   Return: ${result2.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Rebalances: ${rebalances2}\n`);

  // Test 3: Aggressive rebalancing (±5%) - Current config
  console.log('='.repeat(60));
  console.log('TEST 3: Narrow Range (±5%) - Aggressive Rebalancing');
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
          rangeWidth: 0.05, // ±5% - current config
          allocation: 0.4,
        }),
        allocation: 0.4,
      },
    ],
    customDataAdapter: adapter,
    useRealFees: true,
    applyIL: true,
    applyCosts: false,
    outputPath: './results/aggressive-rebalance.json',
  });
  
  const rebalances3 = result3.positionMetrics?.get('vp1-ETH-USDC')?.rebalanceCount || 0;
  console.log(`   Final Value: $${result3.metrics.finalValue.toFixed(2)}`);
  console.log(`   Return: ${result3.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Rebalances: ${rebalances3}\n`);

  // Test 4: With costs enabled
  console.log('='.repeat(60));
  console.log('TEST 4: Narrow Range (±5%) WITH Costs (Gas + Slippage)');
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
      slippageBps: 10, // 0.1% slippage
      gasCostUSD: 50, // $50 gas per rebalance
    },
    outputPath: './results/with-costs.json',
  });
  
  const rebalances4 = result4.positionMetrics?.get('vp1-ETH-USDC')?.rebalanceCount || 0;
  const estimatedGasCosts = rebalances4 * 50;
  const estimatedSlippage = result4.metrics.finalValue * 0.001 * rebalances4; // Rough estimate
  console.log(`   Final Value: $${result4.metrics.finalValue.toFixed(2)}`);
  console.log(`   Return: ${result4.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Rebalances: ${rebalances4}`);
  console.log(`   Estimated Gas Costs: $${estimatedGasCosts.toFixed(2)}`);
  console.log(`   Estimated Slippage: ~$${estimatedSlippage.toFixed(2)}`);
  console.log(`   Total Estimated Costs: ~$${(estimatedGasCosts + estimatedSlippage).toFixed(2)}\n`);

  // Summary
  console.log('='.repeat(60));
  console.log('📊 REBALANCING IMPACT ANALYSIS');
  console.log('='.repeat(60));
  console.log(`Wide Range (±20%):     ${rebalances1} rebalances → ${result1.metrics.totalReturn.toFixed(2)}% return`);
  console.log(`Moderate Range (±10%):  ${rebalances2} rebalances → ${result2.metrics.totalReturn.toFixed(2)}% return`);
  console.log(`Narrow Range (±5%):     ${rebalances3} rebalances → ${result3.metrics.totalReturn.toFixed(2)}% return`);
  console.log(`\nCost Impact (with $50 gas + 0.1% slippage):`);
  console.log(`   ${rebalances4} rebalances × $50 = $${estimatedGasCosts.toFixed(2)} gas`);
  console.log(`   Estimated slippage: ~$${estimatedSlippage.toFixed(2)}`);
  console.log(`   Total cost: ~$${(estimatedGasCosts + estimatedSlippage).toFixed(2)}`);
  console.log(`   Cost as % of capital: ${(((estimatedGasCosts + estimatedSlippage) / initialCapital) * 100).toFixed(2)}%`);
  
  const returnDiff = result1.metrics.totalReturn - result3.metrics.totalReturn;
  console.log(`\nReturn difference (wide vs narrow): ${returnDiff.toFixed(2)}%`);
  console.log(`This suggests rebalancing cost: ~${returnDiff.toFixed(2)}% of returns`);
}

analyzeRebalancingCosts().catch(console.error);

