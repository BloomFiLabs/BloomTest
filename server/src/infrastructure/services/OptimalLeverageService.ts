import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import {
  IOptimalLeverageService,
  LeverageRecommendation,
  LeverageFactors,
  VolatilityMetrics,
  LiquidationRisk,
  LiquidityAssessment,
  LeverageAlert,
  LeverageConfig,
} from '../../domain/ports/IOptimalLeverageService';
import { RealFundingPaymentsService } from './RealFundingPaymentsService';
import type { IHistoricalFundingRateService } from '../../domain/ports/IHistoricalFundingRateService';

/**
 * Price candle data
 */
interface PriceCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Cached volatility data
 */
interface CachedVolatility {
  metrics: VolatilityMetrics;
  expiresAt: number;
}

/**
 * OptimalLeverageService - Calculates optimal leverage per-asset based on multiple factors
 * 
 * Factors considered:
 * - Price volatility (daily/hourly)
 * - Liquidation risk (distance to liquidation)
 * - Liquidity (open interest, slippage)
 * - Historical win rate per symbol
 */
@Injectable()
export class OptimalLeverageService implements IOptimalLeverageService {
  private readonly logger = new Logger(OptimalLeverageService.name);
  
  // Configuration
  private readonly config: LeverageConfig;
  
  // Caches
  private volatilityCache = new Map<string, CachedVolatility>();
  private readonly VOLATILITY_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
  
  // Open interest cache
  private openInterestCache = new Map<string, { oi: number; expiresAt: number }>();
  private readonly OI_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly fundingPaymentsService?: RealFundingPaymentsService,
    @Optional() @Inject('IHistoricalFundingRateService') 
    private readonly historicalService?: IHistoricalFundingRateService,
  ) {
    // Initialize configuration from env or defaults
    this.config = {
      minLeverage: parseFloat(this.configService.get('LEVERAGE_MIN') || '1'),
      maxLeverage: parseFloat(this.configService.get('LEVERAGE_MAX') || '10'),
      volatilityLookbackHours: parseInt(this.configService.get('LEVERAGE_LOOKBACK_HOURS') || '24'),
      leverageOverrides: new Map(),
      volatilityWeight: 0.35,
      liquidationWeight: 0.25,
      liquidityWeight: 0.25,
      winRateWeight: 0.15,
    };

    // Parse leverage overrides from env (format: "BTC:5,ETH:3,DOGE:2")
    const overridesStr = this.configService.get('LEVERAGE_OVERRIDES') || '';
    if (overridesStr) {
      for (const pair of overridesStr.split(',')) {
        const [symbol, leverage] = pair.split(':');
        if (symbol && leverage) {
          this.config.leverageOverrides.set(symbol.trim().toUpperCase(), parseFloat(leverage));
        }
      }
    }

    this.logger.log(
      `OptimalLeverageService initialized: min=${this.config.minLeverage}x, ` +
      `max=${this.config.maxLeverage}x, lookback=${this.config.volatilityLookbackHours}h`
    );
  }

  /**
   * Calculate optimal leverage for a specific asset
   */
  async calculateOptimalLeverage(
    symbol: string,
    exchange: ExchangeType,
    positionSizeUsd: number = 100,
  ): Promise<LeverageRecommendation> {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Check for manual override first
    const override = this.config.leverageOverrides.get(normalizedSymbol);
    if (override !== undefined) {
      return {
        symbol: normalizedSymbol,
        exchange,
        currentLeverage: override,
        optimalLeverage: override,
        maxSafeLeverage: override,
        factors: {
          volatilityScore: 1,
          liquidationRiskScore: 1,
          liquidityScore: 1,
          winRateScore: 1,
        },
        compositeScore: 1,
        shouldAdjust: false,
        reason: `Manual override: ${override}x`,
        timestamp: new Date(),
      };
    }

    // Calculate all factor scores
    const [volatilityMetrics, liquidityAssessment, winRateScore] = await Promise.all([
      this.getAssetVolatility(symbol, exchange),
      this.getLiquidityAssessment(symbol, exchange, positionSizeUsd),
      this.getWinRateAdjustedLeverage(normalizedSymbol),
    ]);

    // Calculate factor scores
    const factors = this.calculateFactorScores(
      volatilityMetrics,
      liquidityAssessment,
      winRateScore,
    );

    // Calculate composite score
    const compositeScore = this.calculateCompositeScore(factors);

    // Calculate optimal leverage
    let optimalLeverage = this.config.minLeverage + 
      (this.config.maxLeverage - this.config.minLeverage) * compositeScore;

    // Apply safety constraints
    optimalLeverage = this.applySafetyConstraints(
      optimalLeverage,
      volatilityMetrics,
      winRateScore,
    );

    // Round to 1 decimal place
    optimalLeverage = Math.round(optimalLeverage * 10) / 10;

    // Calculate max safe leverage (more conservative)
    const maxSafeLeverage = Math.min(
      optimalLeverage * 1.5,
      this.config.maxLeverage,
    );

    const reason = this.generateReason(factors, optimalLeverage, volatilityMetrics);

    return {
      symbol: normalizedSymbol,
      exchange,
      currentLeverage: this.config.minLeverage, // Will be updated by caller
      optimalLeverage,
      maxSafeLeverage,
      factors,
      compositeScore,
      shouldAdjust: false, // Will be determined by comparing with current
      reason,
      timestamp: new Date(),
    };
  }

  /**
   * Get volatility metrics for an asset
   */
  async getAssetVolatility(
    symbol: string,
    exchange: ExchangeType,
    lookbackHours: number = this.config.volatilityLookbackHours,
  ): Promise<VolatilityMetrics> {
    const cacheKey = `${symbol}:${exchange}:${lookbackHours}`;
    const cached = this.volatilityCache.get(cacheKey);
    
    if (cached && cached.expiresAt > Date.now()) {
      return cached.metrics;
    }

    try {
      // Fetch price history
      const candles = await this.fetchPriceHistory(symbol, exchange, lookbackHours);
      
      if (candles.length < 2) {
        return this.getDefaultVolatilityMetrics(symbol, exchange, lookbackHours);
      }

      // Calculate returns
      const returns: number[] = [];
      for (let i = 1; i < candles.length; i++) {
        const ret = (candles[i].close - candles[i - 1].close) / candles[i - 1].close;
        returns.push(ret);
      }

      // Calculate hourly volatility (standard deviation of returns)
      const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
      const hourlyVolatility = Math.sqrt(variance);

      // Annualize to daily (assume hourly candles, 24 hours per day)
      const dailyVolatility = hourlyVolatility * Math.sqrt(24);

      // Calculate max drawdown in period
      let peak = candles[0].high;
      let maxDrawdown = 0;
      for (const candle of candles) {
        if (candle.high > peak) {
          peak = candle.high;
        }
        const drawdown = (peak - candle.low) / peak;
        if (drawdown > maxDrawdown) {
          maxDrawdown = drawdown;
        }
      }

      // Calculate ATR (Average True Range)
      let atrSum = 0;
      for (let i = 1; i < candles.length; i++) {
        const tr = Math.max(
          candles[i].high - candles[i].low,
          Math.abs(candles[i].high - candles[i - 1].close),
          Math.abs(candles[i].low - candles[i - 1].close),
        );
        atrSum += tr;
      }
      const atr = atrSum / (candles.length - 1);

      const metrics: VolatilityMetrics = {
        symbol: this.normalizeSymbol(symbol),
        exchange,
        dailyVolatility,
        hourlyVolatility,
        maxDrawdown24h: maxDrawdown,
        atr,
        lookbackHours,
        dataPoints: candles.length,
        timestamp: new Date(),
      };

      // Cache the result
      this.volatilityCache.set(cacheKey, {
        metrics,
        expiresAt: Date.now() + this.VOLATILITY_CACHE_TTL_MS,
      });

      return metrics;
    } catch (error: any) {
      this.logger.warn(`Failed to get volatility for ${symbol}: ${error.message}`);
      return this.getDefaultVolatilityMetrics(symbol, exchange, lookbackHours);
    }
  }

  /**
   * Assess liquidation risk for a position
   */
  getLiquidationRisk(
    symbol: string,
    exchange: ExchangeType,
    leverage: number,
    entryPrice: number,
    currentPrice: number,
    side: 'LONG' | 'SHORT',
  ): LiquidationRisk {
    // Calculate liquidation price
    // For LONG: liqPrice = entryPrice * (1 - 1/leverage + maintenanceMargin)
    // For SHORT: liqPrice = entryPrice * (1 + 1/leverage - maintenanceMargin)
    const maintenanceMargin = 0.005; // 0.5% typical maintenance margin
    
    let liquidationPrice: number;
    if (side === 'LONG') {
      liquidationPrice = entryPrice * (1 - (1 / leverage) + maintenanceMargin);
    } else {
      liquidationPrice = entryPrice * (1 + (1 / leverage) - maintenanceMargin);
    }

    // Calculate distance to liquidation
    let distanceToLiquidation: number;
    if (side === 'LONG') {
      distanceToLiquidation = (currentPrice - liquidationPrice) / currentPrice;
    } else {
      distanceToLiquidation = (liquidationPrice - currentPrice) / currentPrice;
    }

    // Determine risk level
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    const isAtRisk = distanceToLiquidation < 0.10; // Less than 10% distance
    
    if (distanceToLiquidation < 0.05) {
      riskLevel = 'CRITICAL';
    } else if (distanceToLiquidation < 0.10) {
      riskLevel = 'HIGH';
    } else if (distanceToLiquidation < 0.20) {
      riskLevel = 'MEDIUM';
    } else {
      riskLevel = 'LOW';
    }

    return {
      symbol: this.normalizeSymbol(symbol),
      exchange,
      currentPrice,
      entryPrice,
      liquidationPrice,
      distanceToLiquidation,
      leverage,
      isAtRisk,
      riskLevel,
    };
  }

  /**
   * Assess liquidity for position sizing
   */
  async getLiquidityAssessment(
    symbol: string,
    exchange: ExchangeType,
    positionSizeUsd: number,
  ): Promise<LiquidityAssessment> {
    const openInterest = await this.getOpenInterest(symbol, exchange);
    
    const positionAsPercentOfOI = openInterest > 0 
      ? (positionSizeUsd / openInterest) * 100 
      : 100;

    // Estimate slippage using square root model
    // Slippage increases with sqrt(position / OI)
    const estimatedSlippage = openInterest > 0
      ? Math.min(Math.sqrt(positionSizeUsd / openInterest) * 0.01, 0.02)
      : 0.02; // Default 2% if no OI data

    // Max recommended size to keep slippage < 0.5%
    // Solve: sqrt(size / OI) * 0.01 = 0.005
    // size = (0.5)^2 * OI = 0.25 * OI
    const maxRecommendedSize = openInterest > 0 ? openInterest * 0.05 : positionSizeUsd;

    // Liquidity score: higher is better
    // Score = 1 if position < 1% of OI, decreases as position increases
    let liquidityScore: number;
    if (openInterest <= 0) {
      liquidityScore = 0.5; // Unknown liquidity
    } else if (positionAsPercentOfOI < 1) {
      liquidityScore = 1.0;
    } else if (positionAsPercentOfOI < 5) {
      liquidityScore = 1 - (positionAsPercentOfOI - 1) / 8; // Linear decrease
    } else {
      liquidityScore = Math.max(0.2, 0.5 - (positionAsPercentOfOI - 5) / 20);
    }

    return {
      symbol: this.normalizeSymbol(symbol),
      exchange,
      openInterest,
      positionSizeUsd,
      positionAsPercentOfOI,
      estimatedSlippage,
      maxRecommendedSize,
      liquidityScore,
    };
  }

  /**
   * Get win rate adjusted leverage factor
   */
  async getWinRateAdjustedLeverage(symbol: string): Promise<number> {
    if (!this.fundingPaymentsService) {
      return 0.5; // Default score if no funding service
    }

    try {
      const summary = await this.fundingPaymentsService.getCombinedSummary(30, 0);
      
      // Find symbol in top or bottom performers
      const allSymbols = [...summary.topSymbols, ...summary.bottomSymbols];
      const symbolData = allSymbols.find(s => 
        this.normalizeSymbol(s.symbol) === this.normalizeSymbol(symbol)
      );

      if (symbolData) {
        // Convert win rate to score (70%+ = 1.0, 50% = 0.5, 30% = 0)
        return Math.min(symbolData.winRate / 70, 1);
      }

      // Use overall win rate if symbol not found
      const overallWinRate = summary.winRateMetrics.winRate;
      return Math.min(overallWinRate / 70, 1);
    } catch (error: any) {
      this.logger.debug(`Failed to get win rate for ${symbol}: ${error.message}`);
      return 0.5;
    }
  }

  /**
   * Monitor all positions and generate alerts
   */
  async monitorAndAlert(): Promise<LeverageAlert[]> {
    const alerts: LeverageAlert[] = [];
    
    // This would typically iterate over active positions
    // For now, return empty - will be integrated with position manager
    
    return alerts;
  }

  /**
   * Get leverage recommendation for all active symbols
   */
  async getAllRecommendations(): Promise<LeverageRecommendation[]> {
    const recommendations: LeverageRecommendation[] = [];
    
    // Get common trading symbols
    const symbols = ['BTC', 'ETH', 'SOL', 'DOGE', 'PEPE', 'WIF', 'BONK'];
    const exchanges = [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER, ExchangeType.ASTER];

    for (const symbol of symbols) {
      for (const exchange of exchanges) {
        try {
          const rec = await this.calculateOptimalLeverage(symbol, exchange);
          recommendations.push(rec);
        } catch (error: any) {
          this.logger.debug(`Failed to get recommendation for ${symbol} on ${exchange}`);
        }
      }
    }

    return recommendations;
  }

  /**
   * Check if leverage adjustment is needed for a position
   */
  async shouldAdjustLeverage(
    symbol: string,
    exchange: ExchangeType,
    currentLeverage: number,
  ): Promise<{ shouldAdjust: boolean; reason: string; recommendedLeverage: number }> {
    const recommendation = await this.calculateOptimalLeverage(symbol, exchange);
    
    const difference = Math.abs(currentLeverage - recommendation.optimalLeverage);
    const percentDiff = difference / currentLeverage;

    // Adjust if difference is > 20% or leverage is significantly off
    if (percentDiff > 0.2 || difference > 2) {
      return {
        shouldAdjust: true,
        reason: `Current ${currentLeverage}x vs optimal ${recommendation.optimalLeverage}x (${(percentDiff * 100).toFixed(0)}% diff)`,
        recommendedLeverage: recommendation.optimalLeverage,
      };
    }

    return {
      shouldAdjust: false,
      reason: `Current leverage ${currentLeverage}x is within acceptable range`,
      recommendedLeverage: recommendation.optimalLeverage,
    };
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Normalize symbol (remove USDT, PERP, etc.)
   */
  private normalizeSymbol(symbol: string): string {
    return symbol
      .replace('USDT', '')
      .replace('USDC', '')
      .replace('-PERP', '')
      .replace('PERP', '')
      .toUpperCase();
  }

  /**
   * Calculate factor scores
   */
  private calculateFactorScores(
    volatility: VolatilityMetrics,
    liquidity: LiquidityAssessment,
    winRateScore: number,
  ): LeverageFactors {
    // Volatility score: lower volatility = higher score
    // 10% daily vol = 0, 0% = 1
    const volatilityScore = Math.max(0, 1 - volatility.dailyVolatility / 0.10);

    // Liquidation risk score: assume we want at least 20% distance
    // This is computed dynamically based on leverage in actual positions
    // For new positions, we use 1.0 as placeholder
    const liquidationRiskScore = 1.0;

    return {
      volatilityScore,
      liquidationRiskScore,
      liquidityScore: liquidity.liquidityScore,
      winRateScore,
    };
  }

  /**
   * Calculate composite score from factors
   */
  private calculateCompositeScore(factors: LeverageFactors): number {
    return (
      factors.volatilityScore * this.config.volatilityWeight +
      factors.liquidationRiskScore * this.config.liquidationWeight +
      factors.liquidityScore * this.config.liquidityWeight +
      factors.winRateScore * this.config.winRateWeight
    );
  }

  /**
   * Apply safety constraints to leverage
   */
  private applySafetyConstraints(
    leverage: number,
    volatility: VolatilityMetrics,
    winRateScore: number,
  ): number {
    let constrained = leverage;

    // Cap at 5x for high volatility assets (> 10% daily vol)
    if (volatility.dailyVolatility > 0.10) {
      constrained = Math.min(constrained, 5);
    }

    // Cap at 3x for very high volatility (> 15% daily vol)
    if (volatility.dailyVolatility > 0.15) {
      constrained = Math.min(constrained, 3);
    }

    // Cap at 3x for low win rate assets (< 50%)
    if (winRateScore < 0.5 / 0.7) { // Win rate < 50%
      constrained = Math.min(constrained, 3);
    }

    // Ensure within bounds
    constrained = Math.max(this.config.minLeverage, constrained);
    constrained = Math.min(this.config.maxLeverage, constrained);

    return constrained;
  }

  /**
   * Generate human-readable reason for leverage recommendation
   */
  private generateReason(
    factors: LeverageFactors,
    optimalLeverage: number,
    volatility: VolatilityMetrics,
  ): string {
    const parts: string[] = [];

    if (factors.volatilityScore < 0.5) {
      parts.push(`high volatility (${(volatility.dailyVolatility * 100).toFixed(1)}% daily)`);
    }

    if (factors.liquidityScore < 0.5) {
      parts.push('low liquidity');
    }

    if (factors.winRateScore < 0.5) {
      parts.push('low win rate');
    }

    if (parts.length === 0) {
      return `Optimal leverage: ${optimalLeverage}x based on favorable conditions`;
    }

    return `Leverage capped at ${optimalLeverage}x due to: ${parts.join(', ')}`;
  }

  /**
   * Get default volatility metrics when data unavailable
   */
  private getDefaultVolatilityMetrics(
    symbol: string,
    exchange: ExchangeType,
    lookbackHours: number,
  ): VolatilityMetrics {
    return {
      symbol: this.normalizeSymbol(symbol),
      exchange,
      dailyVolatility: 0.05, // 5% default
      hourlyVolatility: 0.01,
      maxDrawdown24h: 0.10,
      atr: 0,
      lookbackHours,
      dataPoints: 0,
      timestamp: new Date(),
    };
  }

  /**
   * Fetch price history from exchange
   */
  private async fetchPriceHistory(
    symbol: string,
    exchange: ExchangeType,
    hours: number,
  ): Promise<PriceCandle[]> {
    const normalizedSymbol = this.normalizeSymbol(symbol);

    try {
      if (exchange === ExchangeType.HYPERLIQUID) {
        return await this.fetchHyperliquidCandles(normalizedSymbol, hours);
      }
      
      // For other exchanges, try Hyperliquid as fallback (same assets)
      return await this.fetchHyperliquidCandles(normalizedSymbol, hours);
    } catch (error: any) {
      this.logger.debug(`Failed to fetch candles for ${symbol}: ${error.message}`);
      return [];
    }
  }

  /**
   * Fetch candles from Hyperliquid
   */
  private async fetchHyperliquidCandles(symbol: string, hours: number): Promise<PriceCandle[]> {
    const endTime = Date.now();
    const startTime = endTime - hours * 60 * 60 * 1000;

    try {
      const response = await axios.post('https://api.hyperliquid.xyz/info', {
        type: 'candleSnapshot',
        req: {
          coin: symbol,
          interval: '1h',
          startTime,
          endTime,
        },
      }, { timeout: 10000 });

      const data = response.data;
      if (!Array.isArray(data)) return [];

      return data.map((candle: any) => ({
        timestamp: candle.t,
        open: parseFloat(candle.o),
        high: parseFloat(candle.h),
        low: parseFloat(candle.l),
        close: parseFloat(candle.c),
        volume: parseFloat(candle.v),
      }));
    } catch (error: any) {
      this.logger.debug(`Hyperliquid candles error: ${error.message}`);
      return [];
    }
  }

  /**
   * Get open interest for a symbol
   */
  private async getOpenInterest(symbol: string, exchange: ExchangeType): Promise<number> {
    const cacheKey = `${symbol}:${exchange}`;
    const cached = this.openInterestCache.get(cacheKey);
    
    if (cached && cached.expiresAt > Date.now()) {
      return cached.oi;
    }

    try {
      let oi = 0;
      const normalizedSymbol = this.normalizeSymbol(symbol);

      if (exchange === ExchangeType.HYPERLIQUID) {
        const response = await axios.post('https://api.hyperliquid.xyz/info', {
          type: 'metaAndAssetCtxs',
        }, { timeout: 10000 });

        const data = response.data;
        if (data && data.meta && data.assetCtxs) {
          const assetIndex = data.meta.universe.findIndex(
            (u: any) => u.name.toUpperCase() === normalizedSymbol
          );
          if (assetIndex >= 0 && data.assetCtxs[assetIndex]) {
            oi = parseFloat(data.assetCtxs[assetIndex].openInterest || '0');
          }
        }
      }

      // Cache the result
      this.openInterestCache.set(cacheKey, {
        oi,
        expiresAt: Date.now() + this.OI_CACHE_TTL_MS,
      });

      return oi;
    } catch (error: any) {
      this.logger.debug(`Failed to get OI for ${symbol}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Log leverage recommendation summary
   */
  async logRecommendationSummary(): Promise<void> {
    const recommendations = await this.getAllRecommendations();
    
    this.logger.log('');
    this.logger.log('═'.repeat(70));
    this.logger.log('  📊 OPTIMAL LEVERAGE RECOMMENDATIONS');
    this.logger.log('═'.repeat(70));
    
    // Group by symbol
    const bySymbol = new Map<string, LeverageRecommendation[]>();
    for (const rec of recommendations) {
      const existing = bySymbol.get(rec.symbol) || [];
      existing.push(rec);
      bySymbol.set(rec.symbol, existing);
    }

    for (const [symbol, recs] of bySymbol) {
      const avgLeverage = recs.reduce((sum, r) => sum + r.optimalLeverage, 0) / recs.length;
      const avgVolScore = recs.reduce((sum, r) => sum + r.factors.volatilityScore, 0) / recs.length;
      
      this.logger.log(`  ${symbol}:`);
      this.logger.log(`     Optimal Leverage: ${avgLeverage.toFixed(1)}x`);
      this.logger.log(`     Volatility Score: ${(avgVolScore * 100).toFixed(0)}%`);
    }

    this.logger.log('');
    this.logger.log('═'.repeat(70));
  }
}


