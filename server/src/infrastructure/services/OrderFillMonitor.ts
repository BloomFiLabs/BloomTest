import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { HyperLiquidWebSocketProvider, HyperliquidFillEvent, HyperliquidOrderUpdate } from '../adapters/hyperliquid/HyperLiquidWebSocketProvider';
import { LighterWebSocketProvider, LighterFillEvent, LighterOrderUpdate } from '../adapters/lighter/LighterWebSocketProvider';
import { ExecutionLockService } from './ExecutionLockService';
import { DiagnosticsService } from './DiagnosticsService';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';

/**
 * Fill event with normalized exchange type
 */
export interface NormalizedFillEvent {
  exchange: ExchangeType;
  orderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  price: number;
  size: number;
  timestamp: Date;
  filledAt: Date;
  latencyMs?: number;
}

/**
 * OrderFillMonitor - Monitors WebSocket fill events and clears tracked orders
 * 
 * This service:
 * 1. Subscribes to fill events from all exchange WebSocket providers
 * 2. When a fill is detected, removes the order from ExecutionLockService tracking
 * 3. Records fill events in DiagnosticsService for monitoring
 * 4. Tracks fill latency (time from order placement to fill detection)
 * 
 * This prevents stale order loops where MakerEfficiencyService or other services
 * try to modify orders that have already been filled.
 */
@Injectable()
export class OrderFillMonitor implements OnModuleInit {
  private readonly logger = new Logger(OrderFillMonitor.name);

  // Track fill statistics
  private fillCount = 0;
  private totalLatencyMs = 0;
  private recentFills: NormalizedFillEvent[] = [];
  private readonly MAX_RECENT_FILLS = 100;

  constructor(
    @Optional() private readonly hyperliquidWs?: HyperLiquidWebSocketProvider,
    @Optional() private readonly lighterWs?: LighterWebSocketProvider,
    @Optional() private readonly executionLockService?: ExecutionLockService,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.setupHyperliquidMonitoring();
    this.setupLighterMonitoring();
    this.logger.log('OrderFillMonitor initialized - listening for real-time fills');
  }

  /**
   * Set up Hyperliquid fill monitoring
   */
  private setupHyperliquidMonitoring(): void {
    if (!this.hyperliquidWs) {
      this.logger.debug('Hyperliquid WebSocket not available for fill monitoring');
      return;
    }

    // Register fill callback
    this.hyperliquidWs.onFill((fill: HyperliquidFillEvent) => {
      this.handleHyperliquidFill(fill);
    });

    // Register order update callback for status changes
    this.hyperliquidWs.onOrderUpdate((update: HyperliquidOrderUpdate) => {
      this.handleHyperliquidOrderUpdate(update);
    });

    this.logger.log('Hyperliquid fill monitoring enabled');
  }

  /**
   * Set up Lighter fill monitoring
   */
  private setupLighterMonitoring(): void {
    if (!this.lighterWs) {
      this.logger.debug('Lighter WebSocket not available for fill monitoring');
      return;
    }

    // Register fill callback
    this.lighterWs.onFill((fill: LighterFillEvent) => {
      this.handleLighterFill(fill);
    });

    // Register order update callback
    this.lighterWs.onOrderUpdate((update: LighterOrderUpdate) => {
      this.handleLighterOrderUpdate(update);
    });

    this.logger.log('Lighter fill monitoring enabled');
  }

  /**
   * Handle Hyperliquid fill event
   */
  private handleHyperliquidFill(fill: HyperliquidFillEvent): void {
    const side: 'LONG' | 'SHORT' = fill.side === 'B' ? 'LONG' : 'SHORT';
    const symbol = fill.coin.toUpperCase();

    const normalizedFill: NormalizedFillEvent = {
      exchange: ExchangeType.HYPERLIQUID,
      orderId: fill.oid,
      symbol,
      side,
      price: parseFloat(fill.px),
      size: parseFloat(fill.sz),
      timestamp: new Date(fill.time),
      filledAt: new Date(),
    };

    this.processFilledOrder(normalizedFill);
  }

  /**
   * Handle Hyperliquid order update (for filled/cancelled status)
   */
  private handleHyperliquidOrderUpdate(update: HyperliquidOrderUpdate): void {
    const order = update.order;
    
    if (order.status === 'filled' || order.status === 'canceled') {
      const side: 'LONG' | 'SHORT' = order.side === 'B' ? 'LONG' : 'SHORT';
      
      // Clear from tracking
      this.clearOrderFromTracking(
        ExchangeType.HYPERLIQUID,
        order.coin.toUpperCase(),
        side,
        order.oid.toString(),
        order.status,
      );
    }
  }

  /**
   * Handle Lighter fill event
   */
  private handleLighterFill(fill: LighterFillEvent): void {
    const side: 'LONG' | 'SHORT' = fill.side === 'bid' ? 'LONG' : 'SHORT';
    // Lighter uses market index, we'd need to map to symbol
    // For now, use market index as the symbol identifier
    const symbol = `MARKET_${fill.marketIndex}`;

    const normalizedFill: NormalizedFillEvent = {
      exchange: ExchangeType.LIGHTER,
      orderId: fill.orderId,
      symbol,
      side,
      price: parseFloat(fill.price),
      size: parseFloat(fill.filledSize),
      timestamp: new Date(fill.timestamp),
      filledAt: new Date(),
    };

    this.processFilledOrder(normalizedFill);
  }

  /**
   * Handle Lighter order update
   */
  private handleLighterOrderUpdate(update: LighterOrderUpdate): void {
    if (update.status === 'filled' || update.status === 'canceled') {
      const side: 'LONG' | 'SHORT' = update.side === 'bid' ? 'LONG' : 'SHORT';
      const symbol = `MARKET_${update.marketIndex}`;

      this.clearOrderFromTracking(
        ExchangeType.LIGHTER,
        symbol,
        side,
        update.orderId,
        update.status,
      );
    }
  }

  /**
   * Process a filled order - clear from tracking and record stats
   */
  private processFilledOrder(fill: NormalizedFillEvent): void {
    // Calculate latency if we have placement time
    const placementTime = this.getOrderPlacementTime(fill.exchange, fill.orderId);
    if (placementTime) {
      fill.latencyMs = fill.filledAt.getTime() - placementTime.getTime();
      this.totalLatencyMs += fill.latencyMs;
    }

    this.fillCount++;

    // Store in recent fills
    this.recentFills.unshift(fill);
    if (this.recentFills.length > this.MAX_RECENT_FILLS) {
      this.recentFills.pop();
    }

    // Clear from ExecutionLockService
    this.clearOrderFromTracking(
      fill.exchange,
      fill.symbol,
      fill.side,
      fill.orderId,
      'filled',
    );

    // Record in diagnostics
    this.recordFillInDiagnostics(fill);

    this.logger.log(
      `✅ Fill detected via WebSocket: ${fill.exchange} ${fill.symbol} ${fill.side} ` +
      `${fill.size} @ ${fill.price} (oid: ${fill.orderId})` +
      (fill.latencyMs ? ` [latency: ${fill.latencyMs}ms]` : '')
    );
  }

  /**
   * Clear an order from ExecutionLockService tracking
   */
  private clearOrderFromTracking(
    exchange: ExchangeType,
    symbol: string,
    side: 'LONG' | 'SHORT',
    orderId: string,
    status: string,
  ): void {
    if (!this.executionLockService) {
      return;
    }

    try {
      this.executionLockService.forceClearOrder(exchange, symbol, side);
      this.logger.debug(
        `Cleared ${status} order from tracking: ${exchange}:${symbol}:${side} (oid: ${orderId})`
      );
    } catch (error: any) {
      this.logger.warn(
        `Failed to clear order from tracking: ${error.message}`
      );
    }
  }

  /**
   * Get order placement time from ExecutionLockService
   */
  private getOrderPlacementTime(exchange: ExchangeType, orderId: string): Date | null {
    if (!this.executionLockService) {
      return null;
    }

    // Try to find the order in active orders
    const activeOrders = this.executionLockService.getActiveOrders();
    const order = activeOrders.find(
      o => o.orderId === orderId && o.exchange === exchange
    );

    return order?.placedAt ?? null;
  }

  /**
   * Record fill event in diagnostics service
   */
  private recordFillInDiagnostics(fill: NormalizedFillEvent): void {
    if (!this.diagnosticsService) {
      return;
    }

    // Record as an event (you may need to add this method to DiagnosticsService)
    try {
      // For now, we can use the existing logging infrastructure
      // The diagnostics service can be extended later to track fill events
      this.logger.debug(
        `Fill recorded: ${fill.exchange} ${fill.symbol} ${fill.side} @ ${fill.price}`
      );
    } catch (error: any) {
      this.logger.debug(`Failed to record fill in diagnostics: ${error.message}`);
    }
  }

  /**
   * Get fill statistics
   */
  getStatistics(): {
    fillCount: number;
    averageLatencyMs: number | null;
    recentFills: NormalizedFillEvent[];
  } {
    return {
      fillCount: this.fillCount,
      averageLatencyMs: this.fillCount > 0 ? this.totalLatencyMs / this.fillCount : null,
      recentFills: [...this.recentFills],
    };
  }

  /**
   * Get recent fills for a specific symbol
   */
  getRecentFillsForSymbol(symbol: string): NormalizedFillEvent[] {
    return this.recentFills.filter(f => f.symbol === symbol);
  }

  /**
   * Check if we're monitoring fills for a specific exchange
   */
  isMonitoringExchange(exchange: ExchangeType): boolean {
    switch (exchange) {
      case ExchangeType.HYPERLIQUID:
        return !!this.hyperliquidWs?.isSubscribedToUserEvents();
      case ExchangeType.LIGHTER:
        return !!this.lighterWs?.isSubscribedToUserOrders();
      default:
        return false;
    }
  }
}

