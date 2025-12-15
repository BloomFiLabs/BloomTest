import { Injectable, Logger } from '@nestjs/common';
import { IExecutionPlanBuilder, ExecutionPlanContext } from './IExecutionPlanBuilder';
import { CostCalculator } from './CostCalculator';
import { FundingRateAggregator, ArbitrageOpportunity } from '../FundingRateAggregator';
import { ArbitrageExecutionPlan } from '../FundingArbitrageStrategy';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { PositionSize } from '../../value-objects/PositionSize';
import { Result } from '../../common/Result';
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
      const availableCapital = minBalance * config.balanceUsagePercent.toDecimal();
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
        if (positionSizeUsd >= config.minPositionSizeUsd * 0.8) {
          this.logger.debug(
            `Insufficient balance for ${opportunity.symbol}: ` +
              `Need $${config.minPositionSizeUsd}, have $${positionSizeUsd.toFixed(2)}`,
          );
        }
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

      // Check liquidity (open interest)
      const longOI = opportunity.longOpenInterest || 0;
      const shortOI = opportunity.shortOpenInterest || 0;

      if (
        opportunity.longOpenInterest === undefined ||
        opportunity.longOpenInterest === null ||
        longOI === 0
      ) {
        return Result.failure(
          new ValidationException(
            `Missing or zero open interest for long exchange: ${opportunity.longExchange}`,
            'MISSING_OPEN_INTEREST',
            { symbol: opportunity.symbol, exchange: opportunity.longExchange },
          ),
        );
      }

      if (
        opportunity.shortOpenInterest === undefined ||
        opportunity.shortOpenInterest === null ||
        shortOI === 0
      ) {
        return Result.failure(
          new ValidationException(
            `Missing or zero open interest for short exchange: ${opportunity.shortExchange}`,
            'MISSING_OPEN_INTEREST',
            { symbol: opportunity.symbol, exchange: opportunity.shortExchange },
          ),
        );
      }

      if (longOI < config.minOpenInterestUsd || shortOI < config.minOpenInterestUsd) {
        return Result.failure(
          new ValidationException(
            `Insufficient open interest: long=${longOI}, short=${shortOI}, minimum=${config.minOpenInterestUsd}`,
            'INSUFFICIENT_OPEN_INTEREST',
            {
              symbol: opportunity.symbol,
              longOI,
              shortOI,
              minimum: config.minOpenInterestUsd,
            },
          ),
        );
      }

      // Adjust position size based on available liquidity
      const minOI = Math.min(longOI || Infinity, shortOI || Infinity);
      if (minOI < Infinity && minOI > 0) {
        const maxPositionSizeFromOI = minOI * 0.05; // 5% of minimum OI

        if (positionSizeUsd > maxPositionSizeFromOI) {
          positionSizeUsd = maxPositionSizeFromOI;
          positionSizeBaseAsset = positionSizeUsd / avgMarkPrice;
        }

        if (positionSizeUsd < config.minPositionSizeUsd) {
          return Result.failure(
            new InsufficientBalanceException(
              config.minPositionSizeUsd,
              positionSizeUsd,
              'USDC',
              {
                symbol: opportunity.symbol,
                reason: 'Position size too small after OI adjustment',
              },
            ),
          );
        }
      }

      // ========== DYNAMIC VOLUME FILTER: Auto-scales with position size ==========
      // This prevents single-leg positions from unfilled orders on low-volume pairs
      // Key insight: We want position to be ≤ X% of 24h volume for quick fills
      // So required_volume = position_size / (max_percent / 100)
      const long24hVolume = opportunity.long24hVolume || 0;
      const short24hVolume = opportunity.short24hVolume || 0;
      const min24hVolume = Math.min(
        long24hVolume || Infinity,
        short24hVolume || Infinity,
      );

      // Dynamic threshold: Calculate required volume based on position size
      // Formula: required_volume = position_size * (100 / max_position_percent)
      // Example: $15k position with 5% max → needs $300k volume
      const volumeMultiplier = 100 / config.maxPositionToVolumePercent; // e.g., 20x for 5%
      const requiredVolumeForPosition = positionSizeUsd * volumeMultiplier;
      
      // Also enforce absolute minimum if configured (safety floor)
      const effectiveMinVolume = Math.max(
        config.min24hVolumeUsd, // Absolute floor (can be 0 to disable)
        requiredVolumeForPosition, // Dynamic requirement based on position
      );

      // Check if volume is sufficient for our position size
      if (min24hVolume < Infinity && min24hVolume > 0) {
        if (min24hVolume < effectiveMinVolume) {
          // Calculate what position size WOULD work with this volume
          const maxViablePosition = min24hVolume * (config.maxPositionToVolumePercent / 100);
          
          if (maxViablePosition < config.minPositionSizeUsd) {
            // Volume is so low that even minimum position won't fill quickly
            return Result.failure(
              new ValidationException(
                `Insufficient 24h volume for quick fills: $${min24hVolume.toLocaleString()} ` +
                `(need $${effectiveMinVolume.toLocaleString()} for $${positionSizeUsd.toFixed(0)} position at ${config.maxPositionToVolumePercent}% max)`,
                'INSUFFICIENT_VOLUME',
                {
                  symbol: opportunity.symbol,
                  long24hVolume,
                  short24hVolume,
                  requiredVolume: effectiveMinVolume,
                  actualVolume: min24hVolume,
                  positionSize: positionSizeUsd,
                  maxPositionPercent: config.maxPositionToVolumePercent,
                },
              ),
            );
          }
          
          // Cap position to what volume supports
          this.logger.debug(
            `📊 Reducing position for ${opportunity.symbol} from $${positionSizeUsd.toFixed(0)} to $${maxViablePosition.toFixed(0)} ` +
            `(${config.maxPositionToVolumePercent}% of 24h volume $${min24hVolume.toLocaleString()}) - prioritizing quick fills`,
          );
          positionSizeUsd = maxViablePosition;
          positionSizeBaseAsset = positionSizeUsd / avgMarkPrice;
        }
      } else if (min24hVolume === 0 || !isFinite(min24hVolume)) {
        // No volume data available - fall back to absolute minimum if set
        if (config.min24hVolumeUsd > 0) {
          this.logger.warn(
            `⚠️ No volume data for ${opportunity.symbol} - skipping (min volume requirement: $${config.min24hVolumeUsd.toLocaleString()})`,
          );
          return Result.failure(
            new ValidationException(
              `No volume data available for ${opportunity.symbol}`,
              'MISSING_VOLUME_DATA',
              {
                symbol: opportunity.symbol,
                long24hVolume,
                short24hVolume,
              },
            ),
          );
        }
        // If no minimum configured and no data, proceed with caution (OI filter still applies)
        this.logger.debug(`⚠️ No volume data for ${opportunity.symbol} - proceeding (no min volume configured)`);
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
        this.logger.debug(
          `Opportunity ${opportunity.symbol} rejected (profitability): ` +
            `Position: $${positionSizeUsd.toFixed(2)}, ` +
            `Hourly return: $${expectedReturnPerPeriod.toFixed(4)}, ` +
            `Entry fees: $${totalEntryFees.toFixed(4)}, ` +
            `Exit fees: $${totalExitFees.toFixed(4)}, ` +
            `Slippage: $${totalSlippageCost.toFixed(4)}, ` +
            `Total costs: $${totalCostsWithExit.toFixed(4)}, ` +
            `Break-even: ${breakEvenHours !== null ? breakEvenHours.toFixed(1) : 'N/A'}h (max: ${maxBreakEvenHours.toFixed(1)}h), ` +
            `Amortized costs/hour: $${amortizedCosts.toFixed(4)}, ` +
            `Net return/hour: $${expectedNetReturn.toFixed(4)}`,
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

      // Calculate limit prices: use mark price directly for Hyperliquid and Lighter
      // This ensures orders are close to mark price and fill quickly, avoiding "price too high" rejections
      // For other exchanges: use best bid/ask without price improvement
      // LONG orders: at mark price (for Hyperliquid/Lighter) or best bid (for others)
      // SHORT orders: at mark price (for Hyperliquid/Lighter) or best ask (for others)
      const longLimitPrice = (opportunity.longExchange === ExchangeType.HYPERLIQUID || 
                              opportunity.longExchange === ExchangeType.LIGHTER)
        ? finalLongMarkPrice
        : longBidAsk.bestBid;
      const shortLimitPrice = (opportunity.shortExchange === ExchangeType.HYPERLIQUID || 
                               opportunity.shortExchange === ExchangeType.LIGHTER)
        ? finalShortMarkPrice
        : shortBidAsk.bestAsk;

      const longPriceSource = (opportunity.longExchange === ExchangeType.HYPERLIQUID || 
                               opportunity.longExchange === ExchangeType.LIGHTER) ? 'mark' : 'best bid';
      const shortPriceSource = (opportunity.shortExchange === ExchangeType.HYPERLIQUID || 
                                opportunity.shortExchange === ExchangeType.LIGHTER) ? 'mark' : 'best ask';
      
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
