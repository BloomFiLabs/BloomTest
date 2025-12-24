import { Injectable, Logger } from '@nestjs/common';
import {
  IFundingRatePredictor,
  PredictionContext,
  PredictionResult,
  EnsemblePredictionResult,
  EnsembleWeightConfig,
  MarketRegime,
} from '../../ports/IFundingRatePredictor';
import { MeanReversionPredictor } from './predictors/MeanReversionPredictor';
import { PremiumIndexPredictor } from './predictors/PremiumIndexPredictor';
import { OpenInterestPredictor } from './predictors/OpenInterestPredictor';
import { RegimeDetector } from './filters/RegimeDetector';

/**
 * Default ensemble weight configuration
 * Weights are tuned based on predictor characteristics and backtested performance
 */
const DEFAULT_WEIGHT_CONFIG: EnsembleWeightConfig = {
  baseWeights: {
    MeanReversion: 0.4,
    PremiumIndex: 0.35,
    OpenInterest: 0.25,
  },
  regimeAdjustments: {
    [MarketRegime.MEAN_REVERTING]: {
      MeanReversion: 0.15, // Boost mean reversion in mean-reverting regime
      PremiumIndex: -0.05,
      OpenInterest: -0.1,
    },
    [MarketRegime.TRENDING]: {
      MeanReversion: -0.15, // Reduce mean reversion in trending regime
      PremiumIndex: 0.05,
      OpenInterest: 0.1, // OI more useful for trends
    },
    [MarketRegime.HIGH_VOLATILITY]: {
      MeanReversion: -0.1,
      PremiumIndex: 0.05,
      OpenInterest: 0.05,
    },
    [MarketRegime.EXTREME_DISLOCATION]: {
      MeanReversion: 0.1, // Mean reversion stronger in extremes
      PremiumIndex: -0.05,
      OpenInterest: -0.05,
    },
  },
  errorDecayFactor: 0.1,
};

/**
 * Predictor error tracking for adaptive weights
 */
interface PredictorErrorState {
  cumulativeError: number;
  predictionCount: number;
  lastPrediction: number;
  lastTimestamp: Date;
}

/**
 * EnsemblePredictor - Combines multiple predictors with weighted voting
 *
 * Features:
 * - Dynamic weight adjustment based on market regime
 * - Error-based weight decay for recent poor performance
 * - Confidence-weighted combination
 * - Prediction bounds aggregation
 *
 * @see PDF Section III - Ensemble Methods
 */
@Injectable()
export class EnsemblePredictor {
  private readonly logger = new Logger(EnsemblePredictor.name);

  /** All available predictors */
  private readonly predictors: IFundingRatePredictor[];

  /** Weight configuration */
  private readonly weightConfig: EnsembleWeightConfig;

  /** Error tracking by symbol-exchange-predictor key */
  private readonly errorStates: Map<string, PredictorErrorState> = new Map();

  constructor(
    private readonly meanReversionPredictor: MeanReversionPredictor,
    private readonly premiumIndexPredictor: PremiumIndexPredictor,
    private readonly openInterestPredictor: OpenInterestPredictor,
    private readonly regimeDetector: RegimeDetector,
  ) {
    this.predictors = [
      this.meanReversionPredictor,
      this.premiumIndexPredictor,
      this.openInterestPredictor,
    ];
    this.weightConfig = DEFAULT_WEIGHT_CONFIG;
  }

  /**
   * Generate ensemble prediction
   */
  predict(context: PredictionContext): EnsemblePredictionResult {
    // Detect current market regime
    const regimeResult = this.regimeDetector.detectRegime(context);
    const regime = regimeResult.regime;

    // Get predictions from all predictors
    const individualPredictions = this.collectPredictions(context);

    // Calculate regime-adjusted weights
    const weights = this.calculateWeights(
      context,
      regime,
      individualPredictions,
    );

    // Combine predictions
    const combined = this.combinePredictions(individualPredictions, weights);

    // Calculate aggregate bounds
    const bounds = this.calculateAggregateBounds(
      individualPredictions,
      weights,
    );

    return {
      predictedRate: combined.rate,
      confidence: combined.confidence,
      horizonHours: individualPredictions[0]?.prediction.horizonHours ?? 1,
      upperBound: bounds.upper,
      lowerBound: bounds.lower,
      individualPredictions: individualPredictions.map((ip, i) => ({
        predictorName: ip.predictor.name,
        prediction: ip.prediction,
        weight: weights[i],
        contribution: ip.prediction.predictedRate * weights[i],
      })),
      regime,
      regimeConfidence: regimeResult.confidence,
      metadata: {
        regimeMetrics: regimeResult.metrics,
        weightSource: 'regime_adjusted',
      },
    };
  }

  /**
   * Collect predictions from all capable predictors
   */
  private collectPredictions(
    context: PredictionContext,
  ): Array<{ predictor: IFundingRatePredictor; prediction: PredictionResult }> {
    const results: Array<{
      predictor: IFundingRatePredictor;
      prediction: PredictionResult;
    }> = [];

    for (const predictor of this.predictors) {
      try {
        if (predictor.canPredict(context)) {
          const prediction = predictor.predict(context);
          results.push({ predictor, prediction });
        } else {
          this.logger.debug(
            `Predictor ${predictor.name} cannot predict for ${context.symbol}`,
          );
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Predictor ${predictor.name} failed for ${context.symbol}: ${message}`,
        );
      }
    }

    return results;
  }

  /**
   * Calculate regime-adjusted weights with error decay
   */
  private calculateWeights(
    context: PredictionContext,
    regime: MarketRegime,
    predictions: Array<{
      predictor: IFundingRatePredictor;
      prediction: PredictionResult;
    }>,
  ): number[] {
    if (predictions.length === 0) return [];
    if (predictions.length === 1) return [1.0];

    const weights: number[] = [];
    let totalWeight = 0;

    for (const { predictor, prediction } of predictions) {
      // Start with base weight
      let weight = this.weightConfig.baseWeights[predictor.name] ?? 0.33;

      // Apply regime adjustment
      const regimeAdj =
        this.weightConfig.regimeAdjustments[regime]?.[predictor.name] ?? 0;
      weight += regimeAdj;

      // Apply confidence scaling
      weight *= prediction.confidence;

      // Apply error decay
      const errorPenalty = this.getErrorPenalty(
        context.symbol,
        String(context.exchange),
        predictor.name,
      );
      weight *= 1 - errorPenalty;

      // Ensure non-negative
      weight = Math.max(0.01, weight);

      weights.push(weight);
      totalWeight += weight;
    }

    // Normalize weights to sum to 1
    return weights.map((w) =>
      totalWeight > 0 ? w / totalWeight : 1 / predictions.length,
    );
  }

  /**
   * Combine predictions using weighted average
   */
  private combinePredictions(
    predictions: Array<{
      predictor: IFundingRatePredictor;
      prediction: PredictionResult;
    }>,
    weights: number[],
  ): { rate: number; confidence: number } {
    if (predictions.length === 0) {
      return { rate: 0, confidence: 0 };
    }

    let weightedRate = 0;
    let weightedConfidence = 0;

    for (let i = 0; i < predictions.length; i++) {
      const { prediction } = predictions[i];
      const weight = weights[i];

      weightedRate += prediction.predictedRate * weight;
      weightedConfidence += prediction.confidence * weight;
    }

    return {
      rate: weightedRate,
      confidence: Math.min(0.95, weightedConfidence),
    };
  }

  /**
   * Calculate aggregate prediction bounds
   */
  private calculateAggregateBounds(
    predictions: Array<{
      predictor: IFundingRatePredictor;
      prediction: PredictionResult;
    }>,
    weights: number[],
  ): { upper: number; lower: number } {
    if (predictions.length === 0) {
      return { upper: 0, lower: 0 };
    }

    let weightedUpper = 0;
    let weightedLower = 0;
    let boundsCount = 0;

    for (let i = 0; i < predictions.length; i++) {
      const { prediction } = predictions[i];
      const weight = weights[i];

      if (
        prediction.upperBound !== undefined &&
        prediction.lowerBound !== undefined
      ) {
        weightedUpper += prediction.upperBound * weight;
        weightedLower += prediction.lowerBound * weight;
        boundsCount++;
      }
    }

    if (boundsCount === 0) {
      // Fallback: use predicted rate ± small buffer
      const combinedRate = this.combinePredictions(predictions, weights).rate;
      const buffer = Math.abs(combinedRate) * 0.3 + 0.0001;
      return {
        upper: combinedRate + buffer,
        lower: combinedRate - buffer,
      };
    }

    return {
      upper: weightedUpper,
      lower: weightedLower,
    };
  }

  /**
   * Get error penalty for a predictor based on recent performance
   */
  private getErrorPenalty(
    symbol: string,
    exchange: string,
    predictorName: string,
  ): number {
    const key = `${symbol}_${exchange}_${predictorName}`;
    const errorState = this.errorStates.get(key);

    if (!errorState || errorState.predictionCount === 0) {
      return 0;
    }

    // Calculate mean absolute error
    const mae = errorState.cumulativeError / errorState.predictionCount;

    // Convert MAE to penalty (0-0.5 range)
    // Typical funding rates are 0.0001-0.001, so scale accordingly
    const normalizedError = Math.min(1, mae / 0.001);
    return normalizedError * this.weightConfig.errorDecayFactor * 5;
  }

  /**
   * Update error tracking with actual outcome
   * Call this after actual funding rate is known
   */
  updatePredictorErrors(
    symbol: string,
    exchange: string,
    actualRate: number,
    predictions: EnsemblePredictionResult,
  ): void {
    for (const pred of predictions.individualPredictions) {
      const key = `${symbol}_${exchange}_${pred.predictorName}`;
      const error = Math.abs(pred.prediction.predictedRate - actualRate);

      const existing = this.errorStates.get(key);

      if (existing) {
        // Exponential moving average of errors
        const alpha = 0.2;
        existing.cumulativeError =
          alpha * error + (1 - alpha) * existing.cumulativeError;
        existing.predictionCount++;
        existing.lastPrediction = pred.prediction.predictedRate;
        existing.lastTimestamp = new Date();
      } else {
        this.errorStates.set(key, {
          cumulativeError: error,
          predictionCount: 1,
          lastPrediction: pred.prediction.predictedRate,
          lastTimestamp: new Date(),
        });
      }
    }
  }

  /**
   * Get current weight configuration
   */
  getWeightConfig(): EnsembleWeightConfig {
    return { ...this.weightConfig };
  }

  /**
   * Get predictor names
   */
  getPredictorNames(): string[] {
    return this.predictors.map((p) => p.name);
  }

  /**
   * Clear error tracking cache
   */
  clearErrorCache(): void {
    this.errorStates.clear();
  }

  /**
   * Get expected reversion time in hours for a symbol/exchange pair
   * Delegates to the MeanReversionPredictor's cached OU parameters
   * 
   * @param symbol Normalized symbol
   * @param exchange Exchange type as string
   * @param reversionPercent Target reversion percent (default 0.5 = half-life)
   * @returns Expected hours to reversion, or null if no data available
   */
  getExpectedReversionHours(
    symbol: string,
    exchange: string,
    reversionPercent: number = 0.5,
  ): number | null {
    return this.meanReversionPredictor.getTimeToReversionHours(
      symbol,
      exchange,
      reversionPercent,
    );
  }

  /**
   * Get the long-term mean (theta) from OU parameters for a symbol/exchange
   * Used to calculate expected spread reversion targets
   * 
   * @param symbol Normalized symbol
   * @param exchange Exchange type as string
   * @returns Long-term mean rate, or null if no data available
   */
  getLongTermMean(symbol: string, exchange: string): number | null {
    const params = this.meanReversionPredictor.getCachedParameters(symbol, exchange);
    return params?.theta ?? null;
  }
}
