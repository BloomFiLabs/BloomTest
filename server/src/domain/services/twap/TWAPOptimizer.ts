import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { LiquidityProfileCalibrator, LiquidityProfile } from './LiquidityProfileCalibrator';
import { ReplenishmentRateAnalyzer, ReplenishmentProfile } from './ReplenishmentRateAnalyzer';
import { SlippageModelCalibrator, SlippagePrediction } from './SlippageModelCalibrator';

/**
 * Optimal TWAP parameters calculated from historical data
 */
export interface OptimalTWAPParams {
  symbol: string;
  targetPositionUsd: number;
  
  // Core parameters
  sliceCount: number;
  sliceSizeUsd: number;
  intervalMinutes: number;
  totalDurationMinutes: number;
  
  // Expected costs
  expectedSlippageBps: number;
  expectedSlippageUsd: number;
  worstCaseSlippageBps: number;
  worstCaseSlippageUsd: number;
  
  // Timing
  recommendedStartHourUTC: number | null;
  mustCompleteByHourUTC: number | null;
  
  // Direction
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  
  // Confidence and reasoning
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasoning: string[];
  warnings: string[];
  
  // Data quality
  liquidityProfileAvailable: boolean;
  replenishmentProfileAvailable: boolean;
  slippageModelCalibrated: boolean;
}

/**
 * Constraints for TWAP optimization
 */
export interface TWAPConstraints {
  maxDurationMinutes: number;     // Maximum total execution time
  minSliceIntervalMinutes: number; // Minimum time between slices
  maxSliceIntervalMinutes: number; // Maximum time between slices
  minSliceSizeUsd: number;         // Minimum slice size
  maxSliceSizeUsd: number;         // Maximum slice size
  maxBookUsagePerSlice: number;    // Max % of book depth per slice (e.g., 0.05 = 5%)
  targetRecoveryPct: number;       // Target book recovery between slices
  fundingEpochHours: number;       // Funding epoch duration
  safetyBufferMinutes: number;     // Complete this many minutes before epoch
}

const DEFAULT_CONSTRAINTS: TWAPConstraints = {
  maxDurationMinutes: 240,        // 4 hours max
  minSliceIntervalMinutes: 5,     // At least 5 minutes between slices
  maxSliceIntervalMinutes: 30,    // No more than 30 minutes between slices
  minSliceSizeUsd: 1000,          // At least $1k per slice
  maxSliceSizeUsd: 50000,         // At most $50k per slice
  maxBookUsagePerSlice: 0.05,     // 5% of book per slice
  targetRecoveryPct: 0.50,        // Allow 50% book recovery between slices
  fundingEpochHours: 8,           // 8-hour funding epochs
  safetyBufferMinutes: 30,        // Complete 30 minutes before epoch
};

/**
 * TWAPOptimizer
 * 
 * Calculates mathematically optimal TWAP parameters using:
 * - Historical liquidity profiles (time-of-day patterns)
 * - Book replenishment rates (optimal intervals)
 * - Calibrated slippage models (expected costs)
 * 
 * Falls back to conservative defaults when data is unavailable.
 */
@Injectable()
export class TWAPOptimizer {
  private readonly logger = new Logger(TWAPOptimizer.name);

  constructor(
    private readonly liquidityCalibrator: LiquidityProfileCalibrator,
    private readonly replenishmentAnalyzer: ReplenishmentRateAnalyzer,
    private readonly slippageCalibrator: SlippageModelCalibrator,
  ) {}

  /**
   * Calculate optimal TWAP parameters for a position
   */
  calculateOptimalParams(
    symbol: string,
    targetPositionUsd: number,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    constraints: Partial<TWAPConstraints> = {},
    currentHourUTC?: number,
  ): OptimalTWAPParams {
    const c = { ...DEFAULT_CONSTRAINTS, ...constraints };
    const hour = currentHourUTC ?? new Date().getUTCHours();
    
    const reasoning: string[] = [];
    const warnings: string[] = [];
    
    // Get calibrated profiles
    const longLiquidity = this.liquidityCalibrator.getProfile(symbol, longExchange);
    const shortLiquidity = this.liquidityCalibrator.getProfile(symbol, shortExchange);
    const longReplenishment = this.replenishmentAnalyzer.getProfile(symbol, longExchange);
    const shortReplenishment = this.replenishmentAnalyzer.getProfile(symbol, shortExchange);
    
    const liquidityProfileAvailable = !!(longLiquidity && shortLiquidity);
    const replenishmentProfileAvailable = !!(longReplenishment && shortReplenishment);
    
    // Step 1: Calculate effective depth for current hour
    let effectiveDepth: number;
    
    if (liquidityProfileAvailable) {
      const longDepth = this.liquidityCalibrator.getEffectiveDepthForHour(longLiquidity!, hour);
      const shortDepth = this.liquidityCalibrator.getEffectiveDepthForHour(shortLiquidity!, hour);
      effectiveDepth = Math.min(longDepth, shortDepth);
      reasoning.push(`Using calibrated depth: $${(effectiveDepth / 1000).toFixed(1)}k (hour ${hour} UTC)`);
    } else {
      // Fallback to conservative default
      effectiveDepth = 30000; // $30k conservative default
      warnings.push('No liquidity profile available - using conservative default depth');
    }
    
    // Step 2: Calculate maximum safe slice size (max book usage)
    const maxSafeSlice = Math.min(
      effectiveDepth * c.maxBookUsagePerSlice,
      c.maxSliceSizeUsd,
    );
    
    if (maxSafeSlice < c.minSliceSizeUsd) {
      warnings.push(`Book depth too thin: max safe slice $${maxSafeSlice.toFixed(0)} < min $${c.minSliceSizeUsd}`);
    }
    
    // Step 3: Calculate optimal interval based on replenishment
    let optimalIntervalMinutes: number;
    
    if (replenishmentProfileAvailable) {
      const longInterval = this.replenishmentAnalyzer.getOptimalIntervalForHour(
        longReplenishment!, hour, c.targetRecoveryPct
      );
      const shortInterval = this.replenishmentAnalyzer.getOptimalIntervalForHour(
        shortReplenishment!, hour, c.targetRecoveryPct
      );
      // Use the longer interval (more conservative)
      optimalIntervalMinutes = Math.max(longInterval, shortInterval);
      reasoning.push(`Optimal interval: ${optimalIntervalMinutes}min (based on ${(c.targetRecoveryPct * 100).toFixed(0)}% recovery)`);
    } else {
      // Fallback: use middle of allowed range
      optimalIntervalMinutes = (c.minSliceIntervalMinutes + c.maxSliceIntervalMinutes) / 2;
      warnings.push('No replenishment profile - using default interval');
    }
    
    // Clamp interval to constraints
    optimalIntervalMinutes = Math.max(
      c.minSliceIntervalMinutes,
      Math.min(c.maxSliceIntervalMinutes, optimalIntervalMinutes),
    );
    
    // Step 4: Calculate slice count
    // Balance between:
    // - More slices = less market impact per slice
    // - Fewer slices = faster execution, less timing risk
    
    // Minimum slices needed to stay within book usage limit
    const minSlicesForDepth = Math.ceil(targetPositionUsd / maxSafeSlice);
    
    // Maximum slices that fit within time constraint
    const maxSlicesForTime = Math.floor(c.maxDurationMinutes / optimalIntervalMinutes) + 1;
    
    // Calculate actual slice count
    let sliceCount = Math.max(
      2, // At least 2 slices
      Math.min(minSlicesForDepth, maxSlicesForTime),
    );
    
    // Verify we can fit all slices
    if (minSlicesForDepth > maxSlicesForTime) {
      warnings.push(
        `Position may be too large: need ${minSlicesForDepth} slices but only ` +
        `${maxSlicesForTime} fit in ${c.maxDurationMinutes}min`,
      );
      sliceCount = maxSlicesForTime;
    }
    
    // Step 5: Calculate actual slice size and interval
    const sliceSizeUsd = targetPositionUsd / sliceCount;
    
    // Recalculate interval to spread slices evenly
    const totalDurationMinutes = Math.min(
      (sliceCount - 1) * optimalIntervalMinutes,
      c.maxDurationMinutes,
    );
    const actualIntervalMinutes = sliceCount > 1 
      ? totalDurationMinutes / (sliceCount - 1)
      : optimalIntervalMinutes;
    
    reasoning.push(`Plan: ${sliceCount} slices × $${(sliceSizeUsd / 1000).toFixed(1)}k @ ${actualIntervalMinutes.toFixed(0)}min intervals`);
    
    // Step 6: Predict slippage using calibrated model
    const slippagePrediction = this.slippageCalibrator.predictSlippage(
      symbol,
      sliceSizeUsd,
      longExchange,
      shortExchange,
      hour,
    );
    
    const slippageModelCalibrated = slippagePrediction.modelUsed === 'CALIBRATED';
    
    // Total slippage for all slices (entry + exit)
    const expectedSlippageBps = slippagePrediction.expectedBps * 2; // Entry + exit
    const worstCaseSlippageBps = slippagePrediction.upperBoundBps * 2;
    const expectedSlippageUsd = (expectedSlippageBps / 10000) * targetPositionUsd;
    const worstCaseSlippageUsd = (worstCaseSlippageBps / 10000) * targetPositionUsd;
    
    reasoning.push(
      `Expected slippage: ${expectedSlippageBps.toFixed(1)}bps ($${expectedSlippageUsd.toFixed(0)}) - ${slippagePrediction.reasoning}`,
    );
    
    // Step 7: Determine best execution timing
    let recommendedStartHourUTC: number | null = null;
    let mustCompleteByHourUTC: number | null = null;
    
    if (liquidityProfileAvailable) {
      const bestHours = longLiquidity!.bestHoursUTC.filter(h => 
        shortLiquidity!.bestHoursUTC.includes(h)
      );
      
      if (bestHours.length > 0) {
        // Find best hour that allows completion before next funding epoch
        const hoursNeeded = Math.ceil(totalDurationMinutes / 60);
        
        for (const startHour of bestHours) {
          // Check if we can complete before next 8h boundary
          const nextEpochHour = Math.ceil(startHour / c.fundingEpochHours) * c.fundingEpochHours;
          const hoursUntilEpoch = nextEpochHour - startHour;
          
          if (hoursUntilEpoch >= hoursNeeded + (c.safetyBufferMinutes / 60)) {
            recommendedStartHourUTC = startHour;
            mustCompleteByHourUTC = nextEpochHour;
            reasoning.push(`Best start time: ${startHour}:00 UTC (complete by ${nextEpochHour}:00)`);
            break;
          }
        }
      }
    }
    
    // Step 8: Determine overall confidence
    let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    
    if (
      liquidityProfileAvailable && 
      replenishmentProfileAvailable && 
      slippageModelCalibrated &&
      warnings.length === 0
    ) {
      confidence = 'HIGH';
    } else if (
      (liquidityProfileAvailable || replenishmentProfileAvailable) &&
      warnings.length <= 1
    ) {
      confidence = 'MEDIUM';
    } else {
      confidence = 'LOW';
    }
    
    return {
      symbol,
      targetPositionUsd,
      sliceCount,
      sliceSizeUsd,
      intervalMinutes: actualIntervalMinutes,
      totalDurationMinutes,
      expectedSlippageBps,
      expectedSlippageUsd,
      worstCaseSlippageBps,
      worstCaseSlippageUsd,
      recommendedStartHourUTC,
      mustCompleteByHourUTC,
      longExchange,
      shortExchange,
      confidence,
      reasoning,
      warnings,
      liquidityProfileAvailable,
      replenishmentProfileAvailable,
      slippageModelCalibrated,
    };
  }

  /**
   * Calculate optimal params for multiple position sizes
   * Useful for deciding how much to deploy
   */
  analyzePositionSizes(
    symbol: string,
    positionSizes: number[],
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): Array<{ positionUsd: number; params: OptimalTWAPParams; netAPYImpact: number }> {
    const results: Array<{ positionUsd: number; params: OptimalTWAPParams; netAPYImpact: number }> = [];
    
    for (const positionUsd of positionSizes) {
      const params = this.calculateOptimalParams(symbol, positionUsd, longExchange, shortExchange);
      
      // Estimate APY impact from slippage
      // Slippage cost annualized over expected hold period
      const assumedHoldDays = 7;
      const annualizedSlippageCost = (params.expectedSlippageUsd / assumedHoldDays) * 365;
      const netAPYImpact = -(annualizedSlippageCost / positionUsd) * 100;
      
      results.push({ positionUsd, params, netAPYImpact });
    }
    
    return results;
  }

  /**
   * Find optimal position size that balances return and slippage cost
   */
  findOptimalPositionSize(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    grossAPY: number,           // Expected gross APY before costs
    maxPositionUsd: number,     // Maximum capital available
    targetNetAPY: number = 0.15, // Target net APY after slippage
  ): { optimalPositionUsd: number; params: OptimalTWAPParams; expectedNetAPY: number } | null {
    // Binary search for optimal position size
    let low = 1000;
    let high = maxPositionUsd;
    let bestResult: { optimalPositionUsd: number; params: OptimalTWAPParams; expectedNetAPY: number } | null = null;
    
    while (high - low > 1000) {
      const mid = (low + high) / 2;
      const params = this.calculateOptimalParams(symbol, mid, longExchange, shortExchange);
      
      // Calculate net APY
      const assumedHoldDays = 7;
      const annualizedSlippageCost = (params.expectedSlippageUsd / assumedHoldDays) * 365;
      const netAPY = grossAPY - (annualizedSlippageCost / mid);
      
      if (netAPY >= targetNetAPY) {
        // Can do larger position
        bestResult = { optimalPositionUsd: mid, params, expectedNetAPY: netAPY };
        low = mid;
      } else {
        // Need smaller position
        high = mid;
      }
    }
    
    // Return best result found, or calculate for minimum size
    if (!bestResult) {
      const params = this.calculateOptimalParams(symbol, low, longExchange, shortExchange);
      const assumedHoldDays = 7;
      const annualizedSlippageCost = (params.expectedSlippageUsd / assumedHoldDays) * 365;
      const netAPY = grossAPY - (annualizedSlippageCost / low);
      bestResult = { optimalPositionUsd: low, params, expectedNetAPY: netAPY };
    }
    
    return bestResult;
  }

  /**
   * Get a summary of data availability for optimization
   */
  getDataAvailabilitySummary(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): {
    hasLiquidityProfile: boolean;
    hasReplenishmentProfile: boolean;
    hasSlippageModel: boolean;
    liquidityConfidence: number;
    replenishmentConfidence: number;
    slippageModelR2: number;
    recommendedAction: string;
  } {
    const longLiquidity = this.liquidityCalibrator.getProfile(symbol, longExchange);
    const shortLiquidity = this.liquidityCalibrator.getProfile(symbol, shortExchange);
    const longReplenishment = this.replenishmentAnalyzer.getProfile(symbol, longExchange);
    const shortReplenishment = this.replenishmentAnalyzer.getProfile(symbol, shortExchange);
    const slippageModel = this.slippageCalibrator.getModel(symbol);
    
    const hasLiquidityProfile = !!(longLiquidity && shortLiquidity);
    const hasReplenishmentProfile = !!(longReplenishment && shortReplenishment);
    const hasSlippageModel = slippageModel.symbol !== 'DEFAULT';
    
    const liquidityConfidence = hasLiquidityProfile 
      ? Math.min(longLiquidity!.confidenceScore, shortLiquidity!.confidenceScore)
      : 0;
    
    const replenishmentConfidence = hasReplenishmentProfile
      ? Math.min(longReplenishment!.confidenceScore, shortReplenishment!.confidenceScore)
      : 0;
    
    const slippageModelR2 = slippageModel.r2;
    
    let recommendedAction: string;
    if (hasLiquidityProfile && hasReplenishmentProfile && hasSlippageModel) {
      recommendedAction = 'Ready for optimal TWAP execution';
    } else if (hasLiquidityProfile || hasReplenishmentProfile) {
      recommendedAction = 'Partial data available - consider waiting for more data or use conservative defaults';
    } else {
      recommendedAction = 'No historical data - start data collection before executing large positions';
    }
    
    return {
      hasLiquidityProfile,
      hasReplenishmentProfile,
      hasSlippageModel,
      liquidityConfidence,
      replenishmentConfidence,
      slippageModelR2,
      recommendedAction,
    };
  }
}



