import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';

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
interface RateBucket {
  // Sliding window for per-second limiting
  secondWindow: number[];
  // Sliding window for per-minute limiting
  minuteWindow: number[];
  // Queue for waiting requests
  waitQueue: Array<() => void>;
}

/**
 * Rate limiter usage statistics
 */
export interface RateLimiterUsage {
  currentRequestsPerSecond: number;
  currentRequestsPerMinute: number;
  maxRequestsPerSecond: number;
  maxRequestsPerMinute: number;
  queuedRequests: number;
}

/**
 * Default rate limits for each exchange
 * Based on documented API limits and observed behavior
 */
const DEFAULT_LIMITS: RateLimitConfig[] = [
  { 
    exchange: ExchangeType.LIGHTER, 
    maxRequestsPerSecond: 5,   // Conservative - Lighter has strict limits
    maxRequestsPerMinute: 100 
  },
  { 
    exchange: ExchangeType.HYPERLIQUID, 
    maxRequestsPerSecond: 10, 
    maxRequestsPerMinute: 200 
  },
  { 
    exchange: ExchangeType.ASTER, 
    maxRequestsPerSecond: 10, 
    maxRequestsPerMinute: 200 
  },
  { 
    exchange: ExchangeType.EXTENDED, 
    maxRequestsPerSecond: 10, 
    maxRequestsPerMinute: 200 
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
        `  ${exchange}: ${config.maxRequestsPerSecond}/s, ${config.maxRequestsPerMinute}/min`
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
        `RATE_LIMIT_${exchange}_PER_SECOND`
      );
      const perMinute = this.configService.get<number>(
        `RATE_LIMIT_${exchange}_PER_MINUTE`
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
   * @returns Promise that resolves when a slot is available
   */
  async acquire(exchange: ExchangeType): Promise<void> {
    const bucket = this.buckets.get(exchange);
    const config = this.limits.get(exchange);

    if (!bucket || !config) {
      // Unknown exchange - allow through
      return;
    }

    // Clean up old entries from sliding windows
    this.pruneWindows(bucket);

    const now = Date.now();

    // Check if we're at the limit
    const withinSecondLimit = bucket.secondWindow.length < config.maxRequestsPerSecond;
    const withinMinuteLimit = bucket.minuteWindow.length < config.maxRequestsPerMinute;

    if (withinSecondLimit && withinMinuteLimit) {
      // We have capacity - record and proceed
      bucket.secondWindow.push(now);
      bucket.minuteWindow.push(now);
      return;
    }

    // We're at the limit - need to wait
    const waitTime = this.calculateWaitTime(bucket, config, now);
    
    this.logger.debug(
      `Rate limit reached for ${exchange}, waiting ${waitTime}ms ` +
      `(${bucket.secondWindow.length}/${config.maxRequestsPerSecond}/s, ` +
      `${bucket.minuteWindow.length}/${config.maxRequestsPerMinute}/min)`
    );

    // Wait for the calculated time
    await new Promise<void>((resolve) => {
      bucket.waitQueue.push(resolve);
      setTimeout(() => {
        // Remove from queue and resolve
        const index = bucket.waitQueue.indexOf(resolve);
        if (index > -1) {
          bucket.waitQueue.splice(index, 1);
        }
        
        // Re-prune and record
        this.pruneWindows(bucket);
        bucket.secondWindow.push(Date.now());
        bucket.minuteWindow.push(Date.now());
        
        resolve();
      }, waitTime);
    });
  }

  /**
   * Try to acquire a rate limit slot without waiting
   * 
   * @param exchange - The exchange to try acquiring a slot for
   * @returns true if slot was acquired, false if rate limited
   */
  tryAcquire(exchange: ExchangeType): boolean {
    const bucket = this.buckets.get(exchange);
    const config = this.limits.get(exchange);

    if (!bucket || !config) {
      return true;
    }

    this.pruneWindows(bucket);

    const withinSecondLimit = bucket.secondWindow.length < config.maxRequestsPerSecond;
    const withinMinuteLimit = bucket.minuteWindow.length < config.maxRequestsPerMinute;

    if (withinSecondLimit && withinMinuteLimit) {
      const now = Date.now();
      bucket.secondWindow.push(now);
      bucket.minuteWindow.push(now);
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
        currentRequestsPerSecond: 0,
        currentRequestsPerMinute: 0,
        maxRequestsPerSecond: 0,
        maxRequestsPerMinute: 0,
        queuedRequests: 0,
      };
    }

    this.pruneWindows(bucket);

    return {
      currentRequestsPerSecond: bucket.secondWindow.length,
      currentRequestsPerMinute: bucket.minuteWindow.length,
      maxRequestsPerSecond: config.maxRequestsPerSecond,
      maxRequestsPerMinute: config.maxRequestsPerMinute,
      queuedRequests: bucket.waitQueue.length,
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
        `${this.limits.get(exchange)?.maxRequestsPerMinute}/min`
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
      bucket.waitQueue.forEach(resolve => resolve());
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
   * Calculate how long to wait before the next request can be made
   */
  private calculateWaitTime(
    bucket: RateBucket,
    config: RateLimitConfig,
    now: number,
  ): number {
    // Calculate wait time based on which limit is hit
    let waitTime = 0;

    // Check per-second limit
    if (bucket.secondWindow.length >= config.maxRequestsPerSecond) {
      const oldestInSecond = bucket.secondWindow[0];
      const secondWaitTime = 1000 - (now - oldestInSecond);
      waitTime = Math.max(waitTime, secondWaitTime);
    }

    // Check per-minute limit
    if (bucket.minuteWindow.length >= config.maxRequestsPerMinute) {
      const oldestInMinute = bucket.minuteWindow[0];
      const minuteWaitTime = 60000 - (now - oldestInMinute);
      waitTime = Math.max(waitTime, minuteWaitTime);
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

    bucket.secondWindow = bucket.secondWindow.filter(t => t > oneSecondAgo);
    bucket.minuteWindow = bucket.minuteWindow.filter(t => t > oneMinuteAgo);
  }
}


