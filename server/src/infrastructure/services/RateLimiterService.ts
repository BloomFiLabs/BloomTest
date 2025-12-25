import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';

/**
 * Rate limit priority levels
 */
export enum RateLimitPriority {
  NORMAL = 0,
  HIGH = 1,
  EMERGENCY = 2,
}

/**
 * Rate limit configuration per exchange
 */
export interface RateLimitConfig {
  exchange: ExchangeType;
  maxRequestsPerSecond: number;
  maxRequestsPerMinute: number;
}

/**
 * Rate limit bucket for tracking requests
 */
interface RateEntry {
  timestamp: number;
  weight: number;
}

interface WaitQueueEntry {
  resolve: () => void;
  weight: number;
  priority: RateLimitPriority;
  timestamp: number;
}

interface RateBucket {
  // Sliding window for per-second limiting
  secondWindow: RateEntry[];
  // Sliding window for per-minute limiting
  minuteWindow: RateEntry[];
  // Queue for waiting requests
  waitQueue: WaitQueueEntry[];
}

/**
 * Rate limiter usage statistics
 */
export interface RateLimiterUsage {
  currentWeightPerSecond: number;
  currentWeightPerMinute: number;
  maxWeightPerSecond: number;
  maxWeightPerMinute: number;
  queuedRequests: number;
  budgetHealth: number; // 0.0 to 1.0 (1.0 = full budget available)
}

/**
 * Rate limit hit event for tracking
 */
export interface RateLimitHitEvent {
  exchange: ExchangeType;
  timestamp: Date;
  operation: string;
  weight: number;
  queuedMs: number; // How long we had to wait
  currentSecondWeight: number;
  currentMinuteWeight: number;
  limitSecond: number;
  limitMinute: number;
}

/**
 * Rate limit analytics
 */
export interface RateLimitAnalytics {
  exchange: ExchangeType;
  last1h: {
    totalRequests: number;
    rateLimitHits: number;
    hitRate: number; // 0.0 to 1.0
    avgQueueTimeMs: number;
    maxQueueTimeMs: number;
    totalQueueTimeMs: number;
    byOperation: Record<string, { requests: number; hits: number; avgQueueMs: number }>;
  };
  last24h: {
    totalRequests: number;
    rateLimitHits: number;
    hitRate: number;
    avgQueueTimeMs: number;
    maxQueueTimeMs: number;
    peakUsagePercent: number;
  };
  currentState: {
    secondUsagePercent: number;
    minuteUsagePercent: number;
    queueLength: number;
    estimatedWaitMs: number;
  };
}

/**
 * Request weight definitions based on exchange documentation
 * 
 * HYPERLIQUID (from docs):
 * - Exchange API: 1 + floor(batch_length / 40)
 * - Info requests (l2Book, allMids, clearinghouseState, orderStatus): weight 2
 * - Other info requests: weight 20
 * - userRole: weight 60
 * - IP limit: 1200 weight/minute
 * 
 * LIGHTER (from docs):
 * - Premium accounts: 24,000 weight per 60 seconds (rolling)
 * - Standard accounts: Lower limits
 * - Volume Quota: +1 tx per $10 traded (separate from rate limit)
 * - Cancels don't consume quota
 * - Free SendTx every 15 seconds
 */
export const REQUEST_WEIGHTS = {
  // Hyperliquid weights
  HL_EXCHANGE_ACTION: 1, // Base weight for exchange actions
  HL_INFO_LIGHT: 2, // l2Book, allMids, clearinghouseState, orderStatus
  HL_INFO_HEAVY: 20, // Most other info requests
  HL_INFO_USER_ROLE: 60, // userRole endpoint
  
  // Lighter weights (estimated based on docs)
  LIGHTER_SEND_TX: 1, // SendTx weight
  LIGHTER_INFO: 1, // Info requests
  LIGHTER_CANCEL: 0, // Cancels don't consume quota
};

/**
 * Default rate limits for each exchange
 * Based on official API documentation:
 * - Hyperliquid: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
 * - Lighter: https://apidocs.lighter.xyz/docs/volume-quota-program
 */
const DEFAULT_LIMITS: RateLimitConfig[] = [
  {
    exchange: ExchangeType.LIGHTER,
    // Premium: 24,000 weight/60s, but we use conservative 80% to avoid hitting limits
    maxRequestsPerSecond: 320, // ~19,200/min = 320/s
    maxRequestsPerMinute: 19200, // 80% of 24,000 premium limit
  },
  {
    exchange: ExchangeType.HYPERLIQUID,
    // IP limit: 1200 weight/minute, use 80% to be safe
    maxRequestsPerSecond: 16, // ~960/min = 16/s
    maxRequestsPerMinute: 960, // 80% of 1200 limit
  },
  {
    exchange: ExchangeType.ASTER,
    maxRequestsPerSecond: 50,
    maxRequestsPerMinute: 1200,
  },
  {
    exchange: ExchangeType.EXTENDED,
    maxRequestsPerSecond: 50,
    maxRequestsPerMinute: 1200,
  },
  {
    exchange: ExchangeType.MOCK,
    maxRequestsPerSecond: 1000, // Unlimited for testing
    maxRequestsPerMinute: 60000,
  },
];

/**
 * RateLimiterService - Global rate limiter for exchange API calls
 *
 * Features:
 * - Per-exchange rate limiting with configurable limits
 * - Sliding window algorithm for accurate rate tracking
 * - Request queuing when limits are exceeded
 * - Usage statistics for monitoring
 */
@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly limits: Map<ExchangeType, RateLimitConfig> = new Map();
  private readonly buckets: Map<ExchangeType, RateBucket> = new Map();
  
  // Rate limit hit tracking
  private readonly hitEvents: RateLimitHitEvent[] = [];
  private readonly MAX_HIT_EVENTS = 1000; // Keep last 1000 events
  
  // Request tracking for analytics
  private readonly requestLog: Array<{
    exchange: ExchangeType;
    timestamp: Date;
    operation: string;
    weight: number;
    queuedMs: number;
    wasLimited: boolean;
  }> = [];
  private readonly MAX_REQUEST_LOG = 10000;
  
  // Peak usage tracking
  private readonly peakUsage: Map<ExchangeType, { percent: number; timestamp: Date }> = new Map();

  constructor(private readonly configService: ConfigService) {
    // Initialize with default limits
    for (const config of DEFAULT_LIMITS) {
      this.limits.set(config.exchange, config);
      this.buckets.set(config.exchange, {
        secondWindow: [],
        minuteWindow: [],
        waitQueue: [],
      });
    }

    // Override from config if provided
    this.loadConfigOverrides();

    this.logger.log('RateLimiter initialized with limits:');
    for (const [exchange, config] of this.limits) {
      this.logger.log(
        `  ${exchange}: ${config.maxRequestsPerSecond}/s, ${config.maxRequestsPerMinute}/min`,
      );
    }
  }

  /**
   * Load rate limit overrides from configuration
   */
  private loadConfigOverrides(): void {
    // Example config: RATE_LIMIT_LIGHTER_PER_SECOND=3
    for (const exchange of Object.values(ExchangeType)) {
      const perSecond = this.configService.get<number>(
        `RATE_LIMIT_${exchange}_PER_SECOND`,
      );
      const perMinute = this.configService.get<number>(
        `RATE_LIMIT_${exchange}_PER_MINUTE`,
      );

      if (perSecond || perMinute) {
        const existing = this.limits.get(exchange as ExchangeType);
        if (existing) {
          this.limits.set(exchange as ExchangeType, {
            ...existing,
            maxRequestsPerSecond: perSecond ?? existing.maxRequestsPerSecond,
            maxRequestsPerMinute: perMinute ?? existing.maxRequestsPerMinute,
          });
        }
      }
    }
  }

  /**
   * Acquire a rate limit slot for the given exchange
   * Will wait if rate limit is exceeded
   *
   * @param exchange - The exchange to acquire a slot for
   * @param weight - The weight of this request (default: 1)
   * @param priority - The priority of this request (default: NORMAL)
   * @param operation - Description of the operation (for analytics)
   * @returns Promise that resolves when a slot is available
   */
  async acquire(
    exchange: ExchangeType,
    weight: number = 1,
    priority: RateLimitPriority = RateLimitPriority.NORMAL,
    operation: string = 'unknown',
  ): Promise<void> {
    const bucket = this.buckets.get(exchange);
    const config = this.limits.get(exchange);

    if (!bucket || !config) {
      // Unknown exchange - allow through
      return;
    }

    // Clean up old entries from sliding windows
    this.pruneWindows(bucket);

    const now = Date.now();

    // Calculate current weights
    const currentSecondWeight = bucket.secondWindow.reduce((sum, e) => sum + e.weight, 0);
    const currentMinuteWeight = bucket.minuteWindow.reduce((sum, e) => sum + e.weight, 0);

    // EMERGENCY priority bypasses the per-second limit and wait queue
    // but still checks minute limit to prevent total API ban
    if (priority === RateLimitPriority.EMERGENCY) {
      const withinMinuteLimit = (currentMinuteWeight + weight) <= (config.maxRequestsPerMinute * 1.1); // 10% overflow allowance for emergencies
      
      if (withinMinuteLimit) {
        this.logger.warn(`🚨 EMERGENCY acquisition for ${exchange}: bypassing queue and second-limit`);
        bucket.secondWindow.push({ timestamp: now, weight });
        bucket.minuteWindow.push({ timestamp: now, weight });
        return;
      }
    }

    // Check if we're at the limit
    const withinSecondLimit = (currentSecondWeight + weight) <= config.maxRequestsPerSecond;
    const withinMinuteLimit = (currentMinuteWeight + weight) <= config.maxRequestsPerMinute;

    // Track peak usage
    this.trackPeakUsage(exchange, currentMinuteWeight, config.maxRequestsPerMinute);

    // If we have capacity AND no one is waiting, proceed immediately
    if (withinSecondLimit && withinMinuteLimit && bucket.waitQueue.length === 0) {
      // We have capacity - record and proceed
      bucket.secondWindow.push({ timestamp: now, weight });
      bucket.minuteWindow.push({ timestamp: now, weight });
      
      // Track this request (not rate limited)
      this.trackRequest(exchange, operation, weight, 0, false, currentSecondWeight, currentMinuteWeight, config);
      return;
    }

    // We're at the limit or others are waiting - need to wait
    const waitTime = this.calculateWaitTime(bucket, config, now, weight, priority);

    // This is a RATE LIMIT HIT - track it!
    this.trackRateLimitHit(exchange, operation, weight, waitTime, currentSecondWeight, currentMinuteWeight, config);

    if (priority >= RateLimitPriority.HIGH) {
      this.logger.debug(
        `Priority acquisition (${RateLimitPriority[priority]}) for ${exchange}, waiting ${waitTime}ms ` +
          `(${currentSecondWeight + weight}/${config.maxRequestsPerSecond}/s, ` +
          `${currentMinuteWeight + weight}/${config.maxRequestsPerMinute}/min, queue: ${bucket.waitQueue.length})`,
      );
    } else {
      this.logger.debug(
        `⏳ RATE LIMITED: ${exchange} ${operation} - waiting ${waitTime}ms ` +
          `(${currentSecondWeight + weight}/${config.maxRequestsPerSecond}/s, ` +
          `${currentMinuteWeight + weight}/${config.maxRequestsPerMinute}/min)`
      );
    }

    // Wait for the calculated time
    await new Promise<void>((resolve) => {
      const entry: WaitQueueEntry = { resolve, weight, priority, timestamp: Date.now() };
      
      // HIGH priority goes to front of queue (but behind EMERGENCY)
      if (priority === RateLimitPriority.EMERGENCY) {
        bucket.waitQueue.unshift(entry);
      } else if (priority === RateLimitPriority.HIGH) {
        const lastHighIdx = bucket.waitQueue.findIndex(q => q.priority < RateLimitPriority.HIGH);
        if (lastHighIdx === -1) {
          bucket.waitQueue.push(entry);
        } else {
          bucket.waitQueue.splice(lastHighIdx, 0, entry);
        }
      } else {
        bucket.waitQueue.push(entry);
      }

      setTimeout(() => {
        // Remove from queue and resolve
        const index = bucket.waitQueue.findIndex(q => q.resolve === resolve);
        if (index > -1) {
          bucket.waitQueue.splice(index, 1);
        }

        // Re-prune and record
        this.pruneWindows(bucket);
        const actualNow = Date.now();
        bucket.secondWindow.push({ timestamp: actualNow, weight });
        bucket.minuteWindow.push({ timestamp: actualNow, weight });
        
        // Track this request (was rate limited)
        this.trackRequest(exchange, operation, weight, waitTime, true, currentSecondWeight, currentMinuteWeight, config);

        resolve();
      }, waitTime);
    });
  }

  /**
   * Try to acquire a rate limit slot without waiting
   *
   * @param exchange - The exchange to try acquiring a slot for
   * @param weight - The weight of this request (default: 1)
   * @returns true if slot was acquired, false if rate limited
   */
  tryAcquire(exchange: ExchangeType, weight: number = 1): boolean {
    const bucket = this.buckets.get(exchange);
    const config = this.limits.get(exchange);

    if (!bucket || !config) {
      return true;
    }

    this.pruneWindows(bucket);

    const currentSecondWeight = bucket.secondWindow.reduce((sum, e) => sum + e.weight, 0);
    const currentMinuteWeight = bucket.minuteWindow.reduce((sum, e) => sum + e.weight, 0);

    const withinSecondLimit = (currentSecondWeight + weight) <= config.maxRequestsPerSecond;
    const withinMinuteLimit = (currentMinuteWeight + weight) <= config.maxRequestsPerMinute;

    if (withinSecondLimit && withinMinuteLimit) {
      const now = Date.now();
      bucket.secondWindow.push({ timestamp: now, weight });
      bucket.minuteWindow.push({ timestamp: now, weight });
      return true;
    }

    return false;
  }

  /**
   * Get current usage statistics for an exchange
   */
  getUsage(exchange: ExchangeType): RateLimiterUsage {
    const bucket = this.buckets.get(exchange);
    const config = this.limits.get(exchange);

    if (!bucket || !config) {
      return {
        currentWeightPerSecond: 0,
        currentWeightPerMinute: 0,
        maxWeightPerSecond: 0,
        maxWeightPerMinute: 0,
        queuedRequests: 0,
        budgetHealth: 1.0,
      };
    }

    this.pruneWindows(bucket);

    const currentSecondWeight = bucket.secondWindow.reduce((sum, e) => sum + e.weight, 0);
    const currentMinuteWeight = bucket.minuteWindow.reduce((sum, e) => sum + e.weight, 0);

    // Budget health is determined by the most constrained limit
    const secondHealth = 1 - (currentSecondWeight / config.maxRequestsPerSecond);
    const minuteHealth = 1 - (currentMinuteWeight / config.maxRequestsPerMinute);
    const budgetHealth = Math.max(0, Math.min(secondHealth, minuteHealth));

    return {
      currentWeightPerSecond: currentSecondWeight,
      currentWeightPerMinute: currentMinuteWeight,
      maxWeightPerSecond: config.maxRequestsPerSecond,
      maxWeightPerMinute: config.maxRequestsPerMinute,
      queuedRequests: bucket.waitQueue.length,
      budgetHealth,
    };
  }

  /**
   * Get usage for all exchanges
   */
  getAllUsage(): Map<ExchangeType, RateLimiterUsage> {
    const usage = new Map<ExchangeType, RateLimiterUsage>();

    for (const exchange of this.limits.keys()) {
      usage.set(exchange, this.getUsage(exchange));
    }

    return usage;
  }

  /**
   * Get the configured rate limit for an exchange
   */
  getLimit(exchange: ExchangeType): RateLimitConfig | undefined {
    return this.limits.get(exchange);
  }

  /**
   * Update rate limit for an exchange at runtime
   */
  setLimit(exchange: ExchangeType, config: Partial<RateLimitConfig>): void {
    const existing = this.limits.get(exchange);
    if (existing) {
      this.limits.set(exchange, { ...existing, ...config });
      this.logger.log(
        `Updated rate limit for ${exchange}: ` +
          `${this.limits.get(exchange)?.maxRequestsPerSecond}/s, ` +
          `${this.limits.get(exchange)?.maxRequestsPerMinute}/min`,
      );
    }
  }

  /**
   * Reset rate limit counters for an exchange
   */
  reset(exchange: ExchangeType): void {
    const bucket = this.buckets.get(exchange);
    if (bucket) {
      bucket.secondWindow = [];
      bucket.minuteWindow = [];
      // Release all waiting requests
      bucket.waitQueue.forEach((entry) => entry.resolve());
      bucket.waitQueue = [];
    }
  }

  /**
   * Reset all rate limit counters
   */
  resetAll(): void {
    for (const exchange of this.buckets.keys()) {
      this.reset(exchange);
    }
  }

  /**
   * Record an external rate limit (429) hit.
   * This will clear the current windows and force a cooldown.
   */
  recordExternalRateLimit(exchange: ExchangeType, cooldownMs: number = 5000): void {
    const bucket = this.buckets.get(exchange);
    if (!bucket) return;

    this.logger.warn(`🛑 External rate limit hit for ${exchange}! Applying ${cooldownMs}ms cooldown.`);
    
    // Clear windows to ensure next acquisition waits
    bucket.secondWindow = [];
    bucket.minuteWindow = [];
    
    // Add dummy entries at future timestamps to block acquisition
    const futureTimestamp = Date.now() + cooldownMs;
    const config = this.limits.get(exchange);
    if (config) {
      bucket.secondWindow.push({ timestamp: futureTimestamp, weight: config.maxRequestsPerSecond });
      bucket.minuteWindow.push({ timestamp: futureTimestamp, weight: config.maxRequestsPerMinute });
    }
  }

  /**
   * Calculate how long to wait before the next request can be made
   */
  private calculateWaitTime(
    bucket: RateBucket,
    config: RateLimitConfig,
    now: number,
    weight: number,
    priority: RateLimitPriority = RateLimitPriority.NORMAL,
  ): number {
    let waitTime = 0;

    // Check per-second limit: find when enough weight will have expired
    let secondWeight = bucket.secondWindow.reduce((sum, e) => sum + e.weight, 0);
    if (secondWeight + weight > config.maxRequestsPerSecond) {
      // Find how many entries need to expire
      let weightToDrop = (secondWeight + weight) - config.maxRequestsPerSecond;
      let droppedWeight = 0;
      for (const entry of bucket.secondWindow) {
        droppedWeight += entry.weight;
        if (droppedWeight >= weightToDrop) {
          const secondWaitTime = 1000 - (now - entry.timestamp);
          waitTime = Math.max(waitTime, secondWaitTime);
          break;
        }
      }
    }

    // Check per-minute limit
    let minuteWeight = bucket.minuteWindow.reduce((sum, e) => sum + e.weight, 0);
    if (minuteWeight + weight > config.maxRequestsPerMinute) {
      let weightToDrop = (minuteWeight + weight) - config.maxRequestsPerMinute;
      let droppedWeight = 0;
      for (const entry of bucket.minuteWindow) {
        droppedWeight += entry.weight;
        if (droppedWeight >= weightToDrop) {
          const minuteWaitTime = 60000 - (now - entry.timestamp);
          waitTime = Math.max(waitTime, minuteWaitTime);
          break;
        }
      }
    }

    // Adjust based on priority
    if (priority === RateLimitPriority.EMERGENCY) {
      return Math.max(waitTime / 2, 50); // Faster processing for emergencies
    } else if (priority === RateLimitPriority.HIGH) {
      return Math.max(waitTime * 0.8, 100);
    }

    // Add a small buffer to avoid edge cases
    return Math.max(waitTime + 50, 100);
  }

  /**
   * Remove entries outside the sliding window
   */
  private pruneWindows(bucket: RateBucket): void {
    const now = Date.now();
    const oneSecondAgo = now - 1000;
    const oneMinuteAgo = now - 60000;

    bucket.secondWindow = bucket.secondWindow.filter((e) => e.timestamp > oneSecondAgo);
    bucket.minuteWindow = bucket.minuteWindow.filter((e) => e.timestamp > oneMinuteAgo);
  }

  // ==================== RATE LIMIT ANALYTICS ====================

  /**
   * Track a rate limit hit event
   */
  private trackRateLimitHit(
    exchange: ExchangeType,
    operation: string,
    weight: number,
    queuedMs: number,
    currentSecondWeight: number,
    currentMinuteWeight: number,
    config: RateLimitConfig,
  ): void {
    const event: RateLimitHitEvent = {
      exchange,
      timestamp: new Date(),
      operation,
      weight,
      queuedMs,
      currentSecondWeight,
      currentMinuteWeight,
      limitSecond: config.maxRequestsPerSecond,
      limitMinute: config.maxRequestsPerMinute,
    };
    
    this.hitEvents.push(event);
    if (this.hitEvents.length > this.MAX_HIT_EVENTS) {
      this.hitEvents.shift();
    }
  }

  /**
   * Track a request (for overall analytics)
   */
  private trackRequest(
    exchange: ExchangeType,
    operation: string,
    weight: number,
    queuedMs: number,
    wasLimited: boolean,
    currentSecondWeight: number,
    currentMinuteWeight: number,
    config: RateLimitConfig,
  ): void {
    this.requestLog.push({
      exchange,
      timestamp: new Date(),
      operation,
      weight,
      queuedMs,
      wasLimited,
    });
    
    if (this.requestLog.length > this.MAX_REQUEST_LOG) {
      this.requestLog.shift();
    }
  }

  /**
   * Track peak usage for an exchange
   */
  private trackPeakUsage(exchange: ExchangeType, currentWeight: number, maxWeight: number): void {
    const usagePercent = (currentWeight / maxWeight) * 100;
    const existing = this.peakUsage.get(exchange);
    
    if (!existing || usagePercent > existing.percent) {
      this.peakUsage.set(exchange, { percent: usagePercent, timestamp: new Date() });
    }
  }

  /**
   * Get rate limit analytics for an exchange
   */
  getAnalytics(exchange: ExchangeType): RateLimitAnalytics {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    
    // Filter events for this exchange
    const hits1h = this.hitEvents.filter(e => 
      e.exchange === exchange && e.timestamp.getTime() > oneHourAgo
    );
    const hits24h = this.hitEvents.filter(e => 
      e.exchange === exchange && e.timestamp.getTime() > oneDayAgo
    );
    
    const requests1h = this.requestLog.filter(r =>
      r.exchange === exchange && r.timestamp.getTime() > oneHourAgo
    );
    const requests24h = this.requestLog.filter(r =>
      r.exchange === exchange && r.timestamp.getTime() > oneDayAgo
    );
    
    // Calculate 1h analytics by operation
    const byOperation: Record<string, { requests: number; hits: number; avgQueueMs: number }> = {};
    for (const req of requests1h) {
      if (!byOperation[req.operation]) {
        byOperation[req.operation] = { requests: 0, hits: 0, avgQueueMs: 0 };
      }
      byOperation[req.operation].requests++;
      if (req.wasLimited) {
        byOperation[req.operation].hits++;
        byOperation[req.operation].avgQueueMs = 
          (byOperation[req.operation].avgQueueMs * (byOperation[req.operation].hits - 1) + req.queuedMs) / 
          byOperation[req.operation].hits;
      }
    }
    
    // Get current state
    const usage = this.getUsage(exchange);
    const config = this.limits.get(exchange);
    const peak = this.peakUsage.get(exchange);
    
    return {
      exchange,
      last1h: {
        totalRequests: requests1h.length,
        rateLimitHits: hits1h.length,
        hitRate: requests1h.length > 0 ? hits1h.length / requests1h.length : 0,
        avgQueueTimeMs: hits1h.length > 0 
          ? hits1h.reduce((sum, h) => sum + h.queuedMs, 0) / hits1h.length 
          : 0,
        maxQueueTimeMs: hits1h.length > 0 
          ? Math.max(...hits1h.map(h => h.queuedMs)) 
          : 0,
        totalQueueTimeMs: hits1h.reduce((sum, h) => sum + h.queuedMs, 0),
        byOperation,
      },
      last24h: {
        totalRequests: requests24h.length,
        rateLimitHits: hits24h.length,
        hitRate: requests24h.length > 0 ? hits24h.length / requests24h.length : 0,
        avgQueueTimeMs: hits24h.length > 0 
          ? hits24h.reduce((sum, h) => sum + h.queuedMs, 0) / hits24h.length 
          : 0,
        maxQueueTimeMs: hits24h.length > 0 
          ? Math.max(...hits24h.map(h => h.queuedMs)) 
          : 0,
        peakUsagePercent: peak?.percent || 0,
      },
      currentState: {
        secondUsagePercent: config ? (usage.currentWeightPerSecond / config.maxRequestsPerSecond) * 100 : 0,
        minuteUsagePercent: config ? (usage.currentWeightPerMinute / config.maxRequestsPerMinute) * 100 : 0,
        queueLength: usage.queuedRequests,
        estimatedWaitMs: usage.queuedRequests > 0 ? usage.queuedRequests * 100 : 0,
      },
    };
  }

  /**
   * Get analytics for all exchanges
   */
  getAllAnalytics(): Map<ExchangeType, RateLimitAnalytics> {
    const analytics = new Map<ExchangeType, RateLimitAnalytics>();
    
    for (const exchange of this.limits.keys()) {
      analytics.set(exchange, this.getAnalytics(exchange));
    }
    
    return analytics;
  }

  /**
   * Get a summary of rate limit hits for logging/diagnostics
   */
  getRateLimitSummary(): {
    totalHits1h: number;
    totalRequests1h: number;
    overallHitRate: number;
    byExchange: Record<string, { 
      requests: number; 
      hits: number; 
      hitRate: string; 
      avgQueueMs: number;
      topOperations: Array<{ operation: string; hits: number }>;
    }>;
    recentHits: Array<{ 
      time: string; 
      exchange: string; 
      operation: string; 
      queuedMs: number; 
    }>;
  } {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    
    const hits1h = this.hitEvents.filter(e => e.timestamp.getTime() > oneHourAgo);
    const requests1h = this.requestLog.filter(r => r.timestamp.getTime() > oneHourAgo);
    
    const byExchange: Record<string, { 
      requests: number; 
      hits: number; 
      hitRate: string; 
      avgQueueMs: number;
      topOperations: Array<{ operation: string; hits: number }>;
    }> = {};
    
    for (const exchange of this.limits.keys()) {
      const analytics = this.getAnalytics(exchange);
      
      // Get top operations by hit count
      const opHits = Object.entries(analytics.last1h.byOperation)
        .filter(([_, data]) => data.hits > 0)
        .map(([op, data]) => ({ operation: op, hits: data.hits }))
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 5);
      
      byExchange[exchange] = {
        requests: analytics.last1h.totalRequests,
        hits: analytics.last1h.rateLimitHits,
        hitRate: `${(analytics.last1h.hitRate * 100).toFixed(1)}%`,
        avgQueueMs: Math.round(analytics.last1h.avgQueueTimeMs),
        topOperations: opHits,
      };
    }
    
    // Get most recent hits
    const recentHits = hits1h
      .slice(-10)
      .reverse()
      .map(h => ({
        time: `${Math.round((now - h.timestamp.getTime()) / 1000)}s ago`,
        exchange: h.exchange,
        operation: h.operation,
        queuedMs: h.queuedMs,
      }));
    
    return {
      totalHits1h: hits1h.length,
      totalRequests1h: requests1h.length,
      overallHitRate: requests1h.length > 0 ? hits1h.length / requests1h.length : 0,
      byExchange,
      recentHits,
    };
  }

  /**
   * Clear analytics data (for testing)
   */
  clearAnalytics(): void {
    this.hitEvents.length = 0;
    this.requestLog.length = 0;
    this.peakUsage.clear();
    this.logger.log('Rate limit analytics cleared');
  }
}
