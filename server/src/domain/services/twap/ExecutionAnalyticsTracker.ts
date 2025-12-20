import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';

/**
 * Record of a single TWAP slice execution
 */
export interface TWAPExecutionRecord {
  id: string;
  twapId: string;
  symbol: string;
  sliceNumber: number;
  totalSlices: number;
  
  // Timing
  timestamp: Date;
  hourOfDay: number;
  dayOfWeek: number;
  
  // Exchanges
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  
  // Target vs Actual
  targetSizeUsd: number;
  actualFilledLong: number;
  actualFilledShort: number;
  fillRatio: number; // min(long, short) / max(long, short)
  
  // Prices
  expectedPriceLong: number;
  actualPriceLong: number;
  expectedPriceShort: number;
  actualPriceShort: number;
  
  // Slippage
  expectedSlippageBps: number;
  actualSlippageBps: number;
  slippagePredictionError: number; // actual - expected
  
  // Market conditions at execution
  bookDepthAtExec: number;
  spreadBpsAtExec: number;
  
  // Execution quality
  executionLatencyMs: number;
  success: boolean;
  partialFill: boolean;
  singleLegOccurred: boolean;
  errorReason?: string;
}

/**
 * Summary of execution quality for a symbol
 */
export interface ExecutionQualitySummary {
  symbol: string;
  
  // Sample size
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  
  // Fill rates
  avgFillRatio: number;
  singleLegRate: number; // % of executions with single-leg issues
  
  // Slippage accuracy
  avgExpectedSlippageBps: number;
  avgActualSlippageBps: number;
  slippagePredictionBias: number; // positive = underestimate, negative = overestimate
  slippagePredictionMAE: number; // Mean Absolute Error
  
  // Timing
  avgExecutionLatencyMs: number;
  p95ExecutionLatencyMs: number;
  
  // Time-of-day analysis
  hourlySlippageBps: number[]; // 24 elements
  hourlySuccessRate: number[]; // 24 elements
  
  // Confidence
  dataQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  lastUpdated: Date;
}

/**
 * Slippage model coefficients for a symbol
 * Model: slippage = α * sqrt(size/depth) + β * spreadBps + γ
 */
export interface SlippageModelCoefficients {
  symbol: string;
  alpha: number;  // Size impact coefficient
  beta: number;   // Spread coefficient
  gamma: number;  // Base slippage (intercept)
  r2: number;     // Model fit quality (0-1)
  sampleSize: number;
  lastCalibrated: Date;
}

/**
 * ExecutionAnalyticsTracker - Tracks and analyzes TWAP execution quality
 * 
 * Records every slice execution to:
 * 1. Calculate actual vs predicted slippage
 * 2. Identify time-of-day patterns
 * 3. Calibrate slippage prediction models
 * 4. Track single-leg occurrence rates
 */
@Injectable()
export class ExecutionAnalyticsTracker {
  private readonly logger = new Logger(ExecutionAnalyticsTracker.name);
  
  // In-memory storage
  private executionRecords: Map<string, TWAPExecutionRecord[]> = new Map(); // key: symbol
  private qualitySummaryCache: Map<string, ExecutionQualitySummary> = new Map();
  private slippageModels: Map<string, SlippageModelCoefficients> = new Map();
  
  // Configuration
  private readonly RETENTION_DAYS = 30;
  private readonly RETENTION_MS = this.RETENTION_DAYS * 24 * 60 * 60 * 1000;
  private readonly MAX_RECORDS_PER_SYMBOL = 10000;
  private readonly MIN_SAMPLES_FOR_MODEL = 20;
  private readonly SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  
  private summaryCacheLastUpdate: Map<string, Date> = new Map();

  /**
   * Record a TWAP slice execution
   */
  recordExecution(record: TWAPExecutionRecord): void {
    const key = record.symbol;
    
    if (!this.executionRecords.has(key)) {
      this.executionRecords.set(key, []);
    }
    
    const records = this.executionRecords.get(key)!;
    records.push(record);
    
    // Enforce retention limits
    if (records.length > this.MAX_RECORDS_PER_SYMBOL) {
      records.shift();
    }
    
    this.logger.debug(
      `Recorded execution: ${record.symbol} slice ${record.sliceNumber}/${record.totalSlices} ` +
      `actual slippage: ${record.actualSlippageBps.toFixed(1)}bps ` +
      `(expected: ${record.expectedSlippageBps.toFixed(1)}bps)`,
    );
    
    // Invalidate caches
    this.summaryCacheLastUpdate.delete(key);
  }

  /**
   * Create an execution record from raw execution data
   */
  createRecord(params: {
    twapId: string;
    symbol: string;
    sliceNumber: number;
    totalSlices: number;
    longExchange: ExchangeType;
    shortExchange: ExchangeType;
    targetSizeUsd: number;
    actualFilledLong: number;
    actualFilledShort: number;
    expectedPriceLong: number;
    actualPriceLong: number;
    expectedPriceShort: number;
    actualPriceShort: number;
    expectedSlippageBps: number;
    bookDepthAtExec: number;
    spreadBpsAtExec: number;
    executionLatencyMs: number;
    success: boolean;
    errorReason?: string;
  }): TWAPExecutionRecord {
    const timestamp = new Date();
    
    // Calculate actual slippage
    const expectedMid = (params.expectedPriceLong + params.expectedPriceShort) / 2;
    const actualMid = (params.actualPriceLong + params.actualPriceShort) / 2;
    const actualSlippageBps = expectedMid > 0 
      ? Math.abs((actualMid - expectedMid) / expectedMid) * 10000 
      : 0;
    
    // Calculate fill ratio
    const maxFill = Math.max(params.actualFilledLong, params.actualFilledShort);
    const minFill = Math.min(params.actualFilledLong, params.actualFilledShort);
    const fillRatio = maxFill > 0 ? minFill / maxFill : 0;
    
    // Detect single-leg
    const singleLegOccurred = fillRatio < 0.9 && (params.actualFilledLong > 0 || params.actualFilledShort > 0);
    const partialFill = fillRatio < 1 && fillRatio >= 0.9;
    
    const record: TWAPExecutionRecord = {
      id: `exec-${params.twapId}-${params.sliceNumber}-${timestamp.getTime()}`,
      twapId: params.twapId,
      symbol: params.symbol,
      sliceNumber: params.sliceNumber,
      totalSlices: params.totalSlices,
      timestamp,
      hourOfDay: timestamp.getUTCHours(),
      dayOfWeek: timestamp.getUTCDay(),
      longExchange: params.longExchange,
      shortExchange: params.shortExchange,
      targetSizeUsd: params.targetSizeUsd,
      actualFilledLong: params.actualFilledLong,
      actualFilledShort: params.actualFilledShort,
      fillRatio,
      expectedPriceLong: params.expectedPriceLong,
      actualPriceLong: params.actualPriceLong,
      expectedPriceShort: params.expectedPriceShort,
      actualPriceShort: params.actualPriceShort,
      expectedSlippageBps: params.expectedSlippageBps,
      actualSlippageBps,
      slippagePredictionError: actualSlippageBps - params.expectedSlippageBps,
      bookDepthAtExec: params.bookDepthAtExec,
      spreadBpsAtExec: params.spreadBpsAtExec,
      executionLatencyMs: params.executionLatencyMs,
      success: params.success,
      partialFill,
      singleLegOccurred,
      errorReason: params.errorReason,
    };
    
    return record;
  }

  /**
   * Get execution quality summary for a symbol
   */
  getQualitySummary(symbol: string): ExecutionQualitySummary | null {
    // Check cache
    const cacheTime = this.summaryCacheLastUpdate.get(symbol);
    if (cacheTime && Date.now() - cacheTime.getTime() < this.SUMMARY_CACHE_TTL_MS) {
      const cached = this.qualitySummaryCache.get(symbol);
      if (cached) return cached;
    }
    
    const records = this.executionRecords.get(symbol);
    if (!records || records.length === 0) {
      return null;
    }
    
    // Calculate summary statistics
    const successfulRecords = records.filter(r => r.success);
    const failedRecords = records.filter(r => !r.success);
    
    // Averages
    const avg = (arr: number[]): number => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    
    const fillRatios = records.map(r => r.fillRatio);
    const expectedSlippages = records.map(r => r.expectedSlippageBps);
    const actualSlippages = records.map(r => r.actualSlippageBps);
    const predictionErrors = records.map(r => r.slippagePredictionError);
    const latencies = records.map(r => r.executionLatencyMs);
    
    // Time-of-day analysis
    const hourlySlippageBps: number[] = [];
    const hourlySuccessRate: number[] = [];
    
    for (let hour = 0; hour < 24; hour++) {
      const hourRecords = records.filter(r => r.hourOfDay === hour);
      if (hourRecords.length > 0) {
        hourlySlippageBps.push(avg(hourRecords.map(r => r.actualSlippageBps)));
        hourlySuccessRate.push(hourRecords.filter(r => r.success).length / hourRecords.length);
      } else {
        hourlySlippageBps.push(avg(actualSlippages)); // Use overall average as fallback
        hourlySuccessRate.push(records.length > 0 ? successfulRecords.length / records.length : 0);
      }
    }
    
    // Calculate P95 latency
    const sortedLatencies = [...latencies].sort((a, b) => a - b);
    const p95Index = Math.floor(sortedLatencies.length * 0.95);
    const p95Latency = sortedLatencies[p95Index] || avg(latencies);
    
    // Data quality assessment
    let dataQuality: 'HIGH' | 'MEDIUM' | 'LOW';
    if (records.length >= 100) {
      dataQuality = 'HIGH';
    } else if (records.length >= 20) {
      dataQuality = 'MEDIUM';
    } else {
      dataQuality = 'LOW';
    }
    
    const summary: ExecutionQualitySummary = {
      symbol,
      totalExecutions: records.length,
      successfulExecutions: successfulRecords.length,
      failedExecutions: failedRecords.length,
      avgFillRatio: avg(fillRatios),
      singleLegRate: records.filter(r => r.singleLegOccurred).length / records.length,
      avgExpectedSlippageBps: avg(expectedSlippages),
      avgActualSlippageBps: avg(actualSlippages),
      slippagePredictionBias: avg(predictionErrors),
      slippagePredictionMAE: avg(predictionErrors.map(Math.abs)),
      avgExecutionLatencyMs: avg(latencies),
      p95ExecutionLatencyMs: p95Latency,
      hourlySlippageBps,
      hourlySuccessRate,
      dataQuality,
      lastUpdated: new Date(),
    };
    
    // Cache the result
    this.qualitySummaryCache.set(symbol, summary);
    this.summaryCacheLastUpdate.set(symbol, new Date());
    
    return summary;
  }

  /**
   * Calibrate slippage model for a symbol
   * Uses least squares regression to fit: slippage = α * sqrt(size/depth) + β * spread + γ
   */
  calibrateSlippageModel(symbol: string): SlippageModelCoefficients | null {
    const records = this.executionRecords.get(symbol);
    
    if (!records || records.length < this.MIN_SAMPLES_FOR_MODEL) {
      this.logger.debug(
        `Not enough data to calibrate slippage model for ${symbol}: ` +
        `${records?.length || 0} records (need ${this.MIN_SAMPLES_FOR_MODEL})`,
      );
      return null;
    }
    
    // Filter valid records
    const validRecords = records.filter(r => 
      r.success && 
      r.bookDepthAtExec > 0 && 
      r.targetSizeUsd > 0 &&
      isFinite(r.actualSlippageBps)
    );
    
    if (validRecords.length < this.MIN_SAMPLES_FOR_MODEL) {
      return null;
    }
    
    // Prepare data for regression
    // X1 = sqrt(size / depth), X2 = spreadBps, Y = actualSlippageBps
    const n = validRecords.length;
    const X1: number[] = [];
    const X2: number[] = [];
    const Y: number[] = [];
    
    for (const r of validRecords) {
      X1.push(Math.sqrt(r.targetSizeUsd / r.bookDepthAtExec));
      X2.push(r.spreadBpsAtExec);
      Y.push(r.actualSlippageBps);
    }
    
    // Simple multivariate linear regression using normal equations
    // β = (X'X)^-1 X'Y
    // For simplicity, we'll use a simplified approach
    
    // Calculate means
    const meanX1 = X1.reduce((a, b) => a + b, 0) / n;
    const meanX2 = X2.reduce((a, b) => a + b, 0) / n;
    const meanY = Y.reduce((a, b) => a + b, 0) / n;
    
    // Calculate covariances
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
    
    // Solve for coefficients (using simplified two-variable regression)
    const denom = var_x1 * var_x2 - cov_x1x2 * cov_x1x2;
    
    let alpha: number, beta: number, gamma: number;
    
    if (Math.abs(denom) < 1e-10) {
      // Fall back to simple linear regression on X1 only
      alpha = var_x1 > 0 ? cov_x1y / var_x1 : 10;
      beta = 0.5; // Default spread coefficient
      gamma = meanY - alpha * meanX1;
    } else {
      alpha = (var_x2 * cov_x1y - cov_x1x2 * cov_x2y) / denom;
      beta = (var_x1 * cov_x2y - cov_x1x2 * cov_x1y) / denom;
      gamma = meanY - alpha * meanX1 - beta * meanX2;
    }
    
    // Ensure reasonable bounds
    alpha = Math.max(0, Math.min(alpha, 100)); // 0-100 bps per sqrt(size/depth)
    beta = Math.max(0, Math.min(beta, 2));     // 0-2x spread
    gamma = Math.max(-10, Math.min(gamma, 50)); // -10 to 50 bps base
    
    // Calculate R² (coefficient of determination)
    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      const predicted = alpha * X1[i] + beta * X2[i] + gamma;
      ssRes += Math.pow(Y[i] - predicted, 2);
      ssTot += Math.pow(Y[i] - meanY, 2);
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    
    const coefficients: SlippageModelCoefficients = {
      symbol,
      alpha,
      beta,
      gamma,
      r2: Math.max(0, Math.min(r2, 1)),
      sampleSize: validRecords.length,
      lastCalibrated: new Date(),
    };
    
    // Store the model
    this.slippageModels.set(symbol, coefficients);
    
    this.logger.log(
      `Calibrated slippage model for ${symbol}: ` +
      `slippage = ${alpha.toFixed(2)} * sqrt(size/depth) + ${beta.toFixed(2)} * spread + ${gamma.toFixed(2)} ` +
      `(R² = ${r2.toFixed(3)}, n = ${validRecords.length})`,
    );
    
    return coefficients;
  }

  /**
   * Get calibrated slippage model for a symbol
   */
  getSlippageModel(symbol: string): SlippageModelCoefficients | null {
    return this.slippageModels.get(symbol) || null;
  }

  /**
   * Predict slippage using calibrated model
   */
  predictSlippage(
    symbol: string,
    positionSizeUsd: number,
    bookDepthUsd: number,
    spreadBps: number,
  ): { slippageBps: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW' } {
    const model = this.slippageModels.get(symbol);
    
    if (model && model.r2 > 0.5 && model.sampleSize >= this.MIN_SAMPLES_FOR_MODEL) {
      // Use calibrated model
      const sizeDepthRatio = Math.sqrt(positionSizeUsd / Math.max(bookDepthUsd, 1000));
      const predicted = model.alpha * sizeDepthRatio + model.beta * spreadBps + model.gamma;
      
      const confidence = model.r2 > 0.7 ? 'HIGH' : model.r2 > 0.5 ? 'MEDIUM' : 'LOW';
      
      return {
        slippageBps: Math.max(0, predicted),
        confidence,
      };
    }
    
    // Fallback to default model
    const sizeDepthRatio = Math.sqrt(positionSizeUsd / Math.max(bookDepthUsd, 1000));
    const defaultPrediction = 10 * sizeDepthRatio + 0.5 * spreadBps + 2;
    
    return {
      slippageBps: Math.max(0, defaultPrediction),
      confidence: 'LOW',
    };
  }

  /**
   * Get execution records for a symbol
   */
  getRecords(symbol: string): TWAPExecutionRecord[] {
    return this.executionRecords.get(symbol) || [];
  }

  /**
   * Get records for a specific time range
   */
  getRecordsInRange(
    symbol: string,
    startTime: Date,
    endTime: Date,
  ): TWAPExecutionRecord[] {
    const records = this.getRecords(symbol);
    return records.filter(r => 
      r.timestamp >= startTime && r.timestamp <= endTime
    );
  }

  /**
   * Prune old records
   */
  pruneOldRecords(): void {
    const cutoff = Date.now() - this.RETENTION_MS;
    
    for (const [symbol, records] of this.executionRecords) {
      const filtered = records.filter(r => r.timestamp.getTime() > cutoff);
      this.executionRecords.set(symbol, filtered);
    }
    
    this.logger.debug('Pruned old execution records');
  }

  /**
   * Get all tracked symbols
   */
  getTrackedSymbols(): string[] {
    return Array.from(this.executionRecords.keys());
  }

  /**
   * Get overall statistics
   */
  getOverallStats(): {
    totalRecords: number;
    symbolsTracked: number;
    avgSlippageBps: number;
    avgFillRatio: number;
    singleLegRate: number;
    modelsCalibrated: number;
  } {
    let totalRecords = 0;
    let totalSlippage = 0;
    let totalFillRatio = 0;
    let singleLegCount = 0;
    
    for (const records of this.executionRecords.values()) {
      for (const r of records) {
        totalRecords++;
        totalSlippage += r.actualSlippageBps;
        totalFillRatio += r.fillRatio;
        if (r.singleLegOccurred) singleLegCount++;
      }
    }
    
    return {
      totalRecords,
      symbolsTracked: this.executionRecords.size,
      avgSlippageBps: totalRecords > 0 ? totalSlippage / totalRecords : 0,
      avgFillRatio: totalRecords > 0 ? totalFillRatio / totalRecords : 0,
      singleLegRate: totalRecords > 0 ? singleLegCount / totalRecords : 0,
      modelsCalibrated: this.slippageModels.size,
    };
  }

  /**
   * Export all records (for persistence)
   */
  exportRecords(): Map<string, TWAPExecutionRecord[]> {
    return new Map(this.executionRecords);
  }

  /**
   * Import records (from persistence)
   */
  importRecords(data: Map<string, TWAPExecutionRecord[]>): void {
    this.executionRecords = new Map(data);
    this.logger.log(`Imported execution records for ${data.size} symbols`);
    
    // Recalibrate models for all symbols with enough data
    for (const symbol of data.keys()) {
      this.calibrateSlippageModel(symbol);
    }
  }

  /**
   * Export slippage models (for persistence)
   */
  exportModels(): Map<string, SlippageModelCoefficients> {
    return new Map(this.slippageModels);
  }

  /**
   * Import slippage models (from persistence)
   */
  importModels(data: Map<string, SlippageModelCoefficients>): void {
    this.slippageModels = new Map(data);
    this.logger.log(`Imported ${data.size} slippage models`);
  }
}






