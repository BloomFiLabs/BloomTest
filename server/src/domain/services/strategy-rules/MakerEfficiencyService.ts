import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PerpKeeperService } from '../../../application/services/PerpKeeperService';
import { ExecutionLockService, ActiveOrder } from '../../../infrastructure/services/ExecutionLockService';
import { HyperLiquidWebSocketProvider } from '../../../infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider';
import { LighterWebSocketProvider } from '../../../infrastructure/adapters/lighter/LighterWebSocketProvider';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { OrderSide, OrderType, PerpOrderRequest, TimeInForce } from '../../value-objects/PerpOrder';
import { RateLimiterService, RateLimitPriority } from '../../../infrastructure/services/RateLimiterService';

/**
 * MakerEfficiencyService - Ensures our orders are the most price-efficient on the book
 * 
 * TWO MODES:
 * 1. REACTIVE (NEW!): WebSocket callbacks trigger immediate reprice when outbid
 * 2. POLLING: Every 5s backup check for orders that missed reactive updates
 */
@Injectable()
export class MakerEfficiencyService implements OnModuleInit {
  private readonly logger = new Logger(MakerEfficiencyService.name);
  private isRunning = false;
  
  // Track active order book subscriptions (to avoid duplicate callbacks)
  private activeBookSubscriptions: Map<string, () => void> = new Map();
  
  // Debounce reactive reprices (avoid spamming on volatile books)
  private lastReactiveReprice: Map<string, number> = new Map();
  private readonly REACTIVE_DEBOUNCE_MS = 500; // Min 500ms between reactive reprices per order

  constructor(
    private readonly keeperService: PerpKeeperService,
    private readonly executionLockService: ExecutionLockService,
    private readonly hlWsProvider: HyperLiquidWebSocketProvider,
    private readonly lighterWsProvider: LighterWebSocketProvider,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  onModuleInit() {
    this.logger.log('🚀 MakerEfficiencyService initialized - REACTIVE + polling repricing');
    
    // Start watching for new orders to set up reactive callbacks
    this.setupReactiveCallbackWatcher();
  }
  
  /**
   * Watches for new orders and sets up reactive book callbacks
   */
  private setupReactiveCallbackWatcher() {
    // Check every 2s for new orders that need reactive callbacks
    setInterval(() => {
      this.updateReactiveSubscriptions();
    }, 2000);
  }
  
  /**
   * Updates reactive subscriptions based on current active orders
   */
  private updateReactiveSubscriptions() {
    const activeOrders = this.executionLockService.getAllActiveOrders();
    const waitingOrders = activeOrders.filter(o => 
      o.status === 'WAITING_FILL' && o.isForceFilling !== true
    );
    
    // Get current symbols with orders
    const currentOrderKeys = new Set(waitingOrders.map(o => `${o.exchange}-${o.symbol}`));
    
    // Unsubscribe from symbols no longer needed
    for (const [key, unsubscribe] of this.activeBookSubscriptions.entries()) {
      if (!currentOrderKeys.has(key)) {
        unsubscribe();
        this.activeBookSubscriptions.delete(key);
        this.logger.debug(`Unsubscribed from reactive book updates for ${key}`);
      }
    }
    
    // Subscribe to new symbols
    for (const order of waitingOrders) {
      const key = `${order.exchange}-${order.symbol}`;
      if (this.activeBookSubscriptions.has(key)) continue;
      
      const exchange = order.exchange as ExchangeType;
      
      if (exchange === ExchangeType.HYPERLIQUID) {
        const unsubscribe = this.hlWsProvider.onBookUpdate(order.symbol, (bestBid, bestAsk, coin) => {
          this.handleReactiveBookUpdate(ExchangeType.HYPERLIQUID, coin, bestBid, bestAsk);
        });
        this.activeBookSubscriptions.set(key, unsubscribe);
        this.logger.debug(`📡 Subscribed to reactive HL book updates for ${order.symbol}`);
      } else if (exchange === ExchangeType.LIGHTER) {
        // For Lighter, we need the market index
        const adapter = this.keeperService.getExchangeAdapter(ExchangeType.LIGHTER);
        if (adapter) {
          (adapter as any).getMarketIndex(order.symbol).then((marketIndex: number) => {
            const unsubscribe = this.lighterWsProvider.onBookUpdate(marketIndex, (bestBid, bestAsk, mktIdx) => {
              this.handleReactiveBookUpdate(ExchangeType.LIGHTER, order.symbol, bestBid, bestAsk);
            });
            this.activeBookSubscriptions.set(key, unsubscribe);
            this.logger.debug(`📡 Subscribed to reactive Lighter book updates for ${order.symbol}`);
          }).catch(() => {});
        }
      }
    }
  }
  
  /**
   * Handle a reactive book update - check if any of our orders need repricing
   */
  private async handleReactiveBookUpdate(exchange: ExchangeType, symbol: string, bestBid: number, bestAsk: number) {
    // Find orders for this symbol on this exchange
    const activeOrders = this.executionLockService.getAllActiveOrders();
    const relevantOrders = activeOrders.filter(o => 
      o.exchange === exchange && 
      o.symbol === symbol && 
      o.status === 'WAITING_FILL' &&
      o.isForceFilling !== true
    );
    
    if (relevantOrders.length === 0) return;
    
    for (const order of relevantOrders) {
      const orderKey = `${order.exchange}-${order.orderId}`;
      const now = Date.now();
      const lastReprice = this.lastReactiveReprice.get(orderKey) || 0;
      
      // Debounce - don't reprice same order too fast
      if (now - lastReprice < this.REACTIVE_DEBOUNCE_MS) continue;
      
      const currentPrice = order.price || 0;
      const needsReprice = 
        (order.side === 'LONG' && currentPrice < bestBid) ||
        (order.side === 'SHORT' && currentPrice > bestAsk);
      
      if (needsReprice) {
        this.lastReactiveReprice.set(orderKey, now);
        this.logger.log(
          `⚡ REACTIVE reprice: ${order.side} ${symbol} on ${exchange} - ` +
          `Our price ${currentPrice.toFixed(4)} is worse than book (bid=${bestBid.toFixed(4)}, ask=${bestAsk.toFixed(4)})`
        );
        
        // Trigger immediate reprice (bypass rate limit checks for reactive - they're already debounced)
        await this.checkAndRepositionOrder(order, true);
      }
    }
  }

  @Interval(5000) // Run every 5s (was 1s - too aggressive, causes rate limits)
  async manageMakerEfficiency() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const activeOrders = this.executionLockService.getAllActiveOrders();
      const waitingOrders = activeOrders.filter(o => 
        o.status === 'WAITING_FILL' && 
        o.isForceFilling !== true // Skip orders actively managed by PerpKeeperScheduler's aggressive fill logic
      );

      if (waitingOrders.length === 0) {
        this.isRunning = false;
        return;
      }

      // Sort by age - OLDEST ORDERS FIRST (they're at most risk of causing imbalances)
      const sortedOrders = [...waitingOrders].sort((a, b) => 
        a.placedAt.getTime() - b.placedAt.getTime()
      );

      // Group orders by exchange to handle specific rate limits
      const ordersByExchange = new Map<ExchangeType, ActiveOrder[]>();
      for (const order of sortedOrders) {
        const exchange = order.exchange as ExchangeType;
        if (!ordersByExchange.has(exchange)) ordersByExchange.set(exchange, []);
        ordersByExchange.get(exchange)!.push(order);
      }

      // Process exchanges in parallel for speed
      const exchangePromises = Array.from(ordersByExchange.entries()).map(
        ([exchange, orders]) => this.processExchangeEfficiency(exchange, orders)
      );
      await Promise.all(exchangePromises);
    } catch (error: any) {
      this.logger.error(`Error in MakerEfficiencyService: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  private lastExchangeCheck: Map<ExchangeType, number> = new Map();
  private lastOrderCheck: Map<string, number> = new Map(); // Track per-order check times

  private async processExchangeEfficiency(exchange: ExchangeType, orders: ActiveOrder[]) {
    const now = Date.now();
    const lastCheck = this.lastExchangeCheck.get(exchange) || 0;
    
    // 1. Get current budget health (1.0 = full, 0.0 = empty)
    const { budgetHealth } = this.rateLimiter.getUsage(exchange);
    
    // 2. Calculate base optimal interval based on exchange limits
    let baseIntervalMs = 10000; // Default 10s - conservative
    
    if (exchange === ExchangeType.HYPERLIQUID) {
      // Hyperliquid: Very permissive rate limits (1200/min)
      baseIntervalMs = 5000; // 5 seconds per order check
    } else if (exchange === ExchangeType.LIGHTER) {
      // Lighter: VERY strict limits (60/min = 1/sec)
      // Each modifyOrder = multiple API calls, so be very conservative
      baseIntervalMs = 15000; // 15 seconds per order check
    }

    // 3. For OLD orders (>60s), ALWAYS check regardless of health
    // Old orders are at risk of causing imbalances - TOP PRIORITY
    // Increased from 30s to 60s to reduce API pressure
    const urgentOrders = orders.filter(o => now - o.placedAt.getTime() > 60000);
    const normalOrders = orders.filter(o => now - o.placedAt.getTime() <= 30000);

    // 4. Process urgent orders IMMEDIATELY (no rate limit delay for orders >30s old)
    if (urgentOrders.length > 0) {
      this.logger.warn(
        `🚨 ${urgentOrders.length} URGENT unfilled order(s) on ${exchange} (>30s old) - repricing NOW`
      );
      for (const order of urgentOrders) {
        await this.checkAndRepositionOrder(order, true); // force=true
      }
    }

    // 5. Scale interval based on budget health (but less aggressively)
    // Health throttling should NOT delay urgent orders (handled above)
    let intervalMs = baseIntervalMs;
    if (budgetHealth < 0.5) {
      // Only slow down by max 2x (was 4x)
      const healthMultiplier = 1 + (0.5 - budgetHealth) * 2;
      intervalMs = baseIntervalMs * healthMultiplier;
    }

    if (now - lastCheck < intervalMs) return;
    this.lastExchangeCheck.set(exchange, now);
    
    if (budgetHealth < 0.3) {
      this.logger.warn(
        `⚠️ Low budget health for ${exchange} (${(budgetHealth * 100).toFixed(1)}%). ` +
        `Normal order repricing slowed: ${intervalMs/1000}s interval.`
      );
    }

    this.logger.debug(
      `Checking efficiency for ${normalOrders.length} normal orders on ${exchange} ` +
      `(Health: ${(budgetHealth * 100).toFixed(1)}%, Interval: ${intervalMs/1000}s)`
    );

    // Process normal orders (already sorted by age, oldest first)
    for (const order of normalOrders) {
      // Per-order throttling - don't recheck same order too fast
      const orderKey = `${order.exchange}-${order.orderId}`;
      const lastOrderCheck = this.lastOrderCheck.get(orderKey) || 0;
      if (now - lastOrderCheck < 2000) continue; // Min 2s between rechecks per order
      
      this.lastOrderCheck.set(orderKey, now);
      await this.checkAndRepositionOrder(order, false);
    }
  }

  private async checkAndRepositionOrder(activeOrder: ActiveOrder, force: boolean = false) {
    const exchange = activeOrder.exchange as ExchangeType;
    const symbol = activeOrder.symbol;
    const adapter = this.keeperService.getExchangeAdapter(exchange);
    const orderAgeMs = Date.now() - activeOrder.placedAt.getTime();
    const orderAgeSec = orderAgeMs / 1000;

    if (!adapter) return;

    // 1. Get real-time order book from WebSocket providers
    let bestBidAsk: { bestBid: number; bestAsk: number } | null = null;

    if (exchange === ExchangeType.HYPERLIQUID) {
      bestBidAsk = this.hlWsProvider.getBestBidAsk(symbol);
    } else if (exchange === ExchangeType.LIGHTER) {
      try {
        const marketIndex = await (adapter as any).getMarketIndex(symbol);
        bestBidAsk = this.lighterWsProvider.getBestBidAsk(marketIndex);
      } catch (e: any) {
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
    // For URGENT orders (force=true or >30s old), be MORE AGGRESSIVE
    let targetPrice = currentPrice;
    const isUrgent = force || orderAgeSec > 30;
    
    // Aggressive offset: 2 ticks for urgent, 1 tick for normal
    const aggressiveOffset = isUrgent ? tickSize * 2 : tickSize;

    if (activeOrder.side === 'LONG') {
      // For BUY orders, we want to be bestBid + tick(s)
      if (currentPrice < bestBid || (isUrgent && currentPrice <= bestBid)) {
        targetPrice = bestBid + aggressiveOffset;
      }
    } else {
      // For SELL orders, we want to be bestAsk - tick(s)
      if (currentPrice > bestAsk || (isUrgent && currentPrice >= bestAsk)) {
        targetPrice = bestAsk - aggressiveOffset;
      }
    }

    // 3. Reposition if target price changed significantly OR if forced
    const priceNeedsUpdate = Math.abs(targetPrice - currentPrice) > (tickSize / 2);
    if (priceNeedsUpdate || force) {
      // Ensure we don't cross the spread (don't buy above bestAsk or sell below bestBid)
      if (activeOrder.side === 'LONG' && targetPrice >= bestAsk) {
        targetPrice = bestAsk - tickSize;
      }
      if (activeOrder.side === 'SHORT' && targetPrice <= bestBid) {
        targetPrice = bestBid + tickSize;
      }

      const urgencyLabel = isUrgent ? '🚨 URGENT' : '🎯';
      this.logger.log(
        `${urgencyLabel} Repositioning ${activeOrder.side} ${symbol} on ${exchange}: ` +
        `${currentPrice.toFixed(4)} -> ${targetPrice.toFixed(4)} (Age: ${orderAgeSec.toFixed(0)}s)`
      );

      try {
        // Acquire a rate limit slot with HIGH priority for maker repositioning
        await this.rateLimiter.acquire(exchange, 1, RateLimitPriority.HIGH);

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
        
        // If the order no longer exists on the exchange, remove it from tracking
        // This prevents infinite retry loops for filled/cancelled orders
        if (
          error.message?.includes('already canceled') ||
          error.message?.includes('already cancelled') ||
          error.message?.includes('never placed') ||
          error.message?.includes('filled') ||
          error.message?.includes('Order not found') ||
          error.message?.includes('does not exist')
        ) {
          this.logger.warn(
            `🗑️ Order ${activeOrder.orderId} for ${symbol} no longer exists on ${exchange}, removing from tracking`
          );
          this.executionLockService.forceClearOrder(
            exchange,
            symbol,
            activeOrder.side as 'LONG' | 'SHORT'
          );
        }
      }
    }
  }
}

