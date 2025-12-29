import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  LighterWebSocketSendTx,
  LighterWebSocketSendBatchTx,
} from './types';

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
  order_book: {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    nonce?: number;
    begin_nonce?: number;
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
  order_book?: OrderBookMessage['order_book'];
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
export class LighterWebSocketProvider 
  extends EventEmitter
  implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LighterWebSocketProvider.name);
  private readonly WS_URL = 'wss://mainnet.zklighter.elliot.ai/stream';

  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly RECONNECT_DELAY = 5000; // 5 seconds
  
  // Use market_stats/all instead of individual subscriptions to avoid rate limits
  private isSubscribedToAllMarkets = false;

  // Cache for market stats data (key: marketIndex, value: { openInterest: number, markPrice: number, volume24h: number })
  private marketStatsCache: Map<
    number,
    { openInterest: number; markPrice: number; volume24h: number }
  > = new Map();
  private subscribedMarkets: Set<number> = new Set();
  private actuallySubscribedMarkets: Set<number> = new Set(); // Markets we've SENT subscription for
  
  // Cache for orderbook data (key: marketIndex, value: { bids: Map<price, size>, asks: Map<price, size> })
  private orderbookCache: Map<number, { bids: Map<string, string>; asks: Map<string, string> }> = new Map();
  private subscribedOrderbooks: Set<number> = new Set();

  // Track if we've received initial data for each market
  private hasInitialData: Set<number> = new Set();

  // Fill and order update callbacks
  private readonly fillCallbacks: LighterFillCallback[] = [];
  private readonly orderUpdateCallbacks: LighterOrderUpdateCallback[] = [];
  
  // ==================== NEW: Order book update callbacks ====================
  // For reactive repricing when someone outbids us
  private readonly bookUpdateCallbacks: Map<number, Array<(bestBid: number, bestAsk: number, marketIndex: number) => void>> = new Map();

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
  private hasReceivedPositionSnapshot = false; // True once we receive any position update (even empty)

  // Transaction sending support
  private pendingTransactions: Map<string, {
    resolve: (hash: string | string[]) => void;
    reject: (error: Error) => void;
    timestamp: number;
  }> = new Map();
  private transactionRequestId = 0;
  private readonly TRANSACTION_TIMEOUT_MS = 30000; // 30 seconds timeout
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(private readonly configService?: ConfigService) {
    super();
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

          // Start cleanup interval for stale transactions
          if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
          }
          this.cleanupInterval = setInterval(() => {
            this.cleanupStaleTransactions();
          }, 5000); // Clean up every 5 seconds

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
                if (!this.isSubscribedToAllMarkets) {
                  this.logger.log(
                    `Markets discovered late - subscribing to Lighter market_stats/all...`,
                  );
                  this.subscribeToAllMarkets();
                }
              }, 2000);
            }
            
            // Subscribe to positions/orders if account index is set
            if (this.accountIndex && !this.isPositionsSubscribed) {
              this.subscribeToPositions();
              this.subscribeToOrders();
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
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Reject all pending transactions
    for (const [id, pending] of this.pendingTransactions.entries()) {
      pending.reject(new Error('WebSocket disconnected'));
    }
    this.pendingTransactions.clear();

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

    // Handle market_stats updates - supports both single market and "all" subscription formats
    if (message.market_stats) {
      const marketStats = message.market_stats;
      
      // Check if this is a market_stats/all response (object keyed by market index)
      // vs single market response (has market_id directly)
      if (message.channel === 'market_stats:all' || (typeof marketStats === 'object' && !marketStats.market_id)) {
        // Handle market_stats/all format: { "1": {...}, "2": {...}, ... }
        for (const [indexStr, stats] of Object.entries(marketStats)) {
          const marketIndex = parseInt(indexStr);
          if (isNaN(marketIndex)) continue;
          
          const statsData = stats as any;
          try {
            const openInterestRaw = statsData.open_interest || '0';
            const markPriceRaw = statsData.mark_price || '0';
            const volume24hRaw = statsData.daily_quote_token_volume || 0;
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
        }
        return;
      }
      
      // Handle single market format (has market_id directly)
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
    // Support both 'order_book' property (from docs) and 'data' property (legacy/fallback)
    if ((message.channel?.startsWith('order_book/') || message.channel?.startsWith('order_book:')) && (message.order_book || message.data)) {
      const marketIndex = parseInt(message.channel.split(/[:/]/)[1]);
      
      if (!isNaN(marketIndex)) {
        const orderBookData = message.order_book || message.data;
        const bids = orderBookData.bids || [];
        const asks = orderBookData.asks || [];
        
        let cached = this.orderbookCache.get(marketIndex);
        if (!cached) {
          cached = { bids: new Map(), asks: new Map() };
          this.orderbookCache.set(marketIndex, cached);
        }

        // Apply bid updates (snapshot or delta)
        for (const level of bids) {
          const price = level.price || (level as any).p;
          const size = level.size || (level as any).s;
          if (!price) continue;
          
          if (parseFloat(size || '0') <= 0) {
            cached.bids.delete(price);
          } else {
            cached.bids.set(price, size);
          }
        }

        // Apply ask updates (snapshot or delta)
        for (const level of asks) {
          const price = level.price || (level as any).p;
          const size = level.size || (level as any).s;
          if (!price) continue;
          
          if (parseFloat(size || '0') <= 0) {
            cached.asks.delete(price);
          } else {
            cached.asks.set(price, size);
          }
        }
        
        // REACTIVE: Trigger callbacks for order book updates
        const callbacks = this.bookUpdateCallbacks.get(marketIndex);
        if (callbacks && callbacks.length > 0) {
          const bestBidAsk = this.getBestBidAsk(marketIndex);
          if (bestBidAsk) {
            for (const callback of callbacks) {
              try {
                callback(bestBidAsk.bestBid, bestBidAsk.bestAsk, marketIndex);
              } catch (e: any) {
                this.logger.error(`Error in book update callback for market ${marketIndex}: ${e.message}`);
              }
            }
          }
        }
      }
      return;
    }

    // Handle user order updates
    if (message.channel?.startsWith('user_orders/') && message.data) {
      this.handleUserOrderUpdate(message.data);
      return;
    }

    // Handle account_all_positions updates (from WebSocket docs)
    // Channel format can be account_all_positions/{ACCOUNT_ID} or account_all_positions:{ACCOUNT_ID}
    if (message.type === 'update/account_all_positions' || 
        message.channel?.startsWith('account_all_positions/') ||
        message.channel?.startsWith('account_all_positions:')) {
      this.handlePositionsUpdate(message);
      return;
    }

    // Handle account_all_orders updates (from WebSocket docs)
    // Channel format can be account_all_orders/{ACCOUNT_ID} or account_all_orders:{ACCOUNT_ID}
    if (message.type === 'update/account_all_orders' || 
        message.channel?.startsWith('account_all_orders/') ||
        message.channel?.startsWith('account_all_orders:')) {
      this.handleOrdersUpdate(message);
      return;
    }

    // Handle transaction responses (from sendtx/sendtxbatch)
    if (message.type === 'jsonapi/sendtx_response' || message.type === 'jsonapi/sendtxbatch_response') {
      this.handleTransactionResponse(message);
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
    if (!book || book.bids.size === 0 || book.asks.size === 0) {
      if (!this.subscribedOrderbooks.has(marketIndex)) {
        this.subscribeToOrderbook(marketIndex);
      }
      return null;
    }

    // Find best bid (highest price)
    let bestBid = -1;
    for (const priceStr of book.bids.keys()) {
      const price = parseFloat(priceStr);
      if (price > bestBid) bestBid = price;
    }

    // Find best ask (lowest price)
    let bestAsk = Number.MAX_VALUE;
    for (const priceStr of book.asks.keys()) {
      const price = parseFloat(priceStr);
      if (price < bestAsk) bestAsk = price;
    }

    if (bestBid === -1 || bestAsk === Number.MAX_VALUE) {
      return null;
    }

    return {
      bestBid,
      bestAsk
    };
  }

  /**
   * Register a callback for order book updates (reactive repricing)
   * Called immediately when the book changes - use for fast repricing!
   */
  onBookUpdate(marketIndex: number, callback: (bestBid: number, bestAsk: number, marketIndex: number) => void): () => void {
    // Auto-subscribe to the orderbook if not already
    if (!this.subscribedOrderbooks.has(marketIndex)) {
      this.subscribeToOrderbook(marketIndex);
    }
    
    // Add callback
    if (!this.bookUpdateCallbacks.has(marketIndex)) {
      this.bookUpdateCallbacks.set(marketIndex, []);
    }
    this.bookUpdateCallbacks.get(marketIndex)!.push(callback);
    
    this.logger.debug(`Registered book update callback for market ${marketIndex}`);
    
    // Return unsubscribe function
    return () => {
      const callbacks = this.bookUpdateCallbacks.get(marketIndex);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) {
          callbacks.splice(index, 1);
        }
      }
    };
  }

  /**
   * Subscribe to market_stats for a specific market
   * Now just tracks the market and ensures market_stats/all is subscribed
   */
  subscribeToMarket(
    marketIndex: number,
    forceResubscribe: boolean = false,
  ): void {
    // Track the market
    this.subscribedMarkets.add(marketIndex);
    
    // Use market_stats/all for efficiency
    this.subscribeToAllMarkets();
  }

  /**
   * Subscribe to multiple markets at once
   * Now uses market_stats/all for efficiency - just tracks markets and ensures subscription
   */
  subscribeToMarkets(marketIndexes: number[]): void {
    // Track all markets
    marketIndexes.forEach((index) => this.subscribedMarkets.add(index));

    // Use market_stats/all instead of individual subscriptions
    this.subscribeToAllMarkets();
  }

  /**
   * Ensure all tracked markets are subscribed (useful when markets are discovered after connection)
   * Now uses market_stats/all for efficiency
   */
  ensureAllMarketsSubscribed(): void {
    // Just subscribe to market_stats/all - it covers all markets
    this.subscribeToAllMarkets();
  }

  /**
   * Subscribe to market_stats/all - gets ALL market data in one subscription
   * This is much more efficient than subscribing to individual markets
   */
  private subscribeToAllMarkets(): void {
    if (!this.isConnected || !this.ws || this.ws.readyState !== 1) {
      return;
    }

    if (this.isSubscribedToAllMarkets) {
      return;
    }

    try {
      const subscribeMessage = {
        type: 'subscribe',
        channel: 'market_stats/all',
      };

      this.ws.send(JSON.stringify(subscribeMessage));
      this.isSubscribedToAllMarkets = true;
      this.logger.log('📡 Subscribed to Lighter market_stats/all - receiving all markets in one stream');
    } catch (error: any) {
      this.logger.error(`Failed to subscribe to market_stats/all: ${error.message}`);
    }
  }

  /**
   * Resubscribe to all previously subscribed markets (with throttling)
   * Called after reconnection - clears tracking and resubscribes up to limit
   */
  private resubscribeAll(): void {
    // Clear tracking on reconnect - server doesn't remember our subscriptions
    this.actuallySubscribedMarkets.clear();
    this.isSubscribedToAllMarkets = false;
    
    // Reset position/order snapshot flags - need fresh data after reconnect
    this.hasReceivedPositionSnapshot = false;
    
    // Use market_stats/all instead of individual subscriptions - much more efficient
    this.subscribeToAllMarkets();

    // DON'T resubscribe to orderbooks automatically - too expensive
    // Orderbook subscriptions will happen on-demand when needed
    if (this.subscribedOrderbooks.size > 0) {
      this.subscribedOrderbooks.clear();
      this.orderbookCache.clear();
    }

    // Resubscribe to user orders if we were subscribed
    if (this.isUserSubscribed && this.accountAddress) {
      this.isUserSubscribed = false; // Reset to allow resubscription
      this.subscribeToUserOrders();
    }
    
    // Resubscribe to positions if we were subscribed
    if (this.accountIndex) {
      this.isPositionsSubscribed = false; // Reset to allow resubscription
      this.isOrdersSubscribed = false;
      this.subscribeToPositions();
      this.subscribeToOrders();
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

    // Emit event for reactive waitForOrderFill
    this.emit('order_update', orderUpdate);

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
    const positionCount = Object.keys(positions).length;
    
    // Mark that we've received a position snapshot (even if empty)
    this.hasReceivedPositionSnapshot = true;
    
    this.logger.debug(`📊 Lighter WS position update: ${positionCount} positions received (snapshot flag set)`);
    
    // Clear positions that are no longer in the update (closed positions)
    const receivedMarketIds = new Set(Object.keys(positions).map(k => parseInt(k)));
    for (const marketId of this.positionCache.keys()) {
      if (!receivedMarketIds.has(marketId)) {
        this.positionCache.delete(marketId);
      }
    }
    
    for (const [marketIdStr, posData] of Object.entries(positions)) {
      const marketId = parseInt(marketIdStr);
      const pos = posData as any;
      
      if (!pos) continue;
      
      const size = parseFloat(pos.position || '0');
      const sign = pos.sign || (size >= 0 ? 1 : -1);
      
      // Skip zero-size positions
      if (Math.abs(size) < 0.0001) {
        this.positionCache.delete(marketId);
        continue;
      }
      
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
    
    this.logger.debug(`📊 Updated ${this.positionCache.size} positions from WebSocket (received ${Object.keys(positions).length})`);
    
    // REACTIVE: Emit position update event
    this.emit('positions_update', Array.from(this.positionCache.values()));
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
        
        const orderUpdate = {
          orderId,
          marketIndex: parseInt(marketIdStr),
          side: order.is_ask ? 'sell' : 'buy' as 'buy' | 'sell',
          price: parseFloat(order.price || '0'),
          size: parseFloat(order.initial_base_amount || '0'),
          filledSize: parseFloat(order.filled_base_amount || '0'),
          status: order.status || 'open',
          reduceOnly: order.reduce_only || false,
          lastUpdated: new Date(),
        };

        this.orderCache.set(orderId, orderUpdate);

        // Emit event for reactive waitForOrderFill
        this.emit('order_update', {
          orderId,
          marketIndex: orderUpdate.marketIndex,
          side: orderUpdate.side === 'buy' ? 'bid' : 'ask',
          status: this.mapOrderStatus(orderUpdate.status),
          size: orderUpdate.size.toString(),
          filledSize: orderUpdate.filledSize.toString(),
          price: orderUpdate.price.toString()
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
   * Returns true if we've received at least one position snapshot (even if empty)
   */
  hasPositionData(): boolean {
    if (!this.isPositionsSubscribed) return false;
    
    // Return true if we've received any position snapshot from WS
    return this.hasReceivedPositionSnapshot;
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

  /**
   * Send transaction via WebSocket
   * Based on: https://apidocs.lighter.xyz/docs/websocket-reference#send-tx
   * 
   * @param txType Transaction type (integer from SignerClient)
   * @param txInfo Transaction info (generated using sign methods in SignerClient)
   * @returns Promise that resolves to transaction hash
   */
  async sendTransaction(txType: number, txInfo: any): Promise<string> {
    if (!this.isConnected || !this.ws) {
      throw new Error('WebSocket not connected');
    }

    const requestId = `tx_${++this.transactionRequestId}_${Date.now()}`;
    
    return new Promise<string>((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingTransactions.delete(requestId);
        reject(new Error(`Transaction timeout after ${this.TRANSACTION_TIMEOUT_MS}ms`));
      }, this.TRANSACTION_TIMEOUT_MS);

      // Store promise handlers
      this.pendingTransactions.set(requestId, {
        resolve: (hash: string) => {
          clearTimeout(timeout);
          resolve(hash);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timestamp: Date.now(),
      });

      try {
        const message: LighterWebSocketSendTx = {
          type: 'jsonapi/sendtx',
          data: {
            tx_type: txType,
            tx_info: txInfo,
          },
        };

        // Include requestId in data for tracking (if supported)
        // Some implementations may use a correlation ID field
        const messageWithId = {
          ...message,
          request_id: requestId, // Add request ID for correlation
        };

        this.ws!.send(JSON.stringify(messageWithId));
        this.logger.debug(`📤 Sent WebSocket transaction (type: ${txType}, requestId: ${requestId})`);
      } catch (error: any) {
        this.pendingTransactions.delete(requestId);
        clearTimeout(timeout);
        reject(new Error(`Failed to send transaction: ${error.message}`));
      }
    });
  }

  /**
   * Send batch transactions via WebSocket
   * Based on: https://apidocs.lighter.xyz/docs/websocket-reference#send-batch-tx
   * 
   * @param txTypes Array of transaction types
   * @param txInfos Array of transaction infos (must match txTypes length)
   * @returns Promise that resolves to array of transaction hashes
   */
  async sendBatchTransactions(txTypes: number[], txInfos: any[]): Promise<string[]> {
    if (!this.isConnected || !this.ws) {
      throw new Error('WebSocket not connected');
    }

    if (txTypes.length !== txInfos.length) {
      throw new Error('txTypes and txInfos arrays must have the same length');
    }

    if (txTypes.length === 0) {
      throw new Error('Batch must contain at least one transaction');
    }

    if (txTypes.length > 50) {
      throw new Error('Batch cannot contain more than 50 transactions');
    }

    const requestId = `batch_${++this.transactionRequestId}_${Date.now()}`;
    
    return new Promise<string[]>((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingTransactions.delete(requestId);
        reject(new Error(`Batch transaction timeout after ${this.TRANSACTION_TIMEOUT_MS}ms`));
      }, this.TRANSACTION_TIMEOUT_MS);

      // Store promise handlers
      this.pendingTransactions.set(requestId, {
        resolve: (hashes: any) => {
          clearTimeout(timeout);
          // hashes might be a string (single hash) or array
          const hashArray = Array.isArray(hashes) ? hashes : [hashes];
          resolve(hashArray);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timestamp: Date.now(),
      });

      try {
        const message: LighterWebSocketSendBatchTx = {
          type: 'jsonapi/sendtxbatch',
          data: {
            tx_types: txTypes,
            tx_infos: txInfos,
          },
        };

        // Include requestId for tracking
        const messageWithId = {
          ...message,
          request_id: requestId,
        };

        this.ws!.send(JSON.stringify(messageWithId));
        this.logger.debug(`📤 Sent WebSocket batch transaction (${txTypes.length} txs, requestId: ${requestId})`);
      } catch (error: any) {
        this.pendingTransactions.delete(requestId);
        clearTimeout(timeout);
        reject(new Error(`Failed to send batch transactions: ${error.message}`));
      }
    });
  }

  /**
   * Handle transaction response from WebSocket
   */
  private handleTransactionResponse(message: WsMessage): void {
    try {
      // Response format may vary - check for common fields
      const data = message.data || message;
      const requestId = data.request_id || data.id;
      const hash = data.hash || data.tx_hash || data.transaction_hash;
      const error = data.error || message.error;

      if (error) {
        // Find pending transaction by requestId or try to match by other means
        if (requestId && this.pendingTransactions.has(requestId)) {
          const pending = this.pendingTransactions.get(requestId)!;
          this.pendingTransactions.delete(requestId);
          pending.reject(new Error(error.message || error || 'Transaction failed'));
          return;
        }

        // If no requestId match, reject all pending (fallback)
        this.logger.warn(`Transaction error without matching requestId: ${JSON.stringify(error)}`);
        return;
      }

      if (hash) {
        // Single transaction response
        if (requestId && this.pendingTransactions.has(requestId)) {
          const pending = this.pendingTransactions.get(requestId)!;
          this.pendingTransactions.delete(requestId);
          pending.resolve(hash);
          this.logger.debug(`✅ Transaction confirmed: ${hash.substring(0, 16)}...`);
          return;
        }

        // Batch response - hashes might be in an array
        if (Array.isArray(hash) || (data.hashes && Array.isArray(data.hashes))) {
          const hashes = Array.isArray(hash) ? hash : data.hashes;
          if (requestId && this.pendingTransactions.has(requestId)) {
            const pending = this.pendingTransactions.get(requestId)!;
            this.pendingTransactions.delete(requestId);
            pending.resolve(hashes);
            this.logger.debug(`✅ Batch transaction confirmed: ${hashes.length} transactions`);
            return;
          }
        }

        // Fallback: try to match by timestamp (within 5 seconds)
        const now = Date.now();
        for (const [id, pending] of this.pendingTransactions.entries()) {
          if (now - pending.timestamp < 5000) {
            this.pendingTransactions.delete(id);
            pending.resolve(hash);
            this.logger.debug(`✅ Transaction confirmed (matched by timestamp): ${hash.substring(0, 16)}...`);
            return;
          }
        }

        this.logger.warn(`Transaction response received but no matching pending transaction: ${hash.substring(0, 16)}...`);
      } else {
        this.logger.warn(`Transaction response missing hash: ${JSON.stringify(message)}`);
      }
    } catch (error: any) {
      this.logger.error(`Failed to handle transaction response: ${error.message}`);
    }
  }

  /**
   * Clean up stale pending transactions
   */
  private cleanupStaleTransactions(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendingTransactions.entries()) {
      if (now - pending.timestamp > this.TRANSACTION_TIMEOUT_MS) {
        this.pendingTransactions.delete(id);
        pending.reject(new Error('Transaction timeout'));
      }
    }
  }
}
