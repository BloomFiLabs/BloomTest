import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { OrderBookCollector, OrderBookSnapshot, LiquidityMetrics } from './OrderBookCollector';

/**
 * Calibrated liquidity profile for a symbol/exchange pair
 * Contains all data needed for TWAP parameter optimization
 */
export interface LiquidityProfile {
  symbol: string;
  exchange: ExchangeType;
  
  // Average depth (USD) at different levels
  avgBidDepth5: number;
  avgBidDepth10: number;
  avgBidDepth20: number;
  avgAskDepth5: number;
  avgAskDepth10: number;
  avgAskDepth20: number;
  
  // Effective depth for TWAP (conservative estimate)
  effectiveBidDepth: number;
  effectiveAskDepth: number;
  
  // Depth variance (for confidence estimation)
  bidDepthStdDev: number;
  askDepthStdDev: number;
  
  // Spread statistics
  avgSpreadBps: number;
  medianSpreadBps: number;
  spreadStdDev: number;
  
  // Time-of-day multipliers (24 hours, UTC)
  // Values > 1 mean better liquidity than average
  hourlyDepthMultipliers: number[];
  hourlySpreadMultipliers: number[];
  
  // Day-of-week multipliers (7 days, Sunday = 0)
  dailyDepthMultipliers: number[];
  
  // Best/worst hours for execution
  bestHoursUTC: number[];   // Hours with highest liquidity
  worstHoursUTC: number[];  // Hours to avoid
  
  // Data quality metrics
  sampleCount: number;
  coverageHours: number;    // How many hours have data
  confidenceScore: number;  // 0-1, based on data quality
  
  // Freshness
  calibrationTime: Date;
  oldestDataPoint: Date;
  newestDataPoint: Date;
}

/**
 * LiquidityProfileCalibrator
 * 
 * Builds per-asset liquidity profiles from historical order book snapshots.
 * These profiles are used by TWAPOptimizer to calculate optimal execution parameters.
 */
@Injectable()
export class LiquidityProfileCalibrator {
  private readonly logger = new Logger(LiquidityProfileCalibrator.name);
  
  // Configuration
  private readonly MIN_SAMPLES_FOR_CALIBRATION = 60; // At least 1 hour of data
  private readonly PREFERRED_SAMPLE_HOURS = 168;     // 1 week of data
  private readonly DEPTH_PERCENTILE = 25;            // Use 25th percentile for effective depth (conservative)
  
  // Cache
  private profileCache: Map<string, LiquidityProfile> = new Map();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
  private cacheTimestamps: Map<string, number> = new Map();

  // Last log time to prevent noise
  private lastLogTimes: Map<string, number> = new Map();
  private readonly LOG_THROTTLE_MS = 10 * 60 * 1000; // 10 minutes

  constructor(private readonly orderBookCollector: OrderBookCollector) {}

  /**
   * Get or calculate liquidity profile for a symbol/exchange
   */
  getProfile(symbol: string, exchange: ExchangeType): LiquidityProfile | null {
    const cacheKey = `${symbol}-${exchange}`;
    
    // Check cache
    const cachedTime = this.cacheTimestamps.get(cacheKey);
    if (cachedTime && Date.now() - cachedTime < this.CACHE_TTL_MS) {
      return this.profileCache.get(cacheKey) || null;
    }
    
    // Calculate new profile
    const profile = this.calculateProfile(symbol, exchange);
    
    if (profile) {
      this.profileCache.set(cacheKey, profile);
      this.cacheTimestamps.set(cacheKey, Date.now());
    }
    
    return profile;
  }

  /**
   * Calculate liquidity profile from order book snapshots
   */
  calculateProfile(symbol: string, exchange: ExchangeType): LiquidityProfile | null {
    const snapshots = this.orderBookCollector.getSnapshots(symbol, exchange);
    
    if (snapshots.length < this.MIN_SAMPLES_FOR_CALIBRATION) {
      const key = `${symbol}-${exchange}`;
      const lastLog = this.lastLogTimes.get(key) || 0;
      if (Date.now() - lastLog > this.LOG_THROTTLE_MS) {
      this.logger.debug(
        `Insufficient data for ${symbol} on ${exchange}: ` +
          `${snapshots.length} samples (need ${this.MIN_SAMPLES_FOR_CALIBRATION})`
      );
        this.lastLogTimes.set(key, Date.now());
      }
      return null;
    }
    
    // Extract arrays for statistical analysis
    const bidDepth5s = snapshots.map(s => s.bidDepth5);
    const bidDepth10s = snapshots.map(s => s.bidDepth10);
    const bidDepth20s = snapshots.map(s => s.bidDepth20);
    const askDepth5s = snapshots.map(s => s.askDepth5);
    const askDepth10s = snapshots.map(s => s.askDepth10);
    const askDepth20s = snapshots.map(s => s.askDepth20);
    const spreadBpss = snapshots.map(s => s.spreadBps);
    
    // Calculate basic statistics
    const avgBidDepth5 = this.mean(bidDepth5s);
    const avgBidDepth10 = this.mean(bidDepth10s);
    const avgBidDepth20 = this.mean(bidDepth20s);
    const avgAskDepth5 = this.mean(askDepth5s);
    const avgAskDepth10 = this.mean(askDepth10s);
    const avgAskDepth20 = this.mean(askDepth20s);
    
    // Use percentile for effective depth (conservative)
    const effectiveBidDepth = this.percentile(bidDepth20s, this.DEPTH_PERCENTILE);
    const effectiveAskDepth = this.percentile(askDepth20s, this.DEPTH_PERCENTILE);
    
    // Calculate standard deviations
    const bidDepthStdDev = this.stdDev(bidDepth20s);
    const askDepthStdDev = this.stdDev(askDepth20s);
    
    // Spread statistics
    const avgSpreadBps = this.mean(spreadBpss);
    const medianSpreadBps = this.percentile(spreadBpss, 50);
    const spreadStdDev = this.stdDev(spreadBpss);
    
    // Calculate hourly multipliers
    const hourlyDepthMultipliers = this.calculateHourlyMultipliers(
      snapshots,
      s => s.askDepth20,
      avgAskDepth20,
    );
    
    const hourlySpreadMultipliers = this.calculateHourlyMultipliers(
      snapshots,
      s => s.spreadBps,
      avgSpreadBps,
    );
    
    // Calculate daily multipliers
    const dailyDepthMultipliers = this.calculateDailyMultipliers(
      snapshots,
      s => s.askDepth20,
      avgAskDepth20,
    );
    
    // Find best and worst hours
    const { bestHours, worstHours } = this.findBestWorstHours(hourlyDepthMultipliers);
    
    // Calculate coverage and confidence
    const coverageHours = this.calculateCoverageHours(snapshots);
    const confidenceScore = this.calculateConfidenceScore(
      snapshots.length,
      coverageHours,
      avgAskDepth20,
      askDepthStdDev,
    );
    
    const profile: LiquidityProfile = {
      symbol,
      exchange,
      avgBidDepth5,
      avgBidDepth10,
      avgBidDepth20,
      avgAskDepth5,
      avgAskDepth10,
      avgAskDepth20,
      effectiveBidDepth,
      effectiveAskDepth,
      bidDepthStdDev,
      askDepthStdDev,
      avgSpreadBps,
      medianSpreadBps,
      spreadStdDev,
      hourlyDepthMultipliers,
      hourlySpreadMultipliers,
      dailyDepthMultipliers,
      bestHoursUTC: bestHours,
      worstHoursUTC: worstHours,
      sampleCount: snapshots.length,
      coverageHours,
      confidenceScore,
      calibrationTime: new Date(),
      oldestDataPoint: new Date(Math.min(...snapshots.map(s => new Date(s.timestamp).getTime()))),
      newestDataPoint: new Date(Math.max(...snapshots.map(s => new Date(s.timestamp).getTime()))),
    };
    
    this.logger.log(
      `Calibrated liquidity profile for ${symbol} on ${exchange}: ` +
      `effective depth $${(effectiveAskDepth / 1000).toFixed(1)}k, ` +
      `spread ${avgSpreadBps.toFixed(1)}bps, ` +
      `confidence ${(confidenceScore * 100).toFixed(0)}%`,
    );
    
    return profile;
  }

  /**
   * Get effective depth for a specific hour, adjusted by time-of-day multiplier
   */
  getEffectiveDepthForHour(profile: LiquidityProfile, hourUTC: number): number {
    const multiplier = profile.hourlyDepthMultipliers[hourUTC] || 1;
    return profile.effectiveAskDepth * multiplier;
  }

  /**
   * Get effective spread for a specific hour
   */
  getEffectiveSpreadForHour(profile: LiquidityProfile, hourUTC: number): number {
    const multiplier = profile.hourlySpreadMultipliers[hourUTC] || 1;
    return profile.avgSpreadBps * multiplier;
  }

  /**
   * Check if a specific hour is a good time to execute
   */
  isGoodExecutionHour(profile: LiquidityProfile, hourUTC: number): boolean {
    return profile.bestHoursUTC.includes(hourUTC);
  }

  /**
   * Get all calibrated profiles
   */
  getAllProfiles(): Map<string, LiquidityProfile> {
    return new Map(this.profileCache);
  }

  /**
   * Force recalibration for a symbol
   */
  recalibrate(symbol: string, exchange: ExchangeType): LiquidityProfile | null {
    const cacheKey = `${symbol}-${exchange}`;
    this.profileCache.delete(cacheKey);
    this.cacheTimestamps.delete(cacheKey);
    return this.getProfile(symbol, exchange);
  }

  /**
   * Recalibrate all tracked symbols
   */
  recalibrateAll(): void {
    const symbols = this.orderBookCollector.getTrackedSymbols();
    let calibrated = 0;
    
    for (const symbol of symbols) {
      for (const exchange of [ExchangeType.HYPERLIQUID, ExchangeType.ASTER, ExchangeType.LIGHTER]) {
        const profile = this.recalibrate(symbol, exchange);
        if (profile) calibrated++;
      }
    }
    
    this.logger.log(`Recalibrated ${calibrated} liquidity profiles`);
  }

  // ==================== STATISTICAL HELPERS ====================

  private mean(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  private stdDev(arr: number[]): number {
    if (arr.length < 2) return 0;
    const avg = this.mean(arr);
    const squareDiffs = arr.map(x => Math.pow(x - avg, 2));
    return Math.sqrt(this.mean(squareDiffs));
  }

  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.floor((p / 100) * sorted.length);
    return sorted[Math.min(index, sorted.length - 1)];
  }

  private calculateHourlyMultipliers(
    snapshots: OrderBookSnapshot[],
    extractor: (s: OrderBookSnapshot) => number,
    overallAvg: number,
  ): number[] {
    const multipliers: number[] = [];
    
    for (let hour = 0; hour < 24; hour++) {
      const hourSnapshots = snapshots.filter(s => s.hourOfDay === hour);
      
      if (hourSnapshots.length > 0 && overallAvg > 0) {
        const hourAvg = this.mean(hourSnapshots.map(extractor));
        multipliers.push(hourAvg / overallAvg);
      } else {
        multipliers.push(1); // Default to 1 if no data
      }
    }
    
    return multipliers;
  }

  private calculateDailyMultipliers(
    snapshots: OrderBookSnapshot[],
    extractor: (s: OrderBookSnapshot) => number,
    overallAvg: number,
  ): number[] {
    const multipliers: number[] = [];
    
    for (let day = 0; day < 7; day++) {
      const daySnapshots = snapshots.filter(s => s.dayOfWeek === day);
      
      if (daySnapshots.length > 0 && overallAvg > 0) {
        const dayAvg = this.mean(daySnapshots.map(extractor));
        multipliers.push(dayAvg / overallAvg);
      } else {
        multipliers.push(1);
      }
    }
    
    return multipliers;
  }

  private findBestWorstHours(hourlyMultipliers: number[]): {
    bestHours: number[];
    worstHours: number[];
  } {
    // Create array of [hour, multiplier] pairs
    const hourMultPairs = hourlyMultipliers.map((mult, hour) => ({ hour, mult }));
    
    // Sort by multiplier descending
    const sorted = hourMultPairs.sort((a, b) => b.mult - a.mult);
    
    // Best hours: top 6 hours (25% of day) with multiplier > 1
    const bestHours = sorted
      .filter(p => p.mult > 1)
      .slice(0, 6)
      .map(p => p.hour);
    
    // Worst hours: bottom 6 hours with multiplier < 1
    const worstHours = sorted
      .filter(p => p.mult < 1)
      .slice(-6)
      .map(p => p.hour);
    
    return { bestHours, worstHours };
  }

  private calculateCoverageHours(snapshots: OrderBookSnapshot[]): number {
    const hoursWithData = new Set<string>();
    
    for (const s of snapshots) {
      const date = new Date(s.timestamp);
      const hourKey = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}-${date.getUTCHours()}`;
      hoursWithData.add(hourKey);
    }
    
    return hoursWithData.size;
  }

  private calculateConfidenceScore(
    sampleCount: number,
    coverageHours: number,
    avgDepth: number,
    depthStdDev: number,
  ): number {
    // Score based on sample count (0-0.4)
    const sampleScore = Math.min(sampleCount / (this.PREFERRED_SAMPLE_HOURS * 60), 1) * 0.4;
    
    // Score based on hour coverage (0-0.3)
    const coverageScore = Math.min(coverageHours / this.PREFERRED_SAMPLE_HOURS, 1) * 0.3;
    
    // Score based on depth stability (0-0.3)
    // Lower coefficient of variation = higher stability
    const cv = avgDepth > 0 ? depthStdDev / avgDepth : 1;
    const stabilityScore = Math.max(0, 1 - cv) * 0.3;
    
    return Math.min(1, sampleScore + coverageScore + stabilityScore);
  }
}






