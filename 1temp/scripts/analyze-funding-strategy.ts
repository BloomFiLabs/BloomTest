#!/usr/bin/env tsx
import * as fs from 'fs';
import * as path from 'path';

const resultsPath = path.join(process.cwd(), 'results', 'main-backtest.json');
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));

console.log('\n' + '='.repeat(80));
console.log('🔍 FUNDING RATE CAPTURE STRATEGY - DETAILED ANALYSIS');
console.log('='.repeat(80) + '\n');

// Find funding strategy trades
const fundingTrades = results.trades.filter((t: any) => t.strategyId === 'eth-funding');
const fundingPosition = results.positions.find((p: any) => p.strategyId === 'eth-funding');

if (fundingTrades.length === 0) {
  console.log('❌ No funding strategy trades found. Strategy did not execute.');
  console.log('\nPossible reasons:');
  console.log('  • Funding rates were negative or below threshold for entire backtest period');
  console.log('  • Strategy configuration prevented execution');
  process.exit(0);
}

console.log('📊 TRADE HISTORY:');
fundingTrades.forEach((trade: any, i: number) => {
  const date = new Date(trade.timestamp);
  console.log(`  ${i + 1}. ${date.toISOString().split('T')[0]} - ${trade.type || 'Entry'}`);
  console.log(`     Amount: $${trade.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`     Price: $${trade.price.toFixed(4)}`);
});

console.log('\n📈 POSITION DETAILS:');
if (fundingPosition) {
  console.log(`  Asset: ${fundingPosition.asset}`);
  console.log(`  Entry Date: ${fundingTrades[0] ? new Date(fundingTrades[0].timestamp).toISOString().split('T')[0] : 'Unknown'}`);
  console.log(`  Initial Amount: $${fundingTrades[0]?.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || 'Unknown'}`);
  console.log(`  Final Amount: $${fundingPosition.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`  Entry Price: $${fundingPosition.entryPrice?.toFixed(4) || '1.0000'}`);
  console.log(`  Current Price: $${fundingPosition.currentPrice?.toFixed(4) || '1.0000'}`);
} else {
  console.log('  ❌ No position found (may have been closed)');
}

// Calculate actual performance
const entryDate = new Date(fundingTrades[0].timestamp);
const backTestStart = new Date('2025-05-25');
const backTestEnd = new Date('2025-08-22');
const daysInBacktest = (backTestEnd.getTime() - backTestStart.getTime()) / (1000 * 60 * 60 * 24);
const daysActive = (backTestEnd.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24);

const initialValue = fundingTrades[0].amount;
const finalValue = fundingPosition?.amount || 0;
const pnl = finalValue - initialValue;
const returnPct = (pnl / initialValue) * 100;
const annualizedAPY = daysActive > 0 ? (returnPct / daysActive) * 365 : 0;

console.log('\n💰 PERFORMANCE METRICS:');
console.log(`  Backtest Duration: ${daysInBacktest.toFixed(0)} days`);
console.log(`  Strategy Active: ${daysActive.toFixed(1)} days (${(daysActive/daysInBacktest*100).toFixed(1)}% of backtest)`);
console.log(`  Initial Capital: $${initialValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
console.log(`  Final Value: $${finalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
console.log(`  PnL: $${pnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%)`);
console.log(`  Annualized APY: ${annualizedAPY >= 0 ? '+' : ''}${annualizedAPY.toFixed(2)}%`);

console.log('\n🎯 EXPECTED VS ACTUAL:');
console.log(`  Expected Net Yield: 17% APR`);
console.log(`    • Funding Rate: 11% * 3x leverage = 33% APR`);
console.log(`    • Borrow Cost: 8% * 2x debt = 16% APR`);
console.log(`    • Net: 33% - 16% = 17% APR`);
console.log(`  Expected Return (${daysActive.toFixed(1)} days): $${(initialValue * 0.17 * daysActive / 365).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
console.log(`  Actual Return: $${pnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

const variance = ((pnl - (initialValue * 0.17 * daysActive / 365)) / initialValue) * 100;
console.log(`  Variance: ${variance >= 0 ? '+' : ''}${variance.toFixed(2)}%`);

console.log('\n' + '='.repeat(80));
console.log('⚠️  KEY FINDINGS:');
console.log('─'.repeat(80));
if (daysActive < daysInBacktest * 0.5) {
  console.log(`❗ Strategy was only active for ${(daysActive/daysInBacktest*100).toFixed(0)}% of the backtest period!`);
  console.log('   This suggests funding rates were unfavorable (negative or below threshold)');
  console.log('   for most of the backtest, limiting profitability.');
}

const portfolioGrowthFactor = initialValue / 20000;
if (portfolioGrowthFactor > 1.5) {
  console.log(`❗ Initial capital was $${initialValue.toFixed(0)}, not $20,000!`);
  console.log(`   The strategy entered late, after portfolio grew ${((portfolioGrowthFactor - 1) * 100).toFixed(0)}%.`);
  console.log('   This inflates the absolute dollar returns but doesn\'t reflect the');
  console.log('   strategy\'s actual performance on the intended $20k allocation.');
}

if (Math.abs(returnPct) < 1) {
  console.log(`❗ Return was only ${returnPct.toFixed(2)}% over ${daysActive.toFixed(1)} days.`);
  console.log('   This is close to zero, suggesting minimal yield accrual.');
}

console.log('='.repeat(80) + '\n');






