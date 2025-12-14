/**
 * Backtest using Uniswap V3 with real historical data
 * - More historical data available than V4
 * - Real fees from The Graph
 * - Impermanent loss calculation
 * - Slippage and gas costs
 * - Proper LP position sizing and concentration
 */

import 'dotenv/config';
import { RunBacktestUseCase } from '../src/application/use-cases/RunBacktest';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import {
  VolatilePairStrategy,
  OptionsOverlayStrategy,
} from '../src/infrastructure/adapters/strategies';
import { mergeWithDefaults } from '../src/shared/config/StrategyConfigs';

async function runUniswapV3Backtest() {
  console.log('🚀 Running Uniswap V3 Backtest with Real Historical Data\n');
  console.log('📊 Features:');
  console.log('   ✅ Uniswap V3 subgraph (more historical data)');
  console.log('   ✅ Real fees from The Graph');
  console.log('   ✅ Impermanent loss calculation');
  console.log('   ✅ Slippage (10 bps)');
  console.log('   ✅ Gas costs ($50/tx)');
  console.log('   ✅ Concentrated liquidity ranges\n');

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.log('❌ THE_GRAPH_API_KEY not set');
    process.exit(1);
  }

  // Use Uniswap V3 subgraph
  const adapter = new UniswapV3Adapter({
    subgraphUrl: `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV`,
    apiKey,
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    // Find a high-volume ETH/USDC pool
  });

  const useCase = new RunBacktestUseCase();

  // Use longer historical period available in V3
  // V3 has data going back much further than V4
  const startDate = new Date('2024-01-01'); // Start of 2024
  const endDate = new Date('2024-12-31');   // End of 2024 (full year)
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
          rangeWidth: 0.05, // ±5% range - CONCENTRATED for higher fees
          // Narrower ranges = higher fee capture but more IL risk
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
          lpRangeWidth: 0.03, // ±3% range - VERY CONCENTRATED
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
    outputPath: './results-uniswap-v3-real-data.json',
  });

  const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  const annualizedReturn = days > 0 ? (result.metrics.totalReturn / days) * 365 : 0;

  console.log('\n' + '='.repeat(60));
  console.log('✅ UNISWAP V3 BACKTEST COMPLETE!');
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

  console.log('📊 POSITION SIZING:');
  result.positions.forEach((pos, i) => {
    const value = pos.marketValue().value;
    const pct = (value / result.metrics.finalValue) * 100;
    console.log(`   Position ${i + 1}: ${pos.asset} - $${value.toFixed(2)} (${pct.toFixed(1)}% of portfolio)`);
  });

  console.log('\n💡 LP Position Concentration:');
  console.log('   Volatile Pair: ±5% range (moderate concentration)');
  console.log('   Options Overlay: ±3% range (high concentration)');
  console.log('   Narrower ranges = higher fee capture but more IL risk');
  console.log('\n📁 Results saved to: ./results-uniswap-v3-real-data.json');
}

runUniswapV3Backtest().catch(console.error);

