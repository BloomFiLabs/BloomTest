/**
 * Optimize range width to hit 35% APY target
 * Tests progressively narrower ranges until target is met
 */

import 'dotenv/config';
import { RunBacktestUseCase } from '../src/application/use-cases/RunBacktest';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { VolatilePairStrategy } from '../src/infrastructure/adapters/strategies';
import { mergeWithDefaults } from '../src/shared/config/StrategyConfigs';

async function optimizeForTarget() {
  console.log('🎯 Optimizing Range Width for 35% APY Target\n');

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
  const targetAPY = 35;

  console.log(`📅 Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`💰 Initial Capital: $${initialCapital.toLocaleString()}`);
  console.log(`🎯 Target APY: ${targetAPY}%\n`);

  // Calculate real APR
  console.log('📈 Calculating real APR from fees...');
  const realAPR = await adapter.calculateActualAPR('ETH-USDC', startDate, endDate);
  console.log(`   Real Fee APR: ${realAPR.toFixed(2)}%\n`);

  // Test progressively narrower ranges
  const rangeWidths = [0.20, 0.15, 0.10, 0.08, 0.06, 0.05, 0.04, 0.03, 0.02, 0.015];
  const results: Array<{
    rangeWidth: number;
    return: number;
    rebalances: number;
    feeCaptureEfficiency: number;
    feeCaptureRate: number;
    currentIL: number;
  }> = [];

  console.log('='.repeat(80));
  console.log('Testing Range Widths...');
  console.log('='.repeat(80) + '\n');

  for (const rangeWidth of rangeWidths) {
    const rangePercent = (rangeWidth * 100).toFixed(1);
    console.log(`Testing ±${rangePercent}% range...`);

    try {
      const result = await useCase.execute({
        startDate,
        endDate,
        initialCapital,
        dataDirectory: './data',
        strategies: [
          {
            strategy: new VolatilePairStrategy('vp1', 'ETH/USDC'),
            config: mergeWithDefaults('volatile-pair', {
              pair: 'ETH-USDC',
              rangeWidth,
              ammFeeAPR: realAPR,
              incentiveAPR: 15,
              fundingAPR: 5,
              allocation: 0.4,
            }),
            allocation: 0.4,
          },
        ],
        customDataAdapter: adapter,
        useRealFees: true,
        applyIL: true,
        applyCosts: false,
      });

      const positionMetrics = result.positionMetrics?.get('vp1-ETH-USDC');
      const return_ = result.metrics.totalReturn;
      const rebalances = positionMetrics?.rebalanceCount || 0;
      const feeCaptureEfficiency = positionMetrics?.feeCaptureEfficiency || 0;
      const feeCaptureRate = positionMetrics?.feeCaptureRate || 0;
      const currentIL = positionMetrics?.currentIL || 0;

      results.push({
        rangeWidth,
        return: return_,
        rebalances,
        feeCaptureEfficiency,
        feeCaptureRate,
        currentIL,
      });

      const status = return_ >= targetAPY ? '✅ TARGET MET' : '❌ Below target';
      console.log(`   Return: ${return_.toFixed(2)}% ${status}`);
      console.log(`   Rebalances: ${rebalances}`);
      console.log(`   Fee Capture Efficiency: ${feeCaptureEfficiency.toFixed(2)}%`);
      console.log(`   Fee Capture Rate: ${feeCaptureRate.toFixed(2)}%`);
      console.log(`   Current IL: ${currentIL.toFixed(2)}%\n`);

      if (return_ >= targetAPY) {
        console.log('='.repeat(80));
        console.log(`🎉 TARGET ACHIEVED with ±${rangePercent}% range!`);
        console.log('='.repeat(80) + '\n');
        break;
      }
    } catch (error) {
      console.error(`   Error testing range ${rangeWidth}:`, (error as Error).message);
      continue;
    }
  }

  // Summary
  console.log('='.repeat(80));
  console.log('📊 OPTIMIZATION SUMMARY');
  console.log('='.repeat(80) + '\n');

  console.log('Range Width | Return  | Rebalances | Fee Eff. | Fee Rate | IL');
  console.log('-'.repeat(80));

  for (const r of results) {
    const rangePercent = (r.rangeWidth * 100).toFixed(1).padStart(5);
    const return_ = r.return.toFixed(2).padStart(7);
    const rebalances = r.rebalances.toString().padStart(10);
    const feeEff = r.feeCaptureEfficiency.toFixed(1).padStart(8);
    const feeRate = r.feeCaptureRate.toFixed(1).padStart(9);
    const il = r.currentIL.toFixed(2).padStart(5);
    const status = r.return >= targetAPY ? ' ✅' : '';

    console.log(`±${rangePercent}%     | ${return_}% | ${rebalances} | ${feeEff}% | ${feeRate}% | ${il}%${status}`);
  }

  console.log('');

  // Find best range
  const bestResult = results.reduce((best, current) => {
    if (current.return >= targetAPY && current.return < best.return) {
      return current;
    }
    if (best.return < targetAPY && current.return > best.return) {
      return current;
    }
    return best;
  }, results[0]);

  if (bestResult) {
    console.log('🏆 Best Configuration:');
    console.log(`   Range Width: ±${(bestResult.rangeWidth * 100).toFixed(1)}%`);
    console.log(`   Return: ${bestResult.return.toFixed(2)}%`);
    console.log(`   Rebalances: ${bestResult.rebalances}`);
    console.log(`   Fee Capture Efficiency: ${bestResult.feeCaptureEfficiency.toFixed(2)}%`);
    console.log(`   Fee Capture Rate: ${bestResult.feeCaptureRate.toFixed(2)}%`);
    console.log(`   Current IL: ${bestResult.currentIL.toFixed(2)}%`);

    if (bestResult.return >= targetAPY) {
      console.log(`\n✅ This configuration meets the ${targetAPY}% target!`);
    } else {
      console.log(`\n⚠️  No configuration met the ${targetAPY}% target.`);
      console.log(`   Best achieved: ${bestResult.return.toFixed(2)}%`);
      console.log(`   Gap: ${(targetAPY - bestResult.return).toFixed(2)}%`);
    }
  }
}

optimizeForTarget().catch(console.error);

