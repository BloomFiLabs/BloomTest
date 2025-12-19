import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderStatus,
} from '../value-objects/PerpOrder';
import { PerpPosition } from '../entities/PerpPosition';
import { PerpOrder } from '../entities/PerpOrder';
import {
  IPerpExchangeAdapter,
  ExchangeError,
} from '../ports/IPerpExchangeAdapter';
import { ISpotExchangeAdapter } from '../ports/ISpotExchangeAdapter';
import {
  FundingRateAggregator,
  FundingRateComparison,
  ArbitrageOpportunity,
} from './FundingRateAggregator';
import {
  FundingArbitrageStrategy,
  ArbitrageExecutionResult,
} from './FundingArbitrageStrategy';

/**
 * Strategy execution result
 */
export interface StrategyExecutionResult {
  success: boolean;
  ordersPlaced: number;
  ordersFilled: number;
  ordersFailed: number;
  error?: string;
  timestamp: Date;
}

/**
 * Position monitoring result
 */
export interface PositionMonitoringResult {
  positions: PerpPosition[];
  totalUnrealizedPnl: number;
  totalPositionValue: number;
  timestamp: Date;
}

/**
 * PerpKeeperOrchestrator - Domain service for orchestrating perpetual keeper operations
 *
 * This service coordinates trading operations across multiple exchanges,
 * manages order lifecycle, and provides high-level abstractions for strategy execution.
 */
@Injectable()
export class PerpKeeperOrchestrator {
  private readonly logger = new Logger(PerpKeeperOrchestrator.name);
  private readonly exchangeAdapters: Map<ExchangeType, IPerpExchangeAdapter> =
    new Map();
  private readonly spotAdapters: Map<ExchangeType, ISpotExchangeAdapter> =
    new Map();
  private readonly activeOrders: Map<string, PerpOrder> = new Map(); // Internal order ID -> PerpOrder

  constructor(
    private readonly aggregator: FundingRateAggregator,
    private readonly arbitrageStrategy: FundingArbitrageStrategy,
  ) {}

  /**
   * Initialize orchestrator with exchange adapters
   */
  initialize(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    spotAdapters: Map<ExchangeType, ISpotExchangeAdapter> = new Map(),
  ): void {
    this.exchangeAdapters.clear();
    adapters.forEach((adapter, type) => {
      this.exchangeAdapters.set(type, adapter);
    });
    this.spotAdapters.clear();
    spotAdapters.forEach((adapter, type) => {
      this.spotAdapters.set(type, adapter);
    });
    this.logger.log(
      `Initialized with ${this.exchangeAdapters.size} perp adapters and ${this.spotAdapters.size} spot adapters`,
    );
  }

  /**
   * Place an order and track it internally
   */
  async placeAndTrackOrder(
    exchangeType: ExchangeType,
    request: PerpOrderRequest,
  ): Promise<{ order: PerpOrder; response: PerpOrderResponse }> {
    const adapter = this.exchangeAdapters.get(exchangeType);
    if (!adapter) {
      throw new Error(`Exchange adapter not found: ${exchangeType}`);
    }

    try {
      const response = await adapter.placeOrder(request);
      const orderId = this.generateOrderId();
      const order = PerpOrder.fromRequestAndResponse(
        orderId,
        exchangeType,
        request,
        response,
      );
      this.activeOrders.set(orderId, order);

      this.logger.log(
        `Order placed: ${orderId} on ${exchangeType} - ${request.symbol} ${request.side} ${request.size}`,
      );

      return { order, response };
    } catch (error) {
      this.logger.error(
        `Failed to place order on ${exchangeType}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Update order status by polling exchange
   */
  async updateOrderStatus(
    orderId: string,
    exchangeType: ExchangeType,
    exchangeOrderId: string,
    symbol?: string,
  ): Promise<PerpOrder> {
    const order = this.activeOrders.get(orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const adapter = this.exchangeAdapters.get(exchangeType);
    if (!adapter) {
      throw new Error(`Exchange adapter not found: ${exchangeType}`);
    }

    try {
      const response = await adapter.getOrderStatus(exchangeOrderId, symbol);
      const updatedOrder = order.update(
        response.status,
        response.filledSize,
        response.averageFillPrice,
        response.error,
      );
      this.activeOrders.set(orderId, updatedOrder);

      return updatedOrder;
    } catch (error) {
      this.logger.error(`Failed to update order status: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cancel an order and remove from tracking
   */
  async cancelAndUntrackOrder(orderId: string): Promise<boolean> {
    const order = this.activeOrders.get(orderId);
    if (!order) {
      throw new Error(`Order not found: ${orderId}`);
    }

    const adapter = this.exchangeAdapters.get(order.exchangeType);
    if (!adapter) {
      throw new Error(`Exchange adapter not found: ${order.exchangeType}`);
    }

    try {
      const success = await adapter.cancelOrder(
        order.exchangeOrderId,
        order.symbol,
      );

      if (success) {
        const cancelledOrder = order.update(OrderStatus.CANCELLED);
        this.activeOrders.set(orderId, cancelledOrder);
      }

      return success;
    } catch (error) {
      this.logger.error(`Failed to cancel order: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all active orders across all exchanges
   */
  getActiveOrders(): PerpOrder[] {
    return Array.from(this.activeOrders.values()).filter((order) =>
      order.isActive(),
    );
  }

  /**
   * Get all positions across all exchanges with aggregated metrics
   */
  async getAllPositionsWithMetrics(): Promise<{
    positions: PerpPosition[];
    totalUnrealizedPnl: number;
    totalPositionValue: number;
    positionsByExchange: Map<ExchangeType, PerpPosition[]>;
  }> {
    const allPositions: PerpPosition[] = [];
    const positionsByExchange = new Map<ExchangeType, PerpPosition[]>();

    // Fetch positions from all exchanges
    for (const [exchangeType, adapter] of this.exchangeAdapters) {
      try {
        const positions = await adapter.getPositions();
        // Filter out positions with very small sizes (likely rounding errors or stale data)
        const validPositions = positions.filter(
          (p) => Math.abs(p.size) > 0.0001,
        );
        allPositions.push(...validPositions);
        positionsByExchange.set(exchangeType, validPositions);
      } catch (error) {
        this.logger.error(
          `Failed to get positions from ${exchangeType}: ${error.message}`,
        );
      }
    }

    // Calculate aggregated metrics
    const totalUnrealizedPnl = allPositions.reduce(
      (sum, pos) => sum + pos.unrealizedPnl,
      0,
    );
    const totalPositionValue = allPositions.reduce(
      (sum, pos) => sum + pos.getPositionValue(),
      0,
    );

    return {
      positions: allPositions,
      totalUnrealizedPnl,
      totalPositionValue,
      positionsByExchange,
    };
  }

  /**
   * Execute a strategy with error handling and retry logic
   */
  async executeStrategyWithRetry(
    strategy: (
      adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    ) => Promise<StrategyExecutionResult>,
    maxRetries: number = 3,
  ): Promise<StrategyExecutionResult> {
    let lastError: Error | undefined;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        return await strategy(this.exchangeAdapters);
      } catch (error) {
        lastError = error as Error;
        attempt++;
        this.logger.warn(
          `Strategy execution attempt ${attempt} failed: ${error.message}`,
        );

        if (attempt < maxRetries) {
          // Exponential backoff
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          await this.sleep(delay);
        }
      }
    }

    throw new Error(
      `Strategy execution failed after ${maxRetries} attempts: ${lastError?.message}`,
    );
  }

  /**
   * Route order to best exchange based on criteria
   * This is a simple implementation - can be extended with more sophisticated routing
   */
  async routeOrderToBestExchange(
    request: PerpOrderRequest,
    criteria?: {
      preferLowestFee?: boolean;
      preferHighestLiquidity?: boolean;
      preferFastestExecution?: boolean;
      excludeExchanges?: ExchangeType[];
    },
  ): Promise<{ exchangeType: ExchangeType; response: PerpOrderResponse }> {
    const availableExchanges = Array.from(this.exchangeAdapters.keys()).filter(
      (type) => !criteria?.excludeExchanges?.includes(type),
    );

    if (availableExchanges.length === 0) {
      throw new Error('No available exchanges');
    }

    // Simple routing: use first available exchange
    // In production, this would consider fees, liquidity, execution speed, etc.
    const selectedExchange = availableExchanges[0];
    const adapter = this.exchangeAdapters.get(selectedExchange);
    if (!adapter) {
      throw new Error(`Exchange adapter not found: ${selectedExchange}`);
    }

    const response = await adapter.placeOrder(request);

    this.logger.log(
      `Routed order to ${selectedExchange} based on routing criteria`,
    );

    return { exchangeType: selectedExchange, response };
  }

  /**
   * Health check for all exchanges
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    exchanges: Map<ExchangeType, { ready: boolean; error?: string }>;
  }> {
    const exchanges = new Map<
      ExchangeType,
      { ready: boolean; error?: string }
    >();

    for (const [type, adapter] of this.exchangeAdapters) {
      try {
        const ready = await adapter.isReady();
        exchanges.set(type, { ready });
      } catch (error) {
        exchanges.set(type, { ready: false, error: (error as Error).message });
      }
    }

    const healthy = Array.from(exchanges.values()).every(
      (status) => status.ready,
    );

    return { healthy, exchanges };
  }

  /**
   * Clean up old completed orders from tracking
   */
  cleanupCompletedOrders(maxAgeHours: number = 24): void {
    const cutoffTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    let cleaned = 0;

    for (const [orderId, order] of this.activeOrders.entries()) {
      if (order.isTerminal() && order.updatedAt < cutoffTime) {
        this.activeOrders.delete(orderId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.log(`Cleaned up ${cleaned} old completed orders`);
    }
  }

  /**
   * Generate a unique order ID
   */
  private generateOrderId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Compare funding rates across exchanges for a symbol
   */
  async compareFundingRates(symbol: string): Promise<FundingRateComparison> {
    return await this.aggregator.compareFundingRates(symbol);
  }

  /**
   * Discover all common assets across exchanges
   */
  async discoverCommonAssets(): Promise<string[]> {
    return await this.aggregator.discoverCommonAssets();
  }

  /**
   * Find arbitrage opportunities
   * @param symbols List of symbols to search for opportunities
   * @param minSpread Minimum spread threshold
   * @param showProgress Whether to show progress bar
   * @param includePerpSpot Whether to include perp-spot opportunities
   */
  async findArbitrageOpportunities(
    symbols: string[],
    minSpread?: number,
    showProgress: boolean = true,
    includePerpSpot: boolean = false,
  ): Promise<ArbitrageOpportunity[]> {
    // Use findAllOpportunities which handles both perp-perp and perp-spot
    return await this.aggregator.findAllOpportunities(
      symbols,
      minSpread,
      showProgress,
      includePerpSpot,
    );
  }

  /**
   * Execute arbitrage strategy
   */
  async executeArbitrageStrategy(
    symbols: string[],
    minSpread?: number,
    maxPositionSizeUsd?: number,
  ): Promise<ArbitrageExecutionResult> {
    return await this.arbitrageStrategy.executeStrategy(
      symbols,
      this.exchangeAdapters,
      this.spotAdapters,
      minSpread,
      maxPositionSizeUsd,
    );
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
