import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { PerpOrderRequest, PerpOrderResponse } from '../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../domain/entities/PerpPosition';
import { IPerpExchangeAdapter } from '../../domain/ports/IPerpExchangeAdapter';
import {
  IPerpKeeperService,
  StrategyExecutionResult,
  PositionMonitoringResult,
} from '../../domain/ports/IPerpKeeperService';
import { AsterExchangeAdapter } from '../../infrastructure/adapters/aster/AsterExchangeAdapter';
import { LighterExchangeAdapter } from '../../infrastructure/adapters/lighter/LighterExchangeAdapter';
import { HyperliquidExchangeAdapter } from '../../infrastructure/adapters/hyperliquid/HyperliquidExchangeAdapter';
import { MockExchangeAdapter } from '../../infrastructure/adapters/mock/MockExchangeAdapter';
import { PerpKeeperPerformanceLogger } from '../../infrastructure/logging/PerpKeeperPerformanceLogger';
import { ExchangeBalanceRebalancer, RebalanceResult } from '../../domain/services/ExchangeBalanceRebalancer';
import { ArbitrageOpportunity } from '../../domain/services/FundingRateAggregator';

/**
 * PerpKeeperService - Implements IPerpKeeperService
 * 
 * Manages all exchange adapters and coordinates trading operations
 */
@Injectable()
export class PerpKeeperService implements IPerpKeeperService {
  private readonly logger = new Logger(PerpKeeperService.name);
  private readonly adapters: Map<ExchangeType, IPerpExchangeAdapter> = new Map();

  constructor(
    @Optional() @Inject(AsterExchangeAdapter) private readonly asterAdapter: AsterExchangeAdapter | null,
    @Optional() @Inject(LighterExchangeAdapter) private readonly lighterAdapter: LighterExchangeAdapter | null,
    @Optional() @Inject(HyperliquidExchangeAdapter) private readonly hyperliquidAdapter: HyperliquidExchangeAdapter | null,
    private readonly performanceLogger: PerpKeeperPerformanceLogger,
    private readonly balanceRebalancer: ExchangeBalanceRebalancer,
    private readonly configService: ConfigService,
  ) {
    // Check if test mode is enabled
    const testMode = this.configService.get<string>('TEST_MODE') === 'true';
    
    if (testMode) {
      // Use mock adapters in test mode (they wrap real adapters for market data)
      const mockCapital = parseFloat(
        this.configService.get<string>('MOCK_CAPITAL_USD') || '5000000'
      );
      this.logger.log(`🧪 TEST MODE ENABLED - Using mock adapters with $${mockCapital.toFixed(2)} capital`);
      this.logger.log(`   Mock adapters use REAL market data (prices, order books) but track FAKE positions/balances`);
      
      // Create real adapters if they're null (for market data)
      // Mock adapters need real adapters to get market data
      const aster = asterAdapter || new AsterExchangeAdapter(this.configService);
      const lighter = lighterAdapter || new LighterExchangeAdapter(this.configService);
      const hyperliquid = hyperliquidAdapter || new HyperliquidExchangeAdapter(this.configService, null as any);
      
      this.adapters.set(
        ExchangeType.ASTER, 
        new MockExchangeAdapter(this.configService, ExchangeType.ASTER, aster, lighter, hyperliquid)
      );
      this.adapters.set(
        ExchangeType.LIGHTER, 
        new MockExchangeAdapter(this.configService, ExchangeType.LIGHTER, aster, lighter, hyperliquid)
      );
      this.adapters.set(
        ExchangeType.HYPERLIQUID, 
        new MockExchangeAdapter(this.configService, ExchangeType.HYPERLIQUID, aster, lighter, hyperliquid)
      );
    } else {
      // Use real adapters, but only if they were successfully created
      if (asterAdapter) {
        this.adapters.set(ExchangeType.ASTER, asterAdapter);
      } else {
        this.logger.warn('Aster adapter not available - will be created lazily if needed');
      }
      if (lighterAdapter) {
        this.adapters.set(ExchangeType.LIGHTER, lighterAdapter);
      } else {
        this.logger.warn('Lighter adapter not available - will be created lazily if needed');
      }
      if (hyperliquidAdapter) {
        this.adapters.set(ExchangeType.HYPERLIQUID, hyperliquidAdapter);
      } else {
        this.logger.warn('Hyperliquid adapter not available - will be created lazily if needed');
      }
    }

    this.logger.log(`PerpKeeperService initialized with ${this.adapters.size} exchange adapters`);
  }

  getExchangeAdapter(exchangeType: ExchangeType): IPerpExchangeAdapter {
    const adapter = this.adapters.get(exchangeType);
    if (!adapter) {
      throw new Error(`Exchange adapter not found: ${exchangeType}`);
    }
    return adapter;
  }

  getExchangeAdapters(): Map<ExchangeType, IPerpExchangeAdapter> {
    return new Map(this.adapters);
  }

  async placeOrder(exchangeType: ExchangeType, request: PerpOrderRequest): Promise<PerpOrderResponse> {
    const adapter = this.getExchangeAdapter(exchangeType);
    const response = await adapter.placeOrder(request);
    
    // Track order execution
    this.performanceLogger.recordOrderExecution(
      exchangeType,
      response.isFilled(),
      !response.isSuccess(),
    );
    
    // Track volume (USD value of trade)
    if (response.isFilled() && response.filledSize && response.averageFillPrice) {
      const tradeVolume = response.filledSize * response.averageFillPrice;
      this.performanceLogger.recordTradeVolume(tradeVolume);
    }
    
    return response;
  }

  async placeOrdersOnMultipleExchanges(
    requests: Map<ExchangeType, PerpOrderRequest>,
  ): Promise<Map<ExchangeType, PerpOrderResponse>> {
    const results = new Map<ExchangeType, PerpOrderResponse>();

    // Execute orders in parallel
    const promises = Array.from(requests.entries()).map(async ([exchangeType, request]) => {
      try {
        const response = await this.placeOrder(exchangeType, request);
        results.set(exchangeType, response);
      } catch (error: any) {
        this.logger.error(`Failed to place order on ${exchangeType}: ${error.message}`);
        // Create error response
        const { OrderStatus } = require('../../domain/value-objects/PerpOrder');
        results.set(
          exchangeType,
          new PerpOrderResponse(
            'error',
            OrderStatus.REJECTED,
            request.symbol,
            request.side,
            request.clientOrderId,
            undefined,
            undefined,
            error.message,
            new Date(),
          ),
        );
      }
    });

    await Promise.all(promises);
    return results;
  }

  async getPosition(exchangeType: ExchangeType, symbol: string): Promise<PerpPosition | null> {
    const adapter = this.getExchangeAdapter(exchangeType);
    return await adapter.getPosition(symbol);
  }

  async getAllPositions(): Promise<PerpPosition[]> {
    const allPositions: PerpPosition[] = [];

    for (const [exchangeType, adapter] of this.adapters) {
      try {
        const positions = await adapter.getPositions();
        allPositions.push(...positions);
      } catch (error: any) {
        this.logger.error(`Failed to get positions from ${exchangeType}: ${error.message}`);
      }
    }

    return allPositions;
  }

  async monitorPositions(): Promise<PositionMonitoringResult> {
    const positions = await this.getAllPositions();
    const totalUnrealizedPnl = positions.reduce((sum, pos) => sum + pos.unrealizedPnl, 0);
    const totalPositionValue = positions.reduce((sum, pos) => sum + pos.getPositionValue(), 0);

    // Group positions by exchange for performance tracking
    const positionsByExchange = new Map<ExchangeType, PerpPosition[]>();
    for (const position of positions) {
      const exchangePositions = positionsByExchange.get(position.exchangeType) || [];
      exchangePositions.push(position);
      positionsByExchange.set(position.exchangeType, exchangePositions);
    }

    // Update performance metrics for each exchange
    // Note: We'll need funding rates from the orchestrator for full metrics
    // For now, just track position counts and values
    for (const [exchange, exchangePositions] of positionsByExchange.entries()) {
      // This will be enhanced when we have funding rate data
      // For now, the orchestrator will call updatePositionMetrics with full data
    }

    return {
      positions,
      totalUnrealizedPnl,
      totalPositionValue,
      timestamp: new Date(),
    };
  }

  async cancelOrder(exchangeType: ExchangeType, orderId: string, symbol?: string): Promise<boolean> {
    const adapter = this.getExchangeAdapter(exchangeType);
    return await adapter.cancelOrder(orderId, symbol);
  }

  async cancelAllOrders(exchangeType: ExchangeType, symbol: string): Promise<number> {
    const adapter = this.getExchangeAdapter(exchangeType);
    return await adapter.cancelAllOrders(symbol);
  }

  async executeStrategy(
    strategy: (adapters: Map<ExchangeType, IPerpExchangeAdapter>) => Promise<StrategyExecutionResult>,
  ): Promise<StrategyExecutionResult> {
    return await strategy(this.adapters);
  }

  async getOrderStatus(
    exchangeType: ExchangeType,
    orderId: string,
    symbol?: string,
  ): Promise<PerpOrderResponse> {
    const adapter = this.getExchangeAdapter(exchangeType);
    return await adapter.getOrderStatus(orderId, symbol);
  }

  async getMarkPrice(exchangeType: ExchangeType, symbol: string): Promise<number> {
    const adapter = this.getExchangeAdapter(exchangeType);
    return await adapter.getMarkPrice(symbol);
  }

  async getBalance(exchangeType: ExchangeType): Promise<number> {
    const adapter = this.adapters.get(exchangeType);
    if (!adapter) {
      this.logger.debug(`Adapter not found for ${exchangeType}, returning 0 balance`);
      return 0;
    }
    
    // Clear cache before fetching balance to ensure fresh data
    // Hyperliquid adapter has a clearBalanceCache method
    if ('clearBalanceCache' in adapter && typeof (adapter as any).clearBalanceCache === 'function') {
      (adapter as any).clearBalanceCache();
    }
    
    return await adapter.getBalance();
  }

  async getEquity(exchangeType: ExchangeType): Promise<number> {
    const adapter = this.adapters.get(exchangeType);
    if (!adapter) {
      this.logger.debug(`Adapter not found for ${exchangeType}, returning 0 equity`);
      return 0;
    }
    return await adapter.getEquity();
  }

  async areExchangesReady(): Promise<boolean> {
    const readinessChecks = await Promise.all(
      Array.from(this.adapters.values()).map((adapter) => adapter.isReady()),
    );
    return readinessChecks.every((ready) => ready);
  }

  async testAllConnections(): Promise<void> {
    const errors: string[] = [];

    for (const [exchangeType, adapter] of this.adapters) {
      try {
        await adapter.testConnection();
      } catch (error: any) {
        errors.push(`${exchangeType}: ${error.message}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Connection test failed: ${errors.join(', ')}`);
    }
  }

  /**
   * Rebalance balances across all exchanges
   * Transfers funds from exchanges with excess balance to exchanges with deficit
   * Prioritizes moving funds from inactive exchanges (no opportunities) to active exchanges (with opportunities)
   * 
   * @param opportunities Optional list of arbitrage opportunities to determine which exchanges are active
   */
  async rebalanceExchangeBalances(opportunities: ArbitrageOpportunity[] = []): Promise<RebalanceResult> {
    return await this.balanceRebalancer.rebalance(this.adapters, opportunities);
  }
}

