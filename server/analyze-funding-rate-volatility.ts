import axios from 'axios';
import { ExchangeType } from './src/domain/value-objects/ExchangeConfig';

/**
 * Analyze funding rate volatility and spread stability
 * Answers critical questions:
 * 1. How drastically can funding rates change hourly?
 * 2. How often do spreads drop to 0% or reverse?
 * 3. How accurate are monthly/weekly/daily averages as predictors?
 * 4. What's the risk of entering at a loss and waiting for profitability?
 */

interface HistoricalRate {
  timestamp: Date;
  rate: number;
}

interface VolatilityMetrics {
  symbol: string;
  exchange: ExchangeType;
  dataPoints: number;
  averageRate: number;
  stdDev: number;
  minRate: number;
  maxRate: number;
  maxHourlyChange: number; // Largest change between consecutive hours
  maxDailyChange: number; // Largest change within a single day
  rateReversals: number; // Number of times rate flipped from positive to negative or vice versa
  volatilityScore: number; // 0-1, higher = more volatile
}

interface SpreadMetrics {
  symbol: string;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  averageSpread: number;
  stdDevSpread: number;
  minSpread: number;
  maxSpread: number;
  spreadDropsToZero: number; // Count of times spread dropped to near-zero (< 0.0001%)
  spreadReversals: number; // Count of times spread flipped sign
  maxHourlySpreadChange: number; // Largest change in spread between hours
  spreadStabilityScore: number; // 0-1, higher = more stable
}

/**
 * Fetch historical funding rates from Hyperliquid
 */
async function fetchHyperliquidHistory(symbol: string, days: number = 30): Promise<HistoricalRate[]> {
  try {
    const API_URL = 'https://api.hyperliquid.xyz/info';
    const endTime = Date.now();
    const startTime = endTime - (days * 24 * 60 * 60 * 1000);
    
    const response = await axios.post(API_URL, {
      type: 'fundingHistory',
      coin: symbol,
      startTime: startTime,
      endTime: endTime,
    }, {
      timeout: 30000,
    });
    
    if (Array.isArray(response.data) && response.data.length > 0) {
      return response.data.map((entry: any) => ({
        timestamp: new Date(entry.time),
        rate: parseFloat(entry.fundingRate),
      })).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }
    
    return [];
  } catch (error: any) {
    console.error(`Failed to fetch Hyperliquid history for ${symbol}: ${error.message}`);
    return [];
  }
}

/**
 * Fetch historical funding rates from Aster
 */
async function fetchAsterHistory(symbol: string, days: number = 30): Promise<HistoricalRate[]> {
  try {
    const baseUrl = 'https://fapi.asterdex.com';
    const endTime = Date.now();
    const startTime = endTime - (days * 24 * 60 * 60 * 1000);
    
    const response = await axios.get(`${baseUrl}/fapi/v1/fundingRate`, {
      params: {
        symbol: `${symbol}USDT`,
        startTime,
        endTime,
        limit: 1000,
      },
      timeout: 30000,
    });
    
    if (Array.isArray(response.data) && response.data.length > 0) {
      return response.data.map((entry: any) => ({
        timestamp: new Date(entry.fundingTime),
        rate: parseFloat(entry.fundingRate),
      })).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    }
    
    return [];
  } catch (error: any) {
    console.error(`Failed to fetch Aster history for ${symbol}: ${error.message}`);
    return [];
  }
}

/**
 * Calculate volatility metrics for a single exchange
 */
function calculateVolatilityMetrics(
  symbol: string,
  exchange: ExchangeType,
  rates: HistoricalRate[],
): VolatilityMetrics {
  if (rates.length === 0) {
    return {
      symbol,
      exchange,
      dataPoints: 0,
      averageRate: 0,
      stdDev: 0,
      minRate: 0,
      maxRate: 0,
      maxHourlyChange: 0,
      maxDailyChange: 0,
      rateReversals: 0,
      volatilityScore: 0,
    };
  }
  
  const rateValues = rates.map(r => r.rate);
  const averageRate = rateValues.reduce((sum, r) => sum + r, 0) / rateValues.length;
  
  // Standard deviation
  const variance = rateValues.reduce((sum, r) => sum + Math.pow(r - averageRate, 2), 0) / rateValues.length;
  const stdDev = Math.sqrt(variance);
  
  const minRate = Math.min(...rateValues);
  const maxRate = Math.max(...rateValues);
  
  // Calculate hourly changes
  let maxHourlyChange = 0;
  let rateReversals = 0;
  let lastRate = rates[0].rate;
  let lastSign = Math.sign(lastRate);
  
  for (let i = 1; i < rates.length; i++) {
    const currentRate = rates[i].rate;
    const currentSign = Math.sign(currentRate);
    const change = Math.abs(currentRate - lastRate);
    
    if (change > maxHourlyChange) {
      maxHourlyChange = change;
    }
    
    // Check for reversals (positive to negative or vice versa)
    if (lastSign !== 0 && currentSign !== 0 && lastSign !== currentSign) {
      rateReversals++;
    }
    
    lastRate = currentRate;
    lastSign = currentSign;
  }
  
  // Calculate max daily change
  let maxDailyChange = 0;
  const ratesByDay = new Map<string, HistoricalRate[]>();
  rates.forEach(r => {
    const dayKey = r.timestamp.toISOString().split('T')[0];
    if (!ratesByDay.has(dayKey)) {
      ratesByDay.set(dayKey, []);
    }
    ratesByDay.get(dayKey)!.push(r);
  });
  
  ratesByDay.forEach(dayRates => {
    if (dayRates.length > 0) {
      const dayMin = Math.min(...dayRates.map(r => r.rate));
      const dayMax = Math.max(...dayRates.map(r => r.rate));
      const dayChange = Math.abs(dayMax - dayMin);
      if (dayChange > maxDailyChange) {
        maxDailyChange = dayChange;
      }
    }
  });
  
  // Volatility score: combines stdDev, max changes, and reversals
  // Higher score = more volatile
  const normalizedStdDev = Math.min(1, stdDev * 10000); // Scale to 0-1
  const normalizedMaxHourly = Math.min(1, maxHourlyChange * 10000);
  const normalizedMaxDaily = Math.min(1, maxDailyChange * 10000);
  const normalizedReversals = Math.min(1, rateReversals / rates.length);
  const volatilityScore = (normalizedStdDev * 0.4 + normalizedMaxHourly * 0.3 + normalizedMaxDaily * 0.2 + normalizedReversals * 0.1);
  
  return {
    symbol,
    exchange,
    dataPoints: rates.length,
    averageRate,
    stdDev,
    minRate,
    maxRate,
    maxHourlyChange,
    maxDailyChange,
    rateReversals,
    volatilityScore: Math.max(0, Math.min(1, volatilityScore)),
  };
}

/**
 * Calculate spread metrics between two exchanges
 */
function calculateSpreadMetrics(
  symbol: string,
  longRates: HistoricalRate[],
  shortRates: HistoricalRate[],
  longExchange: ExchangeType,
  shortExchange: ExchangeType,
): SpreadMetrics {
  // Match rates by timestamp (within 1 hour window)
  const spreads: Array<{ timestamp: Date; spread: number }> = [];
  
  longRates.forEach(longRate => {
    const matchingShort = shortRates.find(shortRate =>
      Math.abs(shortRate.timestamp.getTime() - longRate.timestamp.getTime()) < 3600 * 1000
    );
    
    if (matchingShort) {
      spreads.push({
        timestamp: longRate.timestamp,
        spread: longRate.rate - matchingShort.rate,
      });
    }
  });
  
  if (spreads.length === 0) {
    return {
      symbol,
      longExchange,
      shortExchange,
      averageSpread: 0,
      stdDevSpread: 0,
      minSpread: 0,
      maxSpread: 0,
      spreadDropsToZero: 0,
      spreadReversals: 0,
      maxHourlySpreadChange: 0,
      spreadStabilityScore: 0,
    };
  }
  
  const spreadValues = spreads.map(s => s.spread);
  const averageSpread = spreadValues.reduce((sum, s) => sum + s, 0) / spreadValues.length;
  
  // Standard deviation
  const variance = spreadValues.reduce((sum, s) => sum + Math.pow(s - averageSpread, 2), 0) / spreadValues.length;
  const stdDevSpread = Math.sqrt(variance);
  
  const minSpread = Math.min(...spreadValues);
  const maxSpread = Math.max(...spreadValues);
  
  // Count spread drops to near-zero (< 0.0001% = 0.000001)
  const spreadDropsToZero = spreadValues.filter(s => Math.abs(s) < 0.000001).length;
  
  // Count spread reversals (positive to negative or vice versa)
  let spreadReversals = 0;
  let lastSign = Math.sign(spreads[0].spread);
  for (let i = 1; i < spreads.length; i++) {
    const currentSign = Math.sign(spreads[i].spread);
    if (lastSign !== 0 && currentSign !== 0 && lastSign !== currentSign) {
      spreadReversals++;
    }
    lastSign = currentSign;
  }
  
  // Max hourly spread change
  let maxHourlySpreadChange = 0;
  for (let i = 1; i < spreads.length; i++) {
    const change = Math.abs(spreads[i].spread - spreads[i - 1].spread);
    if (change > maxHourlySpreadChange) {
      maxHourlySpreadChange = change;
    }
  }
  
  // Spread stability score: higher = more stable
  // Lower stdDev, fewer drops to zero, fewer reversals = more stable
  const normalizedStdDev = Math.min(1, stdDevSpread * 10000);
  const normalizedDrops = Math.min(1, spreadDropsToZero / spreads.length);
  const normalizedReversals = Math.min(1, spreadReversals / spreads.length);
  const spreadStabilityScore = 1 - (normalizedStdDev * 0.5 + normalizedDrops * 0.3 + normalizedReversals * 0.2);
  
  return {
    symbol,
    longExchange,
    shortExchange,
    averageSpread,
    stdDevSpread,
    minSpread,
    maxSpread,
    spreadDropsToZero,
    spreadReversals,
    maxHourlySpreadChange,
    spreadStabilityScore: Math.max(0, Math.min(1, spreadStabilityScore)),
  };
}

/**
 * Calculate predictive accuracy of historical averages
 */
function calculatePredictiveAccuracy(
  rates: HistoricalRate[],
  days: number,
): {
  monthlyAvg: number;
  weeklyAvg: number;
  dailyAvg: number;
  currentRate: number;
  nextHourActual: number | null;
  monthlyError: number | null;
  weeklyError: number | null;
  dailyError: number | null;
} {
  if (rates.length < 24) {
    return {
      monthlyAvg: 0,
      weeklyAvg: 0,
      dailyAvg: 0,
      currentRate: 0,
      nextHourActual: null,
      monthlyError: null,
      weeklyError: null,
      dailyError: null,
    };
  }
  
  const now = Date.now();
  const monthlyCutoff = now - (30 * 24 * 60 * 60 * 1000);
  const weeklyCutoff = now - (7 * 24 * 60 * 60 * 1000);
  const dailyCutoff = now - (24 * 60 * 60 * 1000);
  
  const monthlyRates = rates.filter(r => r.timestamp.getTime() > monthlyCutoff);
  const weeklyRates = rates.filter(r => r.timestamp.getTime() > weeklyCutoff);
  const dailyRates = rates.filter(r => r.timestamp.getTime() > dailyCutoff);
  
  const monthlyAvg = monthlyRates.length > 0
    ? monthlyRates.reduce((sum, r) => sum + r.rate, 0) / monthlyRates.length
    : 0;
  const weeklyAvg = weeklyRates.length > 0
    ? weeklyRates.reduce((sum, r) => sum + r.rate, 0) / weeklyRates.length
    : 0;
  const dailyAvg = dailyRates.length > 0
    ? dailyRates.reduce((sum, r) => sum + r.rate, 0) / dailyRates.length
    : 0;
  
  const currentRate = rates[rates.length - 1].rate;
  const nextHourActual = rates.length > 1 ? rates[rates.length - 1].rate : null; // Use last rate as proxy
  
  // Calculate prediction errors (absolute difference)
  const monthlyError = nextHourActual !== null ? Math.abs(monthlyAvg - nextHourActual) : null;
  const weeklyError = nextHourActual !== null ? Math.abs(weeklyAvg - nextHourActual) : null;
  const dailyError = nextHourActual !== null ? Math.abs(dailyAvg - nextHourActual) : null;
  
  return {
    monthlyAvg,
    weeklyAvg,
    dailyAvg,
    currentRate,
    nextHourActual,
    monthlyError,
    weeklyError,
    dailyError,
  };
}

/**
 * Main analysis function
 */
async function analyzeVolatility() {
  console.log('🔍 Funding Rate Volatility & Spread Stability Analysis');
  console.log('='.repeat(100));
  console.log('');
  
  const symbols = ['ETH', 'BTC', 'SOL'];
  const days = 30;
  
  for (const symbol of symbols) {
    console.log(`\n${'='.repeat(100)}`);
    console.log(`Analyzing ${symbol}...`);
    console.log('='.repeat(100));
    
    // Fetch historical data
    console.log(`\n📥 Fetching historical data (last ${days} days)...`);
    const [hyperliquidRates, asterRates] = await Promise.all([
      fetchHyperliquidHistory(symbol, days),
      fetchAsterHistory(symbol, days),
    ]);
    
    console.log(`   Hyperliquid: ${hyperliquidRates.length} data points`);
    console.log(`   Aster: ${asterRates.length} data points`);
    
    if (hyperliquidRates.length === 0 && asterRates.length === 0) {
      console.log(`   ⚠️  No data available for ${symbol}`);
      continue;
    }
    
    // Calculate volatility metrics
    console.log(`\n📊 Volatility Metrics:`);
    console.log('-'.repeat(100));
    
    if (hyperliquidRates.length > 0) {
      const hyperliquidMetrics = calculateVolatilityMetrics(symbol, ExchangeType.HYPERLIQUID, hyperliquidRates);
      console.log(`\nHYPERLIQUID:`);
      console.log(`   Data Points: ${hyperliquidMetrics.dataPoints}`);
      console.log(`   Average Rate: ${(hyperliquidMetrics.averageRate * 100).toFixed(6)}%`);
      console.log(`   Std Deviation: ${(hyperliquidMetrics.stdDev * 100).toFixed(6)}%`);
      console.log(`   Range: ${(hyperliquidMetrics.minRate * 100).toFixed(6)}% to ${(hyperliquidMetrics.maxRate * 100).toFixed(6)}%`);
      console.log(`   Max Hourly Change: ${(hyperliquidMetrics.maxHourlyChange * 100).toFixed(6)}%`);
      console.log(`   Max Daily Change: ${(hyperliquidMetrics.maxDailyChange * 100).toFixed(6)}%`);
      console.log(`   Rate Reversals: ${hyperliquidMetrics.rateReversals} (${((hyperliquidMetrics.rateReversals / hyperliquidMetrics.dataPoints) * 100).toFixed(2)}% of periods)`);
      console.log(`   Volatility Score: ${(hyperliquidMetrics.volatilityScore * 100).toFixed(2)}% (higher = more volatile)`);
      
      // Predictive accuracy
      const hyperliquidAccuracy = calculatePredictiveAccuracy(hyperliquidRates, days);
      console.log(`\n   Predictive Accuracy:`);
      console.log(`     Monthly Avg: ${(hyperliquidAccuracy.monthlyAvg * 100).toFixed(6)}%`);
      console.log(`     Weekly Avg: ${(hyperliquidAccuracy.weeklyAvg * 100).toFixed(6)}%`);
      console.log(`     Daily Avg: ${(hyperliquidAccuracy.dailyAvg * 100).toFixed(6)}%`);
      console.log(`     Current Rate: ${(hyperliquidAccuracy.currentRate * 100).toFixed(6)}%`);
      if (hyperliquidAccuracy.monthlyError !== null) {
        console.log(`     Monthly Avg Error: ${(hyperliquidAccuracy.monthlyError * 100).toFixed(6)}%`);
        console.log(`     Weekly Avg Error: ${(hyperliquidAccuracy.weeklyError! * 100).toFixed(6)}%`);
        console.log(`     Daily Avg Error: ${(hyperliquidAccuracy.dailyError! * 100).toFixed(6)}%`);
      }
    }
    
    if (asterRates.length > 0) {
      const asterMetrics = calculateVolatilityMetrics(symbol, ExchangeType.ASTER, asterRates);
      console.log(`\nASTER:`);
      console.log(`   Data Points: ${asterMetrics.dataPoints}`);
      console.log(`   Average Rate: ${(asterMetrics.averageRate * 100).toFixed(6)}%`);
      console.log(`   Std Deviation: ${(asterMetrics.stdDev * 100).toFixed(6)}%`);
      console.log(`   Range: ${(asterMetrics.minRate * 100).toFixed(6)}% to ${(asterMetrics.maxRate * 100).toFixed(6)}%`);
      console.log(`   Max Hourly Change: ${(asterMetrics.maxHourlyChange * 100).toFixed(6)}%`);
      console.log(`   Max Daily Change: ${(asterMetrics.maxDailyChange * 100).toFixed(6)}%`);
      console.log(`   Rate Reversals: ${asterMetrics.rateReversals} (${((asterMetrics.rateReversals / asterMetrics.dataPoints) * 100).toFixed(2)}% of periods)`);
      console.log(`   Volatility Score: ${(asterMetrics.volatilityScore * 100).toFixed(2)}% (higher = more volatile)`);
      
      // Predictive accuracy
      const asterAccuracy = calculatePredictiveAccuracy(asterRates, days);
      console.log(`\n   Predictive Accuracy:`);
      console.log(`     Monthly Avg: ${(asterAccuracy.monthlyAvg * 100).toFixed(6)}%`);
      console.log(`     Weekly Avg: ${(asterAccuracy.weeklyAvg * 100).toFixed(6)}%`);
      console.log(`     Daily Avg: ${(asterAccuracy.dailyAvg * 100).toFixed(6)}%`);
      console.log(`     Current Rate: ${(asterAccuracy.currentRate * 100).toFixed(6)}%`);
      if (asterAccuracy.monthlyError !== null) {
        console.log(`     Monthly Avg Error: ${(asterAccuracy.monthlyError * 100).toFixed(6)}%`);
        console.log(`     Weekly Avg Error: ${(asterAccuracy.weeklyError! * 100).toFixed(6)}%`);
        console.log(`     Daily Avg Error: ${(asterAccuracy.dailyError! * 100).toFixed(6)}%`);
      }
    }
    
    // Calculate spread metrics if we have data from both exchanges
    if (hyperliquidRates.length > 0 && asterRates.length > 0) {
      console.log(`\n📈 Spread Stability Metrics (HYPERLIQUID LONG vs ASTER SHORT):`);
      console.log('-'.repeat(100));
      
      const spreadMetrics = calculateSpreadMetrics(
        symbol,
        hyperliquidRates,
        asterRates,
        ExchangeType.HYPERLIQUID,
        ExchangeType.ASTER,
      );
      
      console.log(`   Data Points: ${spreadMetrics.averageSpread !== 0 ? 'matched' : 0}`);
      console.log(`   Average Spread: ${(spreadMetrics.averageSpread * 100).toFixed(6)}%`);
      console.log(`   Std Deviation: ${(spreadMetrics.stdDevSpread * 100).toFixed(6)}%`);
      console.log(`   Range: ${(spreadMetrics.minSpread * 100).toFixed(6)}% to ${(spreadMetrics.maxSpread * 100).toFixed(6)}%`);
      console.log(`   Max Hourly Spread Change: ${(spreadMetrics.maxHourlySpreadChange * 100).toFixed(6)}%`);
      console.log(`   Spread Drops to Near-Zero: ${spreadMetrics.spreadDropsToZero} occurrences`);
      console.log(`   Spread Reversals: ${spreadMetrics.spreadReversals} (spread flipped sign)`);
      console.log(`   Spread Stability Score: ${(spreadMetrics.spreadStabilityScore * 100).toFixed(2)}% (higher = more stable)`);
      
      // Risk assessment
      console.log(`\n⚠️  Risk Assessment:`);
      console.log(`   ${spreadMetrics.spreadDropsToZero > 0 ? '🔴 HIGH RISK' : '🟢 LOW RISK'}: Spread dropped to near-zero ${spreadMetrics.spreadDropsToZero} times`);
      console.log(`   ${spreadMetrics.spreadReversals > 0 ? '🔴 HIGH RISK' : '🟢 LOW RISK'}: Spread reversed ${spreadMetrics.spreadReversals} times`);
      console.log(`   ${spreadMetrics.maxHourlySpreadChange > 0.0001 ? '🔴 HIGH RISK' : '🟢 LOW RISK'}: Max hourly spread change is ${(spreadMetrics.maxHourlySpreadChange * 100).toFixed(6)}%`);
    }
    
    // Small delay between symbols
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\n' + '='.repeat(100));
  console.log('✅ Analysis complete!');
  console.log('='.repeat(100));
}

// Run if executed directly
if (require.main === module) {
  analyzeVolatility().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { analyzeVolatility, calculateVolatilityMetrics, calculateSpreadMetrics };

