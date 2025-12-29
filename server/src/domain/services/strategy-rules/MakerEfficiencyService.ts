import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PerpKeeperService } from '../../../application/services/PerpKeeperService';
import { ExecutionLockService, ActiveOrder } from '../../../infrastructure/services/ExecutionLockService';
import { HyperLiquidWebSocketProvider } from '../../../infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider';
import { LighterWebSocketProvider } from '../../../infrastructure/adapters/lighter/LighterWebSocketProvider';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { OrderSide, OrderType, OrderStatus, PerpOrderRequest, TimeInForce } from '../../value-objects/PerpOrder';
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
        this.logger.log(`📡 Subscribed to reactive HL book updates for ${order.symbol}`);
      } else if (exchange === ExchangeType.LIGHTER) {
        // For Lighter, we need the market index
        const adapter = this.keeperService.getExchangeAdapter(ExchangeType.LIGHTER);
        if (adapter) {
          (adapter as any).getMarketIndex(order.symbol).then((marketIndex: number) => {
            // Verify we can get orderbook data before subscribing
            const testBook = this.lighterWsProvider.getBestBidAsk(marketIndex);
            if (!testBook) {
              this.logger.warn(`⚠️ No orderbook data available yet for ${order.symbol} (marketIndex: ${marketIndex}), subscription may not work`);
            }
            
            const unsubscribe = this.lighterWsProvider.onBookUpdate(marketIndex, (bestBid, bestAsk, mktIdx) => {
              this.handleReactiveBookUpdate(ExchangeType.LIGHTER, order.symbol, bestBid, bestAsk);
            });
            this.activeBookSubscriptions.set(key, unsubscribe);
            this.logger.log(`📡 Subscribed to reactive Lighter book updates for ${order.symbol} (marketIndex: ${marketIndex})`);
          }).catch((error: any) => {
            this.logger.error(`❌ Failed to subscribe to reactive Lighter book updates for ${order.symbol}: ${error.message}`);
          });
        } else {
          this.logger.error(`❌ No Lighter adapter available to subscribe for ${order.symbol}`);
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
    
    if (relevantOrders.length === 0) {
      this.logger.debug(`Reactive update for ${symbol} on ${exchange}: no active orders`);
      return;
    }
    
    for (const order of relevantOrders) {
      const orderKey = `${order.exchange}-${order.orderId}`;
      const now = Date.now();
      const lastReprice = this.lastReactiveReprice.get(orderKey) || 0;
      
      // Debounce - don't reprice same order too fast
      if (now - lastReprice < this.REACTIVE_DEBOUNCE_MS) {
        this.logger.debug(`Reactive update for ${symbol} debounced (${now - lastReprice}ms since last reprice)`);
        continue;
      }
      
      const currentPrice = order.price || 0;
      // More aggressive: reprice if we're not competitive (equal or worse than book)
      const needsReprice = 
        (order.side === 'LONG' && currentPrice <= bestBid) ||
        (order.side === 'SHORT' && currentPrice >= bestAsk);
      
      if (needsReprice) {
        this.lastReactiveReprice.set(orderKey, now);
        const distance = order.side === 'LONG' 
          ? ((bestBid - currentPrice) / currentPrice * 100).toFixed(2)
          : ((currentPrice - bestAsk) / currentPrice * 100).toFixed(2);
        this.logger.log(
          `⚡ REACTIVE reprice: ${order.side} ${symbol} on ${exchange} - ` +
          `Our price ${currentPrice.toFixed(4)} is ${needsReprice ? 'worse' : 'equal'} than book ` +
          `(bid=${bestBid.toFixed(4)}, ask=${bestAsk.toFixed(4)}, ${distance}% away)`
        );
        
        // Trigger immediate reprice (bypass rate limit checks for reactive - they're already debounced)
        await this.checkAndRepositionOrder(order, true);
      } else {
        this.logger.debug(
          `Reactive update for ${order.side} ${symbol}: price ${currentPrice.toFixed(4)} is competitive ` +
          `(bid=${bestBid.toFixed(4)}, ask=${bestAsk.toFixed(4)})`
        );
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

    // 3. Process ALL orders - repricing should continue until FULLY filled
    // No age limits - orders should be repriced until they fill completely
    // Urgent orders (>60s) get priority but all orders are processed
    
    // 5. Scale interval based on budget health (but less aggressively)
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
        `Order repricing slowed: ${intervalMs/1000}s interval.`
      );
    }

    // Separate urgent vs normal for logging, but process ALL orders
    const urgentOrders = orders.filter(o => now - o.placedAt.getTime() > 60000);
    const normalOrders = orders.filter(o => now - o.placedAt.getTime() <= 60000);

    if (urgentOrders.length > 0) {
      this.logger.warn(
        `🚨 ${urgentOrders.length} URGENT unfilled order(s) on ${exchange} (>60s old) - repricing NOW`
      );
    }

    this.logger.debug(
      `Checking efficiency for ${orders.length} orders on ${exchange} ` +
      `(${urgentOrders.length} urgent, ${normalOrders.length} normal, Health: ${(budgetHealth * 100).toFixed(1)}%, Interval: ${intervalMs/1000}s)`
    );

    // Process ALL orders (already sorted by age, oldest first)
    // Repricing continues until orders are FULLY filled
    for (const order of orders) {
      // Per-order throttling - don't recheck same order too fast
      const orderKey = `${order.exchange}-${order.orderId}`;
      const lastOrderCheck = this.lastOrderCheck.get(orderKey) || 0;
      if (now - lastOrderCheck < 2000) continue; // Min 2s between rechecks per order
      
      this.lastOrderCheck.set(orderKey, now);
      const isUrgent = now - order.placedAt.getTime() > 60000;
      await this.checkAndRepositionOrder(order, isUrgent); // force=true for urgent orders
    }
  }

  private async checkAndRepositionOrder(activeOrder: ActiveOrder, force: boolean = false) {
    const exchange = activeOrder.exchange as ExchangeType;
    const symbol = activeOrder.symbol;
    const adapter = this.keeperService.getExchangeAdapter(exchange);
    const orderAgeMs = Date.now() - activeOrder.placedAt.getTime();
    const orderAgeSec = orderAgeMs / 1000;

    if (!adapter) return;

    // CRITICAL: Check if order is FULLY filled - if so, stop repricing
    try {
      const orderStatus = await adapter.getOrderStatus(activeOrder.orderId, symbol);
      const orderSize = activeOrder.size || 0;
      const filledSize = orderStatus.filledSize || 0;
      
      // If order is fully filled (within 0.1% tolerance for rounding), stop repricing
      if (orderStatus.status === OrderStatus.FILLED || 
          (orderSize > 0 && filledSize >= orderSize * 0.999)) {
        this.logger.log(
          `✅ Order ${activeOrder.orderId} for ${symbol} is FULLY FILLED ` +
          `(${filledSize.toFixed(4)}/${orderSize.toFixed(4)}) - stopping repricing`
        );
        // Update order status to FILLED
        if (this.executionLockService) {
          this.executionLockService.updateOrderStatus(
            exchange,
            symbol,
            activeOrder.side,
            'FILLED',
            activeOrder.orderId
          );
        }
        return; // Stop repricing - order is done
      }
    } catch (error: any) {
      // If we can't check status, continue with repricing (better safe than sorry)
      this.logger.debug(`Could not check order status for ${symbol}: ${error.message}`);
    }

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
          // Try fallback to adapter's getBestBidAsk if WebSocket data unavailable
          try {
            // Check if adapter has getBestBidAsk method (not all adapters do)
            if ('getBestBidAsk' in adapter && typeof (adapter as any).getBestBidAsk === 'function') {
              bestBidAsk = await (adapter as any).getBestBidAsk(symbol);
            }
            if (!bestBidAsk) {
              this.logger.warn(`⚠️ REPRICE: No orderbook data available for ${symbol} on ${exchange} (order age: ${orderAgeSec.toFixed(0)}s)`);
              return;
            }
            this.logger.log(`📡 REPRICE: Using REST fallback for orderbook data: ${symbol} on ${exchange} (bid=${bestBidAsk.bestBid.toFixed(4)}, ask=${bestBidAsk.bestAsk.toFixed(4)})`);
          } catch (e: any) {
            this.logger.warn(`⚠️ REPRICE: Failed to get orderbook data for ${symbol} on ${exchange}: ${e.message}`);
            return;
          }
        }

    const { bestBid, bestAsk } = bestBidAsk;
    const currentPrice = activeOrder.price || 0;
    const tickSize = await adapter.getTickSize(symbol);

    // Log current state for debugging
    if (orderAgeSec > 30) {
      this.logger.debug(
        `📊 Order check: ${activeOrder.side} ${symbol} @ ${currentPrice.toFixed(4)} | ` +
        `Book: bid=${bestBid.toFixed(4)}, ask=${bestAsk.toFixed(4)} | Age: ${orderAgeSec.toFixed(0)}s`
      );
    }

    // 2. Determine target price to be the best maker
    // For URGENT orders (force=true or >30s old), be MORE AGGRESSIVE
    let targetPrice = currentPrice;
    const isUrgent = force || orderAgeSec > 30;
    
    // Aggressive offset: 2 ticks for urgent, 1 tick for normal
    const aggressiveOffset = isUrgent ? tickSize * 2 : tickSize;

    // Check if order is far from book (more than 2 ticks away)
    // isFarFromBook: price is too PASSIVE (too low for long, too high for short)
    const isFarFromBook = activeOrder.side === 'LONG' 
      ? (currentPrice < bestBid - tickSize * 2)
      : (currentPrice > bestAsk + tickSize * 2);

    // isFarInsideBook: price is too AGGRESSIVE (too high for long, too low for short)
    // This often means the order has already filled but the exchange hasn't confirmed it,
    // OR the market data is stale.
    const isFarInsideBook = activeOrder.side === 'LONG'
      ? (currentPrice > bestAsk + tickSize * 2)
      : (currentPrice < bestBid - tickSize * 2);

    if (activeOrder.side === 'LONG') {
      // For BUY orders, we want to be bestBid + tick(s)
      // Always reprice if we're worse than or equal to the book (below or equal to bestBid)
      // OR if we're far from the book (too passive or too aggressive)
      if (currentPrice <= bestBid || isFarFromBook || isFarInsideBook) {
        targetPrice = bestBid + aggressiveOffset;
      }
    } else {
      // For SELL orders, we want to be bestAsk - tick(s)
      // Always reprice if we're worse than or equal to the book (above or equal to bestAsk)
      // OR if we're far from the book (too passive or too aggressive)
      if (currentPrice >= bestAsk || isFarFromBook || isFarInsideBook) {
        targetPrice = bestAsk - aggressiveOffset;
      }
    }

    // 3. Reposition if target price changed significantly OR if forced
    const priceDiff = Math.abs(targetPrice - currentPrice);
    const priceNeedsUpdate = priceDiff > (tickSize / 2) || force || isFarFromBook || isFarInsideBook;
    if (priceNeedsUpdate || force) {
      // Ensure we don't cross the spread (don't buy above bestAsk or sell below bestBid)
      if (activeOrder.side === 'LONG' && targetPrice >= bestAsk) {
        targetPrice = bestAsk - tickSize;
      }
      if (activeOrder.side === 'SHORT' && targetPrice <= bestBid) {
        targetPrice = bestBid + tickSize;
      }

      const urgencyLabel = isUrgent ? '🚨 URGENT' : '🎯';
      const distanceFromBook = activeOrder.side === 'LONG' 
        ? ((bestBid - currentPrice) / currentPrice * 100).toFixed(2)
        : ((currentPrice - bestAsk) / currentPrice * 100).toFixed(2);
      const priceChangePct = ((targetPrice - currentPrice) / currentPrice * 100).toFixed(3);
      this.logger.log(
        `${urgencyLabel} REPRICE ${activeOrder.side} ${symbol} on ${exchange}: ` +
        `${currentPrice.toFixed(4)} → ${targetPrice.toFixed(4)} ` +
        `(${priceChangePct}%, Age: ${orderAgeSec.toFixed(0)}s, ${distanceFromBook}% from book) ` +
        `[Book: bid=${bestBid.toFixed(4)}, ask=${bestAsk.toFixed(4)}]`
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
          this.logger.log(
            `✅ REPRICE SUCCESS ${symbol} ${activeOrder.side} on ${exchange}: ` +
            `New order ${response.orderId.substring(0, 16)}... @ ${targetPrice.toFixed(4)}`
          );
        }
      } catch (error: any) {
        this.logger.error(`Failed to reposition order for ${symbol}: ${error.message}`);
        
        // If the order no longer exists on the exchange, we need to determine if it was:
        // 1. FILLED - position should have increased
        // 2. CANCELLED - position unchanged
        // NEVER trust error messages - always verify via position delta
        if (
          error.message?.includes('already canceled') ||
          error.message?.includes('already cancelled') ||
          error.message?.includes('never placed') ||
          error.message?.includes('filled') ||
          error.message?.includes('Order not found') ||
          error.message?.includes('does not exist')
        ) {
          await this.handleDisappearedOrder(exchange, symbol, activeOrder);
        }
      }
    }
  }
  
  /**
   * When an order disappears (modify fails), check position to determine if it was filled or cancelled.
   * NEVER trust error messages - only trust position changes.
   * 
   * IMPORTANT: If we don't have initial position data, we CANNOT reliably determine
   * if the order was filled. In that case, we should NOT force clear - let the 
   * normal execution flow handle it (waitForOrderFill will eventually timeout or detect via other means).
   */
  private async handleDisappearedOrder(
    exchange: ExchangeType,
    symbol: string,
    activeOrder: ActiveOrder
  ): Promise<void> {
    try {
      // If we don't have initial position size, we can't reliably determine fill status
      // Don't force clear - the execution service's waitForOrderFill will handle it
      if (activeOrder.initialPositionSize === undefined) {
        this.logger.warn(
          `⚠️ Order ${activeOrder.orderId} for ${symbol} disappeared but no initialPositionSize tracked. ` +
          `Leaving order in tracking - waitForOrderFill will handle via position delta check.`
        );
        return;
      }
      
      // Get current position to check if order was filled
      const adapter = this.keeperService.getExchangeAdapter(exchange);
      const positions = await adapter.getPositions();
      const position = positions.find(p => p.symbol === symbol && p.side === (activeOrder.side === 'LONG' ? 'LONG' : 'SHORT'));
      
      const currentSize = position ? Math.abs(position.size) : 0;
      const expectedSize = activeOrder.size || 0;
      const initialSize = activeOrder.initialPositionSize;
      
      // Calculate position delta since order was placed
      const positionDelta = currentSize - initialSize;
      
      // If position increased by at least 50% of expected size, consider it filled
      // (partial fills count as fills)
      const fillThreshold = expectedSize * 0.5;
      const wasFilled = positionDelta >= fillThreshold;
      
      if (wasFilled) {
        this.logger.log(
          `✅ Order ${activeOrder.orderId} for ${symbol} FILLED (position delta: ${positionDelta.toFixed(4)}, ` +
          `initial: ${initialSize.toFixed(4)}, current: ${currentSize.toFixed(4)})`
        );
        this.executionLockService.updateOrderStatus(
          exchange,
          symbol,
          activeOrder.side as 'LONG' | 'SHORT',
          'FILLED',
          activeOrder.orderId
        );
      } else {
        // Only force clear if we're confident the order was NOT filled
        // This means: we have initial position data AND delta is near zero
        this.logger.warn(
          `🗑️ Order ${activeOrder.orderId} for ${symbol} CANCELLED (no position change: ` +
          `delta=${positionDelta.toFixed(4)}, initial=${initialSize.toFixed(4)}, current=${currentSize.toFixed(4)})`
        );
        this.executionLockService.forceClearOrder(
          exchange,
          symbol,
          activeOrder.side as 'LONG' | 'SHORT'
        );
      }
    } catch (positionError: any) {
      this.logger.error(`Failed to check position for ${symbol}: ${positionError.message}`);
      // If we can't check position, DON'T force clear - let waitForOrderFill handle it
      // Force clearing could cause us to lose track of a filled order
      this.logger.warn(
        `⚠️ Cannot determine fill status for ${activeOrder.orderId}. Leaving in tracking.`
      );
    }
  }
}

