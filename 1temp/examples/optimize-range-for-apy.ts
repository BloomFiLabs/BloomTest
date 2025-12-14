/**
 * Optimize LP Range Width for Target APY
 * 
 * Tests multiple range widths and finds optimal range for 40% APY target
 * Reports:
 * - IL for each range
 * - Rebalancing frequency
 * - Returns for each range
 * - Optimal range recommendation
 */

import 'dotenv/config';
import { RunBacktestUseCase } from '../src/application/use-cases/RunBacktest';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import {
  VolatilePairStrategy,
  OptionsOverlayStrategy,
} from '../src/infrastructure/adapters/strategies';
import { mergeWithDefaults } from '../src/shared/config/StrategyConfigs';
import { RangeOptimizer } from '../src/shared/utils/RangeOptimizer';
import { Price } from '../src/domain/value-objects';

async function optimizeRangeForAPY() {
  console.log('🎯 Optimizing LP Range Width for 40% APY Target\n');
  console.log('📊 This will test multiple range widths and find the optimal one\n');

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

  // Use real data period
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');
  const targetAPY = 40; // Target APY

  console.log(`📅 Date Range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`🎯 Target APY: ${targetAPY}%\n`);

  // Fetch price data for range optimization
  console.log('📈 Fetching price data...');
  const priceData = await adapter.fetchOHLCV('ETH-USDC', startDate, endDate);
  
  if (priceData.length === 0) {
    console.log('❌ No price data available');
    process.exit(1);
  }

  const entryPrice = priceData[0].close;
  const prices = priceData.map(d => ({
    timestamp: d.timestamp,
    price: d.close,
  }));

  console.log(`   Found ${priceData.length} data points`);
  console.log(`   Entry Price: $${entryPrice.value.toFixed(2)}\n`);

  // Calculate real APR
  console.log('💰 Calculating real APR from fees...');
  const realAPR = await adapter.calculateActualAPR('ETH-USDC', startDate, endDate);
  console.log(`   Real APR: ${realAPR.toFixed(2)}%\n`);

  // Test multiple range widths
  const rangeWidths = [0.02, 0.03, 0.05, 0.07, 0.10, 0.15]; // ±2%, ±3%, ±5%, ±7%, ±10%, ±15%
  
  console.log('🧪 Testing Range Widths:\n');
  console.log('   Range Widths to test:', rangeWidths.map(r => `±${(r * 100).toFixed(0)}%`).join(', '));
  console.log('');

  const incentiveAPR = 15;
  const fundingAPR = 5;
  
  const { optimal, allResults } = RangeOptimizer.findOptimalRange(
    prices,
    entryPrice,
    realAPR,
    targetAPY,
    rangeWidths,
    incentiveAPR,
    fundingAPR
  );

  // Display results
  console.log('='.repeat(80));
  console.log('📊 RANGE OPTIMIZATION RESULTS');
  console.log('='.repeat(80) + '\n');

  console.log('Range Width | APY    | IL      | Rebalances | Fee Capture | Drawdown');
  console.log('-'.repeat(80));
  
  allResults.forEach(result => {
    const isOptimal = result.rangeWidth === optimal.rangeWidth;
    const marker = isOptimal ? '⭐' : '  ';
    console.log(
      `${marker} ±${(result.rangeWidth * 100).toFixed(0).padStart(2)}%   | ` +
      `${result.annualizedReturn.toFixed(1).padStart(5)}% | ` +
      `${result.avgIL.toFixed(2).padStart(6)}% | ` +
      `${result.rebalanceCount.toString().padStart(10)} | ` +
      `${result.feeCapture.toFixed(1).padStart(10)}% | ` +
      `${result.maxDrawdown.toFixed(1).padStart(7)}%`
    );
  });

  console.log('\n' + '='.repeat(80));
  console.log('⭐ OPTIMAL RANGE FOR 40% APY TARGET');
  console.log('='.repeat(80) + '\n');

  console.log(`Range Width: ±${(optimal.rangeWidth * 100).toFixed(0)}%`);
  console.log(`Annualized Return: ${optimal.annualizedReturn.toFixed(2)}% APY`);
  console.log(`Total Return: ${optimal.totalReturn.toFixed(2)}%`);
  console.log(`Final Value: $${optimal.finalValue.toFixed(2)}`);
  console.log(`\nImpermanent Loss:`);
  console.log(`   Total IL: ${optimal.totalIL.toFixed(2)}%`);
  console.log(`   Average Daily IL: ${optimal.avgIL.toFixed(3)}%`);
  console.log(`\nRebalancing:`);
  console.log(`   Total Rebalances: ${optimal.rebalanceCount}`);
  console.log(`   Rebalance Rate: ${optimal.rebalanceRate.toFixed(1)} per year`);
  console.log(`   Estimated Gas Cost: $${(optimal.rebalanceCount * 50).toFixed(2)}`);
  console.log(`\nFee Capture:`);
  console.log(`   Time in Range: ${optimal.feeCapture.toFixed(1)}%`);
  console.log(`   Real APR: ${realAPR.toFixed(2)}%`);
  console.log(`   Incentive APR: ${incentiveAPR.toFixed(2)}%`);
  console.log(`   Funding APR: ${fundingAPR.toFixed(2)}%`);
  console.log(`   Total APR: ${(realAPR + incentiveAPR + fundingAPR).toFixed(2)}%`);
  console.log(`   Effective APR (with fee capture): ${((realAPR + incentiveAPR + fundingAPR) * optimal.feeCapture / 100).toFixed(2)}%`);
  console.log(`\nRisk:`);
  console.log(`   Max Drawdown: ${optimal.maxDrawdown.toFixed(2)}%`);

  // Now run actual backtest with optimal range
  console.log('\n' + '='.repeat(80));
  console.log('🚀 Running Backtest with Optimal Range');
  console.log('='.repeat(80) + '\n');

  const useCase = new RunBacktestUseCase();

  const result = await useCase.execute({
    startDate,
    endDate,
    initialCapital: 100000,
    strategies: [
      {
        strategy: new VolatilePairStrategy('vp1', 'ETH/USDC Volatile Pair'),
        config: mergeWithDefaults('volatile-pair', {
          pair: 'ETH-USDC',
          rangeWidth: optimal.rangeWidth, // Use optimal range
          ammFeeAPR: realAPR, // Use real APR
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
          lpRangeWidth: optimal.rangeWidth * 0.6, // Slightly narrower for options
          optionStrikeDistance: 0.05,
          allocation: 0.3,
        }),
        allocation: 0.3,
      },
    ],
    customDataAdapter: adapter,
    calculateIV: true,
    useRealFees: true,
    applyIL: true,
    applyCosts: true,
    costModel: {
      slippageBps: 10,
      gasCostUSD: 50,
    },
    outputPath: './results-optimal-range.json',
  });

  const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
  const annualizedReturn = result.metrics.totalReturn;

  console.log('\n📊 BACKTEST RESULTS WITH OPTIMAL RANGE:\n');
  console.log(`   Initial Capital: $100,000`);
  console.log(`   Final Value: $${result.metrics.finalValue.toFixed(2)}`);
  console.log(`   Total Return: ${result.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Annualized Return: ${annualizedReturn.toFixed(2)}% APY`);
  console.log(`   Sharpe Ratio: ${result.metrics.sharpeRatio.toFixed(4)}`);
  console.log(`   Max Drawdown: ${result.metrics.maxDrawdown.toFixed(2)}%`);
  console.log(`   Total Trades: ${result.trades.length}`);
  console.log(`   Final Positions: ${result.positions.length}`);

  console.log('\n📋 STRATEGIES TESTED:');
  console.log('   1. Volatile Pair Strategy (ETH/USDC)');
  console.log(`      - Range: ±${(optimal.rangeWidth * 100).toFixed(0)}%`);
  console.log(`      - Allocation: 40%`);
  console.log(`      - Real APR: ${realAPR.toFixed(2)}%`);
  console.log('   2. Options Overlay Strategy (ETH/USDC)');
  console.log(`      - Range: ±${(optimal.rangeWidth * 0.6 * 100).toFixed(0)}%`);
  console.log(`      - Allocation: 30%`);
  console.log(`      - Real APR: ${realAPR.toFixed(2)}%`);

  console.log('\n💡 RECOMMENDATION:');
  if (annualizedReturn >= targetAPY) {
    console.log(`   ✅ Optimal range (±${(optimal.rangeWidth * 100).toFixed(0)}%) achieves ${annualizedReturn.toFixed(1)}% APY`);
    console.log(`   ✅ Exceeds target of ${targetAPY}% APY`);
  } else {
    console.log(`   ⚠️  Optimal range (±${(optimal.rangeWidth * 100).toFixed(0)}%) achieves ${annualizedReturn.toFixed(1)}% APY`);
    console.log(`   ⚠️  Below target of ${targetAPY}% APY`);
    console.log(`   💡 Consider: Narrower ranges, leverage, or higher incentive APRs`);
  }

  console.log(`\n📁 Results saved to: ./results-optimal-range.json`);
}

optimizeRangeForAPY().catch(console.error);

