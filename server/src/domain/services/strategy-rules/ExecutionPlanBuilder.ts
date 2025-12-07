import { Injectable, Logger } from '@nestjs/common';
import { IExecutionPlanBuilder, ExecutionPlanContext } from './IExecutionPlanBuilder';
import { CostCalculator } from './CostCalculator';
import { FundingRateAggregator, ArbitrageOpportunity } from '../FundingRateAggregator';
import { ArbitrageExecutionPlan } from '../FundingArbitrageStrategy';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import {
  PerpOrderRequest,
  OrderSide,
  OrderType,
  TimeInForce,
} from '../../value-objects/PerpOrder';

/**
 * Execution plan builder for funding arbitrage strategy
 * Creates execution plans for arbitrage opportunities with cost calculations
 */
@Injectable()
export class ExecutionPlanBuilder implements IExecutionPlanBuilder {
  private readonly logger = new Logger(ExecutionPlanBuilder.name);

  constructor(
    private readonly costCalculator: CostCalculator,
    private readonly aggregator: FundingRateAggregator,
  ) {}

  async buildPlan(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    balances: ExecutionPlanContext,
    config: StrategyConfig,
    longMarkPrice?: number,
    shortMarkPrice?: number,
    maxPositionSizeUsd?: number,
  ): Promise<ArbitrageExecutionPlan | null> {
    return this.createExecutionPlanWithBalances(
      opportunity,
      adapters,
      maxPositionSizeUsd,
      longMarkPrice,
      shortMarkPrice,
      balances.longBalance,
      balances.shortBalance,
      config,
    );
  }

  async buildPlanWithAllocation(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    allocationUsd: number,
    balances: ExecutionPlanContext,
    config: StrategyConfig,
    longMarkPrice?: number,
    shortMarkPrice?: number,
  ): Promise<ArbitrageExecutionPlan | null> {
    // For allocation mode, use allocation as max position size
    return this.createExecutionPlanWithBalances(
      opportunity,
      adapters,
      allocationUsd,
      longMarkPrice,
      shortMarkPrice,
      balances.longBalance,
      balances.shortBalance,
      config,
    );
  }

  private async createExecutionPlanWithBalances(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    maxPositionSizeUsd: number | undefined,
    longMarkPrice: number | undefined,
    shortMarkPrice: number | undefined,
    longBalance: number,
    shortBalance: number,
    config: StrategyConfig,
  ): Promise<ArbitrageExecutionPlan | null> {
    try {
      const longAdapter = adapters.get(opportunity.longExchange);
      const shortAdapter = adapters.get(opportunity.shortExchange);

      if (!longAdapter || !shortAdapter) {
        this.logger.warn(
          `Missing adapters for opportunity: ${opportunity.symbol}`,
        );
        return null;
      }

      // Use provided mark prices if available, otherwise fetch
      let finalLongMarkPrice = longMarkPrice;
      let finalShortMarkPrice = shortMarkPrice;

      if (!finalLongMarkPrice || finalLongMarkPrice === 0) {
        try {
          finalLongMarkPrice = await longAdapter.getMarkPrice(
            opportunity.symbol,
          );
        } catch (error: any) {
          this.logger.debug(
            `Failed to get mark price for ${opportunity.symbol} on ${opportunity.longExchange}: ${error.message}`,
          );
          return null;
        }
      }

      if (!finalShortMarkPrice || finalShortMarkPrice === 0) {
        try {
          finalShortMarkPrice = await shortAdapter.getMarkPrice(
            opportunity.symbol,
          );
        } catch (error: any) {
          this.logger.debug(
            `Failed to get mark price for ${opportunity.symbol} on ${opportunity.shortExchange}: ${error.message}`,
          );
          return null;
        }
      }

      // Determine position size based on actual available capital
      const minBalance = Math.min(longBalance, shortBalance);
      const availableCapital = minBalance * config.balanceUsagePercent;
      const leveragedCapital = availableCapital * config.leverage;
      const maxSize = maxPositionSizeUsd || Infinity;

      // Calculate position size
      let positionSizeUsd: number;
      if (
        maxPositionSizeUsd &&
        maxPositionSizeUsd !== Infinity &&
        maxPositionSizeUsd >= config.minPositionSizeUsd
      ) {
        // Portfolio allocation mode
        const requiredCollateral = maxPositionSizeUsd / config.leverage;
        if (minBalance >= requiredCollateral) {
          positionSizeUsd = maxPositionSizeUsd;
        } else {
          positionSizeUsd = Math.min(leveragedCapital, maxSize);
        }
      } else {
        // Standard mode
        positionSizeUsd = Math.min(leveragedCapital, maxSize);
      }

      // Check minimum position size
      if (positionSizeUsd < config.minPositionSizeUsd) {
        if (positionSizeUsd >= config.minPositionSizeUsd * 0.8) {
          this.logger.debug(
            `Insufficient balance for ${opportunity.symbol}: ` +
              `Need $${config.minPositionSizeUsd}, have $${positionSizeUsd.toFixed(2)}`,
          );
        }
        return null;
      }

      // Convert to base asset size
      const avgMarkPrice = (finalLongMarkPrice + finalShortMarkPrice) / 2;
      let positionSize = positionSizeUsd / avgMarkPrice;

      // Check liquidity (open interest)
      const longOI = opportunity.longOpenInterest || 0;
      const shortOI = opportunity.shortOpenInterest || 0;

      if (
        opportunity.longOpenInterest === undefined ||
        opportunity.longOpenInterest === null ||
        longOI === 0
      ) {
        return null;
      }

      if (
        opportunity.shortOpenInterest === undefined ||
        opportunity.shortOpenInterest === null ||
        shortOI === 0
      ) {
        return null;
      }

      if (longOI < config.minOpenInterestUsd || shortOI < config.minOpenInterestUsd) {
        return null;
      }

      // Adjust position size based on available liquidity
      const minOI = Math.min(longOI || Infinity, shortOI || Infinity);
      if (minOI < Infinity && minOI > 0) {
        const maxPositionSizeFromOI = minOI * 0.05; // 5% of minimum OI

        if (positionSizeUsd > maxPositionSizeFromOI) {
          positionSizeUsd = maxPositionSizeFromOI;
          positionSize = positionSizeUsd / avgMarkPrice;
        }

        if (positionSizeUsd < config.minPositionSizeUsd) {
          return null;
        }
      }

      // Get exchange-specific symbol formats
      const longExchangeSymbol = this.aggregator.getExchangeSymbol(
        opportunity.symbol,
        opportunity.longExchange,
      );
      const shortExchangeSymbol = this.aggregator.getExchangeSymbol(
        opportunity.symbol,
        opportunity.shortExchange,
      );

      const longSymbol =
        typeof longExchangeSymbol === 'string'
          ? longExchangeSymbol
          : opportunity.symbol;
      const shortSymbol =
        typeof shortExchangeSymbol === 'string'
          ? shortExchangeSymbol
          : opportunity.symbol;

      // Get best bid/ask prices for slippage calculation
      const longBidAsk = await this.getBestBidAsk(
        longAdapter,
        longSymbol,
        opportunity.symbol,
        opportunity.longExchange,
      );
      const shortBidAsk = await this.getBestBidAsk(
        shortAdapter,
        shortSymbol,
        opportunity.symbol,
        opportunity.shortExchange,
      );

      // Calculate slippage costs
      const slippagePositionSize = positionSizeUsd;
      const longSlippage = this.costCalculator.calculateSlippageCost(
        slippagePositionSize,
        longBidAsk.bestBid,
        longBidAsk.bestAsk,
        opportunity.longOpenInterest || 0,
        OrderType.LIMIT,
      );
      const shortSlippage = this.costCalculator.calculateSlippageCost(
        slippagePositionSize,
        shortBidAsk.bestBid,
        shortBidAsk.bestAsk,
        opportunity.shortOpenInterest || 0,
        OrderType.LIMIT,
      );
      const totalSlippageCost = longSlippage + shortSlippage;

      // Calculate fees
      const longEntryFee = this.costCalculator.calculateFees(
        positionSizeUsd,
        opportunity.longExchange,
        true, // isMaker
        true, // isEntry
      );
      const shortEntryFee = this.costCalculator.calculateFees(
        positionSizeUsd,
        opportunity.shortExchange,
        true,
        true,
      );
      const totalEntryFees = longEntryFee + shortEntryFee;
      const totalExitFees = totalEntryFees; // Same calculation for exit

      const totalCosts = totalEntryFees + totalSlippageCost;

      // Calculate expected return
      const periodsPerDay = 24;
      const periodsPerYear = periodsPerDay * 365;

      // Predict funding rate impact
      const longFundingImpact = this.costCalculator.predictFundingRateImpact(
        positionSizeUsd,
        opportunity.longOpenInterest || 0,
        opportunity.longRate || 0,
      );
      const shortFundingImpact = this.costCalculator.predictFundingRateImpact(
        positionSizeUsd,
        opportunity.shortOpenInterest || 0,
        opportunity.shortRate || 0,
      );

      // Adjusted funding rates
      const longRate =
        opportunity.longRate !== undefined && !isNaN(opportunity.longRate)
          ? opportunity.longRate
          : 0;
      const shortRate =
        opportunity.shortRate !== undefined && !isNaN(opportunity.shortRate)
          ? opportunity.shortRate
          : 0;

      const adjustedLongRate = longRate + longFundingImpact;
      const adjustedShortRate = shortRate - shortFundingImpact;
      const adjustedSpread = Math.abs(adjustedLongRate - adjustedShortRate);
      const adjustedExpectedReturn = adjustedSpread * periodsPerYear;

      const useAdjusted =
        Math.abs(longFundingImpact + shortFundingImpact) >
        opportunity.spread * 0.01;
      const effectiveExpectedReturn =
        useAdjusted &&
        !isNaN(adjustedExpectedReturn) &&
        isFinite(adjustedExpectedReturn)
          ? adjustedExpectedReturn
          : opportunity.expectedReturn !== undefined &&
              !isNaN(opportunity.expectedReturn)
            ? opportunity.expectedReturn
            : 0;

      const expectedReturnPerPeriod =
        (effectiveExpectedReturn / periodsPerYear) * positionSizeUsd;

      // Calculate break-even hours
      const totalCostsWithExit =
        totalEntryFees + totalExitFees + totalSlippageCost;
      let breakEvenHours: number | null = null;
      let expectedNetReturn: number;

      if (expectedReturnPerPeriod > 0) {
        breakEvenHours = this.costCalculator.calculateBreakEvenHours(
          totalCostsWithExit,
          expectedReturnPerPeriod,
        );

        const amortizationPeriods = Math.max(
          1,
          Math.min(
            24,
            breakEvenHours !== null ? Math.ceil(breakEvenHours) : 24,
          ),
        );
        const amortizedCostsPerPeriod =
          totalCostsWithExit / amortizationPeriods;
        expectedNetReturn = expectedReturnPerPeriod - amortizedCostsPerPeriod;
      } else {
        expectedNetReturn = -totalCosts;
      }

      // Only proceed if net return is positive
      if (expectedNetReturn <= 0) {
        const amortizedCosts =
          breakEvenHours !== null && isFinite(breakEvenHours)
            ? totalCostsWithExit /
              Math.max(1, Math.min(24, Math.ceil(breakEvenHours)))
            : totalCostsWithExit / 24;
        this.logger.debug(
          `Opportunity ${opportunity.symbol} rejected (profitability): ` +
            `Position: $${positionSizeUsd.toFixed(2)}, ` +
            `Hourly return: $${expectedReturnPerPeriod.toFixed(4)}, ` +
            `Entry fees: $${totalEntryFees.toFixed(4)}, ` +
            `Exit fees: $${totalExitFees.toFixed(4)}, ` +
            `Slippage: $${totalSlippageCost.toFixed(4)}, ` +
            `Total costs: $${totalCostsWithExit.toFixed(4)}, ` +
            `Break-even: ${breakEvenHours !== null ? breakEvenHours.toFixed(1) : 'N/A'}h, ` +
            `Amortized costs/hour: $${amortizedCosts.toFixed(4)}, ` +
            `Net return/hour: $${expectedNetReturn.toFixed(4)}`,
        );
        return null;
      }

      this.logger.log(
        `✅ Execution plan created for ${opportunity.symbol}: ` +
          `Position size: $${positionSizeUsd.toFixed(2)}, ` +
          `Expected net return per period: $${expectedNetReturn.toFixed(4)}, ` +
          `Spread: ${(opportunity.spread * 100).toFixed(4)}%`,
      );

      // Calculate limit prices with price improvement
      const longLimitPrice =
        longBidAsk.bestBid * (1 + config.limitOrderPriceImprovement);
      const shortLimitPrice =
        shortBidAsk.bestAsk * (1 - config.limitOrderPriceImprovement);

      this.logger.debug(
        `Limit order prices for ${opportunity.symbol}: ` +
          `LONG @ ${longLimitPrice.toFixed(4)} (best bid: ${longBidAsk.bestBid.toFixed(4)}), ` +
          `SHORT @ ${shortLimitPrice.toFixed(4)} (best ask: ${shortBidAsk.bestAsk.toFixed(4)}), ` +
          `Slippage cost: $${totalSlippageCost.toFixed(2)}`,
      );

      // Create LIMIT order requests
      const longOrder = new PerpOrderRequest(
        longSymbol,
        OrderSide.LONG,
        OrderType.LIMIT,
        positionSize,
        longLimitPrice,
        TimeInForce.GTC,
      );

      const shortOrder = new PerpOrderRequest(
        shortSymbol,
        OrderSide.SHORT,
        OrderType.LIMIT,
        positionSize,
        shortLimitPrice,
        TimeInForce.GTC,
      );

      return {
        opportunity,
        longOrder,
        shortOrder,
        positionSize,
        estimatedCosts: {
          fees: totalEntryFees + totalExitFees,
          slippage: totalSlippageCost,
          total: totalEntryFees + totalExitFees + totalSlippageCost,
        },
        expectedNetReturn,
        timestamp: new Date(),
      };
    } catch (error: any) {
      this.logger.error(`Failed to create execution plan: ${error.message}`);
      return null;
    }
  }

  /**
   * Get best bid and ask prices from an exchange adapter
   * Falls back to mark price if order book data is unavailable
   */
  private async getBestBidAsk(
    adapter: IPerpExchangeAdapter,
    exchangeSymbol: string,
    normalizedSymbol: string,
    exchangeType: ExchangeType,
  ): Promise<{ bestBid: number; bestAsk: number }> {
    try {
      // Try to get best bid/ask from adapter if it has a getBestBidAsk method
      if (
        'getBestBidAsk' in adapter &&
        typeof (adapter as any).getBestBidAsk === 'function'
      ) {
        return await (adapter as any).getBestBidAsk(exchangeSymbol);
      }

      // For Lighter: get order book details
      if (exchangeType === ExchangeType.LIGHTER) {
        try {
          const marketIndex = this.aggregator.getExchangeSymbol(
            normalizedSymbol,
            exchangeType,
          );
          if (typeof marketIndex === 'number') {
            const orderApi = (adapter as any).orderApi;
            if (orderApi) {
              const response = (await orderApi.getOrderBookDetails({
                marketIndex,
              } as any)) as any;
              const orderBook = response?.order_book_details || response;
              const bestBid = orderBook?.bestBid || orderBook?.best_bid;
              const bestAsk = orderBook?.bestAsk || orderBook?.best_ask;

              if (bestBid?.price && bestAsk?.price) {
                return {
                  bestBid: parseFloat(bestBid.price),
                  bestAsk: parseFloat(bestAsk.price),
                };
              }
            }
          }
        } catch (error: any) {
          this.logger.debug(
            `Failed to get Lighter order book: ${error.message}`,
          );
        }
      }

      // Fallback: use mark price and estimate bid/ask spread
      const markPrice = await adapter.getMarkPrice(exchangeSymbol);
      const estimatedSpread = markPrice * 0.001; // Assume 0.1% spread

      return {
        bestBid: markPrice - estimatedSpread / 2,
        bestAsk: markPrice + estimatedSpread / 2,
      };
    } catch (error: any) {
      // Final fallback: use mark price with estimated spread
      const markPrice = await adapter.getMarkPrice(exchangeSymbol);
      const estimatedSpread = markPrice * 0.001;

      this.logger.warn(
        `Could not get order book for ${normalizedSymbol} on ${exchangeType}, using mark price estimate: ${error.message}`,
      );

      return {
        bestBid: markPrice - estimatedSpread / 2,
        bestAsk: markPrice + estimatedSpread / 2,
      };
    }
  }
}

