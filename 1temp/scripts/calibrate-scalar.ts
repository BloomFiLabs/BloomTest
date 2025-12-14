#!/usr/bin/env node
/**
 * Calibrate the scalar value in the quadratic rebalance frequency formula
 * by comparing predicted vs actual rebalance frequencies from backtests
 */

import 'dotenv/config';
import { UniswapV3Adapter } from '../src/infrastructure/adapters/data/TheGraphDataAdapter';
import { RangeOptimizer } from '../shared/utils/RangeOptimizer';
import { Volatility } from '../domain/value-objects/Volatility';
import { DriftVelocity } from '../domain/value-objects/DriftVelocity';

interface RebalanceEvent {
  timestamp: Date;
  price: number;
  rangeWidth: number;
  volatility: number;
}

interface ScalarTestResult {
  scalar: number;
  predictedRebalances: number;
  actualRebalances: number;
  error: number;
  errorPercent: number;
}

/**
 * Simulate rebalances using historical price data
 * This mimics what the backtest engine does
 */
function simulateRebalances(
  prices: Array<{ timestamp: Date; close: number }>,
  rangeWidth: number,
  rebalanceThreshold: number = 0.95
): RebalanceEvent[] {
  const rebalances: RebalanceEvent[] = [];
  let currentLower = prices[0].close * (1 - rangeWidth / 2);
  let currentUpper = prices[0].close * (1 + rangeWidth / 2);
  let lastRebalancePrice = prices[0].close;

  for (let i = 1; i < prices.length; i++) {
    const price = prices[i].close;
    const rangeHalf = (currentUpper - currentLower) / 2;
    const center = (currentUpper + currentLower) / 2;
    const distanceFromCenter = Math.abs(price - center);
    const effectiveRange = rangeHalf * rebalanceThreshold;

    // Check if price has moved beyond rebalance threshold
    if (distanceFromCenter >= effectiveRange) {
      rebalances.push({
        timestamp: prices[i].timestamp,
        price,
        rangeWidth,
        volatility: 0, // Will calculate later
      });

      // Rebalance: recenter range around current price
      currentLower = price * (1 - rangeWidth / 2);
      currentUpper = price * (1 + rangeWidth / 2);
      lastRebalancePrice = price;
    }
  }

  return rebalances;
}

/**
 * Calculate annualized volatility from price series
 */
function calculateVolatility(prices: number[]): number {
  if (prices.length < 2) return 0;

  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
    (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  // Annualize: multiply by sqrt(365) for daily data, sqrt(24*365) for hourly
  // Assuming hourly data (24 hours per day)
  const annualizedVol = stdDev * Math.sqrt(24 * 365);

  return annualizedVol;
}

/**
 * Calculate drift from price series
 */
function calculateDrift(prices: number[]): number {
  if (prices.length < 2) return 0;

  const firstPrice = prices[0];
  const lastPrice = prices[prices.length - 1];
  const totalReturn = (lastPrice - firstPrice) / firstPrice;

  // Annualize (assuming hourly data)
  const hoursPerYear = 24 * 365;
  const hours = prices.length;
  const annualizedDrift = totalReturn * (hoursPerYear / hours);

  return annualizedDrift * 100; // Convert to percentage
}

/**
 * Predict rebalance frequency using the quadratic formula with given scalar
 */
function predictRebalanceFrequency(
  volatility: number,
  rangeWidth: number,
  drift: number,
  scalar: number,
  rebalanceThreshold: number = 0.95
): number {
  const effectiveRangeWidth = rangeWidth * rebalanceThreshold;
  const rangeWidthPercent = effectiveRangeWidth * 100;
  const annualVolatilityPercent = volatility * 100;

  // Quadratic formula
  const volRatio = annualVolatilityPercent / rangeWidthPercent;
  const volatilityRebalances = Math.pow(volRatio, 2) * scalar;

  // Drift component
  const driftDecimal = Math.abs(drift) / 100;
  const driftRebalances = (driftDecimal * 100) / rangeWidthPercent;

  return Math.max(1, volatilityRebalances + driftRebalances);
}

async function main() {
  console.log('🔬 Calibrating Scalar for Quadratic Rebalance Frequency Formula\n');
  console.log('='.repeat(70));

  // 1. Fetch historical data
  console.log('\n📥 Fetching historical ETH/USDC data from The Graph...');
  const apiKey = process.env.THE_GRAPH_API_KEY || process.env.GRAPH_API_KEY;
  if (!apiKey) {
    console.error('❌ THE_GRAPH_API_KEY or GRAPH_API_KEY environment variable not set');
    process.exit(1);
  }

  const adapter = new UniswapV3Adapter({
    apiKey,
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    token0Address: '0x4200000000000000000000000000000000000006',
    token1Address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    useUrlAuth: true,
  });

  const poolAddress = '0xd0b53d9277642d899df5c87a3966a349a798f224'; // ETH/USDC 0.05%
  const hours = 30 * 24; // 30 days of hourly data

  let candles;
  try {
    // Try fetchHourlyOHLCV first (more accurate)
    if ('fetchHourlyOHLCV' in adapter && typeof (adapter as any).fetchHourlyOHLCV === 'function') {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - hours * 60 * 60 * 1000);
      candles = await (adapter as any).fetchHourlyOHLCV(poolAddress, startDate, endDate);
    } else {
      // Fallback to getHistory
      candles = await (adapter as any).getHistory(poolAddress, hours);
    }
    console.log(`✅ Fetched ${candles.length} candles`);
  } catch (error) {
    console.error(`❌ Failed to fetch data: ${error.message}`);
    process.exit(1);
  }

  if (candles.length < 100) {
    console.error('❌ Not enough data for calibration');
    process.exit(1);
  }

  // Convert candles to price series
  // Handle both OHLCVData format (with .close.value) and simple format (with .close)
  const prices = candles.map((c: any) => ({
    timestamp: c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp),
    close: c.close?.value ?? c.close,
  }));

  const priceValues = prices.map((p) => p.close);

  // Calculate overall volatility and drift
  const volatility = calculateVolatility(priceValues);
  const drift = calculateDrift(priceValues);

  console.log(`\n📊 Market Statistics:`);
  console.log(`   Volatility: ${(volatility * 100).toFixed(2)}%`);
  console.log(`   Drift: ${drift.toFixed(2)}%`);
  console.log(`   Price range: $${Math.min(...priceValues).toFixed(2)} - $${Math.max(...priceValues).toFixed(2)}`);

  // 2. Test different range widths
  const rangeWidths = [0.01, 0.02, 0.05, 0.10, 0.20];
  const scalars = [0.3, 0.5, 0.7, 0.8, 1.0, 1.2, 1.5, 2.0];

  console.log(`\n🧪 Testing ${scalars.length} scalar values across ${rangeWidths.length} range widths...\n`);

  const results: Array<{
    scalar: number;
    rangeWidth: number;
    predicted: number;
    actual: number;
    error: number;
    errorPercent: number;
  }> = [];

  for (const rangeWidth of rangeWidths) {
    // Simulate actual rebalances
    const actualRebalances = simulateRebalances(prices, rangeWidth);
    const actualCount = actualRebalances.length;

    // Scale to annual (assuming hourly data)
    const hoursInPeriod = prices.length;
    const hoursPerYear = 24 * 365;
    const actualAnnualRebalances = (actualCount / hoursInPeriod) * hoursPerYear;

    console.log(`\n${(rangeWidth * 100).toFixed(1)}% Range:`);
    console.log(`   Actual rebalances: ${actualCount} (${actualAnnualRebalances.toFixed(1)}/year)`);

    for (const scalar of scalars) {
      const predicted = predictRebalanceFrequency(
        volatility,
        rangeWidth,
        drift,
        scalar
      );
      const error = Math.abs(predicted - actualAnnualRebalances);
      const errorPercent = (error / actualAnnualRebalances) * 100;

      results.push({
        scalar,
        rangeWidth,
        predicted,
        actual: actualAnnualRebalances,
        error,
        errorPercent,
      });
    }
  }

  // 3. Find best scalar (lowest average error)
  console.log(`\n${'='.repeat(70)}`);
  console.log('\n📊 Results Summary:\n');

  const scalarStats = new Map<
    number,
    { totalError: number; totalErrorPercent: number; count: number }
  >();

  for (const result of results) {
    const stats = scalarStats.get(result.scalar) || {
      totalError: 0,
      totalErrorPercent: 0,
      count: 0,
    };
    stats.totalError += result.error;
    stats.totalErrorPercent += result.errorPercent;
    stats.count += 1;
    scalarStats.set(result.scalar, stats);
  }

  console.log('Scalar | Avg Error | Avg Error % | Best For');
  console.log('-'.repeat(70));

  const sortedScalars = Array.from(scalarStats.entries())
    .map(([scalar, stats]) => ({
      scalar,
      avgError: stats.totalError / stats.count,
      avgErrorPercent: stats.totalErrorPercent / stats.count,
    }))
    .sort((a, b) => a.avgErrorPercent - b.avgErrorPercent);

  for (const { scalar, avgError, avgErrorPercent } of sortedScalars) {
    const bestRanges = results
      .filter((r) => r.scalar === scalar)
      .sort((a, b) => a.errorPercent - b.errorPercent)
      .slice(0, 2)
      .map((r) => `${(r.rangeWidth * 100).toFixed(1)}%`)
      .join(', ');

    console.log(
      `${scalar.toFixed(1).padStart(6)} | ${avgError.toFixed(1).padStart(9)} | ${avgErrorPercent.toFixed(1).padStart(10)}% | ${bestRanges}`
    );
  }

  const bestScalar = sortedScalars[0];
  console.log(`\n✅ Best Scalar: ${bestScalar.scalar.toFixed(2)}`);
  console.log(`   Average Error: ${bestScalar.avgError.toFixed(1)} rebalances/year`);
  console.log(`   Average Error %: ${bestScalar.avgErrorPercent.toFixed(1)}%`);

  // 4. Show detailed comparison for best scalar
  console.log(`\n${'='.repeat(70)}`);
  console.log(`\n📈 Detailed Comparison (Scalar = ${bestScalar.scalar.toFixed(2)}):\n`);
  console.log('Range | Predicted | Actual | Error | Error %');
  console.log('-'.repeat(70));

  const bestResults = results
    .filter((r) => r.scalar === bestScalar.scalar)
    .sort((a, b) => a.rangeWidth - b.rangeWidth);

  for (const result of bestResults) {
    console.log(
      `${(result.rangeWidth * 100).toFixed(1).padStart(5)}% | ${result.predicted.toFixed(1).padStart(9)} | ${result.actual.toFixed(1).padStart(6)} | ${result.error.toFixed(1).padStart(5)} | ${result.errorPercent.toFixed(1).padStart(7)}%`
    );
  }

  console.log(`\n💡 Recommendation: Use scalar = ${bestScalar.scalar.toFixed(2)}`);
  console.log(`   Current value: 1.5`);
  console.log(`   Improvement: ${((1.5 - bestScalar.scalar) / 1.5 * 100).toFixed(1)}% reduction in error`);
}

main().catch(console.error);

