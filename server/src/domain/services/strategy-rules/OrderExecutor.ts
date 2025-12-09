import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { IOrderExecutor } from './IOrderExecutor';
import type { IPositionManager } from './IPositionManager';
import type { AsymmetricFill } from './IPositionManager';
import { PositionManager } from './PositionManager';
import { CostCalculator } from './CostCalculator';
import { ExecutionPlanBuilder } from './ExecutionPlanBuilder';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import {
  ArbitrageExecutionPlan,
  ArbitrageExecutionResult,
} from '../FundingArbitrageStrategy';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import {
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
} from '../../exceptions/DomainException';

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
  ) {}

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

    this.logger.log(
      `⏳ Waiting for ${operationType} order ${orderId} to fill on ${exchangeType} (${symbol})...`,
    );

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

    this.logger.log(
      `🎯 Executing single best opportunity: ${opportunity.symbol} ` +
        `(Expected net return: $${plan.expectedNetReturn.toFixed(4)} per period)`,
    );

    // Get adapters
    const [longAdapter, shortAdapter] = [
      adapters.get(opportunity.longExchange),
      adapters.get(opportunity.shortExchange),
    ];

    if (!longAdapter || !shortAdapter) {
      const missingExchange = !longAdapter
        ? opportunity.longExchange
        : opportunity.shortExchange;
      return Result.failure(
        new ExchangeException(
          `Missing adapter for ${missingExchange}`,
          missingExchange,
          { symbol: opportunity.symbol },
        ),
      );
    }

    // Place orders
    this.logger.log(
      `📤 Executing orders for ${opportunity.symbol}: ` +
        `LONG ${plan.positionSize.toBaseAsset().toFixed(4)} on ${opportunity.longExchange}, ` +
        `SHORT ${plan.positionSize.toBaseAsset().toFixed(4)} on ${opportunity.shortExchange}`,
    );

    try {
      const [longResponse, shortResponse] = await Promise.all([
        longAdapter.placeOrder(plan.longOrder),
        shortAdapter.placeOrder(plan.shortOrder),
      ]);

      if (longResponse.isSuccess() && shortResponse.isSuccess()) {
        result.opportunitiesExecuted = 1;
        result.ordersPlaced = 2;
        result.totalExpectedReturn = plan.expectedNetReturn;

        this.logger.log(
          `✅ Successfully executed arbitrage for ${opportunity.symbol}: ` +
            `Expected return: $${plan.expectedNetReturn.toFixed(4)} per period`,
        );

        return Result.success(result);
      } else {
        const longError = longResponse.error || 'unknown';
        const shortError = shortResponse.error || 'unknown';
        return Result.failure(
          new OrderExecutionException(
            `Order execution failed: Long: ${longError}, Short: ${shortError}`,
            longResponse.orderId || shortResponse.orderId || 'unknown',
            opportunity.longExchange,
            { symbol: opportunity.symbol, longError, shortError },
          ),
        );
      }
    } catch (error: any) {
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
      plan: ArbitrageExecutionPlan | null;
      maxPortfolioFor35APY: number | null;
      isExisting?: boolean;
      currentValue?: number;
      currentCollateral?: number;
      additionalCollateralNeeded?: number;
    }>,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    exchangeBalances: Map<ExchangeType, number>,
    result: ArbitrageExecutionResult,
  ): Promise<Result<{
    successfulExecutions: number;
    totalOrders: number;
    totalExpectedReturn: number;
  }, DomainException>> {
    let successfulExecutions = 0;
    let totalOrders = 0;
    let totalExpectedReturn = 0;

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
          const [longAdapter, shortAdapter] = [
            adapters.get(opportunity.longExchange),
            adapters.get(opportunity.shortExchange),
          ];

          if (!longAdapter || !shortAdapter) {
            result.errors.push(`Missing adapters for ${opportunity.symbol}`);
            break;
          }

          // Place orders
          this.logger.log(
            `📤 [${i + 1}/${opportunities.length}] Opening ${opportunity.symbol}: ` +
              `${plan.positionSize.toBaseAsset().toFixed(4)} size` +
              (executionAttempt > 1
                ? ` [Attempt ${executionAttempt}/${this.config.maxExecutionRetries}]`
                : ''),
          );

          const [longResponse, shortResponse] = await Promise.all([
            longAdapter.placeOrder(plan.longOrder),
            shortAdapter.placeOrder(plan.shortOrder),
          ]);

          // Wait for orders to fill if they're not immediately filled
          let finalLongResponse = longResponse;
          let finalShortResponse = shortResponse;

          if (!longResponse.isFilled() && longResponse.orderId) {
            finalLongResponse = await this.waitForOrderFill(
              longAdapter,
              longResponse.orderId,
              opportunity.symbol,
              opportunity.longExchange,
              plan.positionSize.toBaseAsset(),
              this.config.maxOrderWaitRetries,
              this.config.orderWaitBaseInterval,
              false,
            );
          }

          if (!shortResponse.isFilled() && shortResponse.orderId) {
            finalShortResponse = await this.waitForOrderFill(
              shortAdapter,
              shortResponse.orderId,
              opportunity.symbol,
              opportunity.shortExchange,
              plan.positionSize.toBaseAsset(),
              this.config.maxOrderWaitRetries,
              this.config.orderWaitBaseInterval,
              false,
            );
          }

          // Check if both orders succeeded
          const longIsGTC = plan.longOrder.timeInForce === TimeInForce.GTC;
          const shortIsGTC = plan.shortOrder.timeInForce === TimeInForce.GTC;
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
            const positionSizeBase = plan.positionSize.toBaseAsset();
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
              // Handle asymmetric fill via position manager
              const fill: AsymmetricFill = {
                symbol: opportunity.symbol,
                longFilled: longFullyFilled,
                shortFilled: shortFullyFilled,
                longOrderId: longResponse.orderId,
                shortOrderId: shortResponse.orderId,
                longExchange: opportunity.longExchange,
                shortExchange: opportunity.shortExchange,
                positionSize: plan.positionSize.toBaseAsset(),
                opportunity,
                timestamp: new Date(),
              };
              await this.positionManager.handleAsymmetricFills(adapters, [fill], result);
            }

            successfulExecutions++;
            totalOrders += 2;
            totalExpectedReturn += plan.expectedNetReturn;

            this.logger.log(
              `✅ [${i + 1}/${opportunities.length}] ${opportunity.symbol}: ` +
                `$${plan.expectedNetReturn.toFixed(4)}/period`,
            );

            executionSuccess = true;
          } else {
            // One or both orders failed - CRITICAL: Check if one leg filled
            const longFilled = finalLongResponse.isFilled() && finalLongResponse.isSuccess();
            const shortFilled = finalShortResponse.isFilled() && finalShortResponse.isSuccess();
            
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
                const closeResult = await this.positionManager.closeFilledPosition(
                  longAdapter,
                  opportunity.symbol,
                  'LONG',
                  plan.positionSize.toBaseAsset(),
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
                const closeResult = await this.positionManager.closeFilledPosition(
                  shortAdapter,
                  opportunity.symbol,
                  'SHORT',
                  plan.positionSize.toBaseAsset(),
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
      this.logger.error(`Failed to execute multiple positions: ${error.message}`);
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
