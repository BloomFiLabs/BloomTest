import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { PerpPosition } from '../../domain/entities/PerpPosition';
import { FundingRateComparison, ArbitrageOpportunity } from '../../domain/services/FundingRateAggregator';
import { ArbitrageExecutionResult } from '../../domain/services/FundingArbitrageStrategy';
import { IPerpKeeperPerformanceLogger } from '../../domain/ports/IPerpKeeperPerformanceLogger';

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
export class PerpKeeperPerformanceLogger implements IPerpKeeperPerformanceLogger {
  private readonly logger = new Logger(PerpKeeperPerformanceLogger.name);
  
  // Performance tracking
  private startTime: Date = new Date();
  private exchangeMetrics: Map<ExchangeType, ExchangePerformanceMetrics> = new Map();
  private fundingSnapshots: FundingRateSnapshot[] = [];
  private realizedFundingPayments: Array<{ amount: number; timestamp: Date; exchange: ExchangeType }> = [];
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
  
  constructor() {
    // Initialize exchange metrics
    for (const exchangeType of [ExchangeType.ASTER, ExchangeType.LIGHTER, ExchangeType.HYPERLIQUID]) {
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
    
    metrics.netFundingCaptured = metrics.totalFundingCaptured - metrics.totalFundingPaid;
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
    fundingRates: Array<{ symbol: string; exchange: ExchangeType; fundingRate: number }>,
  ): void {
    const metrics = this.exchangeMetrics.get(exchange);
    if (!metrics) return;

    // Filter out positions with very small sizes (likely rounding errors or stale data)
    const validPositions = positions.filter(p => Math.abs(p.size) > 0.0001);
    
    metrics.positionsCount = validPositions.length;
    metrics.totalPositionValue = validPositions.reduce((sum, pos) => sum + pos.getPositionValue(), 0);
    metrics.totalUnrealizedPnl = validPositions.reduce((sum, pos) => sum + pos.unrealizedPnl, 0);
    metrics.lastUpdateTime = new Date();

    // Remove old snapshots for positions being updated on this exchange
    // If positions is empty (all closed), remove ALL snapshots for this exchange
    // Otherwise, remove snapshots only for symbols that are being updated
    if (validPositions.length === 0) {
      // All positions closed - remove all snapshots for this exchange
      this.fundingSnapshots = this.fundingSnapshots.filter((s) => s.exchange !== exchange);
    } else {
      // Remove snapshots for symbols that are being updated (to prevent duplicates)
      const symbolsToUpdate = new Set(validPositions.map(p => p.symbol));
      this.fundingSnapshots = this.fundingSnapshots.filter(
        (s) => !(symbolsToUpdate.has(s.symbol) && s.exchange === exchange)
      );
    }

    // Create funding rate snapshots for APY estimation
    for (const position of validPositions) {
      const fundingRate = fundingRates.find(
        (fr) => fr.symbol === position.symbol && fr.exchange === exchange
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
    this.fundingSnapshots = this.fundingSnapshots.filter((s) => s.timestamp > oneDayAgo);
    
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
  recordOrderExecution(exchange: ExchangeType, filled: boolean, failed: boolean): void {
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
    const snapshotsBySymbol = new Map<string, { long?: FundingRateSnapshot; short?: FundingRateSnapshot }>();
    
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
        const pairValue = (pair.long.positionValue + pair.short.positionValue) / 2;
        totalValue += pairValue;
        weightedFundingReturn += netFundingReturn * pairValue;
        
        this.logger.debug(
          `Arbitrage pair ${symbol}: LONG rate=${(longRate * 100).toFixed(4)}%, ` +
          `SHORT rate=${(shortRate * 100).toFixed(4)}%, ` +
          `Net spread=${(netFundingReturn * 100).toFixed(4)}%`
        );
      } else {
        // Single position (not part of arbitrage pair) - calculate individually
        // WARNING: This should be part of an arbitrage pair for proper delta-neutral strategy
        const snapshot = pair.long || pair.short!;
        const value = snapshot.positionValue;
        totalValue += value;
        
        // For LONG positions: negative funding rate = we receive funding (positive return)
        // For SHORT positions: positive funding rate = we receive funding (positive return)
        const fundingReturn = snapshot.positionSide === 'LONG' 
          ? -snapshot.fundingRate  // LONG: negative rate = positive return
          : snapshot.fundingRate;   // SHORT: positive rate = positive return
        
        weightedFundingReturn += fundingReturn * value;
        
        this.logger.warn(
          `⚠️ Single position ${symbol} (${snapshot.positionSide}) detected - should be part of arbitrage pair. ` +
          `Rate=${(snapshot.fundingRate * 100).toFixed(4)}%, ` +
          `Return=${(fundingReturn * 100).toFixed(4)}%. ` +
          `This may indicate one leg failed to open or was closed.`
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

    const arbitragePairsCount = Array.from(snapshotsBySymbol.values()).filter(p => p.long && p.short).length;
    const singlePositionsCount = Array.from(snapshotsBySymbol.values()).filter(p => !(p.long && p.short)).length;
    
    this.logger.debug(
      `Estimated APY calculation: ` +
      `${arbitragePairsCount} arbitrage pair(s), ${singlePositionsCount} single position(s), ` +
      `avgFundingReturn=${(avgFundingReturn * 100).toFixed(4)}%, ` +
      `dailyRate=${(dailyRate * 100).toFixed(4)}%, ` +
      `annualizedAPY=${annualizedAPY.toFixed(2)}%`
    );

    return annualizedAPY;
  }

  /**
   * Calculate realized APY based on actual funding payments
   */
  calculateRealizedAPY(capitalDeployed: number): number {
    if (capitalDeployed === 0 || this.realizedFundingPayments.length === 0) return 0;

    const totalFunding = this.realizedFundingPayments.reduce((sum, p) => sum + p.amount, 0);
    const runtimeDays = this.getRuntimeDays();

    if (runtimeDays === 0) return 0;

    // Calculate daily return
    const dailyReturn = totalFunding / capitalDeployed / runtimeDays;
    
    // Annualize
    const annualizedAPY = dailyReturn * 365 * 100; // Convert to percentage

    return annualizedAPY;
  }

  /**
   * Get comprehensive performance metrics
   */
  getPerformanceMetrics(capitalDeployed: number = 0): StrategyPerformanceMetrics {
    const now = new Date();
    const runtimeHours = (now.getTime() - this.startTime.getTime()) / (1000 * 60 * 60);
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
    const realizedAPY = this.calculateRealizedAPY(capitalDeployed || totalPositionValue);

    // Calculate daily returns
    const estimatedDailyReturn = runtimeDays > 0 
      ? (estimatedAPY / 100 / 365) * (capitalDeployed || totalPositionValue)
      : 0;
    
    const realizedDailyReturn = runtimeDays > 0
      ? netFundingCaptured / runtimeDays
      : 0;

    // Calculate capital utilization
    const capitalUtilization = capitalDeployed > 0
      ? (totalPositionValue / capitalDeployed) * 100
      : 0;

    // Calculate average position size
    const averagePositionSize = totalPositions > 0
      ? totalPositionValue / totalPositions
      : 0;

    // Update drawdown tracking
    const currentValue = totalPositionValue + netFundingCaptured + this.totalRealizedPnl;
    if (currentValue > this.peakValue) {
      this.peakValue = currentValue;
    }
    const drawdown = this.peakValue > 0
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
   * Log comprehensive performance metrics
   */
  logPerformanceMetrics(capitalDeployed: number = 0): void {
    const metrics = this.getPerformanceMetrics(capitalDeployed);

    this.logger.log('');
    this.logger.log('📊 ═══════════════════════════════════════════════════════════');
    this.logger.log('📊 PERP KEEPER PERFORMANCE METRICS');
    this.logger.log('📊 ═══════════════════════════════════════════════════════════');
    this.logger.log('');
    
    // Runtime
    this.logger.log(`⏱️  Runtime: ${metrics.runtimeDays.toFixed(2)} days (${metrics.runtimeHours.toFixed(1)} hours)`);
    this.logger.log('');

    // APY Metrics
    this.logger.log('💰 APY METRICS');
    this.logger.log(`   📈 Estimated APY: ${metrics.estimatedAPY.toFixed(2)}%`);
    this.logger.log(`   ✅ Realized APY: ${metrics.realizedAPY.toFixed(2)}%`);
    this.logger.log(`   📅 Estimated Daily Return: $${metrics.estimatedDailyReturn.toFixed(2)}`);
    this.logger.log(`   💵 Realized Daily Return: $${metrics.realizedDailyReturn.toFixed(2)}`);
    this.logger.log('');

    // Funding Metrics
    this.logger.log('💸 FUNDING METRICS');
    this.logger.log(`   💰 Total Funding Captured: $${metrics.totalFundingCaptured.toFixed(2)}`);
    this.logger.log(`   💸 Total Funding Paid: $${metrics.totalFundingPaid.toFixed(2)}`);
    this.logger.log(`   📊 Net Funding Captured: $${metrics.netFundingCaptured.toFixed(2)}`);
    this.logger.log('');

    // Position Metrics
    this.logger.log('📈 POSITION METRICS');
    this.logger.log(`   📍 Total Positions: ${metrics.totalPositions}`);
    this.logger.log(`   💵 Total Position Value: $${metrics.totalPositionValue.toFixed(2)}`);
    this.logger.log(`   📊 Unrealized P&L: $${metrics.totalUnrealizedPnl.toFixed(2)}`);
    this.logger.log(`   ✅ Realized P&L: $${metrics.totalRealizedPnl.toFixed(2)}`);
    this.logger.log('');

    // Trading Metrics
    this.logger.log('🔄 TRADING METRICS');
    this.logger.log(`   📝 Orders Placed: ${metrics.totalOrdersPlaced}`);
    this.logger.log(`   ✅ Orders Filled: ${metrics.totalOrdersFilled}`);
    this.logger.log(`   ❌ Orders Failed: ${metrics.totalOrdersFailed}`);
    this.logger.log(`   🔍 Arbitrage Opportunities Found: ${metrics.arbitrageOpportunitiesFound}`);
    this.logger.log(`   ⚡ Arbitrage Opportunities Executed: ${metrics.arbitrageOpportunitiesExecuted}`);
    this.logger.log('');

    // Capital Efficiency
    this.logger.log('💼 CAPITAL EFFICIENCY');
    this.logger.log(`   💰 Capital Deployed: $${metrics.capitalDeployed.toFixed(2)}`);
    this.logger.log(`   📊 Capital Utilization: ${metrics.capitalUtilization.toFixed(2)}%`);
    this.logger.log(`   📏 Average Position Size: $${metrics.averagePositionSize.toFixed(2)}`);
    this.logger.log('');

    // Risk Metrics
    this.logger.log('⚠️  RISK METRICS');
    this.logger.log(`   📉 Max Drawdown: ${metrics.maxDrawdown.toFixed(2)}%`);
    this.logger.log('');

    // Exchange-specific metrics
    this.logger.log('🏦 EXCHANGE-SPECIFIC METRICS');
    for (const [exchange, exchangeMetrics] of metrics.exchangeMetrics.entries()) {
      if (exchangeMetrics.positionsCount > 0 || exchangeMetrics.ordersExecuted > 0) {
        this.logger.log(`   ${exchange}:`);
        this.logger.log(`      💰 Net Funding: $${exchangeMetrics.netFundingCaptured.toFixed(2)}`);
        this.logger.log(`      📍 Positions: ${exchangeMetrics.positionsCount}`);
        this.logger.log(`      💵 Position Value: $${exchangeMetrics.totalPositionValue.toFixed(2)}`);
        this.logger.log(`      📊 Unrealized P&L: $${exchangeMetrics.totalUnrealizedPnl.toFixed(2)}`);
        this.logger.log(`      ✅ Orders Filled: ${exchangeMetrics.ordersFilled}`);
      }
    }
    this.logger.log('');
    this.logger.log('📊 ═══════════════════════════════════════════════════════════');
    this.logger.log('');
  }

  /**
   * Log compact performance summary (one line)
   */
  logCompactSummary(capitalDeployed: number = 0): void {
    const metrics = this.getPerformanceMetrics(capitalDeployed);
    const runtimeStr = metrics.runtimeDays >= 1 
      ? `${metrics.runtimeDays.toFixed(1)}d`
      : `${metrics.runtimeHours.toFixed(1)}h`;

    this.logger.log(
      `📊 [${runtimeStr}] ` +
      `Est APY: ${metrics.estimatedAPY.toFixed(2)}% | ` +
      `Real APY: ${metrics.realizedAPY.toFixed(2)}% | ` +
      `Net Funding: $${metrics.netFundingCaptured.toFixed(2)} | ` +
      `Positions: ${metrics.totalPositions} | ` +
      `P&L: $${(metrics.totalUnrealizedPnl + metrics.totalRealizedPnl).toFixed(2)}`
    );
  }

  /**
   * Get runtime in days
   */
  private getRuntimeDays(): number {
    const now = new Date();
    const runtimeHours = (now.getTime() - this.startTime.getTime()) / (1000 * 60 * 60);
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

    // Re-initialize exchange metrics
    for (const exchangeType of [ExchangeType.ASTER, ExchangeType.LIGHTER, ExchangeType.HYPERLIQUID]) {
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
