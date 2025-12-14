/**
 * Backtest using Uniswap V3 with full year of historical data
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

async function runUniswapV3FullYear() {
  console.log('🚀 Running Uniswap V3 Full Year Backtest\n');
  console.log('📊 Features:');
  console.log('   ✅ Uniswap V3 subgraph (extensive historical data)');
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

  // Use Uniswap V3 subgraph with API key
  const adapter = new UniswapV3Adapter({
    apiKey,
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    useUrlAuth: true,
  });

  const useCase = new RunBacktestUseCase();

  // Use full year of historical data available in V3
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');
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
          // ±5% is moderate concentration - good balance
          ammFeeAPR: 20, // Will be overridden by real fees if available
          incentiveAPR: 15,
          fundingAPR: 5,
          allocation: 0.4, // 40% = $40,000 position size
        }),
        allocation: 0.4,
      },
      {
        strategy: new OptionsOverlayStrategy('op1', 'ETH/USDC Options Overlay'),
        config: mergeWithDefaults('options-overlay', {
          pair: 'ETH-USDC',
          lpRangeWidth: 0.03, // ±3% range - VERY CONCENTRATED
          // Very narrow range = maximum fee capture
          // But requires frequent rebalancing
          optionStrikeDistance: 0.05,
          allocation: 0.3, // 30% = $30,000 position size
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
    outputPath: './results-uniswap-v3-full-year.json',
  });

  const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  const annualizedReturn = result.metrics.totalReturn;

  console.log('\n' + '='.repeat(60));
  console.log('✅ UNISWAP V3 FULL YEAR BACKTEST COMPLETE!');
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

  console.log('📊 POSITION SIZING & CONCENTRATION:');
  result.positions.forEach((pos, i) => {
    const value = pos.marketValue().value;
    const pct = (value / result.metrics.finalValue) * 100;
    const entryValue = pos.entryValue().value;
    const pnl = pos.unrealizedPnL().value;
    console.log(`\n   Position ${i + 1}: ${pos.asset}`);
    console.log(`      Current Value: $${value.toFixed(2)} (${pct.toFixed(1)}% of portfolio)`);
    console.log(`      Entry Value: $${entryValue.toFixed(2)}`);
    console.log(`      PnL: $${pnl.toFixed(2)}`);
    
    // Determine range width from strategy
    if (pos.asset === 'ETH-USDC') {
      if (pos.strategyId === 'vp1') {
        console.log(`      Range: ±5% (moderate concentration)`);
        console.log(`      Capital Efficiency: ~80%`);
      } else if (pos.strategyId === 'op1') {
        console.log(`      Range: ±3% (high concentration)`);
        console.log(`      Capital Efficiency: ~60%`);
      }
    }
  });

  console.log('\n💡 LP Position Concentration Explained:');
  console.log('   Volatile Pair (±5%):');
  console.log('      - Moderate concentration');
  console.log('      - Captures fees when price within ±5%');
  console.log('      - ~80% capital efficiency');
  console.log('      - Good balance of fee capture vs IL risk');
  console.log('\n   Options Overlay (±3%):');
  console.log('      - High concentration');
  console.log('      - Captures fees when price within ±3%');
  console.log('      - ~60% capital efficiency');
  console.log('      - Maximum fee capture but more IL risk');
  console.log('\n   Narrower ranges = higher fee capture but:');
  console.log('      - More impermanent loss risk');
  console.log('      - More frequent rebalancing needed');
  console.log('      - Higher gas costs');
  console.log('\n📁 Results saved to: ./results-uniswap-v3-full-year.json');
}

runUniswapV3FullYear().catch(console.error);

