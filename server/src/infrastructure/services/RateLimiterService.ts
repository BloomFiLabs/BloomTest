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
 * Default rate limits for each exchange
 * Based on documented API limits and observed behavior
 * Limits are expressed in WEIGHT units per window
 */
const DEFAULT_LIMITS: RateLimitConfig[] = [
  {
    exchange: ExchangeType.LIGHTER,
    maxRequestsPerSecond: 12, // 2 tx/s (weight 6 each)
    maxRequestsPerMinute: 60, // Standard Account limit
  },
  {
    exchange: ExchangeType.HYPERLIQUID,
    maxRequestsPerSecond: 100, // Shared REST weight
    maxRequestsPerMinute: 1200, // Shared REST weight
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
   * @returns Promise that resolves when a slot is available
   */
  async acquire(
    exchange: ExchangeType,
    weight: number = 1,
    priority: RateLimitPriority = RateLimitPriority.NORMAL,
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

    // If we have capacity AND no one is waiting, proceed immediately
    if (withinSecondLimit && withinMinuteLimit && bucket.waitQueue.length === 0) {
      // We have capacity - record and proceed
      bucket.secondWindow.push({ timestamp: now, weight });
      bucket.minuteWindow.push({ timestamp: now, weight });
      return;
    }

    // We're at the limit or others are waiting - need to wait
    const waitTime = this.calculateWaitTime(bucket, config, now, weight, priority);

    if (priority >= RateLimitPriority.HIGH) {
      this.logger.debug(
        `Priority acquisition (${RateLimitPriority[priority]}) for ${exchange}, waiting ${waitTime}ms ` +
          `(${currentSecondWeight + weight}/${config.maxRequestsPerSecond}/s, ` +
          `${currentMinuteWeight + weight}/${config.maxRequestsPerMinute}/min, queue: ${bucket.waitQueue.length})`,
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
}
