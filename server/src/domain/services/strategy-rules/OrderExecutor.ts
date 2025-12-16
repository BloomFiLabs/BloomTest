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
import { CircuitBreakerService, CircuitState } from '../../../infrastructure/services/CircuitBreakerService';

/**
 * Order executor for funding arbitrage strategy
 * Handles order placement, waiting for fills, and managing multiple positions
 */
@Injectable()
export class OrderExecutor implements IOrderExecutor {
  private readonly logger = new Logger(OrderExecutor.name);

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
  ) {}

  /**
   * Record an error to diagnostics service and circuit breaker
   */
  private recordError(type: string, message: string, exchange?: ExchangeType, symbol?: string, context?: Record<string, any>): void {
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
   * Get available margin from an adapter
   * Uses getAvailableMargin() if available, falls back to getBalance() with buffer
   * 
   * This prevents "not enough margin" errors by using a more accurate margin calculation
   * that accounts for existing positions and applies safety buffers.
   */
  private async getAdapterAvailableMargin(adapter: IPerpExchangeAdapter): Promise<number> {
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
    // Determine if sequential execution is required
    const requiresSequential = 
      longExchange === shortExchange ||
      longExchange === ExchangeType.LIGHTER ||
      shortExchange === ExchangeType.LIGHTER;

    if (requiresSequential) {
      this.logger.debug(
        `📋 Sequential order placement for ${longOrder.symbol}: ` +
        `${longExchange} -> ${shortExchange} (Lighter or same exchange)`
      );
      
      // Execute sequentially - long first, then short
      const longResponse = await longAdapter.placeOrder(longOrder);
      const shortResponse = await shortAdapter.placeOrder(shortOrder);
      return [longResponse, shortResponse];
    }

    // Different exchanges (non-Lighter) can be executed in parallel
    this.logger.debug(
      `📋 Parallel order placement for ${longOrder.symbol}: ` +
      `${longExchange} || ${shortExchange}`
    );
    
    return Promise.all([
      longAdapter.placeOrder(longOrder),
      shortAdapter.placeOrder(shortOrder),
    ]);
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
  ): Promise<PerpOrderResponse> {
    const operationType = isClosingPosition ? 'CLOSE' : 'OPEN';
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
    
    this.recordError(
      'ORDER_FILL_TIMEOUT',
      `${operationType} order did not fill after ${maxRetries} attempts (~${Math.round(totalTime / 1000)}s)`,
      exchangeType,
      symbol,
      { orderId, maxRetries, totalTimeMs: totalTime },
    );

    // Return a response indicating the order is still pending
    return new PerpOrderResponse(
      orderId,
      OrderStatus.SUBMITTED,
      symbol,
      OrderSide.LONG,
      undefined,
      undefined,
      undefined,
      `Order did not fill within ${Math.round(totalTime / 1000)} seconds`,
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

    // Circuit breaker check - block new position opening if circuit is OPEN
    if (this.circuitBreaker && !this.circuitBreaker.canOpenNewPosition()) {
      const state = this.circuitBreaker.getState();
      this.logger.warn(
        `🔴 Circuit breaker is ${state} - blocking new position for ${opportunity.symbol}`
      );
      result.errors.push(`Circuit breaker ${state}: blocking new position opening`);
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

    // PRE-FLIGHT CHECK: Scale position to available capital
    // Use getAvailableMargin() which accounts for existing positions and applies safety buffers
    try {
      const [longMargin, shortMargin] = await Promise.all([
        this.getAdapterAvailableMargin(longAdapter),
        this.getAdapterAvailableMargin(shortAdapter),
      ]);
      const avgPrice =
        ((plan.longOrder.price || 0) + (plan.shortOrder.price || 0)) / 2;
      const leverage = this.config?.leverage || 2;
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

      // Place orders (inside try block to use scaled orders)
      const scaledSizeBaseAsset = longOrder.size;
      this.logger.log(
        `📤 Executing orders for ${opportunity.symbol}: ` +
          `LONG ${scaledSizeBaseAsset.toFixed(4)} ($${actualPositionUsd.toFixed(2)}) on ${opportunity.longExchange}, ` +
          `SHORT ${scaledSizeBaseAsset.toFixed(4)} ($${actualPositionUsd.toFixed(2)}) on ${opportunity.shortExchange}`,
      );

      // Place orders with intelligent execution strategy (sequential for Lighter, parallel otherwise)
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
          opportunity.shortExchange!,
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
          longResponse.error || (longError as any)?.message || 'unknown';
        const shortErrorMsg =
          shortResponse.error || (shortError as any)?.message || 'unknown';

        this.logger.error(
          `❌ Order execution failed for ${opportunity.symbol}: ` +
            `LONG (${opportunity.longExchange}): ${longErrorMsg}, ` +
            `SHORT (${opportunity.shortExchange}): ${shortErrorMsg}`,
        );

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
        `🔴 Circuit breaker is ${state} - blocking all new positions (${opportunities.length} opportunities)`
      );
      result.errors.push(`Circuit breaker ${state}: blocking new position opening`);
      return Result.success({
        successfulExecutions: 0,
        totalOrders: 0,
        totalExpectedReturn: 0,
      });
    }

    this.logger.log(`\n🚀 Executing ${opportunities.length} positions...`);

    try {
      for (let i = 0; i < opportunities.length; i++) {
        const item = opportunities[i];

        if (!item.plan) {
          this.logger.warn(`Skipping ${item.opportunity.symbol}: invalid plan`);
          continue;
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
            const { opportunity, plan } = item;

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

            // PRE-FLIGHT CHECK: Verify both exchanges have sufficient margin
            // Use getAvailableMargin() which accounts for existing positions
            const [longMargin, shortMargin] = await Promise.all([
              this.getAdapterAvailableMargin(longAdapter),
              this.getAdapterAvailableMargin(shortAdapter),
            ]);
            // Check if this is a perp-spot plan
            if ('perpOrder' in plan && 'spotOrder' in plan) {
              // Perp-spot plan - skip for now (handled separately)
              this.logger.warn(
                `Skipping perp-spot plan for ${opportunity.symbol} in executeMultiplePositions`,
              );
              continue;
            }
            const perpPerpPlan = plan as ArbitrageExecutionPlan;
            const avgPrice =
              ((perpPerpPlan.longOrder.price || 0) +
                (perpPerpPlan.shortOrder.price || 0)) /
              2;

            // Use the SCALED maxPortfolioFor35APY from ladder allocation if available
            // This is the actual amount we want to deploy, not the original plan size
            const scaledPositionUsd =
              item.maxPortfolioFor35APY ||
              perpPerpPlan.positionSize.toUSD(avgPrice);
            const leverage = this.config?.leverage || 2;
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
              opportunity.shortExchange!,
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
                  shortExchange: opportunity.shortExchange!,
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
                      opportunity.shortExchange!,
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
