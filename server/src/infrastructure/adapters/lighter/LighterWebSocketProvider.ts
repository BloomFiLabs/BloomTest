import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';

interface MarketStatsMessage {
  channel: string;
  market_stats: {
    market_id: number;
    index_price: string;
    mark_price: string;
    open_interest: string;
    last_trade_price: string;
    current_funding_rate: string;
    funding_rate: string;
    funding_timestamp: number;
    daily_base_token_volume: number;
    daily_quote_token_volume: number;
    daily_price_low: number;
    daily_price_high: number;
    daily_price_change: number;
  };
  type: string;
}

interface OrderBookLevel {
  price: string;
  size: string;
}

interface OrderBookMessage {
  channel: string;
  type: string;
  data: {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
  };
}

/**
 * Fill event from Lighter order updates
 */
export interface LighterFillEvent {
  orderId: string;
  marketIndex: number;
  side: 'bid' | 'ask'; // bid = Long, ask = Short
  price: string;
  size: string;
  filledSize: string;
  status: 'filled' | 'partially_filled' | 'canceled' | 'open';
  timestamp: number;
}

/**
 * Order update event from Lighter
 */
export interface LighterOrderUpdate {
  orderId: string;
  marketIndex: number;
  side: 'bid' | 'ask';
  status: 'filled' | 'partially_filled' | 'canceled' | 'open';
  size: string;
  filledSize: string;
  price: string;
}

/**
 * Callback for fill events
 */
export type LighterFillCallback = (fill: LighterFillEvent) => void;

/**
 * Callback for order update events
 */
export type LighterOrderUpdateCallback = (update: LighterOrderUpdate) => void;

interface WsMessage {
  channel?: string;
  type?: string;
  market_stats?: MarketStatsMessage['market_stats'];
  data?: any;
  market_id?: number;
  error?: { code: number; message: string };
}

/**
 * LighterWebSocketProvider - WebSocket-based market data and user event provider
 *
 * Subscribes to:
 * - market_stats: Real-time open interest and price updates
 * - order_book: Order book snapshots
 * - user_orders: Order status updates and fills (requires account address)
 *
 * Docs: https://apidocs.lighter.xyz/docs/websocket-reference#market-stats
 */
@Injectable()
export class LighterWebSocketProvider implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LighterWebSocketProvider.name);
  private readonly WS_URL = 'wss://mainnet.zklighter.elliot.ai/stream';

  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly RECONNECT_DELAY = 5000; // 5 seconds
  
  // Lighter has a limit of ~50-100 subscriptions per connection
  private readonly MAX_MARKET_STATS_SUBSCRIPTIONS = 50;

  // Cache for market stats data (key: marketIndex, value: { openInterest: number, markPrice: number, volume24h: number })
  private marketStatsCache: Map<
    number,
    { openInterest: number; markPrice: number; volume24h: number }
  > = new Map();
  private subscribedMarkets: Set<number> = new Set();
  private actuallySubscribedMarkets: Set<number> = new Set(); // Markets we've SENT subscription for
  
  // Cache for orderbook data (key: marketIndex, value: { bids, asks })
  private orderbookCache: Map<number, { bids: OrderBookLevel[]; asks: OrderBookLevel[] }> = new Map();
  private subscribedOrderbooks: Set<number> = new Set();

  // Track if we've received initial data for each market
  private hasInitialData: Set<number> = new Set();

  // Fill and order update callbacks
  private readonly fillCallbacks: LighterFillCallback[] = [];
  private readonly orderUpdateCallbacks: LighterOrderUpdateCallback[] = [];

  // User account address for order subscriptions
  private accountAddress: string | null = null;
  private accountIndex: number | null = null; // Lighter account index for subscriptions
  private isUserSubscribed = false;
  
  // NEW: Position and order caches from WebSocket
  // These eliminate the need for REST polling!
  private positionCache: Map<number, {
    marketId: number;
    symbol: string;
    size: number;
    sign: number; // 1 = long, -1 = short
    avgEntryPrice: number;
    unrealizedPnl: number;
    realizedPnl: number;
    liquidationPrice: number;
    marginMode: number;
    allocatedMargin: number;
    lastUpdated: Date;
  }> = new Map();
  
  private orderCache: Map<string, {
    orderId: string;
    marketIndex: number;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    filledSize: number;
    status: string;
    reduceOnly: boolean;
    lastUpdated: Date;
  }> = new Map();
  
  private isPositionsSubscribed = false;
  private isOrdersSubscribed = false;

  constructor(private readonly configService?: ConfigService) {
    // Try to get account address for user subscriptions
    if (configService) {
      const privateKey = configService.get<string>('PRIVATE_KEY') ||
        configService.get<string>('LIGHTER_PRIVATE_KEY');
      if (privateKey) {
        try {
          const { Wallet } = require('ethers');
          const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
          const wallet = new Wallet(normalizedKey);
          this.accountAddress = wallet.address;
          this.logger.log(`User order subscriptions enabled for: ${wallet.address.slice(0, 10)}...`);
        } catch (e: any) {
          this.logger.warn(`Could not derive account address: ${e.message}`);
        }
      }
    }
  }

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  /**
   * Connect to Lighter WebSocket
   */
  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Removed WebSocket connection log - only execution logs shown
        this.ws = new WebSocket(this.WS_URL);

        this.ws.on('open', () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          // Removed WebSocket connection log - only execution logs shown

          // Resubscribe to all markets we were tracking
          // Use setTimeout to ensure subscriptions happen after connection is fully established
          // Also gives time for markets to be discovered if discovery happens concurrently
          setTimeout(() => {
            if (this.subscribedMarkets.size > 0) {
              this.logger.log(
                `Resubscribing to ${this.subscribedMarkets.size} Lighter markets after connection...`,
              );
              this.resubscribeAll();
            } else {
              // Check again after a delay in case markets are discovered late
              setTimeout(() => {
                if (this.subscribedMarkets.size > 0 && this.actuallySubscribedMarkets.size === 0) {
                  this.logger.log(
                    `Markets discovered late - subscribing to up to ${this.MAX_MARKET_STATS_SUBSCRIPTIONS} Lighter markets...`,
                  );
                  this.resubscribeAll();
                }
              }, 2000);
            }
          }, 500); // Increased delay to allow markets to be discovered
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const rawMessage = data.toString();
            const message: WsMessage = JSON.parse(rawMessage);
            this.handleMessage(message);
          } catch (error: any) {
            this.logger.error(
              `Failed to parse WebSocket message: ${error.message}`,
            );
          }
        });

        // Handle WebSocket ping frames - respond with pong to keep connection alive
        this.ws.on('ping', (data: Buffer) => {
          try {
            if (this.ws && this.isConnected) {
              this.ws.pong(data);
            }
          } catch (error: any) {
            this.logger.debug(`Failed to send pong: ${error.message}`);
          }
        });

        this.ws.on('error', (error: Error) => {
          this.logger.error(`WebSocket error: ${error.message}`);
          this.isConnected = false;
          reject(error);
        });

        this.ws.on('close', () => {
          this.isConnected = false;
          // Removed WebSocket connection log - only execution logs shown

          // Attempt to reconnect (silently - only log on repeated failures)
          if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            this.reconnectAttempts++;
            // Only log on 3rd+ attempt to reduce noise
            if (this.reconnectAttempts >= 3) {
              this.logger.warn(
                `WebSocket reconnect attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}...`,
              );
            }
            setTimeout(() => this.connect(), this.RECONNECT_DELAY);
          } else {
            this.logger.error(
              'Max reconnection attempts reached. WebSocket will not reconnect.',
            );
          }
        });
      } catch (error: any) {
        this.logger.error(
          `Failed to create WebSocket connection: ${error.message}`,
        );
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket
   */
  private async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
      // Removed WebSocket disconnection log - only execution logs shown
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(message: WsMessage): void {
    // Handle ping/pong heartbeat - respond with pong to keep connection alive
    if (message.type === 'ping') {
      try {
        if (this.ws && this.isConnected) {
          this.ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (error: any) {
        this.logger.debug(`Failed to send pong: ${error.message}`);
      }
      return;
    }

    // Handle connected message (just acknowledge, don't log)
    if (message.type === 'connected') {
      return;
    }

    // Handle market_stats updates - check for market_stats field first (more reliable)
    if (message.market_stats) {
      // ... existing logic for market_stats ...
      const marketStats = message.market_stats;
      const marketIndex = marketStats.market_id;

      if (marketIndex === undefined) {
        this.logger.warn(
          `Received market_stats message without market_id: ${JSON.stringify(message)}`,
        );
        return;
      }

      try {
        const openInterestRaw = marketStats.open_interest || '0';
        const markPriceRaw = marketStats.mark_price || '0';
        const volume24hRaw = marketStats.daily_quote_token_volume || 0;
        const openInterest = parseFloat(openInterestRaw);
        const markPrice = parseFloat(markPriceRaw);
        const volume24h =
          typeof volume24hRaw === 'string'
            ? parseFloat(volume24hRaw)
            : volume24hRaw;

        if (markPrice > 0) {
          this.marketStatsCache.set(marketIndex, {
            openInterest: openInterest,
            markPrice: markPrice,
            volume24h: isNaN(volume24h) ? 0 : volume24h,
          });

          if (!this.hasInitialData.has(marketIndex)) {
            this.hasInitialData.add(marketIndex);
          }
        }
      } catch (error: any) {
        this.logger.error(
          `Failed to parse market_stats for market ${marketIndex}: ${error.message}`,
        );
      }
      return;
    }

    // Handle orderbook updates (channel format: order_book/{MARKET_INDEX})
    if ((message.channel?.startsWith('order_book/') || message.channel?.startsWith('order_book:')) && message.data) {
      const marketIndex = parseInt(message.channel.split(/[:/]/)[1]);
      
      if (!isNaN(marketIndex)) {
        this.orderbookCache.set(marketIndex, {
          bids: message.data.bids || [],
          asks: message.data.asks || []
        });
      }
      return;
    }

    // Handle user order updates
    if (message.channel?.startsWith('user_orders/') && message.data) {
      this.handleUserOrderUpdate(message.data);
      return;
    }

    // Handle account_all_positions updates (from WebSocket docs)
    // Channel: account_all_positions:{ACCOUNT_ID}
    if (message.type === 'update/account_all_positions' || 
        message.channel?.startsWith('account_all_positions:')) {
      this.handlePositionsUpdate(message);
      return;
    }

    // Handle account_all_orders updates (from WebSocket docs)
    // Channel: account_all_orders:{ACCOUNT_ID}
    if (message.type === 'update/account_all_orders' || 
        message.channel?.startsWith('account_all_orders:')) {
      this.handleOrdersUpdate(message);
      return;
    }

    // Handle other message types (subscription confirmations, etc.)
    if (message.type && message.channel) {
      // Only log subscription confirmations, not routine updates
      if (message.type === 'subscribed') {
        this.logger.debug(
          `WebSocket subscribed: channel=${message.channel}`,
        );
      }
      // Silently ignore update/market_stats and update/order_book - they're already handled above
    } else if (message.error) {
      // Silence expected errors at subscription limits
      const code = message.error.code;
      if (code === 30003 || code === 23001) {
        // 30003 = "Already Subscribed" - expected when resubscribing
        // 23001 = "Too Many Subscriptions" - expected at limit
        return;
      }
      if (code === 30009) {
        // 30009 = "Too Many Websocket Messages" - throttle warning, silent
        return;
      }
      // Log other errors
      this.logger.warn(
        `WebSocket error: code=${code}, message=${message.error.message}`,
      );
    }
    // Don't log unhandled messages - too noisy
  }

  /**
   * Subscribe to orderbook for a specific market
   */
  subscribeToOrderbook(marketIndex: number): void {
    if (this.subscribedOrderbooks.has(marketIndex)) {
      return;
    }

    this.subscribedOrderbooks.add(marketIndex);

    if (this.isConnected && this.ws) {
      const subscribeMessage = {
        type: 'subscribe',
        channel: `order_book/${marketIndex}`,
      };
      this.ws.send(JSON.stringify(subscribeMessage));
    }
  }

  /**
   * Get best bid/ask for a market
   */
  getBestBidAsk(marketIndex: number): { bestBid: number; bestAsk: number } | null {
    const book = this.orderbookCache.get(marketIndex);
    if (!book || book.bids.length === 0 || book.asks.length === 0) {
      if (!this.subscribedOrderbooks.has(marketIndex)) {
        this.subscribeToOrderbook(marketIndex);
      }
      return null;
    }

    return {
      bestBid: parseFloat(book.bids[0].price),
      bestAsk: parseFloat(book.asks[0].price)
    };
  }

  /**
   * Subscribe to market_stats for a specific market
   */
  subscribeToMarket(
    marketIndex: number,
    forceResubscribe: boolean = false,
  ): void {
    // Always track the subscription, even if WebSocket isn't connected yet
    this.subscribedMarkets.add(marketIndex);

    if (!this.isConnected || !this.ws) {
      return;
    }

    // Already sent subscription for this market? Skip unless forcing
    if (this.actuallySubscribedMarkets.has(marketIndex) && !forceResubscribe) {
      return;
    }

    // Check subscription limit
    if (this.actuallySubscribedMarkets.size >= this.MAX_MARKET_STATS_SUBSCRIPTIONS && !this.actuallySubscribedMarkets.has(marketIndex)) {
      return; // At limit, can't subscribe to more
    }

    // If we already have data for this market, skip
    if (!forceResubscribe && this.hasMarketData(marketIndex)) {
      return;
    }

    // Subscribe to the market
    try {
      const subscribeMessage = {
        type: 'subscribe',
        channel: `market_stats/${marketIndex}`,
      };

      if (!this.ws) {
        return;
      }

      this.ws.send(JSON.stringify(subscribeMessage));
      this.actuallySubscribedMarkets.add(marketIndex);
    } catch (error: any) {
      this.logger.error(
        `Failed to subscribe to market ${marketIndex}: ${error.message}`,
      );
    }
  }

  /**
   * Subscribe to multiple markets at once (with throttling to avoid rate limits)
   */
  subscribeToMarkets(marketIndexes: number[]): void {
    // Track all markets but only actually subscribe to top ones
    marketIndexes.forEach((index) => this.subscribedMarkets.add(index));

    if (!this.isConnected || !this.ws || this.ws.readyState !== 1) {
      return;
    }

    // Filter to markets we haven't subscribed to yet and limit to remaining capacity
    const remainingCapacity = this.MAX_MARKET_STATS_SUBSCRIPTIONS - this.actuallySubscribedMarkets.size;
    if (remainingCapacity <= 0) {
      return; // Already at max subscriptions
    }

    const marketsToSubscribe = marketIndexes
      .filter((index) => !this.actuallySubscribedMarkets.has(index))
      .slice(0, remainingCapacity);

    if (marketsToSubscribe.length > 0) {
      // Throttle subscriptions to avoid "Too Many Websocket Messages!" error
      const BATCH_SIZE = 3;
      const BATCH_DELAY_MS = 300;

      this.logger.log(`📡 Subscribing to ${marketsToSubscribe.length} Lighter markets (limit: ${this.MAX_MARKET_STATS_SUBSCRIPTIONS})...`);

      for (let i = 0; i < marketsToSubscribe.length; i += BATCH_SIZE) {
        const batch = marketsToSubscribe.slice(i, i + BATCH_SIZE);
        const delay = Math.floor(i / BATCH_SIZE) * BATCH_DELAY_MS;

        setTimeout(() => {
          batch.forEach((index) => this.subscribeToMarket(index, false));
        }, delay);
      }
    }
  }

  /**
   * Ensure all tracked markets are subscribed (useful when markets are discovered after connection)
   * Now respects subscription limits
   */
  ensureAllMarketsSubscribed(): void {
    if (!this.isConnected || !this.ws) {
      return;
    }

    if (this.subscribedMarkets.size === 0) {
      return;
    }

    // Filter to markets not yet actually subscribed and respect limit
    const remainingCapacity = this.MAX_MARKET_STATS_SUBSCRIPTIONS - this.actuallySubscribedMarkets.size;
    if (remainingCapacity <= 0) {
      return;
    }

    const marketsToSubscribe = Array.from(this.subscribedMarkets)
      .filter((index) => !this.actuallySubscribedMarkets.has(index))
      .slice(0, remainingCapacity);

    if (marketsToSubscribe.length > 0) {
      this.logger.log(
        `Ensuring ${marketsToSubscribe.length} Lighter markets are subscribed...`,
      );
      const BATCH_SIZE = 3;
      const BATCH_DELAY_MS = 300;

      for (let i = 0; i < marketsToSubscribe.length; i += BATCH_SIZE) {
        const batch = marketsToSubscribe.slice(i, i + BATCH_SIZE);
        const delay = Math.floor(i / BATCH_SIZE) * BATCH_DELAY_MS;

        setTimeout(() => {
          batch.forEach((index) => this.subscribeToMarket(index, false));
        }, delay);
      }
    }
  }

  /**
   * Resubscribe to all previously subscribed markets (with throttling)
   * Called after reconnection - clears tracking and resubscribes up to limit
   */
  private resubscribeAll(): void {
    // Clear tracking on reconnect - server doesn't remember our subscriptions
    this.actuallySubscribedMarkets.clear();
    
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 300;

    // Resubscribe to market stats (limited)
    const marketsToSubscribe = Array.from(this.subscribedMarkets).slice(0, this.MAX_MARKET_STATS_SUBSCRIPTIONS);
    if (marketsToSubscribe.length > 0) {
      this.logger.log(
        `Resubscribing to ${marketsToSubscribe.length} Lighter market stats (limit: ${this.MAX_MARKET_STATS_SUBSCRIPTIONS})...`,
      );

      for (let i = 0; i < marketsToSubscribe.length; i += BATCH_SIZE) {
        const batch = marketsToSubscribe.slice(i, i + BATCH_SIZE);
        const delay = Math.floor(i / BATCH_SIZE) * BATCH_DELAY_MS;

        setTimeout(() => {
          batch.forEach((index) => this.subscribeToMarket(index, false));
        }, delay);
      }
    }

    // DON'T resubscribe to orderbooks automatically - too expensive
    // Orderbook subscriptions will happen on-demand when needed
    if (this.subscribedOrderbooks.size > 0) {
      this.subscribedOrderbooks.clear();
    }

    // Resubscribe to user orders if we were subscribed
    if (this.isUserSubscribed && this.accountAddress) {
      this.isUserSubscribed = false; // Reset to allow resubscription
      this.subscribeToUserOrders();
    }
  }

  /**
   * Get open interest for a market from WebSocket cache
   * Returns undefined if not available
   */
  getOpenInterest(marketIndex: number): number | undefined {
    const stats = this.marketStatsCache.get(marketIndex);
    return stats?.openInterest;
  }

  /**
   * Get mark price for a market from WebSocket cache
   * Returns undefined if not available
   */
  getMarkPrice(marketIndex: number): number | undefined {
    const stats = this.marketStatsCache.get(marketIndex);
    return stats?.markPrice;
  }

  /**
   * Get 24-hour trading volume in USD for a market from WebSocket cache
   * Returns undefined if not available
   */
  get24hVolume(marketIndex: number): number | undefined {
    const stats = this.marketStatsCache.get(marketIndex);
    return stats?.volume24h;
  }

  /**
   * Check if WebSocket is connected
   */
  isWsConnected(): boolean {
    return this.isConnected && this.ws !== null && this.ws.readyState === 1;
  }

  /**
   * Check if we have data for a market
   */
  hasMarketData(marketIndex: number): boolean {
    return this.marketStatsCache.has(marketIndex);
  }

  /**
   * Register a callback for fill events
   * @param callback Function to call when a fill is received
   */
  onFill(callback: LighterFillCallback): void {
    this.fillCallbacks.push(callback);
    
    // Auto-subscribe to user orders if we have an account address
    if (!this.isUserSubscribed && this.accountAddress) {
      this.subscribeToUserOrders();
    }
  }

  /**
   * Register a callback for order update events
   * @param callback Function to call when an order is updated
   */
  onOrderUpdate(callback: LighterOrderUpdateCallback): void {
    this.orderUpdateCallbacks.push(callback);
    
    // Auto-subscribe to user orders if we have an account address
    if (!this.isUserSubscribed && this.accountAddress) {
      this.subscribeToUserOrders();
    }
  }

  /**
   * Subscribe to user order updates
   * Requires account address to be set
   */
  subscribeToUserOrders(): void {
    if (!this.accountAddress) {
      this.logger.warn('Cannot subscribe to user orders: no account address configured');
      return;
    }

    if (this.isUserSubscribed) {
      return;
    }

    if (this.isConnected && this.ws) {
      // Subscribe to user orders channel
      const subscription = {
        type: 'subscribe',
        channel: `user_orders/${this.accountAddress}`,
      };

      this.ws.send(JSON.stringify(subscription));
      this.isUserSubscribed = true;
      this.logger.log(`Subscribed to user orders for ${this.accountAddress.slice(0, 10)}...`);
    }
  }

  /**
   * Handle user order update message
   */
  private handleUserOrderUpdate(data: any): void {
    if (!data) return;

    const orderUpdate: LighterOrderUpdate = {
      orderId: data.order_id?.toString() || data.orderId?.toString() || '',
      marketIndex: data.market_id || data.marketIndex || 0,
      side: data.side === 'bid' || data.side === 'B' ? 'bid' : 'ask',
      status: this.mapOrderStatus(data.status),
      size: data.size?.toString() || '0',
      filledSize: data.filled_size?.toString() || data.filledSize?.toString() || '0',
      price: data.price?.toString() || '0',
    };

    // Emit order update
    for (const callback of this.orderUpdateCallbacks) {
      try {
        callback(orderUpdate);
      } catch (error: any) {
        this.logger.error(`Order update callback error: ${error.message}`);
      }
    }

    // If order is filled, also emit a fill event
    if (orderUpdate.status === 'filled' || orderUpdate.status === 'partially_filled') {
      const fillEvent: LighterFillEvent = {
        orderId: orderUpdate.orderId,
        marketIndex: orderUpdate.marketIndex,
        side: orderUpdate.side,
        price: orderUpdate.price,
        size: orderUpdate.size,
        filledSize: orderUpdate.filledSize,
        status: orderUpdate.status,
        timestamp: Date.now(),
      };

      this.logger.log(
        `📥 Lighter fill: market=${fillEvent.marketIndex} ${fillEvent.side === 'bid' ? 'LONG' : 'SHORT'} ` +
        `${fillEvent.filledSize}/${fillEvent.size} @ ${fillEvent.price} (oid: ${fillEvent.orderId})`
      );

      for (const callback of this.fillCallbacks) {
        try {
          callback(fillEvent);
        } catch (error: any) {
          this.logger.error(`Fill callback error: ${error.message}`);
        }
      }
    }
  }

  /**
   * Map Lighter order status to normalized status
   */
  private mapOrderStatus(status: string): LighterOrderUpdate['status'] {
    const normalized = status?.toLowerCase();
    if (normalized === 'filled' || normalized === 'fully_filled') return 'filled';
    if (normalized === 'partially_filled' || normalized === 'partial') return 'partially_filled';
    if (normalized === 'canceled' || normalized === 'cancelled') return 'canceled';
    return 'open';
  }

  /**
   * Remove a fill callback
   */
  removeFillCallback(callback: LighterFillCallback): void {
    const index = this.fillCallbacks.indexOf(callback);
    if (index > -1) {
      this.fillCallbacks.splice(index, 1);
    }
  }

  /**
   * Remove an order update callback
   */
  removeOrderUpdateCallback(callback: LighterOrderUpdateCallback): void {
    const index = this.orderUpdateCallbacks.indexOf(callback);
    if (index > -1) {
      this.orderUpdateCallbacks.splice(index, 1);
    }
  }

  /**
   * Get the account address for user subscriptions
   */
  getAccountAddress(): string | null {
    return this.accountAddress;
  }

  /**
   * Check if subscribed to user orders
   */
  isSubscribedToUserOrders(): boolean {
    return this.isUserSubscribed;
  }

  // ==================== NEW: Position & Order WebSocket Subscriptions ====================
  // These eliminate REST polling for getPositions() and getOpenOrders()
  // Based on: https://apidocs.lighter.xyz/docs/websocket-reference

  /**
   * Set the account index for position/order subscriptions
   * This is required because Lighter uses account index, not L1 address
   */
  setAccountIndex(index: number): void {
    this.accountIndex = index;
    this.logger.log(`Account index set to ${index} for WebSocket subscriptions`);
    
    // Auto-subscribe if connected
    if (this.isConnected && this.ws) {
      this.subscribeToPositions();
      this.subscribeToOrders();
    }
  }

  /**
   * Subscribe to account_all_positions channel
   * Provides real-time position updates, eliminating need for REST polling
   */
  subscribeToPositions(): void {
    if (!this.accountIndex) {
      this.logger.debug('Cannot subscribe to positions: no account index set');
      return;
    }

    if (this.isPositionsSubscribed) {
      return;
    }

    if (this.isConnected && this.ws) {
      const subscription = {
        type: 'subscribe',
        channel: `account_all_positions/${this.accountIndex}`,
      };

      this.ws.send(JSON.stringify(subscription));
      this.isPositionsSubscribed = true;
      this.logger.log(`📡 Subscribed to Lighter positions for account ${this.accountIndex}`);
    }
  }

  /**
   * Subscribe to account_all_orders channel
   * Provides real-time order updates, eliminating need for REST polling
   */
  subscribeToOrders(): void {
    if (!this.accountIndex) {
      this.logger.debug('Cannot subscribe to orders: no account index set');
      return;
    }

    if (this.isOrdersSubscribed) {
      return;
    }

    if (this.isConnected && this.ws) {
      const subscription = {
        type: 'subscribe',
        channel: `account_all_orders/${this.accountIndex}`,
      };

      this.ws.send(JSON.stringify(subscription));
      this.isOrdersSubscribed = true;
      this.logger.log(`📡 Subscribed to Lighter orders for account ${this.accountIndex}`);
    }
  }

  /**
   * Handle position updates from account_all_positions channel
   */
  private handlePositionsUpdate(message: any): void {
    const positions = message.positions || {};
    
    for (const [marketIdStr, posData] of Object.entries(positions)) {
      const marketId = parseInt(marketIdStr);
      const pos = posData as any;
      
      if (!pos) continue;
      
      const size = parseFloat(pos.position || '0');
      const sign = pos.sign || (size >= 0 ? 1 : -1);
      
      this.positionCache.set(marketId, {
        marketId,
        symbol: pos.symbol || `Market-${marketId}`,
        size: Math.abs(size),
        sign,
        avgEntryPrice: parseFloat(pos.avg_entry_price || '0'),
        unrealizedPnl: parseFloat(pos.unrealized_pnl || '0'),
        realizedPnl: parseFloat(pos.realized_pnl || '0'),
        liquidationPrice: parseFloat(pos.liquidation_price || '0'),
        marginMode: pos.margin_mode || 0,
        allocatedMargin: parseFloat(pos.allocated_margin || '0'),
        lastUpdated: new Date(),
      });
    }
    
    this.logger.debug(`📊 Updated ${Object.keys(positions).length} positions from WebSocket`);
  }

  /**
   * Handle order updates from account_all_orders channel
   */
  private handleOrdersUpdate(message: any): void {
    const orders = message.orders || {};
    
    // Clear existing orders and repopulate
    this.orderCache.clear();
    
    for (const [marketIdStr, marketOrders] of Object.entries(orders)) {
      const orderList = marketOrders as any[];
      if (!Array.isArray(orderList)) continue;
      
      for (const order of orderList) {
        const orderId = order.order_id?.toString() || order.order_index?.toString();
        if (!orderId) continue;
        
        this.orderCache.set(orderId, {
          orderId,
          marketIndex: parseInt(marketIdStr),
          side: order.is_ask ? 'sell' : 'buy',
          price: parseFloat(order.price || '0'),
          size: parseFloat(order.initial_base_amount || '0'),
          filledSize: parseFloat(order.filled_base_amount || '0'),
          status: order.status || 'open',
          reduceOnly: order.reduce_only || false,
          lastUpdated: new Date(),
        });
      }
    }
    
    this.logger.debug(`📋 Updated ${this.orderCache.size} orders from WebSocket`);
  }

  /**
   * Get all cached positions (from WebSocket)
   * Returns null if not subscribed or no data yet
   */
  getCachedPositions(): Map<number, {
    marketId: number;
    symbol: string;
    size: number;
    sign: number;
    avgEntryPrice: number;
    unrealizedPnl: number;
    realizedPnl: number;
    liquidationPrice: number;
    marginMode: number;
    allocatedMargin: number;
    lastUpdated: Date;
  }> | null {
    if (!this.isPositionsSubscribed || this.positionCache.size === 0) {
      return null;
    }
    return this.positionCache;
  }

  /**
   * Get all cached open orders (from WebSocket)
   * Returns null if not subscribed or no data yet
   */
  getCachedOrders(): Map<string, {
    orderId: string;
    marketIndex: number;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    filledSize: number;
    status: string;
    reduceOnly: boolean;
    lastUpdated: Date;
  }> | null {
    if (!this.isOrdersSubscribed || this.orderCache.size === 0) {
      return null;
    }
    return this.orderCache;
  }

  /**
   * Check if we have fresh position data from WebSocket
   */
  hasPositionData(): boolean {
    if (!this.isPositionsSubscribed) return false;
    
    // Check if any position was updated in the last 30 seconds
    const now = Date.now();
    for (const pos of this.positionCache.values()) {
      if (now - pos.lastUpdated.getTime() < 30000) {
        return true;
      }
    }
    return this.positionCache.size > 0;
  }

  /**
   * Check if we have fresh order data from WebSocket
   */
  hasOrderData(): boolean {
    if (!this.isOrdersSubscribed) return false;
    
    // Check if any order was updated in the last 30 seconds
    const now = Date.now();
    for (const order of this.orderCache.values()) {
      if (now - order.lastUpdated.getTime() < 30000) {
        return true;
      }
    }
    return this.orderCache.size > 0 || this.isOrdersSubscribed;
  }

  /**
   * Check if subscribed to positions
   */
  isSubscribedToPositions(): boolean {
    return this.isPositionsSubscribed;
  }

  /**
   * Check if subscribed to orders
   */
  isSubscribedToAllOrders(): boolean {
    return this.isOrdersSubscribed;
  }
}
