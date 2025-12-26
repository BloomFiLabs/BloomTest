import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { IOrderExecutor } from './IOrderExecutor';
import type { IPositionManager } from './IPositionManager';
import type { AsymmetricFill } from './IPositionManager';
import { PositionManager } from './PositionManager';
import { CostCalculator } from './CostCalculator';
import { ExecutionPlanBuilder } from './ExecutionPlanBuilder';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import type { IPerpKeeperPerformanceLogger } from '../../ports/IPerpKeeperPerformanceLogger';
import {
  ArbitrageExecutionPlan,
  ArbitrageExecutionResult,
} from '../FundingArbitrageStrategy';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderStatus,
  OrderSide,
  OrderType,
  TimeInForce,
} from '../../value-objects/PerpOrder';
import { Result } from '../../common/Result';
import {
  DomainException,
  ExchangeException,
  OrderExecutionException,
  InsufficientBalanceException,
} from '../../exceptions/DomainException';
import { DiagnosticsService } from '../../../infrastructure/services/DiagnosticsService';
import {
  CircuitBreakerService,
  CircuitState,
} from '../../../infrastructure/services/CircuitBreakerService';
import { ExecutionLockService } from '../../../infrastructure/services/ExecutionLockService';
import { ExecutionAnalytics,
  OrderExecutionMetrics,
  RetryConfig,
  DEFAULT_RETRY_CONFIG,
} from './ExecutionAnalytics';
import { UnifiedExecutionService, UnifiedExecutionConfig } from '../execution/UnifiedExecutionService';
import { ConfigService } from '@nestjs/config';

/**
 * Order executor for funding arbitrage strategy
 * Handles order placement, waiting for fills, and managing multiple positions
 * 
 * NEW: Supports sliced execution to minimize single-leg exposure!
 */
@Injectable()
export class OrderExecutor implements IOrderExecutor {
  private readonly logger = new Logger(OrderExecutor.name);
  private executionAnalytics?: ExecutionAnalytics;
  
  // Whether to use sliced execution (can be configured via env)
  private useSlicedExecution: boolean = true;
  private unifiedExecutionConfig: Partial<UnifiedExecutionConfig> = {
    minSlices: 2,
    maxSlices: 10,
    sliceFillTimeoutMs: 20000, // 20 seconds per slice
    maxImbalancePercent: 5, // Abort if > 5% imbalance
    fundingBufferMs: 3 * 60 * 1000, // 3 minute buffer before funding
    maxPortfolioPctPerSlice: 0.05, // 5% of portfolio max
    maxUsdPerSlice: 2500, // $2.5k max per slice
  };

  // Retry configuration for transient failures
  private readonly retryConfig: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    maxRetries: 3,
    baseDelayMs: 1000,
    maxDelayMs: 15000,
    backoffMultiplier: 2,
    retryableErrors: [
      'TIMEOUT',
      'RATE_LIMIT',
      'NETWORK_ERROR',
      'TEMPORARY_FAILURE',
      'INSUFFICIENT_LIQUIDITY',
      'PRICE_MOVED',
      'NONCE',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
    ],
  };

  constructor(
    @Inject(forwardRef(() => 'IPositionManager'))
    private readonly positionManager: IPositionManager,
    private readonly costCalculator: CostCalculator,
    private readonly executionPlanBuilder: ExecutionPlanBuilder,
    private readonly config: StrategyConfig,
    @Optional()
    @Inject('IPerpKeeperPerformanceLogger')
    private readonly performanceLogger?: IPerpKeeperPerformanceLogger,
    @Optional()
    private readonly diagnosticsService?: DiagnosticsService,
    @Optional()
    private readonly circuitBreaker?: CircuitBreakerService,
    @Optional()
    private readonly executionLockService?: ExecutionLockService,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly unifiedExecutionService?: UnifiedExecutionService,
  ) {
    // Initialize execution analytics
    this.executionAnalytics = new ExecutionAnalytics();
    
    // Check if unified execution is available, if not create default (for tests/backward compatibility)
    if (!this.unifiedExecutionService) {
      this.unifiedExecutionService = new UnifiedExecutionService();
    }
    
    // Check if sliced execution is disabled via env
    const disableSliced = this.configService?.get('DISABLE_SLICED_EXECUTION');
    this.useSlicedExecution = disableSliced !== 'true';
    
    if (this.useSlicedExecution) {
      this.logger.log('🍕 Sliced execution ENABLED - orders will be split for safety');
    } else {
      this.logger.warn('⚠️ Sliced execution DISABLED - orders placed all-at-once');
    }
  }

  /**
   * Get execution analytics instance for external access
   */
  getExecutionAnalytics(): ExecutionAnalytics | undefined {
    return this.executionAnalytics;
  }

  /**
   * Record an error to diagnostics service and circuit breaker
   */
  private recordError(
    type: string,
    message: string,
    exchange?: ExchangeType,
    symbol?: string,
    context?: Record<string, any>,
  ): void {
    if (this.diagnosticsService) {
      this.diagnosticsService.recordError({
        type,
        message,
        exchange,
        symbol,
        timestamp: new Date(),
        context,
      });
    }

    // Notify circuit breaker of the error
    if (this.circuitBreaker) {
      this.circuitBreaker.recordError(type);
    }
  }

  /**
   * Record a successful order execution to circuit breaker
   */
  private recordSuccess(): void {
    if (this.circuitBreaker) {
      this.circuitBreaker.recordSuccess();
    }
  }

  /**
   * Record an order event to diagnostics
   */
  private recordOrderToDiagnostics(
    orderId: string,
    symbol: string,
    exchange: ExchangeType,
    side: 'LONG' | 'SHORT',
    status: 'PLACED' | 'FILLED' | 'FAILED' | 'CANCELLED',
    fillTimeMs?: number,
    failReason?: string,
  ): void {
    if (this.diagnosticsService) {
      this.diagnosticsService.recordOrder({
        orderId,
        symbol,
        exchange,
        side,
        placedAt: new Date(),
        status,
        fillTimeMs,
        failReason,
      });
    }
  }

  /**
   * Check if an error is retryable
   */
  private isRetryableError(error: any): boolean {
    const errorMessage = (error?.message || String(error)).toUpperCase();
    return this.retryConfig.retryableErrors.some((retryable) =>
      errorMessage.includes(retryable),
    );
  }

  /**
   * Calculate retry delay with exponential backoff and jitter
   */
  private calculateRetryDelay(attempt: number): number {
    const delay =
      this.retryConfig.baseDelayMs *
      Math.pow(this.retryConfig.backoffMultiplier, attempt);
    const jitter = delay * 0.2 * (Math.random() * 2 - 1); // ±20% jitter
    return Math.min(delay + jitter, this.retryConfig.maxDelayMs);
  }

  /**
   * Execute a function with retry logic and exponential backoff
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    exchange: ExchangeType,
    symbol: string,
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const startTime = Date.now();
        const result = await operation();

        // Record successful execution time
        if (attempt > 0) {
          this.logger.log(
            `✅ ${operationName} succeeded on retry ${attempt} for ${symbol} (${exchange})`,
          );
        }

        return result;
      } catch (error: any) {
        lastError = error;

        // Check if error is retryable
        if (
          !this.isRetryableError(error) ||
          attempt === this.retryConfig.maxRetries
        ) {
          this.logger.warn(
            `❌ ${operationName} failed for ${symbol} (${exchange}) - ` +
              `${this.isRetryableError(error) ? 'max retries exceeded' : 'non-retryable error'}: ${error.message}`,
          );
          throw error;
        }

        const delay = this.calculateRetryDelay(attempt);
        this.logger.warn(
          `⚠️ ${operationName} failed for ${symbol} (${exchange}), ` +
            `retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt + 1}/${this.retryConfig.maxRetries}): ${error.message}`,
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Record order execution metrics
   */
  private recordOrderMetrics(
    symbol: string,
    exchange: ExchangeType,
    side: 'LONG' | 'SHORT',
    requestedSize: number,
    filledSize: number,
    requestedPrice: number,
    executedPrice: number,
    fillTimeMs: number,
    attempts: number,
    success: boolean,
  ): void {
    if (!this.executionAnalytics) return;

    const slippageBps = this.executionAnalytics.calculateSlippageBps(
      requestedPrice,
      executedPrice,
      side,
    );

    this.executionAnalytics.recordExecution({
      symbol,
      exchange,
      side,
      requestedSize,
      filledSize,
      requestedPrice,
      executedPrice,
      slippageBps,
      fillTimeMs,
      attempts,
      success,
      timestamp: new Date(),
    });
  }

  /**
   * Refresh price from exchange and update order if needed
   * Returns updated price or original if refresh fails
   */
  private async refreshPrice(
    adapter: IPerpExchangeAdapter,
    symbol: string,
    originalPrice: number,
    side: OrderSide,
    maxSlippageBps: number = 50, // 0.5% default max acceptable slippage
  ): Promise<{ price: number; priceChanged: boolean }> {
    try {
      const currentPrice = await adapter.getMarkPrice(symbol);

      if (currentPrice <= 0) {
        return { price: originalPrice, priceChanged: false };
      }

      const priceDiff = Math.abs(currentPrice - originalPrice) / originalPrice;
      const priceDiffBps = priceDiff * 10000;

      if (priceDiffBps > maxSlippageBps) {
        this.logger.warn(
          `⚠️ Price moved ${priceDiffBps.toFixed(1)} bps for ${symbol} ` +
            `(${originalPrice.toFixed(4)} -> ${currentPrice.toFixed(4)})`,
        );

        // For buys (LONG), only accept if price went down
        // For sells (SHORT), only accept if price went up
        if (side === OrderSide.LONG && currentPrice > originalPrice) {
          this.logger.warn(
            `Price moved against LONG order, using original price`,
          );
          return { price: originalPrice, priceChanged: false };
        }
        if (side === OrderSide.SHORT && currentPrice < originalPrice) {
          this.logger.warn(
            `Price moved against SHORT order, using original price`,
          );
          return { price: originalPrice, priceChanged: false };
        }
      }

      return {
        price: currentPrice,
        priceChanged: Math.abs(currentPrice - originalPrice) > 0.0001,
      };
    } catch (error: any) {
      this.logger.debug(
        `Failed to refresh price for ${symbol}: ${error.message}`,
      );
      return { price: originalPrice, priceChanged: false };
    }
  }

  /**
   * Handle partial fill by creating a follow-up order for remaining size
   */
  private async handlePartialFill(
    adapter: IPerpExchangeAdapter,
    originalOrder: PerpOrderRequest,
    filledSize: number,
    exchange: ExchangeType,
  ): Promise<PerpOrderResponse | null> {
    const remainingSize = originalOrder.size - filledSize;

    // Skip if remaining size is too small (< 5% of original)
    if (remainingSize < originalOrder.size * 0.05) {
      this.logger.debug(
        `Partial fill for ${originalOrder.symbol}: remaining size ${remainingSize.toFixed(4)} ` +
          `is too small, treating as complete`,
      );
      return null;
    }

    this.logger.log(
      `📊 Handling partial fill for ${originalOrder.symbol} (${exchange}): ` +
        `filled ${filledSize.toFixed(4)}/${originalOrder.size.toFixed(4)}, ` +
        `placing follow-up for ${remainingSize.toFixed(4)}`,
    );

    try {
      // Refresh price for follow-up order
      const { price: refreshedPrice } = await this.refreshPrice(
        adapter,
        originalOrder.symbol,
        originalOrder.price || 0,
        originalOrder.side,
      );

      const followUpOrder = new PerpOrderRequest(
        originalOrder.symbol,
        originalOrder.side,
        originalOrder.type,
        remainingSize,
        refreshedPrice,
        originalOrder.timeInForce,
        originalOrder.reduceOnly,
      );

      const response = await this.executeWithRetry(
        () => adapter.placeOrder(followUpOrder),
        'Place partial fill follow-up order',
        exchange,
        originalOrder.symbol,
      );

      return response;
    } catch (error: any) {
      this.logger.error(
        `❌ Failed to place follow-up order for partial fill: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get adaptive timeout based on historical fill times
   */
  private getAdaptiveTimeout(exchange: ExchangeType): number {
    if (!this.executionAnalytics) {
      return 30000; // Default 30 seconds
    }

    return this.executionAnalytics.calculateAdaptiveTimeout(exchange);
  }

  /**
   * Get available margin from an adapter
   * Uses getAvailableMargin() if available, falls back to getBalance() with buffer
   *
   * This prevents "not enough margin" errors by using a more accurate margin calculation
   * that accounts for existing positions and applies safety buffers.
   */
  private async getAdapterAvailableMargin(
    adapter: IPerpExchangeAdapter,
  ): Promise<number> {
    try {
      // Try to use getAvailableMargin if the adapter supports it
      if (typeof adapter.getAvailableMargin === 'function') {
        return await adapter.getAvailableMargin();
      }

      // Fallback to getBalance with a conservative 30% buffer
      const balance = await adapter.getBalance();
      return balance * 0.7;
    } catch (error: any) {
      this.logger.warn(`Failed to get available margin: ${error.message}`);
      return 0;
    }
  }

  /**
   * Place a pair of orders (long and short) with intelligent execution strategy
   *
   * - If either exchange is Lighter, execute SEQUENTIALLY to avoid nonce conflicts
   * - If both exchanges are the same, execute SEQUENTIALLY
   * - Otherwise, execute in PARALLEL for speed
   *
   * Features:
   * - Order registry to prevent race conditions across threads
   * - Retry logic with exponential backoff for transient failures
   * - Execution metrics tracking (slippage, fill time)
   * - Dynamic timeout adjustment based on historical performance
   *
   * @returns Tuple of [longResponse, shortResponse]
   */
  private async placeOrderPair(
    longAdapter: IPerpExchangeAdapter,
    shortAdapter: IPerpExchangeAdapter,
    longOrder: PerpOrderRequest,
    shortOrder: PerpOrderRequest,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): Promise<[PerpOrderResponse, PerpOrderResponse]> {
    // Generate thread ID for order tracking
    const threadId =
      this.executionLockService?.generateThreadId() || `order-${Date.now()}`;

    // RACE CONDITION CHECK: Verify no active orders exist for this symbol/side
    if (this.executionLockService) {
      const longActive = this.executionLockService.hasActiveOrder(
        longExchange,
        longOrder.symbol,
        'LONG',
      );
      const shortActive = this.executionLockService.hasActiveOrder(
        shortExchange,
        shortOrder.symbol,
        'SHORT',
      );

      if (longActive || shortActive) {
        const msg =
          `Race condition detected: Active orders exist for ${longOrder.symbol} ` +
          `(LONG active: ${longActive}, SHORT active: ${shortActive})`;
        this.logger.error(`🚨 ${msg}`);
        throw new ExchangeException(msg, longExchange, {
          symbol: longOrder.symbol,
        });
      }

      // Register orders as PLACING
      const longRegistered = this.executionLockService.registerOrderPlacing(
        `pending-long-${Date.now()}`,
        longOrder.symbol,
        longExchange,
        'LONG',
        threadId,
        longOrder.size,
        longOrder.price,
      );

      if (!longRegistered) {
        throw new ExchangeException(
          `Failed to register LONG order - another order is active`,
          longExchange,
          { symbol: longOrder.symbol },
        );
      }

      const shortRegistered = this.executionLockService.registerOrderPlacing(
        `pending-short-${Date.now()}`,
        shortOrder.symbol,
        shortExchange,
        'SHORT',
        threadId,
        shortOrder.size,
        shortOrder.price,
      );

      if (!shortRegistered) {
        // Clean up long registration since short failed
        this.executionLockService.forceClearOrder(
          longExchange,
          longOrder.symbol,
          'LONG',
        );
        throw new ExchangeException(
          `Failed to register SHORT order - another order is active`,
          shortExchange,
          { symbol: shortOrder.symbol },
        );
      }
    }

    // Determine if sequential execution is required
    const requiresSequential =
      longExchange === shortExchange ||
      longExchange === ExchangeType.LIGHTER ||
      shortExchange === ExchangeType.LIGHTER;

    const startTime = Date.now();

    try {
      if (requiresSequential) {
        // CRITICAL: Always place Lighter leg FIRST (it's the flakier exchange)
        // If Lighter fails, we haven't committed anything - no rollback needed!
        const lighterIsLong = longExchange === ExchangeType.LIGHTER;
        const lighterIsShort = shortExchange === ExchangeType.LIGHTER;
        
        // Determine execution order: Lighter first, then the reliable exchange
        const firstAdapter = lighterIsLong ? longAdapter : (lighterIsShort ? shortAdapter : longAdapter);
        const secondAdapter = lighterIsLong ? shortAdapter : (lighterIsShort ? longAdapter : shortAdapter);
        const firstOrder = lighterIsLong ? longOrder : (lighterIsShort ? shortOrder : longOrder);
        const secondOrder = lighterIsLong ? shortOrder : (lighterIsShort ? longOrder : shortOrder);
        const firstExchange = lighterIsLong ? longExchange : (lighterIsShort ? shortExchange : longExchange);
        const secondExchange = lighterIsLong ? shortExchange : (lighterIsShort ? longExchange : shortExchange);
        const firstSide: 'LONG' | 'SHORT' = lighterIsLong ? 'LONG' : (lighterIsShort ? 'SHORT' : 'LONG');
        const secondSide: 'LONG' | 'SHORT' = lighterIsLong ? 'SHORT' : (lighterIsShort ? 'LONG' : 'SHORT');
        
        this.logger.debug(
          `📋 Sequential order placement for ${longOrder.symbol}: ` +
            `${firstExchange} (${firstSide}) -> ${secondExchange} (${secondSide}) ` +
            `(Lighter-first strategy: ${lighterIsLong || lighterIsShort ? 'Lighter is ' + firstSide : 'same exchange'})`,
        );

        let firstResponse: PerpOrderResponse | undefined;
        let secondResponse: PerpOrderResponse | undefined;
        let firstAttempts = 0;
        let secondAttempts = 0;

        try {
          // 1. Place FIRST leg (Lighter if involved, otherwise LONG)
          firstResponse = await this.executeWithRetry(
          async () => {
              firstAttempts++;
              return firstAdapter.placeOrder(firstOrder);
          },
            `Place ${firstSide} order`,
            firstExchange,
            firstOrder.symbol,
        );

          // Update registry
        if (this.executionLockService) {
          this.executionLockService.updateOrderStatus(
              firstExchange,
              firstOrder.symbol,
              firstSide,
              firstResponse.isSuccess() ? 'PLACED' : 'FAILED',
              firstResponse.orderId,
              firstOrder.price,
              firstOrder.reduceOnly
          );
        }

          const firstFillTime = Date.now() - startTime;
        this.recordOrderMetrics(
            firstOrder.symbol,
            firstExchange,
            firstSide,
            firstOrder.size,
            firstResponse.filledSize || firstOrder.size,
            firstOrder.price || 0,
            firstResponse.averageFillPrice || firstOrder.price || 0,
            firstFillTime,
            firstAttempts,
            firstResponse.isSuccess(),
        );

        this.recordOrderToDiagnostics(
            firstResponse.orderId || 'unknown',
            firstOrder.symbol,
            firstExchange,
            firstSide,
            firstResponse.isSuccess() ? (firstResponse.isFilled() ? 'FILLED' : 'PLACED') : 'FAILED',
            firstFillTime,
            firstResponse.error,
        );

          // 2. Place SECOND leg (reliable exchange)
          const secondStartTime = Date.now();
          secondResponse = await this.executeWithRetry(
          async () => {
              secondAttempts++;
              return secondAdapter.placeOrder(secondOrder);
          },
            `Place ${secondSide} order`,
            secondExchange,
            secondOrder.symbol,
        );

          // Update registry
        if (this.executionLockService) {
          this.executionLockService.updateOrderStatus(
              secondExchange,
              secondOrder.symbol,
              secondSide,
              secondResponse.isSuccess() ? 'PLACED' : 'FAILED',
              secondResponse.orderId,
              secondOrder.price,
              secondOrder.reduceOnly
          );
        }

          const secondFillTime = Date.now() - secondStartTime;
        this.recordOrderMetrics(
            secondOrder.symbol,
            secondExchange,
            secondSide,
            secondOrder.size,
            secondResponse.filledSize || secondOrder.size,
            secondOrder.price || 0,
            secondResponse.averageFillPrice || secondOrder.price || 0,
            secondFillTime,
            secondAttempts,
            secondResponse.isSuccess(),
        );

        this.recordOrderToDiagnostics(
            secondResponse.orderId || 'unknown',
            secondOrder.symbol,
            secondExchange,
            secondSide,
            secondResponse.isSuccess() ? (secondResponse.isFilled() ? 'FILLED' : 'PLACED') : 'FAILED',
            secondFillTime,
            secondResponse.error,
        );

          // Return in [longResponse, shortResponse] order regardless of execution order
          const longResponse = firstSide === 'LONG' ? firstResponse : secondResponse;
          const shortResponse = firstSide === 'SHORT' ? firstResponse : secondResponse;
        return [longResponse, shortResponse];

        } catch (error: any) {
          // SEQUENTIAL ROLLBACK: If second leg fails, rollback the first
          if (firstResponse && firstResponse.isSuccess()) {
            this.logger.error(
              `🚨 SEQUENTIAL PARTIAL FAILURE: ${firstOrder.symbol} - ` +
              `${firstSide} on ${firstExchange} succeeded but ${secondSide} on ${secondExchange} failed. ` +
              `Attempting ROLLBACK of ${firstSide} leg...`
            );

            try {
              if (firstResponse.orderId && !firstResponse.isFilled()) {
                await firstAdapter.cancelOrder(firstResponse.orderId, firstOrder.symbol);
                this.logger.log(`✅ Rolled back ${firstSide} order ${firstResponse.orderId} (cancelled)`);
              } else {
                // Order filled - MUST close with MARKET order to guarantee exit!
                // Using LIMIT here is dangerous - it might not fill!
                const closeSide = firstSide === 'LONG' ? OrderSide.SHORT : OrderSide.LONG;
                const closeOrder = new PerpOrderRequest(
                  firstOrder.symbol,
                  closeSide,
                  OrderType.MARKET,  // CRITICAL: Use MARKET to guarantee fill!
                  firstResponse.filledSize || firstOrder.size,
                  undefined,  // No price for market orders
                  TimeInForce.IOC,  // Immediate-or-cancel for safety
                  true // reduceOnly
                );
                
                this.logger.warn(
                  `🚨 ROLLBACK: Placing MARKET ${closeSide} to close filled ${firstSide} position ` +
                  `(${firstResponse.filledSize || firstOrder.size} ${firstOrder.symbol})`
                );
                
                const rollbackResponse = await firstAdapter.placeOrder(closeOrder);
                
                if (rollbackResponse.isSuccess()) {
                  this.logger.log(
                    `✅ Rolled back ${firstSide} position with MARKET order (filled: ${rollbackResponse.filledSize || 'pending'})`
                  );
                } else {
                  // CRITICAL: Market order failed - this is very bad!
                  this.logger.error(
                    `🚨🚨 CRITICAL: MARKET rollback failed for ${firstOrder.symbol}! ` +
                    `Position may be UNHEDGED! Error: ${rollbackResponse.error}`
                  );
                  
                  // Record this critical failure for immediate attention
                  if (this.diagnosticsService) {
                    this.diagnosticsService.recordErrorWithContext(
                      'ROLLBACK_MARKET_FAILED',
                      `Market order rollback failed - position may be unhedged!`,
                      {
                        order: {
                          symbol: firstOrder.symbol,
                          exchange: firstExchange,
                          side: firstSide,
                          size: firstResponse.filledSize || firstOrder.size,
                          price: 0,
                          orderType: 'MARKET',
                        },
                      },
                      firstExchange,
                      firstOrder.symbol,
                    );
                  }
                }
              }
            } catch (rollbackError: any) {
              this.logger.error(`🚨 ROLLBACK FAILED for ${firstExchange}: ${rollbackError.message}`);
              
              // Record critical rollback failure
              if (this.diagnosticsService) {
                this.diagnosticsService.recordErrorWithContext(
                  'ROLLBACK_EXCEPTION',
                  `Rollback threw exception - position may be unhedged! Error: ${rollbackError.message}`,
                  {
                    order: {
                      symbol: firstOrder.symbol,
                      exchange: firstExchange,
                      side: firstSide,
                      size: firstOrder.size,
                      price: firstOrder.price || 0,
                      orderType: 'ROLLBACK',
                    },
                  },
                  firstExchange,
                  firstOrder.symbol,
                );
              }
            }
          }

          // Clean up locks
          if (this.executionLockService) {
            this.executionLockService.forceClearOrder(longExchange, longOrder.symbol, 'LONG');
            this.executionLockService.forceClearOrder(shortExchange, shortOrder.symbol, 'SHORT');
          }

          throw error;
        }
      }

      // Different exchanges (non-Lighter) can be executed in parallel with retry
      // CRITICAL: Use Promise.allSettled to handle partial failures and implement rollback
      this.logger.debug(
        `📋 Parallel order placement for ${longOrder.symbol}: ` +
          `${longExchange} || ${shortExchange}`,
      );

      let longAttempts = 0;
      let shortAttempts = 0;

      // Use allSettled to capture both success and failure cases
      const [longResult, shortResult] = await Promise.allSettled([
        this.executeWithRetry(
          async () => {
            longAttempts++;
            return longAdapter.placeOrder(longOrder);
          },
          'Place LONG order',
          longExchange,
          longOrder.symbol,
        ),
        this.executeWithRetry(
          async () => {
            shortAttempts++;
            return shortAdapter.placeOrder(shortOrder);
          },
          'Place SHORT order',
          shortExchange,
          shortOrder.symbol,
        ),
      ]);

      const totalTime = Date.now() - startTime;

      // Check for partial failure (one succeeded, one failed) - ROLLBACK REQUIRED
      const longSuccess = longResult.status === 'fulfilled';
      const shortSuccess = shortResult.status === 'fulfilled';

      if (longSuccess !== shortSuccess) {
        // PARTIAL FAILURE - One leg succeeded, one failed
        // This creates a single-leg position - we need to cancel/close the successful order
        this.logger.error(
          `🚨 PARTIAL FAILURE: ${longOrder.symbol} - ` +
            `LONG: ${longSuccess ? 'SUCCESS' : 'FAILED'}, SHORT: ${shortSuccess ? 'SUCCESS' : 'FAILED'}`,
        );

        if (longSuccess) {
          // LONG succeeded, SHORT failed - cancel/close LONG
          const longResponse = longResult.value;
          const shortError = (shortResult as PromiseRejectedResult).reason;

          this.logger.warn(
            `⚠️ Attempting to rollback LONG order ${longResponse.orderId} on ${longExchange} ` +
              `due to SHORT failure: ${shortError?.message || 'Unknown error'}`,
          );

          try {
            // First try to cancel the order if it hasn't filled
            if (longResponse.orderId && !longResponse.isFilled()) {
              await longAdapter.cancelOrder(
                longResponse.orderId,
                longOrder.symbol,
              );
              this.logger.log(
                `✅ Cancelled LONG order ${longResponse.orderId} for rollback`,
              );
            } else if (longResponse.isFilled()) {
              // Order already filled - MUST use MARKET order to guarantee exit!
              this.logger.warn(
                `🚨 LONG order ${longResponse.orderId} already filled - using MARKET order for guaranteed rollback`,
              );

              const closeOrder = new PerpOrderRequest(
                longOrder.symbol,
                OrderSide.SHORT, // Opposite side to close
                OrderType.MARKET, // CRITICAL: MARKET for guaranteed fill!
                longResponse.filledSize || longOrder.size,
                undefined, // No price for market orders
                TimeInForce.IOC,
                true, // reduceOnly
              );
              
              const rollbackResponse = await longAdapter.placeOrder(closeOrder);
              
              if (rollbackResponse.isSuccess()) {
                this.logger.log(`✅ Rolled back LONG with MARKET order (filled: ${rollbackResponse.filledSize || 'pending'})`);
              } else {
                this.logger.error(
                  `🚨🚨 CRITICAL: MARKET rollback failed for ${longOrder.symbol}! ` +
                  `LONG position may be UNHEDGED! Error: ${rollbackResponse.error}`
                );
                
                if (this.diagnosticsService) {
                  this.diagnosticsService.recordErrorWithContext(
                    'ROLLBACK_MARKET_FAILED',
                    `Market order rollback failed - LONG position may be unhedged!`,
                    {
                      order: {
                        symbol: longOrder.symbol,
                        exchange: longExchange,
                        side: 'LONG' as const,
                        size: longResponse.filledSize || longOrder.size,
                        price: 0,
                        orderType: 'MARKET',
                      },
                    },
                    longExchange,
                    longOrder.symbol,
                  );
                }
              }
            }
          } catch (rollbackError: any) {
            this.logger.error(
              `🚨 ROLLBACK FAILED for LONG on ${longExchange}: ${rollbackError.message}. ` +
                `MANUAL INTERVENTION REQUIRED for single-leg position!`,
            );
            
            if (this.diagnosticsService) {
              this.diagnosticsService.recordErrorWithContext(
                'ROLLBACK_EXCEPTION',
                `Rollback threw exception - LONG position may be unhedged! Error: ${rollbackError.message}`,
                {
                  order: {
                    symbol: longOrder.symbol,
                    exchange: longExchange,
                    side: 'LONG' as const,
                    size: longOrder.size,
                    price: longOrder.price || 0,
                    orderType: 'ROLLBACK',
                  },
                },
                longExchange,
                longOrder.symbol,
              );
            }
          }

          // Clean up registries
          if (this.executionLockService) {
            this.executionLockService.forceClearOrder(
              longExchange,
              longOrder.symbol,
              'LONG',
            );
            this.executionLockService.forceClearOrder(
              shortExchange,
              shortOrder.symbol,
              'SHORT',
            );
          }

          throw new ExchangeException(
            `Parallel execution failed - SHORT order failed after LONG succeeded. ` +
              `Rollback attempted. Short error: ${shortError?.message}`,
            shortExchange,
            {
              longOrderId: longResponse.orderId,
              shortError: shortError?.message,
            },
          );
        } else {
          // SHORT succeeded, LONG failed - cancel/close SHORT
          const shortResponse = (
            shortResult as PromiseFulfilledResult<PerpOrderResponse>
          ).value;
          const longError = longResult.reason;

          this.logger.warn(
            `⚠️ Attempting to rollback SHORT order ${shortResponse.orderId} on ${shortExchange} ` +
              `due to LONG failure: ${longError?.message || 'Unknown error'}`,
          );

          try {
            // First try to cancel the order if it hasn't filled
            if (shortResponse.orderId && !shortResponse.isFilled()) {
              await shortAdapter.cancelOrder(
                shortResponse.orderId,
                shortOrder.symbol,
              );
              this.logger.log(
                `✅ Cancelled SHORT order ${shortResponse.orderId} for rollback`,
              );
            } else if (shortResponse.isFilled()) {
              // Order already filled - MUST use MARKET order to guarantee exit!
              this.logger.warn(
                `🚨 SHORT order ${shortResponse.orderId} already filled - using MARKET order for guaranteed rollback`,
              );

              const closeOrder = new PerpOrderRequest(
                shortOrder.symbol,
                OrderSide.LONG, // Opposite side to close
                OrderType.MARKET, // CRITICAL: MARKET for guaranteed fill!
                shortResponse.filledSize || shortOrder.size,
                undefined, // No price for market orders
                TimeInForce.IOC,
                true, // reduceOnly
              );
              
              const rollbackResponse = await shortAdapter.placeOrder(closeOrder);
              
              if (rollbackResponse.isSuccess()) {
                this.logger.log(`✅ Rolled back SHORT with MARKET order (filled: ${rollbackResponse.filledSize || 'pending'})`);
              } else {
                this.logger.error(
                  `🚨🚨 CRITICAL: MARKET rollback failed for ${shortOrder.symbol}! ` +
                  `SHORT position may be UNHEDGED! Error: ${rollbackResponse.error}`
                );
                
                if (this.diagnosticsService) {
                  this.diagnosticsService.recordErrorWithContext(
                    'ROLLBACK_MARKET_FAILED',
                    `Market order rollback failed - SHORT position may be unhedged!`,
                    {
                      order: {
                        symbol: shortOrder.symbol,
                        exchange: shortExchange,
                        side: 'SHORT' as const,
                        size: shortResponse.filledSize || shortOrder.size,
                        price: 0,
                        orderType: 'MARKET',
                      },
                    },
                    shortExchange,
                    shortOrder.symbol,
                  );
                }
              }
            }
          } catch (rollbackError: any) {
            this.logger.error(
              `🚨 ROLLBACK FAILED for SHORT on ${shortExchange}: ${rollbackError.message}. ` +
                `MANUAL INTERVENTION REQUIRED for single-leg position!`,
            );
            
            if (this.diagnosticsService) {
              this.diagnosticsService.recordErrorWithContext(
                'ROLLBACK_EXCEPTION',
                `Rollback threw exception - SHORT position may be unhedged! Error: ${rollbackError.message}`,
                {
                  order: {
                    symbol: shortOrder.symbol,
                    exchange: shortExchange,
                    side: 'SHORT' as const,
                    size: shortOrder.size,
                    price: shortOrder.price || 0,
                    orderType: 'ROLLBACK',
                  },
                },
                shortExchange,
                shortOrder.symbol,
              );
            }
          }

          // Clean up registries
          if (this.executionLockService) {
            this.executionLockService.forceClearOrder(
              longExchange,
              longOrder.symbol,
              'LONG',
            );
            this.executionLockService.forceClearOrder(
              shortExchange,
              shortOrder.symbol,
              'SHORT',
            );
          }

          throw new ExchangeException(
            `Parallel execution failed - LONG order failed after SHORT succeeded. ` +
              `Rollback attempted. Long error: ${longError?.message}`,
            longExchange,
            {
              shortOrderId: shortResponse.orderId,
              longError: longError?.message,
            },
          );
        }
      }

      // Both failed
      if (!longSuccess && !shortSuccess) {
        const longError = longResult.reason;
        const shortError = shortResult.reason;

        if (this.executionLockService) {
          this.executionLockService.forceClearOrder(
            longExchange,
            longOrder.symbol,
            'LONG',
          );
          this.executionLockService.forceClearOrder(
            shortExchange,
            shortOrder.symbol,
            'SHORT',
          );
        }

        throw new ExchangeException(
          `Both orders failed - LONG: ${longError?.message}, SHORT: ${shortError?.message}`,
          longExchange,
          { longError: longError?.message, shortError: shortError?.message },
        );
      }

      // Both succeeded - extract responses
      const longResponse = (
        longResult as PromiseFulfilledResult<PerpOrderResponse>
      ).value;
      const shortResponse = (
        shortResult as PromiseFulfilledResult<PerpOrderResponse>
      ).value;

      // Update order registry with actual order IDs
      if (this.executionLockService) {
        this.executionLockService.updateOrderStatus(
          longExchange,
          longOrder.symbol,
          'LONG',
          longResponse.isSuccess() ? 'PLACED' : 'FAILED',
          longResponse.orderId,
        );
        this.executionLockService.updateOrderStatus(
          shortExchange,
          shortOrder.symbol,
          'SHORT',
          shortResponse.isSuccess() ? 'PLACED' : 'FAILED',
          shortResponse.orderId,
        );
      }

      // Record metrics for both orders
      this.recordOrderMetrics(
        longOrder.symbol,
        longExchange,
        'LONG',
        longOrder.size,
        longResponse.filledSize || longOrder.size,
        longOrder.price || 0,
        longResponse.averageFillPrice || longOrder.price || 0,
        totalTime,
        longAttempts,
        longResponse.isSuccess(),
      );

      this.recordOrderMetrics(
        shortOrder.symbol,
        shortExchange,
        'SHORT',
        shortOrder.size,
        shortResponse.filledSize || shortOrder.size,
        shortOrder.price || 0,
        shortResponse.averageFillPrice || shortOrder.price || 0,
        totalTime,
        shortAttempts,
        shortResponse.isSuccess(),
      );

      // Record both orders to diagnostics (parallel execution)
      this.recordOrderToDiagnostics(
        longResponse.orderId || 'unknown',
        longOrder.symbol,
        longExchange,
        'LONG',
        longResponse.isSuccess()
          ? longResponse.isFilled()
            ? 'FILLED'
            : 'PLACED'
          : 'FAILED',
        totalTime,
        longResponse.error,
      );

      this.recordOrderToDiagnostics(
        shortResponse.orderId || 'unknown',
        shortOrder.symbol,
        shortExchange,
        'SHORT',
        shortResponse.isSuccess()
          ? shortResponse.isFilled()
            ? 'FILLED'
            : 'PLACED'
          : 'FAILED',
        totalTime,
        shortResponse.error,
      );

      return [longResponse, shortResponse];
    } catch (error: any) {
      // On error, clean up order registry
      if (this.executionLockService) {
        this.executionLockService.forceClearOrder(
          longExchange,
          longOrder.symbol,
          'LONG',
        );
        this.executionLockService.forceClearOrder(
          shortExchange,
          shortOrder.symbol,
          'SHORT',
        );
      }
      throw error;
    }
  }

  async waitForOrderFill(
    adapter: IPerpExchangeAdapter,
    orderId: string,
    symbol: string,
    exchangeType: ExchangeType,
    expectedSize: number,
    maxRetries: number = 10,
    pollIntervalMs: number = 2000,
    isClosingPosition: boolean = false,
    orderSide?: 'LONG' | 'SHORT',
    expectedPrice?: number,
    reduceOnly?: boolean,
    entryPrice?: number,
  ): Promise<PerpOrderResponse> {
    const operationType = isClosingPosition ? 'CLOSE' : 'OPEN';

    // Update order registry to WAITING_FILL status
    if (this.executionLockService && orderSide) {
      this.executionLockService.updateOrderStatus(
        exchangeType,
        symbol,
        orderSide,
        'WAITING_FILL',
        orderId,
        expectedPrice,
        reduceOnly
      );
    }
    const isLighter = exchangeType === ExchangeType.LIGHTER;

    this.logger.log(
      `⏳ Waiting for ${operationType} order ${orderId} to fill on ${exchangeType} (${symbol})...`,
    );

    // For Lighter orders, track initial position to detect fills
    let initialPosition: { size: number; side: OrderSide } | null = null;
    if (isLighter) {
      try {
        const positions = await adapter.getPositions();
        const matchingPosition = positions.find(
          (p) => p.symbol === symbol && Math.abs(p.size) > 0.0001,
        );
        if (matchingPosition) {
          initialPosition = {
            size: matchingPosition.size,
            side: matchingPosition.side,
          };
          this.logger.debug(
            `Initial position for ${symbol}: ${initialPosition.side} ${initialPosition.size.toFixed(4)}`,
          );
        }
      } catch (error: any) {
        this.logger.debug(`Could not get initial position: ${error.message}`);
      }
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Wait before polling (except first attempt)
        if (attempt > 0) {
          const maxBackoff = isClosingPosition
            ? this.config.maxBackoffDelayClosing
            : this.config.maxBackoffDelayOpening;

          const exponentialDelay = pollIntervalMs * Math.pow(2, attempt - 1);
          const backoffDelay = Math.min(exponentialDelay, maxBackoff);

          this.logger.debug(
            `   Waiting ${(backoffDelay / 1000).toFixed(1)}s before attempt ${attempt + 1}/${maxRetries}...`,
          );

          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        }

        // For Lighter orders, check positions to detect fills (since getOrderStatus doesn't work)
        if (isLighter) {
          try {
            const positions = await adapter.getPositions();
            const matchingPosition = positions.find(
              (p) => p.symbol === symbol && Math.abs(p.size) > 0.0001,
            );

            if (matchingPosition) {
              const currentSize = matchingPosition.size;
              const currentSide = matchingPosition.side;

              // Determine expected side based on operation type
              const expectedSide = isClosingPosition
                ? currentSide === OrderSide.LONG
                  ? OrderSide.SHORT
                  : OrderSide.LONG
                : currentSide;

              // Check if position changed (indicating fill)
              if (initialPosition) {
                const sizeChange = Math.abs(currentSize - initialPosition.size);
                if (sizeChange >= expectedSize * 0.9) {
                  // At least 90% of expected size
                  this.logger.log(
                    `✅ ${operationType} order ${orderId} filled (detected via position change): ` +
                      `${currentSize.toFixed(4)} ${symbol} (change: ${sizeChange.toFixed(4)})`,
                  );

                  // RECORD REALIZED PNL IF CLOSING
                  if (isClosingPosition && entryPrice && entryPrice > 0 && this.performanceLogger) {
                    const fillPrice = expectedPrice || matchingPosition.markPrice || matchingPosition.entryPrice;
                    const sideMult = orderSide === 'SHORT' ? 1 : -1;
                    const realizedPnl = (fillPrice - entryPrice) * sizeChange * sideMult;
                    this.performanceLogger.recordRealizedPnl(realizedPnl);
                    this.logger.log(`📈 Recorded realized PnL from position change for ${symbol}: $${realizedPnl.toFixed(4)}`);
                  }

                  return new PerpOrderResponse(
                    orderId,
                    OrderStatus.FILLED,
                    symbol,
                    currentSide,
                    undefined,
                    sizeChange,
                    undefined,
                    undefined,
                    new Date(),
                  );
                }
              } else {
                // No initial position - check if current position matches expected
                if (
                  currentSide === expectedSide &&
                  currentSize >= expectedSize * 0.9
                ) {
                  this.logger.log(
                    `✅ ${operationType} order ${orderId} filled (detected via position): ` +
                      `${currentSize.toFixed(4)} ${symbol}`,
                  );

                  // RECORD REALIZED PNL IF CLOSING
                  if (isClosingPosition && entryPrice && entryPrice > 0 && this.performanceLogger) {
                    const fillPrice = expectedPrice || matchingPosition.markPrice || matchingPosition.entryPrice;
                    const sideMult = orderSide === 'SHORT' ? 1 : -1;
                    const realizedPnl = (fillPrice - entryPrice) * currentSize * sideMult;
                    this.performanceLogger.recordRealizedPnl(realizedPnl);
                    this.logger.log(`📈 Recorded realized PnL from position detection for ${symbol}: $${realizedPnl.toFixed(4)}`);
                  }

                  return new PerpOrderResponse(
                    orderId,
                    OrderStatus.FILLED,
                    symbol,
                    currentSide,
                    undefined,
                    currentSize,
                    undefined,
                    undefined,
                    new Date(),
                  );
                }
              }
            } else if (initialPosition && isClosingPosition) {
              // Position closed - order filled
              this.logger.log(
                `✅ ${operationType} order ${orderId} filled (position closed)`,
              );

              // RECORD REALIZED PNL
              if (entryPrice && entryPrice > 0 && this.performanceLogger) {
                const fillPrice = expectedPrice || initialPosition.size; // Fallback to size if price not available? wait.
                // Using initialPosition.size as fallback for price is wrong. 
                // Let's use expectedPrice or initialPosition markPrice if available.
                // Since I don't have markPrice here easily, I'll rely on expectedPrice.
                if (expectedPrice) {
                  const sideMult = orderSide === 'SHORT' ? 1 : -1;
                  const realizedPnl = (expectedPrice - entryPrice) * initialPosition.size * sideMult;
                  this.performanceLogger.recordRealizedPnl(realizedPnl);
                  this.logger.log(`📈 Recorded realized PnL from position closure for ${symbol}: $${realizedPnl.toFixed(4)}`);
                }
              }

              return new PerpOrderResponse(
                orderId,
                OrderStatus.FILLED,
                symbol,
                initialPosition.side,
                undefined,
                initialPosition.size,
                undefined,
                undefined,
                new Date(),
              );
            }
          } catch (positionError: any) {
            this.logger.debug(
              `Could not check positions: ${positionError.message}`,
            );
          }
        }

        const statusResponse = await adapter.getOrderStatus(orderId, symbol);

        if (statusResponse.isFilled()) {
          this.logger.log(
            `✅ ${operationType} order ${orderId} filled on attempt ${attempt + 1}/${maxRetries} ` +
              `(filled: ${statusResponse.filledSize || expectedSize})`,
          );
          // Update order registry to FILLED status
          if (this.executionLockService && orderSide) {
            this.executionLockService.updateOrderStatus(
              exchangeType,
              symbol,
              orderSide,
              'FILLED',
              orderId,
            );
          }

          // RECORD REALIZED PNL IF CLOSING
          if (isClosingPosition && entryPrice && entryPrice > 0 && this.performanceLogger) {
            const fillPrice = statusResponse.averageFillPrice || expectedPrice;
            if (fillPrice) {
              const sideMult = orderSide === 'SHORT' ? 1 : -1; // Closing LONG with SHORT order = exitPrice - entryPrice
              const realizedPnl = (fillPrice - entryPrice) * (statusResponse.filledSize || expectedSize) * sideMult;
              this.performanceLogger.recordRealizedPnl(realizedPnl);
              this.logger.log(`📈 Recorded realized PnL from partial fill for ${symbol}: $${realizedPnl.toFixed(4)}`);
            }
          }

          return statusResponse;
        }

        if (
          statusResponse.status === OrderStatus.CANCELLED ||
          statusResponse.error
        ) {
          this.logger.warn(
            `⚠️ ${operationType} order ${orderId} was cancelled or has error: ` +
              `${statusResponse.error || 'cancelled'}`,
          );
          // Update order registry to CANCELLED status
          if (this.executionLockService && orderSide) {
            this.executionLockService.updateOrderStatus(
              exchangeType,
              symbol,
              orderSide,
              'CANCELLED',
              orderId,
            );
          }
          return statusResponse;
        }

        // Order is still resting/submitted - continue polling
        this.logger.debug(
          `   ${operationType} order ${orderId} still ${statusResponse.status} ` +
            `(attempt ${attempt + 1}/${maxRetries})...`,
        );
      } catch (error: any) {
        this.logger.warn(
          `   Failed to check ${operationType} order status for ${orderId} ` +
            `(attempt ${attempt + 1}/${maxRetries}): ${error.message}`,
        );

        // If this is the last attempt, return error response
        if (attempt === maxRetries - 1) {
          return new PerpOrderResponse(
            orderId,
            OrderStatus.REJECTED,
            symbol,
            OrderSide.LONG,
            undefined,
            undefined,
            undefined,
            `Failed to check order status after ${maxRetries} attempts: ${error.message}`,
          );
        }
      }
    }

    // Max retries reached - order still not filled
    const totalTime = this.calculateTotalWaitTime(
      maxRetries,
      pollIntervalMs,
      isClosingPosition,
    );

    this.logger.warn(
      `⚠️ ${operationType} order ${orderId} did not fill after ${maxRetries} attempts ` +
        `(~${Math.round(totalTime / 1000)}s). Order may still be resting on the order book.`,
    );

    // CRITICAL: Cancel the unfilled order to prevent orphaned orders on the order book
    // This is especially important for GTC (Good Till Cancel) orders on Lighter
    try {
      this.logger.log(
        `🗑️ Cancelling unfilled ${operationType} order ${orderId} on ${exchangeType}...`,
      );
      await adapter.cancelOrder(orderId, symbol);
      this.logger.log(`✅ Successfully cancelled unfilled order ${orderId}`);
    } catch (cancelError: any) {
      this.logger.warn(
        `⚠️ Failed to cancel unfilled order ${orderId}: ${cancelError.message}. ` +
          `Order may still be resting on order book - manual cleanup may be required.`,
      );
    }

    this.recordError(
      'ORDER_FILL_TIMEOUT',
      `${operationType} order did not fill after ${maxRetries} attempts (~${Math.round(totalTime / 1000)}s)`,
      exchangeType,
      symbol,
      { orderId, maxRetries, totalTimeMs: totalTime },
    );

    // Update order registry to CANCELLED status
    if (this.executionLockService && orderSide) {
      this.executionLockService.updateOrderStatus(
        exchangeType,
        symbol,
        orderSide,
        'CANCELLED',
        orderId,
      );
    }

    // Return a response indicating the order was cancelled due to timeout
    return new PerpOrderResponse(
      orderId,
      OrderStatus.CANCELLED,
      symbol,
      OrderSide.LONG,
      undefined,
      undefined,
      undefined,
      `Order cancelled after not filling within ${Math.round(totalTime / 1000)} seconds`,
    );
  }

  async executeSinglePosition(
    bestOpportunity: {
      plan: ArbitrageExecutionPlan;
      opportunity: ArbitrageOpportunity;
    },
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
  ): Promise<Result<ArbitrageExecutionResult, DomainException>> {
    const { plan, opportunity } = bestOpportunity;

    // SYMBOL-LEVEL LOCK: Prevent concurrent execution on the same symbol
    // This prevents race conditions where multiple threads try to execute the same symbol
    const threadId =
      this.executionLockService?.generateThreadId() || `thread-${Date.now()}`;
    if (this.executionLockService) {
      const lockAcquired = this.executionLockService.tryAcquireSymbolLock(
        opportunity.symbol,
        threadId,
        'executeSinglePosition',
      );
      if (!lockAcquired) {
        this.logger.warn(
          `⏳ Symbol ${opportunity.symbol} is already being executed by another thread - skipping`,
        );
        result.errors.push(
          `Symbol ${opportunity.symbol} locked by another execution`,
        );
        return Result.success(result);
      }
    }

    try {
      return await this.executeSinglePositionInternal(
        bestOpportunity,
        adapters,
        result,
      );
    } finally {
      // Always release the symbol lock
      if (this.executionLockService) {
        this.executionLockService.releaseSymbolLock(
          opportunity.symbol,
          threadId,
        );
      }
    }
  }

  /**
   * Internal implementation of executeSinglePosition (called after acquiring symbol lock)
   */
  private async executeSinglePositionInternal(
    bestOpportunity: {
      plan: ArbitrageExecutionPlan;
      opportunity: ArbitrageOpportunity;
    },
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
  ): Promise<Result<ArbitrageExecutionResult, DomainException>> {
    const { plan, opportunity } = bestOpportunity;

    // Circuit breaker check - block new position opening if circuit is OPEN
    if (this.circuitBreaker && !this.circuitBreaker.canOpenNewPosition()) {
      const state = this.circuitBreaker.getState();
      this.logger.warn(
        `🔴 Circuit breaker is ${state} - blocking new position for ${opportunity.symbol}`,
      );
      result.errors.push(
        `Circuit breaker ${state}: blocking new position opening`,
      );
      return Result.success(result);
    }

    this.logger.log(
      `🎯 Executing single best opportunity: ${opportunity.symbol} ` +
        `(Expected net return: $${plan.expectedNetReturn.toFixed(4)} per period)`,
    );

    if (!opportunity.shortExchange) {
      return Result.failure(
        new ExchangeException(
          'Missing shortExchange for perp-perp opportunity',
          opportunity.longExchange,
          { symbol: opportunity.symbol },
        ),
      );
    }

    // Get adapters
    const [longAdapter, shortAdapter] = [
      adapters.get(opportunity.longExchange),
      adapters.get(opportunity.shortExchange),
    ];

    if (!longAdapter || !shortAdapter) {
      const missingExchange = !longAdapter
        ? opportunity.longExchange
        : opportunity.shortExchange || 'UNKNOWN';
      return Result.failure(
        new ExchangeException(
          `Missing adapter for ${missingExchange}`,
          missingExchange,
          { symbol: opportunity.symbol },
        ),
      );
    }

    // PRE-FLIGHT CHECK: Cancel any existing open orders for this symbol to free up margin
    // This prevents "Insufficient margin" errors caused by stale orders holding reserved margin
    try {
      const [longCancelled, shortCancelled] = await Promise.allSettled([
        longAdapter.cancelAllOrders(opportunity.symbol).catch(() => 0),
        shortAdapter.cancelAllOrders(opportunity.symbol).catch(() => 0),
      ]);
      const totalCancelled =
        (longCancelled.status === 'fulfilled' ? longCancelled.value : 0) +
        (shortCancelled.status === 'fulfilled' ? shortCancelled.value : 0);
      if (totalCancelled > 0) {
        this.logger.log(
          `🗑️ Pre-flight: Cancelled ${totalCancelled} existing order(s) for ${opportunity.symbol}`,
        );
        // Small delay to let margin be released
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (error: any) {
      this.logger.debug(
        `Pre-flight cancel failed (non-critical): ${error.message}`,
      );
    }

    // Use target leverage for margin calculations
    // Leverage is a virtual concept on these DEXs (determined by Size / Collateral)
    const leverage = plan.leverage ?? this.config?.leverage ?? 2;

    // PRE-FLIGHT CHECK: Scale position to available capital
    // Use getAvailableMargin() which accounts for existing positions and applies safety buffers
    try {
      const [longMargin, shortMargin] = await Promise.all([
        this.getAdapterAvailableMargin(longAdapter),
        this.getAdapterAvailableMargin(shortAdapter),
      ]);
      const avgPrice =
        ((plan.longOrder.price || 0) + (plan.shortOrder.price || 0)) / 2;
      const originalPositionUsd = plan.positionSize.toUSD(avgPrice);
      const originalRequiredMargin = originalPositionUsd / leverage;
      const minMargin = Math.min(longMargin, shortMargin);

      // Scale down position to fit available margin
      // Note: getAvailableMargin already applies safety buffers, so we use 100% of it
      let actualPositionUsd = originalPositionUsd;
      let actualRequiredMargin = originalRequiredMargin;

      if (minMargin < originalRequiredMargin) {
        // Not enough for original position - scale down
        actualPositionUsd = minMargin * leverage;
        actualRequiredMargin = minMargin;

        // Check if scaled position is too small
        if (actualPositionUsd < this.config.minPositionSizeUsd) {
          const insufficientExchange =
            longMargin < shortMargin
              ? opportunity.longExchange
              : opportunity.shortExchange;
          return Result.failure(
            new InsufficientBalanceException(
              this.config.minPositionSizeUsd / leverage,
              minMargin,
              'USDC',
              {
                symbol: opportunity.symbol,
                exchange: insufficientExchange,
                message: `Cannot scale down to available margin. Min position: $${this.config.minPositionSizeUsd}, Available margin: $${minMargin.toFixed(2)}`,
              },
            ),
          );
        }

        this.logger.log(
          `📉 Scaling ${opportunity.symbol} from $${originalPositionUsd.toFixed(2)} to $${actualPositionUsd.toFixed(2)} ` +
            `(available margin: $${minMargin.toFixed(2)} per exchange)`,
        );
      }

      // Create scaled orders if position was scaled down
      let longOrder = plan.longOrder;
      let shortOrder = plan.shortOrder;

      if (actualPositionUsd < originalPositionUsd * 0.99) {
        // Need to scale the orders
        const scaledSizeBaseAsset = actualPositionUsd / avgPrice;
        longOrder = new PerpOrderRequest(
          plan.longOrder.symbol,
          plan.longOrder.side,
          plan.longOrder.type,
          scaledSizeBaseAsset,
          plan.longOrder.price,
          plan.longOrder.timeInForce,
          plan.longOrder.reduceOnly,
        );
        shortOrder = new PerpOrderRequest(
          plan.shortOrder.symbol,
          plan.shortOrder.side,
          plan.shortOrder.type,
          scaledSizeBaseAsset,
          plan.shortOrder.price,
          plan.shortOrder.timeInForce,
          plan.shortOrder.reduceOnly,
        );
      }

      // Store scaled orders for use after try block
      // Use plan.longOrder/shortOrder which we already updated above

      // Validation checks (now just validation since we already scaled)
      // Note: getAvailableMargin already applies safety buffers, so we use 95% threshold
      if (longMargin < actualRequiredMargin * 0.95) {
        return Result.failure(
          new InsufficientBalanceException(
            actualRequiredMargin,
            longMargin,
            'USDC',
            { symbol: opportunity.symbol, exchange: opportunity.longExchange },
          ),
        );
      }
      if (shortMargin < actualRequiredMargin * 0.95) {
        return Result.failure(
          new InsufficientBalanceException(
            actualRequiredMargin,
            shortMargin,
            'USDC',
            { symbol: opportunity.symbol, exchange: opportunity.shortExchange },
          ),
        );
      }

      // ========================================================
      // UNIFIED INTELLIGENT EXECUTION
      // ========================================================
      if (this.useSlicedExecution && this.unifiedExecutionService) {
        this.logger.log(`🧠 Using UNIFIED INTELLIGENT execution for ${opportunity.symbol}`);
        
        const unifiedResult = await this.unifiedExecutionService.executeSmartHedge(
          longAdapter,
          shortAdapter,
          opportunity.symbol,
          longOrder.size, // Total size
          longOrder.price || 0,
          shortOrder.price || 0,
          opportunity.longExchange,
          opportunity.shortExchange!,
          this.unifiedExecutionConfig,
        );
        
        if (unifiedResult.success) {
          // Success! Both sides filled across all slices
          result.opportunitiesExecuted = 1;
          result.ordersPlaced = unifiedResult.completedSlices * 2;
          result.totalExpectedReturn = plan.expectedNetReturn;
          
          this.logger.log(
            `✅ Unified execution SUCCESS for ${opportunity.symbol}: ` +
            `${unifiedResult.completedSlices}/${unifiedResult.totalSlices} slices, ` +
            `LONG: ${unifiedResult.totalLongFilled.toFixed(4)}, SHORT: ${unifiedResult.totalShortFilled.toFixed(4)}`
          );
          
          return Result.success(result);
        } else {
          // Execution failed or partial - handle based on what happened
          const imbalance = Math.abs(unifiedResult.totalLongFilled - unifiedResult.totalShortFilled);
          const imbalanceUsd = imbalance * avgPrice;
          
          if (imbalanceUsd > 10) { // More than $10 imbalance
            this.logger.error(
              `🚨 Unified execution FAILED with imbalance for ${opportunity.symbol}: ` +
              `LONG: ${unifiedResult.totalLongFilled.toFixed(4)}, SHORT: ${unifiedResult.totalShortFilled.toFixed(4)} ` +
              `(imbalance: $${imbalanceUsd.toFixed(2)}). Reason: ${unifiedResult.abortReason}`
            );
            
            // Record the single-leg failure
            if (this.diagnosticsService) {
              const longIsLarger = unifiedResult.totalLongFilled > unifiedResult.totalShortFilled;
              this.diagnosticsService.recordSingleLegFailure({
                id: `unified-${opportunity.symbol}-${Date.now()}`,
                symbol: opportunity.symbol,
                timestamp: new Date(),
                failedLeg: longIsLarger ? 'short' : 'long',
                failedExchange: longIsLarger ? opportunity.shortExchange! : opportunity.longExchange,
                successfulExchange: longIsLarger ? opportunity.longExchange : opportunity.shortExchange!,
                failureReason: 'exchange_error',
                failureMessage: unifiedResult.abortReason || 'Unified execution imbalance',
                timeBetweenLegsMs: 0,
                attemptedSize: longOrder.size,
                filledSize: Math.min(unifiedResult.totalLongFilled, unifiedResult.totalShortFilled),
              });
            }
            
            result.errors.push(`Unified execution failed: ${unifiedResult.abortReason}`);
            return Result.failure(
              new OrderExecutionException(
                `Unified execution failed with imbalance: ${unifiedResult.abortReason}`,
                `unified-${opportunity.symbol}`,
                opportunity.longExchange,
                { symbol: opportunity.symbol, imbalanceUsd },
              ),
            );
          } else if (unifiedResult.completedSlices > 0) {
            // Partial success - some slices completed
            result.opportunitiesExecuted = 1;
            result.ordersPlaced = unifiedResult.completedSlices * 2;
            result.totalExpectedReturn = plan.expectedNetReturn * (unifiedResult.completedSlices / unifiedResult.totalSlices);
            
            this.logger.warn(
              `⚠️ Unified execution PARTIAL for ${opportunity.symbol}: ` +
              `${unifiedResult.completedSlices}/${unifiedResult.totalSlices} slices completed. ` +
              `Reason: ${unifiedResult.abortReason}`
            );
            
            return Result.success(result);
          } else {
            // Complete failure - nothing filled
            this.logger.error(
              `❌ Unified execution COMPLETE FAILURE for ${opportunity.symbol}: ${unifiedResult.abortReason}`
            );
            result.errors.push(`Unified execution failed: ${unifiedResult.abortReason}`);
            return Result.failure(
              new OrderExecutionException(
                `Unified execution failed: ${unifiedResult.abortReason}`,
                `unified-${opportunity.symbol}`,
                opportunity.longExchange,
                { symbol: opportunity.symbol },
              ),
            );
          }
        }
      }
      
      // ========================================================
      // FALLBACK: Original all-at-once execution (if sliced disabled)
      // ========================================================
      this.logger.warn(`⚠️ Using ALL-AT-ONCE execution for ${opportunity.symbol} (sliced disabled)`);

      let longResponse: PerpOrderResponse;
      let shortResponse: PerpOrderResponse;
      let longError: any = null;
      let shortError: any = null;

      try {
        // Use placeOrderPair which handles sequential vs parallel execution
        [longResponse, shortResponse] = await this.placeOrderPair(
          longAdapter,
          shortAdapter,
          longOrder,
          shortOrder,
          opportunity.longExchange,
          opportunity.shortExchange,
        );
      } catch (err: any) {
        // If placeOrderPair throws, we need to determine which order failed
        // For sequential execution, the first failure stops execution
        const errorMsg = err?.message || String(err);

        // Check if we have partial results (long succeeded, short failed)
        // This can happen in sequential execution
        if (err.longResponse) {
          longResponse = err.longResponse;
          shortError = err;
          this.logger.error(
            `❌ Failed to place SHORT order on ${opportunity.shortExchange}: ${errorMsg}`,
          );
          shortResponse = new PerpOrderResponse(
            'error',
            OrderStatus.REJECTED,
            opportunity.symbol,
            OrderSide.SHORT,
            undefined,
            undefined,
            undefined,
            errorMsg,
            new Date(),
          );
        } else {
          // Long order failed
          longError = err;
          this.logger.error(
            `❌ Failed to place LONG order on ${opportunity.longExchange}: ${errorMsg}`,
          );
          longResponse = new PerpOrderResponse(
            'error',
            OrderStatus.REJECTED,
            opportunity.symbol,
            OrderSide.LONG,
            undefined,
            undefined,
            undefined,
            errorMsg,
            new Date(),
          );
          // Short was never attempted
          shortResponse = new PerpOrderResponse(
            'not-attempted',
            OrderStatus.REJECTED,
            opportunity.symbol,
            OrderSide.SHORT,
            undefined,
            undefined,
            undefined,
            'Not attempted due to long order failure',
            new Date(),
          );
        }
      }

      if (longResponse.isSuccess() && shortResponse.isSuccess()) {
        result.opportunitiesExecuted = 1;
        result.ordersPlaced = 2;
        result.totalExpectedReturn = plan.expectedNetReturn;

        // Record trading costs (entry fees + slippage, exit fees will be recorded on close)
        if (this.performanceLogger && plan.estimatedCosts) {
          const totalCosts =
            plan.estimatedCosts.total ||
            (plan.estimatedCosts.fees || 0) +
              (plan.estimatedCosts.slippage || 0);
          this.performanceLogger.recordTradingCosts(totalCosts);
        }

        this.logger.log(
          `✅ Successfully executed arbitrage for ${opportunity.symbol}: ` +
            `Expected return: $${plan.expectedNetReturn.toFixed(4)} per period`,
        );

        return Result.success(result);
      } else {
        const longErrorMsg =
          longResponse.error || longError?.message || 'unknown';
        const shortErrorMsg =
          shortResponse.error || shortError?.message || 'unknown';

        this.logger.error(
          `❌ Order execution failed for ${opportunity.symbol}: ` +
            `LONG (${opportunity.longExchange}): ${longErrorMsg}, ` +
            `SHORT (${opportunity.shortExchange}): ${shortErrorMsg}`,
        );

        // Record single-leg failure for patterns if one leg succeeded
        if (this.diagnosticsService) {
          if (longResponse.isSuccess() && !shortResponse.isSuccess()) {
            this.diagnosticsService.recordSingleLegFailure({
              id: `sl-f-${opportunity.symbol}-${Date.now()}`,
              symbol: opportunity.symbol,
              timestamp: new Date(),
              failedLeg: 'short',
              failedExchange: opportunity.shortExchange!,
              successfulExchange: opportunity.longExchange,
              failureReason: shortResponse.status === OrderStatus.REJECTED ? 'order_rejected' : 'exchange_error',
              failureMessage: shortErrorMsg,
              timeBetweenLegsMs: 0,
            });
          } else if (!longResponse.isSuccess() && shortResponse.isSuccess()) {
            this.diagnosticsService.recordSingleLegFailure({
              id: `sl-f-${opportunity.symbol}-${Date.now()}`,
              symbol: opportunity.symbol,
              timestamp: new Date(),
              failedLeg: 'long',
              failedExchange: opportunity.longExchange,
              successfulExchange: opportunity.shortExchange!,
              failureReason: longResponse.status === OrderStatus.REJECTED ? 'order_rejected' : 'exchange_error',
              failureMessage: longErrorMsg,
              timeBetweenLegsMs: 0,
            });
          }
        }

        return Result.failure(
          new OrderExecutionException(
            `Order execution failed: Long (${opportunity.longExchange}): ${longErrorMsg}, Short (${opportunity.shortExchange}): ${shortErrorMsg}`,
            longResponse.orderId || shortResponse.orderId || 'unknown',
            opportunity.longExchange,
            {
              symbol: opportunity.symbol,
              longError: longErrorMsg,
              shortError: shortErrorMsg,
            },
          ),
        );
      }
    } catch (error: any) {
      this.logger.error(
        `❌ Unexpected error executing orders for ${opportunity.symbol}: ${error.message}`,
      );
      if (error.stack) {
        this.logger.error(`Error stack: ${error.stack}`);
      }

      // Record error to circuit breaker
      this.recordError(
        'ORDER_EXECUTION_ERROR',
        error.message,
        opportunity.longExchange,
        opportunity.symbol,
        { error: error.message },
      );

      return Result.failure(
        new OrderExecutionException(
          `Failed to execute orders: ${error.message}`,
          'unknown',
          opportunity.longExchange,
          { symbol: opportunity.symbol, error: error.message },
        ),
      );
    }
  }

  async executeMultiplePositions(
    opportunities: Array<{
      opportunity: ArbitrageOpportunity;
      plan:
        | ArbitrageExecutionPlan
        | import('./PerpSpotExecutionPlanBuilder').PerpSpotExecutionPlan
        | null;
      maxPortfolioFor35APY: number | null;
      isExisting?: boolean;
      currentValue?: number;
      currentCollateral?: number;
      additionalCollateralNeeded?: number;
    }>,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    exchangeBalances: Map<ExchangeType, number>,
    result: ArbitrageExecutionResult,
  ): Promise<
    Result<
      {
        successfulExecutions: number;
        totalOrders: number;
        totalExpectedReturn: number;
      },
      DomainException
    >
  > {
    let successfulExecutions = 0;
    let totalOrders = 0;
    let totalExpectedReturn = 0;

    // Circuit breaker check - block new position opening if circuit is OPEN
    if (this.circuitBreaker && !this.circuitBreaker.canOpenNewPosition()) {
      const state = this.circuitBreaker.getState();
      this.logger.warn(
        `🔴 Circuit breaker is ${state} - blocking all new positions (${opportunities.length} opportunities)`,
      );
      result.errors.push(
        `Circuit breaker ${state}: blocking new position opening`,
      );
      return Result.success({
        successfulExecutions: 0,
        totalOrders: 0,
        totalExpectedReturn: 0,
      });
    }

    this.logger.log(`\n🚀 Executing ${opportunities.length} positions...`);

    // Track which symbols we've locked in this batch
    const lockedSymbols: Map<string, string> = new Map(); // symbol -> threadId

    try {
      for (let i = 0; i < opportunities.length; i++) {
        const item = opportunities[i];

        if (!item.plan) {
          this.logger.warn(`Skipping ${item.opportunity.symbol}: invalid plan`);
          continue;
        }

        const { opportunity, plan } = item;

        // SYMBOL-LEVEL LOCK: Prevent concurrent execution on the same symbol
        const threadId =
          this.executionLockService?.generateThreadId() ||
          `batch-${Date.now()}-${i}`;
        if (this.executionLockService) {
          const lockAcquired = this.executionLockService.tryAcquireSymbolLock(
            opportunity.symbol,
            threadId,
            'executeMultiplePositions',
          );
          if (!lockAcquired) {
            this.logger.warn(
              `⏳ Symbol ${opportunity.symbol} is already being executed - skipping in batch`,
            );
            result.errors.push(
              `Symbol ${opportunity.symbol} locked by another execution`,
            );
            continue;
          }
          lockedSymbols.set(opportunity.symbol, threadId);
        }

        // Retry loop for this opportunity
        let executionAttempt = 0;
        let executionSuccess = false;

        while (
          executionAttempt < this.config.maxExecutionRetries &&
          !executionSuccess
        ) {
          executionAttempt++;

          try {
            // Get adapters
            if (!opportunity.shortExchange) {
              result.errors.push(
                `Missing shortExchange for ${opportunity.symbol}`,
              );
              break;
            }
            const [longAdapter, shortAdapter] = [
              adapters.get(opportunity.longExchange),
              adapters.get(opportunity.shortExchange),
            ];

            if (!longAdapter || !shortAdapter) {
              result.errors.push(`Missing adapters for ${opportunity.symbol}`);
              break;
            }

            // PRE-FLIGHT CHECK: Cancel any existing open orders for this symbol to free up margin
            try {
              const [longCancelled, shortCancelled] = await Promise.allSettled([
                longAdapter.cancelAllOrders(opportunity.symbol).catch(() => 0),
                shortAdapter.cancelAllOrders(opportunity.symbol).catch(() => 0),
              ]);
              const totalCancelled =
                (longCancelled.status === 'fulfilled'
                  ? longCancelled.value
                  : 0) +
                (shortCancelled.status === 'fulfilled'
                  ? shortCancelled.value
                  : 0);
              if (totalCancelled > 0) {
                this.logger.log(
                  `🗑️ Pre-flight: Cancelled ${totalCancelled} existing order(s) for ${opportunity.symbol}`,
                );
                await new Promise((resolve) => setTimeout(resolve, 500));
              }
            } catch (error: any) {
              this.logger.debug(
                `Pre-flight cancel failed (non-critical): ${error.message}`,
              );
            }

            // Check if this is a perp-spot plan
            if ('perpOrder' in plan && 'spotOrder' in plan) {
              // Perp-spot plan - skip for now (handled separately)
              this.logger.warn(
                `Skipping perp-spot plan for ${opportunity.symbol} in executeMultiplePositions`,
              );
              continue;
            }
            const perpPerpPlan = plan;

            // Use target leverage for margin calculations
            // Leverage is a virtual concept on these DEXs (determined by Size / Collateral)
            const leverage = perpPerpPlan.leverage ?? this.config?.leverage ?? 2;

            // PRE-FLIGHT CHECK: Verify both exchanges have sufficient margin
            // Use getAvailableMargin() which accounts for existing positions
            const [longMargin, shortMargin] = await Promise.all([
              this.getAdapterAvailableMargin(longAdapter),
              this.getAdapterAvailableMargin(shortAdapter),
            ]);

            const avgPrice =
              ((perpPerpPlan.longOrder.price || 0) +
                (perpPerpPlan.shortOrder.price || 0)) /
              2;

            // Use the SCALED maxPortfolioFor35APY from ladder allocation if available
            // This is the actual amount we want to deploy, not the original plan size
            const scaledPositionUsd =
              item.maxPortfolioFor35APY ||
              perpPerpPlan.positionSize.toUSD(avgPrice);
            const requiredMargin = scaledPositionUsd / leverage;

            // Check if we have sufficient margin
            // Note: getAvailableMargin already applies safety buffers
            const minMargin = Math.min(longMargin, shortMargin);
            if (minMargin < requiredMargin) {
              // Not enough for the scaled position - scale down to what we can afford
              const actualPositionUsd = minMargin * leverage;

              if (actualPositionUsd < this.config.minPositionSizeUsd) {
                const insufficientExchange =
                  longMargin < shortMargin
                    ? opportunity.longExchange
                    : opportunity.shortExchange;
                this.logger.warn(
                  `⚠️ Insufficient margin for ${opportunity.symbol} on ${insufficientExchange}: ` +
                    `need $${requiredMargin.toFixed(2)}, have $${minMargin.toFixed(2)} (min position: $${this.config.minPositionSizeUsd})`,
                );
                result.errors.push(
                  `Insufficient margin for ${opportunity.symbol}: need $${requiredMargin.toFixed(2)}, have $${minMargin.toFixed(2)}`,
                );
                break; // Skip this opportunity, move to next
              }

              // Scale down the position to fit available margin
              this.logger.log(
                `📉 Scaling ${opportunity.symbol} from $${scaledPositionUsd.toFixed(2)} to $${actualPositionUsd.toFixed(2)} ` +
                  `(available margin: $${minMargin.toFixed(2)})`,
              );

              // Update the maxPortfolioFor35APY to reflect actual size
              item.maxPortfolioFor35APY = actualPositionUsd;
            }

            // Calculate the actual position size to use
            // Use scaled maxPortfolioFor35APY from ladder allocation
            const actualPositionUsd =
              item.maxPortfolioFor35APY || scaledPositionUsd;
            const actualPositionBaseAsset = actualPositionUsd / avgPrice;

            // Scale the orders if the position size differs from the original plan
            const originalPositionBaseAsset =
              perpPerpPlan.positionSize.toBaseAsset();
            const scaleFactor =
              actualPositionBaseAsset / originalPositionBaseAsset;

            // Create scaled orders if needed
            let longOrder = perpPerpPlan.longOrder;
            let shortOrder = perpPerpPlan.shortOrder;

            if (Math.abs(scaleFactor - 1) > 0.01) {
              // Need to scale the orders
              const scaledSize = actualPositionBaseAsset;
              longOrder = new PerpOrderRequest(
                perpPerpPlan.longOrder.symbol,
                perpPerpPlan.longOrder.side,
                perpPerpPlan.longOrder.type,
                scaledSize,
                perpPerpPlan.longOrder.price,
                perpPerpPlan.longOrder.timeInForce,
                perpPerpPlan.longOrder.reduceOnly,
              );
              shortOrder = new PerpOrderRequest(
                perpPerpPlan.shortOrder.symbol,
                perpPerpPlan.shortOrder.side,
                perpPerpPlan.shortOrder.type,
                scaledSize,
                perpPerpPlan.shortOrder.price,
                perpPerpPlan.shortOrder.timeInForce,
                perpPerpPlan.shortOrder.reduceOnly,
              );
            }

            // Place orders using intelligent execution strategy
            this.logger.log(
              `📤 [${i + 1}/${opportunities.length}] Opening ${opportunity.symbol}: ` +
                `$${actualPositionUsd.toFixed(2)} (${actualPositionBaseAsset.toFixed(4)} size)` +
                (Math.abs(scaleFactor - 1) > 0.01
                  ? ` [scaled ${(scaleFactor * 100).toFixed(0)}%]`
                  : '') +
                (executionAttempt > 1
                  ? ` [Attempt ${executionAttempt}/${this.config.maxExecutionRetries}]`
                  : ''),
            );

            // Use placeOrderPair which handles sequential vs parallel execution
            const [longResponse, shortResponse] = await this.placeOrderPair(
              longAdapter,
              shortAdapter,
              longOrder,
              shortOrder,
              opportunity.longExchange,
              opportunity.shortExchange,
            );

            // Wait for orders to fill if they're not immediately filled
            // CRITICAL: For Lighter orders, always check status even if marked as SUBMITTED,
            // as they may be immediately canceled by the system
            let finalLongResponse = longResponse;
            let finalShortResponse = shortResponse;

            // Always check Lighter orders - they're never immediately filled and may be canceled
            const longIsLighter =
              opportunity.longExchange === ExchangeType.LIGHTER;
            const shortIsLighter =
              opportunity.shortExchange === ExchangeType.LIGHTER;

            if (
              (!longResponse.isFilled() || longIsLighter) &&
              longResponse.orderId
            ) {
              finalLongResponse = await this.waitForOrderFill(
                longAdapter,
                longResponse.orderId,
                opportunity.symbol,
                opportunity.longExchange,
                actualPositionBaseAsset,
                this.config.maxOrderWaitRetries,
                this.config.orderWaitBaseInterval,
                false,
                'LONG',
                longOrder.price,
                longOrder.reduceOnly
              );
            }

            if (
              (!shortResponse.isFilled() || shortIsLighter) &&
              shortResponse.orderId
            ) {
              finalShortResponse = await this.waitForOrderFill(
                shortAdapter,
                shortResponse.orderId,
                opportunity.symbol,
                opportunity.shortExchange,
                actualPositionBaseAsset,
                this.config.maxOrderWaitRetries,
                this.config.orderWaitBaseInterval,
                false,
                'SHORT',
                shortOrder.price,
                shortOrder.reduceOnly
              );
            }

            // Check if both orders succeeded
            const longIsGTC =
              perpPerpPlan.longOrder.timeInForce === TimeInForce.GTC;
            const shortIsGTC =
              perpPerpPlan.shortOrder.timeInForce === TimeInForce.GTC;

            // Check if orders were canceled (especially for Lighter)
            const longCanceled =
              finalLongResponse.status === OrderStatus.CANCELLED ||
              (finalLongResponse.error &&
                finalLongResponse.error.toLowerCase().includes('cancel'));
            const shortCanceled =
              finalShortResponse.status === OrderStatus.CANCELLED ||
              (finalShortResponse.error &&
                finalShortResponse.error.toLowerCase().includes('cancel'));

            // If an order was canceled, treat it as failed and retry
            if (longCanceled || shortCanceled) {
              this.logger.warn(
                `⚠️ Order canceled for ${opportunity.symbol}: ` +
                  `Long: ${longCanceled ? 'CANCELED' : 'OK'}, ` +
                  `Short: ${shortCanceled ? 'CANCELED' : 'OK'}. ` +
                  `Will retry...`,
              );

              // Treat canceled orders as failures - will trigger retry below
              if (executionAttempt < this.config.maxExecutionRetries) {
                const delayIndex = executionAttempt - 1;
                const retryDelay =
                  this.config.executionRetryDelays[delayIndex] ||
                  this.config.executionRetryDelays[
                    this.config.executionRetryDelays.length - 1
                  ];

                this.logger.warn(
                  `⚠️ Retrying ${opportunity.symbol} after order cancellation in ${retryDelay / 1000}s... ` +
                    `(attempt ${executionAttempt}/${this.config.maxExecutionRetries})`,
                );

                await new Promise((resolve) => setTimeout(resolve, retryDelay));
                continue; // Retry the order placement
              } else {
                result.errors.push(
                  `Order canceled for ${opportunity.symbol} after ${executionAttempt} attempts`,
                );
                break; // Max retries reached
              }
            }

            const longSuccess =
              finalLongResponse.isSuccess() &&
              (finalLongResponse.isFilled() ||
                (longIsGTC &&
                  finalLongResponse.status === OrderStatus.SUBMITTED));
            const shortSuccess =
              finalShortResponse.isSuccess() &&
              (finalShortResponse.isFilled() ||
                (shortIsGTC &&
                  finalShortResponse.status === OrderStatus.SUBMITTED));

            if (longSuccess && shortSuccess) {
              // Handle asymmetric fills
              const longFilled = finalLongResponse.filledSize || 0;
              const shortFilled = finalShortResponse.filledSize || 0;
              const positionSizeBase = perpPerpPlan.positionSize.toBaseAsset();
              const longFullyFilled = longFilled >= positionSizeBase - 0.0001;
              const shortFullyFilled = shortFilled >= positionSizeBase - 0.0001;
              const longOnBook =
                longIsGTC &&
                finalLongResponse.status === OrderStatus.SUBMITTED &&
                !longFullyFilled;
              const shortOnBook =
                shortIsGTC &&
                finalShortResponse.status === OrderStatus.SUBMITTED &&
                !shortFullyFilled;

              const asymmetricFill =
                (longFullyFilled && shortOnBook) ||
                (shortFullyFilled && longOnBook);

              if (asymmetricFill) {
                // Handle asymmetric fill immediately via position manager
                // Immediate handling reduces exposure time from 2 minutes to seconds
                const fill: AsymmetricFill = {
                  symbol: opportunity.symbol,
                  longFilled: longFullyFilled,
                  shortFilled: shortFullyFilled,
                  longOrderId: longResponse.orderId,
                  shortOrderId: shortResponse.orderId,
                  longExchange: opportunity.longExchange,
                  shortExchange: opportunity.shortExchange,
                  positionSize: perpPerpPlan.positionSize.toBaseAsset(),
                  opportunity,
                  timestamp: new Date(),
                };
                await this.positionManager.handleAsymmetricFills(
                  adapters,
                  [fill],
                  result,
                  true,
                ); // immediate=true
              }

              successfulExecutions++;
              totalOrders += 2;
              totalExpectedReturn += perpPerpPlan.expectedNetReturn;

              // Record success to circuit breaker
              this.recordSuccess();

              // Record trading costs (entry fees + slippage, exit fees will be recorded on close)
              if (this.performanceLogger && perpPerpPlan.estimatedCosts) {
                const totalCosts =
                  perpPerpPlan.estimatedCosts.total ||
                  (perpPerpPlan.estimatedCosts.fees || 0) +
                    (perpPerpPlan.estimatedCosts.slippage || 0);
                this.performanceLogger.recordTradingCosts(totalCosts);
              }

              // Record break-even info for diagnostics
              if (this.diagnosticsService && perpPerpPlan.estimatedCosts) {
                const totalCosts = perpPerpPlan.estimatedCosts.total || 0;
                const hourlyReturn = Math.abs(perpPerpPlan.expectedNetReturn);
                const breakEvenHours =
                  hourlyReturn > 0 ? totalCosts / hourlyReturn : 24;
                this.diagnosticsService.recordPositionBreakEven(
                  opportunity.symbol,
                  opportunity.longExchange,
                  breakEvenHours,
                  totalCosts,
                  hourlyReturn,
                );
              }

              this.logger.log(
                `✅ [${i + 1}/${opportunities.length}] ${opportunity.symbol}: ` +
                  `$${perpPerpPlan.expectedNetReturn.toFixed(4)}/period`,
              );

              executionSuccess = true;
            } else {
              // One or both orders failed - CRITICAL: Check if one leg filled
              const longFilled =
                finalLongResponse.isFilled() && finalLongResponse.isSuccess();
              const shortFilled =
                finalShortResponse.isFilled() && finalShortResponse.isSuccess();

              if (longFilled || shortFilled) {
                // CRITICAL SAFETY: One leg filled but other failed - close filled position immediately
                // This prevents price exposure from single-leg positions
                this.logger.error(
                  `🚨 CRITICAL: Single leg filled for ${opportunity.symbol}! ` +
                    `Long: ${longFilled ? 'FILLED' : 'FAILED'}, ` +
                    `Short: ${shortFilled ? 'FILLED' : 'FAILED'}. ` +
                    `Closing filled position to prevent price exposure...`,
                );

                if (longFilled) {
                  const closeResult =
                    await this.positionManager.closeFilledPosition(
                      longAdapter,
                      opportunity.symbol,
                      'LONG',
                      perpPerpPlan.positionSize.toBaseAsset(),
                      opportunity.longExchange,
                      result,
                    );
                  if (closeResult.isFailure) {
                    this.logger.error(
                      `CRITICAL: Failed to close filled LONG position for ${opportunity.symbol}! ` +
                        `Position remains open - MANUAL INTERVENTION REQUIRED!`,
                    );
                  }
                }

                if (shortFilled) {
                  const closeResult =
                    await this.positionManager.closeFilledPosition(
                      shortAdapter,
                      opportunity.symbol,
                      'SHORT',
                      perpPerpPlan.positionSize.toBaseAsset(),
                      opportunity.shortExchange,
                      result,
                    );
                  if (closeResult.isFailure) {
                    this.logger.error(
                      `CRITICAL: Failed to close filled SHORT position for ${opportunity.symbol}! ` +
                        `Position remains open - MANUAL INTERVENTION REQUIRED!`,
                    );
                  }
                }

                result.errors.push(
                  `Single leg execution for ${opportunity.symbol} - filled position closed`,
                );
                executionSuccess = true; // Don't retry - we've closed the position
              } else if (executionAttempt < this.config.maxExecutionRetries) {
                // Both failed - safe to retry
                const delayIndex = executionAttempt - 1;
                const retryDelay =
                  this.config.executionRetryDelays[delayIndex] ||
                  this.config.executionRetryDelays[
                    this.config.executionRetryDelays.length - 1
                  ];

                this.logger.warn(
                  `⚠️ Error executing ${opportunity.symbol}: Retrying in ${retryDelay / 1000}s... ` +
                    `(attempt ${executionAttempt}/${this.config.maxExecutionRetries})`,
                );

                await new Promise((resolve) => setTimeout(resolve, retryDelay));
              } else {
                result.errors.push(
                  `Error executing ${opportunity.symbol} after ${executionAttempt} attempts`,
                );
                executionSuccess = true; // Stop retrying
              }
            }
          } catch (error: any) {
            if (executionAttempt < this.config.maxExecutionRetries) {
              const delayIndex = executionAttempt - 1;
              const retryDelay =
                this.config.executionRetryDelays[delayIndex] ||
                this.config.executionRetryDelays[
                  this.config.executionRetryDelays.length - 1
                ];

              this.logger.warn(
                `⚠️ Error executing ${item.opportunity.symbol}: ${error.message}. ` +
                  `Retrying in ${retryDelay / 1000}s... (attempt ${executionAttempt}/${this.config.maxExecutionRetries})`,
              );

              await new Promise((resolve) => setTimeout(resolve, retryDelay));
            } else {
              result.errors.push(
                `Error executing ${item.opportunity.symbol} after ${executionAttempt} attempts: ${error.message}`,
              );
              executionSuccess = true; // Stop retrying
            }
          }
        }
      }

      this.logger.log(
        `✅ Execution: ${successfulExecutions}/${opportunities.length} positions, ` +
          `$${totalExpectedReturn.toFixed(2)}/period expected`,
      );

      return Result.success({
        successfulExecutions,
        totalOrders,
        totalExpectedReturn,
      });
    } catch (error: any) {
      this.logger.error(
        `Failed to execute multiple positions: ${error.message}`,
      );
      return Result.failure(
        new DomainException(
          `Failed to execute multiple positions: ${error.message}`,
          'EXECUTION_ERROR',
          { error: error.message, opportunitiesCount: opportunities.length },
        ),
      );
    } finally {
      // Release all symbol locks acquired in this batch
      if (this.executionLockService) {
        for (const [symbol, threadId] of lockedSymbols.entries()) {
          this.executionLockService.releaseSymbolLock(symbol, threadId);
        }
      }
    }
  }

  /**
   * Calculate total wait time for exponential backoff
   */
  private calculateTotalWaitTime(
    maxRetries: number,
    baseInterval: number,
    isClosing: boolean,
  ): number {
    let total = 0;
    const maxBackoff = isClosing
      ? this.config.maxBackoffDelayClosing
      : this.config.maxBackoffDelayOpening;

    for (let i = 1; i < maxRetries; i++) {
      const exponentialDelay = baseInterval * Math.pow(2, i - 1);
      total += Math.min(exponentialDelay, maxBackoff);
    }

    return total;
  }
}
