import { Injectable, Logger } from '@nestjs/common';
import {
  IFundingRatePredictor,
  PredictionContext,
  PredictionResult,
  OUParameters,
  HistoricalRatePoint,
} from '../../../ports/IFundingRatePredictor';
import { KalmanFilterEstimator } from '../filters/KalmanFilterEstimator';

/**
 * Configuration for mean reversion predictor
 */
const MR_CONFIG = {
  /** Minimum data points required for OU parameter estimation */
  MIN_DATA_POINTS: 24,
  /** Default mean reversion speed when estimation fails */
  DEFAULT_KAPPA: 0.1,
  /** Minimum kappa (prevents extremely slow reversion) */
  MIN_KAPPA: 0.01,
  /** Maximum kappa (prevents unrealistic fast reversion) */
  MAX_KAPPA: 2.0,
  /** Prediction horizon in hours */
  HORIZON_HOURS: 1,
  /** Base confidence when model fits well */
  BASE_CONFIDENCE: 0.7,
  /** Confidence boost when rate is far from mean */
  DISTANCE_CONFIDENCE_BOOST: 0.15,
  /** Confidence penalty for low R-squared */
  R_SQUARED_PENALTY_FACTOR: 0.3,
} as const;

/**
 * MeanReversionPredictor - Implements Ornstein-Uhlenbeck process prediction
 *
 * The OU process models mean-reverting behavior:
 *   dX = κ(θ - X)dt + σdW
 *
 * Where:
 * - X is the funding rate
 * - κ (kappa) is the mean reversion speed
 * - θ (theta) is the long-term mean
 * - σ (sigma) is the volatility
 * - W is a Wiener process (Brownian motion)
 *
 * Prediction: E[X(t+h)] = θ + (X(t) - θ) * exp(-κh)
 *
 * @see PDF Section II - Mean Reversion Models
 */
@Injectable()
export class MeanReversionPredictor implements IFundingRatePredictor {
  readonly name = 'MeanReversion';
  private readonly logger = new Logger(MeanReversionPredictor.name);

  /** Cached OU parameters by symbol-exchange key */
  private readonly parameterCache: Map<string, OUParameters> = new Map();

  constructor(private readonly kalmanFilter: KalmanFilterEstimator) {}

  /**
   * Check if we have enough data to make predictions
   */
  canPredict(context: PredictionContext): boolean {
    return context.historicalRates.length >= MR_CONFIG.MIN_DATA_POINTS;
  }

  /**
   * Get base confidence for this predictor
   */
  getBaseConfidence(): number {
    return MR_CONFIG.BASE_CONFIDENCE;
  }

  /**
   * Generate mean reversion prediction
   */
  predict(context: PredictionContext): PredictionResult {
    if (!this.canPredict(context)) {
      return this.createLowConfidencePrediction(context.currentRate);
    }

    // Estimate OU parameters from historical data
    const params = this.estimateOUParameters(context);
    const key = this.getKey(context.symbol, context.exchange);
    this.parameterCache.set(key, params);

    // Use Kalman filter for smoothed current state
    const kalmanState = this.kalmanFilter.getState(
      context.symbol,
      String(context.exchange),
    );
    const smoothedRate = kalmanState?.rate ?? context.currentRate;

    // OU prediction: E[X(t+h)] = θ + (X(t) - θ) * exp(-κh)
    const h = MR_CONFIG.HORIZON_HOURS;
    const decay = Math.exp(-params.kappa * h);
    const predictedRate = params.theta + (smoothedRate - params.theta) * decay;

    // Calculate prediction bounds using OU variance
    const variance = this.calculateOUVariance(params, h);
    const stdDev = Math.sqrt(variance);

    // Calculate confidence
    const confidence = this.calculateConfidence(context, params, smoothedRate);

    return {
      predictedRate,
      confidence,
      horizonHours: h,
      upperBound: predictedRate + 2 * stdDev,
      lowerBound: predictedRate - 2 * stdDev,
      metadata: {
        kappa: params.kappa,
        theta: params.theta,
        sigma: params.sigma,
        rSquared: params.rSquared,
        smoothedRate,
        decayFactor: decay,
      },
    };
  }

  /**
   * Estimate OU parameters using Maximum Likelihood Estimation (MLE)
   *
   * For discrete observations at regular intervals Δt:
   * X(t+Δt) = θ(1 - e^(-κΔt)) + e^(-κΔt)X(t) + ε
   *
   * This is equivalent to AR(1): Y(t) = a + bY(t-1) + ε
   * where a = θ(1-b), b = e^(-κΔt)
   */
  private estimateOUParameters(context: PredictionContext): OUParameters {
    const rates = this.prepareRateTimeSeries(context.historicalRates);

    if (rates.length < MR_CONFIG.MIN_DATA_POINTS) {
      return this.getDefaultParameters(context.historicalRates);
    }

    // Estimate AR(1) parameters: Y(t) = a + b*Y(t-1) + ε
    const { a, b, rSquared } = this.estimateAR1(rates);

    // Convert AR(1) to OU parameters
    // Assume Δt = 1 hour (standard funding interval)
    const deltaT = 1;

    // b = exp(-κΔt) => κ = -ln(b)/Δt
    const kappa = this.clampKappa(-Math.log(Math.max(b, 0.01)) / deltaT);

    // a = θ(1-b) => θ = a/(1-b)
    const theta =
      Math.abs(1 - b) > 1e-6 ? a / (1 - b) : this.calculateMean(rates);

    // Estimate sigma from residuals
    const sigma = this.estimateSigma(rates, a, b);

    return { kappa, theta, sigma, rSquared };
  }

  /**
   * Estimate AR(1) parameters using OLS regression
   * Y(t) = a + b*Y(t-1) + ε
   */
  private estimateAR1(rates: number[]): {
    a: number;
    b: number;
    rSquared: number;
  } {
    const n = rates.length - 1;
    if (n < 2) {
      return { a: 0, b: 0.9, rSquared: 0 };
    }

    // Prepare lagged variables
    const Y = rates.slice(1); // Y(t)
    const X = rates.slice(0, -1); // Y(t-1)

    // Calculate means
    const meanY = this.calculateMean(Y);
    const meanX = this.calculateMean(X);

    // Calculate covariance and variance
    let covXY = 0;
    let varX = 0;
    let varY = 0;

    for (let i = 0; i < n; i++) {
      const dx = X[i] - meanX;
      const dy = Y[i] - meanY;
      covXY += dx * dy;
      varX += dx * dx;
      varY += dy * dy;
    }

    // OLS estimates
    const b = varX > 1e-12 ? covXY / varX : 0.9;
    const a = meanY - b * meanX;

    // R-squared
    const rSquared = varY > 1e-12 ? (covXY * covXY) / (varX * varY) : 0;

    return { a, b: Math.min(0.999, Math.max(0, b)), rSquared };
  }

  /**
   * Estimate sigma from AR(1) residuals
   */
  private estimateSigma(rates: number[], a: number, b: number): number {
    const n = rates.length - 1;
    if (n < 2) return 1e-4;

    let sumSquaredResiduals = 0;
    for (let i = 1; i < rates.length; i++) {
      const predicted = a + b * rates[i - 1];
      const residual = rates[i] - predicted;
      sumSquaredResiduals += residual * residual;
    }

    return Math.sqrt(sumSquaredResiduals / (n - 2));
  }

  /**
   * Calculate OU process variance at horizon h
   * Var[X(t+h)] = (σ²/2κ)(1 - e^(-2κh))
   */
  private calculateOUVariance(params: OUParameters, h: number): number {
    if (params.kappa < 1e-6) {
      // When kappa is very small, variance grows linearly
      return params.sigma * params.sigma * h;
    }
    return (
      ((params.sigma * params.sigma) / (2 * params.kappa)) *
      (1 - Math.exp(-2 * params.kappa * h))
    );
  }

  /**
   * Calculate prediction confidence
   */
  private calculateConfidence(
    context: PredictionContext,
    params: OUParameters,
    currentRate: number,
  ): number {
    let confidence = MR_CONFIG.BASE_CONFIDENCE;

    // Boost confidence when rate is far from mean (mean reversion more reliable)
    const distanceFromMean = Math.abs(currentRate - params.theta);
    const normalizedDistance =
      distanceFromMean / (Math.abs(params.theta) + 1e-6);
    if (normalizedDistance > 1) {
      confidence += MR_CONFIG.DISTANCE_CONFIDENCE_BOOST;
    }

    // Penalize low R-squared (poor model fit)
    confidence -= (1 - params.rSquared) * MR_CONFIG.R_SQUARED_PENALTY_FACTOR;

    // Penalize when kappa is at bounds (estimation may be unreliable)
    if (
      params.kappa <= MR_CONFIG.MIN_KAPPA ||
      params.kappa >= MR_CONFIG.MAX_KAPPA
    ) {
      confidence -= 0.1;
    }

    return Math.max(0.1, Math.min(0.95, confidence));
  }

  /**
   * Create low confidence prediction when insufficient data
   */
  private createLowConfidencePrediction(currentRate: number): PredictionResult {
    return {
      predictedRate: currentRate,
      confidence: 0.1,
      horizonHours: MR_CONFIG.HORIZON_HOURS,
      metadata: {
        reason: 'Insufficient historical data for OU estimation',
      },
    };
  }

  /**
   * Get default parameters when estimation fails
   */
  private getDefaultParameters(rates: HistoricalRatePoint[]): OUParameters {
    const values = rates.map((r) => r.rate);
    const theta = values.length > 0 ? this.calculateMean(values) : 0;
    const sigma = values.length > 1 ? this.calculateStdDev(values) : 1e-4;

    return {
      kappa: MR_CONFIG.DEFAULT_KAPPA,
      theta,
      sigma,
      rSquared: 0,
    };
  }

  /**
   * Prepare rate time series (sorted by time, oldest first)
   */
  private prepareRateTimeSeries(rates: HistoricalRatePoint[]): number[] {
    return [...rates]
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      .map((r) => r.rate);
  }

  /**
   * Clamp kappa to reasonable bounds
   */
  private clampKappa(kappa: number): number {
    if (isNaN(kappa) || !isFinite(kappa)) {
      return MR_CONFIG.DEFAULT_KAPPA;
    }
    return Math.max(MR_CONFIG.MIN_KAPPA, Math.min(MR_CONFIG.MAX_KAPPA, kappa));
  }

  /**
   * Calculate mean of array
   */
  private calculateMean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /**
   * Calculate standard deviation
   */
  private calculateStdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const mean = this.calculateMean(values);
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  /**
   * Get cached OU parameters for a symbol-exchange pair
   */
  getCachedParameters(symbol: string, exchange: string): OUParameters | null {
    return this.parameterCache.get(this.getKey(symbol, exchange)) ?? null;
  }

  /**
   * Calculate the half-life of mean reversion in hours
   * 
   * Half-life is the time it takes for the rate to revert halfway to the mean.
   * Formula: t_1/2 = ln(2) / κ
   * 
   * @param symbol Normalized symbol
   * @param exchange Exchange type
   * @returns Half-life in hours, or null if no cached parameters exist
   */
  getHalfLifeHours(symbol: string, exchange: string): number | null {
    const params = this.getCachedParameters(symbol, exchange);
    if (!params) {
      return null;
    }
    return this.calculateHalfLife(params.kappa);
  }

  /**
   * Calculate half-life from kappa (mean reversion speed)
   * Formula: t_1/2 = ln(2) / κ
   * 
   * @param kappa Mean reversion speed parameter
   * @returns Half-life in hours
   */
  private calculateHalfLife(kappa: number): number {
    if (kappa <= 0 || !isFinite(kappa)) {
      // Default to 24 hours if kappa is invalid
      return 24;
    }
    const halfLife = Math.log(2) / kappa;
    // Clamp to reasonable bounds: 1 hour to 7 days
    return Math.max(1, Math.min(168, halfLife));
  }

  /**
   * Get expected time to 90% reversion in hours
   * This is more conservative than half-life for profit-taking decisions
   * 
   * Formula: t_90 = ln(10) / κ ≈ 2.3 / κ
   * 
   * @param symbol Normalized symbol
   * @param exchange Exchange type
   * @returns Time to 90% reversion in hours, or null if no parameters
   */
  getTimeToReversionHours(symbol: string, exchange: string, reversionPercent: number = 0.5): number | null {
    const params = this.getCachedParameters(symbol, exchange);
    if (!params || params.kappa <= 0) {
      return null;
    }
    
    // Time to X% reversion: t = -ln(1 - X) / κ
    // e.g., 50% reversion: t = ln(2) / κ (half-life)
    // e.g., 90% reversion: t = ln(10) / κ
    const factor = -Math.log(1 - reversionPercent);
    const timeToReversion = factor / params.kappa;
    
    // Clamp to reasonable bounds: 1 hour to 14 days
    return Math.max(1, Math.min(336, timeToReversion));
  }

  /**
   * Get cache key
   */
  private getKey(symbol: string, exchange: unknown): string {
    return `${symbol}_${String(exchange)}`;
  }
}
