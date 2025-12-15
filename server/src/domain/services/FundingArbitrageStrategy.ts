import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  TimeInForce,
  OrderStatus,
} from '../value-objects/PerpOrder';
import { PerpPosition } from '../entities/PerpPosition';
import {
  FundingRateAggregator,
  ArbitrageOpportunity,
  ExchangeSymbolMapping,
} from './FundingRateAggregator';
import { IPerpExchangeAdapter } from '../ports/IPerpExchangeAdapter';
import { HistoricalMetrics } from '../ports/IHistoricalFundingRateService';
import type { IHistoricalFundingRateService } from '../ports/IHistoricalFundingRateService';
import type { IPositionLossTracker } from '../ports/IPositionLossTracker';
import type { IPortfolioRiskAnalyzer } from '../ports/IPortfolioRiskAnalyzer';
import type { IPerpKeeperPerformanceLogger } from '../ports/IPerpKeeperPerformanceLogger';
import type { IOptimalLeverageService } from '../ports/IOptimalLeverageService';
import { ExchangeBalanceRebalancer } from './ExchangeBalanceRebalancer';
import { PortfolioOptimizer } from './strategy-rules/PortfolioOptimizer';
import { OrderExecutor } from './strategy-rules/OrderExecutor';
import { PositionManager } from './strategy-rules/PositionManager';
import { BalanceManager } from './strategy-rules/BalanceManager';
import { OpportunityEvaluator } from './strategy-rules/OpportunityEvaluator';
import { ExecutionPlanBuilder } from './strategy-rules/ExecutionPlanBuilder';
import { CostCalculator } from './strategy-rules/CostCalculator';
import { StrategyConfig } from '../value-objects/StrategyConfig';
import { PositionSize } from '../value-objects/PositionSize';
import { Result } from '../common/Result';
import { DomainException } from '../exceptions/DomainException';
import type { IEventBus } from '../events/DomainEvent';
import {
  ArbitrageOpportunityDiscoveredEvent,
  ExecutionPlanCreatedEvent,
  OrdersPlacedEvent,
  OrdersFilledEvent,
  AsymmetricFillEvent,
  PositionClosedEvent,
  RebalancingAttemptedEvent,
  OpportunityEvaluationFailedEvent,
  OrderExecutionFailedEvent,
  StrategyExecutionCompletedEvent,
} from '../events/ArbitrageEvents';
import { DiagnosticsService } from '../../infrastructure/services/DiagnosticsService';

/**
 * Execution plan for an arbitrage opportunity
 */
export interface ArbitrageExecutionPlan {
  opportunity: ArbitrageOpportunity;
  longOrder: PerpOrderRequest;
  shortOrder: PerpOrderRequest;
  positionSize: PositionSize; // Position size in base asset
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

  // Asymmetric fill tracking: one leg filled, other on book
  private readonly asymmetricFills: Map<
    string,
    {
      symbol: string;
      longFilled: boolean;
      shortFilled: boolean;
      longOrderId?: string;
      shortOrderId?: string;
      longExchange: ExchangeType;
      shortExchange: ExchangeType;
      positionSize: number;
      opportunity: ArbitrageOpportunity;
      timestamp: Date;
    }
  > = new Map();

  // Single-leg retry tracking: track retry attempts for opening missing side
  private readonly singleLegRetries: Map<
    string, // key: `${symbol}-${longExchange}-${shortExchange}`
    {
      retryCount: number;
      longExchange: ExchangeType;
      shortExchange: ExchangeType;
      opportunity: ArbitrageOpportunity;
      lastRetryTime: Date;
    }
  > = new Map();

  // Filtered opportunities: opportunities that failed after 5 retries
  private readonly filteredOpportunities: Set<string> = new Set(); // key: `${symbol}-${longExchange}-${shortExchange}`

  // Failed orders tracking: orders that have exhausted retries
  private readonly failedOrders: Map<
    ExchangeType,
    Array<{ orderId: string; symbol: string; timestamp: Date }>
  > = new Map();

  // Open orders tracking: orders that are still pending
  private readonly openOrders: Map<ExchangeType, string[]> = new Map();

  // Position open time tracking: track when positions were opened to enforce minimum hold time
  // Key: `${symbol}-${longExchange}-${shortExchange}`, Value: timestamp when position was opened
  private readonly positionOpenTimes: Map<string, Date> = new Map();

  // Leverage multiplier (from StrategyConfig, kept for convenience)
  private readonly leverage: number;

  constructor(
    private readonly aggregator: FundingRateAggregator,
    private readonly configService: ConfigService,
    @Inject('IHistoricalFundingRateService')
    private readonly historicalService: IHistoricalFundingRateService,
    @Inject('IPositionLossTracker')
    private readonly lossTracker: IPositionLossTracker,
    @Inject('IPortfolioRiskAnalyzer')
    private readonly portfolioRiskAnalyzer: IPortfolioRiskAnalyzer,
    // Injected extracted modules
    private readonly portfolioOptimizer: PortfolioOptimizer,
    private readonly orderExecutor: OrderExecutor,
    private readonly positionManager: PositionManager,
    private readonly balanceManager: BalanceManager,
    private readonly opportunityEvaluator: OpportunityEvaluator,
    private readonly executionPlanBuilder: ExecutionPlanBuilder,
    private readonly costCalculator: CostCalculator,
    private readonly strategyConfig: StrategyConfig,
    @Optional()
    private readonly performanceLogger?: IPerpKeeperPerformanceLogger,
    @Optional() private readonly balanceRebalancer?: ExchangeBalanceRebalancer,
    @Optional() private readonly eventBus?: IEventBus,
    @Optional()
    private readonly idleFundsManager?: any, // IIdleFundsManager - using any to avoid circular dependency
    @Optional() @Inject('IOptimalLeverageService')
    private readonly optimalLeverageService?: IOptimalLeverageService,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
  ) {
    // Use leverage from StrategyConfig
    // Leverage improves net returns: 2x leverage = 2x funding returns, but fees stay same %
    // Example: $100 capital, 2x leverage = $200 notional, 10% APY = $20/year vs $10/year (2x improvement)
    this.leverage = this.strategyConfig.leverage;
    // Removed strategy initialization log - only execution logs shown
  }

  /**
   * Get leverage for a specific symbol
   * Uses dynamic calculation if enabled, otherwise returns static leverage
   */
  async getLeverageForSymbol(symbol: string, exchange: ExchangeType): Promise<number> {
    // Check for per-symbol override first
    const override = this.strategyConfig.getLeverageForSymbol(symbol);
    if (override !== this.strategyConfig.leverage) {
      return override;
    }

    // Use dynamic leverage if enabled and service available
    if (this.strategyConfig.useDynamicLeverage && this.optimalLeverageService) {
      try {
        const recommendation = await this.optimalLeverageService.calculateOptimalLeverage(
          symbol,
          exchange,
        );
        this.logger.debug(
          `Dynamic leverage for ${symbol}: ${recommendation.optimalLeverage}x ` +
          `(volatility: ${(recommendation.factors.volatilityScore * 100).toFixed(0)}%, ` +
          `liquidity: ${(recommendation.factors.liquidityScore * 100).toFixed(0)}%)`
        );
        return recommendation.optimalLeverage;
      } catch (error: any) {
        this.logger.warn(`Failed to get dynamic leverage for ${symbol}: ${error.message}`);
      }
    }

    // Fallback to static leverage
    return this.leverage;
  }

  /**
   * Create execution plan for an arbitrage opportunity (with pre-fetched balances)
   * Delegates to ExecutionPlanBuilder
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
    // Get dynamic leverage for this symbol if enabled
    const leverage = await this.getLeverageForSymbol(
      opportunity.symbol,
      opportunity.longExchange,
    );
    
    const result = await this.executionPlanBuilder.buildPlan(
      opportunity,
      adapters,
      { longBalance, shortBalance },
      this.strategyConfig,
      longMarkPrice,
      shortMarkPrice,
      maxPositionSizeUsd,
      leverage,
    );

    if (result.isFailure) {
          this.logger.debug(
        `Failed to create execution plan for ${opportunity.symbol}: ${result.error.message}`,
      );
        return null;
      }

    return result.value;
  }


  /**
   * Calculate slippage cost based on order book depth and position size
   * Delegates to CostCalculator
   */
  private calculateSlippageCost(
    positionSizeUsd: number,
    bestBid: number,
    bestAsk: number,
    openInterest: number,
    orderType: OrderType,
  ): number {
    return this.costCalculator.calculateSlippageCost(
      positionSizeUsd,
      bestBid,
      bestAsk,
      openInterest,
      orderType,
    );
  }

  /**
   * Calculate maximum portfolio size that maintains target net APY (35%)
   * Delegates to PortfolioOptimizer
   */
  private async calculateMaxPortfolioForTargetAPY(
    opportunity: ArbitrageOpportunity,
    longBidAsk: { bestBid: number; bestAsk: number },
    shortBidAsk: { bestBid: number; bestAsk: number },
    targetNetAPY: number = 0.35,
  ): Promise<number | null> {
    return this.portfolioOptimizer.calculateMaxPortfolioForTargetAPY(
      opportunity,
      longBidAsk,
      shortBidAsk,
      targetNetAPY,
    );
  }

  /**
   * Calculate max portfolio with optimal leverage
   * Returns both the max position size AND the optimal leverage to use
   */
  private async calculateMaxPortfolioWithLeverage(
    opportunity: ArbitrageOpportunity,
    longBidAsk: { bestBid: number; bestAsk: number },
    shortBidAsk: { bestBid: number; bestAsk: number },
    targetNetAPY: number = 0.35,
  ): Promise<{
    maxPortfolio: number;
    optimalLeverage: number;
    requiredCollateral: number;
    estimatedAPY: number;
  } | null> {
    return this.portfolioOptimizer.calculateMaxPortfolioWithLeverage(
      opportunity,
      longBidAsk,
      shortBidAsk,
      targetNetAPY,
    );
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
   * Delegates to PortfolioOptimizer
   */
  private calculateDataQualityRiskFactor(
    opportunity: ArbitrageOpportunity,
  ): number {
    return this.portfolioOptimizer.calculateDataQualityRiskFactor(opportunity);
  }

  /**
   * Validate historical data quality for an opportunity
   * Delegates to PortfolioOptimizer
   */
  private validateHistoricalDataQuality(
    opportunity: ArbitrageOpportunity,
    historicalSpread: number,
  ): { isValid: boolean; reason?: string } {
    return this.portfolioOptimizer.validateHistoricalDataQuality(
      opportunity,
      historicalSpread,
    );
  }

  /**
   * Calculate optimal portfolio allocation across all opportunities
   * Delegates to PortfolioOptimizer
   */
  private async calculateOptimalPortfolioAllocation(
    opportunities: Array<{
      opportunity: ArbitrageOpportunity;
      maxPortfolioFor35APY: number | null;
      optimalLeverage?: number | null; // Optimal leverage for this position
      longBidAsk: { bestBid: number; bestAsk: number };
      shortBidAsk: { bestBid: number; bestAsk: number };
    }>,
    totalCapital: number | null = null,
    targetAggregateAPY: number = 0.35,
  ): Promise<{
    allocations: Map<string, number>; // symbol -> allocation amount
    totalPortfolio: number;
    aggregateAPY: number;
    opportunityCount: number;
    dataQualityWarnings: string[];
  }> {
    // Convert to PortfolioOptimizationInput format
    // Include optimal leverage for each opportunity (from OptimalLeverageService)
    const portfolioInputs = opportunities.map((opp) => ({
      opportunity: opp.opportunity,
      maxPortfolioFor35APY: opp.maxPortfolioFor35APY,
      optimalLeverage: opp.optimalLeverage ?? undefined,
      longBidAsk: opp.longBidAsk,
      shortBidAsk: opp.shortBidAsk,
    }));

    return this.portfolioOptimizer.calculateOptimalAllocation(
      portfolioInputs,
      totalCapital,
      targetAggregateAPY,
    );
  }


  /**
   * Predict how our position size will affect the funding rate calculation
   * Delegates to CostCalculator
   */
  private predictFundingRateImpact(
    positionSizeUsd: number,
    openInterest: number,
    currentFundingRate: number,
  ): number {
    return this.costCalculator.predictFundingRateImpact(
      positionSizeUsd,
      openInterest,
      currentFundingRate,
    );
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
        `Could not get order book for ${normalizedSymbol} on ${exchangeType}, using mark price estimate: ${error.message}`,
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
      this.logger.warn(
        `Missing adapters for opportunity: ${opportunity.symbol}`,
      );
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
      // Load blacklist from config (defensive filtering at strategy level)
      const blacklistEnv = this.configService.get<string>('KEEPER_BLACKLISTED_SYMBOLS');
      const normalizeSymbol = (symbol: string): string => {
        return symbol
          .trim()
          .toUpperCase()
          .replace('USDT', '')
          .replace('USDC', '')
          .replace('-PERP', '')
          .replace('PERP', '');
      };
      
      let blacklistedSymbols: Set<string> = new Set();
      if (blacklistEnv) {
        blacklistedSymbols = new Set(
          blacklistEnv
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0)
            .map(s => normalizeSymbol(s))
        );
      } else {
        // Default: NVDA
        blacklistedSymbols = new Set(['NVDA']);
      }
      
      // Filter symbols before finding opportunities
      const filteredSymbols = symbols.filter(s => {
        const normalized = normalizeSymbol(s);
        return !blacklistedSymbols.has(normalized);
      });
      
      if (filteredSymbols.length !== symbols.length) {
        const filtered = symbols.filter(s => {
          const normalized = normalizeSymbol(s);
          return blacklistedSymbols.has(normalized);
        });
        this.logger.warn(
          `🚫 Strategy-level blacklist: Filtered out ${filtered.length} blacklisted symbols: ${filtered.join(', ')}`
        );
      }

      // Find arbitrage opportunities (using filtered symbols)
      const opportunities = await this.aggregator.findArbitrageOpportunities(
        filteredSymbols,
        minSpread || this.strategyConfig.defaultMinSpread.toDecimal(),
      );

      // Filter opportunities again (defensive check)
      const filteredOpportunities = opportunities.filter(opp => {
        const normalized = normalizeSymbol(opp.symbol);
        return !blacklistedSymbols.has(normalized);
      });
      
      if (filteredOpportunities.length !== opportunities.length) {
        const filtered = opportunities.filter(opp => {
          const normalized = normalizeSymbol(opp.symbol);
          return blacklistedSymbols.has(normalized);
        });
        const filteredSymbolsList = [...new Set(filtered.map(opp => opp.symbol))];
        this.logger.warn(
          `🚫 Strategy-level blacklist: Filtered out ${filtered.length} opportunities for blacklisted symbols: ${filteredSymbolsList.join(', ')}`
        );
      }

      result.opportunitiesEvaluated = filteredOpportunities.length;

      this.logger.debug(
        `Found ${filteredOpportunities.length} arbitrage opportunities (after blacklist filter)`,
      );

      // Emit events for discovered opportunities (only non-blacklisted)
      if (this.eventBus) {
        for (const opportunity of filteredOpportunities) {
          await this.eventBus.publish(
            new ArbitrageOpportunityDiscoveredEvent(opportunity, opportunity.symbol),
          );
        }
      }

      if (filteredOpportunities.length === 0) {
        return result;
      }

      // Pre-fetch balances for all unique exchanges to reduce API calls
      // This batches balance calls instead of calling for each opportunity
      const uniqueExchanges = new Set<ExchangeType>();
      filteredOpportunities.forEach((opp) => {
        uniqueExchanges.add(opp.longExchange);
        uniqueExchanges.add(opp.shortExchange);
      });

      // Check wallet USDC balance and deposit to exchanges if available
      const depositResult = await this.checkAndDepositWalletFunds(adapters, uniqueExchanges);
      if (depositResult.isFailure) {
        this.logger.warn(
          `Failed to check/deposit wallet funds: ${depositResult.error.message}`,
        );
        // Continue execution even if deposit fails
      }

      // Fetch existing positions FIRST to account for already-deployed margin
      const existingPositions = await this.getAllPositions(adapters);

      // Calculate margin used per exchange from existing positions
      // Margin used = positionValue / leverage (since leverage multiplies position size)
      const marginUsedPerExchange = new Map<ExchangeType, number>();
      for (const position of existingPositions) {
        const positionValue = position.getPositionValue();
        // Margin used = position value / leverage (collateral backing the position)
        const marginUsed = position.marginUsed ?? positionValue / this.leverage;
        const currentMargin =
          marginUsedPerExchange.get(position.exchangeType) ?? 0;
        marginUsedPerExchange.set(
          position.exchangeType,
          currentMargin + marginUsed,
        );
      }

      const exchangeBalances = new Map<ExchangeType, number>();
      for (const exchange of uniqueExchanges) {
        const adapter = adapters.get(exchange);
        if (adapter) {
          try {
            // Clear cache before fetching balance to ensure fresh data
            // Hyperliquid adapter has a clearBalanceCache method
            if ('clearBalanceCache' in adapter && typeof (adapter as any).clearBalanceCache === 'function') {
              (adapter as any).clearBalanceCache();
            }
            
            // Use deployable capital (excludes accrued profits that will be harvested)
            const deployableBalance = await this.balanceManager.getDeployableCapital(adapter, exchange);
            const marginUsed = marginUsedPerExchange.get(exchange) ?? 0;
            // Available balance = deployable balance - margin already used in existing positions
            const availableBalance = Math.max(0, deployableBalance - marginUsed);
            exchangeBalances.set(exchange, availableBalance);

            if (marginUsed > 0) {
              this.logger.debug(
                `${exchange}: Deployable balance: $${deployableBalance.toFixed(2)}, ` +
                  `Margin used: $${marginUsed.toFixed(2)}, ` +
                  `Available: $${availableBalance.toFixed(2)}`,
              );
            }

            // Small delay between balance calls to avoid rate limits
            await new Promise((resolve) => setTimeout(resolve, 50));
          } catch (error: any) {
            this.logger.warn(
              `Failed to get balance for ${exchange}: ${error.message}`,
            );
            // Set to 0 so opportunities using this exchange will be skipped
            exchangeBalances.set(exchange, 0);
          }
        }
      }

      // Evaluate all opportunities and create execution plans (using filtered opportunities)
      // Process sequentially with delays to avoid rate limits
      // Mark prices are already included in the opportunity object from funding rate data
      // Then select the MOST PROFITABLE one (highest expected return)
      const executionPlans: Array<{
        plan: ArbitrageExecutionPlan;
        opportunity: ArbitrageOpportunity;
      }> = [];
      const allEvaluatedOpportunities: Array<{
        opportunity: ArbitrageOpportunity;
        plan: ArbitrageExecutionPlan | null;
        netReturn: number;
        positionValueUsd: number;
        breakEvenHours: number | null;
        maxPortfolioFor35APY: number | null;
        optimalLeverage: number | null; // Optimal leverage for this position
        longBidAsk: { bestBid: number; bestAsk: number } | null;
        shortBidAsk: { bestBid: number; bestAsk: number } | null;
      }> = [];

      for (let i = 0; i < filteredOpportunities.length; i++) {
        const opportunity = filteredOpportunities[i];

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
          let optimalLeverage: number | null = null;

          // Fetch bid/ask data for max portfolio calculation (needed for all opportunities)
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

          // Calculate max portfolio for 35% APY with optimal leverage
          // This returns both the max position size AND the optimal leverage to use
          const portfolioResult = await this.calculateMaxPortfolioWithLeverage(
            opportunity,
            longBidAsk,
            shortBidAsk,
            0.35,
          );
          
          if (portfolioResult) {
            maxPortfolioFor35APY = portfolioResult.maxPortfolio;
            optimalLeverage = portfolioResult.optimalLeverage;
          }

          // Log result with historical context
          if (maxPortfolioFor35APY !== null) {
            const longDataPoints = this.historicalService.getHistoricalData(
              opportunity.symbol,
              opportunity.longExchange,
            ).length;
            const shortDataPoints = this.historicalService.getHistoricalData(
              opportunity.symbol,
              opportunity.shortExchange,
            ).length;
            const hasHistoricalData = longDataPoints > 0 || shortDataPoints > 0;
            this.logger.debug(
              `✅ Max Portfolio (${opportunity.symbol}): $${(maxPortfolioFor35APY / 1000).toFixed(1)}k @ ${optimalLeverage?.toFixed(1)}x leverage ` +
                `(${hasHistoricalData ? 'historical' : 'current'} rates)`,
            );
          }

          if (plan) {
            const avgMarkPrice =
              opportunity.longMarkPrice && opportunity.shortMarkPrice
                ? (opportunity.longMarkPrice + opportunity.shortMarkPrice) / 2
                : opportunity.longMarkPrice || opportunity.shortMarkPrice || 0;
            positionValueUsd = plan.positionSize.toUSD(avgMarkPrice);
            netReturn = plan.expectedNetReturn;
          } else {
            // Calculate metrics even for unprofitable opportunities
            const longBalance =
              exchangeBalances.get(opportunity.longExchange) ?? 0;
            const shortBalance =
              exchangeBalances.get(opportunity.shortExchange) ?? 0;
            const minBalance = Math.min(longBalance, shortBalance);
            const availableCapital = minBalance * this.strategyConfig.balanceUsagePercent.toDecimal();
            const leveragedCapital = availableCapital * this.leverage;
            const maxSize = maxPositionSizeUsd || Infinity;
            const positionSizeUsd = Math.min(leveragedCapital, maxSize);

            if (positionSizeUsd >= this.strategyConfig.minPositionSizeUsd) {
              const avgMarkPrice =
                opportunity.longMarkPrice && opportunity.shortMarkPrice
                  ? (opportunity.longMarkPrice + opportunity.shortMarkPrice) / 2
                  : opportunity.longMarkPrice ||
                    opportunity.shortMarkPrice ||
                    0;

              if (avgMarkPrice > 0) {
                positionValueUsd = positionSizeUsd;

                // Calculate costs and returns
                const longFeeRate =
                  this.strategyConfig.exchangeFeeRates.get(opportunity.longExchange) ||
                  0.0005;
                const shortFeeRate =
                  this.strategyConfig.exchangeFeeRates.get(opportunity.shortExchange) ||
                  0.0005;
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
                const totalOneTimeCosts =
                  totalEntryFees + estimatedSlippageCost;

                const periodsPerDay = 24;
                const periodsPerYear = periodsPerDay * 365;
                // Note: opportunity.expectedReturn is already annualized (APY as decimal, e.g., 0.3625 = 36.25% APY)
                // We convert to hourly dollar return: (APY / periodsPerYear) * positionSize
                const expectedReturnPerPeriod =
                  ((opportunity.expectedReturn?.toAPY() || 0) / periodsPerYear) *
                  positionSizeUsd;

                // Calculate break-even hours: how many hours to cover all costs (entry + exit + slippage)
                const totalCostsWithExit =
                  totalEntryFees + totalExitFees + estimatedSlippageCost;
                if (expectedReturnPerPeriod > 0) {
                  breakEvenHours = totalCostsWithExit / expectedReturnPerPeriod;

                  // Net return per period: hourly return minus amortized costs
                  // Amortize one-time costs over break-even period (capped at 24h) to show true hourly profitability
                  // This way, opportunities that break even quickly show positive net return
                  const amortizationPeriods = Math.max(
                    1,
                    Math.min(24, Math.ceil(breakEvenHours)),
                  ); // Amortize over break-even time, capped at 24h
                  const amortizedCostsPerPeriod =
                    totalCostsWithExit / amortizationPeriods;
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
            optimalLeverage,
            longBidAsk,
            shortBidAsk,
          });

          if (plan) {
            executionPlans.push({ plan, opportunity });
            // Emit event for execution plan creation
            if (this.eventBus) {
              await this.eventBus.publish(
                new ExecutionPlanCreatedEvent(plan, opportunity, opportunity.symbol),
              );
            }
          }
        } catch (error: any) {
          result.errors.push(
            `Error evaluating ${opportunity.symbol}: ${error.message}`,
          );
          this.logger.debug(
            `Failed to evaluate opportunity ${opportunity.symbol}: ${error.message}`,
          );
          // Emit event for evaluation failure
          if (this.eventBus) {
            await this.eventBus.publish(
              new OpportunityEvaluationFailedEvent(
                opportunity,
                error.message,
                opportunity.symbol,
              ),
            );
          }
        }

        // Add delay between opportunity evaluations to avoid rate limits (except for last one)
        if (i < opportunities.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 50)); // Reduced delay since balances are cached
        }
      }

      // Calculate optimal portfolio allocation across all opportunities
      // Include opportunities with valid execution plans OR good break-even times
      // (even if not instantly profitable, as long as they break even within threshold)
      const maxBreakEvenHoursForPortfolio = this.strategyConfig.maxWorstCaseBreakEvenDays * 24;
      const portfolioOptimizationData = allEvaluatedOpportunities
        .filter(
          (item) => {
            // Must have valid execution plan OR acceptable break-even time
            const hasValidPlan = item.plan !== null;
            const hasAcceptableBreakEven =
              item.breakEvenHours !== null &&
              isFinite(item.breakEvenHours) &&
              item.breakEvenHours <= maxBreakEvenHours &&
              item.netReturn > -Infinity; // Must have calculated metrics
            
            return (
              (hasValidPlan || hasAcceptableBreakEven) &&
              item.maxPortfolioFor35APY !== null &&
              item.longBidAsk !== null &&
              item.shortBidAsk !== null
            );
          },
        )
        .map((item) => ({
          opportunity: item.opportunity,
          maxPortfolioFor35APY: item.maxPortfolioFor35APY!,
          longBidAsk: item.longBidAsk!,
          shortBidAsk: item.shortBidAsk!,
        }));

      // Calculate total available capital
      const totalCapital = Array.from(exchangeBalances.values()).reduce(
        (sum, balance) => sum + balance,
        0,
      );

      this.logger.log(
        `💰 Available Capital: $${totalCapital.toFixed(2)} (${portfolioOptimizationData.length} opportunities with valid plans/break-even)`,
      );

      const optimalPortfolio = await this.calculateOptimalPortfolioAllocation(
        portfolioOptimizationData,
        totalCapital > 0 ? totalCapital : null,
        0.35,
      );
      
      // Scale portfolio allocations to actual available capital if needed
      if (optimalPortfolio.totalPortfolio > totalCapital && totalCapital > 0) {
        const scaleFactor = totalCapital / optimalPortfolio.totalPortfolio;
        this.logger.warn(
          `⚠️ Portfolio allocation ($${optimalPortfolio.totalPortfolio.toFixed(2)}) exceeds available capital ($${totalCapital.toFixed(2)}). ` +
          `Scaling by ${(scaleFactor * 100).toFixed(1)}%`,
        );
        // Scale all allocations
        for (const [symbol, allocation] of optimalPortfolio.allocations.entries()) {
          optimalPortfolio.allocations.set(symbol, allocation * scaleFactor);
        }
        optimalPortfolio.totalPortfolio = totalCapital;
      }

      // Sort ALL evaluated opportunities by net return (highest first) for logging
      allEvaluatedOpportunities.sort((a, b) => b.netReturn - a.netReturn);

      // Filter out opportunities with N/A open interest (undefined, null, or 0)
      const opportunitiesWithValidOI = allEvaluatedOpportunities.filter(
        (item) => {
          const longOI = item.opportunity.longOpenInterest;
          const shortOI = item.opportunity.shortOpenInterest;
          return (
            longOI !== undefined &&
            longOI !== null &&
            longOI > 0 &&
            shortOI !== undefined &&
            shortOI !== null &&
            shortOI > 0
          );
        },
      );

      // Log top opportunities only (top 5 profitable + top 3 unprofitable for reference)
      const profitable = opportunitiesWithValidOI
        .filter((item) => item.plan !== null)
        .slice(0, 5);
      const unprofitable = opportunitiesWithValidOI
        .filter((item) => item.plan === null)
        .slice(0, 3);

      if (profitable.length > 0 || unprofitable.length > 0) {
        this.logger.log(
          `\n📊 Top Opportunities: ${profitable.length} profitable, ${unprofitable.length} unprofitable (showing top ${profitable.length + unprofitable.length} of ${opportunitiesWithValidOI.length} total)`,
        );
        [...profitable, ...unprofitable].forEach((item, index) => {
          const isProfitable = item.plan !== null;
          const prefix = isProfitable ? `  ${index + 1}.` : '  ⚠️';
          const maxPortfolioInfo =
            item.maxPortfolioFor35APY !== null &&
            item.maxPortfolioFor35APY !== undefined
              ? ` | Max: $${(item.maxPortfolioFor35APY / 1000).toFixed(1)}k`
              : '';
          this.logger.log(
            `${prefix} ${item.opportunity.symbol}: ` +
              `APY: ${(item.opportunity.expectedReturn?.toPercent() || 0).toFixed(2)}% | ` +
              `Net: $${item.netReturn !== -Infinity ? item.netReturn.toFixed(4) : 'N/A'}/period${maxPortfolioInfo}`,
          );
        });
      }

      // Log optimal portfolio allocation results
      if (optimalPortfolio.opportunityCount > 0) {
        this.logger.log(
          '\n📊 Optimal Portfolio Allocation (Aggregate 35% APY):',
        );
        if (optimalPortfolio.dataQualityWarnings.length > 0) {
          this.logger.debug(
            `   📊 Data Quality: ${optimalPortfolio.dataQualityWarnings.length} opportunities excluded due to invalid spreads (data quality requirements relaxed)`,
          );
        }
        this.logger.log(
          `   Total Portfolio: $${optimalPortfolio.totalPortfolio.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        );
        this.logger.log(
          `   Aggregate APY: ${(optimalPortfolio.aggregateAPY * 100).toFixed(2)}%`,
        );
        this.logger.log(
          `   Opportunities Used: ${optimalPortfolio.opportunityCount}`,
        );
        this.logger.log(`   Allocations:`);
        optimalPortfolio.allocations.forEach((amount, symbol) => {
          if (amount > 0) {
            // Find the opportunity to get data quality risk factor
            const opportunity = allEvaluatedOpportunities.find(
              (item) => item.opportunity.symbol === symbol,
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

            const riskInfo =
              dataQualityRiskFactor < 1.0
                ? ` (Data Quality Risk: ${(dataQualityRiskFactor * 100).toFixed(0)}% - ${longData.length}/${shortData.length}pts)`
                : ` (Data Quality: Good - ${longData.length}/${shortData.length}pts)`;

            this.logger.log(
              `     ${symbol}: $${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${riskInfo}`,
            );
          }
        });
        this.logger.log('');

        // Calculate comprehensive risk metrics
        try {
          const riskMetrics =
            await this.portfolioRiskAnalyzer.calculatePortfolioRiskMetrics({
              allocations: optimalPortfolio.allocations,
              opportunities: allEvaluatedOpportunities
                .filter((item) =>
                  optimalPortfolio.allocations.has(item.opportunity.symbol),
                )
                .map((item) => ({
                  opportunity: item.opportunity,
                  maxPortfolioFor35APY: item.maxPortfolioFor35APY,
                  volatilityMetrics:
                    this.historicalService.getSpreadVolatilityMetrics(
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
          this.logger.error(
            `Failed to calculate portfolio risk metrics: ${error.message}`,
          );
          this.logger.debug(`Risk analysis error: ${error.stack || error}`);
        }
      } else {
        this.logger.log(
          '\n📊 Optimal Portfolio Allocation: No opportunities available for 35% APY portfolio',
        );

        // Show what-if scenario: what if we relaxed data quality requirements?
        const opportunitiesWithMaxPortfolio = portfolioOptimizationData.filter(
          (item) =>
            item.maxPortfolioFor35APY !== null &&
            item.maxPortfolioFor35APY !== undefined &&
            item.maxPortfolioFor35APY > 0,
        );

        // What-if analysis moved to debug level (not actionable)
        if (opportunitiesWithMaxPortfolio.length > 0) {
          this.logger.debug(
            `What-If Analysis: ${opportunitiesWithMaxPortfolio.length} opportunities with maxPortfolioFor35APY available`,
          );
        }
      }

      if (executionPlans.length === 0) {
        this.logger.warn(
          'No instantly profitable execution plans created from opportunities',
        );

        // Try to create execution plans for opportunities with acceptable break-even times
        // Even if not instantly profitable, they can still be executed
        const maxBreakEvenHoursForPlans = this.strategyConfig.maxWorstCaseBreakEvenDays * 24;
        this.logger.log(
          `🔍 Checking opportunities with acceptable break-even times (≤${maxBreakEvenHoursForPlans.toFixed(1)}h)...`,
        );

        for (const item of allEvaluatedOpportunities) {
          // Skip if already has a plan or doesn't meet break-even criteria
          if (item.plan !== null) continue;
          
          const hasAcceptableBreakEven =
            item.breakEvenHours !== null &&
            isFinite(item.breakEvenHours) &&
            item.breakEvenHours <= maxBreakEvenHoursForPlans &&
            item.netReturn > -Infinity &&
            item.opportunity.expectedReturn &&
            item.opportunity.expectedReturn.toAPY() > 0; // Must have positive expected return

          if (hasAcceptableBreakEven) {
            // Try to create execution plan with available capital
            const longBalance =
              exchangeBalances.get(item.opportunity.longExchange) ?? 0;
            const shortBalance =
              exchangeBalances.get(item.opportunity.shortExchange) ?? 0;

            if (longBalance > 0 && shortBalance > 0) {
              try {
                const planResult = await this.executionPlanBuilder.buildPlan(
                  item.opportunity,
                  adapters,
                  { longBalance, shortBalance },
                  this.strategyConfig,
                  item.opportunity.longMarkPrice,
                  item.opportunity.shortMarkPrice,
                  undefined, // Use available capital, not portfolio allocation
                );

                if (planResult.isSuccess) {
                  executionPlans.push({
                    plan: planResult.value,
                    opportunity: item.opportunity,
                  });
                  this.logger.log(
                    `✅ Created execution plan for ${item.opportunity.symbol} (break-even: ${item.breakEvenHours!.toFixed(1)}h)`,
                  );
                  // Update the item's plan so it's included in portfolio optimization
                  item.plan = planResult.value;
                } else {
                  this.logger.debug(
                    `Failed to create plan for ${item.opportunity.symbol}: ${planResult.error.message}`,
                  );
                }
              } catch (error: any) {
                this.logger.debug(
                  `Error creating plan for ${item.opportunity.symbol}: ${error.message}`,
                );
              }
            }
          }
        }

        // If we still have no plans, try worst-case scenario
        if (executionPlans.length === 0) {
          this.logger.warn(
            'No execution plans created (including break-even opportunities). Trying worst-case scenario...',
          );
          
          const worstCaseResult = await this.selectWorstCaseOpportunity(
            opportunitiesWithValidOI,
            adapters,
            maxPositionSizeUsd,
            exchangeBalances,
          );

          if (worstCaseResult) {
            // Execute worst-case opportunity
            return await this.executeWorstCaseOpportunity(
              worstCaseResult,
              adapters,
              result,
            );
          }

          return result;
        } else {
          this.logger.log(
            `✅ Created ${executionPlans.length} execution plan(s) based on break-even time criteria`,
          );
        }
      }

      // MULTI-POSITION PORTFOLIO EXECUTION
      // Greedily fill positions at maxPortfolioFor35APY until we run out of capital
      // Number of positions = how many positions we can afford to max out

      // Calculate total available capital
      const totalAvailableCapital = Array.from(
        exchangeBalances.values(),
      ).reduce((sum, balance) => sum + balance, 0);

      // Get all valid opportunities and sort by expected return (best first)
      // The ladder will allocate whatever capital is available:
      //   - If maxPortfolioFor35APY exists → use it as a cap
      //   - If maxPortfolioFor35APY is null → allocate based purely on available capital
      // We only filter out failed/invalid opportunities, NOT based on affordability or maxPortfolio availability
      const ladderOpportunities = allEvaluatedOpportunities
        .filter((item) => {
          // Filter out opportunities that are marked as filtered (failed after 5 retries)
          const filterKey = this.getRetryKey(
            item.opportunity.symbol,
            item.opportunity.longExchange,
            item.opportunity.shortExchange,
          );
          if (this.filteredOpportunities.has(filterKey)) {
            this.logger.debug(
              `Skipping filtered opportunity ${item.opportunity.symbol} (${item.opportunity.longExchange}/${item.opportunity.shortExchange})`,
            );
            return false;
          }
          
          // Must have a valid execution plan OR acceptable break-even time
          // (even if not instantly profitable, as long as they break even within threshold)
          const maxBreakEvenHours = this.strategyConfig.maxWorstCaseBreakEvenDays * 24;
          const hasValidPlan = item.plan !== null;
            const hasAcceptableBreakEven =
              item.plan === null && // Only check break-even if no plan exists
              item.breakEvenHours !== null &&
              isFinite(item.breakEvenHours) &&
              item.breakEvenHours <= maxBreakEvenHoursForPortfolio &&
              item.netReturn > -Infinity; // Must have calculated metrics
          
          if (!hasValidPlan && !hasAcceptableBreakEven) {
            return false;
          }

          // Check if we have ANY balance on BOTH exchanges (minimum viable position)
          const minPositionCollateral = this.strategyConfig.minPositionSizeUsd / this.leverage;
          const longBalance =
            exchangeBalances.get(item.opportunity.longExchange) ?? 0;
          const shortBalance =
            exchangeBalances.get(item.opportunity.shortExchange) ?? 0;

          // Both exchanges must have at least minimum position collateral
          return (
            longBalance >= minPositionCollateral &&
            shortBalance >= minPositionCollateral
          );
        })
        .sort((a, b) => {
          // Sort by expected return (highest APY first)
          const returnDiff =
            (b.opportunity.expectedReturn?.toAPY() || 0) -
            (a.opportunity.expectedReturn?.toAPY() || 0);
          if (Math.abs(returnDiff) > 0.001) return returnDiff;
          // Then by maxPortfolio as tiebreaker (opportunities with known caps first)
          const aMax = a.maxPortfolioFor35APY ?? Infinity;
          const bMax = b.maxPortfolioFor35APY ?? Infinity;
          return bMax - aMax;
        });

      if (ladderOpportunities.length === 0) {
        this.logger.warn(
          '⚠️ No valid opportunities available for ladder execution (all filtered or insufficient balance)',
        );
        result.errors.push('No valid opportunities available');
        return result;
      }

      this.logger.log(
        `📊 Ladder: ${ladderOpportunities.length} opportunities available ` +
        `(${ladderOpportunities.filter(o => o.maxPortfolioFor35APY !== null).length} with max portfolio caps, ` +
        `${ladderOpportunities.filter(o => o.maxPortfolioFor35APY === null).length} using available capital), ` +
        `${ladderOpportunities.filter(o => o.plan !== null).length} with execution plans`,
      );

      // Ladder allocation: Fill positions sequentially, completely filling each before moving to the next
      // Position 1: $0 to position1Max, Position 2: position1Max+1 to position2Max, etc.
      // Each position requires maxPortfolioFor35APY / leverage as collateral
      // First, check existing positions and calculate where we are in the ladder
      const currentPositions = await this.getAllPositions(adapters);

      // Map existing positions by symbol (for arbitrage pairs, we need both long and short)
      const existingPositionsBySymbol = new Map<
        string,
        {
          long?: PerpPosition;
          short?: PerpPosition;
          currentValue: number; // Total position value (long + short)
          currentCollateral: number; // Current collateral deployed
        }
      >();

      for (const position of currentPositions) {
        if (!existingPositionsBySymbol.has(position.symbol)) {
          existingPositionsBySymbol.set(position.symbol, {
            currentValue: 0,
            currentCollateral: 0,
          });
        }
        const pair = existingPositionsBySymbol.get(position.symbol)!;
        if (position.side === 'LONG') {
          pair.long = position;
        } else if (position.side === 'SHORT') {
          pair.short = position;
        }
        pair.currentValue += position.getPositionValue();
        const marginUsed =
          position.marginUsed ?? position.getPositionValue() / this.leverage;
        pair.currentCollateral += marginUsed;
      }

      const selectedOpportunities: Array<{
        opportunity: ArbitrageOpportunity;
        plan: ArbitrageExecutionPlan | null;
        maxPortfolioFor35APY: number | null;
        isExisting: boolean; // Whether this is topping up an existing position
        currentValue?: number; // Current position value if existing
        currentCollateral?: number; // Current collateral if existing
        additionalCollateralNeeded?: number; // Additional collateral needed to reach max
      }> = [];
      let remainingCapital = totalAvailableCapital;
      let cumulativeCapitalUsed = 0;

      this.logger.log(
        `\n📊 Ladder Allocation: $${totalAvailableCapital.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} capital, ${existingPositionsBySymbol.size} existing position(s)`,
      );

      // First pass: Top up existing positions that are below their max
      for (let i = 0; i < ladderOpportunities.length; i++) {
        const item = ladderOpportunities[i];
        const symbol = item.opportunity.symbol;
        const existingPair = existingPositionsBySymbol.get(symbol);
        
        // If maxPortfolioFor35APY is null, use remaining capital as the cap (no artificial limit)
        // This allows opportunities without calculated max to still be allocated capital
        const maxPortfolio = item.maxPortfolioFor35APY ?? (remainingCapital * this.leverage);
        const maxCollateral = maxPortfolio / this.leverage;

        // CRITICAL: Only consider existing positions if they match the opportunity's exchange pair
        // This prevents opening a third leg (e.g., if we have Aster LONG + Lighter SHORT,
        // we shouldn't open Hyperliquid LONG + Aster SHORT, as that would create 3 positions)
        const existingMatchesOpportunity =
          existingPair &&
          existingPair.currentCollateral > 0 &&
          existingPair.long?.exchangeType === item.opportunity.longExchange &&
          existingPair.short?.exchangeType === item.opportunity.shortExchange;

        if (existingMatchesOpportunity) {
          // We have an existing position for this opportunity that matches the exchange pair
          const currentCollateral = existingPair.currentCollateral;
          const additionalCollateralNeeded = maxCollateral - currentCollateral;

          if (additionalCollateralNeeded > 0.01) {
            // Need at least $0.01 more
            // Position exists but is below max - calculate how much we can top up
            const capitalRangeStart = cumulativeCapitalUsed;
            const topUpAmount = Math.min(
              additionalCollateralNeeded,
              remainingCapital,
            );

            if (topUpAmount >= 0.01) {
              // Can top up at least $0.01
              cumulativeCapitalUsed += topUpAmount;
              const capitalRangeEnd = cumulativeCapitalUsed;

              // Create a scaled opportunity for the top-up
              const scaledMaxPortfolio =
                (currentCollateral + topUpAmount) * this.leverage;
              selectedOpportunities.push({
                ...item,
                maxPortfolioFor35APY: scaledMaxPortfolio,
                isExisting: true,
                currentValue: existingPair.currentValue,
                currentCollateral: currentCollateral,
                additionalCollateralNeeded: topUpAmount,
              });

              remainingCapital -= topUpAmount;

              const isFullyFilled =
                topUpAmount >= additionalCollateralNeeded - 0.01;
              this.logger.log(
                `   🔼 ${symbol}: Adding $${topUpAmount.toFixed(2)} ` +
                  `(${isFullyFilled ? 'FULL' : 'PARTIAL'}) | Remaining: $${remainingCapital.toFixed(2)}`,
              );

              // If we've topped up to max, we can move to next position
              if (isFullyFilled) {
                cumulativeCapitalUsed = capitalRangeStart + maxCollateral; // Set to full max
                continue; // Move to next position
              } else {
                // Position is partially filled - stop here
                break; // Stop here - don't move to next position until this one is full
              }
            } else {
              // Can't top up even $0.01 - stop here
              break;
            }
          } else {
            // Position is already at or above max - move to next position
            cumulativeCapitalUsed += maxCollateral;
            continue;
          }
        } else if (existingPair && existingPair.currentCollateral > 0) {
          // Existing positions exist but don't match this opportunity's exchange pair
          // Skip this opportunity to avoid creating a third leg (breaking delta neutrality)
          this.logger.warn(
            `⚠️ Skipping ${symbol}: Existing positions on ${existingPair.long?.exchangeType || '?'} LONG + ${existingPair.short?.exchangeType || '?'} SHORT ` +
              `don't match opportunity's ${item.opportunity.longExchange} LONG + ${item.opportunity.shortExchange} SHORT ` +
              `(would create 3 positions, breaking delta neutrality)`,
          );
          cumulativeCapitalUsed += maxCollateral; // Reserve space but don't execute
          continue;
        } else {
          // No existing position - fill it partially with whatever capital we have
          // This is Position 1 in the ladder - we fill it until it's maxed, then move to Position 2
          if (remainingCapital > 0.01) {
            // Need at least $0.01
            const capitalRangeStart = cumulativeCapitalUsed;
            const partialCollateral = Math.min(remainingCapital, maxCollateral);
            const partialMaxPortfolio = partialCollateral * this.leverage;

            cumulativeCapitalUsed += partialCollateral;
            const capitalRangeEnd = cumulativeCapitalUsed;

            selectedOpportunities.push({
              ...item,
              maxPortfolioFor35APY: partialMaxPortfolio,
              isExisting: false,
              additionalCollateralNeeded: partialCollateral,
            });
            remainingCapital -= partialCollateral;

            const isFullyFilled = partialCollateral >= maxCollateral - 0.01;
            this.logger.log(
              `   ${isFullyFilled ? '✅' : '🔄'} ${symbol}: NEW $${partialMaxPortfolio.toFixed(2)} ` +
                `($${partialCollateral.toFixed(2)}/${maxCollateral.toFixed(2)} collateral, ${isFullyFilled ? 'FULL' : 'PARTIAL'}) | ` +
                `Remaining: $${remainingCapital.toFixed(2)}`,
            );

            // If this position is fully filled, we can move to the next position
            // Otherwise, we stop here and wait for more capital
            if (!isFullyFilled) {
              break; // Stop here - don't move to next position until this one is full
            }
          } else {
            // No capital left - stop
            break;
          }
        }
      }

      const totalMaxPortfolio = ladderOpportunities.reduce(
        (sum, item) => sum + (item.maxPortfolioFor35APY || 0),
        0,
      );
      const selectedMaxPortfolio = selectedOpportunities.reduce(
        (sum, item) => sum + (item.maxPortfolioFor35APY || 0),
        0,
      );

      if (selectedOpportunities.length === 0) {
        this.logger.warn('⚠️ Insufficient capital to open any positions');
        this.recordDiagnosticError(
          'INSUFFICIENT_CAPITAL',
          'No capital available to open any positions',
          undefined,
          undefined,
          { availableOpportunities: ladderOpportunities.length },
        );
        return result;
      }

      this.logger.log(
        `\n📊 Allocation: ${selectedOpportunities.length} positions, ` +
          `$${(totalAvailableCapital - remainingCapital).toFixed(2)} used, ` +
          `$${remainingCapital.toFixed(2)} remaining`,
      );

      // Only close positions that are NOT being topped up (positions we're replacing with new ones)
      let positionsToClose: PerpPosition[] = [];
      const symbolsBeingToppedUp = new Set(
        selectedOpportunities
          .filter((item) => item.isExisting)
          .map((item) => item.opportunity.symbol),
      );

      for (const position of currentPositions) {
        if (!symbolsBeingToppedUp.has(position.symbol)) {
          positionsToClose.push(position);
        }
      }

      // POSITION STICKINESS: Filter positions to close based on stickiness rules
      // This prevents closing positions that are still profitable just because a slightly better one exists
      if (positionsToClose.length > 0) {
        // Get the best new opportunity spread for comparison
        const bestNewOpportunitySpread = selectedOpportunities.length > 0 && selectedOpportunities[0].opportunity
          ? selectedOpportunities[0].opportunity.spread.toDecimal()
          : null;
        
        this.logger.log(`\n🔒 Evaluating ${positionsToClose.length} candidate position(s) for closing with stickiness rules...`);
        
        const stickinessResult = await this.filterPositionsToCloseWithStickiness(
          positionsToClose,
          existingPositionsBySymbol,
          bestNewOpportunitySpread,
        );
        
        // Update positionsToClose with only the positions that should actually be closed
        const originalCount = positionsToClose.length;
        positionsToClose = stickinessResult.toClose;
        
        if (stickinessResult.toKeep.length > 0) {
          this.logger.log(
            `✅ Stickiness check: Keeping ${stickinessResult.toKeep.length} position(s), ` +
            `closing ${positionsToClose.length} of ${originalCount} candidates`
          );
        }
      }

      // CRITICAL: Detect and handle single-leg positions FIRST (before handling asymmetric fills)
      // Single-leg positions have price exposure - try to open missing side, then close if still missing
      const singleLegPositions = this.positionManager.detectSingleLegPositions(
        currentPositions,
      );
      if (singleLegPositions.length > 0) {
        this.logger.warn(
          `⚠️ Detected ${singleLegPositions.length} single-leg position(s). Attempting to open missing side...`,
        );
        
        // Try to open missing side for each single-leg position
        for (const singleLegPos of singleLegPositions) {
          // Find retry info by matching symbol and exchange
          let retryInfo: {
            retryCount: number;
            longExchange: ExchangeType;
            shortExchange: ExchangeType;
            opportunity: ArbitrageOpportunity;
            lastRetryTime: Date;
          } | undefined;
          let retryKey: string | undefined;
          
          for (const [key, info] of this.singleLegRetries.entries()) {
            if (info.opportunity.symbol === singleLegPos.symbol &&
                (info.longExchange === singleLegPos.exchangeType || 
                 info.shortExchange === singleLegPos.exchangeType)) {
              retryInfo = info;
              retryKey = key;
              break;
            }
          }
          
          if (retryInfo && retryKey && retryInfo.retryCount < 5) {
            // We know which exchange should have the other side - try to open it
            const missingExchange = singleLegPos.side === OrderSide.LONG 
              ? retryInfo.shortExchange 
              : retryInfo.longExchange;
            const missingSide = singleLegPos.side === OrderSide.LONG 
              ? OrderSide.SHORT 
              : OrderSide.LONG;
            
            this.logger.log(
              `🔄 Retry ${retryInfo.retryCount + 1}/5: Attempting to open missing ${missingSide} side ` +
              `for ${singleLegPos.symbol} on ${missingExchange}...`,
            );
            
            // Try to open the missing side using the stored opportunity
            const retrySuccess = await this.retryOpenMissingSide(
              retryInfo.opportunity,
              missingExchange,
              missingSide,
              adapters,
            );
            
            if (retrySuccess) {
              this.logger.log(
                `✅ Successfully opened missing ${missingSide} side for ${singleLegPos.symbol} on ${missingExchange}`,
              );
              // Reset retry count on success
              this.singleLegRetries.delete(retryKey);
            } else {
              // Increment retry count
              retryInfo.retryCount++;
              retryInfo.lastRetryTime = new Date();
              this.logger.warn(
                `⚠️ Retry ${retryInfo.retryCount}/5 failed for ${singleLegPos.symbol}. ` +
                `Will try again next cycle.`,
              );
              
              // After 5 retries, filter out this opportunity
              if (retryInfo.retryCount >= 5) {
                const filterKey = this.getRetryKey(
                  retryInfo.opportunity.symbol,
                  retryInfo.longExchange,
                  retryInfo.shortExchange,
                );
                this.filteredOpportunities.add(filterKey);
                this.logger.error(
                  `❌ Filtering out ${retryInfo.opportunity.symbol} (${retryInfo.longExchange}/${retryInfo.shortExchange}) ` +
                  `after 5 failed retry attempts. Moving to next opportunity.`,
                );
                // Close the single-leg position since we're giving up
                await this.closeSingleLegPosition(singleLegPos, adapters, result);
              }
            }
          } else {
            // No retry info or already exceeded retries - close the position
            this.logger.error(
              `🚨 Closing single-leg position ${singleLegPos.symbol} (${singleLegPos.side}) on ${singleLegPos.exchangeType} ` +
              `- no retry info or exceeded retry limit`,
            );
            await this.closeSingleLegPosition(singleLegPos, adapters, result);
          }
        }
        
        // Refresh positions after retry attempts
        const updatedPositions = await this.getAllPositions(adapters);
        const stillSingleLeg = this.positionManager.detectSingleLegPositions(updatedPositions);
        
        if (stillSingleLeg.length > 0) {
          this.logger.error(
            `🚨 Still have ${stillSingleLeg.length} single-leg position(s) after retries. Closing them...`,
          );
          const singleLegCloseResult = await this.closeAllPositions(
            stillSingleLeg,
            adapters,
            result,
          );
          if (singleLegCloseResult.stillOpen.length > 0) {
            const errorMsg = `${singleLegCloseResult.stillOpen.length} single-leg position(s) failed to close - MANUAL INTERVENTION REQUIRED`;
            this.logger.error(
              `❌ CRITICAL: ${singleLegCloseResult.stillOpen.length} single-leg position(s) failed to close! ` +
                `These positions have price exposure: ${singleLegCloseResult.stillOpen
                  .map((p) => `${p.symbol} (${p.side}) on ${p.exchangeType}`)
                  .join(', ')}. ` +
                `MANUAL INTERVENTION REQUIRED!`,
            );
            // Record critical error for each single-leg position
            for (const pos of singleLegCloseResult.stillOpen) {
              this.recordDiagnosticError(
                'SINGLE_LEG_CLOSE_FAILED',
                errorMsg,
                pos.exchangeType,
                pos.symbol,
                { side: pos.side, critical: true },
              );
            }
          }
        }
        
        // Remove single-leg positions from positionsToClose to avoid double-closing
        const singleLegSymbols = new Set(
          singleLegPositions.map((p) => `${p.symbol}-${p.exchangeType}`),
        );
        positionsToClose = positionsToClose.filter(
          (p) => !singleLegSymbols.has(`${p.symbol}-${p.exchangeType}`),
        );
      }

      // Handle asymmetric fills from previous execution cycles
      await this.handleAsymmetricFills(adapters, result);

      if (positionsToClose.length > 0) {
        this.logger.log(`🔄 Closing ${positionsToClose.length} position(s)...`);
        const closeResult = await this.closeAllPositions(
          positionsToClose,
          adapters,
          result,
        );

        if (closeResult.stillOpen.length > 0) {
          this.logger.warn(
            `⚠️ ${closeResult.stillOpen.length} position(s) failed to close and still exist. ` +
              `Their margin remains locked: ${closeResult.stillOpen.map((p) => `${p.symbol} on ${p.exchangeType}`).join(', ')}`,
          );
        }
        
        // Remove position open time tracking for successfully closed positions
        for (const closedPos of closeResult.closed) {
          // Find the matching pair to get both exchanges
          const pair = existingPositionsBySymbol.get(closedPos.symbol);
          if (pair && pair.long && pair.short) {
            this.removePositionOpenTime(
              closedPos.symbol,
              pair.long.exchangeType,
              pair.short.exchangeType,
            );
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Refresh balances after closing positions (they may have changed)
      // This accounts for positions that failed to close (their margin is still locked)
      // Uses deployable capital (excludes accrued profits)
      for (const [exchange, adapter] of adapters) {
        try {
          const allPositions = await adapter.getPositions();
          const marginUsed = allPositions.reduce((sum, pos) => {
            const posValue = pos.getPositionValue();
            return sum + (pos.marginUsed ?? posValue / this.leverage);
          }, 0);
          // Use deployable capital (excludes accrued profits that will be harvested)
          const deployableBalance = await this.balanceManager.getDeployableCapital(adapter, exchange);
          const availableBalance = Math.max(0, deployableBalance - marginUsed);
          exchangeBalances.set(exchange, availableBalance);

          if (marginUsed > 0) {
            this.logger.debug(
              `${exchange}: Deployable: $${deployableBalance.toFixed(2)}, ` +
                `Margin locked: $${marginUsed.toFixed(2)}, ` +
                `Available: $${availableBalance.toFixed(2)}`,
            );
          }
        } catch (error: any) {
          this.logger.debug(
            `Failed to refresh balance for ${exchange}: ${error.message}`,
          );
        }
      }

      // Create execution plans for opportunities that don't have one but have acceptable break-even times
      const maxBreakEvenHoursForSelected = this.strategyConfig.maxWorstCaseBreakEvenDays * 24;
      for (const opp of selectedOpportunities) {
        if (!opp.plan && opp.opportunity && opp.maxPortfolioFor35APY) {
          // Check if this opportunity has acceptable break-even time
          const oppData = allEvaluatedOpportunities.find(
            (item) =>
              item.opportunity.symbol === opp.opportunity.symbol &&
              item.opportunity.longExchange === opp.opportunity.longExchange &&
              item.opportunity.shortExchange === opp.opportunity.shortExchange,
          );
          
          if (
            oppData &&
            oppData.breakEvenHours !== null &&
            isFinite(oppData.breakEvenHours) &&
            oppData.breakEvenHours <= maxBreakEvenHoursForSelected
          ) {
            // Create execution plan with the allocated position size
            const longBalance =
              exchangeBalances.get(opp.opportunity.longExchange) ?? 0;
            const shortBalance =
              exchangeBalances.get(opp.opportunity.shortExchange) ?? 0;
            
            const planResult = await this.executionPlanBuilder.buildPlan(
              opp.opportunity,
              adapters,
              { longBalance, shortBalance },
              this.strategyConfig,
              opp.opportunity.longMarkPrice,
              opp.opportunity.shortMarkPrice,
              opp.maxPortfolioFor35APY, // Use allocated position size
            );
            
            if (planResult.isSuccess) {
              opp.plan = planResult.value;
              this.logger.log(
                `✅ Created execution plan for ${opp.opportunity.symbol} (break-even: ${oppData.breakEvenHours.toFixed(1)}h)`,
              );
            } else {
              this.logger.warn(
                `⚠️ Failed to create execution plan for ${opp.opportunity.symbol}: ${planResult.error.message}`,
              );
            }
          }
        }
      }
      
      // Store opportunities for retry tracking before execution
      for (const opp of selectedOpportunities) {
        if (opp.plan && opp.opportunity) {
          const retryKey = this.getRetryKey(
            opp.opportunity.symbol,
            opp.opportunity.longExchange,
            opp.opportunity.shortExchange,
          );
          // Only store if not already tracked (don't overwrite existing retry count)
          if (!this.singleLegRetries.has(retryKey)) {
            this.singleLegRetries.set(retryKey, {
              retryCount: 0,
              longExchange: opp.opportunity.longExchange,
              shortExchange: opp.opportunity.shortExchange,
              opportunity: opp.opportunity,
              lastRetryTime: new Date(),
            });
          }
        }
      }

      // Execute all selected positions
      const executionResult = await this.executeMultiplePositions(
        selectedOpportunities,
        adapters,
        exchangeBalances,
        result,
      );

      if (executionResult.isFailure) {
        this.logger.warn(
          `Failed to execute multiple positions: ${executionResult.error.message}`,
        );
        result.errors.push(executionResult.error.message);
      } else {
        const executionResults = executionResult.value;
        result.opportunitiesExecuted = executionResults.successfulExecutions;
        result.ordersPlaced = executionResults.totalOrders;
        result.totalExpectedReturn = executionResults.totalExpectedReturn;
        
        // Record position open times for newly opened positions (for stickiness tracking)
        // Only record for new positions, not top-ups of existing ones
        for (const opp of selectedOpportunities) {
          if (opp.opportunity && !opp.isExisting) {
            this.recordPositionOpenTime(
              opp.opportunity.symbol,
              opp.opportunity.longExchange,
              opp.opportunity.shortExchange,
            );
          }
        }
      }

      // Log comprehensive performance metrics after execution
      if (!executionResult.isFailure) {
      await this.logComprehensivePerformanceMetrics(
        selectedOpportunities,
        adapters,
          executionResult.value.successfulExecutions,
      );
      }

      // Strategy is successful if it completes execution, even with some errors
      // Only mark as failed if there's a fatal error in the outer catch block
      result.success = true;

      // Handle idle funds: detect and reallocate to best opportunities
      if (this.idleFundsManager) {
        try {
          const currentPositions = await this.getAllPositions(adapters);
          const allOpportunities = await this.aggregator.findArbitrageOpportunities(
            symbols,
            minSpread || this.strategyConfig.defaultMinSpread.toDecimal(),
          );

          // Detect idle funds
          const idleFundsResult = await this.idleFundsManager.detectIdleFunds(
            adapters,
            currentPositions,
            this.openOrders,
            this.failedOrders,
          );

          if (idleFundsResult.isSuccess && idleFundsResult.value.length > 0) {
            // Allocate idle funds to best opportunities
            const allocationResult = this.idleFundsManager.allocateIdleFunds(
              idleFundsResult.value,
              allOpportunities,
              currentPositions,
              exchangeBalances,
            );

            if (allocationResult.isSuccess && allocationResult.value.length > 0) {
              // Execute allocations
              const executionResult = await this.idleFundsManager.executeAllocations(
                allocationResult.value,
                adapters,
              );

              if (executionResult.isSuccess) {
                this.logger.log(
                  `✅ Idle funds handling: Allocated $${executionResult.value.allocated.toFixed(2)} ` +
                    `across ${executionResult.value.allocations} allocation(s)`,
                );
              } else {
                this.logger.warn(
                  `Failed to execute idle funds allocations: ${executionResult.error.message}`,
                );
              }
            }
          }
        } catch (error: any) {
          this.logger.warn(`Error handling idle funds: ${error.message}`);
        }
      }
    } catch (error: any) {
      result.success = false;
      result.errors.push(`Strategy execution failed: ${error.message}`);
      this.logger.error(`Strategy execution error: ${error.message}`);
    } finally {
      // Emit strategy execution completed event
      if (this.eventBus) {
        await this.eventBus.publish(
          new StrategyExecutionCompletedEvent(
            result.opportunitiesEvaluated,
            result.opportunitiesExecuted,
            result.totalExpectedReturn,
            result.errors,
          ),
        );
      }
    }

    return result;
  }

  /**
   * Get all positions across all exchanges
   */
  /**
   * Get all positions across all exchanges
   * Delegates to PositionManager
   */
  private async getAllPositions(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<PerpPosition[]> {
    const result = await this.positionManager.getAllPositions(adapters);
    if (result.isFailure) {
        this.logger.warn(
        `Failed to get all positions: ${result.error.message}`,
        );
      return [];
      }
    return result.value;
  }

  /**
   * Close all existing positions
   * Delegates to PositionManager
   */
  private async closeAllPositions(
    positions: PerpPosition[],
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
  ): Promise<{ closed: PerpPosition[]; stillOpen: PerpPosition[] }> {
    const closeResult = await this.positionManager.closeAllPositions(
      positions,
      adapters,
      result,
    );
    if (closeResult.isFailure) {
            this.logger.warn(
        `Failed to close all positions: ${closeResult.error.message}`,
      );
      result.errors.push(closeResult.error.message);
      return { closed: [], stillOpen: positions };
    }
    return closeResult.value;
  }


  /**
   * Wait for an order to fill by polling order status
   * Delegates to OrderExecutor
   */
  private async waitForOrderFill(
    adapter: IPerpExchangeAdapter,
    orderId: string,
    symbol: string,
    exchangeType: ExchangeType,
    expectedSize: number,
    maxRetries: number = 10,
    pollIntervalMs: number = 2000,
    isClosingPosition: boolean = false,
  ): Promise<PerpOrderResponse> {
    return this.orderExecutor.waitForOrderFill(
      adapter,
            orderId,
            symbol,
      exchangeType,
      expectedSize,
      maxRetries,
      pollIntervalMs,
      isClosingPosition,
    );
  }


  /**
   * Calculate total wait time for exponential backoff
   */

  /**
   * Handle asymmetric fills: one leg filled, other on book
   * Delegates to PositionManager
   */
  private async handleAsymmetricFills(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
  ): Promise<void> {
    const now = new Date();
    const fillsToHandle: Array<{
      key: string;
      fill: NonNullable<ReturnType<typeof this.asymmetricFills.get>>;
    }> = [];

    // Find fills that exceeded timeout
    for (const [key, fill] of this.asymmetricFills.entries()) {
      const ageMs = now.getTime() - fill.timestamp.getTime();
      if (ageMs >= this.strategyConfig.asymmetricFillTimeoutMs) {
        fillsToHandle.push({ key, fill });
      }
    }

    if (fillsToHandle.length === 0) {
      return;
    }

    // Convert to AsymmetricFill array format expected by PositionManager
    const fillsArray = fillsToHandle.map(({ fill }) => ({
      symbol: fill.symbol,
      longFilled: fill.longFilled,
      shortFilled: fill.shortFilled,
      longOrderId: fill.longOrderId,
      shortOrderId: fill.shortOrderId,
      longExchange: fill.longExchange,
      shortExchange: fill.shortExchange,
      positionSize: fill.positionSize,
      opportunity: fill.opportunity,
      timestamp: fill.timestamp,
    }));

    // Delegate to PositionManager
    const handleResult = await this.positionManager.handleAsymmetricFills(
      adapters,
      fillsArray,
              result,
            );
    if (handleResult.isFailure) {
          this.logger.warn(
        `Failed to handle asymmetric fills: ${handleResult.error.message}`,
      );
      result.errors.push(handleResult.error.message);
    }

    // Remove handled fills from the Map
    for (const { key } of fillsToHandle) {
          this.asymmetricFills.delete(key);
    }
  }


  /**
   * Close a filled position (helper for asymmetric fill handling)
   * Delegates to PositionManager
   */
  private async closeFilledPosition(
    adapter: IPerpExchangeAdapter,
    symbol: string,
    side: 'LONG' | 'SHORT',
    size: number,
    exchangeType: ExchangeType,
    result: ArbitrageExecutionResult,
  ): Promise<void> {
    const closeResult = await this.positionManager.closeFilledPosition(
          adapter,
          symbol,
      side,
          size,
      exchangeType,
      result,
    );
    if (closeResult.isFailure) {
      this.logger.warn(
        `Failed to close filled position ${symbol}: ${closeResult.error.message}`,
      );
      result.errors.push(closeResult.error.message);
    }
  }


  /**
   * Attempt to rebalance capital to meet balance requirements for an opportunity
   * Priority order:
   * 1. Withdraw from unused exchanges (exchanges not part of this opportunity)
   * 2. Transfer from the exchange with excess balance to the one with deficit
   * 3. Attempt to deposit from wallet (if supported)
   */
  private async attemptRebalanceForOpportunity(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    requiredCollateral: number,
    longBalance: number,
    shortBalance: number,
  ): Promise<boolean> {
    const rebalanceResult = await this.balanceManager.attemptRebalanceForOpportunity(
      opportunity,
      adapters,
      requiredCollateral,
      longBalance,
      shortBalance,
    );
    if (rebalanceResult.isFailure) {
            this.logger.warn(
        `Rebalancing failed: ${rebalanceResult.error.message}`,
      );
      return false;
    }
    return rebalanceResult.value;
  }

  /**
   * Execute multiple positions based on portfolio allocation
   */
  /**
   * Execute multiple positions based on portfolio allocation
   * Delegates to OrderExecutor
   */
  private async executeMultiplePositions(
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
    return this.orderExecutor.executeMultiplePositions(
      opportunities,
                  adapters,
      exchangeBalances,
                  result,
                );
              }


  /**
   * Log comprehensive performance metrics for all positions
   */
  private async logComprehensivePerformanceMetrics(
    opportunities: Array<{
      opportunity: ArbitrageOpportunity;
      plan: ArbitrageExecutionPlan | null;
      maxPortfolioFor35APY: number | null;
    }>,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    successfulExecutions: number,
  ): Promise<void> {
    if (successfulExecutions === 0) {
      return;
    }

    this.logger.log(
      '\n═══════════════════════════════════════════════════════════════════════════════',
    );
    this.logger.log('📊 COMPREHENSIVE PERFORMANCE METRICS');
    this.logger.log(
      '═══════════════════════════════════════════════════════════════════════════════\n',
    );

    // Get all current positions
    const allPositions = await this.getAllPositions(adapters);

    if (allPositions.length === 0) {
      this.logger.log(
        '⚠️ No positions found - metrics will be available after positions are opened',
      );
      return;
    }

    // Get current funding rates for all symbols
    const symbols = new Set<string>();
    allPositions.forEach((pos) => symbols.add(pos.symbol));
    const allFundingRates = new Map<string, Map<ExchangeType, number>>();

    for (const symbol of symbols) {
      try {
        const rates = await this.aggregator.getFundingRates(symbol);
        const rateMap = new Map<ExchangeType, number>();
        rates.forEach((rate) => {
          rateMap.set(rate.exchange, rate.currentRate);
        });
        allFundingRates.set(symbol, rateMap);
      } catch (error: any) {
        this.logger.debug(
          `Failed to get funding rates for ${symbol}: ${error.message}`,
        );
      }
    }

    // Calculate portfolio totals
    let totalPositionValue = 0;
    let totalEntryCosts = 0;
    let totalExpectedHourlyReturn = 0;
    let totalBreakEvenHours = 0;
    let totalEstimatedAPY = 0;
    let totalRealizedPnl = 0;
    let totalUnrealizedPnl = 0;

    // Group positions by symbol (arbitrage pairs: long + short)
    const positionsBySymbol = new Map<
      string,
      { long?: PerpPosition; short?: PerpPosition }
    >();
    for (const position of allPositions) {
      if (!positionsBySymbol.has(position.symbol)) {
        positionsBySymbol.set(position.symbol, {});
      }
      const pair = positionsBySymbol.get(position.symbol)!;
      if (position.side === 'LONG') {
        pair.long = position;
      } else if (position.side === 'SHORT') {
        pair.short = position;
      }
    }

    // Log metrics for each position pair
    this.logger.log('📈 POSITION DETAILS:\n');

    let positionIndex = 0;
    for (const [symbol, pair] of positionsBySymbol.entries()) {
      positionIndex++;

      // Get both positions (long and short)
      const longPosition = pair.long;
      const shortPosition = pair.short;

      if (!longPosition || !shortPosition) {
        // Skip incomplete pairs
        continue;
      }

      const longValue = longPosition.getPositionValue();
      const shortValue = shortPosition.getPositionValue();
      const totalPairValue = longValue + shortValue;
      totalPositionValue += totalPairValue;

      // Get funding rates for this position pair
      // Find the opportunity to get both exchange rates
      const opportunity = opportunities.find(
        (item) => item.opportunity.symbol === symbol,
      );

      let longRate = 0;
      let shortRate = 0;
      if (opportunity) {
        longRate = opportunity.opportunity.longRate?.toDecimal() || 0;
        shortRate = opportunity.opportunity.shortRate?.toDecimal() || 0;
      } else {
        // Fallback: get from funding rates map
        const fundingRates = allFundingRates.get(symbol);
        if (fundingRates) {
          longRate = fundingRates.get(longPosition.exchangeType) || 0;
          shortRate = fundingRates.get(shortPosition.exchangeType) || 0;
        }
      }

      // Calculate break-even metrics for the pair (use long position as representative)
      // For arbitrage, we care about the spread, not individual positions
      const spread = Math.abs(longRate - shortRate);
      const effectiveFundingRate = spread; // Net funding rate for the arbitrage pair

      const longBreakEvenData = this.lossTracker.getRemainingBreakEvenHours(
        longPosition,
        -longRate, // LONG receives funding when rate is negative
        longValue,
      );
      const shortBreakEvenData = this.lossTracker.getRemainingBreakEvenHours(
        shortPosition,
        shortRate, // SHORT receives funding when rate is positive
        shortValue,
      );

      // Combined break-even: use the worse of the two (longer time)
      const combinedBreakEvenHours = Math.max(
        longBreakEvenData.remainingBreakEvenHours,
        shortBreakEvenData.remainingBreakEvenHours,
      );
      const combinedFeesEarned =
        longBreakEvenData.feesEarnedSoFar + shortBreakEvenData.feesEarnedSoFar;
      const combinedRemainingCost =
        longBreakEvenData.remainingCost + shortBreakEvenData.remainingCost;
      const combinedHoursHeld = Math.max(
        longBreakEvenData.hoursHeld,
        shortBreakEvenData.hoursHeld,
      );

      // Calculate hourly return for the arbitrage pair
      const periodsPerYear = 24 * 365;
      let hourlyReturn = 0;
      if (opportunity) {
        const oppSpread = Math.abs(
          (opportunity.opportunity.longRate?.toDecimal() || 0) - (opportunity.opportunity.shortRate?.toDecimal() || 0),
        );
        hourlyReturn = (oppSpread * totalPairValue) / periodsPerYear;
      } else {
        // Estimate from current funding rates
        hourlyReturn = (spread * totalPairValue) / periodsPerYear;
      }

      // Calculate estimated APY
      const estimatedAPY = opportunity
        ? (opportunity.opportunity.expectedReturn?.toPercent() || 0)
        : ((hourlyReturn * periodsPerYear) / totalPairValue) * 100;

      // Get actual entry costs for both positions
      const longEntry = this.lossTracker['currentPositions'].get(
        `${symbol}_${longPosition.exchangeType}`,
      );
      const shortEntry = this.lossTracker['currentPositions'].get(
        `${symbol}_${shortPosition.exchangeType}`,
      );
      const longEntryCost = longEntry?.entry.entryCost || 0;
      const shortEntryCost = shortEntry?.entry.entryCost || 0;
      const totalEntryCost = longEntryCost + shortEntryCost;

      totalEntryCosts += totalEntryCost;
      totalExpectedHourlyReturn += hourlyReturn;
      totalEstimatedAPY +=
        estimatedAPY * (totalPairValue / (totalPositionValue || 1)); // Weighted average

      if (combinedBreakEvenHours !== Infinity) {
        totalBreakEvenHours += combinedBreakEvenHours;
      }

      // Calculate P&L for the pair
      const feesEarnedSoFar = combinedFeesEarned;
      const totalCosts = totalEntryCost * 2; // Entry + estimated exit for both positions
      const currentPnl = feesEarnedSoFar - totalCosts;

      if (currentPnl > 0) {
        totalUnrealizedPnl += currentPnl;
      } else {
        totalUnrealizedPnl += currentPnl; // Negative = loss
      }

      // Format break-even time
      const breakEvenDays = combinedBreakEvenHours / 24;
      const breakEvenStr =
        combinedBreakEvenHours === Infinity
          ? 'N/A (unprofitable)'
          : combinedBreakEvenHours < 1
            ? `${(combinedBreakEvenHours * 60).toFixed(0)} minutes`
            : combinedBreakEvenHours < 24
              ? `${combinedBreakEvenHours.toFixed(1)} hours`
              : `${breakEvenDays.toFixed(1)} days (${combinedBreakEvenHours.toFixed(1)}h)`;

      // Status indicator
      const status =
        combinedBreakEvenHours === 0
          ? '✅ PROFITABLE'
          : combinedBreakEvenHours === Infinity
            ? '❌ UNPROFITABLE'
            : combinedBreakEvenHours < 24
              ? '🟡 BREAKING EVEN SOON'
              : '🟠 IN PROGRESS';

      this.logger.log(`Position Pair ${positionIndex}: ${symbol}`);
      this.logger.log(
        `   ───────────────────────────────────────────────────────────────────────────`,
      );
      this.logger.log(
        `   LONG: ${longPosition.exchangeType} | Size: $${longValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${longPosition.size.toFixed(4)} @ $${(longPosition.markPrice || 0).toFixed(2)})`,
      );
      this.logger.log(
        `   SHORT: ${shortPosition.exchangeType} | Size: $${shortValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${shortPosition.size.toFixed(4)} @ $${(shortPosition.markPrice || 0).toFixed(2)})`,
      );
      this.logger.log(
        `   Total Pair Value: $${totalPairValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      );
      this.logger.log(`   Status: ${status}`);
      this.logger.log(
        `   ───────────────────────────────────────────────────────────────────────────`,
      );

      // Funding Rate Details
      if (opportunity) {
        this.logger.log(
          `   📊 POOL ESTIMATED APY: ${(opportunity.opportunity.expectedReturn?.toPercent() || 0).toFixed(2)}%`,
        );
        this.logger.log(
          `      Long Rate (${opportunity.opportunity.longExchange}): ${(opportunity.opportunity.longRate?.toPercent() || 0).toFixed(4)}%`,
        );
        this.logger.log(
          `      Short Rate (${opportunity.opportunity.shortExchange}): ${(opportunity.opportunity.shortRate?.toPercent() || 0).toFixed(4)}%`,
        );
        this.logger.log(
          `      Spread: ${(opportunity.opportunity.spread?.toPercent() || 0).toFixed(4)}%`,
        );
      }

      this.logger.log(`   💰 CURRENT REAL APY: ${estimatedAPY.toFixed(2)}%`);
      this.logger.log(`      Hourly Return: $${hourlyReturn.toFixed(4)}`);
      this.logger.log(`      Daily Return: $${(hourlyReturn * 24).toFixed(2)}`);
      this.logger.log(
        `      Annual Return: $${(hourlyReturn * periodsPerYear).toFixed(2)}`,
      );

      // Break-even Analysis
      this.logger.log(`   ⏱️  BREAK-EVEN ANALYSIS:`);
      this.logger.log(`      Time Until Break-Even: ${breakEvenStr}`);
      this.logger.log(`      Hours Held: ${combinedHoursHeld.toFixed(2)}`);
      this.logger.log(
        `      Fees Earned So Far: $${feesEarnedSoFar.toFixed(4)}`,
      );
      this.logger.log(
        `      Remaining Cost: $${combinedRemainingCost.toFixed(4)}`,
      );

      // Cost Breakdown
      this.logger.log(`   💸 COST BREAKDOWN:`);
      this.logger.log(`      Long Entry Cost: $${longEntryCost.toFixed(4)}`);
      this.logger.log(`      Short Entry Cost: $${shortEntryCost.toFixed(4)}`);
      this.logger.log(`      Total Entry Cost: $${totalEntryCost.toFixed(4)}`);
      this.logger.log(
        `      Estimated Exit Cost: $${totalEntryCost.toFixed(4)}`,
      );
      this.logger.log(`      Total Costs: $${totalCosts.toFixed(4)}`);

      // P&L Summary
      this.logger.log(`   📈 PROFIT/LOSS:`);
      this.logger.log(`      Fees Earned: $${feesEarnedSoFar.toFixed(4)}`);
      this.logger.log(
        `      Current P&L: $${currentPnl.toFixed(4)} ${currentPnl >= 0 ? '✅' : '❌'}`,
      );
      this.logger.log(
        `      ROI: ${totalCosts > 0 ? ((currentPnl / totalCosts) * 100).toFixed(2) : 0}%`,
      );

      // Allocation Info
      if (opportunity && opportunity.maxPortfolioFor35APY) {
        this.logger.log(`   🎯 ALLOCATION:`);
        this.logger.log(
          `      Max Portfolio (35% APY): $${opportunity.maxPortfolioFor35APY.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        );
        this.logger.log(
          `      Current Allocation: $${totalPairValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        );
        const allocationPercent =
          (totalPairValue / opportunity.maxPortfolioFor35APY) * 100;
        this.logger.log(`      Allocation %: ${allocationPercent.toFixed(1)}%`);
      }

      this.logger.log('');
    }

    // Portfolio Summary
    this.logger.log(
      '═══════════════════════════════════════════════════════════════════════════════',
    );
    this.logger.log('📊 PORTFOLIO SUMMARY');
    this.logger.log(
      '═══════════════════════════════════════════════════════════════════════════════\n',
    );

    const positionPairsCount = positionsBySymbol.size;
    this.logger.log(`   Total Position Pairs: ${positionPairsCount}`);
    this.logger.log(
      `   Total Individual Positions: ${allPositions.length} (${positionPairsCount * 2} expected)`,
    );
    this.logger.log(
      `   Total Position Value: $${totalPositionValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
    this.logger.log(`   Total Entry Costs: $${totalEntryCosts.toFixed(4)}`);
    this.logger.log(
      `   ───────────────────────────────────────────────────────────────────────────`,
    );

    this.logger.log(`   💰 EXPECTED RETURNS:`);
    this.logger.log(`      Weighted Avg APY: ${totalEstimatedAPY.toFixed(2)}%`);
    this.logger.log(
      `      Total Hourly Return: $${totalExpectedHourlyReturn.toFixed(4)}`,
    );
    this.logger.log(
      `      Total Daily Return: $${(totalExpectedHourlyReturn * 24).toFixed(2)}`,
    );
    this.logger.log(
      `      Total Annual Return: $${(totalExpectedHourlyReturn * 8760).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );

    this.logger.log(`   ⏱️  BREAK-EVEN:`);
    const avgBreakEvenHours =
      positionPairsCount > 0 ? totalBreakEvenHours / positionPairsCount : 0;
    const avgBreakEvenDays = avgBreakEvenHours / 24;
    const avgBreakEvenStr =
      avgBreakEvenHours === Infinity
        ? 'N/A'
        : avgBreakEvenHours < 24
          ? `${avgBreakEvenHours.toFixed(1)} hours`
          : `${avgBreakEvenDays.toFixed(1)} days`;
    this.logger.log(`      Average Time to Break-Even: ${avgBreakEvenStr}`);

    this.logger.log(`   📈 PROFIT/LOSS:`);
    this.logger.log(
      `      Total Unrealized P&L: $${totalUnrealizedPnl.toFixed(4)} ${totalUnrealizedPnl >= 0 ? '✅' : '❌'}`,
    );
    this.logger.log(
      `      Total Realized P&L: $${totalRealizedPnl.toFixed(4)}`,
    );
    this.logger.log(
      `      Net P&L: $${(totalUnrealizedPnl + totalRealizedPnl).toFixed(4)}`,
    );

    // Get cumulative loss from loss tracker
    const cumulativeLoss = this.lossTracker.getCumulativeLoss();
    this.logger.log(`      Cumulative Loss: $${cumulativeLoss.toFixed(4)}`);

    this.logger.log(`   📊 EFFICIENCY:`);
    const totalCapital = totalPositionValue / this.leverage; // Collateral deployed
    const capitalEfficiency =
      totalCapital > 0
        ? ((totalExpectedHourlyReturn * 8760) / totalCapital) * 100
        : 0;
    this.logger.log(
      `      Capital Deployed: $${totalCapital.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    );
    this.logger.log(
      `      Capital Efficiency: ${capitalEfficiency.toFixed(2)}% APY`,
    );
    this.logger.log(`      Leverage: ${this.leverage}x`);

    this.logger.log(
      '\n═══════════════════════════════════════════════════════════════════════════════\n',
    );
  }

  /**
   * Execute single position (fallback method)
   */
  /**
   * Execute single position (fallback method)
   * Delegates to OrderExecutor
   */
  private async executeSinglePosition(
    bestOpportunity: {
      plan: ArbitrageExecutionPlan;
      opportunity: ArbitrageOpportunity;
    },
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
    lossTracker: IPositionLossTracker,
  ): Promise<ArbitrageExecutionResult> {
    // Note: OrderExecutor.executeSinglePosition doesn't take lossTracker parameter
    // Loss tracking should be handled internally by OrderExecutor or removed
    const executionResult = await this.orderExecutor.executeSinglePosition(
      bestOpportunity,
        adapters,
        result,
      );

    if (executionResult.isFailure) {
        this.logger.warn(
        `Failed to execute single position for ${bestOpportunity.opportunity.symbol}: ${executionResult.error.message}`,
      );
      result.errors.push(executionResult.error.message);
      this.recordDiagnosticError(
        'EXECUTION_FAILED',
        executionResult.error.message,
        undefined,
        bestOpportunity.opportunity.symbol,
        { type: 'single_position' },
      );
    }

        return result;
      }


  /**
   * Get retry key for single-leg position tracking
   */
  private getRetryKey(
    symbol: string,
    exchange1: ExchangeType,
    exchange2?: ExchangeType,
  ): string {
    if (exchange2) {
      // For opportunity tracking: sort exchanges for consistent key
      const exchanges = [exchange1, exchange2].sort();
      return `${symbol}-${exchanges[0]}-${exchanges[1]}`;
    }
    // For position lookup: find matching retry info by symbol and exchange
    for (const [key, retryInfo] of this.singleLegRetries.entries()) {
      if (key.startsWith(`${symbol}-`) && 
          (retryInfo.longExchange === exchange1 || retryInfo.shortExchange === exchange1)) {
        return key;
      }
    }
    // Fallback: create key with just symbol and exchange
    return `${symbol}-${exchange1}`;
  }

  /**
   * Try to open the missing side of a single-leg position
   * 
   * IMPORTANT: Checks for existing pending orders before placing new ones to prevent
   * duplicate orders (e.g., 4 Lighter orders for 1 Hyperliquid position)
   */
  private async retryOpenMissingSide(
    opportunity: ArbitrageOpportunity,
    missingExchange: ExchangeType,
    missingSide: OrderSide,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<boolean> {
    try {
      const adapter = adapters.get(missingExchange);
      if (!adapter) {
        this.logger.warn(`No adapter found for ${missingExchange}`);
        return false;
      }

      // ========== CRITICAL: Check for existing pending orders BEFORE placing new ones ==========
      // This prevents duplicate orders when single-leg detection runs multiple times
      const PENDING_ORDER_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes - give orders time to fill
      
      if (typeof (adapter as any).getOpenOrders === 'function') {
        try {
          const openOrders = await (adapter as any).getOpenOrders();
          const pendingOrdersForSymbol = openOrders.filter((order: any) => {
            // Match by symbol (handle different formats: YZY, YZY-USD, YZYUSD)
            const normalizedOrderSymbol = order.symbol?.toUpperCase()?.replace('-USD', '')?.replace('USD', '');
            const normalizedOpportunitySymbol = opportunity.symbol?.toUpperCase()?.replace('-USD', '')?.replace('USD', '');
            
            // Normalize side - different exchanges use different formats:
            // Hyperliquid: 'buy'/'sell', Lighter: 'LONG'/'SHORT' or 'BUY'/'SELL'
            const orderSide = order.side?.toUpperCase();
            const isOrderLong = orderSide === 'LONG' || orderSide === 'BUY' || orderSide === 'B';
            const isOrderShort = orderSide === 'SHORT' || orderSide === 'SELL' || orderSide === 'S';
            const isMissingSideLong = missingSide === OrderSide.LONG;
            
            const sideMatches = (isMissingSideLong && isOrderLong) || (!isMissingSideLong && isOrderShort);
            
            return normalizedOrderSymbol === normalizedOpportunitySymbol && sideMatches;
          });

          if (pendingOrdersForSymbol.length > 0) {
            // Check age of oldest pending order
            const now = Date.now();
            const oldestOrder = pendingOrdersForSymbol.reduce((oldest: any, order: any) => {
              const orderTime = order.timestamp ? new Date(order.timestamp).getTime() : now;
              const oldestTime = oldest.timestamp ? new Date(oldest.timestamp).getTime() : now;
              return orderTime < oldestTime ? order : oldest;
            }, pendingOrdersForSymbol[0]);

            const orderAge = now - (oldestOrder.timestamp ? new Date(oldestOrder.timestamp).getTime() : now);

            if (orderAge < PENDING_ORDER_GRACE_PERIOD_MS) {
              // Orders are still fresh - wait for them to fill, don't place more
              this.logger.debug(
                `⏳ Waiting for ${pendingOrdersForSymbol.length} pending ${missingSide} order(s) for ${opportunity.symbol} ` +
                `on ${missingExchange} (${Math.round(orderAge / 1000)}s old, grace period: ${PENDING_ORDER_GRACE_PERIOD_MS / 1000}s)`,
              );
              return false; // Don't place new order, but also don't exhaust retries
            } else {
              // Orders are stale (> 5 min) - cancel them before placing new one
              this.logger.warn(
                `🗑️ Cancelling ${pendingOrdersForSymbol.length} stale pending order(s) for ${opportunity.symbol} ` +
                `on ${missingExchange} (${Math.round(orderAge / 60000)} minutes old)`,
              );
              for (const order of pendingOrdersForSymbol) {
                try {
                  await adapter.cancelOrder(order.orderId, opportunity.symbol);
                } catch (cancelError: any) {
                  this.logger.debug(`Failed to cancel stale order ${order.orderId}: ${cancelError.message}`);
                }
              }
              // Wait for cancellations to process
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        } catch (openOrdersError: any) {
          this.logger.debug(`Could not check open orders on ${missingExchange}: ${openOrdersError.message}`);
          // Continue - we'll place the order anyway
        }
      }
      // ========================================================================================

      // Create execution plan for the missing side
      const leverage = await this.getLeverageForSymbol(
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
        undefined, // longMarkPrice
        undefined, // shortMarkPrice
        undefined, // maxPositionSizeUsd
        leverage,
      );

      if (planResult.isFailure) {
        this.logger.warn(
          `Failed to create execution plan for missing side: ${planResult.error.message}`,
        );
        return false;
      }

      const plan = planResult.value;
      const orderRequest = missingSide === OrderSide.LONG 
        ? plan.longOrder 
        : plan.shortOrder;

      // Place the order
      const orderResult = await adapter.placeOrder(orderRequest);
      
      if (orderResult && orderResult.orderId) {
        this.logger.log(
          `✅ Successfully placed ${missingSide} order for ${opportunity.symbol} on ${missingExchange}: ${orderResult.orderId}`,
        );
        return true;
      } else {
        this.logger.warn(
          `Failed to place ${missingSide} order for ${opportunity.symbol} on ${missingExchange}`,
        );
        return false;
      }
    } catch (error: any) {
      this.logger.warn(
        `Error retrying missing side for ${opportunity.symbol}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Close a single-leg position
   */
  private async closeSingleLegPosition(
    position: PerpPosition,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
  ): Promise<void> {
    try {
      const adapter = adapters.get(position.exchangeType);
      if (!adapter) {
        this.logger.warn(`No adapter found for ${position.exchangeType}`);
        return;
      }

      const closeSide = position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
      const closeOrder = new PerpOrderRequest(
        position.symbol,
        closeSide,
        OrderType.MARKET,
        position.size,
        undefined, // price
        TimeInForce.IOC,
        true, // reduceOnly
      );

      const closeResult = await adapter.placeOrder(closeOrder);
      if (closeResult && closeResult.orderId) {
        this.logger.log(
          `✅ Closed single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType}`,
        );
      } else {
        this.logger.warn(
          `⚠️ Failed to close single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType}`,
        );
        result.errors.push(
          `Failed to close single-leg position ${position.symbol} on ${position.exchangeType}`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Error closing single-leg position ${position.symbol}: ${error.message}`,
      );
      result.errors.push(
        `Error closing single-leg position ${position.symbol}: ${error.message}`,
      );
    }
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
    const evaluationResult = this.opportunityEvaluator.evaluateOpportunityWithHistory(
      opportunity,
      plan,
    );
    if (evaluationResult.isFailure) {
      this.logger.warn(
        `Failed to evaluate opportunity with history: ${evaluationResult.error.message}`,
      );
      // Return default values on failure
    return {
        breakEvenHours: null,
        historicalMetrics: { long: null, short: null },
        worstCaseBreakEvenHours: null,
        consistencyScore: 0,
      };
    }
    return evaluationResult.value;
  }

  /**
   * Determine if we should rebalance from current position to new opportunity
   * Properly accounts for switching costs including exit fees, entry fees, and lost progress
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
    const rebalanceResult = await this.opportunityEvaluator.shouldRebalance(
      currentPosition,
      newOpportunity,
      newPlan,
      cumulativeLoss,
      adapters,
    );
    if (rebalanceResult.isFailure) {
      this.logger.warn(
        `Failed to evaluate rebalance decision: ${rebalanceResult.error.message}`,
      );
      // Default to not rebalancing on error
      return {
        shouldRebalance: false,
        reason: `Error evaluating rebalance: ${rebalanceResult.error.message}`,
        currentBreakEvenHours: null,
        newBreakEvenHours: null,
      };
    }
    return rebalanceResult.value;
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
    const worstCaseResult = await this.opportunityEvaluator.selectWorstCaseOpportunity(
      allOpportunities,
      adapters,
      maxPositionSizeUsd,
      exchangeBalances,
    );
    if (worstCaseResult.isFailure) {
      this.logger.warn(
        `Failed to select worst-case opportunity: ${worstCaseResult.error.message}`,
      );
      return null;
    }
    return worstCaseResult.value;
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
    this.logger.log(
      `⚠️  Executing WORST-CASE scenario opportunity: ${worstCase.reason}`,
    );

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
      const longFeeRate =
        this.strategyConfig.exchangeFeeRates.get(worstCase.opportunity.longExchange) ||
        0.0005;
      const shortFeeRate =
        this.strategyConfig.exchangeFeeRates.get(worstCase.opportunity.shortExchange) ||
        0.0005;
      const avgMarkPrice =
        worstCase.opportunity.longMarkPrice &&
        worstCase.opportunity.shortMarkPrice
          ? (worstCase.opportunity.longMarkPrice +
              worstCase.opportunity.shortMarkPrice) /
            2
          : worstCase.opportunity.longMarkPrice ||
            worstCase.opportunity.shortMarkPrice ||
            0;
      const positionSizeUsd = worstCase.plan.positionSize.toUSD(avgMarkPrice);
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
      const longResponse = await longAdapter.placeOrder(
        worstCase.plan.longOrder,
      );
      const shortResponse = await shortAdapter.placeOrder(
        worstCase.plan.shortOrder,
      );

      if (longResponse.isSuccess && shortResponse.isSuccess) {
        result.opportunitiesExecuted = 1;
        result.ordersPlaced = 2;
        // Worst-case opportunity executed successfully - no log needed for routine operation
      } else {
        result.errors.push(`Failed to execute worst-case opportunity orders`);
      }
    } catch (error: any) {
      result.errors.push(
        `Error executing worst-case opportunity: ${error.message}`,
      );
      this.logger.error(
        `Failed to execute worst-case opportunity: ${error.message}`,
      );
    }

    return result;
  }

  /**
   * Log comprehensive investor report with all risk metrics
   */
  private logInvestorReport(
    riskMetrics: import('../../infrastructure/services/PortfolioRiskAnalyzer').PortfolioRiskMetrics & {
      dataQuality?: any;
    },
    optimalPortfolio: {
      allocations: Map<string, number>;
      totalPortfolio: number;
      aggregateAPY: number;
      opportunityCount: number;
    },
  ): void {
    this.logger.log('\n📊 PORTFOLIO RISK ANALYSIS (Investor Report):');
    this.logger.log('='.repeat(100));

    // Data quality check
    const dataQuality = riskMetrics.dataQuality;
    if (dataQuality?.hasIssues) {
      this.logger.warn('\n⚠️  DATA QUALITY WARNINGS:');
      dataQuality.warnings.forEach((warning: string) =>
        this.logger.warn(`  - ${warning}`),
      );
    }

    // Section 1: Expected Returns & Confidence
    this.logger.log('\nEXPECTED RETURNS:');
    this.logger.log(
      `  Expected APY: ${(riskMetrics.expectedAPY * 100).toFixed(2)}%`,
    );
    if (dataQuality?.hasSufficientDataForConfidenceInterval) {
      this.logger.log(
        `  ${(riskMetrics.expectedAPYConfidenceInterval.confidence * 100).toFixed(0)}% Confidence Interval: ${(riskMetrics.expectedAPYConfidenceInterval.lower * 100).toFixed(2)}% - ${(riskMetrics.expectedAPYConfidenceInterval.upper * 100).toFixed(2)}%`,
      );
    } else {
      this.logger.log(
        `  ${(riskMetrics.expectedAPYConfidenceInterval.confidence * 100).toFixed(0)}% Confidence Interval: N/A (insufficient historical data)`,
      );
    }

    // Section 2: Risk Metrics
    this.logger.log('\nRISK METRICS:');
    this.logger.log(
      `  Worst-Case APY: ${(riskMetrics.worstCaseAPY * 100).toFixed(2)}% (if all spreads reverse)`,
    );
    if (
      dataQuality?.hasSufficientDataForVaR &&
      riskMetrics.valueAtRisk95 !== 0
    ) {
      this.logger.log(
        `  Value at Risk (95%): -$${(Math.abs(riskMetrics.valueAtRisk95) / 1000).toFixed(1)}k (worst month loss)`,
      );
    } else {
      this.logger.log(
        `  Value at Risk (95%): N/A (insufficient historical data - need 2+ months)`,
      );
    }
    if (
      dataQuality?.hasSufficientDataForDrawdown &&
      riskMetrics.maximumDrawdown !== 0
    ) {
      this.logger.log(
        `  Maximum Drawdown: -$${(Math.abs(riskMetrics.maximumDrawdown) / 1000).toFixed(1)}k (estimated)`,
      );
    } else {
      this.logger.log(
        `  Maximum Drawdown: N/A (insufficient historical data - need 1+ month)`,
      );
    }
    this.logger.log(
      `  Sharpe Ratio: ${riskMetrics.sharpeRatio.toFixed(2)} (risk-adjusted return)`,
    );

    // Section 3: Historical Validation
    this.logger.log('\nHISTORICAL VALIDATION:');
    if (dataQuality?.hasSufficientDataForBacktest) {
      this.logger.log(
        `  Last 30 Days: ${(riskMetrics.historicalBacktest.last30Days.apy * 100).toFixed(2)}% APY ${riskMetrics.historicalBacktest.last30Days.realized ? '(realized)' : '(estimated)'}`,
      );
      this.logger.log(
        `  Last 90 Days: ${(riskMetrics.historicalBacktest.last90Days.apy * 100).toFixed(2)}% APY ${riskMetrics.historicalBacktest.last90Days.realized ? '(realized)' : '(estimated)'}`,
      );
      if (riskMetrics.historicalBacktest.worstMonth.month !== 'N/A') {
        this.logger.log(
          `  Worst Month: ${(riskMetrics.historicalBacktest.worstMonth.apy * 100).toFixed(2)}% APY (${riskMetrics.historicalBacktest.worstMonth.month})`,
        );
        this.logger.log(
          `  Best Month: ${(riskMetrics.historicalBacktest.bestMonth.apy * 100).toFixed(2)}% APY (${riskMetrics.historicalBacktest.bestMonth.month})`,
        );
      } else {
        this.logger.log(`  Worst/Best Month: N/A (insufficient monthly data)`);
      }
    } else {
      this.logger.log(
        `  Historical Backtest: N/A (insufficient historical data - need 2+ months)`,
      );
    }

    // Section 4: Stress Test Scenarios
    this.logger.log('\nSTRESS TEST SCENARIOS:');
    riskMetrics.stressTests.forEach((scenario, index) => {
      const riskEmoji =
        scenario.riskLevel === 'CRITICAL'
          ? '🔴'
          : scenario.riskLevel === 'HIGH'
            ? '🟠'
            : scenario.riskLevel === 'MEDIUM'
              ? '🟡'
              : '🟢';
      this.logger.log(
        `  ${index + 1}. ${scenario.scenario}: ${(scenario.apy * 100).toFixed(2)}% APY → ${riskEmoji} ${scenario.riskLevel} risk, ${scenario.timeToRecover} to recover`,
      );
      this.logger.log(`     ${scenario.description}`);
    });

    // Section 5: Concentration & Correlation Risks
    this.logger.log('\nCONCENTRATION RISK:');
    const concentrationEmoji =
      riskMetrics.concentrationRisk.riskLevel === 'HIGH'
        ? '🔴'
        : riskMetrics.concentrationRisk.riskLevel === 'MEDIUM'
          ? '🟡'
          : '🟢';
    this.logger.log(
      `  Max Allocation: ${riskMetrics.concentrationRisk.maxAllocationPercent.toFixed(1)}% ${concentrationEmoji} ${riskMetrics.concentrationRisk.riskLevel} RISK${riskMetrics.concentrationRisk.maxAllocationPercent > 25 ? ' - exceeds 25% threshold' : ''}`,
    );
    this.logger.log(
      `  Top 3 Allocations: ${riskMetrics.concentrationRisk.top3AllocationPercent.toFixed(1)}%`,
    );
    this.logger.log(
      `  Herfindahl Index: ${riskMetrics.concentrationRisk.herfindahlIndex.toFixed(3)} (${riskMetrics.concentrationRisk.herfindahlIndex > 0.25 ? 'HIGH' : riskMetrics.concentrationRisk.herfindahlIndex > 0.15 ? 'MODERATE' : 'LOW'} concentration)`,
    );
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
      this.logger.log(
        `  Recommendation: Reduce ${maxSymbol} allocation to <25%`,
      );
    }

    this.logger.log('\nCORRELATION RISK:');
    if (
      dataQuality?.hasSufficientDataForCorrelation &&
      riskMetrics.correlationRisk.correlatedPairs.length >= 0
    ) {
      const correlationEmoji =
        riskMetrics.correlationRisk.maxCorrelation > 0.7
          ? '🟠'
          : riskMetrics.correlationRisk.maxCorrelation > 0.5
            ? '🟡'
            : '🟢';
      this.logger.log(
        `  Average Correlation: ${riskMetrics.correlationRisk.averageCorrelation.toFixed(3)} (${Math.abs(riskMetrics.correlationRisk.averageCorrelation) < 0.3 ? 'LOW' : 'MODERATE'} - opportunities are mostly ${Math.abs(riskMetrics.correlationRisk.averageCorrelation) < 0.3 ? 'independent' : 'correlated'})`,
      );
      this.logger.log(
        `  Max Correlation: ${riskMetrics.correlationRisk.maxCorrelation.toFixed(3)} ${correlationEmoji}`,
      );
      if (riskMetrics.correlationRisk.correlatedPairs.length > 0) {
        this.logger.log(
          `  Highly Correlated Pairs (|correlation| > 0.7): ${riskMetrics.correlationRisk.correlatedPairs.length} pairs`,
        );
        riskMetrics.correlationRisk.correlatedPairs
          .slice(0, 5)
          .forEach((pair) => {
            this.logger.log(
              `    - ${pair.pair1} / ${pair.pair2}: ${pair.correlation.toFixed(3)}`,
            );
          });
      } else {
        this.logger.log(
          `  Highly Correlated Pairs: None (all pairs have |correlation| ≤ 0.7)`,
        );
      }
    } else {
      this.logger.log(
        `  Correlation Analysis: N/A (insufficient historical data - need 10+ matched pairs)`,
      );
    }

    // Section 6: Volatility Breakdown by Asset
    this.logger.log('\nVOLATILITY BREAKDOWN:');
    riskMetrics.volatilityBreakdown.forEach((item) => {
      const riskEmoji =
        item.riskLevel === 'HIGH'
          ? '🔴'
          : item.riskLevel === 'MEDIUM'
            ? '🟡'
            : '🟢';
      this.logger.log(
        `  ${item.symbol}: $${(item.allocation / 1000).toFixed(1)}k (${item.allocationPercent.toFixed(1)}%) | Stability: ${(item.stabilityScore * 100).toFixed(0)}% | Risk: ${riskEmoji} ${item.riskLevel}`,
      );
    });

    this.logger.log('\n' + '='.repeat(100));
  }

  /**
   * Get wallet USDC balance on-chain
   * Checks the wallet's USDC balance directly from the blockchain
   */
  private async getWalletUsdcBalance(): Promise<number> {
    const balanceResult = await this.balanceManager.getWalletUsdcBalance();
    if (balanceResult.isFailure) {
      this.logger.warn(
        `Failed to get wallet balance: ${balanceResult.error.message}`,
        );
        return 0;
      }
    return balanceResult.value;
  }

  /**
   * Check wallet USDC balance and deposit to exchanges if available
   * This proactively deposits wallet funds to exchanges that need capital
   */
  private async checkAndDepositWalletFunds(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    uniqueExchanges: Set<ExchangeType>,
  ): Promise<Result<void, DomainException>> {
    return this.balanceManager.checkAndDepositWalletFunds(
      adapters,
      uniqueExchanges,
    );
  }

  // ==================== Position Stickiness Methods ====================
  // These methods prevent unnecessary position churn by evaluating whether
  // existing positions should be kept vs closed and replaced

  /**
   * Get the position key for tracking open times
   */
  private getPositionKey(symbol: string, longExchange: ExchangeType, shortExchange: ExchangeType): string {
    return `${symbol}-${longExchange}-${shortExchange}`;
  }

  /**
   * Record when a position pair was opened
   */
  recordPositionOpenTime(symbol: string, longExchange: ExchangeType, shortExchange: ExchangeType): void {
    const key = this.getPositionKey(symbol, longExchange, shortExchange);
    this.positionOpenTimes.set(key, new Date());
    this.logger.debug(`📝 Recorded position open time for ${key}`);
  }

  /**
   * Remove position open time tracking when position is closed
   */
  removePositionOpenTime(symbol: string, longExchange: ExchangeType, shortExchange: ExchangeType): void {
    const key = this.getPositionKey(symbol, longExchange, shortExchange);
    this.positionOpenTimes.delete(key);
    this.logger.debug(`🗑️ Removed position open time for ${key}`);
  }

  /**
   * Get hours since position was opened
   * Returns null if position open time is not tracked (assume it's old enough)
   */
  getPositionAgeHours(symbol: string, longExchange: ExchangeType, shortExchange: ExchangeType): number | null {
    const key = this.getPositionKey(symbol, longExchange, shortExchange);
    const openTime = this.positionOpenTimes.get(key);
    if (!openTime) {
      // If we don't have tracking, assume it's been open long enough
      // This handles positions opened before tracking was added
      return null;
    }
    const ageMs = Date.now() - openTime.getTime();
    return ageMs / (1000 * 60 * 60); // Convert to hours
  }

  /**
   * Get the current funding rate spread for an existing position pair
   * Returns the spread as a decimal (positive = profitable, negative = losing money)
   */
  async getCurrentSpreadForPosition(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): Promise<number | null> {
    try {
      const rates = await this.aggregator.getFundingRates(symbol);
      
      const longRate = rates.find(r => r.exchange === longExchange);
      const shortRate = rates.find(r => r.exchange === shortExchange);
      
      if (!longRate || !shortRate) {
        this.logger.debug(
          `Cannot get current spread for ${symbol}: ` +
          `longRate=${longRate?.currentRate ?? 'missing'}, shortRate=${shortRate?.currentRate ?? 'missing'}`
        );
        return null;
      }
      
      // Spread = shortRate - longRate (positive when we receive funding on both)
      // Long position: we PAY when rate is positive, RECEIVE when negative
      // Short position: we RECEIVE when rate is positive, PAY when negative
      // Net spread = shortRate - longRate
      const spread = shortRate.currentRate - longRate.currentRate;
      
      return spread;
    } catch (error: any) {
      this.logger.debug(`Error getting current spread for ${symbol}: ${error.message}`);
      return null;
    }
  }

  /**
   * Determine if an existing position should be kept vs closed
   * 
   * A position should be KEPT if:
   * 1. It's still earning positive funding (spread > closeSpreadThreshold)
   * 2. OR it hasn't been held long enough (age < minHoldHours) AND spread is not severely negative
   * 3. OR there's no significantly better opportunity to replace it with
   * 
   * @param symbol The symbol of the position pair
   * @param longExchange Exchange holding the long position
   * @param shortExchange Exchange holding the short position
   * @param bestNewOpportunitySpread The spread of the best alternative opportunity (if any)
   * @returns Object with shouldKeep boolean and reason string
   */
  async shouldKeepPosition(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    bestNewOpportunitySpread: number | null,
  ): Promise<{ shouldKeep: boolean; reason: string }> {
    const currentSpread = await this.getCurrentSpreadForPosition(symbol, longExchange, shortExchange);
    const positionAgeHours = this.getPositionAgeHours(symbol, longExchange, shortExchange);
    
    // Default values for position management (not configurable via StrategyConfig yet)
    const closeThreshold = -0.0005; // Close if spread drops below -0.05%
    const minHoldHours = 4; // Minimum 4 hours before considering close
    const churnCostMultiplier = 2.0; // Require 2x the churn cost to justify switching
    
    // Calculate churn cost for this position pair (fees to close + open)
    const longFeeRate = this.strategyConfig.getExchangeFeeRate(longExchange);
    const shortFeeRate = this.strategyConfig.getExchangeFeeRate(shortExchange);
    const churnCost = (longFeeRate + shortFeeRate) * 2; // Close both + open both
    
    this.logger.debug(
      `🔍 Evaluating position ${symbol} (${longExchange}/${shortExchange}): ` +
      `spread=${currentSpread !== null ? (currentSpread * 100).toFixed(4) + '%' : 'unknown'}, ` +
      `age=${positionAgeHours !== null ? positionAgeHours.toFixed(1) + 'h' : 'unknown'}, ` +
      `closeThreshold=${(closeThreshold * 100).toFixed(4)}%, ` +
      `churnCost=${(churnCost * 100).toFixed(4)}%`
    );
    
    // Case 1: Can't get current spread - be conservative and keep position
    if (currentSpread === null) {
      return {
        shouldKeep: true,
        reason: `Cannot determine current spread for ${symbol} - keeping position (conservative)`,
      };
    }
    
    // Case 2: Position has severely negative spread - CLOSE IT regardless of age
    // Severely negative = losing more than 2x the close threshold
    const severelyNegativeThreshold = closeThreshold * 2;
    if (currentSpread < severelyNegativeThreshold) {
      return {
        shouldKeep: false,
        reason: `${symbol} spread (${(currentSpread * 100).toFixed(4)}%) is severely negative (< ${(severelyNegativeThreshold * 100).toFixed(4)}%) - closing to stop losses`,
      };
    }
    
    // Case 3: Position is below minimum hold time - keep unless spread is negative
    if (positionAgeHours !== null && positionAgeHours < minHoldHours) {
      if (currentSpread > 0) {
        return {
          shouldKeep: true,
          reason: `${symbol} is still young (${positionAgeHours.toFixed(1)}h < ${minHoldHours}h min) and profitable (${(currentSpread * 100).toFixed(4)}%) - keeping`,
        };
      } else if (currentSpread > closeThreshold) {
        return {
          shouldKeep: true,
          reason: `${symbol} is young (${positionAgeHours.toFixed(1)}h) and spread (${(currentSpread * 100).toFixed(4)}%) > close threshold (${(closeThreshold * 100).toFixed(4)}%) - keeping`,
        };
      }
    }
    
    // Case 4: Spread is above close threshold - keep position
    if (currentSpread > closeThreshold) {
      // But check if there's a SIGNIFICANTLY better opportunity
      if (bestNewOpportunitySpread !== null) {
        const spreadImprovement = bestNewOpportunitySpread - currentSpread;
        const requiredImprovement = churnCost * churnCostMultiplier;
        
        if (spreadImprovement > requiredImprovement) {
          return {
            shouldKeep: false,
            reason: `${symbol} spread (${(currentSpread * 100).toFixed(4)}%) is profitable but ` +
              `new opportunity (${(bestNewOpportunitySpread * 100).toFixed(4)}%) is ${(spreadImprovement * 100).toFixed(4)}% better, ` +
              `exceeding churn threshold (${(requiredImprovement * 100).toFixed(4)}%) - replacing`,
          };
        }
      }
      
      return {
        shouldKeep: true,
        reason: `${symbol} spread (${(currentSpread * 100).toFixed(4)}%) > close threshold (${(closeThreshold * 100).toFixed(4)}%) - keeping`,
      };
    }
    
    // Case 5: Spread is at or below close threshold - close position
    return {
      shouldKeep: false,
      reason: `${symbol} spread (${(currentSpread * 100).toFixed(4)}%) <= close threshold (${(closeThreshold * 100).toFixed(4)}%) - closing`,
    };
  }

  /**
   * Filter positions to close based on stickiness rules
   * Only returns positions that should actually be closed
   * 
   * @param positionsToClose Candidate positions for closing
   * @param existingPositionsBySymbol Map of existing position pairs
   * @param bestOpportunitySpread Spread of the best new opportunity available
   * @returns Filtered list of positions that should actually be closed
   */
  async filterPositionsToCloseWithStickiness(
    positionsToClose: PerpPosition[],
    existingPositionsBySymbol: Map<string, {
      long?: PerpPosition;
      short?: PerpPosition;
      currentValue: number;
      currentCollateral: number;
    }>,
    bestOpportunitySpread: number | null,
  ): Promise<{ toClose: PerpPosition[]; toKeep: PerpPosition[]; reasons: Map<string, string> }> {
    const toClose: PerpPosition[] = [];
    const toKeep: PerpPosition[] = [];
    const reasons = new Map<string, string>();
    
    // Group positions by symbol (we need to evaluate pairs together)
    const symbolsToEvaluate = new Set<string>();
    for (const position of positionsToClose) {
      symbolsToEvaluate.add(position.symbol);
    }
    
    for (const symbol of symbolsToEvaluate) {
      const pair = existingPositionsBySymbol.get(symbol);
      if (!pair || !pair.long || !pair.short) {
        // Single-leg position - should be handled by single-leg detection, not stickiness
        const positions = positionsToClose.filter(p => p.symbol === symbol);
        toClose.push(...positions);
        reasons.set(symbol, 'Single-leg position - handled separately');
        continue;
      }
      
      // Evaluate if we should keep this position pair
      const { shouldKeep, reason } = await this.shouldKeepPosition(
        symbol,
        pair.long.exchangeType,
        pair.short.exchangeType,
        bestOpportunitySpread,
      );
      
      reasons.set(symbol, reason);
      
      const positionsForSymbol = positionsToClose.filter(p => p.symbol === symbol);
      if (shouldKeep) {
        toKeep.push(...positionsForSymbol);
        this.logger.log(`🔒 KEEPING position ${symbol}: ${reason}`);
      } else {
        toClose.push(...positionsForSymbol);
        this.logger.log(`🔓 CLOSING position ${symbol}: ${reason}`);
      }
    }
    
    return { toClose, toKeep, reasons };
  }
  // ==================== End Position Stickiness Methods ====================

  // ==================== Diagnostics Integration ====================
  
  /**
   * Record an error to the diagnostics service for monitoring
   */
  private recordDiagnosticError(
    type: string,
    message: string,
    exchange?: ExchangeType,
    symbol?: string,
    context?: Record<string, any>,
  ): void {
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
  }

  /**
   * Record an order event to the diagnostics service
   */
  private recordDiagnosticOrder(
    orderId: string,
    symbol: string,
    exchange: ExchangeType,
    side: 'LONG' | 'SHORT',
    status: 'PLACED' | 'FILLED' | 'FAILED' | 'CANCELLED',
    fillTimeMs?: number,
    failReason?: string,
  ): void {
    if (this.diagnosticsService) {
      this.diagnosticsService.recordOrder({
        orderId,
        symbol,
        exchange,
        side,
        placedAt: new Date(),
        status,
        fillTimeMs,
        failReason,
      });
    }
  }
}
