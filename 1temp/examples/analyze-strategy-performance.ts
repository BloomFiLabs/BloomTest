/**
 * Analyze individual strategy performance from backtest results
 */

import 'dotenv/config';
import * as fs from 'fs';

interface Position {
  id: string;
  asset: string;
  strategyId: string;
  amount: { value: number };
  entryPrice: { value: number };
  currentPrice: { value: number };
}

interface BacktestResult {
  positions: Position[];
  trades: Array<{ strategyId: string; asset: string; side: string; amount: { value: number } }>;
  metrics: {
    totalReturn: number;
    finalValue: number;
  };
  historicalValues: number[];
}

function analyzeStrategyPerformance() {
  console.log('📊 Strategy Performance Analysis\n');
  console.log('='.repeat(60) + '\n');

  // Read results
  let results: BacktestResult;
  try {
    const data = fs.readFileSync('./results-extended.json', 'utf-8');
    results = JSON.parse(data);
  } catch (error) {
    console.log('❌ Could not read results-extended.json');
    console.log('   Run: npx tsx examples/backtest-with-extrapolation.ts');
    process.exit(1);
  }

  // Group positions by strategy
  const strategyPositions = new Map<string, Position[]>();
  results.positions.forEach(pos => {
    if (!strategyPositions.has(pos.strategyId)) {
      strategyPositions.set(pos.strategyId, []);
    }
    strategyPositions.get(pos.strategyId)!.push(pos);
  });

  // Group trades by strategy
  const strategyTrades = new Map<string, typeof results.trades>();
  results.trades.forEach(trade => {
    if (!strategyTrades.has(trade.strategyId)) {
      strategyTrades.set(trade.strategyId, []);
    }
    strategyTrades.get(trade.strategyId)!.push(trade);
  });

  // Calculate performance per strategy
  console.log('📈 INDIVIDUAL STRATEGY PERFORMANCE:\n');

  let totalStrategyValue = 0;
  const strategyMetrics = new Map<string, {
    name: string;
    positions: number;
    trades: number;
    totalValue: number;
    totalPnL: number;
    return: number;
  }>();

  strategyPositions.forEach((positions, strategyId) => {
    const trades = strategyTrades.get(strategyId) || [];
    
    // Calculate total value and PnL for this strategy
    let strategyValue = 0;
    let strategyPnL = 0;
    let strategyEntryValue = 0;

    positions.forEach(pos => {
      const entryValue = pos.amount.value * pos.entryPrice.value;
      const currentValue = pos.amount.value * pos.currentPrice.value;
      const pnl = currentValue - entryValue;
      
      strategyValue += currentValue;
      strategyPnL += pnl;
      strategyEntryValue += entryValue;
    });

    const returnPct = strategyEntryValue > 0 ? (strategyPnL / strategyEntryValue) * 100 : 0;
    totalStrategyValue += strategyValue;

    // Map strategy IDs to names
    const strategyNames: Record<string, string> = {
      'vp1': 'Volatile Pair Strategy (ETH/USDC)',
      'op1': 'Options Overlay Strategy (ETH/USDC)',
      'test': 'Test Strategy',
    };

    strategyMetrics.set(strategyId, {
      name: strategyNames[strategyId] || strategyId,
      positions: positions.length,
      trades: trades.length,
      totalValue: strategyValue,
      totalPnL: strategyPnL,
      return: returnPct,
    });
  });

  // Display results
  strategyMetrics.forEach((metrics, strategyId) => {
    console.log(`🔹 ${metrics.name}`);
    console.log(`   Strategy ID: ${strategyId}`);
    console.log(`   Positions: ${metrics.positions}`);
    console.log(`   Trades: ${metrics.trades}`);
    console.log(`   Total Value: $${metrics.totalValue.toFixed(2)}`);
    console.log(`   Total PnL: $${metrics.totalPnL.toFixed(2)}`);
    console.log(`   Return: ${metrics.return.toFixed(2)}%`);
    console.log('');
  });

  // Overall metrics
  console.log('='.repeat(60));
  console.log('\n📊 OVERALL BACKTEST METRICS:\n');
  console.log(`   Total Return: ${results.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Final Portfolio Value: $${results.metrics.finalValue.toFixed(2)}`);
  console.log(`   Total Positions: ${results.positions.length}`);
  console.log(`   Total Trades: ${results.trades.length}`);
  console.log(`   Strategy Value: $${totalStrategyValue.toFixed(2)}`);

  // Historical performance
  if (results.historicalValues && results.historicalValues.length > 0) {
    const initialValue = results.historicalValues[0];
    const finalValue = results.historicalValues[results.historicalValues.length - 1];
    const days = results.historicalValues.length - 1;
    const annualizedReturn = days > 0 ? ((finalValue / initialValue) ** (365 / days) - 1) * 100 : 0;
    
    console.log(`\n📅 HISTORICAL PERFORMANCE:`);
    console.log(`   Days: ${days}`);
    console.log(`   Initial Value: $${initialValue.toFixed(2)}`);
    console.log(`   Final Value: $${finalValue.toFixed(2)}`);
    console.log(`   Annualized Return: ${annualizedReturn.toFixed(2)}%`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('\n💡 BACKTEST ACCURACY NOTES:\n');
  console.log('   1. Data Source: Uniswap V4 subgraph (Sep 9 - Nov 15, 2025)');
  console.log('   2. Data Extrapolation: Used historical patterns to extend to full year');
  console.log('   3. Yield Accrual: Daily compounding based on strategy APRs');
  console.log('   4. Price Assumptions: LP positions priced at $1.0 (USD value)');
  console.log('   5. Limitations:');
  console.log('      - Extrapolated data assumes historical patterns continue');
  console.log('      - Yield rates are estimates, not actual on-chain fees');
  console.log('      - No slippage or gas costs applied');
  console.log('      - No impermanent loss calculations');
  console.log('      - Simplified position management');
}

analyzeStrategyPerformance();

