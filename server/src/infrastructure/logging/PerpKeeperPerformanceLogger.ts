import {
  Injectable,
  Logger,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { PerpPosition } from '../../domain/entities/PerpPosition';
import {
  FundingRateComparison,
  ArbitrageOpportunity,
} from '../../domain/services/FundingRateAggregator';
import { ArbitrageExecutionResult } from '../../domain/services/FundingArbitrageStrategy';
import { IPerpKeeperPerformanceLogger } from '../../domain/ports/IPerpKeeperPerformanceLogger';
import {
  RealFundingPaymentsService,
  CombinedFundingSummary,
} from '../services/RealFundingPaymentsService';
import { DiagnosticsService } from '../services/DiagnosticsService';

/**
 * Performance metrics for a single exchange
 */
export interface ExchangePerformanceMetrics {
  exchangeType: ExchangeType;
  totalFundingCaptured: number; // Total funding payments received (USD)
  totalFundingPaid: number; // Total funding payments paid out (USD)
  netFundingCaptured: number; // Net funding (received - paid)
  positionsCount: number;
  totalPositionValue: number; // Total value of all positions (USD)
  totalUnrealizedPnl: number; // Unrealized P&L from positions
  ordersExecuted: number;
  ordersFilled: number;
  ordersFailed: number;
  lastUpdateTime: Date;
}

/**
 * Overall strategy performance metrics
 */
export interface StrategyPerformanceMetrics {
  startTime: Date;
  currentTime: Date;
  runtimeHours: number;
  runtimeDays: number;

  // Funding metrics
  totalFundingCaptured: number; // Total funding received across all exchanges (USD)
  totalFundingPaid: number; // Total funding paid across all exchanges (USD)
  netFundingCaptured: number; // Net funding (received - paid)

  // Position metrics
  totalPositions: number;
  totalPositionValue: number; // Total value of all positions (USD)
  totalUnrealizedPnl: number; // Unrealized P&L
  totalRealizedPnl: number; // Realized P&L from closed positions

  // Trading metrics
  totalOrdersPlaced: number;
  totalOrdersFilled: number;
  totalOrdersFailed: number;
  arbitrageOpportunitiesFound: number;
  arbitrageOpportunitiesExecuted: number;

  // APY calculations
  estimatedAPY: number; // Based on current funding rates and positions
  realizedAPY: number; // Based on actual funding captured
  fundingAPY: number; // Realized APY from funding payments only
  pricePnlAPY: number; // Realized APY from price movement (basis drift)
  estimatedDailyReturn: number; // Estimated daily return based on current rates
  realizedDailyReturn: number; // Actual daily return from funding captured

  // Exchange-specific metrics
  exchangeMetrics: Map<ExchangeType, ExchangePerformanceMetrics>;

  // Capital efficiency
  capitalDeployed: number; // Total capital deployed across all positions
  capitalUtilization: number; // Percentage of available capital being used
  averagePositionSize: number;

  // Risk metrics
  maxDrawdown: number;
  sharpeRatio: number; // If we have enough data
}

/**
 * Funding rate snapshot for APY estimation
 */
interface FundingRateSnapshot {
  symbol: string;
  exchange: ExchangeType;
  fundingRate: number; // Per period (e.g., per 8 hours)
  positionSize: number; // Position size in base asset
  positionValue: number; // Position value in USD
  positionSide: 'LONG' | 'SHORT'; // Position side - needed to correctly calculate APY
  timestamp: Date;
}

/**
 * PerpKeeperPerformanceLogger - Tracks and logs performance metrics for the perp keeper
 */
@Injectable()
export class PerpKeeperPerformanceLogger
  implements IPerpKeeperPerformanceLogger
{
  private readonly logger = new Logger(PerpKeeperPerformanceLogger.name);

  // Performance tracking
  private startTime: Date = new Date();
  private lastResetTime: Date = new Date();
  private exchangeMetrics: Map<ExchangeType, ExchangePerformanceMetrics> =
    new Map();
  private fundingSnapshots: FundingRateSnapshot[] = [];
  private realizedFundingPayments: Array<{
    amount: number;
    timestamp: Date;
    exchange: ExchangeType;
  }> = [];
  private totalRealizedPnl: number = 0;
  private maxDrawdown: number = 0;
  private peakValue: number = 0;

  // Trading statistics
  private totalOrdersPlaced: number = 0;
  private totalOrdersFilled: number = 0;
  private totalOrdersFailed: number = 0;
  private totalTradeVolume: number = 0; // Total trade volume in USD
  private arbitrageOpportunitiesFound: number = 0;
  private arbitrageOpportunitiesExecuted: number = 0;

  // Real funding data (from exchange APIs)
  private realFundingSummary: CombinedFundingSummary | null = null;
  private totalTradingCosts: number = 0;

  constructor(
    @Optional()
    private readonly realFundingService?: RealFundingPaymentsService,
    @Optional()
    @Inject(forwardRef(() => DiagnosticsService))
    private readonly diagnosticsService?: DiagnosticsService,
  ) {
    // Initialize exchange metrics
    for (const exchangeType of [
      ExchangeType.ASTER,
      ExchangeType.LIGHTER,
      ExchangeType.HYPERLIQUID,
    ]) {
      this.exchangeMetrics.set(exchangeType, {
        exchangeType,
        totalFundingCaptured: 0,
        totalFundingPaid: 0,
        netFundingCaptured: 0,
        positionsCount: 0,
        totalPositionValue: 0,
        totalUnrealizedPnl: 0,
        ordersExecuted: 0,
        ordersFilled: 0,
        ordersFailed: 0,
        lastUpdateTime: new Date(),
      });
    }

    // Sync historical funding payments on startup (async, don't block)
    this.syncHistoricalFundingPayments().catch((err) => {
      this.logger.warn(
        `Failed to sync historical funding payments on startup: ${err.message}`,
      );
    });
  }

  /**
   * Sync historical funding payments from RealFundingPaymentsService
   * This ensures the performance logger has all historical data on startup
   * Resets funding totals first to avoid double-counting
   */
  private async syncHistoricalFundingPayments(): Promise<void> {
    if (!this.realFundingService) {
      return; // Service not available
    }

    try {
      // Reset funding totals to avoid double-counting
      for (const metrics of this.exchangeMetrics.values()) {
        metrics.totalFundingCaptured = 0;
        metrics.totalFundingPaid = 0;
        metrics.netFundingCaptured = 0;
      }
      this.realizedFundingPayments = [];

      // Fetch all historical funding payments (last 30 days)
      const payments = await this.realFundingService.fetchAllFundingPayments(30);

      // Record each payment in the performance logger
      for (const payment of payments) {
        // ONLY RECORD IF IT HAPPENED AFTER THE LAST RESET!
        if (this.lastResetTime && payment.timestamp < this.lastResetTime) {
          continue;
        }
        this.recordFundingPayment(payment.exchange, payment.amount);
      }

      // Also sync trading costs
      const totalCosts = this.realFundingService.getTotalTradingCosts();
      if (totalCosts > 0) {
        // If reset was recent, ignore older costs
        if (this.lastResetTime && (new Date().getTime() - this.lastResetTime.getTime() < 60000)) {
          this.totalTradingCosts = 0;
        } else {
          this.totalTradingCosts = totalCosts;
        }
      }

      this.logger.log(
        `📊 Synced ${payments.length} historical funding payments and $${totalCosts.toFixed(4)} trading costs to performance logger`,
      );
    } catch (error: any) {
      this.logger.warn(
        `Failed to sync historical funding payments: ${error.message}`,
      );
      // Don't throw - this is a background sync
    }
  }

  /**
   * Record trading costs (fees, slippage, etc.) for break-even calculation
   */
  recordTradingCosts(amount: number): void {
    this.totalTradingCosts += amount;
    if (this.realFundingService) {
      this.realFundingService.recordTradingCosts(amount);
    }
  }

  /**
   * Get total trading costs
   */
  getTotalTradingCosts(): number {
    return this.totalTradingCosts;
  }

  /**
   * Refresh real funding data from exchange APIs
   */
  async refreshRealFundingData(
    days: number = 30,
    capitalDeployed: number = 0,
  ): Promise<CombinedFundingSummary | null> {
    if (!this.realFundingService) {
      return null;
    }

    try {
      this.realFundingSummary =
        await this.realFundingService.getCombinedSummary(days, capitalDeployed);
      return this.realFundingSummary;
    } catch (error: any) {
      this.logger.error(
        `Failed to refresh real funding data: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get cached real funding summary
   */
  getRealFundingSummary(): CombinedFundingSummary | null {
    return this.realFundingSummary;
  }

  /**
   * Calculate break-even hours based on trading costs and funding rate
   */
  calculateBreakEvenHours(capitalDeployed: number): number | null {
    // If we have real funding data, use it
    if (this.realFundingSummary) {
      return this.realFundingSummary.breakEvenHours;
    }

    // Fallback: calculate from recorded payments
    if (
      this.realizedFundingPayments.length === 0 ||
      this.totalTradingCosts <= 0
    ) {
      return null;
    }

    const totalFunding = this.realizedFundingPayments.reduce(
      (sum, p) => sum + p.amount,
      0,
    );
    const runtimeDays = this.getRuntimeDays();

    if (runtimeDays <= 0) return null;

    const dailyFunding = totalFunding / runtimeDays;

    if (dailyFunding <= 0) {
      return Infinity; // Never breaks even
    }

    const daysToBreakEven = this.totalTradingCosts / dailyFunding;
    return daysToBreakEven * 24; // Convert to hours
  }

  /**
   * Format break-even time for display
   */
  formatBreakEvenTime(hours: number | null): string {
    if (hours === null) return 'N/A';
    if (!isFinite(hours)) return '∞ (never)';
    if (hours <= 0) return '✅ Already profitable';

    if (hours < 1) {
      return `${(hours * 60).toFixed(0)} minutes`;
    } else if (hours < 24) {
      return `${hours.toFixed(1)} hours`;
    } else {
      const days = hours / 24;
      return `${days.toFixed(1)} days (${hours.toFixed(0)}h)`;
    }
  }

  /**
   * Record a funding payment (positive = received, negative = paid)
   */
  recordFundingPayment(exchange: ExchangeType, amount: number): void {
    const metrics = this.exchangeMetrics.get(exchange);
    if (!metrics) return;

    if (amount > 0) {
      metrics.totalFundingCaptured += amount;
    } else {
      metrics.totalFundingPaid += Math.abs(amount);
    }

    metrics.netFundingCaptured =
      metrics.totalFundingCaptured - metrics.totalFundingPaid;
    metrics.lastUpdateTime = new Date();

    // Track for realized APY calculation
    this.realizedFundingPayments.push({
      amount,
      timestamp: new Date(),
      exchange,
    });
  }

  /**
   * Record realized P&L from closed positions
   */
  recordRealizedPnl(amount: number): void {
    this.totalRealizedPnl += amount;
  }

  /**
   * Update position metrics for an exchange
   */
  updatePositionMetrics(
    exchange: ExchangeType,
    positions: PerpPosition[],
    fundingRates: Array<{
      symbol: string;
      exchange: ExchangeType;
      fundingRate: number;
    }>,
  ): void {
    const metrics = this.exchangeMetrics.get(exchange);
    if (!metrics) return;

    // Filter out positions with very small sizes (likely rounding errors or stale data)
    const validPositions = positions.filter((p) => Math.abs(p.size) > 0.0001);

    metrics.positionsCount = validPositions.length;
    metrics.totalPositionValue = validPositions.reduce(
      (sum, pos) => sum + pos.getPositionValue(),
      0,
    );
    metrics.totalUnrealizedPnl = validPositions.reduce(
      (sum, pos) => sum + pos.unrealizedPnl,
      0,
    );
    metrics.lastUpdateTime = new Date();

    // Remove old snapshots for positions being updated on this exchange
    // If positions is empty (all closed), remove ALL snapshots for this exchange
    // Otherwise, remove snapshots only for symbols that are being updated
    if (validPositions.length === 0) {
      // All positions closed - remove all snapshots for this exchange
      this.fundingSnapshots = this.fundingSnapshots.filter(
        (s) => s.exchange !== exchange,
      );
    } else {
      // Remove snapshots for symbols that are being updated (to prevent duplicates)
      const symbolsToUpdate = new Set(validPositions.map((p) => p.symbol));
      this.fundingSnapshots = this.fundingSnapshots.filter(
        (s) => !(symbolsToUpdate.has(s.symbol) && s.exchange === exchange),
      );
    }

    // Create funding rate snapshots for APY estimation
    for (const position of validPositions) {
      const fundingRate = fundingRates.find(
        (fr) => fr.symbol === position.symbol && fr.exchange === exchange,
      );

      if (fundingRate) {
        // Use the position's side field (OrderSide.LONG or OrderSide.SHORT)
        // OrderSide is a string enum with values 'LONG' and 'SHORT'
        const positionSide = position.side === 'LONG' ? 'LONG' : 'SHORT';

        this.fundingSnapshots.push({
          symbol: position.symbol,
          exchange,
          fundingRate: fundingRate.fundingRate,
          positionSize: position.size,
          positionValue: position.getPositionValue(),
          positionSide,
          timestamp: new Date(),
        });
      }
    }

    // Keep only recent snapshots (last 24 hours) and deduplicate by symbol+exchange (keep latest)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    this.fundingSnapshots = this.fundingSnapshots.filter(
      (s) => s.timestamp > oneDayAgo,
    );

    // Deduplicate: keep only the latest snapshot for each symbol+exchange combination
    const snapshotMap = new Map<string, FundingRateSnapshot>();
    for (const snapshot of this.fundingSnapshots) {
      const key = `${snapshot.symbol}:${snapshot.exchange}`;
      const existing = snapshotMap.get(key);
      if (!existing || snapshot.timestamp > existing.timestamp) {
        snapshotMap.set(key, snapshot);
      }
    }
    this.fundingSnapshots = Array.from(snapshotMap.values());
  }

  /**
   * Record order execution
   */
  recordOrderExecution(
    exchange: ExchangeType,
    filled: boolean,
    failed: boolean,
  ): void {
    const metrics = this.exchangeMetrics.get(exchange);
    if (!metrics) return;

    this.totalOrdersPlaced++;
    metrics.ordersExecuted++;

    if (filled) {
      this.totalOrdersFilled++;
      metrics.ordersFilled++;
    }

    if (failed) {
      this.totalOrdersFailed++;
      metrics.ordersFailed++;
    }

    metrics.lastUpdateTime = new Date();

    // Feed DiagnosticsService
    this.diagnosticsService?.recordOrder({
      orderId: `${Date.now()}`, // Placeholder since we don't have actual ID here
      symbol: 'UNKNOWN',
      exchange,
      side: 'LONG',
      placedAt: new Date(),
      filledAt: filled ? new Date() : undefined,
      status: filled ? 'FILLED' : failed ? 'FAILED' : 'PLACED',
    });
  }

  /**
   * Record order with full details (enhanced version for diagnostics)
   */
  recordOrderWithDetails(
    orderId: string,
    symbol: string,
    exchange: ExchangeType,
    side: 'LONG' | 'SHORT',
    status: 'PLACED' | 'FILLED' | 'FAILED' | 'CANCELLED',
    placedAt: Date,
    filledAt?: Date,
    fillTimeMs?: number,
    failReason?: string,
  ): void {
    // Update internal metrics
    const metrics = this.exchangeMetrics.get(exchange);
    if (metrics) {
      if (status === 'PLACED') {
        this.totalOrdersPlaced++;
        metrics.ordersExecuted++;
      } else if (status === 'FILLED') {
        this.totalOrdersFilled++;
        metrics.ordersFilled++;
      } else if (status === 'FAILED') {
        this.totalOrdersFailed++;
        metrics.ordersFailed++;
      }
      metrics.lastUpdateTime = new Date();
    }

    // Feed DiagnosticsService with full details
    this.diagnosticsService?.recordOrder({
      orderId,
      symbol,
      exchange,
      side,
      placedAt,
      filledAt,
      status,
      fillTimeMs,
      failReason,
    });
  }

  /**
   * Record an error event for diagnostics
   */
  recordError(
    type: string,
    message: string,
    exchange?: ExchangeType,
    symbol?: string,
    context?: Record<string, any>,
  ): void {
    this.diagnosticsService?.recordError({
      type,
      message,
      exchange,
      symbol,
      timestamp: new Date(),
      context,
    });
  }

  /**
   * Record a connection event for diagnostics
   */
  recordConnectionEvent(
    exchange: ExchangeType,
    event: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECT' | 'ERROR',
    errorMessage?: string,
  ): void {
    this.diagnosticsService?.recordConnectionEvent({
      exchange,
      event,
      timestamp: new Date(),
      errorMessage,
    });
  }

  /**
   * Record a liquidity filter event for diagnostics
   */
  recordLiquidityFilter(
    symbol: string,
    reason: 'LOW_VOLUME' | 'LOW_OI' | 'MISSING_DATA',
    details?: Record<string, any>,
  ): void {
    this.diagnosticsService?.recordLiquidityFilter({
      symbol,
      reason,
      timestamp: new Date(),
      details,
    });
  }

  /**
   * Record arbitrage opportunity
   */
  recordArbitrageOpportunity(found: boolean, executed: boolean): void {
    if (found) {
      this.arbitrageOpportunitiesFound++;
    }
    if (executed) {
      this.arbitrageOpportunitiesExecuted++;
    }
  }

  /**
   * Record trade volume (USD value of filled trades)
   */
  recordTradeVolume(volume: number): void {
    this.totalTradeVolume += volume;
  }

  /**
   * Calculate estimated APY based on current funding rates and positions
   * For arbitrage positions, calculates the NET funding spread (shortRate - longRate)
   * Accounts for position side:
   * - LONG positions: negative funding rate = we receive funding (positive return)
   * - SHORT positions: positive funding rate = we receive funding (positive return)
   * - For arbitrage pairs: net return = shortRate - longRate (the spread)
   */
  calculateEstimatedAPY(): number {
    if (this.fundingSnapshots.length === 0) return 0;

    // Normalize symbol for cross-exchange matching (e.g., "0GUSDT" -> "0G", "ETHUSDT" -> "ETH")
    const normalizeSymbol = (symbol: string): string => {
      return symbol
        .replace('USDT', '')
        .replace('USDC', '')
        .replace('-PERP', '')
        .replace('PERP', '')
        .toUpperCase();
    };

    // Group snapshots by normalized symbol to identify arbitrage pairs across exchanges
    const snapshotsBySymbol = new Map<
      string,
      { long?: FundingRateSnapshot; short?: FundingRateSnapshot }
    >();

    for (const snapshot of this.fundingSnapshots) {
      const normalizedSymbol = normalizeSymbol(snapshot.symbol);
      if (!snapshotsBySymbol.has(normalizedSymbol)) {
        snapshotsBySymbol.set(normalizedSymbol, {});
      }
      const pair = snapshotsBySymbol.get(normalizedSymbol)!;
      if (snapshot.positionSide === 'LONG') {
        pair.long = snapshot;
      } else {
        pair.short = snapshot;
      }
    }

    // Calculate weighted average funding rate, accounting for arbitrage pairs
    let totalValue = 0;
    let weightedFundingReturn = 0;

    for (const [symbol, pair] of snapshotsBySymbol.entries()) {
      // If we have both LONG and SHORT positions for this symbol, it's an arbitrage pair
      if (pair.long && pair.short) {
        // For arbitrage: net return = shortRate - longRate
        // This is the spread we capture from the arbitrage
        const longRate = pair.long.fundingRate;
        const shortRate = pair.short.fundingRate;
        const netFundingReturn = shortRate - longRate; // Spread

        // Use the average position value for the pair
        const pairValue =
          (pair.long.positionValue + pair.short.positionValue) / 2;
        totalValue += pairValue;
        weightedFundingReturn += netFundingReturn * pairValue;

        this.logger.debug(
          `Arbitrage pair ${symbol}: LONG rate=${(longRate * 100).toFixed(4)}%, ` +
            `SHORT rate=${(shortRate * 100).toFixed(4)}%, ` +
            `Net spread=${(netFundingReturn * 100).toFixed(4)}%`,
        );
      } else {
        // Single position (not part of arbitrage pair) - calculate individually
        // WARNING: This should be part of an arbitrage pair for proper delta-neutral strategy
        const snapshot = pair.long || pair.short!;
        const value = snapshot.positionValue;
        totalValue += value;

        // For LONG positions: negative funding rate = we receive funding (positive return)
        // For SHORT positions: positive funding rate = we receive funding (positive return)
        const fundingReturn =
          snapshot.positionSide === 'LONG'
            ? -snapshot.fundingRate // LONG: negative rate = positive return
            : snapshot.fundingRate; // SHORT: positive rate = positive return

        weightedFundingReturn += fundingReturn * value;

        this.logger.warn(
          `⚠️ Single position ${symbol} (${snapshot.positionSide}) detected - should be part of arbitrage pair. ` +
            `Rate=${(snapshot.fundingRate * 100).toFixed(4)}%, ` +
            `Return=${(fundingReturn * 100).toFixed(4)}%. ` +
            `This may indicate one leg failed to open or was closed.`,
        );
      }
    }

    if (totalValue === 0) return 0;

    const avgFundingReturn = weightedFundingReturn / totalValue;

    // Convert per-period rate to annualized APY
    // Funding rates are hourly (24 periods per day)
    const periodsPerDay = 24;
    const periodsPerYear = periodsPerDay * 365;
    const dailyRate = avgFundingReturn * periodsPerDay;
    const annualizedAPY = dailyRate * 365 * 100; // Convert to percentage

    const arbitragePairsCount = Array.from(snapshotsBySymbol.values()).filter(
      (p) => p.long && p.short,
    ).length;
    const singlePositionsCount = Array.from(snapshotsBySymbol.values()).filter(
      (p) => !(p.long && p.short),
    ).length;

    this.logger.debug(
      `Estimated APY calculation: ` +
        `${arbitragePairsCount} arbitrage pair(s), ${singlePositionsCount} single position(s), ` +
        `avgFundingReturn=${(avgFundingReturn * 100).toFixed(4)}%, ` +
        `dailyRate=${(dailyRate * 100).toFixed(4)}%, ` +
        `annualizedAPY=${annualizedAPY.toFixed(2)}%`,
    );

    return annualizedAPY;
  }

  /**
   * Calculate realized APY based on actual funding payments
   * Prefers real exchange API data over locally recorded payments
   */
  calculateRealizedAPY(capitalDeployed: number): number {
    // Prefer real funding data from exchange APIs
    if (this.realFundingSummary && capitalDeployed > 0) {
      return this.realFundingSummary.realAPY;
    }

    // Fallback to locally recorded payments
    if (capitalDeployed === 0 || this.realizedFundingPayments.length === 0)
      return 0;

    // Calculate NET realized profit (Funding + P&L - Trading Costs)
    const totalFunding = this.realizedFundingPayments.reduce(
      (sum, p) => sum + p.amount,
      0,
    );
    const netProfit = totalFunding + this.totalRealizedPnl - this.totalTradingCosts;
    const runtimeDays = this.getRuntimeDays();

    if (runtimeDays === 0) return 0;

    // IMPORTANT: Don't extrapolate from very short periods - results are unreliable
    // Require at least 1 hour (1/24 day) of runtime for APY calculation
    const MIN_DAYS_FOR_APY = 1 / 24; // 1 hour

    if (runtimeDays < MIN_DAYS_FOR_APY) {
      // For very short periods, just show the current return rate (not annualized)
      const rawReturn = (netProfit / capitalDeployed) * 100;
      return rawReturn;
    }

    // Calculate daily return and annualize
    const dailyReturn = netProfit / capitalDeployed / runtimeDays;

    // Cap APY at reasonable maximum to prevent misleading numbers
    // Even the best funding arb strategies rarely exceed 500% APY sustainably
    const MAX_REASONABLE_APY = 1000; // 1000% APY cap
    const annualizedAPY = Math.min(dailyReturn * 365 * 100, MAX_REASONABLE_APY);

    if (dailyReturn * 365 * 100 > MAX_REASONABLE_APY) {
      this.logger.warn(
        `Calculated APY (${(dailyReturn * 365 * 100).toFixed(0)}%) exceeds cap, showing ${MAX_REASONABLE_APY}%. ` +
          `This may indicate insufficient runtime (${(runtimeDays * 24).toFixed(1)}h) for accurate extrapolation.`,
      );
    }

    return annualizedAPY;
  }

  /**
   * Get real funding metrics (from exchange APIs)
   */
  getRealFundingMetrics(): {
    netFunding: number;
    dailyAverage: number;
    annualized: number;
  } | null {
    if (!this.realFundingSummary) return null;

    return {
      netFunding: this.realFundingSummary.netFunding,
      dailyAverage: this.realFundingSummary.dailyAverage,
      annualized: this.realFundingSummary.annualized,
    };
  }

  /**
   * Get comprehensive performance metrics
   */
  getPerformanceMetrics(
    capitalDeployed: number = 0,
  ): StrategyPerformanceMetrics {
    const now = new Date();
    const runtimeHours =
      (now.getTime() - this.startTime.getTime()) / (1000 * 60 * 60);
    const runtimeDays = runtimeHours / 24;

    // Aggregate exchange metrics
    let totalFundingCaptured = 0;
    let totalFundingPaid = 0;
    let totalPositions = 0;
    let totalPositionValue = 0;
    let totalUnrealizedPnl = 0;

    for (const metrics of this.exchangeMetrics.values()) {
      totalFundingCaptured += metrics.totalFundingCaptured;
      totalFundingPaid += metrics.totalFundingPaid;
      totalPositions += metrics.positionsCount;
      totalPositionValue += metrics.totalPositionValue;
      totalUnrealizedPnl += metrics.totalUnrealizedPnl;
    }

    const netFundingCaptured = totalFundingCaptured - totalFundingPaid;
    const estimatedAPY = this.calculateEstimatedAPY();
    
    // Determine the capital base for APY calculation
    // Prefer capitalDeployed (actual collateral), fallback to estimated collateral if not provided
    const defaultLeverage = 2.0;
    const estimatedCollateral = totalPositionValue / defaultLeverage;
    const capitalBase = capitalDeployed || (estimatedCollateral > 0 ? estimatedCollateral : totalPositionValue);

    const realizedAPY = this.calculateRealizedAPY(capitalBase);
    
    // Calculate split APYs (Funding vs Price PnL)
    let fundingAPY = 0;
    let pricePnlAPY = 0;
    const MAX_REASONABLE_APY = 1000;

    if (capitalBase > 0 && runtimeDays > (1/24)) {
      // Funding only APY
      const fundingDailyReturn = netFundingCaptured / capitalBase / runtimeDays;
      fundingAPY = Math.min(fundingDailyReturn * 365 * 100, MAX_REASONABLE_APY);

      // Price PnL only APY (Basis drift)
      const pricePnlDailyReturn = (this.totalRealizedPnl - this.totalTradingCosts) / capitalBase / runtimeDays;
      pricePnlAPY = Math.min(pricePnlDailyReturn * 365 * 100, MAX_REASONABLE_APY);
    }

    // Calculate daily returns
    const estimatedDailyReturn =
      runtimeDays > 0
        ? (estimatedAPY / 100 / 365) * capitalBase
        : 0;

    const realizedDailyReturn =
      runtimeDays > 0 ? (netFundingCaptured + this.totalRealizedPnl - this.totalTradingCosts) / runtimeDays : 0;

    // Calculate capital utilization
    const capitalUtilization =
      capitalDeployed > 0 ? (totalPositionValue / capitalDeployed) * 100 : 0;

    // Calculate average position size
    const averagePositionSize =
      totalPositions > 0 ? totalPositionValue / totalPositions : 0;

    // Update drawdown tracking
    const currentValue =
      totalPositionValue + netFundingCaptured + this.totalRealizedPnl;
    if (currentValue > this.peakValue) {
      this.peakValue = currentValue;
    }
    const drawdown =
      this.peakValue > 0
        ? ((this.peakValue - currentValue) / this.peakValue) * 100
        : 0;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
    }

    return {
      startTime: this.startTime,
      currentTime: now,
      runtimeHours,
      runtimeDays,
      totalFundingCaptured,
      totalFundingPaid,
      netFundingCaptured,
      totalPositions,
      totalPositionValue,
      totalUnrealizedPnl,
      totalRealizedPnl: this.totalRealizedPnl,
      totalOrdersPlaced: this.totalOrdersPlaced,
      totalOrdersFilled: this.totalOrdersFilled,
      totalOrdersFailed: this.totalOrdersFailed,
      arbitrageOpportunitiesFound: this.arbitrageOpportunitiesFound,
      arbitrageOpportunitiesExecuted: this.arbitrageOpportunitiesExecuted,
      estimatedAPY,
      realizedAPY,
      fundingAPY,
      pricePnlAPY,
      estimatedDailyReturn,
      realizedDailyReturn,
      exchangeMetrics: new Map(this.exchangeMetrics),
      capitalDeployed: capitalDeployed || totalPositionValue,
      capitalUtilization,
      averagePositionSize,
      maxDrawdown: this.maxDrawdown,
      sharpeRatio: 0, // TODO: Calculate if we have enough data
    };
  }

  /**
   * Reset all performance metrics to start "from now"
   */
  resetPerformanceMetrics(): void {
    this.logger.warn(
      '🔄 Resetting all performance metrics. APY calculation will restart from this moment.',
    );

    this.startTime = new Date();
    this.lastResetTime = new Date(); // Update reset time
    this.realizedFundingPayments = [];
    this.fundingSnapshots = [];
    this.totalRealizedPnl = 0;
    this.totalTradingCosts = 0;
    this.maxDrawdown = 0;
    this.peakValue = 0;
    this.totalOrdersPlaced = 0;
    this.totalOrdersFilled = 0;
    this.totalOrdersFailed = 0;
    this.totalTradeVolume = 0;
    this.arbitrageOpportunitiesFound = 0;
    this.arbitrageOpportunitiesExecuted = 0;
    this.realFundingSummary = null; // Clear exchange cache

    // Reset per-exchange metrics
    for (const exchangeType of Array.from(this.exchangeMetrics.keys())) {
      this.exchangeMetrics.set(exchangeType, {
        exchangeType,
        totalFundingCaptured: 0,
        totalFundingPaid: 0,
        netFundingCaptured: 0,
        positionsCount: 0,
        totalPositionValue: 0,
        totalUnrealizedPnl: 0,
        ordersExecuted: 0,
        ordersFilled: 0,
        ordersFailed: 0,
        lastUpdateTime: new Date(),
      });
    }

    // Force diagnostics update
    if (this.diagnosticsService) {
      this.diagnosticsService.updateApyData({
        estimated: 0,
        realized: 0,
        funding: 0,
        pricePnl: 0,
        realizedPnl: 0,
        netFunding: 0,
        byExchange: {},
      });
    }
  }

  /**
   * Log comprehensive performance metrics
   */
  logPerformanceMetrics(capitalDeployed: number = 0): void {
    const metrics = this.getPerformanceMetrics(capitalDeployed);

    this.logger.log('');
    this.logger.log(
      '📊 ═══════════════════════════════════════════════════════════',
    );
    this.logger.log('📊 PERP KEEPER PERFORMANCE METRICS');
    this.logger.log(
      '📊 ═══════════════════════════════════════════════════════════',
    );
    this.logger.log('');

    // Runtime
    this.logger.log(
      `⏱️  Runtime: ${metrics.runtimeDays.toFixed(2)} days (${metrics.runtimeHours.toFixed(1)} hours)`,
    );
    this.logger.log('');

    // APY Metrics
    this.logger.log('💰 APY METRICS');
    this.logger.log(`   📈 Estimated APY: ${metrics.estimatedAPY.toFixed(2)}%`);
    this.logger.log(`   ✅ Realized APY: ${metrics.realizedAPY.toFixed(2)}%`);
    this.logger.log(
      `   📅 Estimated Daily Return: $${metrics.estimatedDailyReturn.toFixed(2)}`,
    );
    this.logger.log(
      `   💵 Realized Daily Return: $${metrics.realizedDailyReturn.toFixed(2)}`,
    );
    this.logger.log('');

    // Funding Metrics
    this.logger.log('💸 FUNDING METRICS');
    this.logger.log(
      `   💰 Total Funding Captured: $${metrics.totalFundingCaptured.toFixed(2)}`,
    );
    this.logger.log(
      `   💸 Total Funding Paid: $${metrics.totalFundingPaid.toFixed(2)}`,
    );
    this.logger.log(
      `   📊 Net Funding Captured: $${metrics.netFundingCaptured.toFixed(2)}`,
    );
    this.logger.log('');

    // Position Metrics
    this.logger.log('📈 POSITION METRICS');
    this.logger.log(`   📍 Total Positions: ${metrics.totalPositions}`);
    this.logger.log(
      `   💵 Total Position Value: $${metrics.totalPositionValue.toFixed(2)}`,
    );
    this.logger.log(
      `   📊 Unrealized P&L: $${metrics.totalUnrealizedPnl.toFixed(2)}`,
    );
    this.logger.log(
      `   ✅ Realized P&L: $${metrics.totalRealizedPnl.toFixed(2)}`,
    );
    this.logger.log('');

    // Trading Metrics
    this.logger.log('🔄 TRADING METRICS');
    this.logger.log(`   📝 Orders Placed: ${metrics.totalOrdersPlaced}`);
    this.logger.log(`   ✅ Orders Filled: ${metrics.totalOrdersFilled}`);
    this.logger.log(`   ❌ Orders Failed: ${metrics.totalOrdersFailed}`);
    this.logger.log(
      `   🔍 Arbitrage Opportunities Found: ${metrics.arbitrageOpportunitiesFound}`,
    );
    this.logger.log(
      `   ⚡ Arbitrage Opportunities Executed: ${metrics.arbitrageOpportunitiesExecuted}`,
    );
    this.logger.log('');

    // Capital Efficiency
    this.logger.log('💼 CAPITAL EFFICIENCY');
    this.logger.log(
      `   💰 Capital Deployed: $${metrics.capitalDeployed.toFixed(2)}`,
    );
    this.logger.log(
      `   📊 Capital Utilization: ${metrics.capitalUtilization.toFixed(2)}%`,
    );
    this.logger.log(
      `   📏 Average Position Size: $${metrics.averagePositionSize.toFixed(2)}`,
    );
    this.logger.log('');

    // Risk Metrics
    this.logger.log('⚠️  RISK METRICS');
    this.logger.log(`   📉 Max Drawdown: ${metrics.maxDrawdown.toFixed(2)}%`);
    this.logger.log('');

    // Break-Even Analysis
    const breakEvenHours = this.calculateBreakEvenHours(
      metrics.capitalDeployed,
    );
    this.logger.log('⏱️  BREAK-EVEN ANALYSIS');
    this.logger.log(
      `   💸 Total Trading Costs: $${this.totalTradingCosts.toFixed(4)}`,
    );
    this.logger.log(
      `   ⏱️  Time to Break-Even: ${this.formatBreakEvenTime(breakEvenHours)}`,
    );
    if (
      breakEvenHours !== null &&
      isFinite(breakEvenHours) &&
      breakEvenHours > 0
    ) {
      const hoursElapsed = metrics.runtimeHours;
      const progressPct = Math.min(100, (hoursElapsed / breakEvenHours) * 100);
      this.logger.log(
        `   📊 Progress: ${progressPct.toFixed(1)}% (${hoursElapsed.toFixed(1)}h / ${breakEvenHours.toFixed(1)}h)`,
      );
    }
    this.logger.log('');

    // Real Funding Data (from exchange APIs)
    if (this.realFundingSummary) {
      this.logger.log('📡 REAL FUNDING (from Exchange APIs)');
      const sign = this.realFundingSummary.netFunding >= 0 ? '+' : '';
      this.logger.log(
        `   💰 Net Funding (30d): ${sign}$${this.realFundingSummary.netFunding.toFixed(4)}`,
      );
      this.logger.log(
        `   📅 Daily Average: ${sign}$${this.realFundingSummary.dailyAverage.toFixed(4)}`,
      );
      this.logger.log(
        `   📈 Annualized: ${sign}$${this.realFundingSummary.annualized.toFixed(2)}`,
      );
      this.logger.log(
        `   ✅ Real APY: ${this.realFundingSummary.realAPY.toFixed(2)}%`,
      );
      this.logger.log('');

      // Win Rate Metrics
      const wr = this.realFundingSummary.winRateMetrics;
      if (wr.totalPayments > 0) {
        const wrEmoji =
          wr.winRate >= 70
            ? '🔥'
            : wr.winRate >= 55
              ? '✅'
              : wr.winRate >= 45
                ? '⚠️'
                : '❌';
        const pfStatus =
          wr.profitFactor >= 2.0
            ? '🔥'
            : wr.profitFactor >= 1.5
              ? '✅'
              : wr.profitFactor >= 1.0
                ? '⚠️'
                : '❌';

        this.logger.log('📊 WIN RATE ANALYSIS');
        this.logger.log(
          `   ${wrEmoji} Win Rate: ${wr.winRate.toFixed(1)}% (${wr.winningPayments}W / ${wr.losingPayments}L)`,
        );
        this.logger.log(
          `   ${pfStatus} Profit Factor: ${wr.profitFactor === Infinity ? '∞' : wr.profitFactor.toFixed(2)}`,
        );
        this.logger.log(
          `   💵 Avg Win: +$${wr.averageWin.toFixed(4)} | Avg Loss: -$${wr.averageLoss.toFixed(4)}`,
        );
        this.logger.log(
          `   🎯 Win/Loss Ratio: ${wr.winLossRatio === Infinity ? '∞' : wr.winLossRatio.toFixed(2)}x`,
        );
        this.logger.log(
          `   📊 Expectancy: ${wr.expectancy >= 0 ? '+' : ''}$${wr.expectancy.toFixed(4)}/payment`,
        );
        this.logger.log('');
      }
    }

    // Exchange-specific metrics
    this.logger.log('🏦 EXCHANGE-SPECIFIC METRICS');
    for (const [
      exchange,
      exchangeMetrics,
    ] of metrics.exchangeMetrics.entries()) {
      if (
        exchangeMetrics.positionsCount > 0 ||
        exchangeMetrics.ordersExecuted > 0
      ) {
        this.logger.log(`   ${exchange}:`);
        this.logger.log(
          `      💰 Net Funding: $${exchangeMetrics.netFundingCaptured.toFixed(2)}`,
        );
        this.logger.log(
          `      📍 Positions: ${exchangeMetrics.positionsCount}`,
        );
        this.logger.log(
          `      💵 Position Value: $${exchangeMetrics.totalPositionValue.toFixed(2)}`,
        );
        this.logger.log(
          `      📊 Unrealized P&L: $${exchangeMetrics.totalUnrealizedPnl.toFixed(2)}`,
        );
        this.logger.log(
          `      ✅ Orders Filled: ${exchangeMetrics.ordersFilled}`,
        );
      }
    }
    this.logger.log('');
    this.logger.log(
      '📊 ═══════════════════════════════════════════════════════════',
    );
    this.logger.log('');
  }

  /**
   * Log compact performance summary (one line)
   */
  logCompactSummary(capitalDeployed: number = 0): void {
    const metrics = this.getPerformanceMetrics(capitalDeployed);
    const runtimeStr =
      metrics.runtimeDays >= 1
        ? `${metrics.runtimeDays.toFixed(1)}d`
        : `${metrics.runtimeHours.toFixed(1)}h`;

    const breakEvenHours = this.calculateBreakEvenHours(
      metrics.capitalDeployed,
    );
    const breakEvenStr = this.formatBreakEvenTime(breakEvenHours);

    this.logger.log(
      `📊 [${runtimeStr}] ` +
        `Est APY: ${metrics.estimatedAPY.toFixed(2)}% | ` +
        `Real APY: ${metrics.realizedAPY.toFixed(2)}% | ` +
        `Net Funding: $${metrics.netFundingCaptured.toFixed(2)} | ` +
        `Positions: ${metrics.totalPositions} | ` +
        `Break-Even: ${breakEvenStr}`,
    );
  }

  /**
   * Get runtime in days
   */
  private getRuntimeDays(): number {
    const now = new Date();
    const runtimeHours =
      (now.getTime() - this.startTime.getTime()) / (1000 * 60 * 60);
    return runtimeHours / 24;
  }

  /**
   * Reset all metrics (useful for testing or restart)
   */
  reset(): void {
    this.startTime = new Date();
    this.exchangeMetrics.clear();
    this.fundingSnapshots = [];
    this.realizedFundingPayments = [];
    this.totalRealizedPnl = 0;
    this.maxDrawdown = 0;
    this.peakValue = 0;
    this.totalOrdersPlaced = 0;
    this.totalOrdersFilled = 0;
    this.totalOrdersFailed = 0;
    this.totalTradeVolume = 0;
    this.arbitrageOpportunitiesFound = 0;
    this.arbitrageOpportunitiesExecuted = 0;
    this.realFundingSummary = null;
    this.totalTradingCosts = 0;

    // Re-initialize exchange metrics
    for (const exchangeType of [
      ExchangeType.ASTER,
      ExchangeType.LIGHTER,
      ExchangeType.HYPERLIQUID,
    ]) {
      this.exchangeMetrics.set(exchangeType, {
        exchangeType,
        totalFundingCaptured: 0,
        totalFundingPaid: 0,
        netFundingCaptured: 0,
        positionsCount: 0,
        totalPositionValue: 0,
        totalUnrealizedPnl: 0,
        ordersExecuted: 0,
        ordersFilled: 0,
        ordersFailed: 0,
        lastUpdateTime: new Date(),
      });
    }
  }
}
