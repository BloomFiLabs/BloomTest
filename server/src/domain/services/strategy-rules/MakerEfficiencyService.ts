import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PerpKeeperService } from '../../../application/services/PerpKeeperService';
import { ExecutionLockService, ActiveOrder } from '../../../infrastructure/services/ExecutionLockService';
import { HyperLiquidWebSocketProvider } from '../../../infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider';
import { LighterWebSocketProvider } from '../../../infrastructure/adapters/lighter/LighterWebSocketProvider';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { OrderSide, OrderType, PerpOrderRequest, TimeInForce } from '../../value-objects/PerpOrder';
import { RateLimiterService } from '../../../infrastructure/services/RateLimiterService';

/**
 * MakerEfficiencyService - Ensures our orders are the most price-efficient on the book
 * 
 * Runs every 2 seconds to check open orders and reposition them to beat other makers.
 */
@Injectable()
export class MakerEfficiencyService implements OnModuleInit {
  private readonly logger = new Logger(MakerEfficiencyService.name);
  private isRunning = false;

  constructor(
    private readonly keeperService: PerpKeeperService,
    private readonly executionLockService: ExecutionLockService,
    private readonly hlWsProvider: HyperLiquidWebSocketProvider,
    private readonly lighterWsProvider: LighterWebSocketProvider,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  onModuleInit() {
    this.logger.log('MakerEfficiencyService initialized (7s check interval)');
  }

  @Interval(2000) // Run every 2s, but internally throttle per exchange
  async manageMakerEfficiency() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const activeOrders = this.executionLockService.getAllActiveOrders();
      const waitingOrders = activeOrders.filter(o => o.status === 'WAITING_FILL');

      if (waitingOrders.length === 0) {
        this.isRunning = false;
        return;
      }

      // Group orders by exchange to handle specific rate limits
      const ordersByExchange = new Map<ExchangeType, ActiveOrder[]>();
      for (const order of waitingOrders) {
        const exchange = order.exchange as ExchangeType;
        if (!ordersByExchange.has(exchange)) ordersByExchange.set(exchange, []);
        ordersByExchange.get(exchange)!.push(order);
      }

      for (const [exchange, orders] of ordersByExchange.entries()) {
        await this.processExchangeEfficiency(exchange, orders);
      }
    } catch (error: any) {
      this.logger.error(`Error in MakerEfficiencyService: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  private lastExchangeCheck: Map<ExchangeType, number> = new Map();

  private async processExchangeEfficiency(exchange: ExchangeType, orders: ActiveOrder[]) {
    const now = Date.now();
    const lastCheck = this.lastExchangeCheck.get(exchange) || 0;
    
    // 1. Get current budget health (1.0 = full, 0.0 = empty)
    const { budgetHealth } = this.rateLimiter.getUsage(exchange);
    
    // 2. Calculate base optimal interval based on exchange rate limits
    let baseIntervalMs = 7000; // Default
    
    if (exchange === ExchangeType.HYPERLIQUID) {
      // Hyperliquid: Budget of ~400 updates/min.
      baseIntervalMs = Math.max((60000 / 400) * orders.length, 1000); 
    } else if (exchange === ExchangeType.LIGHTER) {
      // Lighter Standard: 60 weight/min. updateOrder = 6 weight.
      // Max 10 updates per minute across ALL orders.
      baseIntervalMs = Math.max(6000 * orders.length, 10000);
    }

    // 3. Scale interval based on budget health (Global Token Bank)
    // If health is > 80%, we use baseInterval.
    // If health is < 20%, we slow down significantly (4x base).
    // Linear scaling in between.
    let intervalMs = baseIntervalMs;
    if (budgetHealth < 0.8) {
      const healthMultiplier = 1 + (0.8 - budgetHealth) * 4; // Max multiplier of ~4.2 at health 0
      intervalMs = baseIntervalMs * healthMultiplier;
      
      if (budgetHealth < 0.3) {
        this.logger.warn(
          `⚠️ Low budget health for ${exchange} (${(budgetHealth * 100).toFixed(1)}%). ` +
          `Slowing down maker chasing: ${intervalMs/1000}s interval.`
        );
      }
    }

    if (now - lastCheck < intervalMs) return;
    this.lastExchangeCheck.set(exchange, now);

    this.logger.debug(
      `Checking efficiency for ${orders.length} orders on ${exchange} ` +
      `(Health: ${(budgetHealth * 100).toFixed(1)}%, Interval: ${intervalMs/1000}s)`
    );

    // Process orders one by one for now
    for (const order of orders) {
      await this.checkAndRepositionOrder(order);
    }
  }

  private async checkAndRepositionOrder(activeOrder: ActiveOrder) {
    const exchange = activeOrder.exchange as ExchangeType;
    const symbol = activeOrder.symbol;
    const adapter = this.keeperService.getExchangeAdapter(exchange);

    if (!adapter) return;

    // 1. Get real-time order book from WebSocket providers
    let bestBidAsk: { bestBid: number; bestAsk: number } | null = null;

    if (exchange === ExchangeType.HYPERLIQUID) {
      bestBidAsk = this.hlWsProvider.getBestBidAsk(symbol);
    } else if (exchange === ExchangeType.LIGHTER) {
      // Lighter uses market index, need to convert symbol if necessary
      // Assuming symbol is usable directly or provider handles it
      try {
        const marketIndex = await (adapter as any).getMarketIndex(symbol);
        bestBidAsk = this.lighterWsProvider.getBestBidAsk(marketIndex);
      } catch (e) {
        this.logger.debug(`Could not get market index for ${symbol}: ${e.message}`);
      }
    }

    if (!bestBidAsk) {
      this.logger.debug(`No real-time book data for ${symbol} on ${exchange} yet.`);
      return;
    }

    const { bestBid, bestAsk } = bestBidAsk;
    const currentPrice = activeOrder.price || 0;
    const tickSize = await adapter.getTickSize(symbol);

    // 2. Determine target price to be the best maker
    let targetPrice = currentPrice;

    if (activeOrder.side === 'LONG') {
      // For BUY orders, we want to be bestBid + tick
      // If we ARE the bestBid, we check if someone is right behind us
      // For simplicity: if currentPrice < bestBid, we are being beat.
      if (currentPrice < bestBid) {
        targetPrice = bestBid + tickSize;
      }
    } else {
      // For SELL orders, we want to be bestAsk - tick
      if (currentPrice > bestAsk) {
        targetPrice = bestAsk - tickSize;
      }
    }

    // 3. Reposition if target price changed significantly
    if (Math.abs(targetPrice - currentPrice) > (tickSize / 2)) {
      // Ensure we don't cross the spread (don't buy above bestAsk or sell below bestBid)
      if (activeOrder.side === 'LONG' && targetPrice >= bestAsk) {
        targetPrice = bestAsk - tickSize;
      }
      if (activeOrder.side === 'SHORT' && targetPrice <= bestBid) {
        targetPrice = bestBid + tickSize;
      }

      this.logger.log(
        `🎯 Repositioning ${activeOrder.side} ${symbol} on ${exchange}: ` +
        `${currentPrice.toFixed(4)} -> ${targetPrice.toFixed(4)} (Maker Efficiency)`
      );

      try {
        // Use modifyOrder if supported by the adapter (more efficient for rate limits)
        let response;
        const side = activeOrder.side === 'LONG' ? OrderSide.LONG : OrderSide.SHORT;
        const newOrderRequest = new PerpOrderRequest(
          symbol,
          side,
          OrderType.LIMIT,
          activeOrder.size || 0,
          targetPrice,
          TimeInForce.GTC,
          activeOrder.reduceOnly || false
        );

        if (typeof adapter.modifyOrder === 'function') {
          this.logger.debug(`Using modifyOrder for ${symbol} on ${exchange}`);
          response = await adapter.modifyOrder(activeOrder.orderId, newOrderRequest);
        } else {
          // Fallback to cancel + place
          this.logger.debug(`Using cancel+place for ${symbol} on ${exchange} (modifyOrder not supported)`);
          await adapter.cancelOrder(activeOrder.orderId, symbol);
          response = await adapter.placeOrder(newOrderRequest);
        }

        if (response.orderId) {
          // Update the registry with the new order ID and price
          this.executionLockService.updateOrderStatus(
            exchange,
            symbol,
            activeOrder.side,
            'WAITING_FILL',
            response.orderId,
            targetPrice,
            activeOrder.reduceOnly
          );
        }
      } catch (error: any) {
        this.logger.error(`Failed to reposition order for ${symbol}: ${error.message}`);
      }
    }
  }
}

