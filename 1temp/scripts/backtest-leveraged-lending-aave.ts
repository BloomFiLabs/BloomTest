/**
 * Leveraged Lending Strategy Backtest with Aave v3 Data
 * 
 * Compares static APR assumptions vs. dynamic Aave rates
 */

import * as dotenv from 'dotenv';
import { AaveV3Adapter, ReserveRateData } from '../src/infrastructure/adapters/data/AaveV3Adapter';

dotenv.config();

interface BacktestConfig {
  asset: string;
  assetAddress: string;
  leverage: number;
  initialCapital: number;
  startDate: Date;
  endDate: Date;
}

interface BacktestResult {
  date: Date;
  capital: number;
  supplyAPR: number;
  borrowAPR: number;
  incentiveAPR: number;
  netAPY: number;
  cumulativeReturn: number;
}

async function runBacktest(
  config: BacktestConfig,
  rates: ReserveRateData[]
): Promise<BacktestResult[]> {
  const results: BacktestResult[] = [];
  let currentCapital = config.initialCapital;

  for (const rate of rates) {
    // Calculate daily return
    const grossYield = (rate.supplyAPR + rate.incentiveAPR) * config.leverage;
    const borrowCost = rate.borrowAPR * (config.leverage - 1);
    const netAPY = grossYield - borrowCost;
    
    // Compound daily
    const dailyReturn = netAPY / 365 / 100;
    currentCapital = currentCapital * (1 + dailyReturn);
    
    const cumulativeReturn = ((currentCapital - config.initialCapital) / config.initialCapital) * 100;

    results.push({
      date: rate.date,
      capital: currentCapital,
      supplyAPR: rate.supplyAPR,
      borrowAPR: rate.borrowAPR,
      incentiveAPR: rate.incentiveAPR,
      netAPY,
      cumulativeReturn,
    });
  }

  return results;
}

function calculateStaticBacktest(
  config: BacktestConfig,
  staticSupplyAPR: number,
  staticBorrowAPR: number,
  staticIncentiveAPR: number,
  numDays: number
): { finalCapital: number; netAPY: number; cumulativeReturn: number } {
  const grossYield = (staticSupplyAPR + staticIncentiveAPR) * config.leverage;
  const borrowCost = staticBorrowAPR * (config.leverage - 1);
  const netAPY = grossYield - borrowCost;
  
  let capital = config.initialCapital;
  const dailyReturn = netAPY / 365 / 100;
  
  for (let i = 0; i < numDays; i++) {
    capital = capital * (1 + dailyReturn);
  }
  
  const cumulativeReturn = ((capital - config.initialCapital) / config.initialCapital) * 100;
  
  return { finalCapital: capital, netAPY, cumulativeReturn };
}

async function main() {
  console.log('='.repeat(80));
  console.log('LEVERAGED LENDING STRATEGY BACKTEST (Aave v3)');
  console.log('='.repeat(80));

  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    console.error('❌ THE_GRAPH_API_KEY not set in environment');
    process.exit(1);
  }

  const adapter = new AaveV3Adapter({ apiKey });

  // Backtest configuration
  // Note: Using Base network USDC address (subgraph is Aave v3 on Base)
  const config: BacktestConfig = {
    asset: 'USDC',
    assetAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base USDC
    leverage: 3,
    initialCapital: 1_000_000, // $1M
    startDate: new Date('2024-09-01'), // Aave v3 Base launched Sept 2024
    endDate: new Date('2024-11-15'),
  };

  console.log('\n📋 Configuration:');
  console.log('─'.repeat(80));
  console.log(`  Asset:            ${config.asset}`);
  console.log(`  Leverage:         ${config.leverage}x`);
  console.log(`  Initial Capital:  $${(config.initialCapital / 1_000_000).toFixed(1)}M`);
  console.log(`  Period:           ${config.startDate.toISOString().split('T')[0]} → ${config.endDate.toISOString().split('T')[0]}`);

  // Fetch historical rates
  console.log('\n📡 Fetching historical Aave rates...\n');
  
  try {
    const rates = await adapter.fetchReserveRatesHistory(
      config.assetAddress,
      config.startDate,
      config.endDate
    );

    if (rates.length === 0) {
      console.error('❌ No rate data available for this period');
      process.exit(1);
    }

    console.log(`✅ Retrieved ${rates.length} daily rate points\n`);

    // Run dynamic backtest
    console.log('🔄 Running dynamic rate backtest...\n');
    const dynamicResults = await runBacktest(config, rates);

    // Calculate average rates for static comparison
    const stats = adapter.getRateStatistics(rates);
    const staticSupplyAPR = stats.supplyAPR.avg;
    const staticBorrowAPR = stats.borrowAPR.avg;
    const staticIncentiveAPR = stats.incentiveAPR.avg;

    // Run static backtest
    const staticResults = calculateStaticBacktest(
      config,
      staticSupplyAPR,
      staticBorrowAPR,
      staticIncentiveAPR,
      rates.length
    );

    // Display results
    console.log('='.repeat(80));
    console.log('BACKTEST RESULTS');
    console.log('='.repeat(80));

    const finalDynamic = dynamicResults[dynamicResults.length - 1];

    console.log('\n📊 Static APR Model (using period averages):');
    console.log('─'.repeat(80));
    console.log(`  Supply APR:       ${staticSupplyAPR.toFixed(2)}%`);
    console.log(`  Borrow APR:       ${staticBorrowAPR.toFixed(2)}%`);
    console.log(`  Incentive APR:    ${staticIncentiveAPR.toFixed(2)}%`);
    console.log(`  Net APY:          ${staticResults.netAPY.toFixed(2)}%`);
    console.log(`  Final Capital:    $${(staticResults.finalCapital / 1_000_000).toFixed(3)}M`);
    console.log(`  Total Return:     ${staticResults.cumulativeReturn >= 0 ? '+' : ''}${staticResults.cumulativeReturn.toFixed(2)}%`);

    console.log('\n📈 Dynamic Aave Rates Model (actual historical rates):');
    console.log('─'.repeat(80));
    console.log(`  Avg Supply APR:   ${stats.supplyAPR.avg.toFixed(2)}%`);
    console.log(`  Avg Borrow APR:   ${stats.borrowAPR.avg.toFixed(2)}%`);
    console.log(`  Avg Incentive:    ${stats.incentiveAPR.avg.toFixed(2)}%`);
    console.log(`  Avg Net APY:      ${(dynamicResults.reduce((sum, r) => sum + r.netAPY, 0) / dynamicResults.length).toFixed(2)}%`);
    console.log(`  Final Capital:    $${(finalDynamic.capital / 1_000_000).toFixed(3)}M`);
    console.log(`  Total Return:     ${finalDynamic.cumulativeReturn >= 0 ? '+' : ''}${finalDynamic.cumulativeReturn.toFixed(2)}%`);

    console.log('\n🔍 Comparison:');
    console.log('─'.repeat(80));
    const returnDiff = finalDynamic.cumulativeReturn - staticResults.cumulativeReturn;
    const capitalDiff = finalDynamic.capital - staticResults.finalCapital;
    console.log(`  Return Difference: ${returnDiff >= 0 ? '+' : ''}${returnDiff.toFixed(2)}%`);
    console.log(`  Capital Difference: $${(capitalDiff / 1000).toFixed(2)}K`);

    // Show volatility
    const netAPYs = dynamicResults.map(r => r.netAPY);
    const avgAPY = netAPYs.reduce((sum, apy) => sum + apy, 0) / netAPYs.length;
    const variance = netAPYs.reduce((sum, apy) => sum + Math.pow(apy - avgAPY, 2), 0) / netAPYs.length;
    const stdDev = Math.sqrt(variance);

    console.log('\n📉 Rate Volatility:');
    console.log('─'.repeat(80));
    console.log(`  Min Net APY:      ${Math.min(...netAPYs).toFixed(2)}%`);
    console.log(`  Max Net APY:      ${Math.max(...netAPYs).toFixed(2)}%`);
    console.log(`  Std Deviation:    ${stdDev.toFixed(2)}%`);

    // Show recent performance (last 30 days)
    console.log('\n📅 Recent Performance (Last 30 Days):');
    console.log('─'.repeat(80));
    console.log('Date         Supply   Borrow   Incentive  Net APY   Capital     Return');
    console.log('─'.repeat(80));

    const recentResults = dynamicResults.slice(-30);
    recentResults.forEach(r => {
      const dateStr = r.date.toISOString().split('T')[0];
      console.log(
        `${dateStr}  ` +
        `${r.supplyAPR.toFixed(2).padStart(5)}%  ` +
        `${r.borrowAPR.toFixed(2).padStart(5)}%  ` +
        `${r.incentiveAPR.toFixed(2).padStart(6)}%   ` +
        `${r.netAPY >= 0 ? '+' : ''}${r.netAPY.toFixed(2).padStart(6)}%  ` +
        `$${(r.capital / 1_000_000).toFixed(3)}M  ` +
        `${r.cumulativeReturn >= 0 ? '+' : ''}${r.cumulativeReturn.toFixed(2)}%`
      );
    });

    // Leverage sensitivity analysis
    console.log('\n💡 Leverage Sensitivity Analysis (using avg rates):');
    console.log('─'.repeat(80));
    console.log('Leverage  Net APY   Final Capital  Total Return');
    console.log('─'.repeat(80));

    for (let lev = 1; lev <= 5; lev++) {
      const configCopy = { ...config, leverage: lev };
      const result = calculateStaticBacktest(
        configCopy,
        staticSupplyAPR,
        staticBorrowAPR,
        staticIncentiveAPR,
        rates.length
      );
      console.log(
        `${lev}x        ` +
        `${result.netAPY >= 0 ? '+' : ''}${result.netAPY.toFixed(2).padStart(6)}%  ` +
        `$${(result.finalCapital / 1_000_000).toFixed(3)}M       ` +
        `${result.cumulativeReturn >= 0 ? '+' : ''}${result.cumulativeReturn.toFixed(2)}%`
      );
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ Backtest Complete');
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

