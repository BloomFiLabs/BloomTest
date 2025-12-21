import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import {
  ArbitrageExecutionPlan,
  ArbitrageExecutionResult,
} from '../FundingArbitrageStrategy';
import { PerpPosition } from '../../entities/PerpPosition';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import {
  OrderSide,
  OrderType,
  TimeInForce,
  PerpOrderRequest,
} from '../../value-objects/PerpOrder';
import { Result } from '../../common/Result';
import { DomainException } from '../../exceptions/DomainException';
import { ExecutionPlanBuilder } from './ExecutionPlanBuilder';
import { ExecutionLockService } from '../../../infrastructure/services/ExecutionLockService';

/**
 * Single-leg retry tracking info
 */
export interface SingleLegRetryInfo {
  retryCount: number;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  opportunity: ArbitrageOpportunity;
  lastRetryTime: Date;
}

/**
 * SingleLegHandler - Handles single-leg position detection, retry, and closure
 *
 * Single-leg positions occur when one side of an arbitrage pair fails to fill.
 * This creates price exposure that must be resolved by either:
 * 1. Opening the missing side (retry)
 * 2. Closing the existing side (give up)
 */
@Injectable()
export class SingleLegHandler {
  private readonly logger = new Logger(SingleLegHandler.name);

  // Grace period before placing duplicate orders
  private readonly PENDING_ORDER_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly strategyConfig: StrategyConfig,
    private readonly executionPlanBuilder: ExecutionPlanBuilder,
    private readonly executionLockService?: ExecutionLockService,
  ) {}

  /**
   * Handle all single-leg positions
   * Attempts to open missing side, or closes if retries exhausted
   */
  async handleSingleLegPositions(
    singleLegPositions: PerpPosition[],
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    singleLegRetries: Map<string, SingleLegRetryInfo>,
    filteredOpportunities: Map<string, Date>,
    filterExpiryMs: number,
    result: ArbitrageExecutionResult,
    getLeverageForSymbol: (
      symbol: string,
      exchange: ExchangeType,
    ) => Promise<number>,
  ): Promise<{
    stillSingleLeg: PerpPosition[];
    closedPositions: PerpPosition[];
  }> {
    const closedPositions: PerpPosition[] = [];

    this.logger.warn(
      `⚠️ Detected ${singleLegPositions.length} single-leg position(s). Attempting to open missing side...`,
    );

    for (const singleLegPos of singleLegPositions) {
      const retryResult = await this.handleSingleLegPosition(
        singleLegPos,
        adapters,
        singleLegRetries,
        filteredOpportunities,
        filterExpiryMs,
        result,
        getLeverageForSymbol,
      );

      if (retryResult.closed) {
        closedPositions.push(singleLegPos);
      }
    }

    // Check which positions are still single-leg after retry attempts
    const stillSingleLeg = singleLegPositions.filter(
      (p) => !closedPositions.includes(p),
    );

    return { stillSingleLeg, closedPositions };
  }

  /**
   * Handle a single single-leg position
   */
  private async handleSingleLegPosition(
    position: PerpPosition,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    singleLegRetries: Map<string, SingleLegRetryInfo>,
    filteredOpportunities: Map<string, Date>,
    filterExpiryMs: number,
    result: ArbitrageExecutionResult,
    getLeverageForSymbol: (
      symbol: string,
      exchange: ExchangeType,
    ) => Promise<number>,
  ): Promise<{ success: boolean; closed: boolean }> {
    // Find retry info by matching symbol and exchange
    let retryInfo: SingleLegRetryInfo | undefined;
    let retryKey: string | undefined;

    for (const [key, info] of singleLegRetries.entries()) {
      if (
        info.opportunity.symbol === position.symbol &&
        (info.longExchange === position.exchangeType ||
          info.shortExchange === position.exchangeType)
      ) {
        retryInfo = info;
        retryKey = key;
        break;
      }
    }

    if (retryInfo && retryKey && retryInfo.retryCount < 5) {
      // Determine missing side
      const missingExchange =
        position.side === OrderSide.LONG
          ? retryInfo.shortExchange
          : retryInfo.longExchange;
      const missingSide =
        position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;

      // SAFETY CHECK: Ensure we're not placing on the same exchange as existing position
      if (missingExchange === position.exchangeType) {
        this.logger.error(
          `🚨 BUG DETECTED: Attempted to place ${missingSide} on same exchange (${missingExchange}) ` +
          `as existing ${position.side} position for ${position.symbol}. Closing single-leg instead.`
        );
        await this.closeSingleLegPosition(position, adapters, result);
        return { success: false, closed: true };
      }

      this.logger.log(
        `🔄 Retry ${retryInfo.retryCount + 1}/5: Attempting to open missing ${missingSide} side ` +
          `for ${position.symbol} on ${missingExchange}...`,
      );

      const retrySuccess = await this.retryOpenMissingSide(
        retryInfo.opportunity,
        missingExchange,
        missingSide,
        adapters,
        getLeverageForSymbol,
      );

      if (retrySuccess) {
        this.logger.log(
          `✅ Successfully opened missing ${missingSide} side for ${position.symbol} on ${missingExchange}`,
        );
        singleLegRetries.delete(retryKey);
        return { success: true, closed: false };
      } else {
        // Increment retry count
        retryInfo.retryCount++;
        retryInfo.lastRetryTime = new Date();
        this.logger.warn(
          `⚠️ Retry ${retryInfo.retryCount}/5 failed for ${position.symbol}. Will try again next cycle.`,
        );

        // After 5 retries, filter out this opportunity
        if (retryInfo.retryCount >= 5) {
          const filterKey = this.getFilterKey(
            retryInfo.opportunity.symbol,
            retryInfo.longExchange,
            retryInfo.shortExchange,
          );
          filteredOpportunities.set(filterKey, new Date());
          this.logger.error(
            `❌ Filtering out ${retryInfo.opportunity.symbol} after 5 failed retry attempts. ` +
              `Will retry in ${filterExpiryMs / 60000} minutes.`,
          );

          // Close the single-leg position
          await this.closeSingleLegPosition(position, adapters, result);
          return { success: false, closed: true };
        }
      }
    } else {
      // No retry info or already exceeded retries - close the position
      this.logger.error(
        `🚨 Closing single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType} ` +
          `- no retry info or exceeded retry limit`,
      );
      await this.closeSingleLegPosition(position, adapters, result);
      return { success: false, closed: true };
    }

    return { success: false, closed: false };
  }

  /**
   * Try to open the missing side of a single-leg position
   */
  async retryOpenMissingSide(
    opportunity: ArbitrageOpportunity,
    missingExchange: ExchangeType,
    missingSide: OrderSide,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    getLeverageForSymbol: (
      symbol: string,
      exchange: ExchangeType,
    ) => Promise<number>,
  ): Promise<boolean> {
    try {
      const adapter = adapters.get(missingExchange);
      if (!adapter) {
        this.logger.warn(`No adapter found for ${missingExchange}`);
        return false;
      }

      // Check for existing pending orders before placing new ones
      const hasPendingOrders = await this.checkForPendingOrders(
        adapter,
        opportunity.symbol,
        missingSide,
        missingExchange,
      );

      if (hasPendingOrders) {
        return false; // Don't place new order, but don't exhaust retries
      }

      // Create execution plan for the missing side
      const leverage = await getLeverageForSymbol(
        opportunity.symbol,
        opportunity.longExchange,
      );

      const planResult = await this.executionPlanBuilder.buildPlan(
        opportunity,
        adapters,
        {
          longBalance: 1000000, // Use large balance to allow execution
          shortBalance: 1000000,
        },
        this.strategyConfig,
        undefined,
        undefined,
        undefined,
        leverage,
      );

      if (planResult.isFailure) {
        this.logger.warn(
          `Failed to create execution plan for missing side: ${planResult.error.message}`,
        );
        return false;
      }

      const plan = planResult.value;

      // Check if this is a perp-spot plan (not supported for single-leg retry)
      if ('perpOrder' in plan) {
        this.logger.warn(
          `Cannot retry single leg for perp-spot strategy: ${opportunity.symbol}`,
        );
        return false;
      }

      // Perp-perp plan
      const perpPerpPlan = plan;
      const orderRequest =
        missingSide === OrderSide.LONG
          ? perpPerpPlan.longOrder
          : perpPerpPlan.shortOrder;

      const threadId = this.executionLockService?.generateThreadId() || `single-leg-${Date.now()}`;

      // SYMBOL-LEVEL LOCK: Prevent concurrent execution on the same symbol
      if (this.executionLockService) {
        const lockAcquired = this.executionLockService.tryAcquireSymbolLock(
          opportunity.symbol,
          threadId,
          'tryOpenMissingSide'
        );
        
        if (!lockAcquired) {
          this.logger.warn(`⏳ Symbol ${opportunity.symbol} is already being executed - skipping single-leg retry`);
          return false;
        }
      }

      try {
        // Check for active order
        if (this.executionLockService) {
          const isLocked = this.executionLockService.hasActiveOrder(missingExchange, opportunity.symbol, missingSide);
          if (isLocked) {
            this.logger.debug(`⚠️ Skipping single-leg retry for ${opportunity.symbol} ${missingSide} on ${missingExchange}: order already active`);
            return false;
          }
        }

        // Register order
        if (this.executionLockService) {
          this.executionLockService.registerOrderPlacing(
            `retry-${opportunity.symbol}-${missingSide}-${Date.now()}`,
            opportunity.symbol,
            missingExchange,
            missingSide,
            threadId,
            orderRequest.size,
            orderRequest.price
          );
        }

        // Place the order
        const orderResult = await adapter.placeOrder(orderRequest);

        if (orderResult && orderResult.orderId) {
          if (this.executionLockService) {
            this.executionLockService.updateOrderStatus(
              missingExchange,
              opportunity.symbol,
              missingSide,
              orderResult.isFilled() ? 'FILLED' : 'WAITING_FILL',
              orderResult.orderId,
              orderRequest.price
            );
          }
          this.logger.log(
            `✅ Successfully placed ${missingSide} order for ${opportunity.symbol} on ${missingExchange}: ${orderResult.orderId}`,
          );
          return true;
        } else {
          if (this.executionLockService) {
            this.executionLockService.updateOrderStatus(
              missingExchange,
              opportunity.symbol,
              missingSide,
              'FAILED'
            );
          }
          this.logger.warn(
            `Failed to place ${missingSide} order for ${opportunity.symbol} on ${missingExchange}`,
          );
          return false;
        }
      } finally {
        if (this.executionLockService) {
          this.executionLockService.releaseSymbolLock(opportunity.symbol, threadId);
        }
      }
    } catch (error: any) {
      this.logger.warn(
        `Error retrying missing side for ${opportunity.symbol}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Check for existing pending orders to prevent duplicates
   */
  private async checkForPendingOrders(
    adapter: IPerpExchangeAdapter,
    symbol: string,
    missingSide: OrderSide,
    exchange: ExchangeType,
  ): Promise<boolean> {
    if (typeof (adapter as any).getOpenOrders !== 'function') {
      return false;
    }

    try {
      const openOrders = await (adapter as any).getOpenOrders();
      const pendingOrdersForSymbol = openOrders.filter((order: any) => {
        // Match by symbol
        const normalizedOrderSymbol = order.symbol
          ?.toUpperCase()
          ?.replace('-USD', '')
          ?.replace('USD', '');
        const normalizedSymbol = symbol
          ?.toUpperCase()
          ?.replace('-USD', '')
          ?.replace('USD', '');

        // Normalize side
        const orderSide = order.side?.toUpperCase();
        const isOrderLong =
          orderSide === 'LONG' || orderSide === 'BUY' || orderSide === 'B';
        const isOrderShort =
          orderSide === 'SHORT' || orderSide === 'SELL' || orderSide === 'S';
        const isMissingSideLong = missingSide === OrderSide.LONG;

        const sideMatches =
          (isMissingSideLong && isOrderLong) ||
          (!isMissingSideLong && isOrderShort);

        return normalizedOrderSymbol === normalizedSymbol && sideMatches;
      });

      if (pendingOrdersForSymbol.length > 0) {
        const now = Date.now();
        const oldestOrder = pendingOrdersForSymbol.reduce(
          (oldest: any, order: any) => {
            const orderTime = order.timestamp
              ? new Date(order.timestamp).getTime()
              : now;
            const oldestTime = oldest.timestamp
              ? new Date(oldest.timestamp).getTime()
              : now;
            return orderTime < oldestTime ? order : oldest;
          },
          pendingOrdersForSymbol[0],
        );

        const orderAge =
          now -
          (oldestOrder.timestamp
            ? new Date(oldestOrder.timestamp).getTime()
            : now);

        if (orderAge < this.PENDING_ORDER_GRACE_PERIOD_MS) {
          this.logger.debug(
            `⏳ Waiting for ${pendingOrdersForSymbol.length} pending ${missingSide} order(s) for ${symbol} ` +
              `on ${exchange} (${Math.round(orderAge / 1000)}s old)`,
          );
          return true;
        } else {
          // Orders are stale - cancel them
          this.logger.warn(
            `🗑️ Cancelling ${pendingOrdersForSymbol.length} stale pending order(s) for ${symbol} ` +
              `on ${exchange} (${Math.round(orderAge / 60000)} minutes old)`,
          );
          for (const order of pendingOrdersForSymbol) {
            try {
              await adapter.cancelOrder(order.orderId, symbol);
            } catch (cancelError: any) {
              this.logger.debug(
                `Failed to cancel stale order ${order.orderId}: ${cancelError.message}`,
              );
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } catch (error: any) {
      this.logger.debug(
        `Could not check open orders on ${exchange}: ${error.message}`,
      );
    }

    return false;
  }

  /**
   * Close a single-leg position
   */
  async closeSingleLegPosition(
    position: PerpPosition,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
  ): Promise<boolean> {
    try {
      const adapter = adapters.get(position.exchangeType);
      if (!adapter) {
        this.logger.warn(`No adapter found for ${position.exchangeType}`);
        return false;
      }

      const closeSide =
        position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;

      // Get current mark price to act as maker
      let markPrice: number | undefined;
      try {
        markPrice = await adapter.getMarkPrice(position.symbol);
      } catch (priceError: any) {
        this.logger.warn(
          `Could not get mark price for ${position.symbol} closure, using entry price: ${priceError.message}`,
        );
        markPrice = position.entryPrice;
      }

      const closeOrder = new PerpOrderRequest(
        position.symbol,
        closeSide,
        OrderType.LIMIT,
        position.size,
        markPrice,
        TimeInForce.GTC,
        true, // reduceOnly
      );

      const threadId = this.executionLockService?.generateThreadId() || `single-leg-close-${Date.now()}`;

      // SYMBOL-LEVEL LOCK
      if (this.executionLockService) {
        const lockAcquired = this.executionLockService.tryAcquireSymbolLock(
          position.symbol,
          threadId,
          'closeSingleLegPosition'
        );
        
        if (!lockAcquired) {
          this.logger.warn(`⏳ Symbol ${position.symbol} is already being executed - skipping single-leg close`);
          return false;
        }
      }

      try {
        // Register order
        if (this.executionLockService) {
          this.executionLockService.registerOrderPlacing(
            `close-${position.symbol}-${closeSide}-${Date.now()}`,
            position.symbol,
            position.exchangeType,
            closeSide,
            threadId,
            position.size,
            markPrice
          );
        }

        const closeResult = await adapter.placeOrder(closeOrder);
        if (closeResult && closeResult.orderId) {
          if (this.executionLockService) {
            this.executionLockService.updateOrderStatus(
              position.exchangeType,
              position.symbol,
              closeSide,
              closeResult.isFilled() ? 'FILLED' : 'WAITING_FILL',
              closeResult.orderId,
              markPrice,
              true
            );
          }
          this.logger.log(
            `✅ Closed single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType}`,
          );
          return true;
        } else {
          if (this.executionLockService) {
            this.executionLockService.updateOrderStatus(
              position.exchangeType,
              position.symbol,
              closeSide,
              'FAILED'
            );
          }
          this.logger.warn(
            `⚠️ Failed to close single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType}`,
          );
          result.errors.push(
            `Failed to close single-leg position ${position.symbol} on ${position.exchangeType}`,
          );
          return false;
        }
      } finally {
        if (this.executionLockService) {
          this.executionLockService.releaseSymbolLock(position.symbol, threadId);
        }
      }
    } catch (error: any) {
      this.logger.error(
        `Error closing single-leg position ${position.symbol}: ${error.message}`,
      );
      result.errors.push(
        `Error closing single-leg position ${position.symbol}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Store retry info for an opportunity before execution
   */
  storeRetryInfo(
    opportunity: ArbitrageOpportunity,
    singleLegRetries: Map<string, SingleLegRetryInfo>,
  ): void {
    if (!opportunity.shortExchange) {
      return; // Skip perp-spot opportunities
    }

    const retryKey = this.getFilterKey(
      opportunity.symbol,
      opportunity.longExchange,
      opportunity.shortExchange,
    );

    // Only store if not already tracked
    if (!singleLegRetries.has(retryKey)) {
      singleLegRetries.set(retryKey, {
        retryCount: 0,
        longExchange: opportunity.longExchange,
        shortExchange: opportunity.shortExchange,
        opportunity,
        lastRetryTime: new Date(),
      });
    }
  }

  /**
   * Get filter key for opportunity tracking
   */
  private getFilterKey(
    symbol: string,
    exchange1: ExchangeType,
    exchange2: ExchangeType,
  ): string {
    const exchanges = [exchange1, exchange2].sort();
    return `${symbol}-${exchanges[0]}-${exchanges[1]}`;
  }
}
