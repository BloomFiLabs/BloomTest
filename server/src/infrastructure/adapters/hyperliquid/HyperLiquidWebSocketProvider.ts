import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';

interface WsActiveAssetCtx {
  coin: string;
  ctx: {
    funding: number;
    openInterest: number;
    oraclePx: number;
    markPx: number;
    midPx?: number;
    dayNtlVlm: number;
    prevDayPx: number;
  };
}

interface L2Level {
  px: string;
  sz: string;
  n: number;
}

interface WsL2Book {
  coin: string;
  levels: [L2Level[], L2Level[]]; // [bids, asks]
  time: number;
}

/**
 * Fill event from Hyperliquid userFills WebSocket subscription
 */
export interface HyperliquidFillEvent {
  coin: string;
  oid: string;
  side: 'B' | 'A'; // B = Buy/Long, A = Ask/Short
  px: string;
  sz: string;
  time: number;
  hash: string;
  closedPnl?: string;
  fee?: string;
}

/**
 * Order update event from Hyperliquid userEvents WebSocket subscription
 */
export interface HyperliquidOrderUpdate {
  order: {
    coin: string;
    side: 'B' | 'A';
    oid: number;
    sz: string;
    px?: string;
    origSz?: string;
    status: 'filled' | 'canceled' | 'open' | 'triggered';
  };
}

/**
 * Callback for fill events
 */
export type FillCallback = (fill: HyperliquidFillEvent) => void;

/**
 * Callback for order update events
 */
export type OrderUpdateCallback = (update: HyperliquidOrderUpdate) => void;

interface WsMessage {
  channel?: string;
  data?: any;
}

/**
 * HyperLiquidWebSocketProvider - WebSocket-based market data and user event provider
 *
 * Subscribes to:
 * - activeAssetCtx: Real-time funding rate updates
 * - l2Book: Order book snapshots
 * - userFills: Real-time fill notifications (requires authentication)
 * - userEvents: Order status updates (requires authentication)
 *
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
 */
@Injectable()
export class HyperLiquidWebSocketProvider
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(HyperLiquidWebSocketProvider.name);
  private readonly WS_URL = 'wss://api.hyperliquid.xyz/ws';

  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private readonly RECONNECT_DELAY = 5000; // 5 seconds

  // Cache for asset context data (key: coin symbol, value: asset context)
  private assetCtxCache: Map<string, WsActiveAssetCtx['ctx']> = new Map();
  private subscribedAssets: Set<string> = new Set();
  
  // Cache for L2 book data (key: coin symbol, value: { bids, asks })
  private l2BookCache: Map<string, { bids: L2Level[]; asks: L2Level[] }> = new Map();
  private subscribedL2Books: Set<string> = new Set();

  // Track if we've received initial data for each asset
  private hasInitialData: Set<string> = new Set();

  // Fill event callbacks
  private readonly fillCallbacks: FillCallback[] = [];
  
  // ==================== NEW: Order book update callbacks ====================
  // For reactive repricing when someone outbids us
  private readonly bookUpdateCallbacks: Map<string, Array<(bestBid: number, bestAsk: number, coin: string) => void>> = new Map();
  
  // Order update callbacks
  private readonly orderUpdateCallbacks: OrderUpdateCallback[] = [];

  // User authentication for userFills/userEvents subscriptions
  private walletAddress: string | null = null;
  private isUserSubscribed = false;
  
  // ==================== NEW: Position & Order WebSocket Subscriptions ====================
  // Based on: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
  // - clearinghouseState: Real-time position and margin updates
  // - openOrders: Real-time open order updates
  
  // Cache for clearinghouse state (positions)
  private clearinghouseCache: {
    assetPositions: Array<{
      coin: string;
      position: {
        coin: string;
        szi: string;
        leverage: { type: string; value: number };
        entryPx: string;
        positionValue: string;
        unrealizedPnl: string;
        returnOnEquity: string;
        liquidationPx: string | null;
        marginUsed: string;
      };
    }>;
    marginSummary: {
      accountValue: number;
      totalNtlPos: number;
      totalRawUsd: number;
      totalMarginUsed: number;
    };
    withdrawable: number;
    lastUpdated: Date;
  } | null = null;
  
  // Cache for open orders
  private openOrdersCache: Array<{
    coin: string;
    side: string;
    limitPx: string;
    sz: string;
    oid: number;
    timestamp: number;
    origSz: string;
    cloid?: string;
  }> = [];
  private openOrdersLastUpdated: Date | null = null;
  
  private isClearinghouseSubscribed = false;
  private isOpenOrdersSubscribed = false;

  constructor(private readonly configService?: ConfigService) {
    // Try to get wallet address for user subscriptions
    if (configService) {
      const privateKey = configService.get<string>('PRIVATE_KEY') ||
        configService.get<string>('HYPERLIQUID_PRIVATE_KEY');
      if (privateKey) {
        try {
          // Import ethers dynamically to get wallet address
          const { Wallet } = require('ethers');
          const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
          const wallet = new Wallet(normalizedKey);
          this.walletAddress = wallet.address;
          this.logger.log(`User subscriptions enabled for wallet: ${wallet.address.slice(0, 10)}...`);
        } catch (e: any) {
          this.logger.warn(`Could not derive wallet address: ${e.message}`);
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
   * Connect to Hyperliquid WebSocket
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

          // Subscribe to all assets we're tracking
          this.resubscribeAll();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message: WsMessage = JSON.parse(data.toString());
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
    if (message.channel === 'subscriptionResponse') {
      // Subscription acknowledgment - silently handled
      return;
    }

    if (message.channel === 'activeAssetCtx' && message.data) {
      const assetCtx: WsActiveAssetCtx = message.data;
      const coin = assetCtx.coin.toUpperCase();

      // Cache the asset context
      this.assetCtxCache.set(coin, assetCtx.ctx);
      this.hasInitialData.add(coin);

      // Debug logs removed - only log errors
    } else if (message.channel === 'l2Book' && message.data) {
      const l2Book: WsL2Book = message.data;
      const coin = l2Book.coin.toUpperCase();
      
      this.l2BookCache.set(coin, {
        bids: l2Book.levels[0],
        asks: l2Book.levels[1]
      });
      
      // REACTIVE: Trigger callbacks for order book updates
      const callbacks = this.bookUpdateCallbacks.get(coin);
      if (callbacks && callbacks.length > 0 && l2Book.levels[0].length > 0 && l2Book.levels[1].length > 0) {
        const bestBid = parseFloat(l2Book.levels[0][0].px);
        const bestAsk = parseFloat(l2Book.levels[1][0].px);
        for (const callback of callbacks) {
          try {
            callback(bestBid, bestAsk, coin);
          } catch (e: any) {
            this.logger.error(`Error in book update callback for ${coin}: ${e.message}`);
          }
        }
      }
    } else if (message.channel === 'userEvents' && message.data) {
      // Correct channel name per docs: userEvents
      this.handleUserEvent(message.data);
    } else if (message.channel === 'userFills' && message.data) {
      // User fills stream
      this.handleUserFills(message.data);
    } else if (message.channel === 'clearinghouseState' && message.data) {
      // Real-time position and margin updates
      this.handleClearinghouseState(message.data);
    } else if (message.channel === 'openOrders' && message.data) {
      // Real-time open order updates
      this.handleOpenOrders(message.data);
    }
  }

  /**
   * Handle clearinghouseState updates (positions and margin)
   * From: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
   */
  private handleClearinghouseState(data: any): void {
    try {
      // The message data might be nested under clearinghouseState
      const state = data.clearinghouseState || data;
      
      // Hyperliquid docs show marginSummary and crossMarginSummary
      const margin = state.marginSummary || state.crossMarginSummary || {};
      
      this.clearinghouseCache = {
        assetPositions: (state.assetPositions || []).map((ap: any) => ({
          coin: ap.position?.coin || '',
          position: {
            coin: ap.position?.coin || '',
            szi: ap.position?.szi || '0',
            leverage: ap.position?.leverage || { type: 'cross', value: 1 },
            entryPx: ap.position?.entryPx || '0',
            positionValue: ap.position?.positionValue || '0',
            unrealizedPnl: ap.position?.unrealizedPnl || '0',
            returnOnEquity: ap.position?.returnOnEquity || '0',
            liquidationPx: ap.position?.liquidationPx || null,
            marginUsed: ap.position?.marginUsed || '0',
          },
        })),
        marginSummary: {
          accountValue: parseFloat(margin.accountValue || '0'),
          totalNtlPos: parseFloat(margin.totalNtlPos || '0'),
          totalRawUsd: parseFloat(margin.totalRawUsd || '0'),
          totalMarginUsed: parseFloat(margin.totalMarginUsed || '0'),
        },
        withdrawable: parseFloat(state.withdrawable || '0'),
        lastUpdated: new Date(),
      };
      
      const posCount = this.clearinghouseCache.assetPositions.filter(
        p => Math.abs(parseFloat(p.position.szi)) > 0.0001
      ).length;
      
      // If we see 0 positions but non-zero account value, or vice versa, log a warning
      if (posCount === 0 && this.clearinghouseCache.marginSummary.accountValue > 0) {
        this.logger.warn(`⚠️ Clearinghouse reported $${this.clearinghouseCache.marginSummary.accountValue.toFixed(2)} equity but 0 positions. Structure keys: ${Object.keys(state).join(', ')}`);
      }
      
      this.logger.debug(`📊 Updated clearinghouseState: ${posCount} positions, $${this.clearinghouseCache.marginSummary.accountValue.toFixed(2)} account value`);
    } catch (error: any) {
      this.logger.error(`Failed to parse clearinghouseState: ${error.message}`);
    }
  }

  /**
   * Handle openOrders updates
   * From: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
   */
  private handleOpenOrders(data: any): void {
    try {
      const orders = data.orders || data || [];
      this.openOrdersCache = orders.map((order: any) => ({
        coin: order.coin || '',
        side: order.side || '',
        limitPx: order.limitPx || '0',
        sz: order.sz || '0',
        oid: order.oid || 0,
        timestamp: order.timestamp || Date.now(),
        origSz: order.origSz || order.sz || '0',
        cloid: order.cloid,
      }));
      this.openOrdersLastUpdated = new Date();
      
      this.logger.debug(`📋 Updated openOrders: ${this.openOrdersCache.length} orders`);
    } catch (error: any) {
      this.logger.error(`Failed to parse openOrders: ${error.message}`);
    }
  }

  /**
   * Handle user event message (order updates, fills)
   */
  private handleUserEvent(data: any): void {
    if (!data) return;

    // User events can contain fills array
    if (data.fills && Array.isArray(data.fills)) {
      for (const fill of data.fills) {
        this.emitFillEvent(fill);
      }
    }

    // User events can contain order updates
    if (data.orders && Array.isArray(data.orders)) {
      for (const orderUpdate of data.orders) {
        this.emitOrderUpdate({ order: orderUpdate });
      }
    }
  }

  /**
   * Handle userFills stream message
   */
  private handleUserFills(data: any): void {
    if (!data) return;

    // The data might be a wrapper with a fills array
    const fills = data.fills || (Array.isArray(data) ? data : [data]);
    
    if (Array.isArray(fills)) {
      for (const fill of fills) {
        this.emitFillEvent(fill);
      }
    }
  }

  /**
   * Emit fill event to all registered callbacks
   */
  private emitFillEvent(fill: HyperliquidFillEvent): void {
    if (this.fillCallbacks.length === 0) return;

    this.logger.log(
      `📥 Fill received: ${fill.coin} ${fill.side === 'B' ? 'LONG' : 'SHORT'} ` +
      `${fill.sz} @ ${fill.px} (oid: ${fill.oid})`
    );

    for (const callback of this.fillCallbacks) {
      try {
        callback(fill);
      } catch (error: any) {
        this.logger.error(`Fill callback error: ${error.message}`);
      }
    }
  }

  /**
   * Emit order update to all registered callbacks
   */
  private emitOrderUpdate(update: HyperliquidOrderUpdate): void {
    if (this.orderUpdateCallbacks.length === 0) return;

    const order = update.order;
    if (order.status === 'filled' || order.status === 'canceled') {
      this.logger.log(
        `📋 Order ${order.status}: ${order.coin} ${order.side === 'B' ? 'LONG' : 'SHORT'} ` +
        `oid=${order.oid}`
      );
    }

    for (const callback of this.orderUpdateCallbacks) {
      try {
        callback(update);
      } catch (error: any) {
        this.logger.error(`Order update callback error: ${error.message}`);
      }
    }
  }

  /**
   * Subscribe to L2 book updates for a specific coin
   */
  subscribeToL2Book(coin: string): void {
    const normalizedCoin = coin.toUpperCase();

    if (this.subscribedL2Books.has(normalizedCoin)) {
      return; // Already subscribed
    }

    this.subscribedL2Books.add(normalizedCoin);

    if (this.isConnected && this.ws) {
      const subscription = {
        method: 'subscribe',
        subscription: {
          type: 'l2Book',
          coin: normalizedCoin,
        },
      };

      this.ws.send(JSON.stringify(subscription));
    }
  }

  /**
   * Get best bid/ask for a coin
   */
  getBestBidAsk(coin: string): { bestBid: number; bestAsk: number } | null {
    const normalizedCoin = coin.toUpperCase();
    const book = this.l2BookCache.get(normalizedCoin);
    
    if (!book || book.bids.length === 0 || book.asks.length === 0) {
      // Auto-subscribe if not already subscribed
      if (!this.subscribedL2Books.has(normalizedCoin)) {
        this.subscribeToL2Book(normalizedCoin);
      }
      return null;
    }
    
    return {
      bestBid: parseFloat(book.bids[0].px),
      bestAsk: parseFloat(book.asks[0].px)
    };
  }

  /**
   * Register a callback for order book updates (reactive repricing)
   * Called immediately when the book changes - use for fast repricing!
   */
  onBookUpdate(coin: string, callback: (bestBid: number, bestAsk: number, coin: string) => void): () => void {
    const normalizedCoin = coin.toUpperCase();
    
    // Auto-subscribe to the book if not already
    if (!this.subscribedL2Books.has(normalizedCoin)) {
      this.subscribeToL2Book(normalizedCoin);
    }
    
    // Add callback
    if (!this.bookUpdateCallbacks.has(normalizedCoin)) {
      this.bookUpdateCallbacks.set(normalizedCoin, []);
    }
    this.bookUpdateCallbacks.get(normalizedCoin)!.push(callback);
    
    this.logger.debug(`Registered book update callback for ${normalizedCoin}`);
    
    // Return unsubscribe function
    return () => {
      const callbacks = this.bookUpdateCallbacks.get(normalizedCoin);
      if (callbacks) {
        const index = callbacks.indexOf(callback);
        if (index > -1) {
          callbacks.splice(index, 1);
        }
      }
    };
  }

  /**
   * Subscribe to asset context updates for a specific coin
   */
  subscribeToAsset(coin: string): void {
    const normalizedCoin = coin.toUpperCase();

    if (this.subscribedAssets.has(normalizedCoin)) {
      return; // Already subscribed
    }

    this.subscribedAssets.add(normalizedCoin);

    if (this.isConnected && this.ws) {
      const subscription = {
        method: 'subscribe',
        subscription: {
          type: 'activeAssetCtx',
          coin: normalizedCoin,
        },
      };

      this.ws.send(JSON.stringify(subscription));
      // Debug logs removed - only log errors
    }
  }

  /**
   * Subscribe to multiple assets at once
   */
  subscribeToAssets(coins: string[]): void {
    for (const coin of coins) {
      this.subscribeToAsset(coin);
    }
  }

  /**
   * Resubscribe to all previously subscribed assets (after reconnection)
   */
  private resubscribeAll(): void {
    if (this.subscribedAssets.size > 0) {
      for (const coin of this.subscribedAssets) {
        this.subscribeToAsset(coin);
      }
    }
    
    if (this.subscribedL2Books.size > 0) {
      for (const coin of this.subscribedL2Books) {
        // Reset the set before calling subscribeToL2Book which adds to it
        this.subscribedL2Books.delete(coin);
        this.subscribeToL2Book(coin);
      }
    }

    // Resubscribe to user events if we were subscribed before
    if (this.isUserSubscribed && this.walletAddress) {
      this.isUserSubscribed = false; // Reset to allow resubscription
      this.subscribeToUserEvents();
    }
    
    // Resubscribe to clearinghouseState if we were subscribed before
    if (this.isClearinghouseSubscribed && this.walletAddress) {
      this.isClearinghouseSubscribed = false; // Reset to allow resubscription
      this.subscribeToClearinghouseState();
    }
    
    // Resubscribe to openOrders if we were subscribed before
    if (this.isOpenOrdersSubscribed && this.walletAddress) {
      this.isOpenOrdersSubscribed = false; // Reset to allow resubscription
      this.subscribeToOpenOrders();
    }
  }

  /**
   * Get cached funding rate for an asset
   */
  getFundingRate(asset: string): number | null {
    const normalizedAsset = asset.toUpperCase();
    const ctx = this.assetCtxCache.get(normalizedAsset);

    if (!ctx) {
      // Auto-subscribe if not already subscribed
      if (!this.subscribedAssets.has(normalizedAsset)) {
        this.subscribeToAsset(normalizedAsset);
      }
      return null; // Data not available yet
    }

    return ctx.funding;
  }

  /**
   * Get cached mark price for an asset
   */
  getMarkPrice(asset: string): number | null {
    const normalizedAsset = asset.toUpperCase();
    const ctx = this.assetCtxCache.get(normalizedAsset);

    if (!ctx) {
      if (!this.subscribedAssets.has(normalizedAsset)) {
        this.subscribeToAsset(normalizedAsset);
      }
      return null;
    }

    return parseFloat(ctx.markPx.toString());
  }

  /**
   * Get cached open interest for an asset
   */
  getOpenInterest(asset: string): number | null {
    const normalizedAsset = asset.toUpperCase();
    const ctx = this.assetCtxCache.get(normalizedAsset);

    if (!ctx) {
      if (!this.subscribedAssets.has(normalizedAsset)) {
        this.subscribeToAsset(normalizedAsset);
      }
      return null;
    }

    // Open interest is in base units, convert to USD
    const oiBase = parseFloat(ctx.openInterest.toString());
    const markPrice = parseFloat(ctx.markPx.toString());
    return oiBase * markPrice;
  }

  /**
   * Get cached premium (for predicted funding rate)
   */
  getPremium(asset: string): number | null {
    const normalizedAsset = asset.toUpperCase();
    const ctx = this.assetCtxCache.get(normalizedAsset);

    if (!ctx) {
      return null;
    }

    // Premium can be calculated from markPx and oraclePx
    const markPx = parseFloat(ctx.markPx.toString());
    const oraclePx = parseFloat(ctx.oraclePx.toString());
    return (markPx - oraclePx) / oraclePx;
  }

  /**
   * Check if we have data for an asset
   */
  hasData(asset: string): boolean {
    return this.hasInitialData.has(asset.toUpperCase());
  }

  /**
   * Check if WebSocket is connected
   */
  isWsConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Register a callback for fill events
   * @param callback Function to call when a fill is received
   */
  onFill(callback: FillCallback): void {
    this.fillCallbacks.push(callback);
    
    // Auto-subscribe to user events if we have a wallet address
    if (!this.isUserSubscribed && this.walletAddress) {
      this.subscribeToUserEvents();
    }
  }

  /**
   * Register a callback for order update events
   * @param callback Function to call when an order is updated
   */
  onOrderUpdate(callback: OrderUpdateCallback): void {
    this.orderUpdateCallbacks.push(callback);
    
    // Auto-subscribe to user events if we have a wallet address
    if (!this.isUserSubscribed && this.walletAddress) {
      this.subscribeToUserEvents();
    }
  }

  /**
   * Subscribe to user events (fills and order updates)
   * Requires wallet address to be set
   */
  subscribeToUserEvents(): void {
    if (!this.walletAddress) {
      this.logger.warn('Cannot subscribe to user events: no wallet address configured');
      return;
    }

    if (this.isUserSubscribed) {
      return; // Already subscribed
    }

    if (this.isConnected && this.ws) {
      // Subscribe to user events channel
      const subscription = {
        method: 'subscribe',
        subscription: {
          type: 'userEvents',
          user: this.walletAddress,
        },
      };

      this.ws.send(JSON.stringify(subscription));
      this.isUserSubscribed = true;
      this.logger.log(`Subscribed to user events for ${this.walletAddress.slice(0, 10)}...`);
    }
  }

  /**
   * Remove a fill callback
   */
  removeFillCallback(callback: FillCallback): void {
    const index = this.fillCallbacks.indexOf(callback);
    if (index > -1) {
      this.fillCallbacks.splice(index, 1);
    }
  }

  /**
   * Remove an order update callback
   */
  removeOrderUpdateCallback(callback: OrderUpdateCallback): void {
    const index = this.orderUpdateCallbacks.indexOf(callback);
    if (index > -1) {
      this.orderUpdateCallbacks.splice(index, 1);
    }
  }

  /**
   * Get the wallet address for user subscriptions
   */
  getWalletAddress(): string | null {
    return this.walletAddress;
  }

  /**
   * Check if subscribed to user events
   */
  isSubscribedToUserEvents(): boolean {
    return this.isUserSubscribed;
  }

  // ==================== NEW: Position & Order Subscriptions ====================
  // Based on: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions

  /**
   * Subscribe to clearinghouseState for real-time position updates
   * This eliminates the need for REST polling of getPositions()
   */
  subscribeToClearinghouseState(): void {
    if (!this.walletAddress) {
      this.logger.warn('Cannot subscribe to clearinghouseState: no wallet address configured');
      return;
    }

    if (this.isClearinghouseSubscribed) {
      return;
    }

    if (this.isConnected && this.ws) {
      const subscription = {
        method: 'subscribe',
        subscription: {
          type: 'clearinghouseState',
          user: this.walletAddress,
        },
      };

      this.ws.send(JSON.stringify(subscription));
      this.isClearinghouseSubscribed = true;
      this.logger.log(`📡 Subscribed to Hyperliquid clearinghouseState for ${this.walletAddress.slice(0, 10)}...`);
    }
  }

  /**
   * Subscribe to openOrders for real-time order updates
   * This eliminates the need for REST polling of getOpenOrders()
   */
  subscribeToOpenOrders(): void {
    if (!this.walletAddress) {
      this.logger.warn('Cannot subscribe to openOrders: no wallet address configured');
      return;
    }

    if (this.isOpenOrdersSubscribed) {
      return;
    }

    if (this.isConnected && this.ws) {
      const subscription = {
        method: 'subscribe',
        subscription: {
          type: 'openOrders',
          user: this.walletAddress,
        },
      };

      this.ws.send(JSON.stringify(subscription));
      this.isOpenOrdersSubscribed = true;
      this.logger.log(`📡 Subscribed to Hyperliquid openOrders for ${this.walletAddress.slice(0, 10)}...`);
    }
  }

  /**
   * Subscribe to all position-related channels
   * Call this after connection is established
   */
  subscribeToPositionUpdates(): void {
    this.subscribeToClearinghouseState();
    this.subscribeToOpenOrders();
  }

  /**
   * Get cached positions from clearinghouseState
   * Returns null if not subscribed or no data yet
   */
  getCachedPositions(): Array<{
    coin: string;
    size: number;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    markPrice: number;
    unrealizedPnl: number;
    leverage: number;
    liquidationPrice: number | null;
    marginUsed: number;
  }> | null {
    if (!this.isClearinghouseSubscribed || !this.clearinghouseCache) {
      return null;
    }

    // Filter to actual positions (non-zero size)
    return this.clearinghouseCache.assetPositions
      .filter(ap => Math.abs(parseFloat(ap.position.szi)) > 0.0001)
      .map(ap => {
        const size = parseFloat(ap.position.szi);
        const entryPrice = parseFloat(ap.position.entryPx);
        const markPrice = this.getMarkPrice(ap.coin) || entryPrice;
        
        return {
          coin: ap.coin,
          size: Math.abs(size),
          side: (size > 0 ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
          entryPrice,
          markPrice,
          unrealizedPnl: parseFloat(ap.position.unrealizedPnl),
          leverage: ap.position.leverage?.value || 1,
          liquidationPrice: ap.position.liquidationPx ? parseFloat(ap.position.liquidationPx) : null,
          marginUsed: parseFloat(ap.position.marginUsed),
        };
      });
  }

  /**
   * Get cached open orders from openOrders subscription
   * Returns null if not subscribed or no data yet
   */
  getCachedOpenOrders(): Array<{
    coin: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    origSize: number;
    orderId: number;
    timestamp: number;
    clientOrderId?: string;
  }> | null {
    if (!this.isOpenOrdersSubscribed || !this.openOrdersLastUpdated) {
      return null;
    }

    return this.openOrdersCache.map(order => ({
      coin: order.coin,
      side: order.side.toLowerCase() as 'buy' | 'sell',
      price: parseFloat(order.limitPx),
      size: parseFloat(order.sz),
      origSize: parseFloat(order.origSz),
      orderId: order.oid,
      timestamp: order.timestamp,
      clientOrderId: order.cloid,
    }));
  }

  /**
   * Get account summary from clearinghouseState
   */
  getCachedAccountSummary(): {
    accountValue: number;
    totalNotionalPosition: number;
    totalMarginUsed: number;
    withdrawable: number;
    lastUpdated: Date;
  } | null {
    if (!this.clearinghouseCache) {
      return null;
    }

    return {
      accountValue: this.clearinghouseCache.marginSummary.accountValue,
      totalNotionalPosition: this.clearinghouseCache.marginSummary.totalNtlPos,
      totalMarginUsed: this.clearinghouseCache.marginSummary.totalMarginUsed,
      withdrawable: this.clearinghouseCache.withdrawable,
      lastUpdated: this.clearinghouseCache.lastUpdated,
    };
  }

  /**
   * Check if we have fresh position data from WebSocket
   */
  hasPositionData(): boolean {
    if (!this.isClearinghouseSubscribed || !this.clearinghouseCache) {
      return false;
    }
    
    // Check if data is fresh (within last 30 seconds)
    const now = Date.now();
    return now - this.clearinghouseCache.lastUpdated.getTime() < 30000;
  }

  /**
   * Check if we have fresh order data from WebSocket
   */
  hasOrderData(): boolean {
    if (!this.isOpenOrdersSubscribed || !this.openOrdersLastUpdated) {
      return false;
    }
    
    // Check if data is fresh (within last 30 seconds)
    const now = Date.now();
    return now - this.openOrdersLastUpdated.getTime() < 30000;
  }

  /**
   * Check if subscribed to clearinghouseState
   */
  isSubscribedToClearinghouse(): boolean {
    return this.isClearinghouseSubscribed;
  }

  /**
   * Check if subscribed to openOrders
   */
  isSubscribedToOpenOrders(): boolean {
    return this.isOpenOrdersSubscribed;
  }
}
