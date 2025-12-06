import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
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

interface WsMessage {
  channel?: string;
  type?: string;
  market_stats?: MarketStatsMessage['market_stats'];
  data?: any;
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
  
  // Cache for market stats data (key: marketIndex, value: { openInterest: number, markPrice: number })
  private marketStatsCache: Map<number, { openInterest: number; markPrice: number }> = new Map();
  private subscribedMarkets: Set<number> = new Set();
  
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
        this.logger.log('Connecting to Lighter WebSocket...');
        this.ws = new WebSocket(this.WS_URL);

        this.ws.on('open', () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.logger.log('✅ Connected to Lighter WebSocket');
          
          // Resubscribe to all markets we were tracking
          // Use setTimeout to ensure subscriptions happen after connection is fully established
          // Also gives time for markets to be discovered if discovery happens concurrently
          setTimeout(() => {
            if (this.subscribedMarkets.size > 0) {
              this.logger.log(`Resubscribing to ${this.subscribedMarkets.size} Lighter markets after connection...`);
              this.resubscribeAll();
            } else {
              this.logger.debug('No markets to resubscribe yet (subscribedMarkets is empty - markets may be discovered shortly)');
              // Check again after a longer delay in case markets are discovered late
              setTimeout(() => {
                if (this.subscribedMarkets.size > 0) {
                  this.logger.log(`Markets discovered late - subscribing to ${this.subscribedMarkets.size} Lighter markets...`);
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
            
            // Debug logging for market_stats messages
            if (message.type === 'update/market_stats' || message.market_stats) {
              this.logger.debug(`Received market_stats message: ${JSON.stringify(message)}`);
            }
            
            this.handleMessage(message);
          } catch (error: any) {
            this.logger.error(`Failed to parse WebSocket message: ${error.message}`);
            this.logger.debug(`Raw message: ${data.toString()}`);
          }
        });

        this.ws.on('error', (error: Error) => {
          this.logger.error(`WebSocket error: ${error.message}`);
          this.isConnected = false;
          reject(error);
        });

        this.ws.on('close', () => {
          this.isConnected = false;
          this.logger.warn('Lighter WebSocket connection closed');
          
          // Attempt to reconnect
          if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
            this.reconnectAttempts++;
            this.logger.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})...`);
            setTimeout(() => this.connect(), this.RECONNECT_DELAY);
          } else {
            this.logger.error('Max reconnection attempts reached. WebSocket will not reconnect.');
          }
        });
      } catch (error: any) {
        this.logger.error(`Failed to create WebSocket connection: ${error.message}`);
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
      this.logger.log('Disconnected from Lighter WebSocket');
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(message: WsMessage): void {
    // Handle market_stats updates - check for market_stats field first (more reliable)
    if (message.market_stats) {
      const marketStats = message.market_stats;
      const marketIndex = marketStats.market_id;
      
      if (!marketIndex) {
        this.logger.warn(`Received market_stats message without market_id: ${JSON.stringify(message)}`);
        return;
      }
      
      try {
        const openInterestRaw = marketStats.open_interest || '0';
        const markPriceRaw = marketStats.mark_price || '0';
        const openInterest = parseFloat(openInterestRaw);
        const markPrice = parseFloat(markPriceRaw);
        
        // Log parsing results for debugging
        if (isNaN(openInterest) || isNaN(markPrice)) {
          this.logger.warn(
            `Failed to parse market_stats for market ${marketIndex}: ` +
            `open_interest="${openInterestRaw}", mark_price="${markPriceRaw}"`
          );
          return;
        }
        
        // Cache data if mark price is valid (open interest can be 0)
        if (markPrice > 0) {
          // According to Lighter API docs, open_interest is a STRING
          // Based on testing, open_interest appears to already be in USD (not contracts)
          // Values are typically in millions/billions for major assets
          // We use the value as-is since it's already in USD
          const oiUsd = openInterest;
          
          const wasNew = !this.marketStatsCache.has(marketIndex);
          this.marketStatsCache.set(marketIndex, {
            openInterest: oiUsd,
            markPrice: markPrice,
          });
          
          if (!this.hasInitialData.has(marketIndex)) {
            this.hasInitialData.add(marketIndex);
          }
        } else {
          this.logger.warn(
            `Invalid mark price for market ${marketIndex}: ${markPriceRaw}`
          );
        }
      } catch (error: any) {
        this.logger.error(`Failed to parse market_stats for market ${marketIndex}: ${error.message}`);
        this.logger.debug(`Message: ${JSON.stringify(message)}`);
      }
      return;
    }

    // Handle other message types (subscription confirmations, etc.)
    if (message.type && message.channel) {
      // Log subscription confirmations - note: channel format is "market_stats:1" (colon, not slash)
      if (message.type === 'subscribed' || message.channel.startsWith('market_stats')) {
        this.logger.debug(`WebSocket message: type=${message.type}, channel=${message.channel}`);
      } else {
        this.logger.debug(`Received other WebSocket message: type=${message.type}, channel=${message.channel}`);
      }
    } else {
      // Log any unhandled messages for debugging
      this.logger.debug(`Received unhandled WebSocket message: ${JSON.stringify(message)}`);
    }
  }

  /**
   * Subscribe to market_stats for a specific market
   */
  subscribeToMarket(marketIndex: number, forceResubscribe: boolean = false): void {
    // Always track the subscription, even if WebSocket isn't connected yet
    // This ensures we resubscribe when it reconnects
    const wasNew = !this.subscribedMarkets.has(marketIndex);
    if (wasNew) {
      this.subscribedMarkets.add(marketIndex);
    }

    if (!this.isConnected || !this.ws) {
      // WebSocket not connected - subscription will happen on reconnect via resubscribeAll
      if (wasNew) {
        this.logger.debug(`Queued market ${marketIndex} for subscription (WebSocket not connected)`);
      }
      return;
    }

    // If we already have data for this market and not forcing resubscribe, assume we're already subscribed
    // (avoid duplicate subscriptions unless we're explicitly resubscribing)
    // BUT: if we don't have data yet, always subscribe (even if market was already in set)
    if (!forceResubscribe && !wasNew && this.hasMarketData(marketIndex)) {
      this.logger.debug(`Market ${marketIndex} already subscribed and has data, skipping`);
      return;
    }

    // Subscribe to the market (either new subscription or resubscription)
    // Always subscribe if we don't have data yet, even if market was already in set
    this.logger.debug(`Subscribing to market ${marketIndex}: wasNew=${wasNew}, hasData=${this.hasMarketData(marketIndex)}, forceResubscribe=${forceResubscribe}`);
    try {
      const subscribeMessage = {
        type: 'subscribe',
        channel: `market_stats/${marketIndex}`,
      };

      const messageStr = JSON.stringify(subscribeMessage);
      if (!this.ws) {
        this.logger.error(`Cannot subscribe to market ${marketIndex} - WebSocket is null`);
        return;
      }
      
      this.ws.send(messageStr);
      this.logger.log(`📡 LIGHTER: Subscribed to market ${marketIndex} (channel: market_stats/${marketIndex})`);
      this.logger.debug(`Subscription message: ${messageStr}`);
    } catch (error: any) {
      this.logger.error(`Failed to subscribe to market ${marketIndex}: ${error.message}`);
      this.logger.debug(`WebSocket state: connected=${this.isConnected}, ws=${!!this.ws}, readyState=${this.ws?.readyState}`);
    }
  }

  /**
   * Subscribe to multiple markets at once
   */
  subscribeToMarkets(marketIndexes: number[]): void {
    this.logger.debug(`subscribeToMarkets called with ${marketIndexes.length} markets. Connected: ${this.isConnected}, ws: ${!!this.ws}, wsReadyState: ${this.ws?.readyState}`);
    
    // Add all markets to tracking set first
    marketIndexes.forEach(index => {
      if (!this.subscribedMarkets.has(index)) {
        this.subscribedMarkets.add(index);
      }
    });
    
    // If connected, subscribe to ALL markets (force subscribe to ensure we get data)
    // WebSocket.OPEN = 1
    if (this.isConnected && this.ws && this.ws.readyState === 1) {
      // Subscribe to all markets that don't have data yet
      const marketsToSubscribe = marketIndexes.filter(index => !this.hasMarketData(index));
      if (marketsToSubscribe.length > 0) {
        this.logger.log(`📡 LIGHTER: Subscribing to ${marketsToSubscribe.length} markets via subscribeToMarkets (websocket connected)`);
        marketsToSubscribe.forEach(index => {
          // Force subscribe to ensure message is sent
          this.subscribeToMarket(index, true);
        });
      } else {
        this.logger.debug(`All ${marketIndexes.length} markets already have data`);
      }
    } else {
      // Not connected - markets are tracked and will be subscribed on connection
      this.logger.debug(`WebSocket not ready - ${marketIndexes.length} markets queued for subscription. isConnected=${this.isConnected}, ws=${!!this.ws}, readyState=${this.ws?.readyState}`);
    }
  }

  /**
   * Ensure all tracked markets are subscribed (useful when markets are discovered after connection)
   */
  ensureAllMarketsSubscribed(): void {
    if (!this.isConnected || !this.ws) {
      this.logger.debug(`Cannot ensure subscriptions - WebSocket not connected`);
      return;
    }

    if (this.subscribedMarkets.size === 0) {
      this.logger.debug(`No markets to subscribe (subscribedMarkets is empty)`);
      return;
    }

    // Subscribe to all markets that don't have data yet
    const marketsToSubscribe = Array.from(this.subscribedMarkets).filter(
      marketIndex => !this.hasMarketData(marketIndex)
    );

    if (marketsToSubscribe.length > 0) {
      this.logger.log(`Ensuring ${marketsToSubscribe.length} Lighter markets are subscribed (no data yet)...`);
      marketsToSubscribe.forEach(index => {
        // Force subscription even if market is already in set
        this.subscribeToMarket(index, true);
      });
    } else {
      this.logger.debug(`All ${this.subscribedMarkets.size} tracked Lighter markets already have data`);
    }
  }

  /**
   * Resubscribe to all previously subscribed markets
   */
  private resubscribeAll(): void {
    if (this.subscribedMarkets.size > 0) {
      this.logger.log(`Resubscribing to ${this.subscribedMarkets.size} Lighter markets...`);
      const markets = Array.from(this.subscribedMarkets);
      // Force resubscribe to ensure all markets are subscribed
      markets.forEach(index => this.subscribeToMarket(index, true));
      this.logger.log(`Successfully resubscribed to ${markets.length} Lighter markets`);
    } else {
      this.logger.debug('No Lighter markets to resubscribe (subscribedMarkets is empty)');
    }
  }

  /**
   * Get open interest for a market from WebSocket cache
   * Returns undefined if not available
   */
  getOpenInterest(marketIndex: number): number | undefined {
    const stats = this.marketStatsCache.get(marketIndex);
    const oi = stats?.openInterest;
    
    // Debug logging if we're being asked for data we don't have
    if (oi === undefined && this.subscribedMarkets.has(marketIndex)) {
      this.logger.debug(
        `getOpenInterest(${marketIndex}): No data yet. ` +
        `Connected: ${this.isConnected}, HasInitialData: ${this.hasInitialData.has(marketIndex)}`
      );
    }
    
    return oi;
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

