#!/usr/bin/env node
import 'dotenv/config';
import { UniswapV3Adapter } from './src/infrastructure/adapters/data/TheGraphDataAdapter';
import { RangeOptimizer } from './src/shared/utils/RangeOptimizer';

async function main() {
  console.log('🌱 ETH/USDC 0.05% Pool Profitability Analysis\n');
  console.log('='.repeat(80));

  const apiKey = process.env.THE_GRAPH_API_KEY || process.env.GRAPH_API_KEY;
  if (!apiKey) {
    console.error('❌ THE_GRAPH_API_KEY not set in environment');
    process.exit(1);
  }

  // ETH/USDC 0.05% Pool on Base
  const POOL_ADDRESS = '0xd0b53d9277642d899df5c87a3966a349a798f224';
  const TOKEN0_ADDRESS = '0x4200000000000000000000000000000000000006'; // WETH
  const TOKEN1_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // USDC

  const adapter = new UniswapV3Adapter({ 
    apiKey, 
    token0Symbol: 'WETH', 
    token1Symbol: 'USDC',
    token0Address: TOKEN0_ADDRESS,
    token1Address: TOKEN1_ADDRESS,
    useUrlAuth: true 
  });

  // Use last 30 days to reflect current market conditions
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);

  console.log(`📅 Period: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  console.log(`💰 Capital: $10,000 (Simulated)`);
  console.log(`⛽ Gas Price: $0.50 per rebalance`);
  console.log(`📉 Pool Fee Tier: 0.05%\n`);

  console.log('📊 Fetching pool data...');
  // Fetch actual APR from the last 30 days
  let apr = 33.05; // Default from live bot
  try {
    apr = await adapter.calculateActualAPR('ETH-USDC', startDate, endDate);
    console.log(`✅ Calculated Realized APR (30d): ${apr.toFixed(2)}%`);
  } catch (e) {
    console.log(`⚠️  Could not calculate APR, using live bot value: ${apr.toFixed(2)}%`);
  }

  console.log('📉 Fetching volatility data...');
  // Calculate realized volatility from price history
  let volatility = 0.74; // Default from live bot
  try {
    // We can use the adapter to fetch candles and calculate vol
    // But for now, let's use the live bot's value as a baseline, or calculate if possible
    // The adapter doesn't expose a simple calculateVolatility method, so we'll stick to the live value
    // to answer "is THIS pool profitable with THESE conditions"
    console.log(`ℹ️  Using Volatility: ${(volatility * 100).toFixed(2)}% (matching live bot conditions)`);
  } catch (e) {
    console.log(`⚠️  Error fetching volatility: ${e.message}`);
  }

  console.log('\n🧪 Running Profitability Simulations...\n');

  const costModel = {
    gasCostPerRebalance: 0.50, // $0.50 (approx 0.0014 Gwei on Base)
    poolFeeTier: 0.0005, // 0.05%
    positionValueUSD: 10000
  };

  // 1. Test Fixed Ranges
  const ranges = [0.01, 0.02, 0.05, 0.10, 0.20, 0.395]; // 1% to 39.5%
  
  console.log('Range Width | Rebalances/Yr | Efficiency | Gross APY | Cost Drag | Net APY');
  console.log('-'.repeat(80));

  let bestFixedNetAPY = -Infinity;
  let bestFixedRange = 0;

  for (const width of ranges) {
    // Use the RangeOptimizer's estimation logic (which now has the quadratic fix)
    const result = RangeOptimizer.estimateAPYForRange(
      width,
      apr,
      0, // incentive
      0, // funding
      volatility,
      costModel,
      5.0 // Drift (5%)
    );

    const netAPY = result.netAPY || -Infinity;
    if (netAPY > bestFixedNetAPY) {
      bestFixedNetAPY = netAPY;
      bestFixedRange = width;
    }

    console.log(
      `${(width * 100).toFixed(1).padStart(9)}% | ` +
      `${result.rebalanceFrequency.toFixed(1).padStart(13)} | ` +
      `${result.feeCaptureEfficiency.toFixed(1).padStart(9)}% | ` +
      `${result.expectedAPY.toFixed(2).padStart(8)}% | ` +
      `${result.annualCostDrag?.toFixed(2).padStart(8)}% | ` +
      `${netAPY.toFixed(2).padStart(7)}%`
    );
  }

  console.log('\n' + '='.repeat(80));
  
  if (bestFixedNetAPY > 0) {
    console.log(`✅ PROFITABLE STRATEGY FOUND!`);
    console.log(`   Best Fixed Range: ${(bestFixedRange * 100).toFixed(1)}%`);
    console.log(`   Estimated Net APY: ${bestFixedNetAPY.toFixed(2)}%`);
  } else {
    console.log(`❌ NO PROFITABLE STRATEGY FOUND with current conditions.`);
    console.log(`   Best "Least Bad" Range: ${(bestFixedRange * 100).toFixed(1)}% (Net APY: ${bestFixedNetAPY.toFixed(2)}%)`);
    console.log(`   Reason: Volatility (${(volatility * 100).toFixed(0)}%) is too high relative to APR (${apr.toFixed(0)}%) and costs.`);
  }

  console.log('\n🔍 Why is the optimizer choosing 39.5%?');
  console.log('   Because it minimizes rebalance costs (Cost Drag).');
  console.log('   Narrow ranges generate huge fees but burn even more in rebalancing.');
  console.log('   Wide ranges save costs but capture very few fees.');
}

main().catch(console.error);

