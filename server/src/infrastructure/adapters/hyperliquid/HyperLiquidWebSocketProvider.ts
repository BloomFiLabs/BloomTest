import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
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

interface WsMessage {
  channel?: string;
  data?: any;
}

/**
 * HyperLiquidWebSocketProvider - WebSocket-based funding rate provider
 * 
 * Subscribes to activeAssetCtx for real-time funding rate updates
 * This eliminates rate limit issues by using streaming data instead of REST polling
 * 
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
 */
@Injectable()
export class HyperLiquidWebSocketProvider implements OnModuleInit, OnModuleDestroy {
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
  
  // Track if we've received initial data for each asset
  private hasInitialData: Set<string> = new Set();

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
            this.logger.error(`Failed to parse WebSocket message: ${error.message}`);
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
              this.logger.warn(`WebSocket reconnect attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}...`);
            }
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
    }
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
      // Removed WebSocket resubscription log - only execution logs shown
      for (const coin of this.subscribedAssets) {
        this.subscribeToAsset(coin);
      }
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
}

