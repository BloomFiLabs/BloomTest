import { ExchangeType } from '../value-objects/ExchangeConfig';

/**
 * Historical funding rate data point
 */
export interface HistoricalFundingRate {
  symbol: string;
  exchange: ExchangeType;
  rate: number;
  timestamp: Date;
}

/**
 * Historical metrics for a symbol/exchange pair
 */
export interface HistoricalMetrics {
  averageRate: number;
  stdDev: number;
  minRate: number;
  maxRate: number;
  positiveDays: number;
  consistencyScore: number; // 0-1, higher = more consistent
  dataPoints: number; // Number of historical data points used
}

/**
 * Spread volatility metrics for an arbitrage pair
 */
export interface SpreadVolatilityMetrics {
  averageSpread: number;
  stdDevSpread: number;
  minSpread: number;
  maxSpread: number;
  spreadDropsToZero: number; // Count of times spread dropped to zero
  spreadReversals: number; // Count of times spread reversed (positive to negative or vice versa)
  maxHourlySpreadChange: number; // Maximum change in spread between consecutive hours
  stabilityScore: number; // 0-1, higher = more stable
}

/**
 * Interface for historical funding rate service
 * Domain port - infrastructure implements this
 */
export interface IHistoricalFundingRateService {
  /**
   * Get historical funding rate data for a symbol/exchange pair
   */
  getHistoricalData(symbol: string, exchange: ExchangeType): HistoricalFundingRate[];

  /**
   * Get historical metrics for a symbol/exchange pair
   */
  getHistoricalMetrics(
    symbol: string,
    exchange: ExchangeType,
    days?: number,
  ): HistoricalMetrics | null;

  /**
   * Get spread volatility metrics for an arbitrage pair
   */
  getSpreadVolatilityMetrics(
    longSymbol: string,
    longExchange: ExchangeType,
    shortSymbol: string,
    shortExchange: ExchangeType,
    days?: number,
  ): SpreadVolatilityMetrics | null;

  /**
   * Get consistency score for a symbol/exchange pair
   * Higher score = more consistent and higher average rate
   */
  getConsistencyScore(symbol: string, exchange: ExchangeType): number;

  /**
   * Get average rate for a specific time period
   */
  getAverageRateForPeriod(symbol: string, exchange: ExchangeType, days: number): number | null;

  /**
   * Get weighted average rate using multiple time periods
   * Weighting: Monthly (40%) + Weekly (30%) + Daily (20%) + Current (10%)
   */
  getWeightedAverageRate(symbol: string, exchange: ExchangeType, currentRate: number): number;

  /**
   * Get weighted average spread between two exchanges
   * Calculates spread for each matching timestamp pair, then applies weighted averaging
   */
  getAverageSpread(
    longSymbol: string,
    longExchange: ExchangeType,
    shortSymbol: string,
    shortExchange: ExchangeType,
    currentLongRate: number,
    currentShortRate: number,
  ): number;
}
