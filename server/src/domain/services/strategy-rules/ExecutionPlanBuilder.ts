import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IExecutionPlanBuilder,
  ExecutionPlanContext,
} from './IExecutionPlanBuilder';
import { CostCalculator } from './CostCalculator';
import {
  FundingRateAggregator,
  ArbitrageOpportunity,
} from '../FundingRateAggregator';
import { ArbitrageExecutionPlan } from '../FundingArbitrageStrategy';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { PositionSize } from '../../value-objects/PositionSize';
import { Result } from '../../common/Result';
import { TWAPOptimizer } from '../twap/TWAPOptimizer';
import {
  DomainException,
  ExchangeException,
  ValidationException,
  InsufficientBalanceException,
} from '../../exceptions/DomainException';
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
    @Optional() private readonly twapOptimizer?: TWAPOptimizer,
  ) {}

  async buildPlan(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    balances: ExecutionPlanContext,
    config: StrategyConfig,
    longMarkPrice?: number,
    shortMarkPrice?: number,
    maxPositionSizeUsd?: number,
    leverageOverride?: number,
  ): Promise<Result<ArbitrageExecutionPlan, DomainException>> {
    return this.createExecutionPlanWithBalances(
      opportunity,
      adapters,
      maxPositionSizeUsd,
      longMarkPrice,
      shortMarkPrice,
      balances.longBalance,
      balances.shortBalance,
      config,
      leverageOverride,
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
    leverageOverride?: number,
  ): Promise<Result<ArbitrageExecutionPlan, DomainException>> {
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
      leverageOverride,
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
    leverageOverride?: number,
  ): Promise<Result<ArbitrageExecutionPlan, DomainException>> {
    // Use override leverage if provided, otherwise use config leverage
    const leverage = leverageOverride ?? config.leverage;

    try {
      if (opportunity.strategyType !== 'perp-perp') {
        return Result.failure(
          new ValidationException(
            'ExecutionPlanBuilder only supports perp-perp opportunities',
            'INVALID_STRATEGY_TYPE',
          ),
        );
      }

      if (!opportunity.shortExchange) {
        return Result.failure(
          new ValidationException(
            'shortExchange is required for perp-perp opportunities',
            'MISSING_SHORT_EXCHANGE',
          ),
        );
      }

      const longAdapter = adapters.get(opportunity.longExchange);
      const shortAdapter = adapters.get(opportunity.shortExchange);

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

      // Use provided mark prices if available, otherwise use from opportunity, otherwise fetch
      let finalLongMarkPrice = longMarkPrice ?? opportunity.longMarkPrice;
      let finalShortMarkPrice = shortMarkPrice ?? opportunity.shortMarkPrice;

      if (!finalLongMarkPrice || finalLongMarkPrice === 0) {
        try {
          finalLongMarkPrice = await longAdapter.getMarkPrice(
            opportunity.symbol,
          );
        } catch (error: any) {
          this.logger.debug(
            `Failed to get mark price for ${opportunity.symbol} on ${opportunity.longExchange}: ${error.message}`,
          );
          return Result.failure(
            new ExchangeException(
              `Failed to get mark price: ${error.message}`,
              opportunity.longExchange,
              { symbol: opportunity.symbol, error: error.message },
            ),
          );
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
          return Result.failure(
            new ExchangeException(
              `Failed to get mark price: ${error.message}`,
              opportunity.shortExchange,
              { symbol: opportunity.symbol, error: error.message },
            ),
          );
        }
      }

      // Determine position size based on actual available capital
      const minBalance = Math.min(longBalance, shortBalance);
      const availableCapital =
        minBalance * config.balanceUsagePercent.toDecimal();
      const leveragedCapital = availableCapital * leverage;
      const maxSize = maxPositionSizeUsd || Infinity;

      // Calculate position size
      let positionSizeUsd: number;
      if (
        maxPositionSizeUsd &&
        maxPositionSizeUsd !== Infinity &&
        maxPositionSizeUsd >= config.minPositionSizeUsd
      ) {
        // Portfolio allocation mode
        const requiredCollateral = maxPositionSizeUsd / leverage;
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
        // Log at WARN level so it's visible
        this.logger.warn(
          `❌ Insufficient balance for ${opportunity.symbol}: ` +
            `Need $${config.minPositionSizeUsd}, have $${positionSizeUsd.toFixed(2)} ` +
            `(minBalance: $${Math.min(longBalance, shortBalance).toFixed(2)}, ` +
            `availableCapital: $${(Math.min(longBalance, shortBalance) * config.balanceUsagePercent.toDecimal()).toFixed(2)}, ` +
            `leveragedCapital: $${(Math.min(longBalance, shortBalance) * config.balanceUsagePercent.toDecimal() * leverage).toFixed(2)})`,
        );
        return Result.failure(
          new InsufficientBalanceException(
            config.minPositionSizeUsd,
            positionSizeUsd,
            'USDC',
            { symbol: opportunity.symbol },
          ),
        );
      }

      // Convert to base asset size
      const avgMarkPrice = (finalLongMarkPrice + finalShortMarkPrice) / 2;
      let positionSizeBaseAsset = positionSizeUsd / avgMarkPrice;

      // ========== STATISTICAL LIQUIDITY FILTER: Replaces heuristics ==========
      if (this.twapOptimizer) {
        const twapParams = this.twapOptimizer.calculateOptimalParams(
          opportunity.symbol,
          positionSizeUsd,
          opportunity.longExchange,
          opportunity.shortExchange!,
        );

        // Identify if the position is too large even for TWAP
        if (twapParams.warnings.some(w => w.includes('too large') || w.includes('too thin'))) {
          // Find max viable size statistically
          const optimal = this.twapOptimizer.findOptimalPositionSize(
            opportunity.symbol,
            opportunity.longExchange,
            opportunity.shortExchange!,
            opportunity.expectedReturn.toDecimal() * 100,
            positionSizeUsd,
            0.15 // Target 15% net APY floor
          );

          if (optimal && optimal.optimalPositionUsd < positionSizeUsd) {
            this.logger.debug(
              `📊 Statistical limit reached for ${opportunity.symbol}: ` +
              `Scaling from $${positionSizeUsd.toFixed(0)} to $${optimal.optimalPositionUsd.toFixed(0)} ` +
              `based on liquidity profile (Target Net APY: ${(optimal.expectedNetAPY * 100).toFixed(1)}%)`
            );
            positionSizeUsd = optimal.optimalPositionUsd;
            positionSizeBaseAsset = positionSizeUsd / avgMarkPrice;
          }
        }
      } else {
        // Fallback to basic heuristics if TWAP optimizer not available
        const minOI = Math.min(opportunity.longOpenInterest || Infinity, opportunity.shortOpenInterest || Infinity);
        if (minOI < Infinity && minOI > 0) {
          const maxPositionSizeFromOI = minOI * 0.05; // 5% of minimum OI
          if (positionSizeUsd > maxPositionSizeFromOI) {
            positionSizeUsd = maxPositionSizeFromOI;
            positionSizeBaseAsset = positionSizeUsd / avgMarkPrice;
          }
        }
      }

      if (positionSizeUsd < config.minPositionSizeUsd) {
        return Result.failure(
          new InsufficientBalanceException(
            config.minPositionSizeUsd,
            positionSizeUsd,
            'USDC',
            {
              symbol: opportunity.symbol,
              reason: 'Position size too small after liquidity adjustment',
            },
          ),
        );
      }
      // =========================================================================

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
        opportunity.longRate?.toDecimal() || 0,
      );
      const shortFundingImpact = this.costCalculator.predictFundingRateImpact(
        positionSizeUsd,
        opportunity.shortOpenInterest || 0,
        opportunity.shortRate?.toDecimal() || 0,
      );

      // Adjusted funding rates
      const longRate = opportunity.longRate?.toDecimal() || 0;
      const shortRate = opportunity.shortRate?.toDecimal() || 0;

      const adjustedLongRate = longRate + longFundingImpact;
      const adjustedShortRate = shortRate - shortFundingImpact;
      const adjustedSpread = Math.abs(adjustedLongRate - adjustedShortRate);
      const adjustedExpectedReturn = adjustedSpread * periodsPerYear;

      const useAdjusted =
        Math.abs(longFundingImpact + shortFundingImpact) >
        (opportunity.spread?.toDecimal() || 0) * 0.01;
      const effectiveExpectedReturn =
        useAdjusted &&
        !isNaN(adjustedExpectedReturn) &&
        isFinite(adjustedExpectedReturn)
          ? adjustedExpectedReturn
          : opportunity.expectedReturn?.toAPY() || 0;

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

      // Accept if either:
      // 1. Net return is positive (instantly profitable), OR
      // 2. Break-even time is within acceptable threshold (good time to break-even)
      const maxBreakEvenHours = config.maxWorstCaseBreakEvenDays * 24; // Convert days to hours
      const isAcceptableBreakEven =
        breakEvenHours !== null &&
        isFinite(breakEvenHours) &&
        breakEvenHours <= maxBreakEvenHours &&
        expectedReturnPerPeriod > 0; // Must have positive expected return (even if not instantly profitable)

      if (expectedNetReturn <= 0 && !isAcceptableBreakEven) {
        const amortizedCosts =
          breakEvenHours !== null && isFinite(breakEvenHours)
            ? totalCostsWithExit /
              Math.max(1, Math.min(24, Math.ceil(breakEvenHours)))
            : totalCostsWithExit / 24;
        // Log at WARN level so it's visible - this is important for debugging
        this.logger.warn(
          `❌ Opportunity ${opportunity.symbol} rejected: ` +
            `Position: $${positionSizeUsd.toFixed(2)}, ` +
            `Hourly return: $${expectedReturnPerPeriod.toFixed(4)}, ` +
            `Net return/hour: $${expectedNetReturn.toFixed(4)}, ` +
            `Break-even: ${breakEvenHours !== null ? breakEvenHours.toFixed(1) : 'N/A'}h (max: ${maxBreakEvenHours.toFixed(1)}h), ` +
            `Total costs: $${totalCostsWithExit.toFixed(4)}`,
        );
        return Result.failure(
          new ValidationException(
            `Opportunity not acceptable: net return ${expectedNetReturn.toFixed(4)}, break-even ${breakEvenHours !== null ? breakEvenHours.toFixed(1) : 'N/A'}h (max: ${maxBreakEvenHours.toFixed(1)}h)`,
            'UNPROFITABLE_OPPORTUNITY',
            {
              symbol: opportunity.symbol,
              expectedNetReturn,
              breakEvenHours,
              maxBreakEvenHours,
              totalCosts: totalCostsWithExit,
            },
          ),
        );
      }

      // Log if accepted based on break-even time (not instant profitability)
      if (expectedNetReturn <= 0 && isAcceptableBreakEven) {
        this.logger.log(
          `✅ Execution plan created for ${opportunity.symbol} (break-even acceptable): ` +
            `Position size: $${positionSizeUsd.toFixed(2)}, ` +
            `Break-even: ${breakEvenHours!.toFixed(1)}h (within ${maxBreakEvenHours.toFixed(1)}h threshold), ` +
            `Expected return per period: $${expectedReturnPerPeriod.toFixed(4)}, ` +
            `Net return per period: $${expectedNetReturn.toFixed(4)} (will be profitable after break-even)`,
        );
      }

      // Only log if it wasn't already logged above (for break-even based acceptance)
      if (expectedNetReturn > 0) {
        this.logger.log(
          `✅ Execution plan created for ${opportunity.symbol} (instantly profitable): ` +
            `Position size: $${positionSizeUsd.toFixed(2)}, ` +
            `Expected net return per period: $${expectedNetReturn.toFixed(4)}, ` +
            `Break-even: ${breakEvenHours !== null ? breakEvenHours.toFixed(1) : 'N/A'}h, ` +
            `Spread: ${(opportunity.spread?.toPercent() || 0).toFixed(4)}%`,
        );
      }

      // Calculate limit prices: use mark price directly for all exchanges
      // This ensures orders are close to mark price and we act as a maker on the book
      // LONG orders: at mark price
      // SHORT orders: at mark price
      const longLimitPrice = finalLongMarkPrice;
      const shortLimitPrice = finalShortMarkPrice;

      const longPriceSource = 'mark';
      const shortPriceSource = 'mark';

      this.logger.debug(
        `Limit order prices for ${opportunity.symbol}: ` +
          `LONG @ ${longLimitPrice.toFixed(4)} (${longPriceSource}: ${finalLongMarkPrice.toFixed(4)}, best bid: ${longBidAsk.bestBid.toFixed(4)}), ` +
          `SHORT @ ${shortLimitPrice.toFixed(4)} (${shortPriceSource}: ${finalShortMarkPrice.toFixed(4)}, best ask: ${shortBidAsk.bestAsk.toFixed(4)}), ` +
          `Slippage cost: $${totalSlippageCost.toFixed(2)}`,
      );

      // Create PositionSize value object
      const positionSize = PositionSize.fromBaseAsset(
        positionSizeBaseAsset,
        leverage,
      );

      // Create LIMIT order requests
      const longOrder = new PerpOrderRequest(
        longSymbol,
        OrderSide.LONG,
        OrderType.LIMIT,
        positionSize.toBaseAsset(),
        longLimitPrice,
        TimeInForce.GTC,
      );

      const shortOrder = new PerpOrderRequest(
        shortSymbol,
        OrderSide.SHORT,
        OrderType.LIMIT,
        positionSize.toBaseAsset(),
        shortLimitPrice,
        TimeInForce.GTC,
      );

      return Result.success({
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
        leverage, // Include target leverage for execution
      });
    } catch (error: any) {
      this.logger.error(`Failed to create execution plan: ${error.message}`);
      return Result.failure(
        new DomainException(
          `Failed to create execution plan: ${error.message}`,
          'EXECUTION_PLAN_ERROR',
          { symbol: opportunity.symbol, error: error.message },
        ),
      );
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
              const response = await orderApi.getOrderBookDetails({
                marketIndex,
              } as any);
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
