#!/usr/bin/env tsx
import * as fs from 'fs';
import * as path from 'path';

const resultsPath = path.join(process.cwd(), 'results', 'main-backtest.json');
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));

console.log('\n' + '='.repeat(80));
console.log('📊 STRATEGY PERFORMANCE BREAKDOWN');
console.log('='.repeat(80) + '\n');

const totalInitial = 100000;
const allocation = 0.20; // 20% each
const initialPerStrategy = totalInitial * allocation;

const positions = results.positions || [];
const strategyPerformance: Record<string, { name: string; initial: number; final: number }> = {};

// Map strategy IDs to readable names
const strategyNames: Record<string, string> = {
  'eth-usdc-opt': 'ETH/USDC Volatile Pair',
  'eth-usdt-opt': 'ETH/USDT Volatile Pair',
  'wbtc-usdc-opt': 'WBTC/USDC Volatile Pair',
  'wbtc-usdt-opt': 'WBTC/USDT Volatile Pair',
  'eth-funding': 'ETH Funding Capture (Delta Neutral)'
};

// Calculate final values per strategy
positions.forEach((pos: any) => {
  const strategyId = pos.strategyId;
  const finalValue = pos.amount * (pos.currentPrice || 1);
  
  if (!strategyPerformance[strategyId]) {
    strategyPerformance[strategyId] = {
      name: strategyNames[strategyId] || strategyId,
      initial: initialPerStrategy,
      final: 0
    };
  }
  
  strategyPerformance[strategyId].final = finalValue;
});

// Calculate metrics
let totalFinal = 0;
const strategies = Object.entries(strategyPerformance).map(([id, data]) => {
  const pnl = data.final - data.initial;
  const returnPct = (pnl / data.initial) * 100;
  
  // Assuming 90-day backtest (adjust based on actual duration)
  const durationDays = 90;
  const durationYears = durationDays / 365;
  const apy = (returnPct / durationYears);
  
  totalFinal += data.final;
  
  return {
    name: data.name,
    initial: data.initial,
    final: data.final,
    pnl,
    returnPct,
    apy
  };
});

// Sort by APY descending
strategies.sort((a, b) => b.apy - a.apy);

strategies.forEach((s) => {
  console.log(`${s.name}`);
  console.log(`   Initial Capital:  $${s.initial.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`   Final Value:      $${s.final.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`   PnL:              $${s.pnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${s.returnPct >= 0 ? '+' : ''}${s.returnPct.toFixed(2)}%)`);
  console.log(`   Annualized APY:   ${s.apy >= 0 ? '+' : ''}${s.apy.toFixed(2)}%`);
  console.log('');
});

console.log('─'.repeat(80));
console.log(`TOTAL PORTFOLIO`);
console.log(`   Initial Capital:  $${totalInitial.toLocaleString()}`);
console.log(`   Final Value:      $${totalFinal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
console.log(`   Total PnL:        $${(totalFinal - totalInitial).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
console.log(`   Portfolio Return: ${((totalFinal - totalInitial) / totalInitial * 100).toFixed(2)}%`);
console.log('='.repeat(80) + '\n');






