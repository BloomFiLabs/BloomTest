import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
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

interface WsMessage {
  channel?: string;
  type?: string;
  market_stats?: MarketStatsMessage['market_stats'];
  data?: any;
  market_id?: number;
  error?: { code: number; message: string };
}

/**
 * LighterWebSocketProvider - WebSocket-based market data provider for Lighter Protocol
 *
 * Subscribes to market_stats channels for real-time open interest updates
 * This eliminates rate limit issues and provides accurate OI data
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
}
