import { Injectable, Logger, Inject } from '@nestjs/common';
import { IPositionManager, AsymmetricFill } from './IPositionManager';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import {
  PerpPosition,
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  TimeInForce,
  OrderStatus,
} from '../../value-objects/PerpOrder';
import { ArbitrageExecutionResult } from '../FundingArbitrageStrategy';
import { IOrderExecutor } from './IOrderExecutor';

/**
 * Position manager for funding arbitrage strategy
 * Handles position aggregation, closing, and asymmetric fill management
 */
@Injectable()
export class PositionManager implements IPositionManager {
  private readonly logger = new Logger(PositionManager.name);

  constructor(
    private readonly config: StrategyConfig,
    @Inject('IOrderExecutor')
    private readonly orderExecutor: IOrderExecutor,
  ) {}

  async getAllPositions(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<PerpPosition[]> {
    const allPositions: PerpPosition[] = [];

    for (const [exchangeType, adapter] of adapters) {
      try {
        const positions = await adapter.getPositions();
        allPositions.push(...positions);
      } catch (error: any) {
        this.logger.warn(
          `Failed to get positions from ${exchangeType}: ${error.message}`,
        );
      }
    }

    return allPositions;
  }

  async closeAllPositions(
    positions: PerpPosition[],
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
  ): Promise<{ closed: PerpPosition[]; stillOpen: PerpPosition[] }> {
    const closed: PerpPosition[] = [];
    const stillOpen: PerpPosition[] = [];

    for (const position of positions) {
      try {
        const adapter = adapters.get(position.exchangeType);
        if (!adapter) {
          this.logger.warn(
            `No adapter found for ${position.exchangeType}, cannot close position`,
          );
          stillOpen.push(position);
          continue;
        }

        // Close position by placing opposite order
        // Use MARKET order with IOC (Immediate or Cancel) and reduceOnly for aggressive closing
        const closeOrder = new PerpOrderRequest(
          position.symbol,
          position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG,
          OrderType.MARKET,
          Math.abs(position.size), // Use absolute size
          0, // No limit price for market orders
          TimeInForce.IOC, // Immediate or cancel - ensures aggressive fill
          true, // Reduce only - ensures we're closing, not opening
        );

        this.logger.log(
          `📤 Closing position: ${position.symbol} ${position.side} ${position.size.toFixed(4)} on ${position.exchangeType}`,
        );

        const closeResponse = await adapter.placeOrder(closeOrder);

        // Wait and retry if order didn't fill immediately
        let finalResponse = closeResponse;
        if (!closeResponse.isFilled() && closeResponse.orderId) {
          finalResponse = await this.orderExecutor.waitForOrderFill(
            adapter,
            closeResponse.orderId,
            position.symbol,
            position.exchangeType,
            position.size,
            this.config.maxOrderWaitRetries,
            this.config.orderWaitBaseInterval,
            true, // isClosingPosition = true (enables longer backoff)
          );
        }

        // Verify position is actually closed by checking positions again
        await new Promise((resolve) => setTimeout(resolve, 500)); // Small delay for position to update
        const currentPositions = await adapter.getPositions();
        const positionStillExists = currentPositions.some(
          (p) =>
            p.symbol === position.symbol &&
            p.exchangeType === position.exchangeType &&
            Math.abs(p.size) > 0.0001, // Position still exists if size > 0
        );

        if (
          finalResponse.isSuccess() &&
          finalResponse.isFilled() &&
          !positionStillExists
        ) {
          this.logger.log(
            `✅ Successfully closed position: ${position.symbol} on ${position.exchangeType}`,
          );
          closed.push(position);
        } else {
          // Final fallback: if position still exists after all retries, try one more market order
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
              `⚠️ Failed to close position ${position.symbol} on ${position.exchangeType}: ${finalResponse.error || 'order not filled'}`,
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

    return { closed, stillOpen };
  }

  async handleAsymmetricFills(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    fills: AsymmetricFill[],
    result: ArbitrageExecutionResult,
  ): Promise<void> {
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
      return;
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
          this.logger.warn(
            `Missing adapters for ${symbol}, skipping asymmetric fill handling`,
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
            await this.closeFilledPosition(
              filledAdapter,
              symbol,
              filledSide,
              positionSize,
              filledExchange,
              result,
            );
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
          await this.closeFilledPosition(
            filledAdapter,
            symbol,
            filledSide,
            positionSize,
            filledExchange,
            result,
          );
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
  }

  async closeFilledPosition(
    adapter: IPerpExchangeAdapter,
    symbol: string,
    side: 'LONG' | 'SHORT',
    size: number,
    exchangeType: ExchangeType,
    result: ArbitrageExecutionResult,
  ): Promise<void> {
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
      } else {
        this.logger.warn(`⚠️ Failed to close ${side} position: ${symbol}`);
        result.errors.push(`Failed to close ${side} position ${symbol}`);
      }
    } catch (error: any) {
      this.logger.error(
        `Error closing filled position ${symbol}: ${error.message}`,
      );
      result.errors.push(
        `Error closing filled position ${symbol}: ${error.message}`,
      );
    }
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
      (opportunity.expectedReturn / periodsPerYear) * positionSizeUsd;

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

