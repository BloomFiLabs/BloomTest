#!/usr/bin/env tsx
/**
 * Backtest Script: Synthetix Funding Rate Capture Strategy
 * 
 * This script demonstrates:
 * 1. Fetching historical funding rates from Synthetix subgraph
 * 2. Backtesting a delta-neutral funding rate capture strategy
 * 3. Calculating realistic net APY including costs
 * 
 * Strategy:
 * - Long spot (or spot-equivalent like stETH) + Short perp
 * - Collect funding payments when positive
 * - 2x leverage with health factor management
 * - 15% allocation of capital
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { SynthetixFundingRatesAdapter } from '../src/infrastructure/adapters/data/SynthetixFundingRatesAdapter';
import { FundingRateCaptureStrategy, FundingRateConfig } from '../src/infrastructure/adapters/strategies/FundingRateCaptureStrategy';
import { Portfolio } from '../src/domain/entities/Portfolio';
import { Amount, Price, FundingRate } from '../src/domain/value-objects';
import { MarketData } from '../src/domain/entities/Strategy';

interface BacktestResult {
  market: string;
  startDate: Date;
  endDate: Date;
  totalUpdates: number;
  avgFundingAPR: number;
  minFundingAPR: number;
  maxFundingAPR: number;
  p50FundingAPR: number;
  p90FundingAPR: number;
  estimatedNetAPY: number;
  leverage: number;
  allocation: number;
  initialCapital: number;
  finalCapital: number;
  totalPnL: number;
  totalPnLPercent: number;
}

async function backtestFundingRateCapture(
  adapter: SynthetixFundingRatesAdapter,
  marketKey: string,
  startDate: Date,
  endDate: Date,
  initialCapital: number = 1000000,
  allocation: number = 0.15,
  leverage: number = 2.0
): Promise<BacktestResult> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Backtesting Funding Rate Capture: ${marketKey}`);
  console.log(`Period: ${startDate.toISOString().split('T')[0]} → ${endDate.toISOString().split('T')[0]}`);
  console.log(`Initial Capital: $${initialCapital.toLocaleString()}`);
  console.log(`Allocation: ${(allocation * 100).toFixed(0)}%`);
  console.log(`Leverage: ${leverage}x`);
  console.log(`${'='.repeat(80)}\n`);

  // Fetch historical funding rates
  const updates = await adapter.fetchFundingHistory(marketKey, startDate, endDate);
  const stats = adapter.calculateStatistics(updates);

  console.log(`📊 Funding Rate Statistics:`);
  console.log(`   Total Updates: ${stats.totalUpdates}`);
  console.log(`   Average Funding APR: ${stats.avgFundingAPR.toFixed(2)}%`);
  console.log(`   Min Funding APR: ${stats.minFundingAPR.toFixed(2)}%`);
  console.log(`   Max Funding APR: ${stats.maxFundingAPR.toFixed(2)}%`);
  console.log(`   P50 (Median): ${stats.p50FundingAPR.toFixed(2)}%`);
  console.log(`   P90: ${stats.p90FundingAPR.toFixed(2)}%`);

  // Simulate strategy execution
  const strategy = new FundingRateCaptureStrategy('snx-funding-1', 'Synthetix Funding Capture');
  const portfolio = Portfolio.create({
    id: 'test-portfolio',
    initialCapital: Amount.create(initialCapital),
  });

  const config: FundingRateConfig = {
    asset: marketKey,
    fundingThreshold: 0.00005, // 0.005% per 8h (very low threshold)
    leverage,
    allocation,
    healthFactorThreshold: 1.5,
  };

  // Simulate daily execution (sample one update per day)
  const dailyUpdates = new Map<string, typeof updates[0]>();
  for (const update of updates) {
    const dateKey = update.timestamp.toISOString().split('T')[0];
    if (!dailyUpdates.has(dateKey)) {
      dailyUpdates.set(dateKey, update);
    }
  }

  let totalFundingPnL = 0;
  let positionDays = 0;
  let currentPosition: any = null;
  const assumedAssetPrice = 2000; // Assume constant price for simplicity

  console.log(`\n⚙️  Simulating Strategy...`);
  console.log(`   Sample Days: ${dailyUpdates.size}`);

  for (const [dateKey, update] of dailyUpdates.entries()) {
    const marketData: MarketData = {
      price: Price.create(assumedAssetPrice),
      timestamp: update.timestamp,
      fundingRate: FundingRate.create(update.fundingRatePerInterval),
    };

    const result = await strategy.execute(portfolio, marketData, config);

    if (result.positions.length > 0) {
      currentPosition = result.positions[0];
      positionDays++;

      // Calculate funding PnL for this interval (assuming 3 intervals per day)
      // Funding is paid/received on the notional amount
      const notional = currentPosition.amount.value;
      const fundingPnL = notional * update.fundingRatePerInterval * 3; // 3 intervals per day
      totalFundingPnL += fundingPnL;
    }
  }

  // Calculate estimated costs
  const notional = initialCapital * allocation * leverage;
  const entryExitCost = notional * 0.001; // 0.1% total trading fees (entry + exit)
  const gasCosts = 100; // $100 in gas for entering/exiting
  const borrowCosts = notional * 0.02 * (dailyUpdates.size / 365); // 2% annual borrow rate
  
  const totalCosts = entryExitCost + gasCosts + borrowCosts;
  const netPnL = totalFundingPnL - totalCosts;
  const netPnLPercent = (netPnL / initialCapital) * 100;

  // Annualize the return
  const periodDays = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
  const annualizedReturn = (netPnL / initialCapital) * (365 / periodDays) * 100;

  console.log(`\n💰 Backtest Results:`);
  console.log(`   Position Days: ${positionDays} / ${dailyUpdates.size}`);
  console.log(`   Gross Funding PnL: $${totalFundingPnL.toFixed(2)}`);
  console.log(`   Total Costs: $${totalCosts.toFixed(2)}`);
  console.log(`     - Trading Fees: $${entryExitCost.toFixed(2)}`);
  console.log(`     - Borrow Costs: $${borrowCosts.toFixed(2)}`);
  console.log(`     - Gas: $${gasCosts.toFixed(2)}`);
  console.log(`   Net PnL: $${netPnL.toFixed(2)} (${netPnLPercent.toFixed(2)}%)`);
  console.log(`   Annualized Return: ${annualizedReturn.toFixed(2)}%`);

  return {
    market: marketKey,
    startDate,
    endDate,
    totalUpdates: stats.totalUpdates,
    avgFundingAPR: stats.avgFundingAPR,
    minFundingAPR: stats.minFundingAPR,
    maxFundingAPR: stats.maxFundingAPR,
    p50FundingAPR: stats.p50FundingAPR,
    p90FundingAPR: stats.p90FundingAPR,
    estimatedNetAPY: annualizedReturn,
    leverage,
    allocation,
    initialCapital,
    finalCapital: initialCapital + netPnL,
    totalPnL: netPnL,
    totalPnLPercent: netPnLPercent,
  };
}

async function main() {
  const apiKey = process.env.THE_GRAPH_API_KEY;

  if (!apiKey) {
    console.error('❌ Error: THE_GRAPH_API_KEY not set in .env file');
    process.exit(1);
  }

  const adapter = new SynthetixFundingRatesAdapter({ apiKey });

  console.log('\n🔍 Fetching available Synthetix markets...');
  const markets = await adapter.fetchAvailableMarkets();
  
  console.log(`\n📋 Available Markets (${markets.length}):`);
  markets.slice(0, 10).forEach(m => {
    console.log(`   ${m.marketKey.padEnd(10)} - ${m.asset}`);
  });

  // Backtest sETH market
  const marketToTest = 'sETH';
  
  // Note: Synthetix Perps v3 is relatively new, so we'll test recent data
  // Adjust these dates based on when the protocol launched on your target chain
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 90); // Last 90 days

  try {
    const result = await backtestFundingRateCapture(
      adapter,
      marketToTest,
      startDate,
      endDate,
      1000000, // $1M capital
      0.15,    // 15% allocation
      2.0      // 2x leverage
    );

    console.log(`\n${'='.repeat(80)}`);
    console.log(`✅ Backtest Complete!`);
    console.log(`${'='.repeat(80)}`);
    console.log(`\n📈 Key Takeaways:`);
    console.log(`   - Average Funding APR: ${result.avgFundingAPR.toFixed(2)}%`);
    console.log(`   - Estimated Net APY: ${result.estimatedNetAPY.toFixed(2)}%`);
    console.log(`   - Total Return: ${result.totalPnLPercent.toFixed(2)}% over ${Math.floor((result.endDate.getTime() - result.startDate.getTime()) / (1000 * 60 * 60 * 24))} days`);
    console.log(`\n💡 Notes:`);
    console.log(`   - This is a delta-neutral strategy (long spot + short perp)`);
    console.log(`   - Returns come purely from funding rate arbitrage`);
    console.log(`   - Assumes constant asset price (no IL/liquidation risk modeled)`);
    console.log(`   - Actual returns may vary based on execution quality and market conditions`);
    console.log(``);

  } catch (error: any) {
    console.error(`\n❌ Backtest failed: ${error.message}`);
    if (error.message.includes('No funding rate data')) {
      console.log(`\n💡 Tip: Try adjusting the date range. Synthetix v3 may not have data for this period.`);
    }
  }
}

main().catch(console.error);



