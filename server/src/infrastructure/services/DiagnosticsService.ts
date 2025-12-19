import {
  Injectable,
  Logger,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import type {
  CircuitBreakerService,
  CircuitState,
} from './CircuitBreakerService';
import type { RateLimiterService } from './RateLimiterService';
import type { PositionStateRepository } from '../repositories/PositionStateRepository';

/**
 * Error context snapshot - captures full state at time of error
 */
export interface ErrorContextSnapshot {
  // Order details if applicable
  order?: {
    symbol: string;
    exchange: ExchangeType;
    side: 'LONG' | 'SHORT';
    size: number;
    price: number;
    orderType: string;
    // Market context at time of order
    marketPrice?: number;
    bestBid?: number;
    bestAsk?: number;
    spread?: number;
    deviationFromMidBps?: number;
  };
  // Position state
  positions?: Array<{
    symbol: string;
    exchange: ExchangeType;
    side: string;
    size: number;
    marginMode?: string;
    margin?: number;
  }>;
  // Exchange-specific state
  exchangeState?: {
    nonce?: number;
    expectedNonce?: number;
    balance?: number;
    marginMode?: string;
    openOrderCount?: number;
    rateLimitRemaining?: number;
  };
  // Execution context
  execution?: {
    threadId?: string;
    operation?: string;
    globalLockHeld?: boolean;
    globalLockDurationMs?: number;
    symbolLockHeld?: boolean;
    timeSinceLastOrderMs?: number;
  };
  // Market specs
  marketSpecs?: {
    minOrderSize?: number;
    tickSize?: number;
    stepSize?: number;
    maxLeverage?: number;
  };
  // Raw request/response for debugging
  rawRequest?: string;
  rawResponse?: string;
}

/**
 * Error event for tracking - enhanced with context snapshot
 */
export interface ErrorEvent {
  type: string;
  message: string;
  exchange?: ExchangeType;
  symbol?: string;
  timestamp: Date;
  context?: Record<string, any>;
  // NEW: Full context snapshot at time of error
  snapshot?: ErrorContextSnapshot;
}

/**
 * Single-leg failure event for tracking patterns
 */
export interface SingleLegFailureEvent {
  id: string;
  symbol: string;
  timestamp: Date;
  // Which leg failed?
  failedLeg: 'long' | 'short';
  failedExchange: ExchangeType;
  successfulExchange: ExchangeType;
  // Why did it fail?
  failureReason:
    | 'price_moved'
    | 'order_rejected'
    | 'timeout'
    | 'size_mismatch'
    | 'exchange_error'
    | 'unknown';
  failureMessage?: string;
  // Timing
  timeBetweenLegsMs: number;
  // Price context
  longPrice?: number;
  shortPrice?: number;
  priceSlippageBps?: number;
  // Order details
  attemptedSize?: number;
  filledSize?: number;
}

/**
 * Lighter exchange state snapshot
 */
export interface LighterStateSnapshot {
  timestamp: Date;
  nonce: {
    current: number;
    expected: number;
    lastSync: Date;
    pendingIncrements: number;
  };
  positions: Array<{
    symbol: string;
    marginMode: 'cross' | 'isolated';
    size: number;
    margin: number;
    leverage: number;
  }>;
  balances: {
    total: number;
    available: number;
    marginUsed: number;
  };
  openOrders: number;
}

/**
 * Unfilled order analysis
 */
export interface UnfilledOrderInfo {
  orderId: string;
  symbol: string;
  exchange: ExchangeType;
  side: 'LONG' | 'SHORT';
  orderPrice: number;
  marketPrice: number;
  deviationBps: number;
  ageSeconds: number;
  size: number;
  filledSize: number;
  bookDepthAtPrice?: number;
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
  missingExchange?: ExchangeType; // The exchange that failed to fill
  reason?: string; // Reason for the single leg
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
  errors: Map<
    string,
    { count: number; lastMessage: string; lastTimestamp: Date }
  >;
  singleLegs: {
    started: number;
    resolved: number;
    resolutionTimesMin: number[]; // For avg calculation (capped at 50 samples)
  };
  liquidityFilters: Map<string, number>; // reason -> count
  connections: Map<
    ExchangeType,
    { reconnects: number; errors: number; lastError?: string }
  >;
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
  reason?: string;
  missingExchange?: ExchangeType;
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
    last1h: {
      placed: number;
      filled: number;
      failed: number;
      fillRate: number;
    };
    last24h: {
      placed: number;
      filled: number;
      failed: number;
      fillRate: number;
    };
    avgFillTimeMs: { p50: number; p95: number; p99: number };
  };
  singleLegs: {
    active: ActiveSingleLeg[];
    stats: { 
      last1h: number; 
      last24h: number; 
      avgResolutionMin: number;
      singleLegRate1h: number;
      singleLegRate24h: number;
      singleLegTimePercent24h: number;
    };
    // NEW: Failure analysis
    failureAnalysis?: {
      byLeg: { long: number; short: number };
      byExchange: Record<string, number>;
      byReason: Record<string, number>;
      avgTimeBetweenLegsMs: number;
      avgPriceSlippageBps: number;
      recentFailures: Array<{
        symbol: string;
        failedLeg: string;
        failedExchange: string;
        reason: string;
        message?: string;
        timeAgo: string;
      }>;
    };
  };
  errors: {
    total: { last1h: number; last24h: number };
    byType: Record<string, { count: number; last: string }>;
    recent: Array<{
      time: string;
      type: string;
      exchange?: string;
      msg: string;
    }>;
    // NEW: Recent errors with full context snapshots
    recentWithContext: Array<{
      time: string;
      type: string;
      exchange?: string;
      msg: string;
      snapshot?: ErrorContextSnapshot;
    }>;
  };
  positions: {
    count: number;
    totalValue: number;
    unrealizedPnl: number;
    byExchange: Record<string, number>;
    breakEvenInfo?: Array<{
      symbol: string;
      exchange: string;
      openedAt: string;
      estimatedBreakEvenHours: number;
      hoursElapsed: number;
      hoursRemaining: number;
      status: 'earning' | 'not_yet_profitable' | 'overdue';
      progressPercent: number;
    }>;
  };
  liquidity: {
    pairsFiltered: { last24h: number; reasons: Record<string, number> };
  };
  connectionStatus: Record<
    string,
    { status: string; reconnects24h: number; lastError?: string }
  >;
  rewards: {
    accruedProfits: number;
    lastHarvestTime: Date | null;
    lastHarvestAmount: number;
    nextHarvestIn: string;
    totalHarvested: number;
  };
  circuitBreaker?: {
    state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    errorsThisHour: number;
    threshold: number;
    cooldownRemainingMs: number | null;
  };
  rateLimiter?: {
    byExchange: Record<
      string,
      {
      currentPerSecond: number; 
      maxPerSecond: number;
      currentPerMinute: number;
      maxPerMinute: number;
      queued: number;
      }
    >;
  };
  positionState?: {
    persisted: number;
    singleLeg: number;
    pending: number;
    complete: number;
  };
  executionAnalytics?: {
    last1h: {
      totalOrders: number;
      successfulOrders: number;
      failedOrders: number;
      fillRate: number;
      avgSlippageBps: number;
      avgFillTimeMs: number;
      p50FillTimeMs: number;
      p95FillTimeMs: number;
      avgAttempts: number;
      partialFillRate: number;
    };
    last24h: {
      totalOrders: number;
      successfulOrders: number;
      failedOrders: number;
      fillRate: number;
      avgSlippageBps: number;
      avgFillTimeMs: number;
      p50FillTimeMs: number;
      p95FillTimeMs: number;
      avgAttempts: number;
      partialFillRate: number;
    };
    byExchange: Record<
      string,
      {
      orders: number;
      fillRate: number;
      avgSlippageBps: number;
      avgFillTimeMs: number;
      }
    >;
  };

  // ==================== NEW DIAGNOSTIC SECTIONS ====================

  /** Lighter exchange specific state */
  lighterState?: {
    nonce: {
      current: number;
      expected: number;
      lastSync: string;
      syncStatus: 'OK' | 'STALE' | 'MISMATCH';
    };
    positions: Array<{
      symbol: string;
      marginMode: string;
      size: number;
      margin: number;
    }>;
    balance: {
      total: number;
      available: number;
      marginUsed: number;
    };
    recentErrors: Array<{
      type: string;
      message: string;
      timeAgo: string;
      context?: string;
    }>;
  };

  /** Unfilled/stale orders analysis */
  staleOrders?: {
    count: number;
    totalValue: number;
    byExchange: Record<string, number>;
    orders: Array<{
      orderId: string;
      symbol: string;
      exchange: string;
      side: string;
      price: number;
      size: number;
      marketPrice: number;
      deviationBps: number;
      ageMinutes: number;
    }>;
    recommendation: string;
  };

  /** Execution lock diagnostics */
  executionLocks?: {
    globalLock: {
      held: boolean;
      holder?: string;
      durationMs?: number;
      currentOperation?: string;
      isStale: boolean;
      warning?: string;
    };
    symbolLocks: Array<{
      symbol: string;
      holder: string;
      durationMs: number;
    }>;
    activeOrders: Array<{
      orderId: string;
      symbol: string;
      exchange: string;
      side: string;
      ageMs: number;
    }>;
    recentOrderHistory: Array<{
      orderId: string;
      symbol: string;
      exchange: string;
      side: string;
      threadId: string;
      placedAt: string;
      status: string;
      size?: number;
      price?: number;
    }>;
    blockedOperationsCount: number;
  };

  /** Capital utilization */
  capital?: {
    byExchange: Record<
      string,
      {
      total: number;
      available: number;
      marginUsed: number;
      inOrders: number;
      utilizationPercent: number;
      }
    >;
    summary: {
      totalCapital: number;
      deployed: number;
      idle: number;
      idlePercent: number;
    };
  };

  /** Current operation status */
  currentOperation?: {
    description: string;
    startedAt: string;
    durationMs: number;
    stage: string;
    symbol?: string;
    exchanges?: string[];
  };

  /** Prediction system diagnostics */
  predictions?: {
    enabled: boolean;
    accuracy?: {
      last24h: {
        predictions: number;
        directionallyCorrect: number;
        accuracyPercent: number;
        avgErrorBps: number;
      };
    };
    currentPredictions?: Array<{
      symbol: string;
      predictedSpread: number;
      confidence: number;
      regime: string;
      recommendation: string;
      predictedBreakEvenHours: number;
    }>;
    cacheStats?: {
      size: number;
      hitRate: number;
    };
  };

  /** Market quality filter diagnostics */
  marketQuality?: {
    blacklistedCount: number;
    blacklistedMarkets: Array<{
      symbol: string;
      exchange?: string;
      reason: string;
      expiresIn?: string;
    }>;
    recentFailures: Array<{
      symbol: string;
      exchange: string;
      type: string;
      message: string;
      timeAgo: string;
    }>;
    marketStats: Array<{
      symbol: string;
      exchange: string;
      failures1h: number;
      failures24h: number;
      failureRate: string;
      status: 'healthy' | 'degraded' | 'blacklisted';
    }>;
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
    // Break-even tracking per position
    breakEvenInfo?: Array<{
      symbol: string;
      openedAt: Date;
      estimatedBreakEvenHours: number;
      hoursRemaining: number;
      status: 'earning' | 'not_yet_profitable' | 'overdue';
    }>;
  } = { count: 0, totalValue: 0, unrealizedPnl: 0, byExchange: {} };

  // Break-even tracking per active position (keyed by symbol-exchange)
  private positionBreakEvenMap: Map<
    string,
    {
      symbol: string;
      exchange: string;
      openedAt: Date;
      estimatedBreakEvenHours: number;
      estimatedCosts: number;
      expectedHourlyReturn: number;
    }
  > = new Map();
  
  // Position time tracking for single-leg percentage calculation
  // Tracks cumulative time spent in positions (both full and single-leg)
  private totalPositionTimeMs: number = 0;
  private lastPositionCheckTime: Date | null = null;
  private lastPositionCount: number = 0;

  // Injected services for enhanced diagnostics
  private circuitBreaker?: CircuitBreakerService;
  private rateLimiter?: RateLimiterService;
  private positionStateRepo?: PositionStateRepository;
  private executionAnalytics?: any; // ExecutionAnalytics type from OrderExecutor

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

  // ==================== NEW: Enhanced tracking data ====================

  // Recent errors with full context snapshots (ring buffer, last 50)
  private readonly MAX_ERRORS_WITH_CONTEXT = 50;
  private readonly errorsWithContext: ErrorEvent[] = [];

  // Single-leg failure tracking (ring buffer, last 100)
  private readonly MAX_SINGLE_LEG_FAILURES = 100;
  private readonly singleLegFailures: SingleLegFailureEvent[] = [];

  // Lighter state snapshot (updated on each operation)
  private lighterState: LighterStateSnapshot | null = null;

  // Unfilled orders tracking
  private unfilledOrders: Map<string, UnfilledOrderInfo> = new Map();

  // Current operation tracking (what is the system doing right now?)
  private currentOperation: {
    description: string;
    startedAt: Date;
    stage: string;
    symbol?: string;
    exchanges?: ExchangeType[];
  } | null = null;

  // Global lock tracking (separate from ExecutionLockService for diagnostics)
  private globalLockInfo: {
    held: boolean;
    holder?: string;
    startedAt?: Date;
    currentOperation?: string;
  } = { held: false };

  // Blocked operations counter
  private blockedOperationsCount = 0;

  // Capital data (set externally)
  private capitalData: {
    byExchange: Map<
      ExchangeType,
      {
      total: number;
      available: number;
      marginUsed: number;
      inOrders: number;
      }
    >;
  } = { byExchange: new Map() };

  // Prediction service reference
  private predictionService?: any;

  // Market quality filter reference
  private marketQualityFilter?: any;

  constructor() {
    this.logger.log('DiagnosticsService initialized with enhanced tracking');
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

    // Also store in errors with context if snapshot provided
    if (event.snapshot) {
      this.errorsWithContext.push(event);
      if (this.errorsWithContext.length > this.MAX_ERRORS_WITH_CONTEXT) {
        this.errorsWithContext.shift();
      }
    }
  }

  /**
   * Record an error with full context snapshot
   * Use this for critical errors where we need full debugging context
   */
  recordErrorWithContext(
    type: string,
    message: string,
    snapshot: ErrorContextSnapshot,
    exchange?: ExchangeType,
    symbol?: string,
  ): void {
    const event: ErrorEvent = {
      type,
      message,
      exchange,
      symbol,
      timestamp: new Date(),
      snapshot,
    };
    this.recordError(event);
    
    this.logger.debug(
      `Recorded error with context: ${type} - ${message} ` +
      `(snapshot: ${JSON.stringify(snapshot).substring(0, 200)}...)`,
    );
  }

  /**
   * Create an error context snapshot from current state
   * Call this when an error occurs to capture full debugging context
   */
  createErrorSnapshot(
    orderDetails?: ErrorContextSnapshot['order'],
    exchangeState?: ErrorContextSnapshot['exchangeState'],
    additionalContext?: Partial<ErrorContextSnapshot>,
  ): ErrorContextSnapshot {
    const snapshot: ErrorContextSnapshot = {
      ...additionalContext,
    };

    // Add order details if provided
    if (orderDetails) {
      snapshot.order = orderDetails;
    }

    // Add exchange state if provided
    if (exchangeState) {
      snapshot.exchangeState = exchangeState;
    }

    // Add current execution context
    snapshot.execution = {
      globalLockHeld: this.globalLockInfo.held,
      globalLockDurationMs: this.globalLockInfo.startedAt
        ? Date.now() - this.globalLockInfo.startedAt.getTime()
        : undefined,
      operation: this.currentOperation?.description,
      threadId: this.globalLockInfo.holder,
    };

    // Add positions from our tracked data
    if (this.positionData.count > 0) {
      // Note: Full position details would need to be passed in
      snapshot.positions = [];
    }

    return snapshot;
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

    const reasonStr = event.reason ? ` (Reason: ${event.reason})` : '';
    const missingStr = event.missingExchange ? ` (Missing: ${event.missingExchange})` : '';
    this.logger.warn(`🚨 Single-leg detected for ${event.symbol} on ${event.exchange}${reasonStr}${missingStr}`);
  }

  /**
   * Record resolution of a single-leg position
   */
  recordSingleLegResolved(
    id: string,
    resolution: 'FILLED' | 'CLOSED' | 'TIMEOUT',
  ): void {
    const singleLeg = this.activeSingleLegs.get(id);
    if (!singleLeg) return;
    
    singleLeg.resolvedAt = new Date();
    singleLeg.resolution = resolution;
    
    const bucket = this.getOrCreateCurrentBucket();
    bucket.singleLegs.resolved++;
    
    // Calculate resolution time in minutes
    const resolutionTimeMin =
      (singleLeg.resolvedAt.getTime() - singleLeg.startedAt.getTime()) / 60000;
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
   * Record a single-leg failure event with analysis
   * Call this when one leg of a trade fails to fill
   */
  recordSingleLegFailure(event: SingleLegFailureEvent): void {
    this.singleLegFailures.push(event);
    if (this.singleLegFailures.length > this.MAX_SINGLE_LEG_FAILURES) {
      this.singleLegFailures.shift();
    }

    const msgStr = event.failureMessage ? ` - ${event.failureMessage}` : '';
    this.logger.warn(
      `🚨 Single-leg failure recorded: ${event.symbol} ` +
      `${event.failedLeg} leg failed on ${event.failedExchange} (Success: ${event.successfulExchange}) ` +
      `[Reason: ${event.failureReason}${msgStr}]`
    );
  }

  /**
   * Get single-leg failure analysis for diagnostics
   */
  private getSingleLegFailureAnalysis(): DiagnosticsResponse['singleLegs']['failureAnalysis'] {
    if (this.singleLegFailures.length === 0) {
      return undefined;
    }

    const now = Date.now();
    const last24h = this.singleLegFailures.filter(
      (f) => now - f.timestamp.getTime() < 24 * 60 * 60 * 1000,
    );

    // Count by leg
    const byLeg = { long: 0, short: 0 };
    for (const f of last24h) {
      byLeg[f.failedLeg]++;
    }

    // Count by exchange
    const byExchange: Record<string, number> = {};
    for (const f of last24h) {
      byExchange[f.failedExchange] = (byExchange[f.failedExchange] || 0) + 1;
    }

    // Count by reason
    const byReason: Record<string, number> = {};
    for (const f of last24h) {
      byReason[f.failureReason] = (byReason[f.failureReason] || 0) + 1;
    }

    // Calculate averages
    const timeBetween = last24h
      .map((f) => f.timeBetweenLegsMs)
      .filter((t) => t > 0);
    const avgTimeBetweenLegsMs =
      timeBetween.length > 0
        ? Math.round(
            timeBetween.reduce((a, b) => a + b, 0) / timeBetween.length,
          )
      : 0;

    const slippages = last24h
      .map((f) => f.priceSlippageBps)
      .filter((s): s is number => s !== undefined);
    const avgPriceSlippageBps =
      slippages.length > 0
        ? Math.round(
            (slippages.reduce((a, b) => a + b, 0) / slippages.length) * 10,
          ) / 10
      : 0;

    // Recent failures
    const recentFailures = last24h
      .slice(-10)
      .reverse()
      .map((f) => {
      const minutesAgo = Math.round((now - f.timestamp.getTime()) / 60000);
      return {
        symbol: f.symbol,
        failedLeg: f.failedLeg,
        failedExchange: f.failedExchange,
        reason: f.failureReason,
        message: f.failureMessage,
          timeAgo:
            minutesAgo < 60
              ? `${minutesAgo}min ago`
              : `${Math.round(minutesAgo / 60)}h ago`,
      };
    });

    return {
      byLeg,
      byExchange,
      byReason,
      avgTimeBetweenLegsMs,
      avgPriceSlippageBps,
      recentFailures,
    };
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
  updateApyData(data: {
    estimated: number;
    realized: number;
    byExchange: Record<string, number>;
  }): void {
    this.apyData = data;
  }

  /**
   * Record break-even info when a position is opened
   */
  recordPositionBreakEven(
    symbol: string,
    exchange: string,
    estimatedBreakEvenHours: number,
    estimatedCosts: number,
    expectedHourlyReturn: number,
  ): void {
    const key = `${symbol}-${exchange}`;
    this.positionBreakEvenMap.set(key, {
      symbol,
      exchange,
      openedAt: new Date(),
      estimatedBreakEvenHours,
      estimatedCosts,
      expectedHourlyReturn,
    });
    this.logger.debug(
      `Recorded break-even for ${symbol} on ${exchange}: ${estimatedBreakEvenHours.toFixed(1)}h`,
    );
  }

  /**
   * Remove break-even tracking when position is closed
   */
  removePositionBreakEven(symbol: string, exchange: string): void {
    const key = `${symbol}-${exchange}`;
    this.positionBreakEvenMap.delete(key);
  }

  /**
   * Update position data (called by PerformanceLogger or Orchestrator)
   * Also tracks cumulative time spent in positions for single-leg % calculation
   */
  updatePositionData(data: {
    count: number;
    totalValue: number;
    unrealizedPnl: number;
    byExchange: Record<string, number>;
  }): void {
    const now = new Date();
    
    // Track time spent in positions
    if (this.lastPositionCheckTime && this.lastPositionCount > 0) {
      // We had positions since last check - accumulate that time
      const elapsedMs = now.getTime() - this.lastPositionCheckTime.getTime();
      this.totalPositionTimeMs += elapsedMs;
    }
    
    // Update tracking state
    this.lastPositionCheckTime = now;
    this.lastPositionCount = data.count;
    
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

  /**
   * Set execution analytics reference for diagnostics
   */
  setExecutionAnalytics(analytics: any): void {
    this.executionAnalytics = analytics;
  }

  /**
   * Set prediction service reference for diagnostics
   */
  setPredictionService(service: any): void {
    this.predictionService = service;
  }

  /**
   * Set market quality filter reference for diagnostics
   */
  setMarketQualityFilter(filter: any): void {
    this.marketQualityFilter = filter;
  }

  // ==================== NEW: Lighter State Tracking ====================

  /**
   * Update Lighter exchange state snapshot
   * Call this after every Lighter operation to track state
   */
  updateLighterState(state: LighterStateSnapshot): void {
    this.lighterState = state;
    this.logger.debug(
      `Lighter state updated: nonce=${state.nonce.current}/${state.nonce.expected}, ` +
      `positions=${state.positions.length}, balance=$${state.balances.available.toFixed(2)}`,
    );
  }

  /**
   * Update just the Lighter nonce info
   */
  updateLighterNonce(
    current: number,
    expected: number,
    pendingIncrements: number = 0,
  ): void {
    if (!this.lighterState) {
      this.lighterState = {
        timestamp: new Date(),
        nonce: { current, expected, lastSync: new Date(), pendingIncrements },
        positions: [],
        balances: { total: 0, available: 0, marginUsed: 0 },
        openOrders: 0,
      };
    } else {
      this.lighterState.nonce = {
        current,
        expected,
        lastSync: new Date(),
        pendingIncrements,
      };
      this.lighterState.timestamp = new Date();
    }
  }

  /**
   * Get Lighter diagnostics for response
   */
  private getLighterDiagnostics(): DiagnosticsResponse['lighterState'] {
    if (!this.lighterState) {
      return undefined;
    }

    const now = Date.now();
    const lastSyncAgeMs = now - this.lighterState.nonce.lastSync.getTime();
    
    // Determine nonce sync status
    let syncStatus: 'OK' | 'STALE' | 'MISMATCH' = 'OK';
    if (this.lighterState.nonce.current !== this.lighterState.nonce.expected) {
      syncStatus = 'MISMATCH';
    } else if (lastSyncAgeMs > 5 * 60 * 1000) {
      // > 5 minutes
      syncStatus = 'STALE';
    }

    // Get recent Lighter-specific errors
    const lighterErrors = this.errorsWithContext
      .filter((e) => e.exchange === ExchangeType.LIGHTER)
      .slice(-5)
      .reverse()
      .map((e) => {
        const minutesAgo = Math.round((now - e.timestamp.getTime()) / 60000);
        return {
          type: e.type,
          message: e.message,
          timeAgo:
            minutesAgo < 60
              ? `${minutesAgo}min ago`
              : `${Math.round(minutesAgo / 60)}h ago`,
          context: e.snapshot?.exchangeState
            ? `nonce=${e.snapshot.exchangeState.nonce}, mode=${e.snapshot.exchangeState.marginMode}`
            : undefined,
        };
      });

    return {
      nonce: {
        current: this.lighterState.nonce.current,
        expected: this.lighterState.nonce.expected,
        lastSync: this.formatTimeAgo(this.lighterState.nonce.lastSync),
        syncStatus,
      },
      positions: this.lighterState.positions.map((p) => ({
        symbol: p.symbol,
        marginMode: p.marginMode,
        size: p.size,
        margin: p.margin,
      })),
      balance: this.lighterState.balances,
      recentErrors: lighterErrors,
    };
  }

  // ==================== NEW: Unfilled Orders Tracking ====================

  /**
   * Record an unfilled order for tracking
   */
  recordUnfilledOrder(order: UnfilledOrderInfo): void {
    this.unfilledOrders.set(order.orderId, order);
  }

  /**
   * Update an unfilled order (e.g., update market price deviation)
   */
  updateUnfilledOrder(
    orderId: string,
    updates: Partial<UnfilledOrderInfo>,
  ): void {
    const existing = this.unfilledOrders.get(orderId);
    if (existing) {
      Object.assign(existing, updates);
    }
  }

  /**
   * Remove an order from unfilled tracking (filled or cancelled)
   */
  removeUnfilledOrder(orderId: string): void {
    this.unfilledOrders.delete(orderId);
  }

  /**
   * Clear all unfilled orders for an exchange (e.g., after cancel all)
   */
  clearUnfilledOrders(exchange?: ExchangeType): void {
    if (exchange) {
      for (const [id, order] of this.unfilledOrders) {
        if (order.exchange === exchange) {
          this.unfilledOrders.delete(id);
        }
      }
    } else {
      this.unfilledOrders.clear();
    }
  }

  /**
   * Get stale orders diagnostics
   */
  private getStaleOrdersDiagnostics(): DiagnosticsResponse['staleOrders'] {
    if (this.unfilledOrders.size === 0) {
      return undefined;
    }

    const now = Date.now();
    const orders = Array.from(this.unfilledOrders.values());
    
    // Count by exchange
    const byExchange: Record<string, number> = {};
    let totalValue = 0;
    
    const orderDetails = orders
      .map((o) => {
      byExchange[o.exchange] = (byExchange[o.exchange] || 0) + 1;
      totalValue += o.size * o.orderPrice;
      
      return {
          orderId:
            o.orderId.substring(0, 20) + (o.orderId.length > 20 ? '...' : ''),
        symbol: o.symbol,
        exchange: o.exchange,
        side: o.side,
        price: o.orderPrice,
        size: o.size,
        marketPrice: o.marketPrice,
        deviationBps: Math.round(o.deviationBps * 10) / 10,
        ageMinutes: Math.round(o.ageSeconds / 60),
      };
      })
      .sort((a, b) => b.ageMinutes - a.ageMinutes);

    // Generate recommendation
    let recommendation = '';
    const staleCount = orders.filter((o) => o.ageSeconds > 300).length; // > 5 min
    const farFromMarket = orders.filter(
      (o) => Math.abs(o.deviationBps) > 50,
    ).length;
    
    if (staleCount > 0) {
      recommendation += `${staleCount} orders older than 5 minutes. `;
    }
    if (farFromMarket > 0) {
      recommendation += `${farFromMarket} orders >50bps from market. `;
    }
    if (orders.length > 5) {
      recommendation += `Consider cancelling stale orders to free capital. `;
    }
    if (!recommendation) {
      recommendation = 'Orders look healthy';
    }

    return {
      count: orders.length,
      totalValue: Math.round(totalValue * 100) / 100,
      byExchange,
      orders: orderDetails.slice(0, 20), // Limit to 20 for response size
      recommendation: recommendation.trim(),
    };
  }

  // ==================== NEW: Current Operation Tracking ====================

  /**
   * Set current operation (what is the system doing now?)
   */
  setCurrentOperation(
    description: string,
    stage: string,
    symbol?: string,
    exchanges?: ExchangeType[],
  ): void {
    this.currentOperation = {
      description,
      startedAt: new Date(),
      stage,
      symbol,
      exchanges,
    };
  }

  /**
   * Update current operation stage
   */
  updateOperationStage(stage: string): void {
    if (this.currentOperation) {
      this.currentOperation.stage = stage;
    }
  }

  /**
   * Clear current operation (completed)
   */
  clearCurrentOperation(): void {
    this.currentOperation = null;
  }

  /**
   * Get current operation diagnostics
   */
  private getCurrentOperationDiagnostics(): DiagnosticsResponse['currentOperation'] {
    if (!this.currentOperation) {
      return undefined;
    }

    return {
      description: this.currentOperation.description,
      startedAt: this.currentOperation.startedAt.toISOString(),
      durationMs: Date.now() - this.currentOperation.startedAt.getTime(),
      stage: this.currentOperation.stage,
      symbol: this.currentOperation.symbol,
      exchanges: this.currentOperation.exchanges,
    };
  }

  // ==================== NEW: Global Lock Tracking ====================

  /**
   * Record global lock acquisition
   */
  recordGlobalLockAcquired(holder: string, operation?: string): void {
    this.globalLockInfo = {
      held: true,
      holder,
      startedAt: new Date(),
      currentOperation: operation,
    };
  }

  /**
   * Record global lock release
   */
  recordGlobalLockReleased(): void {
    this.globalLockInfo = { held: false };
  }

  /**
   * Update global lock operation
   */
  updateGlobalLockOperation(operation: string): void {
    if (this.globalLockInfo.held) {
      this.globalLockInfo.currentOperation = operation;
    }
  }

  /**
   * Record a blocked operation (something waiting for lock)
   */
  recordBlockedOperation(): void {
    this.blockedOperationsCount++;
  }

  /**
   * Reset blocked operations counter
   */
  resetBlockedOperationsCount(): void {
    this.blockedOperationsCount = 0;
  }

  // ==================== NEW: Capital Tracking ====================

  /**
   * Update capital data for an exchange
   */
  updateCapitalData(
    exchange: ExchangeType,
    data: {
      total: number;
      available: number;
      marginUsed: number;
      inOrders: number;
    },
  ): void {
    this.capitalData.byExchange.set(exchange, data);
  }

  /**
   * Get capital diagnostics
   */
  private getCapitalDiagnostics(): DiagnosticsResponse['capital'] {
    if (this.capitalData.byExchange.size === 0) {
      return undefined;
    }

    const byExchange: Record<
      string,
      {
      total: number;
      available: number;
      marginUsed: number;
      inOrders: number;
      utilizationPercent: number;
      }
    > = {};

    let totalCapital = 0;
    let totalDeployed = 0;

    for (const [exchange, data] of this.capitalData.byExchange) {
      const utilization =
        data.total > 0
        ? Math.round((data.marginUsed / data.total) * 1000) / 10
        : 0;
      
      byExchange[exchange] = {
        ...data,
        utilizationPercent: utilization,
      };

      totalCapital += data.total;
      totalDeployed += data.marginUsed + data.inOrders;
    }

    const idle = totalCapital - totalDeployed;

    return {
      byExchange,
      summary: {
        totalCapital: Math.round(totalCapital * 100) / 100,
        deployed: Math.round(totalDeployed * 100) / 100,
        idle: Math.round(idle * 100) / 100,
        idlePercent:
          totalCapital > 0 ? Math.round((idle / totalCapital) * 1000) / 10 : 0,
      },
    };
  }

  // ==================== Break-Even Info ====================

  /**
   * Get break-even info for all active positions
   */
  private getBreakEvenInfo(): Array<{
    symbol: string;
    exchange: string;
    openedAt: string;
    estimatedBreakEvenHours: number;
    hoursElapsed: number;
    hoursRemaining: number;
    status: 'earning' | 'not_yet_profitable' | 'overdue';
    progressPercent: number;
  }> {
    const now = Date.now();
    const info: Array<{
      symbol: string;
      exchange: string;
      openedAt: string;
      estimatedBreakEvenHours: number;
      hoursElapsed: number;
      hoursRemaining: number;
      status: 'earning' | 'not_yet_profitable' | 'overdue';
      progressPercent: number;
    }> = [];

    for (const [, data] of this.positionBreakEvenMap) {
      const hoursElapsed =
        (now - data.openedAt.getTime()) / (1000 * 60 * 60);
      const hoursRemaining = Math.max(
        0,
        data.estimatedBreakEvenHours - hoursElapsed,
      );

      let status: 'earning' | 'not_yet_profitable' | 'overdue';
      if (hoursElapsed >= data.estimatedBreakEvenHours) {
        status = 'earning';
      } else if (hoursElapsed < data.estimatedBreakEvenHours * 2) {
        status = 'not_yet_profitable';
      } else {
        status = 'overdue';
      }

      const progressPercent =
        data.estimatedBreakEvenHours > 0
          ? Math.min(100, (hoursElapsed / data.estimatedBreakEvenHours) * 100)
          : 100;

      info.push({
        symbol: data.symbol,
        exchange: data.exchange,
        openedAt: this.formatTimeAgo(data.openedAt),
        estimatedBreakEvenHours:
          Math.round(data.estimatedBreakEvenHours * 10) / 10,
        hoursElapsed: Math.round(hoursElapsed * 10) / 10,
        hoursRemaining: Math.round(hoursRemaining * 10) / 10,
        status,
        progressPercent: Math.round(progressPercent),
      });
    }

    return info.sort((a, b) => a.hoursRemaining - b.hoursRemaining);
  }

  // ==================== NEW: Prediction Diagnostics ====================

  /**
   * Get prediction system diagnostics
   */
  private getPredictionDiagnostics(): DiagnosticsResponse['predictions'] {
    if (!this.predictionService) {
      return { enabled: false };
    }

    try {
      // Try to get prediction stats if available
      const stats = this.predictionService.getAccuracyStats?.();
      const currentPredictions =
        this.predictionService.getCurrentPredictions?.();

      return {
        enabled: true,
        accuracy: stats
          ? {
          last24h: {
            predictions: stats.total || 0,
            directionallyCorrect: stats.correct || 0,
            accuracyPercent: stats.accuracy || 0,
            avgErrorBps: stats.avgError || 0,
          },
            }
          : undefined,
        currentPredictions: currentPredictions?.slice(0, 10),
        cacheStats: this.predictionService.getCacheStats?.(),
      };
    } catch {
      return { enabled: true };
    }
  }

  // ==================== Helper Methods ====================

  /**
   * Format a date as "Xmin ago" or "Xh ago"
   */
  private formatTimeAgo(date: Date): string {
    const minutesAgo = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutesAgo < 60) {
      return `${minutesAgo}min ago`;
    }
    return `${Math.round(minutesAgo / 60)}h ago`;
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
          fillRate:
            stats1h.orders.placed > 0
              ? Math.round(
                  (stats1h.orders.filled / stats1h.orders.placed) * 1000,
                ) / 10
            : 100,
        },
        last24h: {
          placed: stats24h.orders.placed,
          filled: stats24h.orders.filled,
          failed: stats24h.orders.failed,
          fillRate:
            stats24h.orders.placed > 0
              ? Math.round(
                  (stats24h.orders.filled / stats24h.orders.placed) * 1000,
                ) / 10
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
          singleLegRate1h: this.calculateSingleLegRate(stats1h),
          singleLegRate24h: this.calculateSingleLegRate(stats24h),
          singleLegTimePercent24h: this.calculateSingleLegTimePercent(),
        },
        // NEW: Failure analysis
        failureAnalysis: this.getSingleLegFailureAnalysis(),
      },
      errors: {
        total: {
          last1h: stats1h.errorCount,
          last24h: stats24h.errorCount,
        },
        byType: this.getErrorsByType(stats24h),
        recent: this.getRecentErrors(),
        // NEW: Recent errors with full context snapshots
        recentWithContext: this.getRecentErrorsWithContext(),
      },
      positions: {
        ...this.positionData,
        breakEvenInfo: this.getBreakEvenInfo(),
      },
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
      executionAnalytics: this.getExecutionAnalyticsDiagnostics(),

      // ==================== NEW DIAGNOSTIC SECTIONS ====================
      lighterState: this.getLighterDiagnostics(),
      staleOrders: this.getStaleOrdersDiagnostics(),
      executionLocks: this.getExecutionLocksDiagnostics(),
      capital: this.getCapitalDiagnostics(),
      currentOperation: this.getCurrentOperationDiagnostics(),
      predictions: this.getPredictionDiagnostics(),
      marketQuality: this.getMarketQualityDiagnostics(),
    };
  }

  /**
   * Get market quality filter diagnostics
   */
  private getMarketQualityDiagnostics(): DiagnosticsResponse['marketQuality'] {
    if (!this.marketQualityFilter) {
      return undefined;
    }

    try {
      return this.marketQualityFilter.getDiagnostics();
    } catch {
      return undefined;
    }
  }

  /**
   * Get recent errors with full context snapshots
   */
  private getRecentErrorsWithContext(): DiagnosticsResponse['errors']['recentWithContext'] {
    const now = Date.now();
    
    return this.errorsWithContext
      .slice(-10)
      .reverse()
      .map((err) => {
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
        msg: err.message.substring(0, 100),
        snapshot: err.snapshot,
      };
    });
  }

  /**
   * Get execution locks diagnostics
   */
  private getExecutionLocksDiagnostics(): DiagnosticsResponse['executionLocks'] {
    const now = Date.now();
    
    // Check if global lock is stale (held > 60s)
    const lockDurationMs = this.globalLockInfo.startedAt
      ? now - this.globalLockInfo.startedAt.getTime()
      : 0;
    const isStale = lockDurationMs > 60000;

    let warning: string | undefined;
    if (isStale && this.globalLockInfo.held) {
      warning = `Global lock held for ${Math.round(lockDurationMs / 1000)}s - possible deadlock or slow operation`;
    }

    return {
      globalLock: {
        held: this.globalLockInfo.held,
        holder: this.globalLockInfo.holder,
        durationMs: lockDurationMs || undefined,
        currentOperation: this.globalLockInfo.currentOperation,
        isStale,
        warning,
      },
      symbolLocks: [], // Populated externally if needed
      activeOrders: [], // Populated externally if needed
      recentOrderHistory: [], // Populated externally if needed
      blockedOperationsCount: this.blockedOperationsCount,
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
    const byExchange: Record<
      string,
      {
      currentPerSecond: number;
      maxPerSecond: number;
      currentPerMinute: number;
      maxPerMinute: number;
      queued: number;
      }
    > = {};

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

  /**
   * Get execution analytics diagnostics
   */
  private getExecutionAnalyticsDiagnostics(): DiagnosticsResponse['executionAnalytics'] {
    if (!this.executionAnalytics) {
      return undefined;
    }

    try {
      const stats = this.executionAnalytics.getDiagnosticsStats();
      
      const formatStats = (s: any) => ({
        totalOrders: s.totalOrders || 0,
        successfulOrders: s.successfulOrders || 0,
        failedOrders: s.failedOrders || 0,
        fillRate: Math.round((s.fillRate || 0) * 10) / 10,
        avgSlippageBps: Math.round((s.avgSlippageBps || 0) * 10) / 10,
        avgFillTimeMs: Math.round(s.avgFillTimeMs || 0),
        p50FillTimeMs: Math.round(s.p50FillTimeMs || 0),
        p95FillTimeMs: Math.round(s.p95FillTimeMs || 0),
        avgAttempts: Math.round((s.avgAttempts || 1) * 10) / 10,
        partialFillRate: Math.round((s.partialFillRate || 0) * 10) / 10,
      });

      // Convert byExchange Map to Record
      const byExchange: Record<
        string,
        {
        orders: number;
        fillRate: number;
        avgSlippageBps: number;
        avgFillTimeMs: number;
        }
      > = {};

      if (stats.last24h?.byExchange) {
        for (const [exchange, data] of stats.last24h.byExchange) {
          byExchange[exchange] = {
            orders: data.orders || 0,
            fillRate: Math.round((data.fillRate || 0) * 10) / 10,
            avgSlippageBps: Math.round((data.avgSlippageBps || 0) * 10) / 10,
            avgFillTimeMs: Math.round(data.avgFillTimeMs || 0),
          };
        }
      }

      return {
        last1h: formatStats(stats.last1h || {}),
        last24h: formatStats(stats.last24h || {}),
        byExchange,
      };
    } catch (error: any) {
      this.logger.warn(`Failed to get execution analytics: ${error.message}`);
      return undefined;
    }
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
        orders: {
          placed: 0,
          filled: 0,
          failed: 0,
          cancelled: 0,
          fillTimesMs: [],
        },
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
    const cutoff = this.getHourTimestamp() - this.MAX_HOURS * 3600000;
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
    errors: Map<
      string,
      { count: number; lastMessage: string; lastTimestamp: Date }
    >;
  } {
    const now = this.getHourTimestamp();
    const cutoff = now - hours * 3600000;
    
    const result = {
      orders: { placed: 0, filled: 0, failed: 0 },
      errorCount: 0,
      singleLegs: { started: 0, resolved: 0 },
      errors: new Map<
        string,
        { count: number; lastMessage: string; lastTimestamp: Date }
      >(),
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

  private calculatePercentiles(times: number[]): {
    p50: number;
    p95: number;
    p99: number;
  } {
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

  private calculateHealthStatus(
    stats1h: any,
    stats24h: any,
  ): { overall: 'OK' | 'DEGRADED' | 'CRITICAL'; issues: string[] } {
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
      const oldSingleLegs = Array.from(this.activeSingleLegs.values()).filter(
        (sl) => Date.now() - sl.startedAt.getTime() > 30 * 60000,
      ); // > 30 min
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
        issues.push(
          `${exchange} connection unstable (${status.reconnects24h} reconnects)`,
        );
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
    return Array.from(this.activeSingleLegs.values()).map((sl) => ({
      symbol: sl.symbol,
      exchange: sl.exchange,
      side: sl.side,
      ageMinutes: Math.round((now - sl.startedAt.getTime()) / 60000),
      retries: sl.retryCount,
      reason: sl.reason,
      missingExchange: sl.missingExchange,
    }));
  }

  private calculateAvgResolutionTime(): number {
    const allTimes: number[] = [];
    for (const bucket of this.hourlyBuckets.values()) {
      allTimes.push(...bucket.singleLegs.resolutionTimesMin);
    }
    
    if (allTimes.length === 0) return 0;
    return (
      Math.round((allTimes.reduce((a, b) => a + b, 0) / allTimes.length) * 10) /
      10
    );
  }

  /**
   * Calculate single-leg rate: percentage of executions that resulted in single-leg
   * A single-leg occurs when one side of a delta-neutral position fails to fill
   */
  private calculateSingleLegRate(stats: {
    orders: { placed: number };
    singleLegs: { started: number };
  }): number {
    // Each execution attempt places 2 orders (long + short)
    // So number of executions = placed / 2
    const executions = Math.floor(stats.orders.placed / 2);
    if (executions === 0) return 0;
    
    // Single-leg rate = single-legs / executions
    const rate = stats.singleLegs.started / executions;
    return Math.round(rate * 1000) / 10; // Return as percentage with 1 decimal, e.g., 15.5%
  }

  /**
   * Calculate percentage of time spent in single-leg state
   * This measures how much of our POSITION time is exposed to directional risk
   * (single-leg time / total time in positions, NOT total uptime)
   */
  private calculateSingleLegTimePercent(): number {
    // Sum up all resolution times (time spent in single-leg state)
    let totalSingleLegMs = 0;
    for (const bucket of this.hourlyBuckets.values()) {
      // Convert minutes to ms
      totalSingleLegMs +=
        bucket.singleLegs.resolutionTimesMin.reduce((a, b) => a + b, 0) * 60000;
    }
    
    // Also count time for currently active single-legs
    const now = Date.now();
    for (const sl of this.activeSingleLegs.values()) {
      totalSingleLegMs += now - sl.startedAt.getTime();
    }
    
    // Get total time spent in positions (tracked via updatePositionData calls)
    // Add current period if we have positions now
    let totalPositionMs = this.totalPositionTimeMs;
    if (this.lastPositionCheckTime && this.lastPositionCount > 0) {
      totalPositionMs += now - this.lastPositionCheckTime.getTime();
    }
    
    // If no position time tracked yet but we have single-leg time,
    // single-leg time IS position time (can't be in single-leg without position)
    // Use the greater of tracked position time or single-leg time as denominator
    if (totalPositionMs < totalSingleLegMs) {
      totalPositionMs = totalSingleLegMs;
    }
    
    // If still no position time, return 0
    if (totalPositionMs === 0) return 0;
    
    // Cap at 100% (can't spend more than 100% of position time in single-leg)
    const percent = Math.min((totalSingleLegMs / totalPositionMs) * 100, 100);
    return Math.round(percent * 10) / 10; // Return as percentage with 1 decimal
  }

  private getErrorsByType(
    stats: any,
  ): Record<string, { count: number; last: string }> {
    const result: Record<string, { count: number; last: string }> = {};
    
    for (const [type, data] of stats.errors) {
      const minutesAgo = Math.round(
        (Date.now() - data.lastTimestamp.getTime()) / 60000,
      );
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

  private getRecentErrors(): Array<{
    time: string;
    type: string;
    exchange?: string;
    msg: string;
  }> {
    const now = Date.now();
    
    return this.recentErrors
      .slice(-10)
      .reverse()
      .map((err) => {
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
    const cutoff = now - hours * 3600000;
    
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
    const cutoff = now - hours * 3600000;
    
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

  private getConnectionStatus(): Record<
    string,
    { status: string; reconnects24h: number; lastError?: string }
  > {
    const now = this.getHourTimestamp();
    const cutoff = now - 24 * 3600000;
    
    const result: Record<
      string,
      { status: string; reconnects24h: number; lastError?: string }
    > = {};
    
    // Initialize for all exchanges
    for (const exchange of [
      ExchangeType.HYPERLIQUID,
      ExchangeType.LIGHTER,
      ExchangeType.ASTER,
    ]) {
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
    this.positionData = {
      count: 0,
      totalValue: 0,
      unrealizedPnl: 0,
      byExchange: {},
    };
    this.totalPositionTimeMs = 0;
    this.lastPositionCheckTime = null;
    this.lastPositionCount = 0;

    // Reset new tracking data
    this.errorsWithContext.length = 0;
    this.singleLegFailures.length = 0;
    this.lighterState = null;
    this.unfilledOrders.clear();
    this.currentOperation = null;
    this.globalLockInfo = { held: false };
    this.blockedOperationsCount = 0;
    this.capitalData.byExchange.clear();
  }

  /**
   * Get a summary suitable for AI context windows (condensed)
   */
  getSummary(): string {
    const diag = this.getDiagnostics();
    
    const lines: string[] = [];
    lines.push(`Health: ${diag.health.overall}`);
    
    if (diag.health.issues.length > 0) {
      lines.push(`Issues: ${diag.health.issues.join('; ')}`);
    }

    lines.push(
      `Orders 1h: ${diag.orders.last1h.filled}/${diag.orders.last1h.placed} filled (${diag.orders.last1h.fillRate}%)`,
    );
    lines.push(`Errors 1h: ${diag.errors.total.last1h}`);
    
    if (diag.singleLegs.failureAnalysis) {
      const fa = diag.singleLegs.failureAnalysis;
      lines.push(
        `Single-leg failures: long=${fa.byLeg.long}, short=${fa.byLeg.short}`,
      );
      if (Object.keys(fa.byReason).length > 0) {
        lines.push(
          `Failure reasons: ${Object.entries(fa.byReason)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`,
        );
      }
    }

    if (diag.lighterState?.nonce.syncStatus !== 'OK') {
      lines.push(
        `Lighter nonce: ${diag.lighterState?.nonce.syncStatus} (${diag.lighterState?.nonce.current}/${diag.lighterState?.nonce.expected})`,
      );
    }

    if (diag.staleOrders && diag.staleOrders.count > 0) {
      lines.push(
        `Stale orders: ${diag.staleOrders.count} ($${diag.staleOrders.totalValue})`,
      );
    }

    if (diag.executionLocks?.globalLock.isStale) {
      lines.push(`⚠️ ${diag.executionLocks.globalLock.warning}`);
    }

    if (diag.currentOperation) {
      lines.push(
        `Current: ${diag.currentOperation.description} (${diag.currentOperation.stage})`,
      );
    }

    return lines.join('\n');
  }
}
