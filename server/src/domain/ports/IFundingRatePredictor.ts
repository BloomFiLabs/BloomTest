import { ExchangeType } from '../value-objects/ExchangeConfig';

/**
 * Market regime classification for funding rate behavior
 * Used to adjust prediction strategy weights dynamically
 */
export enum MarketRegime {
  /** Normal market conditions - mean reversion reliable */
  MEAN_REVERTING = 'mean_reverting',
  /** Sustained directional funding movement */
  TRENDING = 'trending',
  /** High volatility - predictions less reliable */
  HIGH_VOLATILITY = 'high_volatility',
  /** Extreme dislocation - funding > 4x normal, arbitrage capacity exhausted */
  EXTREME_DISLOCATION = 'extreme_dislocation',
}

/**
 * Context provided to predictors for making predictions
 * Contains all relevant market data needed for forecasting
 */
export interface PredictionContext {
  /** Normalized symbol (e.g., "ETH") */
  symbol: string;
  /** Exchange type */
  exchange: ExchangeType;
  /** Current funding rate (hourly, as decimal e.g., 0.0001 = 0.01%) */
  currentRate: number;
  /** Historical funding rates (most recent first) */
  historicalRates: HistoricalRatePoint[];
  /** Current mark price */
  markPrice: number;
  /** Current index/spot price (if available) */
  indexPrice?: number;
  /** Current open interest in USD */
  openInterest?: number;
  /** Historical open interest points */
  historicalOI?: HistoricalOIPoint[];
  /** 24h trading volume in USD */
  volume24h?: number;
  /** Current detected market regime */
  currentRegime?: MarketRegime;
  /** Timestamp of the prediction request */
  timestamp: Date;
}

/**
 * Historical funding rate data point
 */
export interface HistoricalRatePoint {
  rate: number;
  timestamp: Date;
}

/**
 * Historical open interest data point
 */
export interface HistoricalOIPoint {
  openInterest: number;
  price: number;
  timestamp: Date;
}

/**
 * Result of a funding rate prediction
 */
export interface PredictionResult {
  /** Predicted funding rate for next period (hourly, as decimal) */
  predictedRate: number;
  /** Confidence in prediction (0-1) */
  confidence: number;
  /** Prediction horizon in hours */
  horizonHours: number;
  /** Upper bound of prediction interval (optional) */
  upperBound?: number;
  /** Lower bound of prediction interval (optional) */
  lowerBound?: number;
  /** Additional metadata from predictor */
  metadata?: Record<string, unknown>;
}

/**
 * Interface for individual funding rate predictors
 * Implements Strategy pattern - each predictor uses a different approach
 */
export interface IFundingRatePredictor {
  /** Unique name of the predictor */
  readonly name: string;

  /**
   * Generate a funding rate prediction
   * @param context Market context for prediction
   * @returns Prediction result with rate and confidence
   */
  predict(context: PredictionContext): PredictionResult;

  /**
   * Get the base confidence level for this predictor
   * Used for ensemble weighting
   */
  getBaseConfidence(): number;

  /**
   * Check if predictor has enough data to make predictions
   * @param context Market context to check
   */
  canPredict(context: PredictionContext): boolean;
}

/**
 * Ornstein-Uhlenbeck process parameters
 * Used for mean reversion estimation
 */
export interface OUParameters {
  /** Mean reversion speed (kappa) - higher = faster reversion */
  kappa: number;
  /** Long-term mean (theta) - rate reverts to this value */
  theta: number;
  /** Volatility (sigma) - noise level */
  sigma: number;
  /** Goodness of fit (R-squared) */
  rSquared: number;
}

/**
 * Kalman filter state vector
 */
export interface KalmanState {
  /** Estimated funding rate */
  rate: number;
  /** Estimated rate of change (velocity) */
  rateVelocity: number;
  /** Estimated volatility */
  volatility: number;
  /** State covariance matrix (flattened 3x3) */
  covariance: number[];
}

/**
 * Regime detection result
 */
export interface RegimeDetectionResult {
  /** Detected market regime */
  regime: MarketRegime;
  /** Confidence in regime classification (0-1) */
  confidence: number;
  /** Regime-specific metrics */
  metrics: {
    /** Current volatility relative to historical */
    volatilityRatio: number;
    /** Trend strength (-1 to 1, negative = downtrend) */
    trendStrength: number;
    /** Mean reversion score (0-1, higher = more mean reverting) */
    meanReversionScore: number;
    /** Dislocation level (current rate / historical mean) */
    dislocationLevel: number;
  };
}

/**
 * Ensemble prediction result with individual predictor contributions
 */
export interface EnsemblePredictionResult extends PredictionResult {
  /** Individual predictor results */
  individualPredictions: Array<{
    predictorName: string;
    prediction: PredictionResult;
    weight: number;
    contribution: number;
  }>;
  /** Current regime used for weighting */
  regime: MarketRegime;
  /** Regime detection confidence */
  regimeConfidence: number;
}

/**
 * Configuration for ensemble predictor weights
 */
export interface EnsembleWeightConfig {
  /** Base weights by predictor name (sum to 1.0) */
  baseWeights: Record<string, number>;
  /** Weight adjustments by regime */
  regimeAdjustments: Record<MarketRegime, Record<string, number>>;
  /** Weight decay factor for recent prediction errors (0-1) */
  errorDecayFactor: number;
}

/**
 * Result of spread prediction between two exchanges
 */
export interface SpreadPredictionResult {
  /** Predicted funding rate spread (long - short) */
  predictedSpread: number;
  /** Combined confidence (geometric mean of individual confidences) */
  confidence: number;
  /** Prediction for long exchange */
  longPrediction: EnsemblePredictionResult;
  /** Prediction for short exchange */
  shortPrediction: EnsemblePredictionResult;
  /** Expected hours until spread reverts to mean (half-life based) */
  expectedReversionHours: number | null;
  /** Current spread for comparison */
  currentSpread: number;
  /** Long-term mean spread the spread is expected to revert to */
  meanSpread: number;
}

/**
 * Interface for the main prediction service
 */
export interface IFundingRatePredictionService {
  /**
   * Get ensemble prediction for a symbol/exchange
   * @param symbol Normalized symbol
   * @param exchange Exchange type
   * @returns Ensemble prediction with individual contributions
   */
  getPrediction(
    symbol: string,
    exchange: ExchangeType,
  ): Promise<EnsemblePredictionResult>;

  /**
   * Get prediction for spread between two exchanges
   * @param symbol Normalized symbol
   * @param longExchange Exchange for long position
   * @param shortExchange Exchange for short position
   * @returns Predicted spread, confidence, and expected reversion time
   */
  getSpreadPrediction(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): Promise<SpreadPredictionResult>;

  /**
   * Get current market regime for a symbol/exchange
   */
  getMarketRegime(
    symbol: string,
    exchange: ExchangeType,
  ): Promise<RegimeDetectionResult>;

  /**
   * Update predictor weights based on prediction accuracy
   * Called after actual rates are known
   */
  updatePredictorWeights(
    symbol: string,
    exchange: ExchangeType,
    actualRate: number,
    predictedRate: number,
  ): void;
}
