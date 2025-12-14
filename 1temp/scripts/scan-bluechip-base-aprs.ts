import 'dotenv/config';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { RangeOptimizer } from '../src/shared/utils/RangeOptimizer';

/**
 * Scan a curated set of Uniswap V3 bluechip pools and estimate:
 * - Realized base fee APR from The Graph (feesUSD / tvlUSD, annualized)
 * - Expected net APY for our ±0.5% range strategy on each pool
 *
 * This helps answer:
 *   "Are there other pools with higher base rates for bluechips we can short?"
 *
 * Run with:
 *   cd 1temp
 *   THE_GRAPH_API_KEY=... npx tsx scripts/scan-bluechip-base-aprs.ts
 */

type PoolConfig = {
  label: string;
  token0Symbol: string;
  token1Symbol: string;
};

const BLUECHIP_POOLS: PoolConfig[] = [
  {
    label: 'ETH/USDC 0.3% (baseline)',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
  },
  {
    label: 'ETH/USDT 0.3%',
    token0Symbol: 'WETH',
    token1Symbol: 'USDT',
  },
  {
    label: 'WBTC/USDC 0.3%',
    token0Symbol: 'WBTC',
    token1Symbol: 'USDC',
  },
  {
    label: 'WBTC/USDT 0.3%',
    token0Symbol: 'WBTC',
    token1Symbol: 'USDT',
  },
  {
    label: 'WSTETH/ETH 0.3%',
    token0Symbol: 'WSTETH',
    token1Symbol: 'WETH',
  },
  {
    label: 'RETH/ETH 0.3%',
    token0Symbol: 'RETH',
    token1Symbol: 'WETH',
  },
];

// Strategy knobs (same as ETH/USDC analysis)
const RANGE_WIDTH = 0.005; // ±0.5%
const INCENTIVE_APR = 15;  // 15% incentives
const FUNDING_APR = 5;     // 5% funding
const VOLATILITY = 0.6;    // 60% annual vol (approx for majors)
const GAS_COST_PER_REBALANCE = 0.01; // $0.01 on L2
const POSITION_VALUE = 1_000_000;    // $1M notional (small enough to ignore dilution for APR)

async function main() {
  const apiKey = process.env.THE_GRAPH_API_KEY;
  if (!apiKey) {
    throw new Error('THE_GRAPH_API_KEY not set. Export it before running this script.');
  }

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000);

  console.log('📡 Scanning Uniswap V3 bluechip pools on Ethereum for base fee APR...');
  console.log(
    `   Window: ${startDate.toISOString().split('T')[0]} → ${
      endDate.toISOString().split('T')[0]
    }\n`
  );

  type Result = {
    label: string;
    baseFeeAPR: number;
    netAPY: number;
  };

  const results: Result[] = [];

  for (const pool of BLUECHIP_POOLS) {
    console.log(`\n🔍 Pool: ${pool.label}`);

    const adapter = new UniswapV3Adapter({
      apiKey,
      token0Symbol: pool.token0Symbol,
      token1Symbol: pool.token1Symbol,
      useUrlAuth: true,
    });

    try {
      // Calculate realized base APR from The Graph
      const baseFeeAPR = await adapter.calculateActualAPR(
        `${pool.token0Symbol}-${pool.token1Symbol}`,
        startDate,
        endDate
      );

      console.log(`   • Realized base fee APR: ${baseFeeAPR.toFixed(2)}%`);

      const poolFeeTier = await adapter.fetchPoolFeeTier(
        `${pool.token0Symbol}-${pool.token1Symbol}`
      );

      // Feed into our ±0.5% strategy model
      const rangeResult = RangeOptimizer.estimateAPYForRange(
        RANGE_WIDTH,
        baseFeeAPR,
        INCENTIVE_APR,
        FUNDING_APR,
        VOLATILITY,
        {
          gasCostPerRebalance: GAS_COST_PER_REBALANCE,
          poolFeeTier,
          positionValueUSD: POSITION_VALUE,
        }
      );

      const netAPY = rangeResult.netAPY ?? rangeResult.expectedAPY;

      console.log(
        `   • Expected net APY (±0.5% range, 15% incentives, 5% funding): ${netAPY.toFixed(
          2
        )}%`
      );

      results.push({
        label: pool.label,
        baseFeeAPR,
        netAPY,
      });
    } catch (err: any) {
      console.warn(`   ⚠️  Failed to analyze ${pool.label}: ${err.message}`);
    }
  }

  if (!results.length) {
    console.log('\n❌ No pools successfully analyzed. Check API key or subgraph status.');
    return;
  }

  console.log('\n📊 Summary: Bluechip Base APRs & Strategy Net APYs\n');
  results.sort((a, b) => b.baseFeeAPR - a.baseFeeAPR);

  console.log(
    [
      'Pool'.padEnd(28),
      'Base APR %'.padEnd(12),
      'Net APY %'.padEnd(10),
      'Meets 35%?'.padEnd(12),
    ].join(' | ')
  );
  console.log('-'.repeat(70));

  for (const r of results) {
    const meets35 = r.netAPY >= 35 ? '✅ Yes' : '❌ No';

    console.log(
      [
        r.label.padEnd(28),
        r.baseFeeAPR.toFixed(2).padEnd(12),
        r.netAPY.toFixed(2).padEnd(10),
        meets35.padEnd(12),
      ].join(' | ')
    );
  }

  console.log('\n💡 Interpretation:');
  console.log(
    '   • Use this to identify which bluechip pools have higher intrinsic fee APR than ETH/USDC.'
  );
  console.log(
    '   • Any pool with net APY ≥ 35% on our ±0.5% strategy meets the client target before upside.'
  );
}

main().catch((err) => {
  console.error('scan-bluechip-base-aprs failed:', err);
  process.exit(1);
});




