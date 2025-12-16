import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { IPositionManager, AsymmetricFill } from './IPositionManager';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  TimeInForce,
  OrderStatus,
} from '../../value-objects/PerpOrder';
import { PerpPosition } from '../../entities/PerpPosition';
import { ArbitrageExecutionResult } from '../FundingArbitrageStrategy';
import type { IOrderExecutor } from './IOrderExecutor';
import { OrderExecutor } from './OrderExecutor';
import { Result } from '../../common/Result';
import {
  DomainException,
  ExchangeException,
  PositionNotFoundException,
} from '../../exceptions/DomainException';

/**
 * Position manager for funding arbitrage strategy
 * Handles position aggregation, closing, and asymmetric fill management
 */
@Injectable()
export class PositionManager implements IPositionManager {
  private readonly logger = new Logger(PositionManager.name);

  // Track positions currently being closed to prevent double-close attempts
  // Key format: "EXCHANGE:SYMBOL" (e.g., "LIGHTER:ETHUSDC")
  private readonly closingPositions: Set<string> = new Set();
  
  // Track recently closed positions to prevent immediate re-close attempts
  // Key format: "EXCHANGE:SYMBOL", Value: timestamp when closed
  private readonly recentlyClosedPositions: Map<string, number> = new Map();
  private readonly RECENTLY_CLOSED_TTL_MS = 30000; // 30 seconds

  constructor(
    private readonly config: StrategyConfig,
    @Inject(forwardRef(() => 'IOrderExecutor'))
    private readonly orderExecutor: IOrderExecutor,
  ) {}

  /**
   * Generate a unique key for a position
   */
  private getPositionKey(exchangeType: ExchangeType, symbol: string): string {
    const normalizedSymbol = symbol
      .replace('USDC', '')
      .replace('USDT', '')
      .replace('-PERP', '')
      .replace('PERP', '')
      .toUpperCase();
    return `${exchangeType}:${normalizedSymbol}`;
  }

  /**
   * Check if a position is currently being closed
   */
  private isPositionBeingClosed(exchangeType: ExchangeType, symbol: string): boolean {
    return this.closingPositions.has(this.getPositionKey(exchangeType, symbol));
  }

  /**
   * Check if a position was recently closed
   */
  private wasRecentlyClosed(exchangeType: ExchangeType, symbol: string): boolean {
    const key = this.getPositionKey(exchangeType, symbol);
    const closedAt = this.recentlyClosedPositions.get(key);
    if (!closedAt) return false;
    
    const elapsed = Date.now() - closedAt;
    if (elapsed > this.RECENTLY_CLOSED_TTL_MS) {
      // Expired, remove from map
      this.recentlyClosedPositions.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Mark a position as being closed (acquire lock)
   * Returns true if lock acquired, false if already being closed
   */
  private markAsClosing(exchangeType: ExchangeType, symbol: string): boolean {
    const key = this.getPositionKey(exchangeType, symbol);
    if (this.closingPositions.has(key)) {
      return false; // Already being closed
    }
    this.closingPositions.add(key);
    return true;
  }

  /**
   * Mark a position as closed (release lock and record)
   */
  private markAsClosed(exchangeType: ExchangeType, symbol: string): void {
    const key = this.getPositionKey(exchangeType, symbol);
    this.closingPositions.delete(key);
    this.recentlyClosedPositions.set(key, Date.now());
  }

  /**
   * Release closing lock without marking as closed (for failed closes)
   */
  private releaseClosingLock(exchangeType: ExchangeType, symbol: string): void {
    const key = this.getPositionKey(exchangeType, symbol);
    this.closingPositions.delete(key);
  }

  /**
   * Clean up expired entries from recentlyClosedPositions
   */
  private cleanupRecentlyClosed(): void {
    const now = Date.now();
    for (const [key, closedAt] of this.recentlyClosedPositions) {
      if (now - closedAt > this.RECENTLY_CLOSED_TTL_MS) {
        this.recentlyClosedPositions.delete(key);
      }
    }
  }

  async getAllPositions(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<Result<PerpPosition[], DomainException>> {
    const allPositions: PerpPosition[] = [];
    const errors: DomainException[] = [];

    for (const [exchangeType, adapter] of adapters) {
      try {
        const positions = await adapter.getPositions();
        allPositions.push(...positions);
      } catch (error: any) {
        this.logger.warn(
          `Failed to get positions from ${exchangeType}: ${error.message}`,
        );
        errors.push(
          new ExchangeException(
            `Failed to get positions: ${error.message}`,
            exchangeType,
            { error: error.message },
          ),
        );
      }
    }

    // Return success even if some exchanges failed (resilient design)
    // Individual errors are logged but we still return positions from successful exchanges
    // Only return failure if ALL exchanges failed AND we have no positions
    if (allPositions.length === 0 && errors.length === adapters.size) {
      return Result.failure(
        new DomainException(
          `Failed to get positions from all exchanges`,
          'POSITION_FETCH_ERROR',
          { errors: errors.map((e) => e.message) },
        ),
      );
    }

    return Result.success(allPositions);
  }

  async closeAllPositions(
    positions: PerpPosition[],
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
  ): Promise<Result<{ closed: PerpPosition[]; stillOpen: PerpPosition[] }, DomainException>> {
    const closed: PerpPosition[] = [];
    const stillOpen: PerpPosition[] = [];

    // Clean up expired entries
    this.cleanupRecentlyClosed();

    for (const position of positions) {
      try {
        const adapter = adapters.get(position.exchangeType);
        if (!adapter) {
          this.logger.warn(
            `No adapter found for ${position.exchangeType}, cannot close position`,
          );
          result.errors.push(
            `No adapter found for ${position.exchangeType}`,
          );
          stillOpen.push(position);
          continue;
        }

        // IDEMPOTENT CHECK: Skip if position is already being closed
        if (this.isPositionBeingClosed(position.exchangeType, position.symbol)) {
          this.logger.warn(
            `⚠️ Position ${position.symbol} on ${position.exchangeType} is already being closed, skipping`,
          );
          continue; // Don't add to stillOpen - another process is handling it
        }

        // IDEMPOTENT CHECK: Skip if position was recently closed
        if (this.wasRecentlyClosed(position.exchangeType, position.symbol)) {
          this.logger.debug(
            `Position ${position.symbol} on ${position.exchangeType} was recently closed, skipping`,
          );
          continue; // Position was already closed
        }

        // Acquire closing lock
        if (!this.markAsClosing(position.exchangeType, position.symbol)) {
          this.logger.warn(
            `⚠️ Failed to acquire closing lock for ${position.symbol} on ${position.exchangeType}`,
          );
          continue;
        }

        // Close position with progressive price improvement (especially for Lighter)
        // Try progressively worse prices to ensure fill
        const closeSide = position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
        const positionSize = Math.abs(position.size);
        
        // Progressive price improvement: start with market, then try worse prices
        const priceImprovements = [0, 0.001, 0.005, 0.01, 0.02, 0.05]; // 0%, 0.1%, 0.5%, 1%, 2%, 5% worse
        
        let finalResponse: PerpOrderResponse | null = null;
        let positionClosed = false;
        
        for (let attempt = 0; attempt < priceImprovements.length; attempt++) {
          const priceImprovement = priceImprovements[attempt];
          
          try {
            // Get current market price for limit orders (if not first attempt)
            let limitPrice: number | undefined = undefined;
            if (attempt > 0 && position.exchangeType === ExchangeType.LIGHTER) {
              // For Lighter, get order book price and apply price improvement
              try {
                const markPrice = await adapter.getMarkPrice(position.symbol);
                if (markPrice > 0) {
                  // For closing LONG: we SELL, so use bid price (worse = lower)
                  // For closing SHORT: we BUY, so use ask price (worse = higher)
                  if (position.side === OrderSide.LONG) {
                    // Closing LONG = SELL = use bid price, make it worse (lower)
                    limitPrice = markPrice * (1 - priceImprovement);
                  } else {
                    // Closing SHORT = BUY = use ask price, make it worse (higher)
                    limitPrice = markPrice * (1 + priceImprovement);
                  }
                  this.logger.debug(
                    `Attempt ${attempt + 1}/${priceImprovements.length}: Using limit price ${limitPrice.toFixed(6)} ` +
                    `(${(priceImprovement * 100).toFixed(2)}% ${position.side === OrderSide.LONG ? 'worse' : 'worse'} than market)`,
                  );
                }
              } catch (priceError: any) {
                this.logger.debug(`Failed to get market price for progressive close: ${priceError.message}`);
                // Fall back to market order
              }
            }
            
            const closeOrder = new PerpOrderRequest(
              position.symbol,
              closeSide,
              limitPrice ? OrderType.LIMIT : OrderType.MARKET,
              positionSize,
              limitPrice,
              limitPrice ? TimeInForce.IOC : TimeInForce.IOC, // IOC for both market and limit
              true, // Reduce only - ensures we're closing, not opening
            );

            if (attempt === 0) {
              this.logger.log(
                `📤 Closing position: ${position.symbol} ${position.side} ${positionSize.toFixed(4)} on ${position.exchangeType}`,
              );
            } else {
              this.logger.warn(
                `🔄 Retry ${attempt}/${priceImprovements.length - 1}: Closing ${position.symbol} with ` +
                `${(priceImprovement * 100).toFixed(2)}% worse price (${limitPrice?.toFixed(6)})`,
              );
            }

            const closeResponse = await adapter.placeOrder(closeOrder);

            // Wait and retry if order didn't fill immediately
            let response = closeResponse;
            if (!closeResponse.isFilled() && closeResponse.orderId) {
              // Determine the order side for the close order (opposite of position side)
              const closeSide: 'LONG' | 'SHORT' = position.side === OrderSide.LONG ? 'SHORT' : 'LONG';
              response = await this.orderExecutor.waitForOrderFill(
                adapter,
                closeResponse.orderId,
                position.symbol,
                position.exchangeType,
                positionSize,
                this.config.maxOrderWaitRetries,
                this.config.orderWaitBaseInterval,
                true, // isClosingPosition = true (enables longer backoff)
                closeSide,
              );
            }
            
            finalResponse = response;
            
            // Check if position is actually closed
            await new Promise((resolve) => setTimeout(resolve, 500)); // Small delay for position to update
            const currentPositions = await adapter.getPositions();
            const positionStillExists = currentPositions.some(
              (p) =>
                p.symbol === position.symbol &&
                p.exchangeType === position.exchangeType &&
                Math.abs(p.size) > 0.0001,
            );
            
            if (response.isFilled() && !positionStillExists) {
              positionClosed = true;
              if (attempt > 0) {
                this.logger.log(
                  `✅ Successfully closed position ${position.symbol} on attempt ${attempt + 1} ` +
                  `with ${(priceImprovement * 100).toFixed(2)}% worse price`,
                );
              }
              break; // Position closed successfully
            }
            
            if (attempt < priceImprovements.length - 1) {
              this.logger.warn(
                `⚠️ Close order for ${position.symbol} didn't fill on attempt ${attempt + 1}, ` +
                `trying with worse price...`,
              );
              await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait before next attempt
            }
          } catch (error: any) {
            this.logger.warn(
              `Error on close attempt ${attempt + 1} for ${position.symbol}: ${error.message}`,
            );
            if (attempt === priceImprovements.length - 1) {
              // Last attempt failed, break and try fallback
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait before retry
          }
        }

        // Verify position is actually closed
        if (!positionClosed && finalResponse) {
          await new Promise((resolve) => setTimeout(resolve, 500)); // Small delay for position to update
          const currentPositions = await adapter.getPositions();
          const positionStillExists = currentPositions.some(
            (p) =>
              p.symbol === position.symbol &&
              p.exchangeType === position.exchangeType &&
              Math.abs(p.size) > 0.0001, // Position still exists if size > 0
          );
          positionClosed = !positionStillExists && finalResponse.isFilled();
        }

        if (positionClosed) {
          // Mark as closed (release lock and record)
          this.markAsClosed(position.exchangeType, position.symbol);
          
          if (!finalResponse || finalResponse.isSuccess()) {
            this.logger.log(
              `✅ Successfully closed position: ${position.symbol} on ${position.exchangeType}`,
            );
            closed.push(position);
          } else {
            // Position closed but response indicates failure - still count as closed
            this.logger.warn(
              `⚠️ Position ${position.symbol} appears closed but order response indicates failure`,
            );
            closed.push(position);
          }
        } else {
          // Final fallback: if position still exists after all retries, try one more market order
          const currentPositions = await adapter.getPositions();
          const positionStillExists = currentPositions.some(
            (p) =>
              p.symbol === position.symbol &&
              p.exchangeType === position.exchangeType &&
              Math.abs(p.size) > 0.0001,
          );
          
          if (positionStillExists) {
            this.logger.warn(
              `⚠️ Position ${position.symbol} on ${position.exchangeType} still exists after close attempt. ` +
                `Attempting final market order fallback...`,
            );

            try {
              // Get current position size (may have changed)
              const currentPositions = await adapter.getPositions();
              const currentPosition = currentPositions.find(
                (p) =>
                  p.symbol === position.symbol &&
                  p.exchangeType === position.exchangeType &&
                  Math.abs(p.size) > 0.0001,
              );

              if (currentPosition) {
                const finalCloseOrder = new PerpOrderRequest(
                  currentPosition.symbol,
                  currentPosition.side === OrderSide.LONG
                    ? OrderSide.SHORT
                    : OrderSide.LONG,
                  OrderType.MARKET,
                  Math.abs(currentPosition.size), // Use absolute size
                  0, // No limit price for market orders
                  TimeInForce.IOC, // Immediate or cancel
                  true, // Reduce only
                );

                this.logger.log(
                  `🔄 Final fallback: Force closing ${currentPosition.symbol} ${currentPosition.side} ${Math.abs(currentPosition.size).toFixed(4)} on ${currentPosition.exchangeType} with market order...`,
                );

                const fallbackResponse = await adapter.placeOrder(finalCloseOrder);

                // Wait a bit for the order to fill
                await new Promise((resolve) => setTimeout(resolve, 2000));

                // Verify position is closed
                const verifyPositions = await adapter.getPositions();
                const stillExists = verifyPositions.some(
                  (p) =>
                    p.symbol === position.symbol &&
                    p.exchangeType === position.exchangeType &&
                    Math.abs(p.size) > 0.0001,
                );

                if (!stillExists && fallbackResponse.isSuccess()) {
                  // Mark as closed (release lock and record)
                  this.markAsClosed(position.exchangeType, position.symbol);
                  this.logger.log(
                    `✅ Successfully closed position with final fallback market order: ${position.symbol} on ${position.exchangeType}`,
                  );
                  closed.push(position);
                } else {
                  // Release lock without marking as closed
                  this.releaseClosingLock(position.exchangeType, position.symbol);
                  this.logger.error(
                    `❌ Final fallback market order failed: ${position.symbol} on ${position.exchangeType}. ` +
                      `Position still exists. Margin remains locked.`,
                  );
                  result.errors.push(
                    `Failed to close position ${position.symbol} on ${position.exchangeType} even after final fallback`,
                  );
                  stillOpen.push(position);
                }
              } else {
                // Position disappeared between checks - mark as closed
                this.markAsClosed(position.exchangeType, position.symbol);
                this.logger.log(
                  `✅ Position ${position.symbol} on ${position.exchangeType} closed (disappeared during fallback check)`,
                );
                closed.push(position);
              }
            } catch (fallbackError: any) {
              // Release lock on fallback error
              this.releaseClosingLock(position.exchangeType, position.symbol);
              this.logger.error(
                `❌ Final fallback market order error for ${position.symbol} on ${position.exchangeType}: ${fallbackError.message}`,
              );
              result.errors.push(
                `Failed to close position ${position.symbol} on ${position.exchangeType}: ${fallbackError.message}`,
              );
              stillOpen.push(position);
            }
          } else {
            // Release lock - position doesn't exist
            this.releaseClosingLock(position.exchangeType, position.symbol);
            this.logger.warn(
              `⚠️ Failed to close position ${position.symbol} on ${position.exchangeType}: ${finalResponse?.error || 'order not filled'}`,
            );
            result.errors.push(
              `Failed to close position ${position.symbol} on ${position.exchangeType}`,
            );
            stillOpen.push(position);
          }
        }

        // Small delay between closes to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error: any) {
        // Release lock on any error
        this.releaseClosingLock(position.exchangeType, position.symbol);
        this.logger.error(
          `Error closing position ${position.symbol} on ${position.exchangeType}: ${error.message}`,
        );
        result.errors.push(
          `Error closing position ${position.symbol}: ${error.message}`,
        );
        stillOpen.push(position);
      }
    }

    return Result.success({ closed, stillOpen });
  }

  async handleAsymmetricFills(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    fills: AsymmetricFill[],
    result: ArbitrageExecutionResult,
    immediate: boolean = false,
  ): Promise<Result<void, DomainException>> {
    const now = new Date();
    const fillsToHandle: Array<{ fill: AsymmetricFill }> = [];

    // Filter fills: immediate mode handles all, otherwise only those exceeding timeout
    for (const fill of fills) {
      if (immediate) {
        fillsToHandle.push({ fill });
      } else {
        const ageMs = now.getTime() - fill.timestamp.getTime();
        if (ageMs >= this.config.asymmetricFillTimeoutMs) {
          fillsToHandle.push({ fill });
        }
      }
    }

    if (fillsToHandle.length === 0) {
      return Result.success(undefined);
    }

    if (immediate) {
      this.logger.warn(
        `⚡ Handling ${fillsToHandle.length} asymmetric fill(s) immediately (no timeout)...`,
      );
    } else {
      this.logger.warn(
        `⚠️ Handling ${fillsToHandle.length} asymmetric fill(s) that exceeded timeout...`,
      );
    }

    for (const { fill } of fillsToHandle) {
      try {
        const {
          symbol,
          longFilled,
          shortFilled,
          longOrderId,
          shortOrderId,
          longExchange,
          shortExchange,
          positionSize,
          opportunity,
        } = fill;

        const longAdapter = adapters.get(longExchange);
        const shortAdapter = adapters.get(shortExchange);

        if (!longAdapter || !shortAdapter) {
          const missingExchange = !longAdapter ? longExchange : shortExchange;
          this.logger.warn(
            `Missing adapters for ${symbol}, skipping asymmetric fill handling`,
          );
          result.errors.push(
            `Missing adapter for ${missingExchange} when handling asymmetric fill for ${symbol}`,
          );
          continue;
        }

        // Determine which side filled and which is on book
        const filledSide = longFilled ? 'LONG' : 'SHORT';
        const unfilledOrderId = longFilled ? shortOrderId : longOrderId;
        const unfilledAdapter = longFilled ? shortAdapter : longAdapter;
        const filledAdapter = longFilled ? longAdapter : shortAdapter;
        const unfilledExchange = longFilled ? shortExchange : longExchange;
        const filledExchange = longFilled ? longExchange : shortExchange;

        // Check current profitability with taker fees
        const markPrice = longFilled
          ? opportunity.longMarkPrice || 0
          : opportunity.shortMarkPrice || 0;
        const positionSizeUsd = positionSize * markPrice;

        const profitability = this.checkProfitabilityWithTakerFees(
          opportunity,
          positionSizeUsd,
        );

        if (profitability.profitable) {
          // Option 2: Try progressive price improvement, then market order if needed
          this.logger.log(
            `📋 ${symbol}: Arbitrage still profitable with taker fees ` +
              `($${profitability.expectedNetReturn.toFixed(4)}/period). ` +
              `Attempting progressive price improvement before market order...`,
          );

          // Progressive price improvements: try worse prices to get filled faster
          const priceImprovements = [0.001, 0.002, 0.005]; // 0.1%, 0.2%, 0.5% worse
          let improvedOrderFilled = false;
          const unfilledSide = longFilled ? OrderSide.SHORT : OrderSide.LONG;
          
          // Get current mark price for the unfilled exchange
          let currentMarkPrice: number;
          try {
            currentMarkPrice = await unfilledAdapter.getMarkPrice(symbol);
          } catch (error: any) {
            this.logger.warn(
              `Failed to get mark price for ${symbol} on ${unfilledExchange}: ${error.message}. ` +
              `Skipping price improvement, going straight to market order.`,
            );
            currentMarkPrice = markPrice; // Fallback to opportunity mark price
          }

          // Try progressive price improvement if order still exists
          // This helps fill orders faster in both immediate and timeout-based handling
          if (unfilledOrderId) {
            for (let i = 0; i < priceImprovements.length && !improvedOrderFilled; i++) {
              const improvement = priceImprovements[i];
              
              // Calculate improved price (worse = more aggressive)
              // For LONG: improve by making price higher (pay more)
              // For SHORT: improve by making price lower (sell for less)
              const improvedPrice = unfilledSide === OrderSide.LONG
                ? currentMarkPrice * (1 + improvement)  // Pay more for LONG
                : currentMarkPrice * (1 - improvement);  // Sell for less for SHORT

              try {
                // Cancel existing order
                await unfilledAdapter.cancelOrder(unfilledOrderId, symbol);
                this.logger.debug(
                  `🔄 ${symbol}: Cancelled order ${unfilledOrderId}, replacing with improved price ` +
                  `${improvedPrice.toFixed(4)} (${(improvement * 100).toFixed(2)}% ${unfilledSide === OrderSide.LONG ? 'worse' : 'worse'})`,
                );

                // Place new limit order with improved price
                const improvedOrder = new PerpOrderRequest(
                  symbol,
                  unfilledSide,
                  OrderType.LIMIT,
                  positionSize,
                  improvedPrice,
                  TimeInForce.IOC, // Use IOC for faster execution
                );

                const improvedResponse = await unfilledAdapter.placeOrder(improvedOrder);

                if (improvedResponse.isSuccess() && improvedResponse.isFilled()) {
                  this.logger.log(
                    `✅ ${symbol}: Improved limit order filled at ${improvedPrice.toFixed(4)}. ` +
                    `Arbitrage pair complete. Net return: $${profitability.expectedNetReturn.toFixed(4)}/period`,
                  );
                  improvedOrderFilled = true;
                  break;
                } else if (improvedResponse.isSuccess() && improvedResponse.status === OrderStatus.SUBMITTED) {
                  // Order placed but not filled - wait briefly then check
                  this.logger.debug(
                    `⏳ ${symbol}: Improved order placed but not immediately filled. Waiting 3 seconds...`,
                  );
                  await new Promise(resolve => setTimeout(resolve, 3000));
                  
                  // Check if order filled
                  try {
                    const orderStatus = await unfilledAdapter.getOrderStatus(
                      improvedResponse.orderId,
                      symbol,
                    );
                    if (orderStatus.isFilled()) {
                      this.logger.log(
                        `✅ ${symbol}: Improved limit order filled after wait. Arbitrage pair complete.`,
                      );
                      improvedOrderFilled = true;
                      break;
                    }
                    // Cancel the improved order if it didn't fill
                    await unfilledAdapter.cancelOrder(improvedResponse.orderId, symbol);
                  } catch (statusError: any) {
                    this.logger.debug(
                      `Could not check order status: ${statusError.message}. Continuing to next improvement.`,
                    );
                  }
                }
              } catch (error: any) {
                this.logger.warn(
                  `Failed price improvement attempt ${i + 1}/${priceImprovements.length} for ${symbol}: ${error.message}`,
                );
                // Continue to next improvement or market order
              }
            }
          }

          // If price improvement didn't work, place market order
          if (!improvedOrderFilled) {
            // Cancel unfilled GTC order if it still exists
            if (unfilledOrderId) {
              try {
                await unfilledAdapter.cancelOrder(unfilledOrderId, symbol);
                this.logger.log(
                  `✅ Cancelled GTC order ${unfilledOrderId} on ${unfilledExchange}`,
                );
              } catch (error: any) {
                // Order might already be cancelled or filled
                this.logger.debug(
                  `Could not cancel order ${unfilledOrderId}: ${error.message}`,
                );
              }
            }

            // Place market order to complete the pair
            this.logger.log(
              `📤 ${symbol}: Placing market order to complete arbitrage pair...`,
            );
            const marketOrder = new PerpOrderRequest(
              symbol,
              unfilledSide,
              OrderType.MARKET,
              positionSize,
            );

            const marketResponse = await unfilledAdapter.placeOrder(marketOrder);

            if (marketResponse.isSuccess() && marketResponse.isFilled()) {
              this.logger.log(
                `✅ ${symbol}: Market order filled, arbitrage pair complete. ` +
                  `Net return: $${profitability.expectedNetReturn.toFixed(4)}/period`,
              );
            } else {
              this.logger.warn(
                `⚠️ ${symbol}: Market order failed to fill. ` +
                  `Falling back to closing filled position...`,
              );
              // Fall through to Option 1
              const closeResult = await this.closeFilledPosition(
                filledAdapter,
                symbol,
                filledSide,
                positionSize,
                filledExchange,
                result,
              );
              if (closeResult.isFailure) {
                // Error already logged in closeFilledPosition
              }
            }
          }
        } else {
          // Option 1: Cancel unfilled order and close filled position
          this.logger.warn(
            `⚠️ ${symbol}: Arbitrage no longer profitable with taker fees ` +
              `($${profitability.expectedNetReturn.toFixed(4)}/period). ` +
              `Cancelling GTC order and closing filled position...`,
          );

          // Cancel unfilled GTC order
          if (unfilledOrderId) {
            try {
              await unfilledAdapter.cancelOrder(unfilledOrderId, symbol);
              this.logger.log(
                `✅ Cancelled GTC order ${unfilledOrderId} on ${unfilledExchange}`,
              );
            } catch (error: any) {
              this.logger.warn(
                `Failed to cancel GTC order ${unfilledOrderId}: ${error.message}`,
              );
            }
          }

          // Close filled position
          const closeResult = await this.closeFilledPosition(
            filledAdapter,
            symbol,
            filledSide,
            positionSize,
            filledExchange,
            result,
          );
          if (closeResult.isFailure) {
            // Error already logged in closeFilledPosition
          }
        }
      } catch (error: any) {
        this.logger.error(
          `Error handling asymmetric fill ${fill.symbol}: ${error.message}`,
        );
        result.errors.push(
          `Failed to handle asymmetric fill ${fill.symbol}: ${error.message}`,
        );
      }
    }

    // Return success even if some fills failed (errors are logged in result.errors)
    return Result.success(undefined);
  }

  async closeFilledPosition(
    adapter: IPerpExchangeAdapter,
    symbol: string,
    side: 'LONG' | 'SHORT',
    size: number,
    exchangeType: ExchangeType,
    result: ArbitrageExecutionResult,
  ): Promise<Result<void, DomainException>> {
    try {
      const closeOrder = new PerpOrderRequest(
        symbol,
        side === 'LONG' ? OrderSide.SHORT : OrderSide.LONG,
        OrderType.MARKET,
        size,
        0, // No limit price for market orders
        TimeInForce.IOC, // Immediate or cancel
        true, // Reduce only
      );

      this.logger.log(
        `📤 Closing ${side} position: ${symbol} ${size.toFixed(4)}`,
      );

      const closeResponse = await adapter.placeOrder(closeOrder);

      if (!closeResponse.isFilled() && closeResponse.orderId) {
        // Determine the order side for the close order (opposite of position side)
        const closeSide: 'LONG' | 'SHORT' = side === 'LONG' ? 'SHORT' : 'LONG';
        await this.orderExecutor.waitForOrderFill(
          adapter,
          closeResponse.orderId,
          symbol,
          exchangeType,
          size,
          this.config.maxOrderWaitRetries,
          this.config.orderWaitBaseInterval,
          true, // isClosingPosition
          closeSide,
        );
      }

      if (closeResponse.isSuccess() && closeResponse.isFilled()) {
        this.logger.log(`✅ Successfully closed ${side} position: ${symbol}`);
        return Result.success(undefined);
      } else {
        this.logger.warn(`⚠️ Failed to close ${side} position: ${symbol}`);
        result.errors.push(`Failed to close ${side} position ${symbol}`);
        return Result.failure(
          new PositionNotFoundException(
            symbol,
            exchangeType,
            { side, size, error: closeResponse.error || 'order not filled' },
          ),
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Error closing filled position ${symbol}: ${error.message}`,
      );
      result.errors.push(
        `Error closing filled position ${symbol}: ${error.message}`,
      );
      return Result.failure(
        new DomainException(
          `Error closing filled position: ${error.message}`,
          'POSITION_CLOSE_ERROR',
          { symbol, side, exchangeType, error: error.message },
        ),
      );
    }
  }

  /**
   * Detect single-leg positions (positions without a matching pair on another exchange)
   * A single-leg position is one where we have LONG on one exchange but no SHORT on another,
   * or SHORT on one exchange but no LONG on another.
   * 
   * Returns positions that are single-leg and should be closed immediately to prevent price exposure.
   */
  detectSingleLegPositions(positions: PerpPosition[]): PerpPosition[] {
    if (positions.length === 0) {
      return [];
    }

    this.logger.debug(`🔍 detectSingleLegPositions: Analyzing ${positions.length} total positions`);
    for (const pos of positions) {
      this.logger.debug(
        `  Position: symbol="${pos.symbol}", exchange=${pos.exchangeType}, side=${pos.side}, size=${pos.size}`
      );
    }

    // Normalize symbol for cross-exchange matching (e.g., "0GUSDT" -> "0G", "ETHUSDT" -> "ETH")
    const normalizeSymbol = (symbol: string): string => {
      return symbol
        .replace('USDT', '')
        .replace('USDC', '')
        .replace('-PERP', '')
        .replace('PERP', '')
        .toUpperCase();
    };

    // Group positions by normalized symbol to match positions across exchanges
    const positionsBySymbol = new Map<string, PerpPosition[]>();
    for (const position of positions) {
      const normalizedSymbol = normalizeSymbol(position.symbol);
      this.logger.debug(
        `  Normalizing: "${position.symbol}" -> "${normalizedSymbol}" (exchange=${position.exchangeType}, side=${position.side})`
      );
      if (!positionsBySymbol.has(normalizedSymbol)) {
        positionsBySymbol.set(normalizedSymbol, []);
      }
      positionsBySymbol.get(normalizedSymbol)!.push(position);
    }

    this.logger.debug(`📊 Grouped into ${positionsBySymbol.size} normalized symbols: ${Array.from(positionsBySymbol.keys()).join(', ')}`);

    const singleLegPositions: PerpPosition[] = [];

    for (const [symbol, symbolPositions] of positionsBySymbol) {
      this.logger.debug(`\n🔍 Analyzing symbol "${symbol}" with ${symbolPositions.length} position(s):`);
      for (const pos of symbolPositions) {
        this.logger.debug(`    - ${pos.exchangeType}: ${pos.side}, size=${pos.size}, symbol="${pos.symbol}"`);
      }
      
      // For arbitrage, we need both LONG and SHORT positions on DIFFERENT exchanges
      const longPositions = symbolPositions.filter((p) => p.side === OrderSide.LONG);
      const shortPositions = symbolPositions.filter((p) => p.side === OrderSide.SHORT);

      this.logger.debug(`  LONG positions: ${longPositions.length} (${longPositions.map(p => `${p.exchangeType}`).join(', ')})`);
      this.logger.debug(`  SHORT positions: ${shortPositions.length} (${shortPositions.map(p => `${p.exchangeType}`).join(', ')})`);

      // Check if we have a matched arbitrage pair: LONG on one exchange and SHORT on a DIFFERENT exchange
      // This is the CORRECT arbitrage setup - both positions exist and are on different exchanges
      const matchedPairs: Array<{ long: PerpPosition; short: PerpPosition }> = [];
      const unmatchedPositions: PerpPosition[] = [];
      
      for (const longPos of longPositions) {
        const matchingShort = shortPositions.find(
          (shortPos) => shortPos.exchangeType !== longPos.exchangeType,
        );
        if (matchingShort) {
          // Found a matched pair: LONG and SHORT on different exchanges
          matchedPairs.push({ long: longPos, short: matchingShort });
        } else {
          // No matching SHORT on a different exchange
          unmatchedPositions.push(longPos);
        }
      }
      
      // Check for unmatched SHORT positions (SHORT without a LONG on a different exchange)
      for (const shortPos of shortPositions) {
        const matchingLong = longPositions.find(
          (longPos) => longPos.exchangeType !== shortPos.exchangeType,
        );
        if (!matchingLong) {
          // No matching LONG on a different exchange
          if (!unmatchedPositions.includes(shortPos)) {
            unmatchedPositions.push(shortPos);
          }
        }
      }
      
      // Also check for same-exchange pairs (LONG and SHORT on same exchange - not arbitrage)
      const sameExchangePairs: PerpPosition[] = [];
      for (const longPos of longPositions) {
        const sameExchangeShort = shortPositions.find(
          (shortPos) => shortPos.exchangeType === longPos.exchangeType,
        );
        if (sameExchangeShort) {
          // Both LONG and SHORT on same exchange - not an arbitrage pair
          if (!sameExchangePairs.includes(longPos)) {
            sameExchangePairs.push(longPos);
          }
          if (!sameExchangePairs.includes(sameExchangeShort)) {
            sameExchangePairs.push(sameExchangeShort);
          }
        }
      }

      this.logger.debug(
        `  Matched pairs: ${matchedPairs.length} (${matchedPairs.map(p => `${p.long.exchangeType} LONG + ${p.short.exchangeType} SHORT`).join(', ')})`,
      );
      this.logger.debug(
        `  Unmatched positions: ${unmatchedPositions.length} (${unmatchedPositions.map(p => `${p.side} on ${p.exchangeType}`).join(', ')})`,
      );
      this.logger.debug(
        `  Same-exchange pairs: ${sameExchangePairs.length} (${sameExchangePairs.map(p => `${p.side} on ${p.exchangeType}`).join(', ')})`,
      );

      if (matchedPairs.length > 0) {
        this.logger.debug(
          `✅ Matched arbitrage pair(s) detected for ${symbol}: LONG and SHORT positions exist on different exchanges - NOT single-leg`,
        );
      }

      // Flag unmatched positions and same-exchange pairs as single-leg
      if (unmatchedPositions.length > 0) {
        this.logger.warn(
          `⚠️ Single-leg position(s) detected for ${symbol}: ` +
            `${unmatchedPositions.map(p => `${p.side} on ${p.exchangeType}`).join(', ')} ` +
            `have no matching position on a different exchange. These have price exposure and should be closed.`,
        );
        singleLegPositions.push(...unmatchedPositions);
      }

      if (sameExchangePairs.length > 0) {
        this.logger.warn(
          `⚠️ Same-exchange position(s) detected for ${symbol}: ` +
            `${sameExchangePairs.map(p => `${p.side} on ${p.exchangeType}`).join(', ')} ` +
            `are on the same exchange - not arbitrage pairs. These should be closed.`,
        );
        sameExchangePairs.forEach(pos => {
          if (!singleLegPositions.includes(pos)) {
            singleLegPositions.push(pos);
          }
        });
      }
    }

    if (singleLegPositions.length > 0) {
      this.logger.error(
        `🚨 CRITICAL: Detected ${singleLegPositions.length} single-leg position(s) with price exposure: ` +
          `${singleLegPositions.map((p) => `${p.symbol} (${p.side}) on ${p.exchangeType}`).join(', ')}. ` +
          `These will be closed immediately to prevent losses.`,
      );
    }

    return singleLegPositions;
  }

  /**
   * Check if arbitrage is still profitable with taker fees (for market orders)
   */
  private checkProfitabilityWithTakerFees(
    opportunity: any,
    positionSizeUsd: number,
  ): { profitable: boolean; expectedNetReturn: number } {
    const longMakerFeeRate =
      this.config.exchangeFeeRates.get(opportunity.longExchange) || 0.0005;
    const shortTakerFeeRate =
      this.config.takerFeeRates.get(opportunity.shortExchange) || 0.0004;

    // One side already filled (maker fee), other will use taker fee
    const longEntryFee = positionSizeUsd * longMakerFeeRate;
    const shortEntryFee = positionSizeUsd * shortTakerFeeRate;
    const totalEntryFees = longEntryFee + shortEntryFee;

    // Estimate slippage for market order (conservative)
    const marketSlippage = 0.0005; // 0.05% slippage for market orders
    const slippageCost = positionSizeUsd * marketSlippage;

    // Exit fees (both sides will pay maker fees when closing)
    const longExitFeeRate =
      this.config.exchangeFeeRates.get(opportunity.longExchange) || 0.0005;
    const shortExitFeeRate =
      this.config.exchangeFeeRates.get(opportunity.shortExchange) || 0.0005;
    const totalExitFees =
      positionSizeUsd * (longExitFeeRate + shortExitFeeRate);

    const totalCosts = totalEntryFees + totalExitFees + slippageCost;

    // Calculate expected return
    const periodsPerDay = 24;
    const periodsPerYear = periodsPerDay * 365;
    const expectedReturnPerPeriod =
      ((opportunity.expectedReturn?.toAPY() || 0) / periodsPerYear) * positionSizeUsd;

    if (expectedReturnPerPeriod > 0) {
      const breakEvenHours = totalCosts / expectedReturnPerPeriod;
      const amortizationPeriods = Math.max(
        1,
        Math.min(24, Math.ceil(breakEvenHours)),
      );
      const amortizedCostsPerPeriod = totalCosts / amortizationPeriods;
      const expectedNetReturn =
        expectedReturnPerPeriod - amortizedCostsPerPeriod;

      return {
        profitable: expectedNetReturn > 0,
        expectedNetReturn,
      };
    }

    return {
      profitable: false,
      expectedNetReturn: -totalCosts,
    };
  }
}
