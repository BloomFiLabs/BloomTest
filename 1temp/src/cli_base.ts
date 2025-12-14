#!/usr/bin/env node
import 'dotenv/config';
import { RunBacktestUseCase } from './application/use-cases/RunBacktest';
import { UniswapV3Adapter } from './infrastructure/adapters/data/TheGraphDataAdapter';
import { TrendAwareStrategy } from './infrastructure/adapters/strategies';
import { mergeWithDefaults } from './shared/config/StrategyConfigs';

function formatNumber(value: number, decimals = 2): string {
  const rounded = Number(value.toFixed(decimals));
  if (Math.abs(rounded) < Math.pow(10, -decimals)) return (0).toFixed(decimals);
  return rounded.toFixed(decimals);
}

async function main() {
  console.log('🌱 Bloom Base Network Backtest\n');
  console.log('='.repeat(80));

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.error('❌ THE_GRAPH_API_KEY not set in environment');
    process.exit(1);
  }

  // Base network token addresses
  const WETH_BASE = '0x4200000000000000000000000000000000000006';
  const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  
  const ethUsdcAdapter = new UniswapV3Adapter({ 
    apiKey, 
    token0Symbol: 'WETH', 
    token1Symbol: 'USDC',
    token0Address: WETH_BASE,
    token1Address: USDC_BASE,
    useUrlAuth: true 
  });

  // Use last 90 days
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90);
  const initialCapital = 100000; // $100k

  console.log(`📅 Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`💰 Initial Capital: $${initialCapital.toLocaleString()}\n`);

  console.log('📈 Calculating real APR from Base network fees...');
  let ethUsdcAPR = 51.57; // We already know this from earlier query
  
  try {
    ethUsdcAPR = await ethUsdcAdapter.calculateActualAPR('ETH-USDC', startDate, endDate);
    console.log(`   ✅ ETH/USDC Real APR: ${ethUsdcAPR.toFixed(2)}%`);
  } catch (e) {
    console.log(`   ⚠️  Using fallback APR: ${ethUsdcAPR.toFixed(2)}%`);
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('🚀 Running Backtest...\n');

  const useCase = new RunBacktestUseCase();
  
  const result = await useCase.execute({
    startDate,
    endDate,
    initialCapital,
    dataDirectory: './data',
    strategies: [
      {
        strategy: new TrendAwareStrategy('eth-usdc-base', 'ETH/USDC Base Network'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          allocation: 1.0, // 100% allocation - single pool
          ammFeeAPR: ethUsdcAPR,
          incentiveAPR: 0,
          fundingAPR: 0,
          checkIntervalHours: 12,
          rangeWidth: 0.005, // Start with ±0.5% range
          costModel: {
            gasCostPerRebalance: 0.50, // Base L2 gas costs
            poolFeeTier: 0.0005, // 0.05% pool
            positionValueUSD: initialCapital,
          },
        }),
        dataAdapter: ethUsdcAdapter,
        allocation: 1.0,
        checkIntervalHours: 12,
      },
    ],
  });

  console.log('\n' + '='.repeat(80));
  console.log('📊 BACKTEST RESULTS (Base Network - ETH/USDC 0.05%)');
  console.log('='.repeat(80));
  console.log('');
  console.log(`📅 Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`📊 Pool Fee APR: ${ethUsdcAPR.toFixed(2)}%`);
  console.log('');
  console.log('💰 PERFORMANCE:');
  console.log(`   Initial Capital:  $${formatNumber(result.initialCapital)}`);
  console.log(`   Final Value:      $${formatNumber(result.finalPortfolioValue)}`);
  console.log(`   Total PnL:        $${formatNumber(result.totalPnL)} (${formatNumber(result.totalPnLPercent)}%)`);
  console.log(`   Annualized APY:   ${formatNumber(result.annualizedAPY)}%`);
  console.log('');
  console.log('📈 STRATEGY METRICS:');
  console.log(`   Total Trades:     ${result.totalTrades}`);
  console.log(`   Winning Trades:   ${result.winningTrades} (${formatNumber((result.winningTrades / Math.max(result.totalTrades, 1)) * 100)}%)`);
  console.log(`   Losing Trades:    ${result.losingTrades}`);
  console.log(`   Avg Win:          $${formatNumber(result.avgWin)}`);
  console.log(`   Avg Loss:         $${formatNumber(result.avgLoss)}`);
  console.log(`   Max Drawdown:     ${formatNumber(result.maxDrawdown)}%`);
  console.log(`   Sharpe Ratio:     ${formatNumber(result.sharpeRatio, 3)}`);
  console.log('');
  console.log('💸 COSTS:');
  console.log(`   Total Fees:       $${formatNumber(result.totalFees || 0)}`);
  console.log(`   Gas Costs:        $${formatNumber(result.totalGasCosts || 0)}`);
  console.log(`   Total Costs:      $${formatNumber((result.totalFees || 0) + (result.totalGasCosts || 0))}`);
  console.log('');
  
  console.log('='.repeat(80));
  console.log('');
  console.log('✅ Backtest Complete!');
  console.log('');
  console.log('💡 KEY INSIGHTS:');
  console.log(`   • With ${ethUsdcAPR.toFixed(0)}% pool APR, the strategy ${result.totalPnLPercent > 0 ? 'WAS PROFITABLE' : 'was not profitable'}`);
  console.log(`   • Annualized return: ${formatNumber(result.annualizedAPY)}%`);
  console.log(`   • This represents performance during ${ethUsdcAPR > 30 ? 'HIGH' : ethUsdcAPR > 10 ? 'MEDIUM' : 'LOW'} volatility period`);
  console.log('');
  
  if (result.annualizedAPY > 20) {
    console.log('🎉 EXCELLENT PERFORMANCE! Strategy works well in these conditions.');
  } else if (result.annualizedAPY > 5) {
    console.log('✅ POSITIVE PERFORMANCE. Strategy is profitable in these conditions.');
  } else if (result.annualizedAPY > 0) {
    console.log('🟡 MARGINAL PERFORMANCE. Consider larger capital or wait for higher volatility.');
  } else {
    console.log('⚠️  NEGATIVE PERFORMANCE. This fee environment is not suitable.');
  }
  
  console.log('');
}

main().catch((error) => {
  console.error('\n❌ Backtest Failed:', error.message);
  console.error(error);
  process.exit(1);
});

