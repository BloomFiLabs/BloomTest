import { Controller, Get, Post, Delete, Body, Param, Query, Optional } from '@nestjs/common';
import { PerpKeeperOrchestrator } from '../../domain/services/PerpKeeperOrchestrator';
import { FundingArbitrageStrategy } from '../../domain/services/FundingArbitrageStrategy';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { PerpKeeperService } from '../../application/services/PerpKeeperService';
import { PerpKeeperPerformanceLogger } from '../logging/PerpKeeperPerformanceLogger';
import { DiagnosticsService } from '../services/DiagnosticsService';
import { ExecutionLockService } from '../services/ExecutionLockService';
import { MarketQualityFilter } from '../../domain/services/MarketQualityFilter';

@Controller('keeper')
export class PerpKeeperController {
  constructor(
    private readonly orchestrator: PerpKeeperOrchestrator,
    private readonly arbitrageStrategy: FundingArbitrageStrategy,
    private readonly keeperService: PerpKeeperService,
    private readonly performanceLogger: PerpKeeperPerformanceLogger,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
    @Optional() private readonly executionLockService?: ExecutionLockService,
    @Optional() private readonly marketQualityFilter?: MarketQualityFilter,
  ) {}

  /**
   * Get keeper status and health
   * GET /keeper/status
   */
  @Get('status')
  async getStatus() {
    const healthCheck = await this.orchestrator.healthCheck();
    const areReady = await this.keeperService.areExchangesReady();

    return {
      healthy: healthCheck.healthy && areReady,
      exchanges: Object.fromEntries(
        Array.from(healthCheck.exchanges.entries()).map(([type, status]) => [
          type,
          status,
        ]),
      ),
      timestamp: new Date(),
    };
  }

  /**
   * Get all positions across exchanges
   * GET /keeper/positions
   */
  @Get('positions')
  async getPositions() {
    const metrics = await this.orchestrator.getAllPositionsWithMetrics();

    return {
      positions: metrics.positions.map((p) => ({
        exchange: p.exchangeType,
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unrealizedPnl: p.unrealizedPnl,
        leverage: p.leverage,
        liquidationPrice: p.liquidationPrice,
        marginUsed: p.marginUsed,
        timestamp: p.timestamp,
      })),
      totalUnrealizedPnl: metrics.totalUnrealizedPnl,
      totalPositionValue: metrics.totalPositionValue,
      positionsByExchange: Object.fromEntries(
        Array.from(metrics.positionsByExchange.entries()).map(
          ([type, positions]) => [type, positions.length],
        ),
      ),
      timestamp: new Date(),
    };
  }

  /**
   * Manually trigger execution
   * POST /keeper/execute
   * Body: { symbols?: string[], minSpread?: number, maxPositionSizeUsd?: number }
   */
  @Post('execute')
  async execute(
    @Body()
    body: {
      symbols?: string[];
      minSpread?: number;
      maxPositionSizeUsd?: number;
    },
  ) {
    const symbols = body.symbols || ['ETH', 'BTC'];
    const adapters = this.keeperService.getExchangeAdapters();

    const spotAdapters = this.keeperService.getSpotAdapters();
    const result = await this.arbitrageStrategy.executeStrategy(
      symbols,
      adapters,
      spotAdapters,
      body.minSpread,
      body.maxPositionSizeUsd,
    );

    return {
      success: result.success,
      opportunitiesEvaluated: result.opportunitiesEvaluated,
      opportunitiesExecuted: result.opportunitiesExecuted,
      totalExpectedReturn: result.totalExpectedReturn,
      ordersPlaced: result.ordersPlaced,
      errors: result.errors,
      timestamp: result.timestamp,
    };
  }

  /**
   * Get execution history (placeholder - would need persistence)
   * GET /keeper/history
   */
  @Get('history')
  async getHistory() {
    // TODO: Implement history tracking with persistence
    return {
      message: 'History tracking not yet implemented',
      executions: [],
    };
  }

  /**
   * Get performance metrics
   * GET /keeper/performance
   */
  @Get('performance')
  async getPerformance() {
    // Calculate total capital deployed
    let totalCapital = 0;
    try {
      for (const exchangeType of [
        ExchangeType.ASTER,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
      ]) {
        try {
          const balance = await this.keeperService.getBalance(exchangeType);
          totalCapital += balance;
        } catch (error) {
          // Skip if we can't get balance
        }
      }
    } catch (error) {
      // Use position value as fallback
    }

    const metrics = this.performanceLogger.getPerformanceMetrics(totalCapital);

    return {
      ...metrics,
      exchangeMetrics: Object.fromEntries(
        Array.from(metrics.exchangeMetrics.entries()).map(
          ([type, exchangeMetrics]) => [type, exchangeMetrics],
        ),
      ),
    };
  }

  /**
   * Get condensed diagnostics for bot health monitoring
   * GET /keeper/diagnostics
   *
   * Returns a condensed, actionable summary of bot health and performance.
   * Designed to remain small (<10KB) even after days of operation.
   * Ideal for AI context windows and quick health checks.
   */
  @Get('diagnostics')
  async getDiagnostics(): Promise<any> {
    if (!this.diagnosticsService) {
      return {
        error: 'DiagnosticsService not available',
        timestamp: new Date(),
      };
    }

    // Update position data before generating diagnostics
    try {
      const positionMetrics =
        await this.orchestrator.getAllPositionsWithMetrics();
      const positionsByExchange: Record<string, number> = {};
      for (const [exchange, positions] of positionMetrics.positionsByExchange) {
        positionsByExchange[exchange] = positions.length;
      }

      this.diagnosticsService.updatePositionData({
        count: positionMetrics.positions.length,
        totalValue: positionMetrics.totalPositionValue,
        unrealizedPnl: positionMetrics.totalUnrealizedPnl,
        byExchange: positionsByExchange,
      });
    } catch (error) {
      // Continue with stale position data if we can't fetch fresh
    }

    // Update APY data from performance logger
    try {
      let totalCapital = 0;
      for (const exchangeType of [
        ExchangeType.ASTER,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
      ]) {
        try {
          const balance = await this.keeperService.getBalance(exchangeType);
          totalCapital += balance;
        } catch {
          // Skip
        }
      }

      const perfMetrics =
        this.performanceLogger.getPerformanceMetrics(totalCapital);
      const byExchange: Record<string, number> = {};
      for (const [exchange, metrics] of perfMetrics.exchangeMetrics) {
        // Calculate per-exchange APY approximation based on funding captured
        if (metrics.totalPositionValue > 0) {
          const dailyReturn =
            metrics.netFundingCaptured / (perfMetrics.runtimeDays || 1);
          byExchange[exchange] =
            (dailyReturn / metrics.totalPositionValue) * 365 * 100;
        }
      }

      this.diagnosticsService.updateApyData({
        estimated: perfMetrics.estimatedAPY,
        realized: perfMetrics.realizedAPY,
        byExchange,
      });
    } catch (error) {
      // Continue with stale APY data
    }

    // Get base diagnostics
    const diagnostics = this.diagnosticsService.getDiagnostics();
    
    // Add execution lock diagnostics if available
    if (this.executionLockService) {
      const lockDiagnostics = this.executionLockService.getFullDiagnostics();
      return {
        ...diagnostics,
        executionLocks: {
          globalLock: lockDiagnostics.globalLock,
          symbolLocks: lockDiagnostics.symbolLocks,
          activeOrders: lockDiagnostics.activeOrders,
          recentOrderHistory: lockDiagnostics.recentOrderHistory,
        },
      };
    }

    return diagnostics;
  }
  
  /**
   * Get execution lock status
   * GET /keeper/locks
   * 
   * Returns the current state of all execution locks and active orders.
   * Useful for debugging race conditions and concurrent execution issues.
   */
  @Get('locks')
  async getLocks() {
    if (!this.executionLockService) {
      return {
        error: 'ExecutionLockService not available',
        timestamp: new Date(),
      };
    }
    
    return {
      ...this.executionLockService.getFullDiagnostics(),
      timestamp: new Date(),
    };
  }

  /**
   * Get market quality stats and blacklisted markets
   * GET /keeper/market-quality
   * 
   * Returns market execution quality statistics and dynamically blacklisted markets.
   */
  @Get('market-quality')
  async getMarketQuality() {
    if (!this.marketQualityFilter) {
      return {
        error: 'MarketQualityFilter not available',
        timestamp: new Date(),
      };
    }

    return {
      ...this.marketQualityFilter.getDiagnostics(),
      timestamp: new Date(),
    };
  }

  /**
   * Manually blacklist a market
   * POST /keeper/market-quality/blacklist
   * Body: { symbol: string, exchange?: string, reason?: string, durationMinutes?: number }
   * 
   * Adds a market to the blacklist. If exchange is not provided, blacklists the symbol on all exchanges.
   * If durationMinutes is not provided, the blacklist is permanent.
   */
  @Post('market-quality/blacklist')
  async blacklistMarket(
    @Body() body: { 
      symbol: string; 
      exchange?: string; 
      reason?: string; 
      durationMinutes?: number;
    }
  ) {
    if (!this.marketQualityFilter) {
      return {
        error: 'MarketQualityFilter not available',
        timestamp: new Date(),
      };
    }

    const { symbol, exchange, reason, durationMinutes } = body;

    if (!symbol) {
      return { error: 'Symbol is required', timestamp: new Date() };
    }

    const exchangeType = exchange ? (exchange as ExchangeType) : undefined;
    const durationMs = durationMinutes ? durationMinutes * 60 * 1000 : undefined;

    this.marketQualityFilter.addToBlacklist(
      symbol.toUpperCase(),
      reason || 'Manually blacklisted via API',
      exchangeType,
      durationMs,
    );

    return {
      success: true,
      message: `Blacklisted ${symbol}${exchange ? ` on ${exchange}` : ''}`,
      expiresIn: durationMinutes ? `${durationMinutes} minutes` : 'permanent',
      timestamp: new Date(),
    };
  }

  /**
   * Remove a market from the blacklist
   * DELETE /keeper/market-quality/blacklist/:symbol
   * Query: exchange? - optional exchange to remove from specific exchange
   * 
   * Removes a market from the blacklist.
   */
  @Delete('market-quality/blacklist/:symbol')
  async unblacklistMarket(
    @Param('symbol') symbol: string,
    @Query('exchange') exchange?: string,
  ) {
    if (!this.marketQualityFilter) {
      return {
        error: 'MarketQualityFilter not available',
        timestamp: new Date(),
      };
    }

    const exchangeType = exchange ? (exchange as ExchangeType) : undefined;
    const removed = this.marketQualityFilter.removeFromBlacklist(
      symbol.toUpperCase(),
      exchangeType,
    );

    return {
      success: removed,
      message: removed 
        ? `Removed ${symbol}${exchange ? ` on ${exchange}` : ''} from blacklist`
        : `${symbol}${exchange ? ` on ${exchange}` : ''} was not blacklisted`,
      timestamp: new Date(),
    };
  }

  /**
   * Get stats for a specific market
   * GET /keeper/market-quality/:symbol/:exchange
   */
  @Get('market-quality/:symbol/:exchange')
  async getMarketStats(
    @Param('symbol') symbol: string,
    @Param('exchange') exchange: string,
  ) {
    if (!this.marketQualityFilter) {
      return {
        error: 'MarketQualityFilter not available',
        timestamp: new Date(),
      };
    }

    const stats = this.marketQualityFilter.getMarketStats(
      symbol.toUpperCase(),
      exchange as ExchangeType,
    );

    return {
      ...stats,
      isBlacklisted: this.marketQualityFilter.isBlacklisted(symbol.toUpperCase(), exchange as ExchangeType),
      timestamp: new Date(),
    };
  }
}
