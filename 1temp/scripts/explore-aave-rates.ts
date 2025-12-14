/**
 * Aave v3 Rate Exploration Script
 * 
 * Query and analyze historical lending/borrowing rates from Aave v3
 */

import * as dotenv from 'dotenv';
import { AaveV3Adapter } from '../src/infrastructure/adapters/data/AaveV3Adapter';

dotenv.config();

async function main() {
  console.log('='.repeat(80));
  console.log('AAVE V3 RATE EXPLORATION');
  console.log('='.repeat(80));

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.error('❌ THE_GRAPH_API_KEY not set in environment');
    process.exit(1);
  }

  const adapter = new AaveV3Adapter({ apiKey });

  // Step 1: Fetch available reserves
  console.log('\n📊 Step 1: Fetching available Aave v3 reserves...\n');
  
  try {
    const reserves = await adapter.fetchCurrentReserves();
    console.log(`✅ Found ${reserves.length} active reserves\n`);
    
    // Show top reserves by common usage
    const topReserves = reserves
      .filter(r => ['USDC', 'USDT', 'WETH', 'DAI', 'WBTC'].includes(r.symbol))
      .slice(0, 10);
    
    console.log('Top Reserves:');
    console.log('─'.repeat(80));
    topReserves.forEach(r => {
      console.log(`  ${r.symbol.padEnd(8)} ${r.name.padEnd(30)} ${r.address}`);
    });
    console.log('');

    // Step 2: Query rate history for USDC (6 months)
    const usdcReserve = topReserves.find(r => r.symbol === 'USDC');
    if (!usdcReserve) {
      console.error('❌ USDC reserve not found');
      return;
    }

    console.log('\n📈 Step 2: Fetching USDC rate history (Sept-Nov 2024)...\n');
    
    const endDate = new Date('2024-11-15');
    const startDate = new Date('2024-09-01'); // Aave v3 Base launched Sept 2024

    const rates = await adapter.fetchReserveRatesHistory(
      usdcReserve.address,
      startDate,
      endDate
    );

    if (rates.length === 0) {
      console.log('⚠️  No rate data found for this period');
      return;
    }

    console.log(`✅ Retrieved ${rates.length} daily rate points\n`);

    // Step 3: Calculate statistics
    console.log('\n📊 Step 3: Rate Statistics\n');
    console.log('='.repeat(80));
    
    const stats = adapter.getRateStatistics(rates);

    console.log('\nSupply APR:');
    console.log('─'.repeat(80));
    console.log(`  Min:    ${stats.supplyAPR.min.toFixed(2)}%`);
    console.log(`  P50:    ${stats.supplyAPR.p50.toFixed(2)}%`);
    console.log(`  P75:    ${stats.supplyAPR.p75.toFixed(2)}%`);
    console.log(`  P90:    ${stats.supplyAPR.p90.toFixed(2)}%`);
    console.log(`  Max:    ${stats.supplyAPR.max.toFixed(2)}%`);
    console.log(`  Avg:    ${stats.supplyAPR.avg.toFixed(2)}%`);

    console.log('\nBorrow APR:');
    console.log('─'.repeat(80));
    console.log(`  Min:    ${stats.borrowAPR.min.toFixed(2)}%`);
    console.log(`  P50:    ${stats.borrowAPR.p50.toFixed(2)}%`);
    console.log(`  P75:    ${stats.borrowAPR.p75.toFixed(2)}%`);
    console.log(`  P90:    ${stats.borrowAPR.p90.toFixed(2)}%`);
    console.log(`  Max:    ${stats.borrowAPR.max.toFixed(2)}%`);
    console.log(`  Avg:    ${stats.borrowAPR.avg.toFixed(2)}%`);

    console.log('\nIncentive APR:');
    console.log('─'.repeat(80));
    console.log(`  Min:    ${stats.incentiveAPR.min.toFixed(2)}%`);
    console.log(`  Max:    ${stats.incentiveAPR.max.toFixed(2)}%`);
    console.log(`  Avg:    ${stats.incentiveAPR.avg.toFixed(2)}%`);

    // Step 4: Show recent trends
    console.log('\n📈 Step 4: Recent Trends (Last 30 Days)\n');
    console.log('='.repeat(80));
    
    const recentRates = rates.slice(-30);
    console.log('\nDate         Supply APR  Borrow APR  Incentive APR  Net Spread');
    console.log('─'.repeat(80));
    
    recentRates.forEach(r => {
      const spread = r.supplyAPR + r.incentiveAPR - r.borrowAPR;
      const dateStr = r.date.toISOString().split('T')[0];
      console.log(
        `${dateStr}  ` +
        `${r.supplyAPR.toFixed(2).padStart(6)}%    ` +
        `${r.borrowAPR.toFixed(2).padStart(6)}%    ` +
        `${r.incentiveAPR.toFixed(2).padStart(8)}%    ` +
        `${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%`
      );
    });

    // Step 5: Calculate leveraged lending yield (3x leverage)
    console.log('\n💰 Step 5: Leveraged Lending Analysis (3x Leverage)\n');
    console.log('='.repeat(80));
    
    const leverage = 3;
    const avgSupplyAPR = stats.supplyAPR.avg;
    const avgBorrowAPR = stats.borrowAPR.avg;
    const avgIncentiveAPR = stats.incentiveAPR.avg;
    
    const grossYield = (avgSupplyAPR + avgIncentiveAPR) * leverage;
    const borrowCost = avgBorrowAPR * (leverage - 1);
    const netYield = grossYield - borrowCost;

    console.log(`\nLeverage:           ${leverage}x`);
    console.log(`Supply APR:         ${avgSupplyAPR.toFixed(2)}%`);
    console.log(`Incentive APR:      ${avgIncentiveAPR.toFixed(2)}%`);
    console.log(`Borrow APR:         ${avgBorrowAPR.toFixed(2)}%`);
    console.log('─'.repeat(80));
    console.log(`Gross Yield:        ${grossYield.toFixed(2)}%`);
    console.log(`Borrow Cost:        ${borrowCost.toFixed(2)}%`);
    console.log(`Net Yield:          ${netYield.toFixed(2)}%`);

    // Compare at different leverage levels
    console.log('\n\nYield at Different Leverage Levels:');
    console.log('─'.repeat(80));
    console.log('Leverage  Gross Yield  Borrow Cost  Net Yield');
    console.log('─'.repeat(80));
    
    for (let lev = 1; lev <= 5; lev++) {
      const gross = (avgSupplyAPR + avgIncentiveAPR) * lev;
      const cost = avgBorrowAPR * (lev - 1);
      const net = gross - cost;
      console.log(
        `${lev}x        ` +
        `${gross.toFixed(2).padStart(6)}%     ` +
        `${cost.toFixed(2).padStart(6)}%     ` +
        `${net >= 0 ? '+' : ''}${net.toFixed(2)}%`
      );
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ Analysis Complete');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ Error:', error);
    if (error instanceof Error) {
      console.error('   Message:', error.message);
    }
    process.exit(1);
  }
}

main();

