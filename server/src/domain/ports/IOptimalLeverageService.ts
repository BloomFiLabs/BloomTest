import { ExchangeType } from '../value-objects/ExchangeConfig';

/**
 * Factors that contribute to leverage calculation
 */
export interface LeverageFactors {
  volatilityScore: number;      // 0-1 (lower vol = higher score)
  liquidationRiskScore: number; // 0-1 (farther from liq = higher score)
  liquidityScore: number;       // 0-1 (more OI = higher score)
  winRateScore: number;         // 0-1 (higher win rate = higher score)
}

/**
 * Leverage recommendation for a specific asset
 */
export interface LeverageRecommendation {
  symbol: string;
  exchange: ExchangeType;
  currentLeverage: number;
  optimalLeverage: number;
  maxSafeLeverage: number;
  factors: LeverageFactors;
  compositeScore: number;       // 0-1 weighted score
  shouldAdjust: boolean;
  reason: string;
  timestamp: Date;
}

/**
 * Volatility metrics for an asset
 */
export interface VolatilityMetrics {
  symbol: string;
  exchange: ExchangeType;
  dailyVolatility: number;      // Standard deviation of daily returns
  hourlyVolatility: number;     // Standard deviation of hourly returns
  maxDrawdown24h: number;       // Maximum drawdown in last 24 hours
  atr: number;                  // Average True Range
  lookbackHours: number;
  dataPoints: number;
  timestamp: Date;
}

/**
 * Liquidation risk assessment
 */
export interface LiquidationRisk {
  symbol: string;
  exchange: ExchangeType;
  currentPrice: number;
  entryPrice: number;
  liquidationPrice: number;
  distanceToLiquidation: number; // Percentage distance
  leverage: number;
  isAtRisk: boolean;            // True if distance < 10%
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

/**
 * Liquidity assessment for position sizing
 */
export interface LiquidityAssessment {
  symbol: string;
  exchange: ExchangeType;
  openInterest: number;
  positionSizeUsd: number;
  positionAsPercentOfOI: number;
  estimatedSlippage: number;
  maxRecommendedSize: number;   // Max size to keep slippage < 0.5%
  liquidityScore: number;       // 0-1
}

/**
 * Alert when leverage adjustment is recommended
 */
export interface LeverageAlert {
  symbol: string;
  exchange: ExchangeType;
  alertType: 'INCREASE' | 'DECREASE' | 'CRITICAL';
  currentLeverage: number;
  recommendedLeverage: number;
  reason: string;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH';
  timestamp: Date;
}

/**
 * Configuration for leverage calculation
 */
export interface LeverageConfig {
  minLeverage: number;          // Floor (default: 1x)
  maxLeverage: number;          // Ceiling (default: 10x)
  volatilityLookbackHours: number;
  leverageOverrides: Map<string, number>; // Per-symbol overrides
  volatilityWeight: number;     // Weight in composite score
  liquidationWeight: number;
  liquidityWeight: number;
  winRateWeight: number;
}

/**
 * Interface for optimal leverage calculation service
 */
export interface IOptimalLeverageService {
  /**
   * Calculate optimal leverage for a specific asset
   */
  calculateOptimalLeverage(
    symbol: string,
    exchange: ExchangeType,
    positionSizeUsd?: number,
  ): Promise<LeverageRecommendation>;

  /**
   * Get volatility metrics for an asset
   */
  getAssetVolatility(
    symbol: string,
    exchange: ExchangeType,
    lookbackHours?: number,
  ): Promise<VolatilityMetrics>;

  /**
   * Assess liquidation risk for a position
   */
  getLiquidationRisk(
    symbol: string,
    exchange: ExchangeType,
    leverage: number,
    entryPrice: number,
    currentPrice: number,
    side: 'LONG' | 'SHORT',
  ): LiquidationRisk;

  /**
   * Assess liquidity for position sizing
   */
  getLiquidityAssessment(
    symbol: string,
    exchange: ExchangeType,
    positionSizeUsd: number,
  ): Promise<LiquidityAssessment>;

  /**
   * Get win rate adjusted leverage factor
   */
  getWinRateAdjustedLeverage(symbol: string): Promise<number>;

  /**
   * Monitor all positions and generate alerts
   */
  monitorAndAlert(): Promise<LeverageAlert[]>;

  /**
   * Get leverage recommendation for all active symbols
   */
  getAllRecommendations(): Promise<LeverageRecommendation[]>;

  /**
   * Check if leverage adjustment is needed for a position
   */
  shouldAdjustLeverage(
    symbol: string,
    exchange: ExchangeType,
    currentLeverage: number,
  ): Promise<{ shouldAdjust: boolean; reason: string; recommendedLeverage: number }>;
}

