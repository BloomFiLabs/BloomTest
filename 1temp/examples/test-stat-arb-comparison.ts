import 'dotenv/config';
import { RunBacktestUseCase } from '../src/application/use-cases/RunBacktest';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { VolatilePairStrategy } from '../src/infrastructure/adapters/strategies/VolatilePairStrategy';
import { StatArbVolatilityStrategy } from '../src/infrastructure/adapters/strategies/StatArbVolatilityStrategy';
import { mergeWithDefaults } from '../src/shared/config/StrategyConfigs';

async function runComparison() {
  console.log('🚀 Running Stat Arb vs Standard Strategy Comparison\n');

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.log('⚠️  Warning: THE_GRAPH_API_KEY not set. Using defaults/mock data if available.');
  }

  // Use Uniswap V3 subgraph
  const adapter = new UniswapV3Adapter({
    apiKey: apiKey || '',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    useUrlAuth: !!apiKey,
  });

  const useCase = new RunBacktestUseCase();
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-03-31'); // 3 Month run for speed
  const initialCapital = 100000;

  console.log(`📅 Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

  // --- Run 1: Standard Daily Rebalance ---
  console.log('\n▶️  Running STANDARD Strategy (Daily Rebalance, Fixed 5% Range)...');
  const resultStandard = await useCase.execute({
    startDate,
    endDate,
    initialCapital,
    strategies: [
      {
        strategy: new VolatilePairStrategy('standard', 'Standard Daily'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          rangeWidth: 0.05, // Fixed 5%
          checkIntervalHours: 24, // Daily Rebalance check
          rebalanceThreshold: 0.9,
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

  // --- Run 2: Stat Arb Smart Rebalance ---
  console.log('\n▶️  Running STAT ARB Strategy (Hourly Check, Dynamic Range, Bollinger)...');
  const resultStatArb = await useCase.execute({
    startDate,
    endDate,
    initialCapital,
    strategies: [
      {
        strategy: new StatArbVolatilityStrategy('statarb', 'Stat Arb Smart'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          rangeWidth: 0.05, // Base 5%, but dynamic
          checkIntervalHours: 1, // Hourly Checks for Volatility
          rebalanceThreshold: 0.9,
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

  // --- Comparison Report ---
  console.log('\n' + '='.repeat(60));
  console.log('📊 COMPARISON RESULTS');
  console.log('='.repeat(60));

  console.log('\n1️⃣  STANDARD STRATEGY (Daily)');
  console.log(`   Final Value: $${resultStandard.metrics.finalValue.toFixed(2)}`);
  console.log(`   Total Return: ${resultStandard.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   APY: ${resultStandard.metrics.totalReturn.toFixed(2)}% (Annualized: ${(resultStandard.metrics.totalReturn * 4).toFixed(2)}%)`);
  console.log(`   Drawdown: ${resultStandard.metrics.maxDrawdown.toFixed(2)}%`);
  console.log(`   Trades: ${resultStandard.trades.length}`);

  console.log('\n2️⃣  STAT ARB STRATEGY (Smart)');
  console.log(`   Final Value: $${resultStatArb.metrics.finalValue.toFixed(2)}`);
  console.log(`   Total Return: ${resultStatArb.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   APY: ${resultStatArb.metrics.totalReturn.toFixed(2)}% (Annualized: ${(resultStatArb.metrics.totalReturn * 4).toFixed(2)}%)`);
  console.log(`   Drawdown: ${resultStatArb.metrics.maxDrawdown.toFixed(2)}%`);
  console.log(`   Trades: ${resultStatArb.trades.length}`);

  const diff = resultStatArb.metrics.finalValue - resultStandard.metrics.finalValue;
  console.log('\n🏆 VERDICT:');
  if (diff > 0) {
      console.log(`   ✅ Stat Arb Outperformed by $${diff.toFixed(2)}`);
  } else {
      console.log(`   ❌ Standard Outperformed by $${Math.abs(diff).toFixed(2)} (Likely due to gas/over-trading?)`);
  }
}

runComparison().catch(console.error);



