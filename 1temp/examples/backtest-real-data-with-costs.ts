/**
 * Backtest using ONLY real data (67 days) with all costs applied
 * - Real fees from The Graph
 * - Impermanent loss calculation
 * - Slippage and gas costs
 */

import 'dotenv/config';
import { RunBacktestUseCase } from '../src/application/use-cases/RunBacktest';
import { UniswapV4Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import {
  VolatilePairStrategy,
  OptionsOverlayStrategy,
} from '../src/infrastructure/adapters/strategies';
import { mergeWithDefaults } from '../src/shared/config/StrategyConfigs';

async function runRealDataBacktest() {
  console.log('🚀 Running Real Data Backtest (67 days)\n');
  console.log('📊 Features:');
  console.log('   ✅ Real fees from The Graph');
  console.log('   ✅ Impermanent loss calculation');
  console.log('   ✅ Slippage (10 bps)');
  console.log('   ✅ Gas costs ($50/tx)\n');

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.log('❌ THE_GRAPH_API_KEY not set');
    process.exit(1);
  }

  const adapter = new UniswapV4Adapter({
    apiKey,
    token0Symbol: 'ETH',
    token1Symbol: 'USDC',
    useUrlAuth: true,
  });

  const useCase = new RunBacktestUseCase();

  // Use ONLY real data period
  const startDate = new Date('2025-09-09');
  const endDate = new Date('2025-11-15'); // 67 days
  const initialCapital = 100000;

  console.log(`📅 Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`📊 Days: ${Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000))}`);
  console.log(`💰 Initial Capital: $${initialCapital.toLocaleString()}\n`);

  // Calculate actual APR from real fees
  console.log('📈 Calculating actual APR from real fee data...');
  try {
    const actualAPR = await adapter.calculateActualAPR('ETH-USDC', startDate, endDate);
    console.log(`   Real APR from fees: ${actualAPR.toFixed(2)}%\n`);
  } catch (error) {
    console.log('   Could not calculate real APR, using config defaults\n');
  }

  const result = await useCase.execute({
    startDate,
    endDate,
    initialCapital,
    strategies: [
      {
        strategy: new VolatilePairStrategy('vp1', 'ETH/USDC Volatile Pair'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          rangeWidth: 0.05,
          ammFeeAPR: 20, // Will be overridden by real fees if available
          incentiveAPR: 15,
          fundingAPR: 5,
          allocation: 0.4,
        }),
        allocation: 0.4,
      },
      {
        strategy: new OptionsOverlayStrategy('op1', 'ETH/USDC Options Overlay'),
        config: mergeWithDefaults('options-overlay', {
          pair: 'ETH-USDC',
          lpRangeWidth: 0.03,
          optionStrikeDistance: 0.05,
          allocation: 0.3,
        }),
        allocation: 0.3,
      },
    ],
    customDataAdapter: adapter,
    calculateIV: true,
    useRealFees: true, // Use real fees from The Graph
    applyIL: true, // Apply impermanent loss
    applyCosts: true, // Apply slippage and gas
    costModel: {
      slippageBps: 10, // 0.1% slippage
      gasCostUSD: 50, // $50 per transaction
    },
    outputPath: './results-real-data-with-costs.json',
  });

  const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  const annualizedReturn = days > 0 ? (result.metrics.totalReturn / days) * 365 : 0;

  console.log('\n' + '='.repeat(60));
  console.log('✅ REAL DATA BACKTEST COMPLETE!');
  console.log('='.repeat(60) + '\n');

  console.log('📊 PORTFOLIO METRICS:');
  console.log(`   Initial Capital: $${initialCapital.toLocaleString()}`);
  console.log(`   Final Value: $${result.metrics.finalValue.toFixed(2)}`);
  console.log(`   Total Return: ${result.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Days: ${days}`);
  console.log(`   Annualized Return: ${annualizedReturn.toFixed(2)}% APY`);
  console.log(`   Total PnL: $${(result.metrics.finalValue - initialCapital).toFixed(2)}\n`);

  console.log('📈 RISK METRICS:');
  console.log(`   Sharpe Ratio: ${result.metrics.sharpeRatio.toFixed(4)}`);
  console.log(`   Max Drawdown: ${result.metrics.maxDrawdown.toFixed(2)}%\n`);

  console.log('💼 TRADING ACTIVITY:');
  console.log(`   Total Trades: ${result.trades.length}`);
  console.log(`   Final Positions: ${result.positions.length}\n`);

  console.log('💡 This backtest uses:');
  console.log('   ✅ Real on-chain data only (no extrapolation)');
  console.log('   ✅ Actual fees from The Graph');
  console.log('   ✅ Impermanent loss applied');
  console.log('   ✅ Slippage and gas costs included');
  console.log(`\n📁 Results saved to: ./results-real-data-with-costs.json`);
}

runRealDataBacktest().catch(console.error);

