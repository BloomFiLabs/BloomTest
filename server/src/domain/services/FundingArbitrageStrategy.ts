import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { PerpOrderRequest, OrderSide, OrderType, TimeInForce } from '../value-objects/PerpOrder';
import { PerpPosition } from '../entities/PerpPosition';
import { FundingRateAggregator, ArbitrageOpportunity, ExchangeSymbolMapping } from './FundingRateAggregator';
import { IPerpExchangeAdapter } from '../ports/IPerpExchangeAdapter';
import { HistoricalFundingRateService, HistoricalMetrics } from '../../infrastructure/services/HistoricalFundingRateService';
import { PositionLossTracker } from '../../infrastructure/services/PositionLossTracker';
import { PerpKeeperPerformanceLogger } from '../../infrastructure/logging/PerpKeeperPerformanceLogger';
import { PortfolioRiskAnalyzer } from '../../infrastructure/services/PortfolioRiskAnalyzer';

/**
 * Execution plan for an arbitrage opportunity
 */
export interface ArbitrageExecutionPlan {
  opportunity: ArbitrageOpportunity;
  longOrder: PerpOrderRequest;
  shortOrder: PerpOrderRequest;
  positionSize: number; // Position size in base asset
  estimatedCosts: {
    fees: number;
    slippage: number;
    total: number;
  };
  expectedNetReturn: number; // After costs
  timestamp: Date;
}

/**
 * Strategy execution result
 */
export interface ArbitrageExecutionResult {
  success: boolean;
  opportunitiesEvaluated: number;
  opportunitiesExecuted: number;
  totalExpectedReturn: number;
  ordersPlaced: number;
  errors: string[];
  timestamp: Date;
}

/**
 * FundingArbitrageStrategy - Implements arbitrage-focused decision logic
 */
@Injectable()
export class FundingArbitrageStrategy {
  private readonly logger = new Logger(FundingArbitrageStrategy.name);

  // Default configuration
  private readonly DEFAULT_MIN_SPREAD = 0.0001; // 0.01% minimum spread
  private readonly MIN_POSITION_SIZE_USD = 10; // Minimum $10 to cover fees (very small for testing)
  private readonly BALANCE_USAGE_PERCENT = 0.9; // Use 90% of available balance (leave 10% buffer)
  private readonly leverage: number; // Leverage multiplier (configurable via KEEPER_LEVERAGE env var)
  private readonly MAX_WORST_CASE_BREAK_EVEN_DAYS = 7; // Maximum break-even time for worst-case selection
  private readonly MIN_OPEN_INTEREST_USD = 10000; // Minimum $10k open interest per exchange for liquidity
  private readonly MIN_TOTAL_OPEN_INTEREST_USD = 20000; // Minimum $20k total OI across both exchanges

  // Exchange-specific fee rates (maker fees for limit orders)
  // Hyperliquid: Tier 0 (≤ $5M 14D volume) - Perps Maker: 0.0150%
  // Aster: Maker 0.0050% (much cheaper than 0.0400% taker)
  // Lighter: 0% maker/taker fees (no trading fees)
  private readonly EXCHANGE_FEE_RATES: Map<ExchangeType, number> = new Map([
    [ExchangeType.HYPERLIQUID, 0.00015], // 0.0150% maker fee (tier 0)
    [ExchangeType.ASTER, 0.00005],       // 0.0050% maker fee
    [ExchangeType.LIGHTER, 0],            // 0% fees (no trading fees)
  ]);
  
  // Small price improvement to ensure limit orders fill quickly while remaining maker orders
  // 0.01% improvement makes orders competitive but still adds liquidity to the book
  private readonly LIMIT_ORDER_PRICE_IMPROVEMENT = 0.0001; // 0.01%

  constructor(
    private readonly aggregator: FundingRateAggregator,
    private readonly configService: ConfigService,
    private readonly historicalService: HistoricalFundingRateService,
    private readonly lossTracker: PositionLossTracker,
    private readonly portfolioRiskAnalyzer: PortfolioRiskAnalyzer,
    @Optional() private readonly performanceLogger?: PerpKeeperPerformanceLogger,
  ) {
    // Get leverage from config, default to 2.0x
    // Leverage improves net returns: 2x leverage = 2x funding returns, but fees stay same %
    // Example: $100 capital, 2x leverage = $200 notional, 10% APY = $20/year vs $10/year (2x improvement)
    this.leverage = parseFloat(
      this.configService.get<string>('KEEPER_LEVERAGE') || '2.0'
    );
    this.logger.log(`Funding arbitrage strategy initialized with ${this.leverage}x leverage`);
  }

  /**
   * Create execution plan for an arbitrage opportunity (with pre-fetched balances)
   * @param opportunity The arbitrage opportunity
   * @param adapters Map of exchange adapters
   * @param maxPositionSizeUsd Optional maximum position size
   * @param longMarkPrice Optional mark price for long exchange (from funding rate data)
   * @param shortMarkPrice Optional mark price for short exchange (from funding rate data)
   * @param longBalance Pre-fetched balance for long exchange (to reduce API calls)
   * @param shortBalance Pre-fetched balance for short exchange (to reduce API calls)
   */
  private async createExecutionPlanWithBalances(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    maxPositionSizeUsd: number | undefined,
    longMarkPrice: number | undefined,
    shortMarkPrice: number | undefined,
    longBalance: number,
    shortBalance: number,
  ): Promise<ArbitrageExecutionPlan | null> {
    try {
      const longAdapter = adapters.get(opportunity.longExchange);
      const shortAdapter = adapters.get(opportunity.shortExchange);

      if (!longAdapter || !shortAdapter) {
        this.logger.warn(`Missing adapters for opportunity: ${opportunity.symbol}`);
        return null;
      }

      // Use pre-fetched balances (no API calls here!)

      // Use provided mark prices if available, otherwise fetch (but prefer cached)
      let finalLongMarkPrice = longMarkPrice;
      let finalShortMarkPrice = shortMarkPrice;

      if (!finalLongMarkPrice || finalLongMarkPrice === 0) {
        try {
          finalLongMarkPrice = await longAdapter.getMarkPrice(opportunity.symbol);
        } catch (error: any) {
          this.logger.debug(`Failed to get mark price for ${opportunity.symbol} on ${opportunity.longExchange}: ${error.message}`);
          return null; // Can't proceed without mark price
        }
      }

      if (!finalShortMarkPrice || finalShortMarkPrice === 0) {
        try {
          finalShortMarkPrice = await shortAdapter.getMarkPrice(opportunity.symbol);
        } catch (error: any) {
          this.logger.debug(`Failed to get mark price for ${opportunity.symbol} on ${opportunity.shortExchange}: ${error.message}`);
          return null; // Can't proceed without mark price
        }
      }

      // Determine position size based on actual available capital
      // Use the minimum balance between the two exchanges (can't trade more than the smaller balance)
      const minBalance = Math.min(longBalance, shortBalance);
      const availableCapital = minBalance * this.BALANCE_USAGE_PERCENT; // Use 90% of minimum balance
      
      // Apply leverage to increase position size (and returns)
      // Leverage multiplies both returns and position size, but fees stay the same percentage
      // So net returns improve with leverage (e.g., 2x leverage = 2x returns, same fee %)
      // Example: $100 capital, 2x leverage = $200 notional, 10% APY = $20/year vs $10/year (2x improvement)
      const leveragedCapital = availableCapital * this.leverage;
      
      // Apply max position size limit if specified (this is the leveraged size)
      const maxSize = maxPositionSizeUsd || Infinity; // No default max, use whatever balance is available
      
      // Calculate position size - must be at least MIN_POSITION_SIZE_USD to cover fees
      // Note: positionSizeUsd is the NOTIONAL size (with leverage), not the collateral
      let positionSizeUsd = Math.min(leveragedCapital, maxSize);
      
      // Log leverage usage for transparency
      if (this.leverage > 1) {
        this.logger.debug(
          `Using ${this.leverage}x leverage for ${opportunity.symbol}: ` +
          `Capital: $${availableCapital.toFixed(2)} → Notional: $${positionSizeUsd.toFixed(2)}`
        );
      }
      
      // Check if we have enough to cover minimum
      if (positionSizeUsd < this.MIN_POSITION_SIZE_USD) {
        this.logger.debug(
          `Insufficient balance for ${opportunity.symbol}: ` +
          `Need $${this.MIN_POSITION_SIZE_USD}, have $${positionSizeUsd.toFixed(2)} ` +
          `(Long: $${longBalance.toFixed(2)}, Short: $${shortBalance.toFixed(2)})`
        );
        return null; // Skip this opportunity
      }

      // Convert to base asset size (recalculate after potential OI adjustment)
      const avgMarkPrice = (finalLongMarkPrice + finalShortMarkPrice) / 2;
      let positionSize = positionSizeUsd / avgMarkPrice;

      // Estimate costs using exchange-specific fee rates
      // Get fee rates for both exchanges (taker fees for market orders)
      const longFeeRate = this.EXCHANGE_FEE_RATES.get(opportunity.longExchange) || 0.0005; // Default 0.05% if unknown
      const shortFeeRate = this.EXCHANGE_FEE_RATES.get(opportunity.shortExchange) || 0.0005; // Default 0.05% if unknown
      
      // Check liquidity (open interest) - ensure sufficient liquidity for our position size
      // For arbitrage, we need liquidity on BOTH sides (long exchange for long position, short exchange for short position)
      const longOI = opportunity.longOpenInterest || 0;
      const shortOI = opportunity.shortOpenInterest || 0;
      
      // Reject opportunities where OI data is unavailable (N/A) - we need OI data to assess liquidity
      if (opportunity.longOpenInterest === undefined || opportunity.longOpenInterest === null || longOI === 0) {
        this.logger.debug(
          `Opportunity ${opportunity.symbol} rejected: Open interest unavailable (N/A) on LONG exchange. ` +
          `Long OI: ${opportunity.longOpenInterest === undefined || opportunity.longOpenInterest === null ? 'N/A' : '$' + longOI.toFixed(2)}`
        );
        return null;
      }
      
      if (opportunity.shortOpenInterest === undefined || opportunity.shortOpenInterest === null || shortOI === 0) {
        this.logger.debug(
          `Opportunity ${opportunity.symbol} rejected: Open interest unavailable (N/A) on SHORT exchange. ` +
          `Short OI: ${opportunity.shortOpenInterest === undefined || opportunity.shortOpenInterest === null ? 'N/A' : '$' + shortOI.toFixed(2)}`
        );
        return null;
      }
      
      // Check liquidity on each side separately
      // We need liquidity on the long exchange for the long position
      if (longOI < this.MIN_OPEN_INTEREST_USD) {
        this.logger.debug(
          `Opportunity ${opportunity.symbol} rejected: Insufficient liquidity on LONG exchange. ` +
          `Long OI: $${longOI.toFixed(2)}, Min required: $${this.MIN_OPEN_INTEREST_USD}`
        );
        return null;
      }
      
      // We need liquidity on the short exchange for the short position
      if (shortOI < this.MIN_OPEN_INTEREST_USD) {
        this.logger.debug(
          `Opportunity ${opportunity.symbol} rejected: Insufficient liquidity on SHORT exchange. ` +
          `Short OI: $${shortOI.toFixed(2)}, Min required: $${this.MIN_OPEN_INTEREST_USD}`
        );
        return null;
      }
      
      // Adjust position size based on available liquidity (use minimum of both sides)
      // Position size should be < 5% of minimum OI to avoid market impact
      const minOI = Math.min(longOI || Infinity, shortOI || Infinity);
      if (minOI < Infinity && minOI > 0) {
        const maxPositionSizeFromOI = minOI * 0.05; // 5% of minimum OI
        
        // Check if market can support the ACTUAL position size we want to trade
        // Ensure we don't exceed 5% of OI to avoid market impact
        if (positionSizeUsd > maxPositionSizeFromOI) {
          // Reduce position size to fit within liquidity constraints
          this.logger.debug(
            `Reducing position size for ${opportunity.symbol} due to liquidity: ` +
            `Requested: $${positionSizeUsd.toFixed(2)}, ` +
            `Max from OI: $${maxPositionSizeFromOI.toFixed(2)}`
          );
          positionSizeUsd = maxPositionSizeFromOI;
          // Recalculate position size in base asset
          positionSize = positionSizeUsd / avgMarkPrice;
        }
        
        // Only reject if reduced position size is below minimum viable size
        if (positionSizeUsd < this.MIN_POSITION_SIZE_USD) {
          this.logger.debug(
            `Opportunity ${opportunity.symbol} rejected: Insufficient liquidity. ` +
            `Max position from OI: $${maxPositionSizeFromOI.toFixed(2)}, ` +
            `Required minimum: $${this.MIN_POSITION_SIZE_USD.toFixed(2)}`
          );
          return null;
        }
      }
      
      // Get exchange-specific symbol formats for order placement (needed before bid/ask fetch)
      // Aster: needs "ETHUSDT" format
      // Lighter: needs normalized symbol, adapter will look up marketIndex
      // Hyperliquid: needs "ETH" format
      const longExchangeSymbol = this.aggregator.getExchangeSymbol(opportunity.symbol, opportunity.longExchange);
      const shortExchangeSymbol = this.aggregator.getExchangeSymbol(opportunity.symbol, opportunity.shortExchange);
      
      // For Lighter (marketIndex is number), we still pass normalized symbol and adapter handles lookup
      // For Aster/Hyperliquid (string symbols), we use the exchange-specific format
      const longSymbol = typeof longExchangeSymbol === 'string' 
        ? longExchangeSymbol 
        : opportunity.symbol; // For Lighter, use normalized symbol
      const shortSymbol = typeof shortExchangeSymbol === 'string' 
        ? shortExchangeSymbol 
        : opportunity.symbol; // For Lighter, use normalized symbol

      // Get best bid/ask prices for slippage calculation (needed before cost calculation)
      const longBidAsk = await this.getBestBidAsk(longAdapter, longSymbol, opportunity.symbol, opportunity.longExchange);
      const shortBidAsk = await this.getBestBidAsk(shortAdapter, shortSymbol, opportunity.symbol, opportunity.shortExchange);
      
      // Calculate slippage costs for the ACTUAL position size we'll trade
      // Use actual positionSizeUsd (based on balances) for accurate cost calculation
      // This matches the logging calculation and ensures consistency
      const slippagePositionSize = positionSizeUsd;
      const longSlippage = this.calculateSlippageCost(
        slippagePositionSize,
        longBidAsk.bestBid,
        longBidAsk.bestAsk,
        opportunity.longOpenInterest || 0,
        OrderType.LIMIT,
      );
      const shortSlippage = this.calculateSlippageCost(
        slippagePositionSize,
        shortBidAsk.bestBid,
        shortBidAsk.bestAsk,
        opportunity.shortOpenInterest || 0,
        OrderType.LIMIT,
      );
      const totalSlippageCost = longSlippage + shortSlippage;
      
      // Calculate fees: entry fees on both exchanges (exit fees apply when closing, not included here)
      // We only account for entry fees since we're opening positions
      const longEntryFee = positionSizeUsd * longFeeRate;
      const shortEntryFee = positionSizeUsd * shortFeeRate;
      const totalEntryFees = longEntryFee + shortEntryFee;
      
      // For exit fees, we'll estimate them the same way (when closing positions)
      const totalExitFees = totalEntryFees; // Same calculation for exit
      
      // IMPORTANT: Only check entry fees + slippage for initial profitability check
      // Exit fees are paid later when closing, so we don't need to cover them upfront
      // This allows more opportunities to be considered profitable
      // We'll still track exit fees for break-even calculations
      // Slippage is included because it affects the entry price immediately
      const totalCosts = totalEntryFees + totalSlippageCost; // Entry fees + slippage for initial check

      // Calculate expected return (annualized, then convert to per-period)
      // Funding rates are typically hourly (e.g., 0.0013% per hour ≈ 10% annualized)
      // With leverage, returns scale with leverage (2x leverage = 2x returns)
      const periodsPerDay = 24; // Hourly funding periods
      const periodsPerYear = periodsPerDay * 365; // 8760 hours per year
      
      // Predict funding rate impact based on our position size relative to OI
      // Large positions can affect funding rate calculation by shifting OI-weighted premium
      // Impact is typically small unless position > 5-10% of OI
      const longFundingImpact = this.predictFundingRateImpact(
        positionSizeUsd,
        opportunity.longOpenInterest || 0,
        opportunity.longRate,
      );
      const shortFundingImpact = this.predictFundingRateImpact(
        positionSizeUsd,
        opportunity.shortOpenInterest || 0,
        opportunity.shortRate,
      );
      
      // Adjusted funding rates accounting for our position impact
      // Long position increases funding rate (more longs = higher premium)
      // Short position decreases funding rate (more shorts = lower premium)
      // Validate funding rates are valid numbers before calculation
      const longRate = opportunity.longRate !== undefined && !isNaN(opportunity.longRate) ? opportunity.longRate : 0;
      const shortRate = opportunity.shortRate !== undefined && !isNaN(opportunity.shortRate) ? opportunity.shortRate : 0;
      
      const adjustedLongRate = longRate + longFundingImpact;
      const adjustedShortRate = shortRate - shortFundingImpact;
      
      // Recalculate spread with adjusted rates
      const adjustedSpread = Math.abs(adjustedLongRate - adjustedShortRate);
      const adjustedExpectedReturn = adjustedSpread * periodsPerYear; // Annualized APY
      
      // Note: opportunity.expectedReturn is already annualized (APY as decimal, e.g., 0.3625 = 36.25% APY)
      // APY calculation: spread * periodsPerYear (done in FundingRateAggregator)
      // To get hourly return: (APY / periodsPerYear) * positionSizeUsd
      // Returns scale with leverage: if we use 2x leverage, we get 2x the funding rate returns
      // But fees are a percentage of notional, so they scale too, but net return still improves
      // Use adjusted expected return if impact is significant (>1% of original spread) and valid
      const useAdjusted = Math.abs(longFundingImpact + shortFundingImpact) > opportunity.spread * 0.01;
      const effectiveExpectedReturn = (useAdjusted && !isNaN(adjustedExpectedReturn) && isFinite(adjustedExpectedReturn))
        ? adjustedExpectedReturn
        : (opportunity.expectedReturn !== undefined && !isNaN(opportunity.expectedReturn) ? opportunity.expectedReturn : 0);
      
      const expectedReturnPerPeriod = (effectiveExpectedReturn / periodsPerYear) * positionSizeUsd;
      
      // Calculate break-even hours: how many hours to cover all costs (entry + exit + slippage)
      const totalCostsWithExit = totalEntryFees + totalExitFees + totalSlippageCost;
      let breakEvenHours: number | null = null;
      let expectedNetReturn: number;
      
      if (expectedReturnPerPeriod > 0) {
        breakEvenHours = totalCostsWithExit / expectedReturnPerPeriod;
        
        // Amortize one-time costs over break-even period (capped at 24h) to determine profitability
        // This way, opportunities that break even quickly are considered profitable
        const amortizationPeriods = Math.max(1, Math.min(24, Math.ceil(breakEvenHours))); // Amortize over break-even time, capped at 24h
        const amortizedCostsPerPeriod = totalCostsWithExit / amortizationPeriods;
        expectedNetReturn = expectedReturnPerPeriod - amortizedCostsPerPeriod;
      } else {
        // No expected return, so net return is negative (costs only)
        expectedNetReturn = -totalCosts;
      }

      // Only proceed if net return is positive (after amortization)
      if (expectedNetReturn <= 0) {
        const amortizedCosts = breakEvenHours !== null 
          ? totalCostsWithExit / Math.max(1, Math.min(24, Math.ceil(breakEvenHours)))
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
          `Net return/hour: $${expectedNetReturn.toFixed(4)}`
        );
        return null;
      }

      this.logger.log(
        `✅ Execution plan created for ${opportunity.symbol}: ` +
        `Position size: $${positionSizeUsd.toFixed(2)}, ` +
        `Expected net return per period: $${expectedNetReturn.toFixed(4)}, ` +
        `Spread: ${(opportunity.spread * 100).toFixed(4)}%`
      );

      // Calculate limit prices using already-fetched bid/ask prices:
      // LONG: Place at best bid + 0.01% improvement (competitive but still maker)
      // SHORT: Place at best ask - 0.01% improvement (competitive but still maker)
      const longLimitPrice = longBidAsk.bestBid * (1 + this.LIMIT_ORDER_PRICE_IMPROVEMENT);
      const shortLimitPrice = shortBidAsk.bestAsk * (1 - this.LIMIT_ORDER_PRICE_IMPROVEMENT);
      
      this.logger.debug(
        `Limit order prices for ${opportunity.symbol}: ` +
        `LONG @ ${longLimitPrice.toFixed(4)} (best bid: ${longBidAsk.bestBid.toFixed(4)}), ` +
        `SHORT @ ${shortLimitPrice.toFixed(4)} (best ask: ${shortBidAsk.bestAsk.toFixed(4)}), ` +
        `Slippage cost: $${totalSlippageCost.toFixed(2)}`
      );

      // Create LIMIT order requests with competitive prices (maker orders)
      const longOrder = new PerpOrderRequest(
        longSymbol,
        OrderSide.LONG,
        OrderType.LIMIT,
        positionSize,
        longLimitPrice,
        TimeInForce.GTC, // Good Till Canceled - order stays on book until filled
      );

      const shortOrder = new PerpOrderRequest(
        shortSymbol,
        OrderSide.SHORT,
        OrderType.LIMIT,
        positionSize,
        shortLimitPrice,
        TimeInForce.GTC, // Good Till Canceled - order stays on book until filled
      );

      return {
        opportunity,
        longOrder,
        shortOrder,
        positionSize,
        estimatedCosts: {
          fees: totalEntryFees + totalExitFees, // Full fees for tracking
          slippage: totalSlippageCost, // Slippage cost based on order book depth
          total: totalEntryFees + totalExitFees + totalSlippageCost, // Full costs including slippage
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
   * Calculate slippage cost based on order book depth and position size
   * Uses square root model: slippage increases with sqrt(order_size / liquidity)
   */
  private calculateSlippageCost(
    positionSizeUsd: number,
    bestBid: number,
    bestAsk: number,
    openInterest: number,
    orderType: OrderType,
  ): number {
    const spread = bestAsk - bestBid;
    const midPrice = (bestBid + bestAsk) / 2;
    const spreadPercent = midPrice > 0 ? spread / midPrice : 0.001; // Default 0.1% if no price
    
    // Base slippage: limit orders have minimal slippage (we're adding liquidity)
    // Market orders would pay half the spread
    const baseSlippage = orderType === OrderType.MARKET 
      ? spreadPercent / 2  // Pay half the spread for market orders
      : 0.0001; // Minimal slippage for limit orders (0.01%)
    
    // Market impact: how much our order size affects price
    // Use open interest as proxy for liquidity
    // Position size should be < 5% of OI to avoid significant impact
    if (openInterest > 0) {
      const liquidityRatio = positionSizeUsd / openInterest;
      // Square root model: impact increases with sqrt(size/liquidity)
      // Cap impact at 2% for very large orders
      const impactSlippage = Math.min(
        Math.sqrt(Math.min(liquidityRatio, 1)) * spreadPercent * 2,
        0.02 // Cap at 2%
      );
      
      return positionSizeUsd * (baseSlippage + impactSlippage);
    }
    
    // Fallback: use conservative estimate if no OI data
    const conservativeSlippage = orderType === OrderType.MARKET ? 0.0005 : 0.0001;
    return positionSizeUsd * conservativeSlippage;
  }

  /**
   * Calculate maximum portfolio size that maintains target net APY (35%)
   * Accounts for slippage scaling with position size relative to OI
   */
  private calculateMaxPortfolioForTargetAPY(
    opportunity: ArbitrageOpportunity,
    longBidAsk: { bestBid: number; bestAsk: number },
    shortBidAsk: { bestBid: number; bestAsk: number },
    targetNetAPY: number = 0.35,
  ): number | null {
    const periodsPerYear = 24 * 365;
    
    // Get historical weighted average rates (more robust than current snapshot)
    const currentLongRate = opportunity.longRate !== undefined && !isNaN(opportunity.longRate) ? opportunity.longRate : 0;
    const currentShortRate = opportunity.shortRate !== undefined && !isNaN(opportunity.shortRate) ? opportunity.shortRate : 0;
    
    const historicalLongRate = this.historicalService.getWeightedAverageRate(
      opportunity.symbol,
      opportunity.longExchange,
      currentLongRate,
    );
    const historicalShortRate = this.historicalService.getWeightedAverageRate(
      opportunity.symbol,
      opportunity.shortExchange,
      currentShortRate,
    );
    
    // Get historical weighted average spread
    const historicalSpread = this.historicalService.getAverageSpread(
      opportunity.symbol,
      opportunity.longExchange,
      opportunity.symbol,
      opportunity.shortExchange,
      currentLongRate,
      currentShortRate,
    );
    
    // Log historical data usage (debug level to avoid spam)
    const longDataPoints = this.historicalService.getHistoricalData(opportunity.symbol, opportunity.longExchange).length;
    const shortDataPoints = this.historicalService.getHistoricalData(opportunity.symbol, opportunity.shortExchange).length;
    const usingHistorical = longDataPoints > 0 || shortDataPoints > 0;
    
    if (usingHistorical) {
      this.logger.debug(
        `📊 Max Portfolio Calc (${opportunity.symbol}): Using historical rates ` +
        `(Long: ${longDataPoints}pts, Short: ${shortDataPoints}pts) ` +
        `| Historical spread: ${(historicalSpread * 100).toFixed(4)}% ` +
        `| Current spread: ${((currentLongRate - currentShortRate) * 100).toFixed(4)}%`
      );
    } else {
      this.logger.debug(
        `📊 Max Portfolio Calc (${opportunity.symbol}): Insufficient historical data, using current rates ` +
        `| Current spread: ${((currentLongRate - currentShortRate) * 100).toFixed(4)}%`
      );
    }
    
    // Use historical spread for initial gross APY calculation
    const grossAPY = Math.abs(historicalSpread) * periodsPerYear;
    
    if (grossAPY <= targetNetAPY) {
      return null; // Can't achieve target if gross APY is too low
    }
    
    // Get OI data
    const longOI = opportunity.longOpenInterest || 0;
    const shortOI = opportunity.shortOpenInterest || 0;
    const minOI = Math.min(longOI, shortOI);
    
    if (minOI <= 0) {
      return null; // Need OI data to calculate slippage
    }
    
    // Get fee rates
    const longFeeRate = this.EXCHANGE_FEE_RATES.get(opportunity.longExchange) || 0.0005;
    const shortFeeRate = this.EXCHANGE_FEE_RATES.get(opportunity.shortExchange) || 0.0005;
    const totalFeeRate = (longFeeRate + shortFeeRate) * 2; // Entry + exit fees for both legs
    
    // Binary search for max position size
    let low = 1000; // $1k minimum
    let high = Math.min(minOI * 0.1, 10000000); // Max 10% of OI or $10M
    let maxPortfolio: number | null = null;
    let finalEffectiveGrossAPY: number = 0; // Store for volatility adjustment
    
    // Iterate to find max position size
    for (let iter = 0; iter < 50; iter++) {
      const testPosition = (low + high) / 2;
      
      // Calculate slippage for this position size using existing method
      const longSlippage = this.calculateSlippageCost(
        testPosition,
        longBidAsk.bestBid,
        longBidAsk.bestAsk,
        longOI,
        OrderType.LIMIT,
      );
      const shortSlippage = this.calculateSlippageCost(
        testPosition,
        shortBidAsk.bestBid,
        shortBidAsk.bestAsk,
        shortOI,
        OrderType.LIMIT,
      );
      // Slippage is paid once per round trip (entry + exit), so we need entry and exit slippage
      // For entry: longSlippage + shortSlippage
      // For exit: same amount (closing positions)
      const entrySlippage = longSlippage + shortSlippage;
      const exitSlippage = entrySlippage; // Same when closing
      const totalSlippageCost = entrySlippage + exitSlippage;
      
      // Calculate fees (entry + exit for both legs)
      const entryFees = testPosition * (longFeeRate + shortFeeRate);
      const exitFees = entryFees; // Same when closing
      const totalFees = entryFees + exitFees;
      
      // Calculate funding rate impact for this position size (iterative)
      // Large positions affect funding rate calculation by shifting OI-weighted premium
      // Use historical rates as base (more robust than current snapshot)
      const longFundingImpact = this.predictFundingRateImpact(
        testPosition,
        longOI,
        historicalLongRate, // Use historical rate instead of current
      );
      const shortFundingImpact = this.predictFundingRateImpact(
        testPosition,
        shortOI,
        historicalShortRate, // Use historical rate instead of current
      );
      
      // Adjust funding rates based on our position impact
      // Long position increases funding rate (more longs = higher premium)
      // Short position decreases funding rate (more shorts = lower premium)
      // Use historical rates as base
      const adjustedLongRate = historicalLongRate + longFundingImpact;
      const adjustedShortRate = historicalShortRate - shortFundingImpact;
      
      // Recalculate spread with adjusted rates
      const adjustedSpread = Math.abs(adjustedLongRate - adjustedShortRate);
      const adjustedGrossAPY = adjustedSpread * periodsPerYear;
      
      // Use adjusted gross APY (accounts for funding rate impact)
      const effectiveGrossAPY = adjustedGrossAPY;
      
      // Total one-time costs (slippage + fees) amortized over a year
      // These costs reduce effective return, so we amortize them hourly
      const totalOneTimeCosts = totalSlippageCost + totalFees;
      const amortizedCostsPerHour = totalOneTimeCosts / periodsPerYear;
      
      // Calculate net return per hour using adjusted gross APY
      const grossReturnPerHour = (effectiveGrossAPY / periodsPerYear) * testPosition;
      const netReturnPerHour = grossReturnPerHour - amortizedCostsPerHour;
      const netAPY = testPosition > 0 ? (netReturnPerHour * periodsPerYear) / testPosition : 0;
      
      if (Math.abs(netAPY - targetNetAPY) < 0.001) {
        // Found it!
        maxPortfolio = testPosition;
        finalEffectiveGrossAPY = effectiveGrossAPY; // Store for volatility adjustment
        break;
      } else if (netAPY > targetNetAPY) {
        // Can go larger
        low = testPosition;
        maxPortfolio = testPosition; // Update best so far
        finalEffectiveGrossAPY = effectiveGrossAPY; // Store for volatility adjustment
      } else {
        // Too large, reduce
        high = testPosition;
      }
      
      if (high - low < 100) {
        // Converged
        break;
      }
    }
    
    // Apply volatility-based portfolio size reduction
    // Higher volatility = smaller portfolio = faster break-even = less funding delta exposure
    if (maxPortfolio !== null && maxPortfolio > 0) {
      const volatilityMetrics = this.historicalService.getSpreadVolatilityMetrics(
        opportunity.symbol,
        opportunity.longExchange,
        opportunity.symbol,
        opportunity.shortExchange,
        30, // 30 days
      );
      
      if (volatilityMetrics) {
        // Calculate break-even time for this position size
        // Use the final test position (maxPortfolio) to calculate break-even
        const finalTestPosition = maxPortfolio;
        
        // Recalculate costs for final position size
        const finalLongSlippage = this.calculateSlippageCost(
          finalTestPosition,
          longBidAsk.bestBid,
          longBidAsk.bestAsk,
          longOI,
          OrderType.LIMIT,
        );
        const finalShortSlippage = this.calculateSlippageCost(
          finalTestPosition,
          shortBidAsk.bestBid,
          shortBidAsk.bestAsk,
          shortOI,
          OrderType.LIMIT,
        );
        const finalEntrySlippage = finalLongSlippage + finalShortSlippage;
        const finalExitSlippage = finalEntrySlippage;
        const finalTotalSlippageCost = finalEntrySlippage + finalExitSlippage;
        const finalEntryFees = finalTestPosition * (longFeeRate + shortFeeRate);
        const finalExitFees = finalEntryFees;
        const finalTotalFees = finalEntryFees + finalExitFees;
        const finalTotalOneTimeCosts = finalTotalSlippageCost + finalTotalFees;
        
        // Calculate hourly return for final position
        const finalHourlyReturn = (finalEffectiveGrossAPY / periodsPerYear) * finalTestPosition;
        const breakEvenHours = finalHourlyReturn > 0 ? finalTotalOneTimeCosts / finalHourlyReturn : Infinity;
        
        // Volatility-based portfolio reduction factors:
        // 1. Stability score penalty: Lower stability = smaller portfolio
        const stabilityPenalty = 1 - volatilityMetrics.stabilityScore; // 0-1, higher = more volatile
        
        // 2. Break-even time penalty: Longer break-even = more exposure = smaller portfolio
        // Target: break-even < 24 hours for volatile spreads, < 48 hours for stable spreads
        const maxBreakEvenHours = volatilityMetrics.stabilityScore < 0.5 ? 24 : 48;
        const breakEvenPenalty = breakEvenHours > maxBreakEvenHours && breakEvenHours < Infinity
          ? Math.min(0.5, (breakEvenHours - maxBreakEvenHours) / maxBreakEvenHours) // Up to 50% reduction
          : 0;
        
        // 3. Max hourly spread change penalty: Large changes = higher risk
        const maxChangePenalty = volatilityMetrics.maxHourlySpreadChange > 0.0001 // 0.01%
          ? Math.min(0.3, (volatilityMetrics.maxHourlySpreadChange - 0.0001) / 0.0002) // Up to 30% reduction
          : 0;
        
        // 4. Spread reversal penalty: More reversals = higher risk
        const reversalPenalty = volatilityMetrics.spreadReversals > 5
          ? Math.min(0.2, (volatilityMetrics.spreadReversals - 5) / 25) // Up to 20% reduction
          : 0;
        
        // Combine all penalties (weighted average)
        const totalVolatilityPenalty = Math.min(0.7, 
          stabilityPenalty * 0.4 + 
          breakEvenPenalty * 0.3 + 
          maxChangePenalty * 0.2 + 
          reversalPenalty * 0.1
        );
        
        // Apply volatility reduction to max portfolio
        const volatilityAdjustedMaxPortfolio = maxPortfolio * (1 - totalVolatilityPenalty);
        
        // Ensure minimum portfolio size ($1k)
        const finalMaxPortfolio = Math.max(1000, volatilityAdjustedMaxPortfolio);
        
        this.logger.debug(
          `📊 Volatility Adjustment (${opportunity.symbol}): ` +
          `Base=${(maxPortfolio / 1000).toFixed(1)}k, ` +
          `Stability=${(volatilityMetrics.stabilityScore * 100).toFixed(1)}%, ` +
          `BreakEven=${breakEvenHours.toFixed(1)}h, ` +
          `MaxChange=${(volatilityMetrics.maxHourlySpreadChange * 100).toFixed(4)}%, ` +
          `Reversals=${volatilityMetrics.spreadReversals}, ` +
          `Penalty=${(totalVolatilityPenalty * 100).toFixed(1)}%, ` +
          `Adjusted=${(finalMaxPortfolio / 1000).toFixed(1)}k`
        );
        
        return finalMaxPortfolio;
      }
    }
    
    return maxPortfolio;
  }

  /**
   * Calculate optimal portfolio allocation across all opportunities
   * Maximizes total portfolio size while maintaining aggregate 35% APY
   */
  /**
   * Validate historical data quality for an opportunity
   * Returns true if data is sufficient and reliable for portfolio allocation
   */
  /**
   * Calculate data quality risk factor (0-1) based on historical data availability
   * Returns 1.0 for high-quality data, lower values for data-poor opportunities
   * This factor will be used to reduce allocation for riskier opportunities
   */
  private calculateDataQualityRiskFactor(
    opportunity: ArbitrageOpportunity,
  ): number {
    const longData = this.historicalService.getHistoricalData(
      opportunity.symbol,
      opportunity.longExchange,
    );
    const shortData = this.historicalService.getHistoricalData(
      opportunity.symbol,
      opportunity.shortExchange,
    );
    
    // Target: 168+ hourly points (7 days) or 21+ Aster points (7 days at 8-hour intervals)
    const longExchange = opportunity.longExchange;
    const shortExchange = opportunity.shortExchange;
    const targetLongPoints = longExchange === ExchangeType.ASTER ? 21 : 168;
    const targetShortPoints = shortExchange === ExchangeType.ASTER ? 21 : 168;
    
    // Calculate data quality score for each exchange (0-1)
    const longQuality = Math.min(1.0, longData.length / targetLongPoints);
    const shortQuality = Math.min(1.0, shortData.length / targetShortPoints);
    
    // Use minimum quality (both exchanges need good data)
    const minQuality = Math.min(longQuality, shortQuality);
    
    // Risk factor: 1.0 = full allocation (high quality), 0.3 = minimal allocation (very poor data)
    // Scale: 0-0.1 data points = 0.3 risk factor (70% reduction)
    //        0.1-0.5 data points = 0.3-0.7 risk factor (gradual increase)
    //        0.5+ data points = 0.7-1.0 risk factor (good quality)
    let riskFactor: number;
    if (minQuality < 0.1) {
      // Very poor data (<10% of target): 30% allocation (70% reduction)
      riskFactor = 0.3;
    } else if (minQuality < 0.5) {
      // Poor data (10-50% of target): 30-70% allocation (linear interpolation)
      riskFactor = 0.3 + (minQuality - 0.1) * (0.7 - 0.3) / (0.5 - 0.1);
    } else {
      // Good data (50%+ of target): 70-100% allocation
      riskFactor = 0.7 + (minQuality - 0.5) * (1.0 - 0.7) / (1.0 - 0.5);
    }
    
    return Math.max(0.1, Math.min(1.0, riskFactor)); // Clamp between 0.1 and 1.0
  }

  private validateHistoricalDataQuality(
    opportunity: ArbitrageOpportunity,
    historicalSpread: number,
  ): { isValid: boolean; reason?: string } {
    // DATA QUALITY REQUIREMENTS RELAXED: Only check for obviously invalid spreads
    // No minimum data point requirement - will use whatever historical data is available
    // Falls back to current rates if historical data is insufficient
    // Data-poor opportunities will be marked as risky and receive less allocation
    
    // Only reject if spread is obviously invalid (negative or impossibly high)
    // Allow spreads from 0% to 50% (0 to 0.5) - very lenient
    const absSpread = Math.abs(historicalSpread);
    if (absSpread > 0.5) {
      return {
        isValid: false,
        reason: `Invalid historical spread: ${(historicalSpread * 100).toFixed(4)}% (exceeds 50% threshold)`,
      };
    }
    
    // Note: Negative spreads are allowed (they indicate reverse arbitrage opportunities)
    // The system will handle them appropriately in calculations
    
    // Additional validation: Check if we have matched data points
    // If getAverageSpread returns the current spread (fallback), we don't have historical data
    const currentSpread = Math.abs(opportunity.longRate - opportunity.shortRate);
    if (Math.abs(historicalSpread - currentSpread) < 0.0000001) {
      // Historical spread equals current spread - likely fallback, not real historical data
      return {
        isValid: false,
        reason: `No historical matched data (using current spread fallback)`,
      };
    }
    
    return { isValid: true };
  }

  private calculateOptimalPortfolioAllocation(
    opportunities: Array<{
      opportunity: ArbitrageOpportunity;
      maxPortfolioFor35APY: number | null;
      longBidAsk: { bestBid: number; bestAsk: number };
      shortBidAsk: { bestBid: number; bestAsk: number };
    }>,
    totalCapital: number | null = null,
    targetAggregateAPY: number = 0.35,
  ): {
    allocations: Map<string, number>; // symbol -> allocation amount
    totalPortfolio: number;
    aggregateAPY: number;
    opportunityCount: number;
    dataQualityWarnings: string[];
  } {
    const dataQualityWarnings: string[] = [];
    
    // Filter to only opportunities that can achieve target APY AND have valid historical data
    const validOpportunities = opportunities.filter((item) => {
      // Basic filter: must have maxPortfolioFor35APY
      if (item.maxPortfolioFor35APY === null || item.maxPortfolioFor35APY === undefined || item.maxPortfolioFor35APY <= 0) {
        return false;
      }
      
      // Validate historical data quality
      const currentLongRate = item.opportunity.longRate !== undefined && !isNaN(item.opportunity.longRate) ? item.opportunity.longRate : 0;
      const currentShortRate = item.opportunity.shortRate !== undefined && !isNaN(item.opportunity.shortRate) ? item.opportunity.shortRate : 0;
      
      const historicalSpread = this.historicalService.getAverageSpread(
        item.opportunity.symbol,
        item.opportunity.longExchange,
        item.opportunity.symbol,
        item.opportunity.shortExchange,
        currentLongRate,
        currentShortRate,
      );
      
      const validation = this.validateHistoricalDataQuality(item.opportunity, historicalSpread);
      if (!validation.isValid) {
        dataQualityWarnings.push(`${item.opportunity.symbol}: ${validation.reason}`);
        return false;
      }
      
      return true;
    });

    if (validOpportunities.length === 0) {
      this.logger.warn(`⚠️ No valid opportunities after filtering. ${dataQualityWarnings.length} opportunities excluded due to invalid spreads:`);
      dataQualityWarnings.forEach(warning => this.logger.warn(`  - ${warning}`));
      return {
        allocations: new Map(),
        totalPortfolio: 0,
        aggregateAPY: 0,
        opportunityCount: 0,
        dataQualityWarnings,
      };
    }
    
    if (dataQualityWarnings.length > 0) {
      this.logger.debug(`📊 Data Quality: ${dataQualityWarnings.length} opportunities excluded due to invalid spreads (data quality requirements relaxed - no minimum data points required)`);
      dataQualityWarnings.forEach(warning => this.logger.debug(`  - ${warning}`));
    }

    const periodsPerYear = 24 * 365;
    const allocations = new Map<string, number>();
    
    // Calculate max total portfolio (sum of all max portfolios)
    const maxTotalPortfolio = validOpportunities.reduce(
      (sum, item) => sum + (item.maxPortfolioFor35APY || 0),
      0
    );

    // Binary search for optimal total portfolio size
    let low = 0;
    let high = totalCapital !== null ? Math.min(totalCapital, maxTotalPortfolio) : maxTotalPortfolio;
    let bestTotalPortfolio = 0;
    let bestAllocations = new Map<string, number>();
    let bestAggregateAPY = 0;

    for (let iter = 0; iter < 50; iter++) {
      const testTotalPortfolio = (low + high) / 2;

      // Calculate weights based on max portfolio sizes
      const weights = new Map<string, number>();
      const totalMaxPortfolio = validOpportunities.reduce(
        (sum, item) => sum + (item.maxPortfolioFor35APY || 0),
        0
      );

      validOpportunities.forEach((item) => {
        const weight = totalMaxPortfolio > 0
          ? (item.maxPortfolioFor35APY || 0) / totalMaxPortfolio
          : 1 / validOpportunities.length;
        weights.set(item.opportunity.symbol, weight);
      });

      // Allocate proportionally, capped at each opportunity's max portfolio
      // Apply data quality risk factor to reduce allocation for data-poor opportunities
      const testAllocations = new Map<string, number>();
      let actualTotalPortfolio = 0;

      validOpportunities.forEach((item) => {
        const weight = weights.get(item.opportunity.symbol) || 0;
        const baseAllocation = Math.min(
          testTotalPortfolio * weight,
          item.maxPortfolioFor35APY || 0
        );
        
        // Apply data quality risk factor: data-poor opportunities get less allocation
        const dataQualityRiskFactor = this.calculateDataQualityRiskFactor(item.opportunity);
        const allocation = baseAllocation * dataQualityRiskFactor;
        
        testAllocations.set(item.opportunity.symbol, allocation);
        actualTotalPortfolio += allocation;
      });

      // Calculate weighted average APY
      // Since each opportunity's maxPortfolioFor35APY is calculated to achieve exactly 35% net APY,
      // and smaller allocations have higher net APY (less slippage/funding impact),
      // we need to estimate net APY for each allocation size.
      // 
      // Conservative approach: Assume net APY scales linearly with allocation ratio
      // At maxPortfolio: net APY = 35%
      // At 0: net APY = gross APY (no costs)
      // Linear interpolation: netAPY = grossAPY - (grossAPY - 0.35) * (allocation / maxPortfolio)
      let totalWeightedReturn = 0;
      let totalAllocated = 0;

      testAllocations.forEach((allocation, symbol) => {
        if (allocation > 0) {
          const item = validOpportunities.find((o) => o.opportunity.symbol === symbol);
          if (item && item.maxPortfolioFor35APY) {
            // Use historical weighted average spread instead of current snapshot
            const currentLongRate = item.opportunity.longRate !== undefined && !isNaN(item.opportunity.longRate) ? item.opportunity.longRate : 0;
            const currentShortRate = item.opportunity.shortRate !== undefined && !isNaN(item.opportunity.shortRate) ? item.opportunity.shortRate : 0;
            
            const historicalSpread = this.historicalService.getAverageSpread(
              item.opportunity.symbol,
              item.opportunity.longExchange,
              item.opportunity.symbol,
              item.opportunity.shortExchange,
              currentLongRate,
              currentShortRate,
            );
            
            // Get spread volatility metrics for risk adjustment
            const volatilityMetrics = this.historicalService.getSpreadVolatilityMetrics(
              item.opportunity.symbol,
              item.opportunity.longExchange,
              item.opportunity.symbol,
              item.opportunity.shortExchange,
              30, // 30 days
            );
            
            // Calculate gross APY from historical spread
            const grossAPY = Math.abs(historicalSpread) * periodsPerYear;
            const maxPortfolio = item.maxPortfolioFor35APY;
            const allocationRatio = Math.min(allocation / maxPortfolio, 1);
            
            // IMPORTANT: Recalculate slippage and fees at actual allocation size
            // Slippage scales non-linearly (square root), so we can't use linear interpolation
            const longFeeRate = this.EXCHANGE_FEE_RATES.get(item.opportunity.longExchange) || 0.0005;
            const shortFeeRate = this.EXCHANGE_FEE_RATES.get(item.opportunity.shortExchange) || 0.0005;
            const totalFeeRate = (longFeeRate + shortFeeRate) * 2; // Entry + exit
            
            // Calculate slippage at actual allocation size (not maxPortfolio)
            const longSlippage = this.calculateSlippageCost(
              allocation,
              item.longBidAsk.bestBid,
              item.longBidAsk.bestAsk,
              item.opportunity.longOpenInterest || 0,
              OrderType.LIMIT,
            );
            const shortSlippage = this.calculateSlippageCost(
              allocation,
              item.shortBidAsk.bestBid,
              item.shortBidAsk.bestAsk,
              item.opportunity.shortOpenInterest || 0,
              OrderType.LIMIT,
            );
            const totalSlippageCost = (longSlippage + shortSlippage) * 2; // Entry + exit
            
            // Calculate funding rate impact at actual allocation size
            const historicalLongRate = this.historicalService.getWeightedAverageRate(
              item.opportunity.symbol,
              item.opportunity.longExchange,
              item.opportunity.longRate || 0,
            );
            const historicalShortRate = this.historicalService.getWeightedAverageRate(
              item.opportunity.symbol,
              item.opportunity.shortExchange,
              item.opportunity.shortRate || 0,
            );
            
            const longFundingImpact = this.predictFundingRateImpact(
              allocation,
              item.opportunity.longOpenInterest || 0,
              historicalLongRate,
            );
            const shortFundingImpact = this.predictFundingRateImpact(
              allocation,
              item.opportunity.shortOpenInterest || 0,
              historicalShortRate,
            );
            
            const adjustedLongRate = historicalLongRate + longFundingImpact;
            const adjustedShortRate = historicalShortRate - shortFundingImpact;
            const adjustedSpread = Math.abs(adjustedLongRate - adjustedShortRate);
            const adjustedGrossAPY = adjustedSpread * periodsPerYear;
            
            // Calculate net APY: gross APY minus costs (amortized over a year)
            const totalOneTimeCosts = totalSlippageCost + (allocation * totalFeeRate);
            const amortizedCostsPerHour = totalOneTimeCosts / periodsPerYear;
            const grossReturnPerHour = (adjustedGrossAPY / periodsPerYear) * allocation;
            const netReturnPerHour = grossReturnPerHour - amortizedCostsPerHour;
            let estimatedNetAPY = allocation > 0 ? (netReturnPerHour * periodsPerYear) / allocation : 0;
            
            // Apply volatility risk adjustment (additional discount beyond what's in maxPortfolio)
            // Note: maxPortfolio already includes volatility adjustment, but we apply additional discount
            // for the portfolio-level aggregation to account for correlation risk
            if (volatilityMetrics) {
              // Stability score: 0-1, higher = more stable
              // Risk discount: (1 - stabilityScore) * riskPenaltyFactor
              // More volatile spreads get a larger discount
              const riskPenaltyFactor = 0.15; // Reduced from 0.3 since maxPortfolio already accounts for volatility
              const riskDiscount = (1 - volatilityMetrics.stabilityScore) * riskPenaltyFactor;
              
              // Additional penalty for spreads that drop to zero or reverse frequently
              const zeroDropPenalty = volatilityMetrics.spreadDropsToZero > 0 ? 0.1 : 0; // Reduced from 0.15
              const reversalPenalty = volatilityMetrics.spreadReversals > 10 ? 0.05 : 0; // Reduced from 0.1
              
              const totalRiskDiscount = Math.min(0.3, riskDiscount + zeroDropPenalty + reversalPenalty); // Cap at 30% (reduced from 50%)
              estimatedNetAPY = estimatedNetAPY * (1 - totalRiskDiscount);
            }
            
            totalWeightedReturn += allocation * estimatedNetAPY;
            totalAllocated += allocation;
          }
        }
      });

      const aggregateAPY = totalAllocated > 0 ? totalWeightedReturn / totalAllocated : 0;

      if (Math.abs(aggregateAPY - targetAggregateAPY) < 0.001) {
        // Found it!
        bestTotalPortfolio = actualTotalPortfolio;
        bestAllocations = testAllocations;
        bestAggregateAPY = aggregateAPY;
        break;
      } else if (aggregateAPY > targetAggregateAPY) {
        // Can go larger
        low = testTotalPortfolio;
        bestTotalPortfolio = actualTotalPortfolio;
        bestAllocations = testAllocations;
        bestAggregateAPY = aggregateAPY;
      } else {
        // Too large, reduce
        high = testTotalPortfolio;
      }

      if (high - low < 1000) {
        // Converged
        break;
      }
    }

    // Sanity check: If portfolio is suspiciously large, cap it and warn
    const MAX_REASONABLE_PORTFOLIO = 50_000_000; // $50M cap
    let finalPortfolio = bestTotalPortfolio;
    if (bestTotalPortfolio > MAX_REASONABLE_PORTFOLIO) {
      this.logger.warn(`⚠️ Portfolio size ${bestTotalPortfolio.toLocaleString()} exceeds reasonable limit (${MAX_REASONABLE_PORTFOLIO.toLocaleString()}). This may indicate data quality issues.`);
      finalPortfolio = MAX_REASONABLE_PORTFOLIO;
      // Scale down allocations proportionally
      const scaleFactor = MAX_REASONABLE_PORTFOLIO / bestTotalPortfolio;
      bestAllocations.forEach((amount, symbol) => {
        bestAllocations.set(symbol, amount * scaleFactor);
      });
    }
    
    return {
      allocations: bestAllocations,
      totalPortfolio: finalPortfolio,
      aggregateAPY: bestAggregateAPY,
      opportunityCount: Array.from(bestAllocations.values()).filter((v) => v > 0).length,
      dataQualityWarnings,
    };
  }

  /**
   * Predict how our position size will affect the funding rate calculation
   * Funding rates are typically calculated based on OI-weighted premium index
   * Our position affects OI, which can shift the funding rate
   * 
   * @param positionSizeUsd Our position size in USD
   * @param openInterest Current open interest in USD
   * @param currentFundingRate Current funding rate (as decimal, e.g., 0.0001 = 0.01%)
   * @returns Predicted change in funding rate (positive = rate increases, negative = rate decreases)
   */
  private predictFundingRateImpact(
    positionSizeUsd: number,
    openInterest: number,
    currentFundingRate: number,
  ): number {
    if (openInterest <= 0) {
      return 0; // Can't predict impact without OI data
    }
    
    // Validate funding rate is valid number
    if (currentFundingRate === undefined || currentFundingRate === null || isNaN(currentFundingRate)) {
      return 0; // Can't predict impact with invalid funding rate
    }
    
    // Calculate our position as a percentage of OI
    const positionRatio = positionSizeUsd / openInterest;
    
    // Funding rate impact is typically small unless position > 5% of OI
    // Model: impact scales with position ratio, but capped at reasonable levels
    // For long positions: increases funding rate (more longs = higher premium)
    // For short positions: decreases funding rate (more shorts = lower premium)
    
    // Impact factor: how much our position affects the rate
    // Small positions (< 1% of OI): minimal impact (~0.1% of current rate)
    // Medium positions (1-5% of OI): moderate impact (~1-5% of current rate)
    // Large positions (> 5% of OI): significant impact (~5-10% of current rate)
    const impactFactor = Math.min(
      Math.sqrt(positionRatio) * 0.1, // Square root model, capped at 10% impact
      0.1 // Maximum 10% impact on funding rate
    );
    
    // Apply impact: long positions increase funding rate, short positions decrease it
    // Since we're taking a long position, it increases the rate
    // The impact is proportional to current rate magnitude
    const impact = currentFundingRate * impactFactor;
    
    // Validate result is not NaN
    return isNaN(impact) ? 0 : impact;
  }

  /**
   * Get best bid and ask prices from an exchange adapter for limit order placement
   * Falls back to mark price if order book data is unavailable
   */
  private async getBestBidAsk(
    adapter: IPerpExchangeAdapter,
    exchangeSymbol: string,
    normalizedSymbol: string,
    exchangeType: ExchangeType,
  ): Promise<{ bestBid: number; bestAsk: number }> {
    try {
      // Try to get best bid/ask from adapter if it has a getBestBidAsk method (Hyperliquid)
      if ('getBestBidAsk' in adapter && typeof (adapter as any).getBestBidAsk === 'function') {
        return await (adapter as any).getBestBidAsk(exchangeSymbol);
      }

      // For Lighter: get order book details
      if (exchangeType === ExchangeType.LIGHTER) {
        try {
          const marketIndex = this.aggregator.getExchangeSymbol(normalizedSymbol, exchangeType);
          if (typeof marketIndex === 'number') {
            const orderApi = (adapter as any).orderApi;
            if (orderApi) {
              const response = await orderApi.getOrderBookDetails({ marketIndex } as any) as any;
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
          this.logger.debug(`Failed to get Lighter order book: ${error.message}`);
        }
      }

      // For Aster: try to get order book (may need to implement)
      // For now, fall back to mark price
      
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
      const estimatedSpread = markPrice * 0.001; // Assume 0.1% spread
      
      this.logger.warn(
        `Could not get order book for ${normalizedSymbol} on ${exchangeType}, using mark price estimate: ${error.message}`
      );
      
      return {
        bestBid: markPrice - estimatedSpread / 2,
        bestAsk: markPrice + estimatedSpread / 2,
      };
    }
  }

  /**
   * Create execution plan for an arbitrage opportunity (public method, fetches balances)
   * @param opportunity The arbitrage opportunity
   * @param adapters Map of exchange adapters
   * @param maxPositionSizeUsd Optional maximum position size
   * @param longMarkPrice Optional mark price for long exchange (from funding rate data)
   * @param shortMarkPrice Optional mark price for short exchange (from funding rate data)
   */
  async createExecutionPlan(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    maxPositionSizeUsd?: number,
    longMarkPrice?: number,
    shortMarkPrice?: number,
  ): Promise<ArbitrageExecutionPlan | null> {
    const longAdapter = adapters.get(opportunity.longExchange);
    const shortAdapter = adapters.get(opportunity.shortExchange);

    if (!longAdapter || !shortAdapter) {
      this.logger.warn(`Missing adapters for opportunity: ${opportunity.symbol}`);
      return null;
    }

    // Get available balances (with small delay to avoid rate limits)
    const [longBalance, shortBalance] = await Promise.all([
      longAdapter.getBalance(),
      shortAdapter.getBalance(),
    ]);

    return this.createExecutionPlanWithBalances(
      opportunity,
      adapters,
      maxPositionSizeUsd,
      longMarkPrice,
      shortMarkPrice,
      longBalance,
      shortBalance,
    );
  }

  /**
   * Execute arbitrage strategy
   */
  async executeStrategy(
    symbols: string[],
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    minSpread?: number,
    maxPositionSizeUsd?: number,
  ): Promise<ArbitrageExecutionResult> {
    const result: ArbitrageExecutionResult = {
      success: true,
      opportunitiesEvaluated: 0,
      opportunitiesExecuted: 0,
      totalExpectedReturn: 0,
      ordersPlaced: 0,
      errors: [],
      timestamp: new Date(),
    };

    try {
      // Find arbitrage opportunities
      const opportunities = await this.aggregator.findArbitrageOpportunities(
        symbols,
        minSpread || this.DEFAULT_MIN_SPREAD,
      );

      result.opportunitiesEvaluated = opportunities.length;

      this.logger.log(`Found ${opportunities.length} arbitrage opportunities`);

      if (opportunities.length === 0) {
        return result;
      }

      // Pre-fetch balances for all unique exchanges to reduce API calls
      // This batches balance calls instead of calling for each opportunity
      const uniqueExchanges = new Set<ExchangeType>();
      opportunities.forEach(opp => {
        uniqueExchanges.add(opp.longExchange);
        uniqueExchanges.add(opp.shortExchange);
      });

      // Fetch existing positions FIRST to account for already-deployed margin
      const existingPositions = await this.getAllPositions(adapters);
      
      // Calculate margin used per exchange from existing positions
      // Margin used = positionValue / leverage (since leverage multiplies position size)
      const marginUsedPerExchange = new Map<ExchangeType, number>();
      for (const position of existingPositions) {
        const positionValue = position.getPositionValue();
        // Margin used = position value / leverage (collateral backing the position)
        const marginUsed = position.marginUsed ?? (positionValue / this.leverage);
        const currentMargin = marginUsedPerExchange.get(position.exchangeType) ?? 0;
        marginUsedPerExchange.set(position.exchangeType, currentMargin + marginUsed);
      }

      const exchangeBalances = new Map<ExchangeType, number>();
      for (const exchange of uniqueExchanges) {
        const adapter = adapters.get(exchange);
        if (adapter) {
          try {
            const totalBalance = await adapter.getBalance();
            const marginUsed = marginUsedPerExchange.get(exchange) ?? 0;
            // Available balance = total balance - margin already used in existing positions
            const availableBalance = Math.max(0, totalBalance - marginUsed);
            exchangeBalances.set(exchange, availableBalance);
            
            if (marginUsed > 0) {
              this.logger.debug(
                `${exchange}: Total balance: $${totalBalance.toFixed(2)}, ` +
                `Margin used: $${marginUsed.toFixed(2)}, ` +
                `Available: $${availableBalance.toFixed(2)}`
              );
            }
            
            // Small delay between balance calls to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 50));
          } catch (error: any) {
            this.logger.warn(`Failed to get balance for ${exchange}: ${error.message}`);
            // Set to 0 so opportunities using this exchange will be skipped
            exchangeBalances.set(exchange, 0);
          }
        }
      }

      // Evaluate all opportunities and create execution plans
      // Process sequentially with delays to avoid rate limits
      // Mark prices are already included in the opportunity object from funding rate data
      // Then select the MOST PROFITABLE one (highest expected return)
      const executionPlans: Array<{ plan: ArbitrageExecutionPlan; opportunity: ArbitrageOpportunity }> = [];
      const allEvaluatedOpportunities: Array<{ 
        opportunity: ArbitrageOpportunity; 
        plan: ArbitrageExecutionPlan | null;
        netReturn: number;
        positionValueUsd: number;
        breakEvenHours: number | null;
        maxPortfolioFor35APY: number | null;
        longBidAsk: { bestBid: number; bestAsk: number } | null;
        shortBidAsk: { bestBid: number; bestAsk: number } | null;
      }> = [];

      for (let i = 0; i < opportunities.length; i++) {
        const opportunity = opportunities[i];

        try {
          // Use pre-fetched balances instead of calling getBalance() in createExecutionPlan
          const plan = await this.createExecutionPlanWithBalances(
            opportunity,
            adapters,
            maxPositionSizeUsd,
            opportunity.longMarkPrice,
            opportunity.shortMarkPrice,
            exchangeBalances.get(opportunity.longExchange) ?? 0,
            exchangeBalances.get(opportunity.shortExchange) ?? 0,
          );

          // Calculate metrics for logging (even if plan is null/unprofitable)
          let positionValueUsd = 0;
          let netReturn = -Infinity;
          let breakEvenHours: number | null = null;
          let maxPortfolioFor35APY: number | null = null;
          
          // Fetch bid/ask data for max portfolio calculation (needed for all opportunities)
          const longExchangeSymbol = this.aggregator.getExchangeSymbol(opportunity.symbol, opportunity.longExchange);
          const shortExchangeSymbol = this.aggregator.getExchangeSymbol(opportunity.symbol, opportunity.shortExchange);
          const longSymbol = typeof longExchangeSymbol === 'string' ? longExchangeSymbol : opportunity.symbol;
          const shortSymbol = typeof shortExchangeSymbol === 'string' ? shortExchangeSymbol : opportunity.symbol;
          const longBidAsk = await this.getBestBidAsk(
            adapters.get(opportunity.longExchange)!,
            longSymbol,
            opportunity.symbol,
            opportunity.longExchange,
          );
          const shortBidAsk = await this.getBestBidAsk(
            adapters.get(opportunity.shortExchange)!,
            shortSymbol,
            opportunity.symbol,
            opportunity.shortExchange,
          );
          
          // Calculate max portfolio for 35% APY (uses historical weighted averages)
          maxPortfolioFor35APY = this.calculateMaxPortfolioForTargetAPY(
            opportunity,
            longBidAsk,
            shortBidAsk,
            0.35,
          );
          
          // Log result with historical context
          if (maxPortfolioFor35APY !== null) {
            const longDataPoints = this.historicalService.getHistoricalData(opportunity.symbol, opportunity.longExchange).length;
            const shortDataPoints = this.historicalService.getHistoricalData(opportunity.symbol, opportunity.shortExchange).length;
            const hasHistoricalData = longDataPoints > 0 || shortDataPoints > 0;
            this.logger.debug(
              `✅ Max Portfolio (${opportunity.symbol}): $${(maxPortfolioFor35APY / 1000).toFixed(1)}k ` +
              `(${hasHistoricalData ? 'historical' : 'current'} rates)`
            );
          }
          
          if (plan) {
            const avgMarkPrice = opportunity.longMarkPrice && opportunity.shortMarkPrice
              ? (opportunity.longMarkPrice + opportunity.shortMarkPrice) / 2
              : opportunity.longMarkPrice || opportunity.shortMarkPrice || 0;
            positionValueUsd = plan.positionSize * avgMarkPrice;
            netReturn = plan.expectedNetReturn;
          } else {
            // Calculate metrics even for unprofitable opportunities
            const longBalance = exchangeBalances.get(opportunity.longExchange) ?? 0;
            const shortBalance = exchangeBalances.get(opportunity.shortExchange) ?? 0;
            const minBalance = Math.min(longBalance, shortBalance);
            const availableCapital = minBalance * this.BALANCE_USAGE_PERCENT;
            const leveragedCapital = availableCapital * this.leverage;
            const maxSize = maxPositionSizeUsd || Infinity;
            const positionSizeUsd = Math.min(leveragedCapital, maxSize);
            
            if (positionSizeUsd >= this.MIN_POSITION_SIZE_USD) {
              const avgMarkPrice = opportunity.longMarkPrice && opportunity.shortMarkPrice
                ? (opportunity.longMarkPrice + opportunity.shortMarkPrice) / 2
                : opportunity.longMarkPrice || opportunity.shortMarkPrice || 0;
              
              if (avgMarkPrice > 0) {
                positionValueUsd = positionSizeUsd;
                
                // Calculate costs and returns
                const longFeeRate = this.EXCHANGE_FEE_RATES.get(opportunity.longExchange) || 0.0005;
                const shortFeeRate = this.EXCHANGE_FEE_RATES.get(opportunity.shortExchange) || 0.0005;
                const longEntryFee = positionSizeUsd * longFeeRate;
                const shortEntryFee = positionSizeUsd * shortFeeRate;
                const totalEntryFees = longEntryFee + shortEntryFee;
                const totalExitFees = totalEntryFees;
                
                // Estimate slippage cost for the ACTUAL position size we'll trade
                // Use actual slippage calculation method, but with conservative parameters
                // This ensures break-even accounts for slippage at the actual scale we'll trade
                // Note: longBidAsk and shortBidAsk are already fetched above for max portfolio calculation
                const slippagePositionSize = positionSizeUsd; // Use actual position size based on available capital and liquidity
                const longSlippage = this.calculateSlippageCost(
                  slippagePositionSize,
                  longBidAsk.bestBid,
                  longBidAsk.bestAsk,
                  opportunity.longOpenInterest || 0,
                  OrderType.LIMIT,
                );
                const shortSlippage = this.calculateSlippageCost(
                  slippagePositionSize,
                  shortBidAsk.bestBid,
                  shortBidAsk.bestAsk,
                  opportunity.shortOpenInterest || 0,
                  OrderType.LIMIT,
                );
                const estimatedSlippageCost = longSlippage + shortSlippage;
                
                // Only check entry fees + slippage for initial profitability (exit fees paid later)
                const totalOneTimeCosts = totalEntryFees + estimatedSlippageCost;
                
                const periodsPerDay = 24;
                const periodsPerYear = periodsPerDay * 365;
                // Note: opportunity.expectedReturn is already annualized (APY as decimal, e.g., 0.3625 = 36.25% APY)
                // We convert to hourly dollar return: (APY / periodsPerYear) * positionSize
                const expectedReturnPerPeriod = (opportunity.expectedReturn / periodsPerYear) * positionSizeUsd;
                
                // Calculate break-even hours: how many hours to cover all costs (entry + exit + slippage)
                const totalCostsWithExit = totalEntryFees + totalExitFees + estimatedSlippageCost;
                if (expectedReturnPerPeriod > 0) {
                  breakEvenHours = totalCostsWithExit / expectedReturnPerPeriod;
                  
                  // Net return per period: hourly return minus amortized costs
                  // Amortize one-time costs over break-even period (capped at 24h) to show true hourly profitability
                  // This way, opportunities that break even quickly show positive net return
                  const amortizationPeriods = Math.max(1, Math.min(24, Math.ceil(breakEvenHours))); // Amortize over break-even time, capped at 24h
                  const amortizedCostsPerPeriod = totalCostsWithExit / amortizationPeriods;
                  netReturn = expectedReturnPerPeriod - amortizedCostsPerPeriod;
                } else {
                  // No expected return, so net return is negative (costs only)
                  netReturn = -totalOneTimeCosts;
                }
              }
            }
          }
          
          // Track ALL opportunities (even unprofitable ones) for logging
          allEvaluatedOpportunities.push({
            opportunity,
            plan,
            netReturn,
            positionValueUsd,
            breakEvenHours,
            maxPortfolioFor35APY,
            longBidAsk,
            shortBidAsk,
          });

          if (plan) {
            executionPlans.push({ plan, opportunity });
          }
        } catch (error: any) {
          result.errors.push(`Error evaluating ${opportunity.symbol}: ${error.message}`);
          this.logger.debug(`Failed to evaluate opportunity ${opportunity.symbol}: ${error.message}`);
        }

        // Add delay between opportunity evaluations to avoid rate limits (except for last one)
        if (i < opportunities.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 50)); // Reduced delay since balances are cached
        }
      }

      // Calculate optimal portfolio allocation across all opportunities
      const portfolioOptimizationData = allEvaluatedOpportunities
        .filter((item) => item.maxPortfolioFor35APY !== null && item.longBidAsk !== null && item.shortBidAsk !== null)
        .map((item) => ({
          opportunity: item.opportunity,
          maxPortfolioFor35APY: item.maxPortfolioFor35APY!,
          longBidAsk: item.longBidAsk!,
          shortBidAsk: item.shortBidAsk!,
        }));

      // Calculate total available capital
      const totalCapital = Array.from(exchangeBalances.values()).reduce((sum, balance) => sum + balance, 0);

      const optimalPortfolio = this.calculateOptimalPortfolioAllocation(
        portfolioOptimizationData,
        totalCapital > 0 ? totalCapital : null,
        0.35,
      );

      // Sort ALL evaluated opportunities by net return (highest first) for logging
      allEvaluatedOpportunities.sort((a, b) => b.netReturn - a.netReturn);
      
      // Filter out opportunities with N/A open interest (undefined, null, or 0)
      const opportunitiesWithValidOI = allEvaluatedOpportunities.filter((item) => {
        const longOI = item.opportunity.longOpenInterest;
        const shortOI = item.opportunity.shortOpenInterest;
        return (longOI !== undefined && longOI !== null && longOI > 0) &&
               (shortOI !== undefined && shortOI !== null && shortOI > 0);
      });
      
      // Log all available opportunities with their APY (including unprofitable ones)
      // This helps user see alternatives if current opportunity drops in funding
      // Exclude opportunities with N/A OI
      this.logger.log('\n📊 All Arbitrage Opportunities (sorted by net return, excluding N/A OI):');
      opportunitiesWithValidOI.forEach((item, index) => {
        // An opportunity is profitable if it has a plan (executable) OR has positive net return
        // (some may have positive returns but were rejected for liquidity/other reasons)
        const isProfitable = item.plan !== null;
        const hasPositiveReturn = item.netReturn > 0 && item.netReturn !== -Infinity;
        // Consider opportunities with break-even < 24 hours as potentially profitable
        const hasQuickBreakEven = item.breakEvenHours !== null && item.breakEvenHours !== undefined && item.breakEvenHours < 24;
        const isBest = index === 0 && isProfitable;
        const prefix = isBest ? '🥇' : isProfitable ? `  ${index + 1}.` : hasPositiveReturn ? '  ⚠️' : hasQuickBreakEven ? '  ⚠️' : '  ❌';
        const profitability = isProfitable ? '✅' : hasPositiveReturn ? '⚠️ (rejected)' : hasQuickBreakEven ? '⚠️ (quick break-even)' : '❌';
        
        // Format break-even info for opportunities that aren't immediately profitable
        let breakEvenInfo = '';
        if (item.breakEvenHours !== null && item.breakEvenHours !== undefined) {
          const hours = Math.ceil(item.breakEvenHours);
          const days = (hours / 24).toFixed(1);
          breakEvenInfo = ` | Break-even: ${hours}h (${days}d) at current funding`;
        }
        
        // Format liquidity info
        const longOI = item.opportunity.longOpenInterest ?? 0;
        const shortOI = item.opportunity.shortOpenInterest ?? 0;
        const hasValidOI = (item.opportunity.longOpenInterest !== undefined && item.opportunity.longOpenInterest !== null && item.opportunity.longOpenInterest > 0) &&
                           (item.opportunity.shortOpenInterest !== undefined && item.opportunity.shortOpenInterest !== null && item.opportunity.shortOpenInterest > 0);
        const minOI = hasValidOI ? Math.min(longOI, shortOI) : 0;
        const liquidityInfo = hasValidOI && minOI > 0
          ? ` | OI: $${(minOI / 1000).toFixed(1)}k`
          : ' | OI: N/A';
        
        const maxPortfolioInfo = item.maxPortfolioFor35APY !== null && item.maxPortfolioFor35APY !== undefined
          ? ` | Max Portfolio (35% APY): $${(item.maxPortfolioFor35APY / 1000).toFixed(1)}k`
          : ' | Max Portfolio (35% APY): N/A';
        
        this.logger.log(
          `${prefix} ${item.opportunity.symbol}: ` +
          `APY: ${(item.opportunity.expectedReturn * 100).toFixed(2)}% | ` +
          `Spread: ${(item.opportunity.spread * 100).toFixed(4)}% | ` +
          `Net Return: ${item.netReturn !== -Infinity ? '$' + item.netReturn.toFixed(4) : 'N/A'}/period ${profitability}${breakEvenInfo}${liquidityInfo}${maxPortfolioInfo} | ` +
          `Position: ${item.positionValueUsd > 0 ? '$' + item.positionValueUsd.toFixed(2) : 'N/A'} | ` +
          `${item.opportunity.longExchange} LONG @ ${(item.opportunity.longRate * 100).toFixed(4)}% / ` +
          `${item.opportunity.shortExchange} SHORT @ ${(item.opportunity.shortRate * 100).toFixed(4)}%`
        );
      });
      this.logger.log('');

      // Log optimal portfolio allocation results
      if (optimalPortfolio.opportunityCount > 0) {
        this.logger.log('\n📊 Optimal Portfolio Allocation (Aggregate 35% APY):');
        if (optimalPortfolio.dataQualityWarnings.length > 0) {
          this.logger.debug(`   📊 Data Quality: ${optimalPortfolio.dataQualityWarnings.length} opportunities excluded due to invalid spreads (data quality requirements relaxed)`);
        }
        this.logger.log(`   Total Portfolio: $${optimalPortfolio.totalPortfolio.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
        this.logger.log(`   Aggregate APY: ${(optimalPortfolio.aggregateAPY * 100).toFixed(2)}%`);
        this.logger.log(`   Opportunities Used: ${optimalPortfolio.opportunityCount}`);
        this.logger.log(`   Allocations:`);
        optimalPortfolio.allocations.forEach((amount, symbol) => {
          if (amount > 0) {
            // Find the opportunity to get data quality risk factor
            const opportunity = allEvaluatedOpportunities.find(
              (item) => item.opportunity.symbol === symbol
            );
            const dataQualityRiskFactor = opportunity
              ? this.calculateDataQualityRiskFactor(opportunity.opportunity)
              : 1.0;
            
            // Get data point counts for context
            const longData = opportunity
              ? this.historicalService.getHistoricalData(
                  opportunity.opportunity.symbol,
                  opportunity.opportunity.longExchange,
                )
              : [];
            const shortData = opportunity
              ? this.historicalService.getHistoricalData(
                  opportunity.opportunity.symbol,
                  opportunity.opportunity.shortExchange,
                )
              : [];
            
            const riskInfo = dataQualityRiskFactor < 1.0
              ? ` (Data Quality Risk: ${(dataQualityRiskFactor * 100).toFixed(0)}% - ${longData.length}/${shortData.length}pts)`
              : ` (Data Quality: Good - ${longData.length}/${shortData.length}pts)`;
            
            this.logger.log(
              `     ${symbol}: $${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${riskInfo}`
            );
          }
        });
        this.logger.log('');

        // Calculate comprehensive risk metrics
        try {
          const riskMetrics = await this.portfolioRiskAnalyzer.calculatePortfolioRiskMetrics({
            allocations: optimalPortfolio.allocations,
            opportunities: allEvaluatedOpportunities
              .filter((item) => optimalPortfolio.allocations.has(item.opportunity.symbol))
              .map((item) => ({
                opportunity: item.opportunity,
                maxPortfolioFor35APY: item.maxPortfolioFor35APY,
                volatilityMetrics: this.historicalService.getSpreadVolatilityMetrics(
                  item.opportunity.symbol,
                  item.opportunity.longExchange,
                  item.opportunity.symbol,
                  item.opportunity.shortExchange,
                  30,
                ),
              })),
            aggregateAPY: optimalPortfolio.aggregateAPY,
            totalPortfolio: optimalPortfolio.totalPortfolio,
          });

          // Log comprehensive investor report
          this.logInvestorReport(riskMetrics, optimalPortfolio);
        } catch (error: any) {
          this.logger.error(`Failed to calculate portfolio risk metrics: ${error.message}`);
          this.logger.debug(`Risk analysis error: ${error.stack || error}`);
        }
      } else {
        this.logger.log('\n📊 Optimal Portfolio Allocation: No opportunities available for 35% APY portfolio');
        
        // Show what-if scenario: what if we relaxed data quality requirements?
        const opportunitiesWithMaxPortfolio = portfolioOptimizationData.filter(
          (item) => item.maxPortfolioFor35APY !== null && item.maxPortfolioFor35APY !== undefined && item.maxPortfolioFor35APY > 0
        );
        
        if (opportunitiesWithMaxPortfolio.length > 0) {
          const totalMaxPortfolio = opportunitiesWithMaxPortfolio.reduce(
            (sum, item) => sum + (item.maxPortfolioFor35APY || 0),
            0
          );
          
          this.logger.log(`\n   📊 What-If Analysis (${opportunitiesWithMaxPortfolio.length} opportunities with maxPortfolioFor35APY calculated):`);
          this.logger.log(`      Total Max Portfolio (if data quality relaxed): $${totalMaxPortfolio.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
          this.logger.log(`      Top 5 Opportunities by Max Portfolio:`);
          
          const sortedByMaxPortfolio = [...opportunitiesWithMaxPortfolio].sort(
            (a, b) => (b.maxPortfolioFor35APY || 0) - (a.maxPortfolioFor35APY || 0)
          );
          
          sortedByMaxPortfolio.slice(0, 5).forEach((item) => {
            const longData = this.historicalService.getHistoricalData(
              item.opportunity.symbol,
              item.opportunity.longExchange,
            );
            const shortData = this.historicalService.getHistoricalData(
              item.opportunity.symbol,
              item.opportunity.shortExchange,
            );
            const longPts = longData.length;
            const shortPts = shortData.length;
            const minRequired = Math.max(
              item.opportunity.longExchange === ExchangeType.ASTER ? 21 : 168,
              item.opportunity.shortExchange === ExchangeType.ASTER ? 21 : 168,
            );
            
            this.logger.log(
              `        ${item.opportunity.symbol}: $${(item.maxPortfolioFor35APY || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ` +
              `(Long: ${longPts}pts, Short: ${shortPts}pts, need ${minRequired}+)`
            );
          });
        }
        
        this.logger.log('');
      }

      if (executionPlans.length === 0) {
        this.logger.warn('No profitable execution plans created from opportunities');
        
        // Try worst-case scenario selection if no profitable opportunities exist
        // Only consider opportunities with valid OI data (exclude N/A OI)
        const worstCaseResult = await this.selectWorstCaseOpportunity(
          opportunitiesWithValidOI,
          adapters,
          maxPositionSizeUsd,
          exchangeBalances,
        );
        
        if (worstCaseResult) {
          // Execute worst-case opportunity
          return await this.executeWorstCaseOpportunity(worstCaseResult, adapters, result);
        }
        
        return result;
      }

      // Sort profitable plans by expected net return (highest first) and select the BEST one
      executionPlans.sort((a, b) => b.plan.expectedNetReturn - a.plan.expectedNetReturn);
      const bestOpportunity = executionPlans[0];

      this.logger.log(
        `🎯 Selected BEST opportunity: ${bestOpportunity.opportunity.symbol} ` +
        `(Expected net return: $${bestOpportunity.plan.expectedNetReturn.toFixed(4)} per period, ` +
        `APY: ${(bestOpportunity.opportunity.expectedReturn * 100).toFixed(2)}%, ` +
        `Spread: ${(bestOpportunity.opportunity.spread * 100).toFixed(4)}%)`
      );

      // STEP 1: Check if we should rebalance (prevent rebalancing trap)
      this.logger.log('🔍 Checking for existing positions and rebalancing decision...');
      const allPositions = await this.getAllPositions(adapters);
      const cumulativeLoss = this.lossTracker.getCumulativeLoss();
      
      if (allPositions.length > 0) {
        // Check if we should rebalance to the new opportunity
        const rebalanceDecision = await this.shouldRebalance(
          allPositions[0], // Current position (assuming single position strategy)
          bestOpportunity.opportunity,
          bestOpportunity.plan,
          cumulativeLoss,
          adapters,
        );
        
        if (!rebalanceDecision.shouldRebalance) {
          this.logger.log(
            `⏸️  Skipping rebalance: ${rebalanceDecision.reason}. ` +
            `Current break-even: ${rebalanceDecision.currentBreakEvenHours?.toFixed(2) ?? 'N/A'}h, ` +
            `New break-even: ${rebalanceDecision.newBreakEvenHours?.toFixed(2) ?? 'N/A'}h`
          );
          return result;
        }
        
        this.logger.log(
          `✅ Rebalancing approved: ${rebalanceDecision.reason}. ` +
          `Current break-even: ${rebalanceDecision.currentBreakEvenHours?.toFixed(2) ?? 'N/A'}h, ` +
          `New break-even: ${rebalanceDecision.newBreakEvenHours?.toFixed(2) ?? 'N/A'}h`
        );
        
        this.logger.log(`Found ${allPositions.length} existing position(s) - closing before opening new opportunity...`);
        
        for (const position of allPositions) {
          try {
            const adapter = adapters.get(position.exchangeType);
            if (!adapter) {
              this.logger.warn(`No adapter found for ${position.exchangeType}, cannot close position`);
              continue;
            }

            // Close position by placing opposite order
            const closeOrder = new PerpOrderRequest(
              position.symbol,
              position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG,
              OrderType.MARKET,
              position.size,
            );

            this.logger.log(
              `📤 Closing position: ${position.symbol} ${position.side} ${position.size.toFixed(4)} on ${position.exchangeType}`
            );

            const closeResponse = await adapter.placeOrder(closeOrder);
            
            if (closeResponse.isSuccess()) {
              // Record position exit in loss tracker
              const exitFeeRate = this.EXCHANGE_FEE_RATES.get(position.exchangeType) || 0.0005;
              const positionValueUsd = position.size * (position.markPrice || 0);
              const exitCost = exitFeeRate * positionValueUsd;
              
              // Calculate realized loss (simplified - assumes break-even if no P&L data)
              const realizedLoss = -exitCost; // Exit cost is a loss
              
              this.lossTracker.recordPositionExit(
                position.symbol,
                position.exchangeType,
                exitCost,
                realizedLoss,
              );
              
              this.logger.log(`✅ Successfully closed position: ${position.symbol} on ${position.exchangeType}`);
            } else {
              this.logger.warn(
                `⚠️ Failed to close position ${position.symbol} on ${position.exchangeType}: ${closeResponse.error || 'unknown error'}`
              );
              result.errors.push(`Failed to close position ${position.symbol} on ${position.exchangeType}`);
            }

            // Small delay between closes to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 200));
          } catch (error: any) {
            this.logger.error(`Error closing position ${position.symbol} on ${position.exchangeType}: ${error.message}`);
            result.errors.push(`Error closing position ${position.symbol}: ${error.message}`);
          }
        }

        // Wait a bit after closing positions before opening new ones
        this.logger.log('⏳ Waiting 1 second after closing positions before opening new opportunity...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        this.logger.log('✅ No existing positions to close');
      }

      // Execute only the most profitable opportunity
      try {
        const { plan, opportunity } = bestOpportunity;
        
        // Get adapters
        const [longAdapter, shortAdapter] = [
          adapters.get(opportunity.longExchange),
          adapters.get(opportunity.shortExchange),
        ];

        if (!longAdapter || !shortAdapter) {
          result.errors.push(`Missing adapters for ${opportunity.symbol}`);
          this.logger.error(
            `Missing adapters: Long=${opportunity.longExchange} (${longAdapter ? 'OK' : 'MISSING'}), ` +
            `Short=${opportunity.shortExchange} (${shortAdapter ? 'OK' : 'MISSING'})`
          );
          return result;
        }

        // Place orders (in parallel for speed)
        this.logger.log(
          `📤 Executing orders for ${opportunity.symbol}: ` +
          `LONG ${plan.positionSize.toFixed(4)} on ${opportunity.longExchange}, ` +
          `SHORT ${plan.positionSize.toFixed(4)} on ${opportunity.shortExchange}`
        );

        const [longResponse, shortResponse] = await Promise.all([
          longAdapter.placeOrder(plan.longOrder),
          shortAdapter.placeOrder(plan.shortOrder),
        ]);

        // Track volume for filled orders
        if (this.performanceLogger) {
          if (longResponse.isFilled() && longResponse.filledSize && longResponse.averageFillPrice) {
            const longVolume = longResponse.filledSize * longResponse.averageFillPrice;
            this.performanceLogger.recordTradeVolume(longVolume);
          }
          if (shortResponse.isFilled() && shortResponse.filledSize && shortResponse.averageFillPrice) {
            const shortVolume = shortResponse.filledSize * shortResponse.averageFillPrice;
            this.performanceLogger.recordTradeVolume(shortVolume);
          }
        }

        if (longResponse.isSuccess() && shortResponse.isSuccess()) {
          // Record position entries in loss tracker
          const longFeeRate = this.EXCHANGE_FEE_RATES.get(opportunity.longExchange) || 0.0005;
          const shortFeeRate = this.EXCHANGE_FEE_RATES.get(opportunity.shortExchange) || 0.0005;
          const avgMarkPrice = opportunity.longMarkPrice && opportunity.shortMarkPrice
            ? (opportunity.longMarkPrice + opportunity.shortMarkPrice) / 2
            : opportunity.longMarkPrice || opportunity.shortMarkPrice || 0;
          const positionSizeUsd = plan.positionSize * avgMarkPrice;
          const longEntryCost = longFeeRate * positionSizeUsd;
          const shortEntryCost = shortFeeRate * positionSizeUsd;
          
          this.lossTracker.recordPositionEntry(
            opportunity.symbol,
            opportunity.longExchange,
            longEntryCost,
            positionSizeUsd,
          );
          this.lossTracker.recordPositionEntry(
            opportunity.symbol,
            opportunity.shortExchange,
            shortEntryCost,
            positionSizeUsd,
          );
          
          result.opportunitiesExecuted = 1; // Only executed the best one
          result.ordersPlaced = 2;
          result.totalExpectedReturn = plan.expectedNetReturn;

          this.logger.log(
            `✅ Successfully executed arbitrage for ${opportunity.symbol}: ` +
            `LONG on ${opportunity.longExchange}, SHORT on ${opportunity.shortExchange} ` +
            `Expected return: $${plan.expectedNetReturn.toFixed(4)} per period ` +
            `(APY: ${(opportunity.expectedReturn * 100).toFixed(2)}%)`
          );
        } else {
          result.errors.push(
            `Order execution failed for ${opportunity.symbol}: ` +
            `Long: ${longResponse.error || 'unknown'}, Short: ${shortResponse.error || 'unknown'}`
          );
          this.logger.error(
            `❌ Order execution failed for ${opportunity.symbol}: ` +
            `Long success: ${longResponse.isSuccess()}, Short success: ${shortResponse.isSuccess()}`
          );
        }
      } catch (error: any) {
        result.errors.push(`Error executing best opportunity: ${error.message}`);
        this.logger.error(`Failed to execute best opportunity: ${error.message}`);
      }

      // Strategy is successful if it completes execution, even with some errors
      // Only mark as failed if there's a fatal error in the outer catch block
      result.success = true;
    } catch (error: any) {
      result.success = false;
      result.errors.push(`Strategy execution failed: ${error.message}`);
      this.logger.error(`Strategy execution error: ${error.message}`);
    }

    return result;
  }

  /**
   * Get all positions across all exchanges
   */
  private async getAllPositions(adapters: Map<ExchangeType, IPerpExchangeAdapter>): Promise<PerpPosition[]> {
    const allPositions: PerpPosition[] = [];

    for (const [exchangeType, adapter] of adapters) {
      try {
        const positions = await adapter.getPositions();
        allPositions.push(...positions);
      } catch (error: any) {
        this.logger.warn(`Failed to get positions from ${exchangeType}: ${error.message}`);
      }
    }

    return allPositions;
  }

  /**
   * Calculate next funding rate payment time
   * Most perpetual exchanges pay funding every hour at :00 minutes (e.g., 1:00, 2:00, 3:00)
   * Some pay every 8 hours at 00:00, 08:00, 16:00 UTC
   * This function returns the next payment time assuming hourly payments at :00
   */
  static getNextFundingPaymentTime(): Date {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 0, 0); // Next hour at :00:00
    return nextHour;
  }

  /**
   * Get milliseconds until next funding payment
   */
  static getMsUntilNextFundingPayment(): number {
    const nextPayment = this.getNextFundingPaymentTime();
    return nextPayment.getTime() - Date.now();
  }

  /**
   * Evaluate opportunity with historical metrics
   */
  private evaluateOpportunityWithHistory(
    opportunity: ArbitrageOpportunity,
    plan: ArbitrageExecutionPlan | null,
  ): {
    breakEvenHours: number | null;
    historicalMetrics: {
      long: HistoricalMetrics | null;
      short: HistoricalMetrics | null;
    };
    worstCaseBreakEvenHours: number | null;
    consistencyScore: number;
  } {
    const longMetrics = this.historicalService.getHistoricalMetrics(
      opportunity.symbol,
      opportunity.longExchange,
    );
    const shortMetrics = this.historicalService.getHistoricalMetrics(
      opportunity.symbol,
      opportunity.shortExchange,
    );

    // Calculate consistency score (average of both exchanges)
    const consistencyScore = longMetrics && shortMetrics
      ? (longMetrics.consistencyScore + shortMetrics.consistencyScore) / 2
      : longMetrics?.consistencyScore || shortMetrics?.consistencyScore || 0;

    // Calculate worst-case break-even using minimum historical rates
    let worstCaseBreakEvenHours: number | null = null;
    if (plan && longMetrics && shortMetrics) {
      const periodsPerYear = 24 * 365;
      const worstCaseLongRate = longMetrics.minRate;
      const worstCaseShortRate = shortMetrics.minRate;
      const worstCaseSpread = Math.abs(worstCaseShortRate - worstCaseLongRate);
      const worstCaseAPY = worstCaseSpread * periodsPerYear;
      
      const avgMarkPrice = opportunity.longMarkPrice && opportunity.shortMarkPrice
        ? (opportunity.longMarkPrice + opportunity.shortMarkPrice) / 2
        : opportunity.longMarkPrice || opportunity.shortMarkPrice || 0;
      const positionSizeUsd = plan.positionSize * avgMarkPrice;
      const worstCaseHourlyReturn = (worstCaseAPY / periodsPerYear) * positionSizeUsd;
      
      if (worstCaseHourlyReturn > 0) {
        const totalCosts = plan.estimatedCosts.total;
        worstCaseBreakEvenHours = totalCosts / worstCaseHourlyReturn;
      }
    }

    return {
      breakEvenHours: plan ? null : (opportunity as any).breakEvenHours || null,
      historicalMetrics: {
        long: longMetrics,
        short: shortMetrics,
      },
      worstCaseBreakEvenHours,
      consistencyScore,
    };
  }

  /**
   * Determine if we should rebalance from current position to new opportunity
   */
  private async shouldRebalance(
    currentPosition: PerpPosition,
    newOpportunity: ArbitrageOpportunity,
    newPlan: ArbitrageExecutionPlan,
    cumulativeLoss: number,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<{
    shouldRebalance: boolean;
    reason: string;
    currentBreakEvenHours: number | null;
    newBreakEvenHours: number | null;
  }> {
    // Get current position's funding rate
    let currentFundingRate = 0;
    try {
      const rates = await this.aggregator.getFundingRates(currentPosition.symbol);
      const currentRate = rates.find(r => r.exchange === currentPosition.exchangeType);
      if (currentRate) {
        currentFundingRate = currentPosition.side === 'LONG' 
          ? currentRate.currentRate 
          : -currentRate.currentRate; // Flip for SHORT
      }
    } catch (error: any) {
      this.logger.debug(`Failed to get funding rate for current position: ${error.message}`);
    }

    // Calculate current position's remaining break-even hours
    const avgMarkPrice = currentPosition.markPrice || 0;
    const positionValueUsd = currentPosition.size * avgMarkPrice;
    const currentBreakEvenHours = this.lossTracker.getRemainingBreakEvenHours(
      currentPosition,
      currentFundingRate,
      positionValueUsd,
    );

    // Calculate new position's break-even hours (including cumulative losses)
    const periodsPerYear = 24 * 365;
    const hourlyReturn = (newOpportunity.expectedReturn / periodsPerYear) * (newPlan.positionSize * avgMarkPrice);
    const newBreakEvenHours = this.lossTracker.getAdjustedBreakEvenHours(
      {
        hourlyReturn,
        entryCosts: newPlan.estimatedCosts.fees / 2, // Entry is half of total costs
        exitCosts: newPlan.estimatedCosts.fees / 2, // Exit is half of total costs
      },
      cumulativeLoss,
    );

    // Decision logic
    if (newPlan.expectedNetReturn > 0) {
      return {
        shouldRebalance: true,
        reason: 'New opportunity is instantly profitable',
        currentBreakEvenHours,
        newBreakEvenHours: null, // Not applicable for profitable positions
      };
    }

    if (currentBreakEvenHours === null || currentBreakEvenHours === Infinity) {
      // Current position never breaks even, always rebalance if new one is better
      if (newBreakEvenHours < Infinity) {
        return {
          shouldRebalance: true,
          reason: 'Current position never breaks even, new position has finite break-even time',
          currentBreakEvenHours,
          newBreakEvenHours,
        };
      }
      return {
        shouldRebalance: false,
        reason: 'Both positions never break even',
        currentBreakEvenHours,
        newBreakEvenHours,
      };
    }

    if (newBreakEvenHours < currentBreakEvenHours) {
      const hoursSaved = currentBreakEvenHours - newBreakEvenHours;
      return {
        shouldRebalance: true,
        reason: `New position breaks even ${hoursSaved.toFixed(2)}h faster`,
        currentBreakEvenHours,
        newBreakEvenHours,
      };
    }

    return {
      shouldRebalance: false,
      reason: `Current position breaks even faster (${currentBreakEvenHours.toFixed(2)}h vs ${newBreakEvenHours.toFixed(2)}h)`,
      currentBreakEvenHours,
      newBreakEvenHours,
    };
  }

  /**
   * Select worst-case scenario opportunity when no profitable opportunities exist
   */
  private async selectWorstCaseOpportunity(
    allOpportunities: Array<{
      opportunity: ArbitrageOpportunity;
      plan: ArbitrageExecutionPlan | null;
      netReturn: number;
      positionValueUsd: number;
      breakEvenHours: number | null;
    }>,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    maxPositionSizeUsd: number | undefined,
    exchangeBalances: Map<ExchangeType, number>,
  ): Promise<{
    opportunity: ArbitrageOpportunity;
    plan: ArbitrageExecutionPlan;
    reason: string;
  } | null> {
    if (allOpportunities.length === 0) {
      return null;
    }

    // Evaluate all opportunities with historical metrics
    const evaluated: Array<{
      opportunity: ArbitrageOpportunity;
      plan: ArbitrageExecutionPlan | null;
      historical: ReturnType<typeof this.evaluateOpportunityWithHistory>;
      score: number;
    }> = [];

    for (const item of allOpportunities) {
      if (!item.plan) continue; // Skip if no plan

      const historical = this.evaluateOpportunityWithHistory(item.opportunity, item.plan);
      
      // Calculate score: (consistencyScore * avgHistoricalRate * liquidity) / worstCaseBreakEvenHours
      // Higher score = better worst-case opportunity
      const longMetrics = historical.historicalMetrics.long;
      const shortMetrics = historical.historicalMetrics.short;
      const avgHistoricalRate = longMetrics && shortMetrics
        ? (longMetrics.averageRate + shortMetrics.averageRate) / 2
        : 0;
      
      // Use open interest as liquidity proxy
      const longOI = item.opportunity.longOpenInterest || 0;
      const shortOI = item.opportunity.shortOpenInterest || 0;
      const minOI = Math.min(longOI, shortOI);
      // Normalize liquidity score: 0-1 scale based on OI (higher OI = better liquidity)
      // Use log scale to avoid extreme values: log10(OI/1000) / 10, clamped to [0, 1]
      const liquidity = minOI > 0 
        ? Math.min(1, Math.max(0, Math.log10(Math.max(minOI / 1000, 1)) / 10))
        : 0.1; // Default low liquidity score if OI unavailable
      
      const worstCaseBreakEven = historical.worstCaseBreakEvenHours || Infinity;
      const score = worstCaseBreakEven < Infinity && worstCaseBreakEven > 0
        ? (historical.consistencyScore * Math.abs(avgHistoricalRate) * liquidity) / worstCaseBreakEven
        : 0;

      evaluated.push({
        opportunity: item.opportunity,
        plan: item.plan,
        historical,
        score,
      });
    }

    if (evaluated.length === 0) {
      return null;
    }

    // Sort by score (highest first)
    evaluated.sort((a, b) => b.score - a.score);
    const best = evaluated[0];

    // Only select if worst-case break-even is reasonable
    const worstCaseBreakEvenDays = best.historical.worstCaseBreakEvenHours
      ? best.historical.worstCaseBreakEvenHours / 24
      : Infinity;

    if (worstCaseBreakEvenDays > this.MAX_WORST_CASE_BREAK_EVEN_DAYS) {
      this.logger.warn(
        `Worst-case opportunity has break-even > ${this.MAX_WORST_CASE_BREAK_EVEN_DAYS} days, skipping`
      );
      return null;
    }

    const reason = `Worst-case scenario selection: ` +
      `Consistency: ${(best.historical.consistencyScore * 100).toFixed(1)}%, ` +
      `Worst-case break-even: ${worstCaseBreakEvenDays.toFixed(1)} days, ` +
      `Score: ${best.score.toFixed(4)}`;

    this.logger.log(`🎯 Selected WORST-CASE opportunity: ${best.opportunity.symbol} - ${reason}`);

    return {
      opportunity: best.opportunity,
      plan: best.plan!,
      reason,
    };
  }

  /**
   * Execute worst-case scenario opportunity
   */
  private async executeWorstCaseOpportunity(
    worstCase: {
      opportunity: ArbitrageOpportunity;
      plan: ArbitrageExecutionPlan;
      reason: string;
    },
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
  ): Promise<ArbitrageExecutionResult> {
    this.logger.log(`⚠️  Executing WORST-CASE scenario opportunity: ${worstCase.reason}`);

    // Close existing positions first
    const allPositions = await this.getAllPositions(adapters);
    for (const position of allPositions) {
      try {
        const adapter = adapters.get(position.exchangeType);
        if (adapter) {
          const closeOrder = new PerpOrderRequest(
            position.symbol,
            position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG,
            OrderType.MARKET,
            position.size,
          );
          await adapter.placeOrder(closeOrder);
        }
      } catch (error: any) {
        this.logger.warn(`Failed to close position: ${error.message}`);
      }
    }

    // Execute the worst-case opportunity (same as normal execution)
    try {
      const longAdapter = adapters.get(worstCase.opportunity.longExchange);
      const shortAdapter = adapters.get(worstCase.opportunity.shortExchange);

      if (!longAdapter || !shortAdapter) {
        throw new Error('Missing adapters for worst-case opportunity');
      }

      // Record entry
      const longFeeRate = this.EXCHANGE_FEE_RATES.get(worstCase.opportunity.longExchange) || 0.0005;
      const shortFeeRate = this.EXCHANGE_FEE_RATES.get(worstCase.opportunity.shortExchange) || 0.0005;
      const avgMarkPrice = worstCase.opportunity.longMarkPrice && worstCase.opportunity.shortMarkPrice
        ? (worstCase.opportunity.longMarkPrice + worstCase.opportunity.shortMarkPrice) / 2
        : worstCase.opportunity.longMarkPrice || worstCase.opportunity.shortMarkPrice || 0;
      const positionSizeUsd = worstCase.plan.positionSize * avgMarkPrice;
      const entryCost = (longFeeRate + shortFeeRate) * positionSizeUsd;

      this.lossTracker.recordPositionEntry(
        worstCase.opportunity.symbol,
        worstCase.opportunity.longExchange,
        entryCost / 2,
        positionSizeUsd / 2,
      );
      this.lossTracker.recordPositionEntry(
        worstCase.opportunity.symbol,
        worstCase.opportunity.shortExchange,
        entryCost / 2,
        positionSizeUsd / 2,
      );

      // Place orders
      const longResponse = await longAdapter.placeOrder(worstCase.plan.longOrder);
      const shortResponse = await shortAdapter.placeOrder(worstCase.plan.shortOrder);

      if (longResponse.isSuccess() && shortResponse.isSuccess()) {
        result.opportunitiesExecuted = 1;
        result.ordersPlaced = 2;
        this.logger.log(`✅ Successfully executed worst-case opportunity: ${worstCase.opportunity.symbol}`);
      } else {
        result.errors.push(`Failed to execute worst-case opportunity orders`);
      }
    } catch (error: any) {
      result.errors.push(`Error executing worst-case opportunity: ${error.message}`);
      this.logger.error(`Failed to execute worst-case opportunity: ${error.message}`);
    }

    return result;
  }

  /**
   * Log comprehensive investor report with all risk metrics
   */
  private logInvestorReport(
    riskMetrics: import('../../infrastructure/services/PortfolioRiskAnalyzer').PortfolioRiskMetrics & { dataQuality?: any },
    optimalPortfolio: { allocations: Map<string, number>; totalPortfolio: number; aggregateAPY: number; opportunityCount: number },
  ): void {
    this.logger.log('\n📊 PORTFOLIO RISK ANALYSIS (Investor Report):');
    this.logger.log('='.repeat(100));
    
    // Data quality check
    const dataQuality = riskMetrics.dataQuality;
    if (dataQuality?.hasIssues) {
      this.logger.warn('\n⚠️  DATA QUALITY WARNINGS:');
      dataQuality.warnings.forEach((warning: string) => this.logger.warn(`  - ${warning}`));
    }
    
    // Section 1: Expected Returns & Confidence
    this.logger.log('\nEXPECTED RETURNS:');
    this.logger.log(`  Expected APY: ${(riskMetrics.expectedAPY * 100).toFixed(2)}%`);
    if (dataQuality?.hasSufficientDataForConfidenceInterval) {
      this.logger.log(`  ${(riskMetrics.expectedAPYConfidenceInterval.confidence * 100).toFixed(0)}% Confidence Interval: ${(riskMetrics.expectedAPYConfidenceInterval.lower * 100).toFixed(2)}% - ${(riskMetrics.expectedAPYConfidenceInterval.upper * 100).toFixed(2)}%`);
    } else {
      this.logger.log(`  ${(riskMetrics.expectedAPYConfidenceInterval.confidence * 100).toFixed(0)}% Confidence Interval: N/A (insufficient historical data)`);
    }
    
    // Section 2: Risk Metrics
    this.logger.log('\nRISK METRICS:');
    this.logger.log(`  Worst-Case APY: ${(riskMetrics.worstCaseAPY * 100).toFixed(2)}% (if all spreads reverse)`);
    if (dataQuality?.hasSufficientDataForVaR && riskMetrics.valueAtRisk95 !== 0) {
      this.logger.log(`  Value at Risk (95%): -$${(Math.abs(riskMetrics.valueAtRisk95) / 1000).toFixed(1)}k (worst month loss)`);
    } else {
      this.logger.log(`  Value at Risk (95%): N/A (insufficient historical data - need 2+ months)`);
    }
    if (dataQuality?.hasSufficientDataForDrawdown && riskMetrics.maximumDrawdown !== 0) {
      this.logger.log(`  Maximum Drawdown: -$${(Math.abs(riskMetrics.maximumDrawdown) / 1000).toFixed(1)}k (estimated)`);
    } else {
      this.logger.log(`  Maximum Drawdown: N/A (insufficient historical data - need 1+ month)`);
    }
    this.logger.log(`  Sharpe Ratio: ${riskMetrics.sharpeRatio.toFixed(2)} (risk-adjusted return)`);
    
    // Section 3: Historical Validation
    this.logger.log('\nHISTORICAL VALIDATION:');
    if (dataQuality?.hasSufficientDataForBacktest) {
      this.logger.log(`  Last 30 Days: ${(riskMetrics.historicalBacktest.last30Days.apy * 100).toFixed(2)}% APY ${riskMetrics.historicalBacktest.last30Days.realized ? '(realized)' : '(estimated)'}`);
      this.logger.log(`  Last 90 Days: ${(riskMetrics.historicalBacktest.last90Days.apy * 100).toFixed(2)}% APY ${riskMetrics.historicalBacktest.last90Days.realized ? '(realized)' : '(estimated)'}`);
      if (riskMetrics.historicalBacktest.worstMonth.month !== 'N/A') {
        this.logger.log(`  Worst Month: ${(riskMetrics.historicalBacktest.worstMonth.apy * 100).toFixed(2)}% APY (${riskMetrics.historicalBacktest.worstMonth.month})`);
        this.logger.log(`  Best Month: ${(riskMetrics.historicalBacktest.bestMonth.apy * 100).toFixed(2)}% APY (${riskMetrics.historicalBacktest.bestMonth.month})`);
      } else {
        this.logger.log(`  Worst/Best Month: N/A (insufficient monthly data)`);
      }
    } else {
      this.logger.log(`  Historical Backtest: N/A (insufficient historical data - need 2+ months)`);
    }
    
    // Section 4: Stress Test Scenarios
    this.logger.log('\nSTRESS TEST SCENARIOS:');
    riskMetrics.stressTests.forEach((scenario, index) => {
      const riskEmoji = scenario.riskLevel === 'CRITICAL' ? '🔴' : scenario.riskLevel === 'HIGH' ? '🟠' : scenario.riskLevel === 'MEDIUM' ? '🟡' : '🟢';
      this.logger.log(`  ${index + 1}. ${scenario.scenario}: ${(scenario.apy * 100).toFixed(2)}% APY → ${riskEmoji} ${scenario.riskLevel} risk, ${scenario.timeToRecover} to recover`);
      this.logger.log(`     ${scenario.description}`);
    });
    
    // Section 5: Concentration & Correlation Risks
    this.logger.log('\nCONCENTRATION RISK:');
    const concentrationEmoji = riskMetrics.concentrationRisk.riskLevel === 'HIGH' ? '🔴' : riskMetrics.concentrationRisk.riskLevel === 'MEDIUM' ? '🟡' : '🟢';
    this.logger.log(`  Max Allocation: ${riskMetrics.concentrationRisk.maxAllocationPercent.toFixed(1)}% ${concentrationEmoji} ${riskMetrics.concentrationRisk.riskLevel} RISK${riskMetrics.concentrationRisk.maxAllocationPercent > 25 ? ' - exceeds 25% threshold' : ''}`);
    this.logger.log(`  Top 3 Allocations: ${riskMetrics.concentrationRisk.top3AllocationPercent.toFixed(1)}%`);
    this.logger.log(`  Herfindahl Index: ${riskMetrics.concentrationRisk.herfindahlIndex.toFixed(3)} (${riskMetrics.concentrationRisk.herfindahlIndex > 0.25 ? 'HIGH' : riskMetrics.concentrationRisk.herfindahlIndex > 0.15 ? 'MODERATE' : 'LOW'} concentration)`);
    if (riskMetrics.concentrationRisk.maxAllocationPercent > 25) {
      // Find which symbol has the max allocation
      let maxSymbol = 'N/A';
      let maxAmount = 0;
      optimalPortfolio.allocations.forEach((amount, symbol) => {
        if (amount > maxAmount) {
          maxAmount = amount;
          maxSymbol = symbol;
        }
      });
      this.logger.log(`  Recommendation: Reduce ${maxSymbol} allocation to <25%`);
    }
    
    this.logger.log('\nCORRELATION RISK:');
    if (dataQuality?.hasSufficientDataForCorrelation && riskMetrics.correlationRisk.correlatedPairs.length >= 0) {
      const correlationEmoji = riskMetrics.correlationRisk.maxCorrelation > 0.7 ? '🟠' : riskMetrics.correlationRisk.maxCorrelation > 0.5 ? '🟡' : '🟢';
      this.logger.log(`  Average Correlation: ${riskMetrics.correlationRisk.averageCorrelation.toFixed(3)} (${Math.abs(riskMetrics.correlationRisk.averageCorrelation) < 0.3 ? 'LOW' : 'MODERATE'} - opportunities are mostly ${Math.abs(riskMetrics.correlationRisk.averageCorrelation) < 0.3 ? 'independent' : 'correlated'})`);
      this.logger.log(`  Max Correlation: ${riskMetrics.correlationRisk.maxCorrelation.toFixed(3)} ${correlationEmoji}`);
      if (riskMetrics.correlationRisk.correlatedPairs.length > 0) {
        this.logger.log(`  Highly Correlated Pairs (|correlation| > 0.7): ${riskMetrics.correlationRisk.correlatedPairs.length} pairs`);
        riskMetrics.correlationRisk.correlatedPairs.slice(0, 5).forEach(pair => {
          this.logger.log(`    - ${pair.pair1} / ${pair.pair2}: ${pair.correlation.toFixed(3)}`);
        });
      } else {
        this.logger.log(`  Highly Correlated Pairs: None (all pairs have |correlation| ≤ 0.7)`);
      }
    } else {
      this.logger.log(`  Correlation Analysis: N/A (insufficient historical data - need 10+ matched pairs)`);
    }
    
    // Section 6: Volatility Breakdown by Asset
    this.logger.log('\nVOLATILITY BREAKDOWN:');
    riskMetrics.volatilityBreakdown.forEach(item => {
      const riskEmoji = item.riskLevel === 'HIGH' ? '🔴' : item.riskLevel === 'MEDIUM' ? '🟡' : '🟢';
      this.logger.log(`  ${item.symbol}: $${(item.allocation / 1000).toFixed(1)}k (${item.allocationPercent.toFixed(1)}%) | Stability: ${(item.stabilityScore * 100).toFixed(0)}% | Risk: ${riskEmoji} ${item.riskLevel}`);
    });
    
    this.logger.log('\n' + '='.repeat(100));
  }
}

