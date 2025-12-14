import { RangeOptimizer } from '../src/shared/utils/RangeOptimizer';

/**
 * Simple Monte Carlo over fee APR, volatility and cost assumptions
 * to understand how fragile the extreme APY numbers are.
 *
 * This is NOT part of the unit test suite – run manually, e.g.:
 *   npx tsx scripts/monte-carlo-range.ts
 */

interface Scenario {
  baseFeeAPR: number;
  incentiveAPR: number;
  fundingAPR: number;
  volatility: number;
  poolFeeTier: number;
  gasCostPerRebalance: number;
}

const positionValueUSD = 40_000;
const rangeWidth = 0.0005; // ±0.05% – aggressive narrow band

function sampleScenario(): Scenario {
  // Sample around our ETH/USDC Base assumptions
  const baseFeeAPR = 11 * randomInRange(0.4, 1.6); // 40%–160% of historical
  const incentiveAPR = 15 * randomInRange(0.0, 1.0); // can be 0–100% of assumed
  const fundingAPR = randomInRange(-10, 10); // we might pay or receive funding
  const volatility = 0.6 * randomInRange(0.5, 1.5); // 30%–90% vol
  const poolFeeTier = 0.003 * randomInRange(1.0, 3.0); // competition/slippage proxy
  const gasCostPerRebalance = 0.01 * randomInRange(1.0, 5.0); // Base gas normal to 5x

  return {
    baseFeeAPR,
    incentiveAPR,
    fundingAPR,
    volatility,
    poolFeeTier,
    gasCostPerRebalance,
  };
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
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

function main() {
  const runs = 2_000;
  const apys: number[] = [];

  for (let i = 0; i < runs; i++) {
    const scenario = sampleScenario();
    const netAPY = runScenario(scenario);
    apys.push(netAPY);
  }

  apys.sort((a, b) => a - b);

  const p = (q: number) => apys[Math.floor(q * (apys.length - 1))];

  console.log('🔬 Monte Carlo: RangeOptimizer robustness for ±0.05% range');
  console.log(`Runs: ${runs}`);
  console.log('');
  console.log('Assumptions sampled:');
  console.log('  • baseFeeAPR   ~ 4.4% – 17.6% (centered at 11%)');
  console.log('  • incentiveAPR ~ 0% – 15%');
  console.log('  • fundingAPR   ~ -10% – +10%');
  console.log('  • volatility   ~ 30% – 90%');
  console.log('  • poolFeeTier  ~ 0.3% – 0.9% (competition/slippage proxy)');
  console.log('  • gas/rebal    ~ $0.01 – $0.05');
  console.log('');
  console.log('Net APY distribution (after costs):');
  console.log(`  min   : ${p(0.00).toFixed(2)}%`);
  console.log(`  p10   : ${p(0.10).toFixed(2)}%`);
  console.log(`  p25   : ${p(0.25).toFixed(2)}%`);
  console.log(`  median: ${p(0.50).toFixed(2)}%`);
  console.log(`  p75   : ${p(0.75).toFixed(2)}%`);
  console.log(`  p90   : ${p(0.90).toFixed(2)}%`);
  console.log(`  max   : ${p(1.00).toFixed(2)}%`);
  console.log('');
  console.log('Interpretation:');
  console.log('  • Compare median/p75 to the 880% “optimistic” point estimate.');
  console.log('  • If median << 880%, the extreme scenario is fragile to parameter shifts.');
  console.log('  • Use this to pick a more conservative target band (e.g. median–p75).');
}

main();










