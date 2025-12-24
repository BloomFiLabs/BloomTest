import { Injectable, Logger, Inject, OnModuleInit } from '@nestjs/common';
import {
  IFundingRatePredictionService,
  EnsemblePredictionResult,
  RegimeDetectionResult,
  PredictionContext,
  HistoricalRatePoint,
  HistoricalOIPoint,
  SpreadPredictionResult,
} from '../../ports/IFundingRatePredictor';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { EnsemblePredictor } from './EnsemblePredictor';
import { KalmanFilterEstimator } from './filters/KalmanFilterEstimator';
import { RegimeDetector } from './filters/RegimeDetector';
import type { IHistoricalFundingRateService } from '../../ports/IHistoricalFundingRateService';
import { FundingRateAggregator } from '../FundingRateAggregator';

/**
 * Configuration for prediction service
 */
const SERVICE_CONFIG = {
  /** Minimum historical data points for reliable prediction */
  MIN_HISTORICAL_POINTS: 24,
  /** Default prediction horizon in hours */
  DEFAULT_HORIZON_HOURS: 1,
  /** Cache TTL for predictions in milliseconds */
  PREDICTION_CACHE_TTL_MS: 5 * 60 * 1000, // 5 minutes
  /** Maximum cache size */
  MAX_CACHE_SIZE: 500,
} as const;

/**
 * Cached prediction entry
 */
interface CachedPrediction {
  prediction: EnsemblePredictionResult;
  timestamp: Date;
}

/**
 * FundingRatePredictionService - Main orchestrator for funding rate predictions
 *
 * Integrates with existing infrastructure:
 * - HistoricalFundingRateService for historical data
 * - FundingRateAggregator for current rates and market data
 *
 * Provides:
 * - Single symbol predictions
 * - Spread predictions for arbitrage pairs
 * - Regime detection
 * - Prediction accuracy tracking
 *
 * @implements IFundingRatePredictionService
 */
@Injectable()
export class FundingRatePredictionService
  implements IFundingRatePredictionService, OnModuleInit
{
  private readonly logger = new Logger(FundingRatePredictionService.name);

  /** Prediction cache by symbol-exchange key */
  private readonly predictionCache: Map<string, CachedPrediction> = new Map();

  constructor(
    private readonly ensemblePredictor: EnsemblePredictor,
    private readonly kalmanFilter: KalmanFilterEstimator,
    private readonly regimeDetector: RegimeDetector,
    @Inject('IHistoricalFundingRateService')
    private readonly historicalService: IHistoricalFundingRateService,
    private readonly aggregator: FundingRateAggregator,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Funding Rate Prediction Service initialized');
    this.logger.log(
      `Ensemble predictors: ${this.ensemblePredictor.getPredictorNames().join(', ')}`,
    );
  }

  /**
   * Get ensemble prediction for a symbol/exchange pair
   */
  async getPrediction(
    symbol: string,
    exchange: ExchangeType,
  ): Promise<EnsemblePredictionResult> {
    const cacheKey = this.getCacheKey(symbol, exchange);

    // Check cache
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    // Build prediction context
    const context = await this.buildPredictionContext(symbol, exchange);

    // Warm up Kalman filter if needed
    this.warmUpKalmanFilter(symbol, exchange, context.historicalRates);

    // Generate ensemble prediction
    const prediction = this.ensemblePredictor.predict(context);

    // Cache result
    this.addToCache(cacheKey, prediction);

    this.logger.debug(
      `${symbol}/${exchange}: Predicted rate ${(prediction.predictedRate * 100).toFixed(4)}% ` +
        `(confidence: ${(prediction.confidence * 100).toFixed(1)}%, regime: ${prediction.regime})`,
    );

    return prediction;
  }

  /**
   * Get prediction for spread between two exchanges
   * Used for arbitrage opportunity evaluation
   * 
   * Returns predicted spread, confidence, and expected reversion time
   * based on Ornstein-Uhlenbeck mean reversion model
   */
  async getSpreadPrediction(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): Promise<SpreadPredictionResult> {
    // Get individual predictions in parallel
    const [longPrediction, shortPrediction] = await Promise.all([
      this.getPrediction(symbol, longExchange),
      this.getPrediction(symbol, shortExchange),
    ]);

    // Calculate spread: long receives funding, short pays
    // For arbitrage: we want long rate negative (receive) and short rate positive (pay)
    // Spread = long rate - short rate (positive = profitable)
    const predictedSpread =
      longPrediction.predictedRate - shortPrediction.predictedRate;

    // Combined confidence (geometric mean)
    const confidence = Math.sqrt(
      longPrediction.confidence * shortPrediction.confidence,
    );

    // Get current spread from current rates (not predicted)
    const rates = await this.aggregator.getFundingRates(symbol);
    const longRate = rates.find(r => r.exchange === longExchange)?.currentRate ?? 0;
    const shortRate = rates.find(r => r.exchange === shortExchange)?.currentRate ?? 0;
    const currentSpread = longRate - shortRate;

    // Calculate expected reversion time
    // Use the more conservative (longer) half-life of the two exchanges
    const longHalfLife = this.ensemblePredictor.getExpectedReversionHours(
      symbol,
      String(longExchange),
      0.5, // Half-life
    );
    const shortHalfLife = this.ensemblePredictor.getExpectedReversionHours(
      symbol,
      String(shortExchange),
      0.5,
    );

    // Use the max of the two half-lives (more conservative estimate)
    // If both are null, we don't have enough data
    let expectedReversionHours: number | null = null;
    if (longHalfLife !== null && shortHalfLife !== null) {
      expectedReversionHours = Math.max(longHalfLife, shortHalfLife);
    } else if (longHalfLife !== null) {
      expectedReversionHours = longHalfLife;
    } else if (shortHalfLife !== null) {
      expectedReversionHours = shortHalfLife;
    }

    // Calculate long-term mean spread
    const longMean = this.ensemblePredictor.getLongTermMean(symbol, String(longExchange));
    const shortMean = this.ensemblePredictor.getLongTermMean(symbol, String(shortExchange));
    const meanSpread = (longMean ?? 0) - (shortMean ?? 0);

    this.logger.debug(
      `${symbol} spread ${longExchange}->${shortExchange}: ` +
        `predicted=${(predictedSpread * 100).toFixed(4)}%, ` +
        `current=${(currentSpread * 100).toFixed(4)}%, ` +
        `reversion=${expectedReversionHours?.toFixed(1) ?? 'N/A'}h, ` +
        `confidence=${(confidence * 100).toFixed(1)}%`,
    );

    return {
      predictedSpread,
      confidence,
      longPrediction,
      shortPrediction,
      expectedReversionHours,
      currentSpread,
      meanSpread,
    };
  }

  /**
   * Get current market regime for a symbol/exchange
   */
  async getMarketRegime(
    symbol: string,
    exchange: ExchangeType,
  ): Promise<RegimeDetectionResult> {
    const context = await this.buildPredictionContext(symbol, exchange);
    return this.regimeDetector.detectRegime(context);
  }

  /**
   * Update predictor weights based on prediction accuracy
   * Call this when actual funding rate becomes known
   */
  updatePredictorWeights(
    symbol: string,
    exchange: ExchangeType,
    actualRate: number,
    predictedRate: number,
  ): void {
    const cacheKey = this.getCacheKey(symbol, exchange);
    const cached = this.predictionCache.get(cacheKey);

    if (cached) {
      this.ensemblePredictor.updatePredictorErrors(
        symbol,
        String(exchange),
        actualRate,
        cached.prediction,
      );

      // Update Kalman filter with actual observation
      this.kalmanFilter.update(symbol, String(exchange), actualRate, 1);

      const error = Math.abs(actualRate - predictedRate);
      this.logger.debug(
        `${symbol}/${exchange}: Prediction error ${(error * 100).toFixed(4)}% ` +
          `(predicted: ${(predictedRate * 100).toFixed(4)}%, actual: ${(actualRate * 100).toFixed(4)}%)`,
      );
    }
  }

  /**
   * Build prediction context from available data
   */
  private async buildPredictionContext(
    symbol: string,
    exchange: ExchangeType,
  ): Promise<PredictionContext> {
    // Get current funding rate data
    const rates = await this.aggregator.getFundingRates(symbol);
    const currentRateData = rates.find((r) => r.exchange === exchange);

    // Get historical data
    const historicalRates = this.getHistoricalRates(symbol, exchange);

    // Get OI data if available (from current rate data)
    const historicalOI = this.buildHistoricalOI(symbol, exchange);

    // Helper to sanitize numbers - ?? doesn't catch NaN, only null/undefined
    const sanitizeNumber = (val: number | undefined, fallback: number): number => {
      if (val === undefined || val === null || !isFinite(val)) {
        return fallback;
      }
      return val;
    };

    return {
      symbol,
      exchange,
      currentRate: sanitizeNumber(currentRateData?.currentRate, 0),
      historicalRates,
      markPrice: sanitizeNumber(currentRateData?.markPrice, 0),
      indexPrice: undefined, // Would need spot price data
      openInterest: sanitizeNumber(currentRateData?.openInterest, undefined as any),
      historicalOI,
      volume24h: sanitizeNumber(currentRateData?.volume24h, undefined as any),
      timestamp: new Date(),
    };
  }

  /**
   * Get historical rates from service and convert to expected format
   * Filters out any NaN or invalid rate values to prevent NaN propagation
   */
  private getHistoricalRates(
    symbol: string,
    exchange: ExchangeType,
  ): HistoricalRatePoint[] {
    const data = this.historicalService.getHistoricalData(symbol, exchange);

    // Sort by timestamp descending (most recent first)
    // Filter out any NaN or invalid rates to prevent NaN propagation in predictions
    return data
      .filter((d) => isFinite(d.rate)) // Remove NaN, Infinity, -Infinity
      .map((d) => ({
        rate: d.rate,
        timestamp: d.timestamp,
      }))
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Build historical OI data (placeholder - would need OI history service)
   */
  private buildHistoricalOI(
    _symbol: string,
    _exchange: ExchangeType,
  ): HistoricalOIPoint[] {
    // OI history not currently available in the system
    // This would need to be implemented separately
    return [];
  }

  /**
   * Warm up Kalman filter with historical data
   */
  private warmUpKalmanFilter(
    symbol: string,
    exchange: ExchangeType,
    historicalRates: HistoricalRatePoint[],
  ): void {
    const state = this.kalmanFilter.getState(symbol, String(exchange));

    if (!state && historicalRates.length > 0) {
      // Filter needs initialization
      this.kalmanFilter.warmUp(symbol, String(exchange), historicalRates);
      this.logger.debug(
        `Kalman filter warmed up for ${symbol}/${exchange} with ${historicalRates.length} points`,
      );
    }
  }

  /**
   * Get cached prediction if still valid
   */
  private getFromCache(key: string): EnsemblePredictionResult | null {
    const cached = this.predictionCache.get(key);

    if (!cached) return null;

    const age = Date.now() - cached.timestamp.getTime();
    if (age > SERVICE_CONFIG.PREDICTION_CACHE_TTL_MS) {
      this.predictionCache.delete(key);
      return null;
    }

    return cached.prediction;
  }

  /**
   * Add prediction to cache
   */
  private addToCache(key: string, prediction: EnsemblePredictionResult): void {
    // Evict oldest entries if cache is full
    if (this.predictionCache.size >= SERVICE_CONFIG.MAX_CACHE_SIZE) {
      const oldestKey = this.predictionCache.keys().next().value;
      if (oldestKey) {
        this.predictionCache.delete(oldestKey);
      }
    }

    this.predictionCache.set(key, {
      prediction,
      timestamp: new Date(),
    });
  }

  /**
   * Get cache key for symbol-exchange pair
   */
  private getCacheKey(symbol: string, exchange: ExchangeType): string {
    return `${symbol}_${exchange}`;
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.predictionCache.clear();
    this.kalmanFilter.clearCache();
    this.regimeDetector.clearCache();
    this.ensemblePredictor.clearErrorCache();
    this.logger.log('All prediction caches cleared');
  }

  /**
   * Get prediction statistics for monitoring
   */
  getStatistics(): {
    cacheSize: number;
    predictorNames: string[];
    weightConfig: ReturnType<typeof this.ensemblePredictor.getWeightConfig>;
  } {
    return {
      cacheSize: this.predictionCache.size,
      predictorNames: this.ensemblePredictor.getPredictorNames(),
      weightConfig: this.ensemblePredictor.getWeightConfig(),
    };
  }
}
