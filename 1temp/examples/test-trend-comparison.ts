import 'dotenv/config';
import { RunBacktestUseCase } from '../src/application/use-cases/RunBacktest';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { VolatilePairStrategy } from '../src/infrastructure/adapters/strategies/VolatilePairStrategy';
import { TrendAwareStrategy } from '../src/infrastructure/adapters/strategies/TrendAwareStrategy';
import { mergeWithDefaults } from '../src/shared/config/StrategyConfigs';

async function runTrendComparison() {
  console.log('🚀 Running Trend-Aware vs Standard Strategy Comparison\n');

  const apiKey = process.env.THE_GRAPH_API_KEY;
  const adapter = new UniswapV3Adapter({
    apiKey: apiKey || '',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    useUrlAuth: !!apiKey,
  });

  const useCase = new RunBacktestUseCase();
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-03-31'); // 3 Month Trend
  const initialCapital = 100000;

    // --- Run 1: Standard (Heuristic 3% Fixed) ---
    console.log('\n▶️  Running HEURISTIC Strategy (Fixed 3%)...');
    const resultStandard = await useCase.execute({
      startDate,
      endDate,
      initialCapital,
      strategies: [
        {
          strategy: new VolatilePairStrategy('heuristic', 'Heuristic Fixed 3%'),
          config: mergeWithDefaults('volatile-pair', {
            pair: 'ETH-USDC',
            rangeWidth: 0.03, // Fixed 3% (The Heuristic we discussed)
            checkIntervalHours: 12,
            allocation: 1.0,
          }),
        allocation: 1.0,
      },
    ],
    customDataAdapter: adapter,
    useRealFees: !!apiKey,
    applyIL: true,
    applyCosts: true,
    costModel: { slippageBps: 10, gasCostUSD: 50 },
  });

  // --- Run 2: Trend Aware ---
  console.log('\n▶️  Running TREND AWARE Strategy (Hurst Filter)...');
  const resultTrend = await useCase.execute({
    startDate,
    endDate,
    initialCapital,
    strategies: [
      {
        strategy: new TrendAwareStrategy('trend', 'Trend Aware'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          rangeWidth: 0.05,
          allocation: 1.0,
        }),
        allocation: 1.0,
      },
    ],
    customDataAdapter: adapter,
    useRealFees: !!apiKey,
    applyIL: true,
    applyCosts: true,
    costModel: { slippageBps: 10, gasCostUSD: 50 },
  });

  // --- Comparison ---
  console.log('\n' + '='.repeat(60));
  console.log('📊 TREND COMPARISON RESULTS (Jan-Mar 2024 Bull Run)');
  console.log('='.repeat(60));

  console.log('\n1️⃣  STANDARD STRATEGY');
  console.log(`   Final Value: $${resultStandard.metrics.finalValue.toFixed(2)}`);
  console.log(`   Total Return: ${resultStandard.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Drawdown: ${resultStandard.metrics.maxDrawdown.toFixed(2)}%`);
  console.log(`   Trades: ${resultStandard.trades.length}`);

  console.log('\n2️⃣  TREND AWARE STRATEGY');
  console.log(`   Final Value: $${resultTrend.metrics.finalValue.toFixed(2)}`);
  console.log(`   Total Return: ${resultTrend.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Drawdown: ${resultTrend.metrics.maxDrawdown.toFixed(2)}%`);
  console.log(`   Trades: ${resultTrend.trades.length}`);

  const diff = resultTrend.metrics.finalValue - resultStandard.metrics.finalValue;
  console.log('\n🏆 VERDICT:');
  if (diff > 0) {
      console.log(`   ✅ Trend Aware Outperformed by $${diff.toFixed(2)}`);
  } else {
      console.log(`   ❌ Standard Outperformed by $${Math.abs(diff).toFixed(2)}`);
  }
}

runTrendComparison().catch(console.error);

