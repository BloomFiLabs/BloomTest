import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import type { CircuitBreakerService, CircuitState } from './CircuitBreakerService';
import type { RateLimiterService } from './RateLimiterService';
import type { PositionStateRepository } from '../repositories/PositionStateRepository';

/**
 * Error event for tracking
 */
export interface ErrorEvent {
  type: string;
  message: string;
  exchange?: ExchangeType;
  symbol?: string;
  timestamp: Date;
  context?: Record<string, any>;
}

/**
 * Order event for tracking fill times
 */
export interface OrderEvent {
  orderId: string;
  symbol: string;
  exchange: ExchangeType;
  side: 'LONG' | 'SHORT';
  placedAt: Date;
  filledAt?: Date;
  status: 'PLACED' | 'FILLED' | 'FAILED' | 'CANCELLED';
  fillTimeMs?: number;
  failReason?: string;
}

/**
 * Single-leg position event
 */
export interface SingleLegEvent {
  id: string; // Unique identifier for this single-leg instance
  symbol: string;
  exchange: ExchangeType;
  side: 'LONG' | 'SHORT';
  startedAt: Date;
  resolvedAt?: Date;
  retryCount: number;
  resolution?: 'FILLED' | 'CLOSED' | 'TIMEOUT';
}

/**
 * Liquidity filter event
 */
export interface LiquidityFilterEvent {
  symbol: string;
  reason: 'LOW_VOLUME' | 'LOW_OI' | 'MISSING_DATA';
  timestamp: Date;
  details?: Record<string, any>;
}

/**
 * Connection status event
 */
export interface ConnectionEvent {
  exchange: ExchangeType;
  event: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECT' | 'ERROR';
  timestamp: Date;
  errorMessage?: string;
}

/**
 * Hourly statistics bucket
 */
interface HourlyBucket {
  hour: number; // Unix timestamp of hour start
  orders: {
    placed: number;
    filled: number;
    failed: number;
    cancelled: number;
    fillTimesMs: number[]; // For percentile calculation (capped at 100 samples)
  };
  errors: Map<string, { count: number; lastMessage: string; lastTimestamp: Date }>;
  singleLegs: {
    started: number;
    resolved: number;
    resolutionTimesMin: number[]; // For avg calculation (capped at 50 samples)
  };
  liquidityFilters: Map<string, number>; // reason -> count
  connections: Map<ExchangeType, { reconnects: number; errors: number; lastError?: string }>;
}

/**
 * Aggregated error summary
 */
interface ErrorSummary {
  type: string;
  count: number;
  lastSeen: Date;
  lastMessage: string;
  exchange?: ExchangeType;
}

/**
 * Active single-leg info for response
 */
interface ActiveSingleLeg {
  symbol: string;
  exchange: ExchangeType;
  side: 'LONG' | 'SHORT';
  ageMinutes: number;
  retries: number;
}

/**
 * Diagnostics response structure
 */
export interface DiagnosticsResponse {
  timestamp: Date;
  uptime: {
    hours: number;
    since: Date;
  };
  health: {
    overall: 'OK' | 'DEGRADED' | 'CRITICAL';
    issues: string[];
  };
  apy: {
    estimated: number;
    realized: number;
    byExchange: Record<string, number>;
  };
  orders: {
    last1h: { placed: number; filled: number; failed: number; fillRate: number };
    last24h: { placed: number; filled: number; failed: number; fillRate: number };
    avgFillTimeMs: { p50: number; p95: number; p99: number };
  };
  singleLegs: {
    active: ActiveSingleLeg[];
    stats: { last1h: number; last24h: number; avgResolutionMin: number };
  };
  errors: {
    total: { last1h: number; last24h: number };
    byType: Record<string, { count: number; last: string }>;
    recent: Array<{ time: string; type: string; exchange?: string; msg: string }>;
  };
  positions: {
    count: number;
    totalValue: number;
    unrealizedPnl: number;
    byExchange: Record<string, number>;
  };
  liquidity: {
    pairsFiltered: { last24h: number; reasons: Record<string, number> };
  };
  connectionStatus: Record<string, { status: string; reconnects24h: number; lastError?: string }>;
  rewards: {
    accruedProfits: number;
    lastHarvestTime: Date | null;
    lastHarvestAmount: number;
    nextHarvestIn: string;
    totalHarvested: number;
  };
  // New fields for enhanced diagnostics
  circuitBreaker?: {
    state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    errorsThisHour: number;
    threshold: number;
    cooldownRemainingMs: number | null;
  };
  rateLimiter?: {
    byExchange: Record<string, { 
      currentPerSecond: number; 
      maxPerSecond: number;
      currentPerMinute: number;
      maxPerMinute: number;
      queued: number;
    }>;
  };
  positionState?: {
    persisted: number;
    singleLeg: number;
    pending: number;
    complete: number;
  };
}

/**
 * DiagnosticsService - Tracks and aggregates diagnostic data for the keeper bot
 * 
 * Uses circular buffers (hourly buckets for 7 days) to keep memory bounded.
 * Provides condensed summaries suitable for API responses and AI context windows.
 */
@Injectable()
export class DiagnosticsService {
  private readonly logger = new Logger(DiagnosticsService.name);
  
  // Start time for uptime calculation
  private readonly startTime: Date = new Date();
  
  // Circular buffer of hourly buckets (168 hours = 7 days)
  private readonly MAX_HOURS = 168;
  private readonly hourlyBuckets: Map<number, HourlyBucket> = new Map();
  
  // Active single-leg positions (key: id)
  private readonly activeSingleLegs: Map<string, SingleLegEvent> = new Map();
  
  // Recent errors ring buffer (last 20)
  private readonly MAX_RECENT_ERRORS = 20;
  private readonly recentErrors: ErrorEvent[] = [];
  
  // APY data (set externally by PerformanceLogger)
  private apyData: {
    estimated: number;
    realized: number;
    byExchange: Record<string, number>;
  } = { estimated: 0, realized: 0, byExchange: {} };
  
  // Position data (set externally)
  private positionData: {
    count: number;
    totalValue: number;
    unrealizedPnl: number;
    byExchange: Record<string, number>;
  } = { count: 0, totalValue: 0, unrealizedPnl: 0, byExchange: {} };

  // Injected services for enhanced diagnostics
  private circuitBreaker?: CircuitBreakerService;
  private rateLimiter?: RateLimiterService;
  private positionStateRepo?: PositionStateRepository;

  // Rewards data (set externally by RewardHarvester)
  private rewardsData: {
    accruedProfits: number;
    lastHarvestTime: Date | null;
    lastHarvestAmount: number;
    nextHarvestIn: string;
    totalHarvested: number;
  } = { 
    accruedProfits: 0, 
    lastHarvestTime: null, 
    lastHarvestAmount: 0, 
    nextHarvestIn: '24h 0m',
    totalHarvested: 0,
  };

  constructor() {
    this.logger.log('DiagnosticsService initialized');
  }

  // ==================== Recording Methods ====================

  /**
   * Record an error event
   */
  recordError(event: ErrorEvent): void {
    const bucket = this.getOrCreateCurrentBucket();
    
    // Aggregate by type
    const existing = bucket.errors.get(event.type);
    if (existing) {
      existing.count++;
      existing.lastMessage = event.message;
      existing.lastTimestamp = event.timestamp;
    } else {
      bucket.errors.set(event.type, {
        count: 1,
        lastMessage: event.message,
        lastTimestamp: event.timestamp,
      });
    }
    
    // Add to recent errors (ring buffer)
    this.recentErrors.push(event);
    if (this.recentErrors.length > this.MAX_RECENT_ERRORS) {
      this.recentErrors.shift();
    }
  }

  /**
   * Record an order event
   */
  recordOrder(event: OrderEvent): void {
    const bucket = this.getOrCreateCurrentBucket();
    
    switch (event.status) {
      case 'PLACED':
        bucket.orders.placed++;
        break;
      case 'FILLED':
        bucket.orders.filled++;
        if (event.fillTimeMs !== undefined) {
          // Keep only last 100 samples per hour for percentile calculation
          if (bucket.orders.fillTimesMs.length < 100) {
            bucket.orders.fillTimesMs.push(event.fillTimeMs);
          }
        }
        break;
      case 'FAILED':
        bucket.orders.failed++;
        break;
      case 'CANCELLED':
        bucket.orders.cancelled++;
        break;
    }
  }

  /**
   * Record start of a single-leg position
   */
  recordSingleLegStart(event: SingleLegEvent): void {
    this.activeSingleLegs.set(event.id, event);
    
    const bucket = this.getOrCreateCurrentBucket();
    bucket.singleLegs.started++;
  }

  /**
   * Record resolution of a single-leg position
   */
  recordSingleLegResolved(id: string, resolution: 'FILLED' | 'CLOSED' | 'TIMEOUT'): void {
    const singleLeg = this.activeSingleLegs.get(id);
    if (!singleLeg) return;
    
    singleLeg.resolvedAt = new Date();
    singleLeg.resolution = resolution;
    
    const bucket = this.getOrCreateCurrentBucket();
    bucket.singleLegs.resolved++;
    
    // Calculate resolution time in minutes
    const resolutionTimeMin = (singleLeg.resolvedAt.getTime() - singleLeg.startedAt.getTime()) / 60000;
    if (bucket.singleLegs.resolutionTimesMin.length < 50) {
      bucket.singleLegs.resolutionTimesMin.push(resolutionTimeMin);
    }
    
    // Remove from active
    this.activeSingleLegs.delete(id);
  }

  /**
   * Update retry count for a single-leg position
   */
  updateSingleLegRetry(id: string): void {
    const singleLeg = this.activeSingleLegs.get(id);
    if (singleLeg) {
      singleLeg.retryCount++;
    }
  }

  /**
   * Record a liquidity filter event
   */
  recordLiquidityFilter(event: LiquidityFilterEvent): void {
    const bucket = this.getOrCreateCurrentBucket();
    const count = bucket.liquidityFilters.get(event.reason) || 0;
    bucket.liquidityFilters.set(event.reason, count + 1);
  }

  /**
   * Record a connection event
   */
  recordConnectionEvent(event: ConnectionEvent): void {
    const bucket = this.getOrCreateCurrentBucket();
    
    let connStats = bucket.connections.get(event.exchange);
    if (!connStats) {
      connStats = { reconnects: 0, errors: 0 };
      bucket.connections.set(event.exchange, connStats);
    }
    
    switch (event.event) {
      case 'RECONNECT':
        connStats.reconnects++;
        break;
      case 'ERROR':
        connStats.errors++;
        connStats.lastError = event.errorMessage;
        break;
    }
  }

  /**
   * Update APY data (called by PerformanceLogger)
   */
  updateApyData(data: { estimated: number; realized: number; byExchange: Record<string, number> }): void {
    this.apyData = data;
  }

  /**
   * Update position data (called by PerformanceLogger or Orchestrator)
   */
  updatePositionData(data: {
    count: number;
    totalValue: number;
    unrealizedPnl: number;
    byExchange: Record<string, number>;
  }): void {
    this.positionData = data;
  }

  /**
   * Update rewards data (called by RewardHarvester)
   */
  updateRewardsData(data: {
    accruedProfits: number;
    lastHarvestTime: Date | null;
    lastHarvestAmount: number;
    nextHarvestIn: string;
    totalHarvested: number;
  }): void {
    this.rewardsData = data;
  }

  /**
   * Set circuit breaker service reference for diagnostics
   */
  setCircuitBreaker(circuitBreaker: CircuitBreakerService): void {
    this.circuitBreaker = circuitBreaker;
  }

  /**
   * Set rate limiter service reference for diagnostics
   */
  setRateLimiter(rateLimiter: RateLimiterService): void {
    this.rateLimiter = rateLimiter;
  }

  /**
   * Set position state repository reference for diagnostics
   */
  setPositionStateRepository(repo: PositionStateRepository): void {
    this.positionStateRepo = repo;
  }

  // ==================== Query Methods ====================

  /**
   * Get condensed diagnostics response
   */
  getDiagnostics(): DiagnosticsResponse {
    const now = new Date();
    const uptimeHours = (now.getTime() - this.startTime.getTime()) / 3600000;
    
    // Aggregate stats for different time periods
    const stats1h = this.aggregateStats(1);
    const stats24h = this.aggregateStats(24);
    
    // Calculate health status
    const health = this.calculateHealthStatus(stats1h, stats24h);
    
    // Get all fill times for percentile calculation
    const allFillTimes = this.getAllFillTimes();
    
    return {
      timestamp: now,
      uptime: {
        hours: Math.round(uptimeHours * 10) / 10,
        since: this.startTime,
      },
      health,
      apy: this.apyData,
      orders: {
        last1h: {
          placed: stats1h.orders.placed,
          filled: stats1h.orders.filled,
          failed: stats1h.orders.failed,
          fillRate: stats1h.orders.placed > 0 
            ? Math.round((stats1h.orders.filled / stats1h.orders.placed) * 1000) / 10 
            : 100,
        },
        last24h: {
          placed: stats24h.orders.placed,
          filled: stats24h.orders.filled,
          failed: stats24h.orders.failed,
          fillRate: stats24h.orders.placed > 0 
            ? Math.round((stats24h.orders.filled / stats24h.orders.placed) * 1000) / 10 
            : 100,
        },
        avgFillTimeMs: this.calculatePercentiles(allFillTimes),
      },
      singleLegs: {
        active: this.getActiveSingleLegs(),
        stats: {
          last1h: stats1h.singleLegs.started,
          last24h: stats24h.singleLegs.started,
          avgResolutionMin: this.calculateAvgResolutionTime(),
        },
      },
      errors: {
        total: {
          last1h: stats1h.errorCount,
          last24h: stats24h.errorCount,
        },
        byType: this.getErrorsByType(stats24h),
        recent: this.getRecentErrors(),
      },
      positions: this.positionData,
      liquidity: {
        pairsFiltered: {
          last24h: this.getLiquidityFilterCount(24),
          reasons: this.getLiquidityFilterReasons(24),
        },
      },
      connectionStatus: this.getConnectionStatus(),
      rewards: this.rewardsData,
      // Enhanced diagnostics from new services
      circuitBreaker: this.getCircuitBreakerDiagnostics(),
      rateLimiter: this.getRateLimiterDiagnostics(),
      positionState: this.getPositionStateDiagnostics(),
    };
  }

  /**
   * Get circuit breaker diagnostics
   */
  private getCircuitBreakerDiagnostics(): DiagnosticsResponse['circuitBreaker'] {
    if (!this.circuitBreaker) {
      return undefined;
    }

    const diagnostics = this.circuitBreaker.getDiagnostics();
    return {
      state: diagnostics.state as 'CLOSED' | 'OPEN' | 'HALF_OPEN',
      errorsThisHour: diagnostics.errorsThisHour,
      threshold: diagnostics.threshold,
      cooldownRemainingMs: diagnostics.cooldownRemainingMs,
    };
  }

  /**
   * Get rate limiter diagnostics
   */
  private getRateLimiterDiagnostics(): DiagnosticsResponse['rateLimiter'] {
    if (!this.rateLimiter) {
      return undefined;
    }

    const allUsage = this.rateLimiter.getAllUsage();
    const byExchange: Record<string, {
      currentPerSecond: number;
      maxPerSecond: number;
      currentPerMinute: number;
      maxPerMinute: number;
      queued: number;
    }> = {};

    for (const [exchange, usage] of allUsage) {
      byExchange[exchange] = {
        currentPerSecond: usage.currentRequestsPerSecond,
        maxPerSecond: usage.maxRequestsPerSecond,
        currentPerMinute: usage.currentRequestsPerMinute,
        maxPerMinute: usage.maxRequestsPerMinute,
        queued: usage.queuedRequests,
      };
    }

    return { byExchange };
  }

  /**
   * Get position state diagnostics
   */
  private getPositionStateDiagnostics(): DiagnosticsResponse['positionState'] {
    if (!this.positionStateRepo) {
      return undefined;
    }

    const counts = this.positionStateRepo.getStatusCounts();
    return {
      persisted: this.positionStateRepo.getAll().length,
      singleLeg: counts.SINGLE_LEG,
      pending: counts.PENDING,
      complete: counts.COMPLETE,
    };
  }

  // ==================== Private Helper Methods ====================

  private getHourTimestamp(date: Date = new Date()): number {
    return Math.floor(date.getTime() / 3600000) * 3600000;
  }

  private getOrCreateCurrentBucket(): HourlyBucket {
    const hourTs = this.getHourTimestamp();
    
    let bucket = this.hourlyBuckets.get(hourTs);
    if (!bucket) {
      bucket = {
        hour: hourTs,
        orders: { placed: 0, filled: 0, failed: 0, cancelled: 0, fillTimesMs: [] },
        errors: new Map(),
        singleLegs: { started: 0, resolved: 0, resolutionTimesMin: [] },
        liquidityFilters: new Map(),
        connections: new Map(),
      };
      this.hourlyBuckets.set(hourTs, bucket);
      
      // Cleanup old buckets
      this.cleanupOldBuckets();
    }
    
    return bucket;
  }

  private cleanupOldBuckets(): void {
    const cutoff = this.getHourTimestamp() - (this.MAX_HOURS * 3600000);
    for (const [hourTs] of this.hourlyBuckets) {
      if (hourTs < cutoff) {
        this.hourlyBuckets.delete(hourTs);
      }
    }
  }

  private aggregateStats(hours: number): {
    orders: { placed: number; filled: number; failed: number };
    errorCount: number;
    singleLegs: { started: number; resolved: number };
    errors: Map<string, { count: number; lastMessage: string; lastTimestamp: Date }>;
  } {
    const now = this.getHourTimestamp();
    const cutoff = now - (hours * 3600000);
    
    const result = {
      orders: { placed: 0, filled: 0, failed: 0 },
      errorCount: 0,
      singleLegs: { started: 0, resolved: 0 },
      errors: new Map<string, { count: number; lastMessage: string; lastTimestamp: Date }>(),
    };
    
    for (const [hourTs, bucket] of this.hourlyBuckets) {
      if (hourTs >= cutoff) {
        result.orders.placed += bucket.orders.placed;
        result.orders.filled += bucket.orders.filled;
        result.orders.failed += bucket.orders.failed;
        result.singleLegs.started += bucket.singleLegs.started;
        result.singleLegs.resolved += bucket.singleLegs.resolved;
        
        // Aggregate errors
        for (const [type, data] of bucket.errors) {
          result.errorCount += data.count;
          const existing = result.errors.get(type);
          if (existing) {
            existing.count += data.count;
            if (data.lastTimestamp > existing.lastTimestamp) {
              existing.lastMessage = data.lastMessage;
              existing.lastTimestamp = data.lastTimestamp;
            }
          } else {
            result.errors.set(type, { ...data });
          }
        }
      }
    }
    
    return result;
  }

  private getAllFillTimes(): number[] {
    const allTimes: number[] = [];
    for (const bucket of this.hourlyBuckets.values()) {
      allTimes.push(...bucket.orders.fillTimesMs);
    }
    return allTimes;
  }

  private calculatePercentiles(times: number[]): { p50: number; p95: number; p99: number } {
    if (times.length === 0) {
      return { p50: 0, p95: 0, p99: 0 };
    }
    
    const sorted = [...times].sort((a, b) => a - b);
    
    const percentile = (p: number): number => {
      const index = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, index)];
    };
    
    return {
      p50: Math.round(percentile(50)),
      p95: Math.round(percentile(95)),
      p99: Math.round(percentile(99)),
    };
  }

  private calculateHealthStatus(stats1h: any, stats24h: any): { overall: 'OK' | 'DEGRADED' | 'CRITICAL'; issues: string[] } {
    const issues: string[] = [];
    
    // Check fill rate
    if (stats1h.orders.placed > 0) {
      const fillRate = stats1h.orders.filled / stats1h.orders.placed;
      if (fillRate < 0.8) {
        issues.push(`Low fill rate: ${Math.round(fillRate * 100)}%`);
      }
    }
    
    // Check active single-legs
    if (this.activeSingleLegs.size > 0) {
      const oldSingleLegs = Array.from(this.activeSingleLegs.values())
        .filter(sl => (Date.now() - sl.startedAt.getTime()) > 30 * 60000); // > 30 min
      if (oldSingleLegs.length > 0) {
        issues.push(`${oldSingleLegs.length} stale single-leg position(s)`);
      }
    }
    
    // Check error rate
    if (stats1h.errorCount > 10) {
      issues.push(`High error rate: ${stats1h.errorCount} errors/hour`);
    }
    
    // Check connections
    const connStatus = this.getConnectionStatus();
    for (const [exchange, status] of Object.entries(connStatus)) {
      if (status.reconnects24h > 20) {
        issues.push(`${exchange} connection unstable (${status.reconnects24h} reconnects)`);
      }
    }
    
    let overall: 'OK' | 'DEGRADED' | 'CRITICAL' = 'OK';
    if (issues.length > 2) {
      overall = 'CRITICAL';
    } else if (issues.length > 0) {
      overall = 'DEGRADED';
    }
    
    return { overall, issues };
  }

  private getActiveSingleLegs(): ActiveSingleLeg[] {
    const now = Date.now();
    return Array.from(this.activeSingleLegs.values()).map(sl => ({
      symbol: sl.symbol,
      exchange: sl.exchange,
      side: sl.side,
      ageMinutes: Math.round((now - sl.startedAt.getTime()) / 60000),
      retries: sl.retryCount,
    }));
  }

  private calculateAvgResolutionTime(): number {
    const allTimes: number[] = [];
    for (const bucket of this.hourlyBuckets.values()) {
      allTimes.push(...bucket.singleLegs.resolutionTimesMin);
    }
    
    if (allTimes.length === 0) return 0;
    return Math.round((allTimes.reduce((a, b) => a + b, 0) / allTimes.length) * 10) / 10;
  }

  private getErrorsByType(stats: any): Record<string, { count: number; last: string }> {
    const result: Record<string, { count: number; last: string }> = {};
    
    for (const [type, data] of stats.errors) {
      const minutesAgo = Math.round((Date.now() - data.lastTimestamp.getTime()) / 60000);
      let lastStr: string;
      if (minutesAgo < 60) {
        lastStr = `${minutesAgo}min ago`;
      } else if (minutesAgo < 1440) {
        lastStr = `${Math.round(minutesAgo / 60)}h ago`;
      } else {
        lastStr = `${Math.round(minutesAgo / 1440)}d ago`;
      }
      
      result[type] = { count: data.count, last: lastStr };
    }
    
    return result;
  }

  private getRecentErrors(): Array<{ time: string; type: string; exchange?: string; msg: string }> {
    const now = Date.now();
    
    return this.recentErrors.slice(-10).reverse().map(err => {
      const minutesAgo = Math.round((now - err.timestamp.getTime()) / 60000);
      let timeStr: string;
      if (minutesAgo < 60) {
        timeStr = `${minutesAgo}min ago`;
      } else {
        timeStr = `${Math.round(minutesAgo / 60)}h ago`;
      }
      
      return {
        time: timeStr,
        type: err.type,
        exchange: err.exchange,
        msg: err.message.substring(0, 100), // Truncate for brevity
      };
    });
  }

  private getLiquidityFilterCount(hours: number): number {
    const now = this.getHourTimestamp();
    const cutoff = now - (hours * 3600000);
    
    let count = 0;
    for (const [hourTs, bucket] of this.hourlyBuckets) {
      if (hourTs >= cutoff) {
        for (const c of bucket.liquidityFilters.values()) {
          count += c;
        }
      }
    }
    
    return count;
  }

  private getLiquidityFilterReasons(hours: number): Record<string, number> {
    const now = this.getHourTimestamp();
    const cutoff = now - (hours * 3600000);
    
    const result: Record<string, number> = {};
    for (const [hourTs, bucket] of this.hourlyBuckets) {
      if (hourTs >= cutoff) {
        for (const [reason, count] of bucket.liquidityFilters) {
          result[reason] = (result[reason] || 0) + count;
        }
      }
    }
    
    return result;
  }

  private getConnectionStatus(): Record<string, { status: string; reconnects24h: number; lastError?: string }> {
    const now = this.getHourTimestamp();
    const cutoff = now - (24 * 3600000);
    
    const result: Record<string, { status: string; reconnects24h: number; lastError?: string }> = {};
    
    // Initialize for all exchanges
    for (const exchange of [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER, ExchangeType.ASTER]) {
      result[exchange] = { status: 'OK', reconnects24h: 0 };
    }
    
    // Aggregate from buckets
    for (const [hourTs, bucket] of this.hourlyBuckets) {
      if (hourTs >= cutoff) {
        for (const [exchange, stats] of bucket.connections) {
          if (!result[exchange]) {
            result[exchange] = { status: 'OK', reconnects24h: 0 };
          }
          result[exchange].reconnects24h += stats.reconnects;
          if (stats.lastError) {
            result[exchange].lastError = stats.lastError;
          }
        }
      }
    }
    
    // Determine status based on reconnect count
    for (const exchange of Object.keys(result)) {
      if (result[exchange].reconnects24h > 20) {
        result[exchange].status = 'DEGRADED';
      } else if (result[exchange].reconnects24h > 50) {
        result[exchange].status = 'CRITICAL';
      }
    }
    
    return result;
  }

  /**
   * Reset all diagnostics (for testing)
   */
  reset(): void {
    this.hourlyBuckets.clear();
    this.activeSingleLegs.clear();
    this.recentErrors.length = 0;
    this.apyData = { estimated: 0, realized: 0, byExchange: {} };
    this.positionData = { count: 0, totalValue: 0, unrealizedPnl: 0, byExchange: {} };
  }
}

