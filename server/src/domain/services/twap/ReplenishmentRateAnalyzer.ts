import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { OrderBookCollector, OrderBookSnapshot } from './OrderBookCollector';

/**
 * Replenishment profile for a symbol/exchange
 * Describes how quickly the order book refills after being depleted
 */
export interface ReplenishmentProfile {
  symbol: string;
  exchange: ExchangeType;
  
  // Turnover metrics (USD per minute)
  avgTurnoverPerMin: number;
  medianTurnoverPerMin: number;
  p90TurnoverPerMin: number;
  
  // Recovery time estimates (minutes)
  recoveryTime10Pct: number;   // Time to recover after 10% depletion
  recoveryTime25Pct: number;   // Time to recover after 25% depletion
  recoveryTime50Pct: number;   // Time to recover after 50% depletion
  
  // Optimal TWAP intervals based on recovery
  recommendedMinIntervalMin: number;  // Minimum interval between slices
  recommendedMaxIntervalMin: number;  // Maximum useful interval
  
  // Hourly turnover multipliers (24 hours UTC)
  hourlyTurnoverMultipliers: number[];
  
  // Confidence metrics
  sampleCount: number;
  confidenceScore: number;  // 0-1
  
  // Freshness
  calibrationTime: Date;
}

/**
 * Turnover observation from consecutive snapshots
 */
interface TurnoverObservation {
  timestamp: Date;
  hourOfDay: number;
  depthChange: number;      // Absolute change in depth
  depthChangePct: number;   // Percentage change
  intervalMs: number;       // Time between observations
  turnoverPerMin: number;   // Estimated turnover per minute
}

/**
 * ReplenishmentRateAnalyzer
 * 
 * Analyzes how fast order books refill between snapshots.
 * Used to determine optimal TWAP intervals - we want to wait long enough
 * for the book to recover between slices to minimize market impact.
 */
@Injectable()
export class ReplenishmentRateAnalyzer {
  private readonly logger = new Logger(ReplenishmentRateAnalyzer.name);
  
  // Configuration
  private readonly MIN_OBSERVATIONS = 60;  // At least 1 hour of data
  private readonly MAX_SNAPSHOT_GAP_MS = 5 * 60 * 1000; // Ignore gaps > 5 minutes
  private readonly MIN_DEPTH_CHANGE_PCT = 0.01; // Ignore tiny changes (< 1%)
  
  // Cache
  private profileCache: Map<string, ReplenishmentProfile> = new Map();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
  private cacheTimestamps: Map<string, number> = new Map();

  constructor(private readonly orderBookCollector: OrderBookCollector) {}

  /**
   * Get or calculate replenishment profile for a symbol/exchange
   */
  getProfile(symbol: string, exchange: ExchangeType): ReplenishmentProfile | null {
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
   * Calculate replenishment profile from order book snapshots
   */
  calculateProfile(symbol: string, exchange: ExchangeType): ReplenishmentProfile | null {
    const snapshots = this.orderBookCollector.getSnapshots(symbol, exchange);
    
    if (snapshots.length < this.MIN_OBSERVATIONS) {
      this.logger.debug(
        `Insufficient data for ${symbol} on ${exchange}: ` +
        `${snapshots.length} snapshots (need ${this.MIN_OBSERVATIONS})`,
      );
      return null;
    }
    
    // Sort snapshots by timestamp
    const sortedSnapshots = [...snapshots].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    
    // Calculate turnover observations
    const observations = this.calculateTurnoverObservations(sortedSnapshots);
    
    if (observations.length < this.MIN_OBSERVATIONS / 2) {
      this.logger.debug(
        `Insufficient turnover observations for ${symbol} on ${exchange}: ${observations.length}`,
      );
      return null;
    }
    
    // Calculate turnover statistics
    const turnovers = observations.map(o => o.turnoverPerMin);
    const avgTurnoverPerMin = this.mean(turnovers);
    const medianTurnoverPerMin = this.percentile(turnovers, 50);
    const p90TurnoverPerMin = this.percentile(turnovers, 90);
    
    // Calculate average depth from snapshots
    const depths = sortedSnapshots.map(s => s.askDepth20 + s.bidDepth20);
    const avgDepth = this.mean(depths);
    
    // Estimate recovery times
    // Recovery time = (depth * depletion%) / turnover rate
    const recoveryTime10Pct = avgDepth > 0 && avgTurnoverPerMin > 0
      ? (avgDepth * 0.10) / avgTurnoverPerMin
      : 5; // Default 5 minutes
      
    const recoveryTime25Pct = avgDepth > 0 && avgTurnoverPerMin > 0
      ? (avgDepth * 0.25) / avgTurnoverPerMin
      : 10;
      
    const recoveryTime50Pct = avgDepth > 0 && avgTurnoverPerMin > 0
      ? (avgDepth * 0.50) / avgTurnoverPerMin
      : 20;
    
    // Calculate recommended intervals
    // We want to wait for ~50% recovery between slices
    const recommendedMinIntervalMin = Math.max(5, Math.ceil(recoveryTime25Pct));
    const recommendedMaxIntervalMin = Math.min(30, Math.ceil(recoveryTime50Pct * 1.5));
    
    // Calculate hourly turnover multipliers
    const hourlyTurnoverMultipliers = this.calculateHourlyMultipliers(observations, avgTurnoverPerMin);
    
    // Calculate confidence score
    const confidenceScore = this.calculateConfidenceScore(
      observations.length,
      avgTurnoverPerMin,
      this.stdDev(turnovers),
    );
    
    const profile: ReplenishmentProfile = {
      symbol,
      exchange,
      avgTurnoverPerMin,
      medianTurnoverPerMin,
      p90TurnoverPerMin,
      recoveryTime10Pct,
      recoveryTime25Pct,
      recoveryTime50Pct,
      recommendedMinIntervalMin,
      recommendedMaxIntervalMin,
      hourlyTurnoverMultipliers,
      sampleCount: observations.length,
      confidenceScore,
      calibrationTime: new Date(),
    };
    
    this.logger.log(
      `Calibrated replenishment profile for ${symbol} on ${exchange}: ` +
      `turnover $${(avgTurnoverPerMin / 1000).toFixed(1)}k/min, ` +
      `recovery ${recoveryTime25Pct.toFixed(1)}min (25%), ` +
      `recommended interval ${recommendedMinIntervalMin}-${recommendedMaxIntervalMin}min, ` +
      `confidence ${(confidenceScore * 100).toFixed(0)}%`,
    );
    
    return profile;
  }

  /**
   * Calculate turnover observations from consecutive snapshots
   */
  private calculateTurnoverObservations(snapshots: OrderBookSnapshot[]): TurnoverObservation[] {
    const observations: TurnoverObservation[] = [];
    
    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1];
      const curr = snapshots[i];
      
      const prevTime = new Date(prev.timestamp).getTime();
      const currTime = new Date(curr.timestamp).getTime();
      const intervalMs = currTime - prevTime;
      
      // Skip if gap is too large (data gap, not representative)
      if (intervalMs > this.MAX_SNAPSHOT_GAP_MS || intervalMs <= 0) {
        continue;
      }
      
      // Calculate total depth change
      const prevDepth = prev.askDepth20 + prev.bidDepth20;
      const currDepth = curr.askDepth20 + curr.bidDepth20;
      const depthChange = Math.abs(currDepth - prevDepth);
      const depthChangePct = prevDepth > 0 ? depthChange / prevDepth : 0;
      
      // Skip tiny changes (noise)
      if (depthChangePct < this.MIN_DEPTH_CHANGE_PCT) {
        continue;
      }
      
      // Calculate turnover per minute
      const intervalMin = intervalMs / (60 * 1000);
      const turnoverPerMin = depthChange / intervalMin;
      
      observations.push({
        timestamp: new Date(currTime),
        hourOfDay: curr.hourOfDay,
        depthChange,
        depthChangePct,
        intervalMs,
        turnoverPerMin,
      });
    }
    
    return observations;
  }

  /**
   * Calculate hourly turnover multipliers
   */
  private calculateHourlyMultipliers(
    observations: TurnoverObservation[],
    avgTurnover: number,
  ): number[] {
    const multipliers: number[] = [];
    
    for (let hour = 0; hour < 24; hour++) {
      const hourObs = observations.filter(o => o.hourOfDay === hour);
      
      if (hourObs.length > 0 && avgTurnover > 0) {
        const hourAvg = this.mean(hourObs.map(o => o.turnoverPerMin));
        multipliers.push(hourAvg / avgTurnover);
      } else {
        multipliers.push(1);
      }
    }
    
    return multipliers;
  }

  /**
   * Get optimal interval for a specific hour
   */
  getOptimalIntervalForHour(
    profile: ReplenishmentProfile,
    hourUTC: number,
    targetRecoveryPct: number = 0.25,
  ): number {
    const multiplier = profile.hourlyTurnoverMultipliers[hourUTC] || 1;
    const adjustedTurnover = profile.avgTurnoverPerMin * multiplier;
    
    if (adjustedTurnover <= 0) {
      return profile.recommendedMinIntervalMin;
    }
    
    // Estimate depth from turnover (rough)
    // We'll use recovery time as baseline
    const baseRecoveryTime = profile.recoveryTime25Pct;
    const adjustedRecoveryTime = baseRecoveryTime / multiplier;
    
    return Math.max(
      profile.recommendedMinIntervalMin,
      Math.min(
        profile.recommendedMaxIntervalMin,
        Math.ceil(adjustedRecoveryTime * (targetRecoveryPct / 0.25)),
      ),
    );
  }

  /**
   * Estimate how long it will take to safely deploy a position
   */
  estimateDeploymentTime(
    profile: ReplenishmentProfile,
    positionSizeUsd: number,
    sliceSizeUsd: number,
    hourUTC: number,
  ): { totalMinutes: number; sliceCount: number; intervalMin: number } {
    const sliceCount = Math.ceil(positionSizeUsd / sliceSizeUsd);
    const intervalMin = this.getOptimalIntervalForHour(profile, hourUTC);
    const totalMinutes = intervalMin * (sliceCount - 1); // First slice is immediate
    
    return { totalMinutes, sliceCount, intervalMin };
  }

  /**
   * Force recalibration for a symbol
   */
  recalibrate(symbol: string, exchange: ExchangeType): ReplenishmentProfile | null {
    const cacheKey = `${symbol}-${exchange}`;
    this.profileCache.delete(cacheKey);
    this.cacheTimestamps.delete(cacheKey);
    return this.getProfile(symbol, exchange);
  }

  /**
   * Get all cached profiles
   */
  getAllProfiles(): Map<string, ReplenishmentProfile> {
    return new Map(this.profileCache);
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

  private calculateConfidenceScore(
    observationCount: number,
    avgTurnover: number,
    turnoverStdDev: number,
  ): number {
    // Score based on observation count (0-0.5)
    const countScore = Math.min(observationCount / 1000, 1) * 0.5;
    
    // Score based on turnover consistency (0-0.5)
    // Lower coefficient of variation = more consistent = higher confidence
    const cv = avgTurnover > 0 ? turnoverStdDev / avgTurnover : 1;
    const consistencyScore = Math.max(0, 1 - cv) * 0.5;
    
    return Math.min(1, countScore + consistencyScore);
  }
}





