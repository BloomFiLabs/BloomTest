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

  constructor(
    private readonly config: StrategyConfig,
    @Inject(forwardRef(() => 'IOrderExecutor'))
    private readonly orderExecutor: IOrderExecutor,
  ) {}

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
              response = await this.orderExecutor.waitForOrderFill(
                adapter,
                closeResponse.orderId,
                position.symbol,
                position.exchangeType,
                positionSize,
                this.config.maxOrderWaitRetries,
                this.config.orderWaitBaseInterval,
                true, // isClosingPosition = true (enables longer backoff)
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
                  this.logger.log(
                    `✅ Successfully closed position with final fallback market order: ${position.symbol} on ${position.exchangeType}`,
                  );
                  closed.push(position);
                } else {
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
                // Position disappeared between checks
                this.logger.log(
                  `✅ Position ${position.symbol} on ${position.exchangeType} closed (disappeared during fallback check)`,
                );
                closed.push(position);
              }
            } catch (fallbackError: any) {
              this.logger.error(
                `❌ Final fallback market order error for ${position.symbol} on ${position.exchangeType}: ${fallbackError.message}`,
              );
              result.errors.push(
                `Failed to close position ${position.symbol} on ${position.exchangeType}: ${fallbackError.message}`,
              );
              stillOpen.push(position);
            }
          } else {
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
  ): Promise<Result<void, DomainException>> {
    const now = new Date();
    const fillsToHandle: Array<{ fill: AsymmetricFill }> = [];

    // Filter fills that exceeded timeout
    for (const fill of fills) {
      const ageMs = now.getTime() - fill.timestamp.getTime();
      if (ageMs >= this.config.asymmetricFillTimeoutMs) {
        fillsToHandle.push({ fill });
      }
    }

    if (fillsToHandle.length === 0) {
      return Result.success(undefined);
    }

    this.logger.warn(
      `⚠️ Handling ${fillsToHandle.length} asymmetric fill(s) that exceeded timeout...`,
    );

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
          // Option 2: Cancel GTC order and place market order to complete arbitrage
          this.logger.log(
            `📋 ${symbol}: Arbitrage still profitable with taker fees ` +
              `($${profitability.expectedNetReturn.toFixed(4)}/period). ` +
              `Cancelling GTC order and placing market order to complete pair...`,
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

          // Place market order to complete the pair
          const marketOrder = new PerpOrderRequest(
            symbol,
            longFilled ? OrderSide.SHORT : OrderSide.LONG,
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
        await this.orderExecutor.waitForOrderFill(
          adapter,
          closeResponse.orderId,
          symbol,
          exchangeType,
          size,
          this.config.maxOrderWaitRetries,
          this.config.orderWaitBaseInterval,
          true, // isClosingPosition
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

    // Group positions by symbol
    const positionsBySymbol = new Map<string, PerpPosition[]>();
    for (const position of positions) {
      if (!positionsBySymbol.has(position.symbol)) {
        positionsBySymbol.set(position.symbol, []);
      }
      positionsBySymbol.get(position.symbol)!.push(position);
    }

    const singleLegPositions: PerpPosition[] = [];

    for (const [symbol, symbolPositions] of positionsBySymbol) {
      // For arbitrage, we need both LONG and SHORT positions on DIFFERENT exchanges
      const longPositions = symbolPositions.filter((p) => p.side === OrderSide.LONG);
      const shortPositions = symbolPositions.filter((p) => p.side === OrderSide.SHORT);

      // Check if we have both LONG and SHORT on different exchanges
      const hasLongOnDifferentExchange = longPositions.some(
        (longPos) =>
          !shortPositions.some(
            (shortPos) => shortPos.exchangeType === longPos.exchangeType,
          ),
      );
      const hasShortOnDifferentExchange = shortPositions.some(
        (shortPos) =>
          !longPositions.some(
            (longPos) => longPos.exchangeType === shortPos.exchangeType,
          ),
      );

      // If we have LONG but no SHORT on a different exchange, all LONG positions are single-leg
      if (longPositions.length > 0 && !hasShortOnDifferentExchange) {
        this.logger.warn(
          `⚠️ Single-leg LONG position(s) detected for ${symbol}: ` +
            `Found ${longPositions.length} LONG position(s) but no SHORT position on different exchange. ` +
            `These positions have price exposure and should be closed.`,
        );
        singleLegPositions.push(...longPositions);
      }

      // If we have SHORT but no LONG on a different exchange, all SHORT positions are single-leg
      if (shortPositions.length > 0 && !hasLongOnDifferentExchange) {
        this.logger.warn(
          `⚠️ Single-leg SHORT position(s) detected for ${symbol}: ` +
            `Found ${shortPositions.length} SHORT position(s) but no LONG position on different exchange. ` +
            `These positions have price exposure and should be closed.`,
        );
        singleLegPositions.push(...shortPositions);
      }

      // Edge case: If we have LONG and SHORT but they're on the SAME exchange, they're not arbitrage pairs
      // This is also a single-leg scenario (both legs on same exchange = no arbitrage)
      if (
        longPositions.length > 0 &&
        shortPositions.length > 0 &&
        longPositions.every((longPos) =>
          shortPositions.some(
            (shortPos) => shortPos.exchangeType === longPos.exchangeType,
          ),
        )
      ) {
        this.logger.warn(
          `⚠️ Positions for ${symbol} are on the same exchange(s) - not arbitrage pairs. ` +
            `Both LONG and SHORT positions are single-leg (no cross-exchange arbitrage).`,
        );
        singleLegPositions.push(...symbolPositions);
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
