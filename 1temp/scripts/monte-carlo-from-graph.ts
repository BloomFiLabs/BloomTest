import 'dotenv/config';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { RangeOptimizer } from '../src/shared/utils/RangeOptimizer';

/**
 * Monte Carlo using REAL fee + TVL data from The Graph for ETH/USDC Uniswap V3 pool.
 *
 * Idea:
 * - Pull daily feesUSD / tvlUSD from the subgraph over a historical window.
 * - Convert to a distribution of baseFeeAPR values (realized fee environments).
 * - Sample scenarios around those real APRs, plus variations in volatility & costs,
 *   to understand how fragile the extreme APY numbers are.
 *
 * Run with:
 *   cd 1temp
 *   THE_GRAPH_API_KEY=... npx tsx scripts/monte-carlo-from-graph.ts
 */

const positionValueUSD = 40_000;
const rangeWidth = 0.0005; // ±0.05% – aggressive narrow band

interface Scenario {
  baseFeeAPR: number;
  incentiveAPR: number;
  fundingAPR: number;
  volatility: number;
  poolFeeTier: number;
  gasCostPerRebalance: number;
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sampleScenario(baseFeeAPRFromGraph: number[]): Scenario {
  // Sample a historical baseFeeAPR from empirical distribution
  const idx = Math.floor(Math.random() * baseFeeAPRFromGraph.length);
  const baseFee = baseFeeAPRFromGraph[idx];

  // Allow for some regime shift around historical values (±60%)
  const baseFeeAPR = baseFee * randomInRange(0.4, 1.6);

  const incentiveAPR = 15 * randomInRange(0.0, 1.0); // 0–15%
  const fundingAPR = randomInRange(-10, 10); // we may pay or receive funding
  const volatility = 0.6 * randomInRange(0.5, 1.5); // 30–90% vol
  const poolFeeTier = 0.003 * randomInRange(1.0, 3.0); // 0.3%–0.9% effective
  const gasCostPerRebalance = 0.01 * randomInRange(1.0, 5.0); // $0.01–$0.05

  return {
    baseFeeAPR,
    incentiveAPR,
    fundingAPR,
    volatility,
    poolFeeTier,
    gasCostPerRebalance,
  };
}

function runScenario(s: Scenario): number {
  const result = RangeOptimizer.estimateAPYForRange(
    rangeWidth,
    s.baseFeeAPR,
    s.incentiveAPR,
    s.fundingAPR,
    s.volatility,
    {
      gasCostPerRebalance: s.gasCostPerRebalance,
      poolFeeTier: s.poolFeeTier,
      positionValueUSD,
    }
  );
  return result.netAPY ?? result.expectedAPY;
}

async function loadHistoricalBaseFeeAPR(): Promise<number[]> {
  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    throw new Error('THE_GRAPH_API_KEY not set');
  }

  const adapter = new UniswapV3Adapter({
    apiKey,
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    useUrlAuth: true,
  });

  // Use a reasonably long window – e.g. last full year
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);

  console.log('📡 Fetching historical fee data from The Graph...');
  console.log(
    `   Window: ${startDate.toISOString().split('T')[0]} → ${
      endDate.toISOString().split('T')[0]
    }`
  );

  const feesData = await adapter.fetchDailyFees('ETH-USDC', startDate, endDate);
  if (!feesData.length) {
    throw new Error('No fees data returned from The Graph');
  }

  // Convert each day to an annualized fee APR (pure fee-side APR)
  const dailyAprs: number[] = [];
  for (const day of feesData) {
    if (day.tvlUSD <= 0) continue;
    const dailyFeeRate = day.feesUSD / day.tvlUSD; // fees / TVL
    const apr = dailyFeeRate * 365 * 100; // annualized %, purely from fees
    if (Number.isFinite(apr) && apr > 0) {
      dailyAprs.push(apr);
    }
  }

  if (!dailyAprs.length) {
    throw new Error('No valid APR points derived from daily fees/TVL');
  }

  dailyAprs.sort((a, b) => a - b);

  const p = (q: number) => dailyAprs[Math.floor(q * (dailyAprs.length - 1))];

  console.log('\n📊 Historical base fee APR distribution (from The Graph):');
  console.log(`   Count: ${dailyAprs.length}`);
  console.log(`   Min  : ${p(0.0).toFixed(2)}%`);
  console.log(`   p10  : ${p(0.1).toFixed(2)}%`);
  console.log(`   p25  : ${p(0.25).toFixed(2)}%`);
  console.log(`   p50  : ${p(0.5).toFixed(2)}%`);
  console.log(`   p75  : ${p(0.75).toFixed(2)}%`);
  console.log(`   p90  : ${p(0.9).toFixed(2)}%`);
  console.log(`   Max  : ${p(1.0).toFixed(2)}%`);

  return dailyAprs;
}

async function main() {
  const baseFeeAPRFromGraph = await loadHistoricalBaseFeeAPR();

  const runs = 2_000;
  const apys: number[] = [];

  console.log('\n🔬 Running Monte Carlo using Graph-derived fee APRs...');
  for (let i = 0; i < runs; i++) {
    const scenario = sampleScenario(baseFeeAPRFromGraph);
    const netAPY = runScenario(scenario);
    apys.push(netAPY);
  }

  apys.sort((a, b) => a - b);
  const p = (q: number) => apys[Math.floor(q * (apys.length - 1))];

  console.log('\n📈 Net APY distribution for ±0.05% range (after costs):');
  console.log(`   Runs : ${runs}`);
  console.log(`   Min  : ${p(0.0).toFixed(2)}%`);
  console.log(`   p10  : ${p(0.1).toFixed(2)}%`);
  console.log(`   p25  : ${p(0.25).toFixed(2)}%`);
  console.log(`   p50  : ${p(0.5).toFixed(2)}%`);
  console.log(`   p75  : ${p(0.75).toFixed(2)}%`);
  console.log(`   p90  : ${p(0.9).toFixed(2)}%`);
  console.log(`   Max  : ${p(1.0).toFixed(2)}%`);

  console.log('\n💡 Interpretation:');
  console.log('   • This uses REAL fee APR variability from The Graph as the base input.');
  console.log(
    '   • Compare median/p75 to the ~880% optimistic figure to see how fragile it is to fee regime changes.'
  );
  console.log(
    '   • Use the median–p75 band as a more conservative target for a production strategy.'
  );
}

main().catch((err) => {
  console.error('Monte Carlo (Graph-based) failed:', err);
  process.exit(1);
});










