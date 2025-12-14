#!/usr/bin/env node

// Simple calculation based on known Base pool APR
console.log('🌱 Base Network Performance Calculator\n');
console.log('='.repeat(80));

const poolAPR = 51.57; // From our query
const positionSize = 10000; // $10k
const periodDays = 90; // 90-day backtest

// Calculate gross fees
const annualFees = positionSize * (poolAPR / 100);
const dailyFees = annualFees / 365;
const periodFees = dailyFees * periodDays;

// Estimate costs (conservative)
const avgRebalancesPerDay = 1; // With 12h check interval and ±0.5-2% range
const totalRebalances = avgRebalancesPerDay * periodDays;
const gasCostPerRebalance = 0.50; // Base L2
const totalGasCosts = totalRebalances * gasCostPerRebalance;

// Pool swap fees (0.05% pool, swap ~50% on rebalance)
const swapFeesPerRebalance = (positionSize * 0.5) * 0.0005;
const totalSwapFees = swapFeesPerRebalance * totalRebalances;

// Total costs
const totalCosts = totalGasCosts + totalSwapFees;

// Net profit
const netProfit = periodFees - totalCosts;
const netProfitPercent = (netProfit / positionSize) * 100;

// Annualized
const annualizedReturn = (netProfit / positionSize) * (365 / periodDays) * 100;

console.log('📊 BASE NETWORK BACKTEST ESTIMATE (90 days)');
console.log('='.repeat(80));
console.log('');
console.log('📈 MARKET CONDITIONS:');
console.log(`   Pool: ETH/USDC 0.05% (Base)`);
console.log(`   Period: Aug 26 - Nov 24, 2025`);
console.log(`   Pool APR: ${poolAPR.toFixed(2)}%`);
console.log('');
console.log('💰 POSITION:');
console.log(`   Size: $${positionSize.toLocaleString()}`);
console.log(`   Strategy: Trend-Aware Concentrated LP`);
console.log(`   Check Interval: 12 hours`);
console.log(`   Range: ±0.5-2% (adaptive)`);
console.log('');
console.log('📊 REVENUE:');
console.log(`   Daily Fees: $${dailyFees.toFixed(2)}`);
console.log(`   90-Day Fees: $${periodFees.toFixed(2)}`);
console.log('');
console.log('💸 COSTS:');
console.log(`   Total Rebalances: ${totalRebalances}`);
console.log(`   Gas Costs: $${totalGasCosts.toFixed(2)} (${gasCostPerRebalance.toFixed(2)}/rebalance)`);
console.log(`   Swap Fees: $${totalSwapFees.toFixed(2)}`);
console.log(`   Total Costs: $${totalCosts.toFixed(2)}`);
console.log('');
console.log('💵 NET PERFORMANCE:');
console.log(`   Net Profit (90d): $${netProfit.toFixed(2)} (${netProfitPercent.toFixed(2)}%)`);
console.log(`   Annualized APY: ${annualizedReturn.toFixed(2)}%`);
console.log('');
console.log('='.repeat(80));
console.log('');

if (annualizedReturn > 30) {
  console.log('🎉 EXCELLENT! Strategy is highly profitable with 51% pool APR.');
} else if (annualizedReturn > 15) {
  console.log('✅ GOOD! Strategy is solidly profitable.');
} else if (annualizedReturn > 5) {
  console.log('�� MARGINAL. Strategy is profitable but not exceptional.');
} else if (annualizedReturn > 0) {
  console.log('⚠️  BARELY PROFITABLE. Consider larger position.');
} else {
  console.log('❌ UNPROFITABLE. Costs exceed revenue.');
}

console.log('');
console.log('💡 KEY INSIGHTS:');
console.log(`   • With ${poolAPR.toFixed(0)}% pool APR, $10k position earns ~$${annualFees.toFixed(0)}/year`);
console.log(`   • After ~${totalRebalances} rebalances and costs: ~$${(netProfit * (365/periodDays)).toFixed(0)}/year`);
console.log(`   • ROI: ${annualizedReturn.toFixed(1)}% annualized`);
console.log('');
console.log('📊 SCALING PROJECTIONS:');
console.log('');
console.log('   Position   | Gross Fees | Costs   | Net Profit | APY');
console.log('   ---------- | ---------- | ------- | ---------- | -------');

for (const size of [1000, 5000, 10000, 25000, 50000, 100000]) {
  const fees = size * (poolAPR / 100);
  const costs = totalCosts; // Fixed costs don't scale
  const profit = fees - (costs * (365 / periodDays));
  const apy = (profit / size) * 100;
  console.log(`   $${size.toLocaleString().padEnd(9)} | $${fees.toFixed(0).padEnd(9)} | $${(costs * (365/periodDays)).toFixed(0).padEnd(6)} | $${profit.toFixed(0).padEnd(9)} | ${apy.toFixed(1)}%`);
}

console.log('');
console.log('='.repeat(80));
