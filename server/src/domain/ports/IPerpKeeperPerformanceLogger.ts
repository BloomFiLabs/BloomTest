import { ExchangeType } from '../value-objects/ExchangeConfig';
import { PerpPosition } from '../entities/PerpPosition';

/**
 * Performance metrics for a single exchange
 */
export interface ExchangePerformanceMetrics {
  exchangeType: ExchangeType;
  totalFundingCaptured: number; // Total funding payments received (USD)
  totalFundingPaid: number; // Total funding payments paid out (USD)
  netFundingCaptured: number; // Net funding (received - paid)
  positionsCount: number;
  totalPositionValue: number; // Total value of all positions (USD)
  totalUnrealizedPnl: number; // Unrealized P&L from positions
  ordersExecuted: number;
  ordersFilled: number;
  ordersFailed: number;
  lastUpdateTime: Date;
}

/**
 * Overall strategy performance metrics
 */
export interface StrategyPerformanceMetrics {
  startTime: Date;
  currentTime: Date;
  runtimeHours: number;
  runtimeDays: number;

  // Funding metrics
  totalFundingCaptured: number; // Total funding received across all exchanges (USD)
  totalFundingPaid: number; // Total funding paid across all exchanges (USD)
  netFundingCaptured: number; // Net funding (received - paid)

  // Position metrics
  totalPositions: number;
  totalPositionValue: number; // Total value of all positions (USD)
  totalUnrealizedPnl: number; // Unrealized P&L
  totalRealizedPnl: number; // Realized P&L from closed positions

  // Trading metrics
  totalOrdersPlaced: number;
  totalOrdersFilled: number;
  totalOrdersFailed: number;
  arbitrageOpportunitiesFound: number;
  arbitrageOpportunitiesExecuted: number;

  // APY calculations
  estimatedAPY: number; // Based on current funding rates and positions
  realizedAPY: number; // Based on actual funding captured
  fundingAPY: number; // Realized APY from funding payments only
  pricePnlAPY: number; // Realized APY from price movement (basis drift)
  expectedEarningsNextPeriod: number; // Predicted earnings for the next 1h period (USD)
  estimatedDailyReturn: number; // Estimated daily return based on current rates
  realizedDailyReturn: number; // Actual daily return from funding captured

  // Historical earnings tracking
  historicalEarnings: Array<{
    timestamp: Date;
    expected: number;
    actual: number;
  }>;

  // Exchange-specific metrics
  exchangeMetrics: Map<ExchangeType, ExchangePerformanceMetrics>;

  // Capital efficiency
  capitalDeployed: number; // Total capital deployed across all positions
  capitalUtilization: number; // Percentage of available capital being used
  averagePositionSize: number;

  // Risk metrics
  maxDrawdown: number;
  sharpeRatio: number; // If we have enough data
}

/**
 * Interface for performance logging in the perp keeper
 */
export interface IPerpKeeperPerformanceLogger {
  /**
   * Record a funding payment (positive = received, negative = paid)
   */
  recordFundingPayment(exchange: ExchangeType, amount: number, timestamp?: Date): void;

  /**
   * Record trading costs (fees, slippage, etc.) for break-even calculation
   */
  recordTradingCosts(amount: number): void;

  /**
   * Record realized P&L from closed positions
   */
  recordRealizedPnl(amount: number): void;

  /**
   * Update position metrics for an exchange
   */
  updatePositionMetrics(
    exchange: ExchangeType,
    positions: PerpPosition[],
    fundingRates: Array<{
      symbol: string;
      exchange: ExchangeType;
      fundingRate: number;
    }>,
  ): void;

  /**
   * Record order execution
   */
  recordOrderExecution(
    exchange: ExchangeType,
    filled: boolean,
    failed: boolean,
  ): void;

  /**
   * Record arbitrage opportunity
   */
  recordArbitrageOpportunity(found: boolean, executed: boolean): void;

  /**
   * Record trade volume (USD value of filled trades)
   */
  recordTradeVolume(volume: number): void;

  /**
   * Calculate estimated APY based on current funding rates and positions
   */
  calculateEstimatedAPY(): number;

  /**
   * Calculate realized APY based on actual funding payments
   */
  calculateRealizedAPY(capitalDeployed: number): number;

  /**
   * Get comprehensive performance metrics
   */
  getPerformanceMetrics(capitalDeployed?: number): StrategyPerformanceMetrics;

  /**
   * Log comprehensive performance metrics
   */
  logPerformanceMetrics(capitalDeployed?: number): void;

  /**
   * Sync historical funding payments from exchange APIs
   */
  syncHistoricalFundingPayments(): Promise<void>;

  /**
   * Capture an hourly snapshot of expected vs actual earnings
   */
  captureHourlyEarnings(expected: number, actual: number): void;
}
