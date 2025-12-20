import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { ExecutionAnalyticsTracker, SlippageModelCoefficients, TWAPExecutionRecord } from './ExecutionAnalyticsTracker';
import { LiquidityProfileCalibrator, LiquidityProfile } from './LiquidityProfileCalibrator';

/**
 * Slippage prediction with confidence intervals
 */
export interface SlippagePrediction {
  expectedBps: number;
  lowerBoundBps: number;  // 10th percentile
  upperBoundBps: number;  // 90th percentile
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  modelUsed: 'CALIBRATED' | 'DEFAULT' | 'FALLBACK';
  reasoning: string;
}

/**
 * Validation result for slippage model
 */
export interface ModelValidation {
  symbol: string;
  r2: number;                    // Coefficient of determination
  mae: number;                   // Mean Absolute Error (bps)
  rmse: number;                  // Root Mean Square Error (bps)
  bias: number;                  // Prediction bias (+ = underestimate)
  sampleSize: number;
  outOfSampleMAE: number | null; // Cross-validation error
  isValid: boolean;
  validationTime: Date;
}

/**
 * Default slippage model parameters
 * Used when no historical data is available
 */
const DEFAULT_MODEL: SlippageModelCoefficients = {
  symbol: 'DEFAULT',
  alpha: 15,    // Moderate size impact
  beta: 0.5,    // Half spread added
  gamma: 2,     // Base slippage 2 bps
  r2: 0,
  sampleSize: 0,
  lastCalibrated: new Date(),
};

/**
 * SlippageModelCalibrator
 * 
 * Calibrates per-symbol slippage prediction models from historical execution data.
 * Uses regression to fit: slippage = α * sqrt(size/depth) + β * spread + γ
 * 
 * Falls back to default model when insufficient data is available.
 */
@Injectable()
export class SlippageModelCalibrator {
  private readonly logger = new Logger(SlippageModelCalibrator.name);
  
  // Configuration
  private readonly MIN_SAMPLES_FOR_CALIBRATION = 20;
  private readonly MIN_R2_FOR_VALID_MODEL = 0.3;
  private readonly CROSS_VALIDATION_FOLDS = 5;
  
  // Validated models
  private validatedModels: Map<string, ModelValidation> = new Map();

  constructor(
    private readonly executionTracker: ExecutionAnalyticsTracker,
    private readonly liquidityCalibrator: LiquidityProfileCalibrator,
  ) {}

  /**
   * Get calibrated model for a symbol, or default if unavailable
   */
  getModel(symbol: string): SlippageModelCoefficients {
    // Try to get calibrated model from execution tracker
    const calibratedModel = this.executionTracker.getSlippageModel(symbol);
    
    if (calibratedModel && calibratedModel.r2 >= this.MIN_R2_FOR_VALID_MODEL) {
      return calibratedModel;
    }
    
    // Try to calibrate from available data
    const newModel = this.calibrateModel(symbol);
    if (newModel && newModel.r2 >= this.MIN_R2_FOR_VALID_MODEL) {
      return newModel;
    }
    
    // Fall back to default
    return DEFAULT_MODEL;
  }

  /**
   * Calibrate slippage model for a symbol
   */
  calibrateModel(symbol: string): SlippageModelCoefficients | null {
    const model = this.executionTracker.calibrateSlippageModel(symbol);
    
    if (model) {
      // Validate the model
      const validation = this.validateModel(symbol, model);
      this.validatedModels.set(symbol, validation);
      
      this.logger.log(
        `Model validation for ${symbol}: R²=${validation.r2.toFixed(3)}, ` +
        `MAE=${validation.mae.toFixed(1)}bps, valid=${validation.isValid}`,
      );
    }
    
    return model;
  }

  /**
   * Predict slippage for a trade
   */
  predictSlippage(
    symbol: string,
    positionSizeUsd: number,
    exchangeLong: ExchangeType,
    exchangeShort: ExchangeType,
    hourUTC?: number,
  ): SlippagePrediction {
    const hour = hourUTC ?? new Date().getUTCHours();
    
    // Get liquidity profiles for both exchanges
    const longProfile = this.liquidityCalibrator.getProfile(symbol, exchangeLong);
    const shortProfile = this.liquidityCalibrator.getProfile(symbol, exchangeShort);
    
    // Calculate effective depth and spread
    let effectiveDepth: number;
    let effectiveSpreadBps: number;
    
    if (longProfile && shortProfile) {
      // Use minimum depth between exchanges (most constrained)
      const longDepth = this.liquidityCalibrator.getEffectiveDepthForHour(longProfile, hour);
      const shortDepth = this.liquidityCalibrator.getEffectiveDepthForHour(shortProfile, hour);
      effectiveDepth = Math.min(longDepth, shortDepth);
      
      // Use average spread
      const longSpread = this.liquidityCalibrator.getEffectiveSpreadForHour(longProfile, hour);
      const shortSpread = this.liquidityCalibrator.getEffectiveSpreadForHour(shortProfile, hour);
      effectiveSpreadBps = (longSpread + shortSpread) / 2;
    } else {
      // Fallback to defaults
      effectiveDepth = 50000; // $50k default
      effectiveSpreadBps = 10; // 10 bps default
    }
    
    // Get model
    const model = this.getModel(symbol);
    
    // Calculate prediction
    const sizeDepthRatio = Math.sqrt(positionSizeUsd / Math.max(effectiveDepth, 1000));
    const expectedBps = Math.max(0, 
      model.alpha * sizeDepthRatio + 
      model.beta * effectiveSpreadBps + 
      model.gamma
    );
    
    // Calculate confidence intervals based on model quality
    const validation = this.validatedModels.get(symbol);
    const mae = validation?.mae || expectedBps * 0.5; // Default to 50% uncertainty
    
    const lowerBoundBps = Math.max(0, expectedBps - mae);
    const upperBoundBps = expectedBps + mae * 1.5; // Asymmetric - worse case is more common
    
    // Determine confidence level
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    let modelUsed: 'CALIBRATED' | 'DEFAULT' | 'FALLBACK';
    let reasoning: string;
    
    if (model.symbol !== 'DEFAULT' && model.r2 >= 0.5 && model.sampleSize >= 50) {
      confidence = 'HIGH';
      modelUsed = 'CALIBRATED';
      reasoning = `Calibrated model with R²=${model.r2.toFixed(2)}, n=${model.sampleSize}`;
    } else if (model.symbol !== 'DEFAULT' && model.r2 >= 0.3) {
      confidence = 'MEDIUM';
      modelUsed = 'CALIBRATED';
      reasoning = `Calibrated model with limited data (R²=${model.r2.toFixed(2)}, n=${model.sampleSize})`;
    } else if (longProfile && shortProfile) {
      confidence = 'MEDIUM';
      modelUsed = 'DEFAULT';
      reasoning = 'Using default model with exchange liquidity profiles';
    } else {
      confidence = 'LOW';
      modelUsed = 'FALLBACK';
      reasoning = 'Using fallback defaults - no historical data available';
    }
    
    return {
      expectedBps,
      lowerBoundBps,
      upperBoundBps,
      confidence,
      modelUsed,
      reasoning,
    };
  }

  /**
   * Predict slippage cost in USD
   */
  predictSlippageCost(
    symbol: string,
    positionSizeUsd: number,
    exchangeLong: ExchangeType,
    exchangeShort: ExchangeType,
    hourUTC?: number,
  ): { expectedUsd: number; worstCaseUsd: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW' } {
    const prediction = this.predictSlippage(
      symbol, 
      positionSizeUsd, 
      exchangeLong, 
      exchangeShort, 
      hourUTC
    );
    
    // Slippage applies to both entry and exit
    const expectedUsd = (prediction.expectedBps / 10000) * positionSizeUsd * 2;
    const worstCaseUsd = (prediction.upperBoundBps / 10000) * positionSizeUsd * 2;
    
    return {
      expectedUsd,
      worstCaseUsd,
      confidence: prediction.confidence,
    };
  }

  /**
   * Validate a slippage model using cross-validation
   */
  private validateModel(symbol: string, model: SlippageModelCoefficients): ModelValidation {
    const records = this.executionTracker.getRecords(symbol);
    const validRecords = records.filter(r => 
      r.success && 
      r.bookDepthAtExec > 0 && 
      r.targetSizeUsd > 0 &&
      isFinite(r.actualSlippageBps)
    );
    
    if (validRecords.length < 10) {
      return {
        symbol,
        r2: model.r2,
        mae: 0,
        rmse: 0,
        bias: 0,
        sampleSize: validRecords.length,
        outOfSampleMAE: null,
        isValid: false,
        validationTime: new Date(),
      };
    }
    
    // Calculate in-sample metrics
    const predictions = validRecords.map(r => {
      const sizeDepthRatio = Math.sqrt(r.targetSizeUsd / r.bookDepthAtExec);
      return model.alpha * sizeDepthRatio + model.beta * r.spreadBpsAtExec + model.gamma;
    });
    
    const actuals = validRecords.map(r => r.actualSlippageBps);
    const errors = predictions.map((p, i) => p - actuals[i]);
    
    const mae = this.mean(errors.map(Math.abs));
    const rmse = Math.sqrt(this.mean(errors.map(e => e * e)));
    const bias = this.mean(errors); // Positive = underestimate
    
    // Cross-validation if enough samples
    let outOfSampleMAE: number | null = null;
    if (validRecords.length >= this.MIN_SAMPLES_FOR_CALIBRATION * 2) {
      outOfSampleMAE = this.crossValidate(validRecords);
    }
    
    const isValid = model.r2 >= this.MIN_R2_FOR_VALID_MODEL && 
                    mae < 20 && // Less than 20 bps MAE
                    validRecords.length >= this.MIN_SAMPLES_FOR_CALIBRATION;
    
    return {
      symbol,
      r2: model.r2,
      mae,
      rmse,
      bias,
      sampleSize: validRecords.length,
      outOfSampleMAE,
      isValid,
      validationTime: new Date(),
    };
  }

  /**
   * Perform k-fold cross-validation
   */
  private crossValidate(records: TWAPExecutionRecord[]): number {
    const shuffled = [...records].sort(() => Math.random() - 0.5);
    const foldSize = Math.floor(shuffled.length / this.CROSS_VALIDATION_FOLDS);
    const errors: number[] = [];
    
    for (let fold = 0; fold < this.CROSS_VALIDATION_FOLDS; fold++) {
      const testStart = fold * foldSize;
      const testEnd = testStart + foldSize;
      
      const trainSet = [
        ...shuffled.slice(0, testStart),
        ...shuffled.slice(testEnd),
      ];
      const testSet = shuffled.slice(testStart, testEnd);
      
      if (trainSet.length < 10 || testSet.length < 2) continue;
      
      // Fit model on training set
      const model = this.fitModel(trainSet);
      if (!model) continue;
      
      // Evaluate on test set
      for (const r of testSet) {
        const sizeDepthRatio = Math.sqrt(r.targetSizeUsd / r.bookDepthAtExec);
        const predicted = model.alpha * sizeDepthRatio + model.beta * r.spreadBpsAtExec + model.gamma;
        errors.push(Math.abs(predicted - r.actualSlippageBps));
      }
    }
    
    return errors.length > 0 ? this.mean(errors) : 0;
  }

  /**
   * Fit model on a subset of records
   */
  private fitModel(records: TWAPExecutionRecord[]): SlippageModelCoefficients | null {
    if (records.length < 10) return null;
    
    // Simple linear regression
    const n = records.length;
    const X1: number[] = [];
    const X2: number[] = [];
    const Y: number[] = [];
    
    for (const r of records) {
      X1.push(Math.sqrt(r.targetSizeUsd / r.bookDepthAtExec));
      X2.push(r.spreadBpsAtExec);
      Y.push(r.actualSlippageBps);
    }
    
    const meanX1 = this.mean(X1);
    const meanX2 = this.mean(X2);
    const meanY = this.mean(Y);
    
    let cov_x1y = 0, cov_x2y = 0, var_x1 = 0, var_x2 = 0, cov_x1x2 = 0;
    
    for (let i = 0; i < n; i++) {
      const dx1 = X1[i] - meanX1;
      const dx2 = X2[i] - meanX2;
      const dy = Y[i] - meanY;
      
      cov_x1y += dx1 * dy;
      cov_x2y += dx2 * dy;
      var_x1 += dx1 * dx1;
      var_x2 += dx2 * dx2;
      cov_x1x2 += dx1 * dx2;
    }
    
    const denom = var_x1 * var_x2 - cov_x1x2 * cov_x1x2;
    
    let alpha: number, beta: number, gamma: number;
    
    if (Math.abs(denom) < 1e-10) {
      alpha = var_x1 > 0 ? cov_x1y / var_x1 : 10;
      beta = 0.5;
      gamma = meanY - alpha * meanX1;
    } else {
      alpha = (var_x2 * cov_x1y - cov_x1x2 * cov_x2y) / denom;
      beta = (var_x1 * cov_x2y - cov_x1x2 * cov_x1y) / denom;
      gamma = meanY - alpha * meanX1 - beta * meanX2;
    }
    
    // Calculate R²
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      const predicted = alpha * X1[i] + beta * X2[i] + gamma;
      ssRes += Math.pow(Y[i] - predicted, 2);
      ssTot += Math.pow(Y[i] - meanY, 2);
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    
    return {
      symbol: 'TEMP',
      alpha: Math.max(0, Math.min(alpha, 100)),
      beta: Math.max(0, Math.min(beta, 2)),
      gamma: Math.max(-10, Math.min(gamma, 50)),
      r2: Math.max(0, Math.min(r2, 1)),
      sampleSize: n,
      lastCalibrated: new Date(),
    };
  }

  /**
   * Get validation results for all calibrated models
   */
  getAllValidations(): Map<string, ModelValidation> {
    return new Map(this.validatedModels);
  }

  /**
   * Recalibrate all models
   */
  recalibrateAll(): void {
    const symbols = this.executionTracker.getTrackedSymbols();
    let calibrated = 0;
    
    for (const symbol of symbols) {
      const model = this.calibrateModel(symbol);
      if (model) calibrated++;
    }
    
    this.logger.log(`Recalibrated ${calibrated} slippage models`);
  }

  // ==================== STATISTICAL HELPERS ====================

  private mean(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }
}






