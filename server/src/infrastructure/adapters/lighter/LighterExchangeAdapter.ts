import { Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SignerClient,
  OrderType as LighterOrderType,
  ApiClient,
  OrderApi,
  MarketHelper,
} from '@reservoir0x/lighter-ts-sdk';
import axios from 'axios';
import { ethers } from 'ethers';
import {
  ExchangeConfig,
  ExchangeType,
} from '../../../domain/value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForce,
} from '../../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../../domain/entities/PerpPosition';
import {
  IPerpExchangeAdapter,
  ExchangeError,
  FundingPayment,
  OpenOrder,
} from '../../../domain/ports/IPerpExchangeAdapter';
import { DiagnosticsService } from '../../services/DiagnosticsService';
import { MarketQualityFilter } from '../../../domain/services/MarketQualityFilter';
import { RateLimiterService, RateLimitPriority } from '../../services/RateLimiterService';

import { LighterWebSocketProvider } from './LighterWebSocketProvider';
import { ILighterExchangeAdapter } from './ILighterExchangeAdapter';
import {
  LighterOrder,
  LighterPosition,
  LighterTrade,
  LighterOrderRequest,
  LighterModifyOrderRequest,
  LighterAccountMarketResponse,
  LighterAccountAllOrdersResponse,
  LighterAccountOrdersResponse,
  LighterAccountAllTradesResponse,
  LighterAccountAllPositionsResponse,
  LighterAccountAllAssetsResponse,
  LighterOrderBookResponse,
  LighterMarketStatsResponse,
  LighterWebSocketSubscription,
  LighterWebSocketSendTx,
  LighterWebSocketSendBatchTx,
  LighterOrderUpdate,
} from './types';

/**
 * LighterExchangeAdapter - Implements ILighterExchangeAdapter for Lighter Protocol
 *
 * Based on the existing lighter-order-simple.ts script logic
 */
@Injectable()
export class LighterExchangeAdapter
  implements ILighterExchangeAdapter, OnModuleDestroy
{
  private readonly logger = new Logger(LighterExchangeAdapter.name);
  private readonly config: ExchangeConfig;
  private signerClient: SignerClient | null = null;
  private orderApi: OrderApi | null = null;
  private marketHelpers: Map<number, MarketHelper> = new Map(); // marketIndex -> MarketHelper

  // Market index mapping cache: symbol -> marketIndex
  private marketIndexCache: Map<string, number> = new Map();
  private marketIndexCacheTimestamp: number = 0;
  private readonly MARKET_INDEX_CACHE_TTL = 3600000; // 1 hour cache

  // Mutex for order placement to prevent concurrent nonce conflicts
  // Lighter uses sequential nonces - concurrent orders cause "invalid nonce" errors
  private orderMutex: Promise<void> = Promise.resolve();
  private orderMutexRelease: (() => void) | null = null;

  // Nonce reset lock - blocks new orders during nonce resync
  private nonceResetInProgress = false;
  private nonceResetQueue: Array<() => void> = [];
  
  // Track last successful nonce sync
  private lastNonceSyncTime: number = 0;
  private readonly NONCE_RESET_TIMEOUT_MS = 5000; // 5 second timeout for waiting on current order

  // Track consecutive nonce errors for debugging
  private consecutiveNonceErrors = 0;

  // ==================== ORDER TRACKING ====================
  // Track placed orders by transaction hash to match with Lighter order index
  // Key: transaction hash, Value: { symbol, side, size, price, placedAt }
  private pendingOrdersMap: Map<string, {
    symbol: string;
    side: OrderSide;
    size: number;
    price?: number;
    placedAt: Date;
  }> = new Map();
  private readonly PENDING_ORDER_TTL_MS = 300000; // 5 minutes TTL for pending orders

  // ==================== ROBUST NONCE MANAGEMENT ====================
  // Local nonce tracking to handle stale API responses
  private localNonce: number | null = null;
  private lastSuccessfulNonce: number | null = null;
  private lastFailedNonce: number | null = null;
  private failedNonceAttempts: Map<number, number> = new Map(); // Track how many times we've tried each nonce
  private readonly MAX_NONCE_RETRIES = 2; // Max times to retry same nonce before bumping
  private lastSuccessfulOrderTime: Date | null = null;

  // Rate limit weights (from Lighter docs)
  // https://apidocs.lighter.xyz/docs/volume-quota-program
  // Premium: 24,000 weight per 60 seconds (rolling)
  // Cancels don't consume quota
  private readonly WEIGHT_TX = 1; // SendTx weight
  private readonly WEIGHT_INFO = 1; // Info requests
  private readonly WEIGHT_CANCEL = 0; // Cancels don't consume quota

  private async callApi<T>(
    weight: number, 
    fn: () => Promise<T>, 
    priority: RateLimitPriority = RateLimitPriority.NORMAL,
    operation: string = 'api',
  ): Promise<T> {
    try {
      await this.rateLimiter.acquire(ExchangeType.LIGHTER, weight, priority, operation);
      return await fn();
    } catch (error: any) {
      if (error.response?.status === 429 || error.message?.includes('429') || error.message?.includes('Too Many Requests')) {
        this.rateLimiter.recordExternalRateLimit(ExchangeType.LIGHTER);
      }
      throw error;
    }
  }

  constructor(
    private readonly configService: ConfigService,
    private readonly rateLimiter: RateLimiterService,
    @Optional() private readonly wsProvider?: LighterWebSocketProvider,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
    @Optional() private readonly marketQualityFilter?: MarketQualityFilter,
  ) {
    const baseUrl =
      this.configService.get<string>('LIGHTER_API_BASE_URL') ||
      'https://mainnet.zklighter.elliot.ai';
    const apiKey = this.configService.get<string>('LIGHTER_API_KEY');
    const accountIndex = parseInt(
      this.configService.get<string>('LIGHTER_ACCOUNT_INDEX') || '1000',
    );
    const apiKeyIndex = parseInt(
      this.configService.get<string>('LIGHTER_API_KEY_INDEX') || '1',
    );

    if (!apiKey) {
      throw new Error('Lighter exchange requires LIGHTER_API_KEY');
    }

    // Normalize API key (remove 0x if present)
    let normalizedKey = apiKey;
    if (normalizedKey.startsWith('0x')) {
      normalizedKey = normalizedKey.slice(2);
    }

    this.config = new ExchangeConfig(
      ExchangeType.LIGHTER,
      baseUrl,
      normalizedKey,
      undefined,
      undefined,
      undefined,
      undefined,
      accountIndex,
      apiKeyIndex,
    );

    // Removed adapter initialization log - only execution logs shown
    if (this.wsProvider) {
      this.wsProvider.subscribeToPositionUpdates();
    }
  }

  /**
   * Record an error to diagnostics service and market quality filter
   */
  private recordError(
    type: string,
    message: string,
    symbol?: string,
    context?: Record<string, any>,
  ): void {
    if (this.diagnosticsService) {
      this.diagnosticsService.recordError({
        type,
        message,
        exchange: ExchangeType.LIGHTER,
        symbol,
        timestamp: new Date(),
        context,
      });
    }

    // Record to market quality filter for automatic blacklisting
    if (this.marketQualityFilter && symbol) {
      const failureType = MarketQualityFilter.parseFailureType(message);
      this.marketQualityFilter.recordFailure({
        symbol,
        exchange: ExchangeType.LIGHTER,
        failureType,
        message,
        timestamp: new Date(),
        context,
      });
    }
  }

  /**
   * Record a successful order fill
   */
  private recordSuccess(symbol: string): void {
    if (this.marketQualityFilter) {
      this.marketQualityFilter.recordSuccess(symbol, ExchangeType.LIGHTER);
    }
  }

  /**
   * NestJS lifecycle hook - called when module is destroyed (app shutdown)
   */
  async onModuleDestroy(): Promise<void> {
    await this.dispose();
  }

  /**
   * Clean up resources when the adapter is destroyed
   * Called on application shutdown or when adapter is no longer needed
   */
  async dispose(): Promise<void> {
    this.logger.log('Disposing Lighter adapter...');

    if (this.signerClient) {
      try {
        if (typeof (this.signerClient as any).close === 'function') {
          await (this.signerClient as any).close();
        }
        if (typeof (this.signerClient as any).destroy === 'function') {
          await (this.signerClient as any).destroy();
        }
      } catch (e) {
        // Ignore cleanup errors
      }
      this.signerClient = null;
    }

    this.orderApi = null;
    this.marketHelpers.clear();
    this.marketIndexCache.clear();

    this.logger.log('Lighter adapter disposed');
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.signerClient) {
      const normalizedKey = this.config.apiKey!;

      this.signerClient = new SignerClient({
        url: this.config.baseUrl,
        privateKey: normalizedKey,
        accountIndex: this.config.accountIndex!,
        apiKeyIndex: this.config.apiKeyIndex!,
        enableWebSocket: true, // Enable WS order placement for faster execution and better nonce management
      } as any);

      await this.signerClient.initialize();
      await this.signerClient.ensureWasmClient();

      // Pre-warm the nonce cache IMMEDIATELY after initialization
      // This ensures we have the correct nonce from the server before any orders
      try {
        await (this.signerClient as any).preWarmNonceCache();
        this.lastNonceSyncTime = Date.now();
        this.logger.log('✅ Lighter SignerClient initialized with pre-warmed nonce cache and WebSockets');
      } catch (e: any) {
        this.logger.warn(`Could not pre-warm nonce cache: ${e.message}`);
      }

      // Create ApiClient and OrderApi
      const apiClient = new ApiClient({ host: this.config.baseUrl });
      this.orderApi = new OrderApi(apiClient);
      
      // NEW: Set account index on WebSocket provider for position/order subscriptions
      // This enables WebSocket-based position updates, eliminating REST polling!
      if (this.wsProvider && this.config.accountIndex) {
        this.wsProvider.setAccountIndex(this.config.accountIndex);
      }
    }
  }

  /**
   * Explicitly get a fresh nonce from the Lighter API
   * ROBUST VERSION: Tracks nonce locally and auto-bumps on stale API responses
   * 
   * Strategy:
   * 1. On first call or reset: fetch from API
   * 2. Subsequent calls: increment local nonce
   * 3. If API returns stale nonce (same as last failed): auto-bump
   * 4. Sync with API periodically or on errors
   */
  private async getFreshNonce(): Promise<number | null> {
    // If we have a local nonce and it's been successfully used, increment it
    if (this.localNonce !== null && this.lastSuccessfulNonce !== null) {
      // Check if API is returning stale data (same nonce we've already tried and failed)
      if (this.lastFailedNonce !== null && this.lastFailedNonce === this.localNonce) {
        const attempts = this.failedNonceAttempts.get(this.localNonce) || 0;
        if (attempts >= this.MAX_NONCE_RETRIES) {
          // API is stuck returning stale nonce - bump it locally
          this.localNonce++;
          this.logger.warn(
            `⚠️ API returned stale nonce ${this.lastFailedNonce} ${attempts} times. ` +
            `Auto-bumping to ${this.localNonce}`
          );
          this.failedNonceAttempts.delete(this.lastFailedNonce);
          this.lastFailedNonce = null;
          return this.localNonce;
        }
      }
      
      // Normal case: increment local nonce
      this.localNonce++;
      this.logger.debug(`📡 Using locally incremented nonce: ${this.localNonce} (last successful: ${this.lastSuccessfulNonce})`);
      return this.localNonce;
    }

    // First call or after reset - fetch from API
    try {
      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(
        `${this.config.baseUrl}/api/v1/nextNonce`,
        {
          params: {
            account_index: this.config.accountIndex,
            api_key_index: this.config.apiKeyIndex,
          },
          timeout: 10000,
        },
      ));

      let apiNonce: number | null = null;
      if (response.data && typeof response.data === 'object') {
        if (response.data.nonce !== undefined) {
          apiNonce = Number(response.data.nonce);
        }
      } else if (typeof response.data === 'number') {
        apiNonce = response.data;
      }

      if (apiNonce !== null && !isNaN(apiNonce)) {
        this.lastNonceSyncTime = Date.now();
        
        // If we have a local nonce that's ahead of API, use local (API might be stale)
        if (this.localNonce !== null && this.localNonce >= apiNonce) {
          this.logger.warn(
            `⚠️ API returned nonce ${apiNonce} but local is ${this.localNonce}. ` +
            `API may be stale, using local + 1: ${this.localNonce + 1}`
          );
          this.localNonce++;
          return this.localNonce;
        }
        
        // Sync to API nonce
        this.localNonce = apiNonce;
        this.logger.debug(`📡 Fetched fresh nonce from API: ${apiNonce}`);
        
        // Also try to update the SDK's internal counter if possible to keep it in sync
        if (this.signerClient) {
          try {
            // Some versions of the SDK allow syncing the nonce manager
            if ((this.signerClient as any).nonceManager?.setNonce) {
              (this.signerClient as any).nonceManager.setNonce(apiNonce);
            }
          } catch (e) {
            // Non-critical
          }
        }
        
        return apiNonce;
      }
      
      // Fallback to SDK method if API fails
      if (this.signerClient) {
        const sdkNonce = await (this.signerClient as any).getNextNonce();
        const nonce = (typeof sdkNonce === 'object' && sdkNonce !== null) ? sdkNonce.nonce : sdkNonce;
        if (nonce !== null && !isNaN(nonce)) {
          this.localNonce = Number(nonce);
          return this.localNonce;
        }
      }
      
      return this.localNonce; // Return local if available, even if API failed
    } catch (e: any) {
      this.logger.warn(`Failed to get fresh nonce from API: ${e.message}. Using local or SDK fallback.`);
      
      // If we have a local nonce, increment and use it
      if (this.localNonce !== null) {
        this.localNonce++;
        this.logger.debug(`📡 API failed, using local nonce: ${this.localNonce}`);
        return this.localNonce;
      }
      
      // Last resort: try SDK
      if (this.signerClient) {
        try {
          const sdkNonce = await (this.signerClient as any).getNextNonce();
          const nonce = (typeof sdkNonce === 'object' && sdkNonce !== null) ? sdkNonce.nonce : sdkNonce;
          if (nonce !== null && !isNaN(nonce)) {
            this.localNonce = Number(nonce);
            return this.localNonce;
          }
        } catch (sdkError) {
          // Ignore
        }
      }
      
      return null;
    }
  }

  /**
   * Lightweight nonce refresh - tries to refresh nonce cache without full client recreation
   * Returns true if refresh succeeded, false if full reset is needed
   */
  private async tryLightweightNonceRefresh(): Promise<boolean> {
    if (!this.signerClient) return false;
    
    try {
      // Method 1: Try to pre-warm the nonce cache via SignerClient
      await (this.signerClient as any).preWarmNonceCache();
      this.logger.log('✅ Lightweight nonce refresh succeeded via preWarmNonceCache');
      this.lastNonceSyncTime = Date.now();
      return true;
    } catch (e1: any) {
      this.logger.debug(`preWarmNonceCache failed: ${e1.message}`);
    }
    
    try {
      // Method 2: Fetch nonce directly from SignerClient
      const nonce = await this.getFreshNonce();
      if (nonce !== null) {
        this.logger.log(`✅ Lightweight nonce refresh via getNextNonce: nonce=${nonce}`);
        return true;
      }
    } catch (e2: any) {
      this.logger.debug(`getNextNonce fetch failed: ${e2.message}`);
    }
    
    return false; // Need full reset
  }

  /**
   * Acquire the order mutex to prevent concurrent order placements
   * Lighter uses sequential nonces - concurrent orders cause "invalid nonce" errors
   * Returns a release function that MUST be called when done
   *
   * IMPORTANT: This also waits for any ongoing nonce reset to complete first
   */
  private async acquireOrderMutex(): Promise<() => void> {
    // First, wait for any nonce reset to complete
    if (this.nonceResetInProgress) {
      this.logger.debug(
        'Waiting for nonce reset to complete before acquiring mutex...',
      );
      await new Promise<void>((resolve) => this.nonceResetQueue.push(resolve));
      this.logger.debug(
        'Nonce reset complete, proceeding with mutex acquisition',
      );
    }

    // Wait for any pending order to complete
    await this.orderMutex;

    // Double-check nonce reset didn't start while we were waiting
    if (this.nonceResetInProgress) {
      this.logger.debug('Nonce reset started while waiting, re-waiting...');
      await new Promise<void>((resolve) => this.nonceResetQueue.push(resolve));
    }

    // Create a new promise that will be resolved when we release
    let release: () => void;
    this.orderMutex = new Promise<void>((resolve) => {
      release = resolve;
    });

    return release!;
  }

  private isNonceError(error: any): boolean {
    const errorMsg = (error?.message || '').toLowerCase();
    const errorResponse = error?.response?.data;
    const responseMsg = (typeof errorResponse === 'string' ? errorResponse : JSON.stringify(errorResponse || '')).toLowerCase();
    
    return (
      errorMsg.includes('invalid nonce') ||
      errorMsg.includes('nonce') ||
      errorMsg.includes('sequence index') ||
      errorMsg.includes('out of sync') ||
      responseMsg.includes('invalid nonce') ||
      responseMsg.includes('nonce') ||
      responseMsg.includes('sequence index') ||
      responseMsg.includes('out of sync')
    );
  }

  /**
   * Fully recreate the SignerClient to get a fresh nonce from the server
   * This is more robust than just resetting - it destroys all state and creates a new client
   *
   * IMPORTANT: This blocks all new orders until recreation is complete
   */
  private async resetSignerClient(): Promise<void> {
    // Prevent multiple concurrent resets
    if (this.nonceResetInProgress) {
      this.logger.debug('Nonce reset already in progress, waiting...');
      await new Promise<void>((resolve) => this.nonceResetQueue.push(resolve));
      return;
    }

    this.nonceResetInProgress = true;
    const resetStartTime = Date.now();
    this.logger.warn(
      `🔄 Recreating Lighter SignerClient to re-sync nonce ` +
        `(consecutive errors: ${this.consecutiveNonceErrors})...`,
    );

    try {
      // NOTE: This method is called from within placeOrderInternal which already holds the mutex.
      // We do NOT wait for the mutex here - we already have exclusive access.
      // The nonceResetInProgress flag will block any NEW orders from acquiring the mutex
      // until we're done resetting.

      // Step 1: Close and destroy existing client completely
      if (this.signerClient) {
        try {
          // Try to close gracefully if method exists
          if (typeof (this.signerClient as any).close === 'function') {
            await (this.signerClient as any).close();
          }
          // Try to destroy if method exists
          if (typeof (this.signerClient as any).destroy === 'function') {
            await (this.signerClient as any).destroy();
          }
        } catch (e) {
          // Ignore close/destroy errors - we're recreating anyway
        }
      }

      // Step 2: Clear ALL client state to ensure fresh start
      this.signerClient = null;
      this.orderApi = null;
      
      // Reset local nonce tracking to force fresh sync from API
      this.localNonce = null;
      this.lastSuccessfulNonce = null;
      this.lastFailedNonce = null;
      this.failedNonceAttempts.clear();

      // Step 3: Wait for server state to settle
      // The delay increases with consecutive errors (1s base + 500ms per error, max 5s)
      const settleDelay = Math.min(
        1000 + this.consecutiveNonceErrors * 500,
        5000,
      );
      this.logger.debug(
        `Waiting ${settleDelay}ms for server state to settle before re-initialization...`,
      );
      await new Promise((resolve) => setTimeout(resolve, settleDelay));

      // Step 4: Re-initialize with fresh client - this fetches fresh nonce from server
      await this.ensureInitialized();

      const resetDuration = Date.now() - resetStartTime;
      this.logger.log(
        `✅ Lighter SignerClient recreated in ${resetDuration}ms - nonce re-synced from server`,
      );
    } finally {
      // Release all waiting operations
      this.nonceResetInProgress = false;
      const waitingOperations = this.nonceResetQueue.splice(0);
      this.logger.debug(
        `Releasing ${waitingOperations.length} operations waiting on nonce reset`,
      );
      waitingOperations.forEach((resolve) => resolve());
    }
  }

  /**
   * Check if a nonce reset is currently in progress
   */
  isNonceResetInProgress(): boolean {
    return this.nonceResetInProgress;
  }

  /**
   * Force resync nonce from API
   * Useful after manual trades on Lighter UI or when nonce gets out of sync
   * This resets local tracking and fetches fresh nonce from server
   */
  async forceNonceResync(): Promise<number | null> {
    this.logger.log('🔄 Force resyncing nonce from Lighter API...');
    this.localNonce = null;
    this.lastSuccessfulNonce = null;
    this.lastFailedNonce = null;
    this.failedNonceAttempts.clear();
    const nonce = await this.getFreshNonce();
    this.logger.log(`✅ Nonce resynced: ${nonce}`);
    return nonce;
  }

  private async getMarketHelper(marketIndex: number): Promise<MarketHelper> {
    if (!this.marketHelpers.has(marketIndex)) {
      await this.ensureInitialized();
      const market = new MarketHelper(marketIndex, this.orderApi!);

      // Add retry logic with exponential backoff for market config fetch (rate limiting)
      const maxRetries = 8;
      const baseDelay = 3000; // 3 seconds base delay
      const maxDelay = 300000; // 5 minutes max delay
      let lastError: any = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            // Exponential backoff with jitter: 2s, 4s, 8s, 16s, 32s, 60s (capped)
            const exponentialDelay = Math.min(
              baseDelay * Math.pow(2, attempt - 1),
              maxDelay,
            );
            const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);
            const delay = Math.max(1000, exponentialDelay + jitter);

            this.logger.debug(
              `Retrying market config fetch for market ${marketIndex} after ${Math.floor(delay / 1000)}s ` +
                `(attempt ${attempt + 1}/${maxRetries})`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          await market.initialize();
          this.marketHelpers.set(marketIndex, market);
          return market;
        } catch (error: any) {
          lastError = error;
          const errorMsg = error?.message || String(error);
          const isRateLimit =
            errorMsg.includes('Too Many Requests') ||
            errorMsg.includes('429') ||
            errorMsg.includes('rate limit');

          if (isRateLimit && attempt < maxRetries - 1) {
            // Silenced 429/rate limit warnings - only show errors
            this.logger.debug(
              `Market config fetch rate limited for market ${marketIndex} ` +
                `(attempt ${attempt + 1}/${maxRetries}): ${errorMsg}. Will retry.`,
            );
            continue;
          }

          // Not retryable or max retries reached
          throw error;
        }
      }

      // Should never reach here, but just in case
      throw (
        lastError ||
        new Error(
          `Failed to initialize market helper for market ${marketIndex}`,
        )
      );
    }
    return this.marketHelpers.get(marketIndex)!;
  }

  /**
   * Fetch and cache market index mappings from Lighter Explorer API
   * API: https://explorer.elliot.ai/api/markets
   * Docs: https://apidocs.lighter.xyz/reference/get_markets
   */
  private async refreshMarketIndexCache(): Promise<void> {
    const now = Date.now();

    // Use cache if fresh
    if (
      this.marketIndexCache.size > 0 &&
      now - this.marketIndexCacheTimestamp < this.MARKET_INDEX_CACHE_TTL
    ) {
      return;
    }

    try {
      this.logger.debug(
        'Fetching market index mappings from Lighter Explorer API...',
      );

      const explorerUrl = 'https://explorer.elliot.ai/api/markets';
      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(explorerUrl, {
        timeout: 10000,
        headers: { accept: 'application/json' },
      }));

      if (!response.data || !Array.isArray(response.data)) {
        this.logger.warn('Lighter Explorer API returned invalid data format');
        return;
      }

      // Clear old cache
      this.marketIndexCache.clear();

      // Parse response: [{ "symbol": "ETH", "market_index": 0 }, ...]
      for (const market of response.data) {
        // API uses "market_index" (with underscore)
        const marketIndex =
          market.market_index ?? market.marketIndex ?? market.index ?? null;
        const symbol = market.symbol || market.baseAsset || market.name;

        if (marketIndex !== null && symbol) {
          // Normalize symbol (remove USDC/USDT suffixes)
          const normalizedSymbol = symbol
            .replace('USDC', '')
            .replace('USDT', '')
            .replace('-PERP', '')
            .replace('PERP', '')
            .toUpperCase();

          this.marketIndexCache.set(normalizedSymbol, Number(marketIndex));
        }
      }

      this.marketIndexCacheTimestamp = now;
      // Removed cache log - only execution logs shown
    } catch (error: any) {
      this.logger.warn(
        `Failed to fetch market index mappings from Explorer API: ${error.message}`,
      );
      // Don't throw - allow fallback to hardcoded mapping
    }
  }

  /**
   * Convert symbol to market index
   * Uses cached Explorer API data, with fallback to hardcoded mapping
   */
  async getMarketIndex(symbol: string): Promise<number> {
    // Refresh cache if needed
    await this.refreshMarketIndexCache();

    // Normalize symbol
    const baseSymbol = symbol
      .replace('USDC', '')
      .replace('USDT', '')
      .replace('-PERP', '')
      .toUpperCase();

    // Try cached mapping first
    const cachedIndex = this.marketIndexCache.get(baseSymbol);
    if (cachedIndex !== undefined) {
      return cachedIndex;
    }

    // Fallback: Try querying order books API
    try {
      const apiClient = new ApiClient({ host: this.config.baseUrl });
      const orderBooks = await (apiClient as any).order?.getOrderBooks();

      if (orderBooks && Array.isArray(orderBooks)) {
        for (let i = 0; i < orderBooks.length; i++) {
          const book = orderBooks[i];
          const bookSymbol = (book.symbol || book.baseAsset || '')
            .replace('USDC', '')
            .replace('USDT', '')
            .replace('-PERP', '')
            .toUpperCase();
          if (bookSymbol === baseSymbol) {
            // Cache the result
            this.marketIndexCache.set(baseSymbol, i);
            return i;
          }
        }
      }
    } catch (error) {
      // Fall back to hardcoded mapping
    }

    // Final fallback: Hardcoded common market indices
    const symbolToMarketIndex: Record<string, number> = {
      ETH: 0,
      BTC: 1,
      // Add more as needed
    };

    const fallbackIndex = symbolToMarketIndex[baseSymbol] ?? 0;
    this.logger.warn(
      `Market index not found for ${symbol} (${baseSymbol}), using fallback index: ${fallbackIndex}. ` +
        `Consider checking Lighter Explorer API: https://explorer.elliot.ai/api/markets`,
    );
    return fallbackIndex;
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): string {
    return ExchangeType.LIGHTER;
  }

  async placeOrder(request: PerpOrderRequest): Promise<PerpOrderResponse> {
    this.logger.log(
      `📤 Placing ${request.side} order on Lighter: ${request.size} ${request.symbol} ` +
        `@ ${request.price || 'market'} (type: ${request.type}, reduceOnly: ${request.reduceOnly})`,
    );

    // CRITICAL: Validate reduceOnly orders BEFORE acquiring mutex
    // This prevents "invalid reduce only direction" errors from the blockchain
    if (request.reduceOnly) {
      await this.validateReduceOnlyOrder(request);
    }
    
    // PROACTIVE NONCE SYNC: If it's been > 60 seconds since last sync, refresh nonce cache
    // This helps prevent nonce errors from stale cache
    const NONCE_SYNC_INTERVAL_MS = 60000; // 1 minute
    if (this.lastNonceSyncTime > 0 && Date.now() - this.lastNonceSyncTime > NONCE_SYNC_INTERVAL_MS) {
      this.logger.debug(`⏰ Proactive nonce sync (last sync ${Math.round((Date.now() - this.lastNonceSyncTime) / 1000)}s ago)`);
      try {
        if (this.signerClient) {
          await (this.signerClient as any).preWarmNonceCache();
          this.lastNonceSyncTime = Date.now();
        }
      } catch (e: any) {
        this.logger.debug(`Proactive nonce sync failed (non-critical): ${e.message}`);
      }
    }

    // Acquire mutex to prevent concurrent order placements
    // Lighter uses sequential nonces - concurrent orders cause "invalid nonce" errors
    // We hold the mutex ONLY for the duration of a single attempt to avoid blocking
    // other orders during the exponential backoff delay.
    return await this.placeOrderInternal(request);
  }

  /**
   * Validate that a reduceOnly order can be placed
   * Checks that a position exists and the order direction is correct for closing it
   *
   * @throws Error if no position exists or direction is wrong
   */
  private async validateReduceOnlyOrder(
    request: PerpOrderRequest,
  ): Promise<void> {
    const positions = await this.getPositions();

    // Normalize symbol for comparison
    const normalizedRequestSymbol = request.symbol
      .replace('USDC', '')
      .replace('USDT', '')
      .replace('-PERP', '')
      .replace('PERP', '')
      .toUpperCase();

    const matchingPosition = positions.find((p) => {
      const normalizedPosSymbol = p.symbol
        .replace('USDC', '')
        .replace('USDT', '')
        .replace('-PERP', '')
        .replace('PERP', '')
        .toUpperCase();
      return (
        normalizedPosSymbol === normalizedRequestSymbol &&
        Math.abs(p.size) > 0.0001
      );
    });

    if (!matchingPosition) {
      const errorMsg = `Cannot place reduceOnly order: No position exists for ${request.symbol}`;
      this.logger.warn(`⚠️ ${errorMsg}`);
      this.recordError(
        'LIGHTER_REDUCE_ONLY_NO_POSITION',
        errorMsg,
        request.symbol,
      );
      throw new ExchangeError(errorMsg, ExchangeType.LIGHTER);
    }

    // Verify direction matches - to close a position, we need the opposite side
    // LONG position -> need SHORT order to close
    // SHORT position -> need LONG order to close
    const expectedCloseSide =
      matchingPosition.side === OrderSide.LONG
        ? OrderSide.SHORT
        : OrderSide.LONG;

    if (request.side !== expectedCloseSide) {
      const errorMsg =
        `Invalid reduceOnly direction: Position is ${matchingPosition.side}, ` +
        `order side is ${request.side}, expected ${expectedCloseSide} to close`;
      this.logger.warn(`⚠️ ${errorMsg}`);
      this.recordError(
        'LIGHTER_REDUCE_ONLY_WRONG_DIRECTION',
        errorMsg,
        request.symbol,
        {
          positionSide: matchingPosition.side,
          orderSide: request.side,
          expectedSide: expectedCloseSide,
        },
      );
      throw new ExchangeError(errorMsg, ExchangeType.LIGHTER);
    }

    // Also validate that order size doesn't exceed position size
    const actualPositionSize = Math.abs(matchingPosition.size);
    if (request.size > actualPositionSize * 1.01) {
      // 1% tolerance for rounding
      this.logger.warn(
        `⚠️ ReduceOnly order size ${request.size.toFixed(4)} exceeds position size ${actualPositionSize.toFixed(4)}. ` +
          `Will use position size instead.`,
      );
      this.recordError(
        'LIGHTER_REDUCE_ONLY_SIZE_EXCEEDS',
        `ReduceOnly size ${request.size.toFixed(4)} exceeds position ${actualPositionSize.toFixed(4)} - will auto-correct`,
        request.symbol,
        {
          originalSize: request.size,
          positionSize: actualPositionSize,
        },
      );
      // Note: We can't modify request.size here as it's readonly
      // The caller should fetch fresh position size before calling
      // We'll throw to force the caller to retry with correct size
      throw new ExchangeError(
        `ReduceOnly order size ${request.size.toFixed(4)} exceeds position size ${actualPositionSize.toFixed(4)}. ` +
          `Please retry with correct size.`,
        ExchangeType.LIGHTER,
      );
    }

    this.logger.debug(
      `✅ ReduceOnly validation passed: Closing ${matchingPosition.side} position of ${actualPositionSize.toFixed(4)} ` +
        `with ${request.side} order of ${request.size.toFixed(4)}`,
    );
  }

  /**
   * Internal order placement logic - handles retries and mutex management
   */
  private async placeOrderInternal(
    request: PerpOrderRequest,
  ): Promise<PerpOrderResponse> {
    const maxRetries = request.type === OrderType.MARKET ? 5 : 6;
    const baseDelay = 2000;
    const maxDelay = 60000;
    let lastError: any = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        const exponentialDelay = Math.min(
          baseDelay * Math.pow(2, attempt - 1),
          maxDelay,
        );
        const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);
        const delay = Math.max(1000, exponentialDelay + jitter);

        this.logger.warn(
          `Retrying order placement for ${request.symbol} after ${Math.floor(delay / 1000)}s ` +
            `(attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // Acquire mutex ONLY for the critical section (nonce + submission)
      const releaseMutex = await this.acquireOrderMutex();
      
      let nonce: number | null = null;
      try {
        this.logger.debug(
          `Initializing Lighter adapter for order placement (attempt ${attempt + 1})...`,
        );
        await this.ensureInitialized();
        
        // Fetch a fresh nonce explicitly before each order attempt
        nonce = await this.getFreshNonce();
        this.logger.debug(`Using fresh nonce for ${request.symbol}: ${nonce}`);

        const marketIndex = await this.getMarketIndex(request.symbol);
        const market = await this.getMarketHelper(marketIndex);

        let orderResponse: PerpOrderResponse;
        
        if (request.type === OrderType.MARKET && request.reduceOnly) {
          orderResponse = await this.executeLighterMarketClose(request, marketIndex, market, attempt, maxRetries, nonce);
        } else if (request.type === OrderType.MARKET) {
          orderResponse = await this.executeLighterMarketOpen(request, marketIndex, market, attempt, maxRetries, nonce);
        } else {
          orderResponse = await this.executeLighterLimitOrder(request, marketIndex, market, nonce);
        }

        // Order succeeded - track the nonce as successful
        if (nonce !== null) {
          this.lastSuccessfulNonce = nonce;
          this.failedNonceAttempts.delete(nonce); // Clear any failure tracking
          this.lastFailedNonce = null;
        }
        
        this.consecutiveNonceErrors = 0;
        this.lastSuccessfulOrderTime = new Date();
        return orderResponse;

      } catch (error: any) {
        lastError = error;
        const errorMessage = error.message || String(error);

        // Track failed nonce for intelligent retry logic
        if (nonce !== null) {
          this.lastFailedNonce = nonce;
          const attempts = (this.failedNonceAttempts.get(nonce) || 0) + 1;
          this.failedNonceAttempts.set(nonce, attempts);
        }

        if (
          errorMessage.includes('invalid nonce') ||
          errorMessage.includes('nonce too low') ||
          errorMessage.includes('AccountSequenceMismatch')
        ) {
          this.consecutiveNonceErrors++;
          this.logger.error(
            `❌ Lighter nonce error (attempt ${attempt + 1}/${maxRetries}): ${errorMessage}`,
          );
          
          // Reset local nonce to force re-sync from API on nonce errors
          if (this.consecutiveNonceErrors >= 2) {
            this.logger.warn(`🔄 Multiple nonce errors, resetting local nonce and clearing signer client...`);
            this.localNonce = null;
            this.lastSuccessfulNonce = null;
            this.signerClient = null;
          }
        } else if (errorMessage.includes('invalid signature')) {
          // "invalid signature" often means nonce was already used (ghost success)
          // Immediately bump the nonce to avoid retrying with the same one
          this.consecutiveNonceErrors++;
          if (nonce !== null && this.localNonce !== null) {
            // Bump local nonce immediately - this nonce was likely already used
            this.localNonce = Math.max(this.localNonce, nonce + 1);
            this.logger.warn(
              `⚠️ Invalid signature error (attempt ${attempt + 1}/${maxRetries}): ${errorMessage}. ` +
              `Nonce ${nonce} likely already used. Bumped local nonce to ${this.localNonce}.`
            );
          } else {
            this.logger.warn(
              `⚠️ Invalid signature error (attempt ${attempt + 1}/${maxRetries}): ${errorMessage}. ` +
              `Nonce ${nonce} may have been used. Will auto-bump on next attempt.`
            );
          }
          
          // If we get multiple invalid signature errors, reset to force re-sync
          if (this.consecutiveNonceErrors >= 3) {
            this.logger.warn(`🔄 Multiple invalid signature errors, resetting local nonce...`);
            this.localNonce = null;
            this.lastSuccessfulNonce = null;
          }
        } else {
          this.logger.error(
            `❌ Lighter order error (attempt ${attempt + 1}/${maxRetries}): ${errorMessage}`,
          );
        }

        if (attempt === maxRetries - 1) {
          throw new ExchangeError(
            `Lighter order failed after ${maxRetries} attempts: ${errorMessage}`,
            ExchangeType.LIGHTER,
          );
        }
      } finally {
        releaseMutex();
      }
    }

    // Should never reach here, but just in case
    const finalErrorMsg = lastError?.message || 'Unknown error';
    this.logger.error(
      `❌ Lighter order placement failed after ${maxRetries} attempts: ${finalErrorMsg}`,
    );
    if (lastError?.stack) {
      this.logger.error(`Final error stack: ${lastError.stack}`);
    }
    this.recordError(
      'LIGHTER_ORDER_MAX_RETRIES',
      finalErrorMsg,
      request.symbol,
      { maxRetries },
    );

    throw new ExchangeError(
      `Failed to place order after ${maxRetries} attempts: ${finalErrorMsg}`,
      ExchangeType.LIGHTER,
      undefined,
      lastError,
    );
  }

  async getPosition(symbol: string): Promise<PerpPosition | null> {
    try {
      const positions = await this.getPositions();
      // Normalize symbol for comparison
      const normalizedSymbol = symbol
        .replace('USDC', '')
        .replace('USDT', '')
        .replace('-PERP', '')
        .replace('PERP', '')
        .toUpperCase();

      return (
        positions.find((p) => {
          const posSymbol = p.symbol
            .replace('USDC', '')
            .replace('USDT', '')
            .replace('-PERP', '')
            .replace('PERP', '')
            .toUpperCase();
          return posSymbol === normalizedSymbol;
        }) || null
      );
    } catch (error: any) {
      this.logger.error(`Failed to get position: ${error.message}`);
      throw new ExchangeError(
        `Failed to get position: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  /**
   * Get symbol from market index by reverse lookup
   */
  private async getSymbolFromMarketIndex(
    marketIndex: number,
  ): Promise<string | null> {
    // Refresh cache to ensure we have latest mappings
    await this.refreshMarketIndexCache();

    // Reverse lookup: find symbol that maps to this market index
    for (const [symbol, index] of this.marketIndexCache.entries()) {
      if (index === marketIndex) {
        return symbol;
      }
    }

    // Fallback: query markets API directly
    try {
      const explorerUrl = 'https://explorer.elliot.ai/api/markets';
      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(explorerUrl, {
        timeout: 10000,
        headers: { accept: 'application/json' },
      }));

      if (response.data && Array.isArray(response.data)) {
        for (const market of response.data) {
          const idx =
            market.market_index ?? market.marketIndex ?? market.index ?? null;
          if (idx === marketIndex) {
            const symbol = market.symbol || market.baseAsset || market.name;
            if (symbol) {
              // Normalize and cache
              const normalizedSymbol = symbol
                .replace('USDC', '')
                .replace('USDT', '')
                .replace('-PERP', '')
                .replace('PERP', '')
                .toUpperCase();
              this.marketIndexCache.set(normalizedSymbol, marketIndex);
              return normalizedSymbol;
            }
          }
        }
      }
    } catch (error: any) {
      this.logger.debug(
        `Failed to fetch symbol for market index ${marketIndex}: ${error.message}`,
      );
    }

    return null;
  }

  async getPositions(): Promise<PerpPosition[]> {
    try {
      await this.ensureInitialized();

      // ========== NEW: Try WebSocket cache first to avoid REST call ==========
      // This dramatically reduces rate limit usage!
      if (this.wsProvider) {
        const cachedPositions = this.wsProvider.getCachedPositions();
        if (cachedPositions && cachedPositions.size > 0) {
          this.logger.debug(`Using WebSocket cached positions (${cachedPositions.size} markets)`);
          
          const positions: PerpPosition[] = [];
          for (const [marketId, pos] of cachedPositions) {
            if (Math.abs(pos.size) < 0.0001) continue; // Skip zero positions
            
            // Map to PerpPosition
            const side = pos.sign > 0 ? OrderSide.LONG : OrderSide.SHORT;
            const markPrice = this.wsProvider.getMarkPrice(marketId) || pos.avgEntryPrice;
            
            positions.push(new PerpPosition(
              ExchangeType.LIGHTER,
              pos.symbol,
              side,
              Math.abs(pos.size),
              pos.avgEntryPrice,
              markPrice,
              pos.unrealizedPnl,
              1, // leverage - not provided by WS, use default
            ));
          }
          
          if (positions.length > 0) {
            this.logger.debug(`WebSocket returned ${positions.length} active positions`);
            return positions;
          }
        }
      }
      // ========== End WebSocket cache check ==========

      // Fallback to REST API
      // Use Lighter Explorer API to get positions
      // Endpoint: https://explorer.elliot.ai/api/accounts/{accountIndex}/positions
      const accountIndex = this.config.accountIndex!;
      const explorerUrl = `https://explorer.elliot.ai/api/accounts/${accountIndex}/positions`;

      this.logger.debug(
        `Fetching positions from Lighter REST API for account ${accountIndex}...`,
      );

      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(explorerUrl, {
        timeout: 10000,
        headers: { accept: 'application/json' },
      }), RateLimitPriority.NORMAL, 'getPositions');

      if (!response.data) {
        this.logger.warn('Lighter Explorer API returned empty positions data');
        return [];
      }

      // Lighter API returns positions as an object with market_index as keys
      // Structure: { "positions": { "51": {...}, "52": {...} } }
      const positionsObj = response.data.positions || {};
      if (typeof positionsObj !== 'object' || Array.isArray(positionsObj)) {
        this.logger.warn(
          'Lighter Explorer API returned unexpected positions format',
        );
        return [];
      }

      // Convert object to array of position data
      // Type assertion: positions are objects with known structure
      const positionsData = Object.values(positionsObj) as Array<{
        market_index?: number;
        marketIndex?: number;
        index?: number;
        size?: string | number;
        positionSize?: string | number;
        amount?: string | number;
        side?: string;
        entry_price?: string | number;
        entryPrice?: string | number;
        avgEntryPrice?: string | number;
        pnl?: string | number;
        unrealized_pnl?: string | number;
        unrealizedPnl?: string | number;
      }>;
      const positions: PerpPosition[] = [];

      for (const posData of positionsData) {
        try {
          // Parse position data - actual structure from API:
          // { market_index, pnl, side, size, entry_price }
          const marketIndex =
            posData.market_index ??
            posData.marketIndex ??
            posData.index ??
            null;
          if (marketIndex === null) {
            this.logger.warn(
              `Position data missing market_index: ${JSON.stringify(posData).substring(0, 200)}`,
            );
            continue;
          }

          // Get symbol from market index
          const symbol = await this.getSymbolFromMarketIndex(marketIndex);
          if (!symbol) {
            this.logger.warn(
              `Could not resolve symbol for market index ${marketIndex}, skipping position`,
            );
            continue;
          }

          // Parse position size (can be negative for short positions)
          const sizeRaw =
            posData.size ?? posData.positionSize ?? posData.amount ?? '0';
          const size = parseFloat(String(sizeRaw));

          if (size === 0 || isNaN(size)) {
            continue; // Skip zero positions
          }

          // Determine side: API provides "side" field ("long" or "short"), or infer from size sign
          let side: OrderSide;
          if (posData.side) {
            const sideStr = String(posData.side).toLowerCase();
            side =
              sideStr === 'long' || sideStr === 'l'
                ? OrderSide.LONG
                : OrderSide.SHORT;
          } else {
            // Fallback: infer from size sign
            side = size > 0 ? OrderSide.LONG : OrderSide.SHORT;
          }
          const absSize = Math.abs(size);

          // Parse entry price (required)
          const entryPrice = parseFloat(
            String(
              posData.entry_price ??
                posData.entryPrice ??
                posData.avgEntryPrice ??
                '0',
            ),
          );

          if (entryPrice <= 0) {
            this.logger.warn(
              `Invalid entry price for ${symbol}: ${entryPrice}`,
            );
            continue;
          }

          // Fetch current mark price (not provided in positions response)
          let markPrice: number;
          try {
            markPrice = await this.getMarkPrice(symbol);
            if (markPrice <= 0) {
              // Fallback to entry price if mark price fetch fails
              this.logger.debug(
                `Could not fetch mark price for ${symbol}, using entry price`,
              );
              markPrice = entryPrice;
            }
          } catch (error: any) {
            // Fallback to entry price if mark price fetch fails
            this.logger.debug(
              `Failed to fetch mark price for ${symbol}: ${error.message}, using entry price`,
            );
            markPrice = entryPrice;
          }

          // Parse PnL (unrealized profit/loss)
          const unrealizedPnl = parseFloat(
            String(
              posData.pnl ??
                posData.unrealized_pnl ??
                posData.unrealizedPnl ??
                '0',
            ),
          );

          // Lighter uses cross-margin. Leverage for a position can be estimated as PositionValue / AccountBalance
          let leverage: number | undefined = undefined;
          try {
            const balance = await this.getBalance();
            if (balance > 0) {
              leverage = Math.abs(absSize * markPrice) / balance;
              // Cap at 20x for sanity in case of very low balance
              leverage = Math.min(20, Math.max(1, leverage));
            }
          } catch (e) {
            // Ignore balance fetch errors for leverage estimation
          }
          
          const liquidationPrice = undefined; // Not provided by API
          const marginUsed = undefined; // Not provided by API

          const position = new PerpPosition(
            ExchangeType.LIGHTER,
            symbol,
            side,
            absSize,
            entryPrice,
            markPrice,
            unrealizedPnl,
            leverage,
            liquidationPrice,
            marginUsed,
            undefined,
            new Date(),
          );

          this.logger.debug(
            `📍 Lighter Position: symbol="${symbol}", side=${side}, size=${absSize}, ` +
              `entryPrice=${entryPrice}, markPrice=${markPrice}, pnl=${unrealizedPnl}, marketIndex=${marketIndex}`,
          );

          positions.push(position);
        } catch (error: any) {
          this.logger.warn(
            `Failed to parse position data: ${error.message}. Data: ${JSON.stringify(posData).substring(0, 200)}`,
          );
          continue;
        }
      }

      this.logger.debug(
        `✅ Lighter getPositions() returning ${positions.length} positions: ${positions.map((p) => `${p.symbol}(${p.side})`).join(', ')}`,
      );
      return positions;
    } catch (error: any) {
      this.logger.error(`Failed to get positions: ${error.message}`);
      if (error.response) {
        this.logger.error(
          `API response: ${JSON.stringify(error.response.data).substring(0, 400)}`,
        );
      }
      throw new ExchangeError(
        `Failed to get positions: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  private async executeLighterMarketClose(
    request: PerpOrderRequest,
    marketIndex: number,
    market: any,
    attempt: number,
    maxRetries: number,
    nonce: number | null,
  ): Promise<PerpOrderResponse> {
    const isBuy = request.side === OrderSide.LONG;
    const isAsk = !isBuy;
    const baseAmount = market.amountToUnits(request.size);

    let avgExecutionPrice: number;
    const priceImprovements = [0, 0, 0.001, 0.005, 0.01, 0.02, 0.05];
    const priceImprovement =
      priceImprovements[Math.min(attempt, priceImprovements.length - 1)];

    try {
      if (attempt === 0) {
        avgExecutionPrice = await this.getMarkPrice(request.symbol);
      } else {
        const { bestBid, bestAsk } = await this.getOrderBookBidAsk(
          request.symbol,
        );
        avgExecutionPrice = isBuy ? bestAsk : bestBid;
      }
    } catch (e) {
      const { bestBid, bestAsk } = await this.getOrderBookBidAsk(
        request.symbol,
      ).catch(() => ({ bestBid: 0, bestAsk: 0 }));
      avgExecutionPrice = isBuy ? bestAsk : bestBid;
      if (!avgExecutionPrice)
        throw new Error(
          `Could not get price for ${request.symbol}: ${e.message}`,
        );
    }

    const adjustedPrice = isBuy
      ? avgExecutionPrice * (1 + priceImprovement)
      : avgExecutionPrice * (1 - priceImprovement);

    const orderParams = {
      marketIndex,
      clientOrderIndex: Date.now(),
      baseAmount,
      isAsk,
      orderType: LighterOrderType.MARKET,
      idealPrice: market.priceToUnits(adjustedPrice),
      maxSlippage: 0.05,
      orderExpiry: 0,
      reduceOnly: true,
      nonce: nonce || undefined,
    };

    const result = (await this.callApi(this.WEIGHT_TX, () =>
      (this.signerClient as any).createUnifiedOrder(orderParams),
    )) as any;

    if (!result.success) {
      throw new Error(`Failed to close position: ${result.mainOrder?.error || 'Unknown error'}`);
    }

    const hash = result.mainOrder.hash;

    try {
      await this.signerClient!.waitForTransaction(hash, 30000, 2000);
    } catch (e) {}

    return new PerpOrderResponse(
      hash,
      OrderStatus.SUBMITTED,
      request.symbol,
      request.side,
      request.clientOrderId,
      undefined,
      undefined,
      undefined,
      new Date(),
    );
  }

  private async executeLighterMarketOpen(
    request: PerpOrderRequest,
    marketIndex: number,
    market: any,
    attempt: number,
    maxRetries: number,
    nonce: number | null,
  ): Promise<PerpOrderResponse> {
    const isBuy = request.side === OrderSide.LONG;
    const isAsk = !isBuy;
    const baseAmount = market.amountToUnits(request.size);

    let idealPrice: number;
    const priceImprovements = [0, 0, 0.001, 0.005, 0.01, 0.02, 0.05];
    const priceImprovement =
      priceImprovements[Math.min(attempt, priceImprovements.length - 1)];

    try {
      if (attempt === 0) {
        idealPrice = await this.getMarkPrice(request.symbol);
      } else {
        const { bestBid, bestAsk } = await this.getOrderBookBidAsk(
          request.symbol,
        );
        idealPrice = isBuy ? bestAsk : bestBid;
      }
    } catch (e) {
      const { bestBid, bestAsk } = await this.getOrderBookBidAsk(
        request.symbol,
      ).catch(() => ({ bestBid: 0, bestAsk: 0 }));
      idealPrice = isBuy ? bestAsk : bestBid;
      if (!idealPrice)
        throw new Error(
          `Could not get price for ${request.symbol}: ${e.message}`,
        );
    }

    const adjustedPrice = isBuy
      ? idealPrice * (1 + priceImprovement)
      : idealPrice * (1 - priceImprovement);

    const orderParams = {
      marketIndex,
      clientOrderIndex: Date.now(),
      baseAmount,
      isAsk,
      orderType: LighterOrderType.MARKET,
      idealPrice: market.priceToUnits(adjustedPrice),
      maxSlippage: 0.05,
      orderExpiry: 0,
      reduceOnly: false,
      nonce: nonce || undefined,
    };

    const result = (await this.callApi(this.WEIGHT_TX, () =>
      (this.signerClient as any).createUnifiedOrder(orderParams),
    )) as any;

    if (!result.success) {
      throw new Error(`Failed to open market order: ${result.mainOrder?.error || 'Unknown error'}`);
    }

    const hash = result.mainOrder.hash;

    return new PerpOrderResponse(
      hash,
      OrderStatus.SUBMITTED,
      request.symbol,
      request.side,
      request.clientOrderId,
      undefined,
      undefined,
      undefined,
      new Date(),
    );
  }

  private async executeLighterLimitOrder(
    request: PerpOrderRequest,
    marketIndex: number,
    market: any,
    nonce: number | null,
  ): Promise<PerpOrderResponse> {
    const isBuy = request.side === OrderSide.LONG;
    const isAsk = !isBuy;
    const baseAmount = market.amountToUnits(request.size);

    if (!request.price) throw new Error('Limit order requires a price');

    const now = Date.now();
    const EXPIRY_DURATION_MS = 60 * 60 * 1000; // 1 hour
    const orderExpiry = now + EXPIRY_DURATION_MS;

    const orderParams = {
      marketIndex,
      clientOrderIndex: now,
      baseAmount,
      price: market.priceToUnits(request.price!),
      isAsk,
      orderType: LighterOrderType.LIMIT,
      orderExpiry,
      reduceOnly: request.reduceOnly || false,
      nonce: nonce || undefined,
    };

    const result = (await this.callApi(this.WEIGHT_TX, () =>
      this.signerClient!.createUnifiedOrder(orderParams),
    )) as any;

    if (!result.success) {
      throw new Error(`Failed to place limit order: ${result.mainOrder?.error || 'Unknown error'}`);
    }

    const hash = result.mainOrder.hash;

    // Track this order for status matching (tx hash -> order details)
    this.pendingOrdersMap.set(hash, {
      symbol: request.symbol,
      side: request.side,
      size: request.size,
      price: request.price,
      placedAt: new Date(),
    });
    this.cleanupPendingOrders(); // Cleanup old entries

    return new PerpOrderResponse(
      hash,
      OrderStatus.SUBMITTED,
      request.symbol,
      request.side,
      request.clientOrderId,
      undefined,
      undefined,
      undefined,
      new Date(),
    );
  }

  /**
   * Cleanup old pending orders from tracking map
   */
  private cleanupPendingOrders(): void {
    const now = Date.now();
    for (const [hash, order] of this.pendingOrdersMap.entries()) {
      if (now - order.placedAt.getTime() > this.PENDING_ORDER_TTL_MS) {
        this.pendingOrdersMap.delete(hash);
      }
    }
  }

  /**
   * Modify an existing order with automatic nonce error handling
   */
  async modifyOrder(
    orderId: string,
    request: PerpOrderRequest,
    maxRetries: number = 3,
  ): Promise<PerpOrderResponse> {
      await this.ensureInitialized();

      const marketIndex = await this.getMarketIndex(request.symbol);
      const market = await this.getMarketHelper(marketIndex);

      // CRITICAL FIX: Lighter's modifyOrder requires numeric orderIndex
      // If we have a transaction hash (orderId), we must find the corresponding orderIndex first
      let orderIndex = parseInt(orderId, 10);
      
      const isTransactionHash = orderId.length > 20 && /^[0-9a-f]+$/i.test(orderId);
      if (isTransactionHash || isNaN(orderIndex) || orderIndex === 0) {
        this.logger.debug(`Searching for orderIndex for ${request.symbol} ${request.side} (tx: ${orderId.substring(0, 8)}...)`);
        
        // Find order index from active orders
        const activeOrders = await this.getOpenOrders();
        // Map request.side (LONG/SHORT) to open order side format (buy/sell)
        const requestSideNormalized = request.side === OrderSide.LONG || request.side.toUpperCase() === 'LONG' ? 'buy' : 'sell';
        const matchingOrder = activeOrders.find(o => 
          o.symbol === request.symbol && 
          o.side.toLowerCase() === requestSideNormalized
        );

        if (!matchingOrder) {
        throw new ExchangeError(
          `Could not find active order index for ${request.symbol} ${request.side}`,
          ExchangeType.LIGHTER,
        );
        }

        orderIndex = Math.floor(parseFloat(matchingOrder.orderId));
        this.logger.debug(`Found orderIndex ${orderIndex} for ${request.symbol}`);
      }

      // Format parameters using market helper units
      const amount = market.amountToUnits(request.size);
      const price = market.priceToUnits(request.price || 0);
      const triggerPrice = BigInt(0); // No trigger price for non-conditional orders

    // Acquire mutex to prevent concurrent nonce conflicts with other operations
    const releaseMutex = await this.acquireOrderMutex();

    try {
      // Retry loop with nonce error handling
      let nonce: number | null = null;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          // Fetch a fresh nonce explicitly before each modify attempt
          nonce = await this.getFreshNonce();
          
          this.logger.debug(
            `🔄 Modifying order ${orderIndex} on Lighter: ${request.symbol} @ ${request.price} ` +
            `(nonce: ${nonce}, attempt ${attempt + 1}/${maxRetries})`,
          );

      // Use positional arguments matching modify_order.ts example
      // Pass RateLimitPriority.HIGH to callApi for maker repositioning
      const result = await this.callApi(this.WEIGHT_TX, () => (this.signerClient as any).modifyOrder(
        marketIndex,
        orderIndex,
        amount,
        price,
        triggerPrice,
            nonce || undefined // Pass the fresh nonce!
      ), RateLimitPriority.HIGH) as [any, string, string | null];
      
      const [tx, txHash, error] = result;

      if (error) {
        throw new Error(error);
      }

        // Order modification succeeded - track the nonce as successful
        if (nonce !== null) {
          this.lastSuccessfulNonce = nonce;
          this.failedNonceAttempts.delete(nonce);
          this.lastFailedNonce = null;
        }
        
        // Reset consecutive nonce errors on success
        this.consecutiveNonceErrors = 0;

      this.logger.log(`✅ Order ${orderIndex} modified successfully: ${txHash}`);

        // Wait for transaction (non-blocking timeout)
      try {
        await this.signerClient!.waitForTransaction(txHash, 30000, 2000);
      } catch (waitError: any) {
        this.logger.debug(`Update wait timeout: ${waitError.message}`);
      }

      return new PerpOrderResponse(
        orderIndex.toString(),
        OrderStatus.SUBMITTED,
        request.symbol,
        request.side,
        request.clientOrderId,
        undefined,
        undefined,
        undefined,
        new Date(),
      );
    } catch (error: any) {
        const errorMsg = error.message || String(error);
        
        // Track failed nonce
        if (nonce !== null) {
          this.lastFailedNonce = nonce;
          const attempts = (this.failedNonceAttempts.get(nonce) || 0) + 1;
          this.failedNonceAttempts.set(nonce, attempts);
        }
        
        // Check if this is a nonce error
        const isNonceError = this.isNonceError(error);

        if (isNonceError && attempt < maxRetries - 1) {
          this.consecutiveNonceErrors++;
          
          this.logger.warn(
            `⚠️ Lighter nonce error #${this.consecutiveNonceErrors} modifying order for ${request.symbol}: ${errorMsg}. ` +
            `Re-syncing nonce and retrying (attempt ${attempt + 1}/${maxRetries})...`,
          );

          // IMPROVED: Try lightweight refresh first
          let refreshed = false;
          if (this.consecutiveNonceErrors < 3) {
            refreshed = await this.tryLightweightNonceRefresh();
          }
          
          if (!refreshed) {
            // Fall back to full SignerClient recreation
            await this.resetSignerClient();
          }

          // Progressive backoff - reduced for faster recovery
          const nonceBackoff = Math.min(500 * Math.pow(2, attempt), 3000);
          this.logger.debug(`Waiting ${nonceBackoff}ms before retry after nonce error`);
          await new Promise((resolve) => setTimeout(resolve, nonceBackoff));
          continue;
        }

        // Not a nonce error or last attempt
        
        // CRITICAL FALLBACK: If WASM signer doesn't support modifyOrder, use cancel + place
        if (errorMsg.includes('modifyOrder not supported with WASM signer')) {
          this.logger.warn(`⚠️ WASM signer does not support modifyOrder for ${request.symbol}. Falling back to cancel + place...`);
          
          try {
            // 1. Cancel the existing order
            await this.cancelOrder(orderId, request.symbol);
            
            // 2. Place a new order
            return await this.placeOrder(request);
          } catch (fallbackError: any) {
            this.logger.error(`❌ Fallback cancel+place failed for ${request.symbol}: ${fallbackError.message}`);
            throw fallbackError;
          }
        }

        this.logger.error(`Failed to modify order ${orderId}: ${errorMsg}`);
        throw new ExchangeError(
          `Failed to modify order: ${errorMsg}`,
          ExchangeType.LIGHTER,
          undefined,
          error,
        );
    }
  }

    // Should not reach here, but just in case
    throw new ExchangeError(
      `Failed to modify order after ${maxRetries} attempts`,
      ExchangeType.LIGHTER,
    );
    } finally {
      // Always release the mutex when done
      releaseMutex();
    }
  }

  async cancelOrder(orderId: string, symbol?: string, maxRetries: number = 3): Promise<boolean> {
    const releaseMutex = await this.acquireOrderMutex();
    try {
      await this.ensureInitialized();

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            this.logger.warn(`Retrying cancelOrder for ${symbol} after ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }

          // Fetch a fresh nonce
          const nonce = await this.getFreshNonce();

      // CRITICAL FIX: Lighter's cancelOrder requires { marketIndex, orderIndex }
      // NOT the transaction hash! We need to find the actual order from open orders.

      // First, check if orderId is a transaction hash (64+ chars hex) or a numeric order index
      const isTransactionHash =
        orderId.length > 20 && /^[0-9a-f]+$/i.test(orderId);

      if (isTransactionHash) {
        // Transaction hash passed - we need to find the actual order to cancel
        // This happens when we're trying to cancel an order we just placed
        this.logger.warn(
          `⚠️ cancelOrder called with transaction hash ${orderId.substring(0, 16)}... - ` +
            `Lighter requires numeric orderIndex. Looking up open orders...`,
        );

        if (!symbol) {
          this.logger.error(
            '❌ Cannot cancel order: symbol is required when using transaction hash',
          );
          throw new ExchangeError(
            'Symbol is required to cancel Lighter order by transaction hash',
            ExchangeType.LIGHTER,
          );
        }

        // Get market index for the symbol
        const marketIndex = await this.getMarketIndex(symbol);

        // Get open orders for this market
        const authToken =
          await this.signerClient!.createAuthTokenWithExpiry(600);
        const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(
          `${this.config.baseUrl}/api/v1/accountActiveOrders`,
          {
            params: {
              auth: authToken,
              market_id: marketIndex,
              account_index: this.config.accountIndex,
            },
            timeout: 10000,
            headers: { accept: 'application/json' },
          },
        ));

        if (!response.data || response.data.code !== 200) {
          this.logger.warn(
            `No open orders found for ${symbol} - order may have already filled/cancelled`,
          );
          return true; // Consider it "cancelled" if no orders exist
        }

        const orders = response.data.orders || [];
        if (orders.length === 0) {
          this.logger.warn(
            `No open orders found for ${symbol} - order may have already filled/cancelled`,
          );
          return true;
        }

        // Cancel all orders for this market (since we can't match by tx hash)
        // This is the safest approach when we don't know which specific order to cancel
        this.logger.log(
          `🗑️ Found ${orders.length} open order(s) for ${symbol} - cancelling all...`,
        );

        let cancelledCount = 0;
        for (const order of orders) {
          // Order indices can exceed Number.MAX_SAFE_INTEGER
          // The SDK WASM expects a number - we use parseFloat which preserves more precision
          // than parseInt for large numbers, then floor it
          const orderIndexStr = String(order.order_id || order.order_index || '0');
          const orderIndex = Math.floor(parseFloat(orderIndexStr));
          if (orderIndex <= 0) continue;

          try {
            this.logger.debug(
              `Cancelling order ${orderIndex} for market ${marketIndex}...`,
            );
            // SDK types are incorrect - it actually accepts { marketIndex, orderIndex, nonce } object
            const [tx, txHash, error] = await (
              this.signerClient as any
            ).cancelOrder({
              marketIndex,
              orderIndex,
              nonce: nonce || undefined
            });

            if (error) {
              this.logger.warn(
                `Failed to cancel order ${orderIndex}: ${error}`,
              );
              continue;
            }

            // Wait for cancellation to be processed
            try {
              await this.signerClient!.waitForTransaction(txHash, 15000, 2000);
            } catch (waitError: any) {
              this.logger.debug(
                `Cancel wait timeout (may still succeed): ${waitError.message}`,
              );
            }

            cancelledCount++;
            this.logger.log(
              `✅ Cancelled order ${orderIndex} (tx: ${txHash.substring(0, 16)}...)`,
            );
          } catch (cancelError: any) {
            this.logger.warn(
              `Error cancelling order ${orderIndex}: ${cancelError.message}`,
            );
          }
        }

        if (cancelledCount === 0) {
          this.logger.warn(
            `⚠️ No orders were successfully cancelled for ${symbol}`,
          );
        } else {
          this.logger.log(
            `✅ Successfully cancelled ${cancelledCount}/${orders.length} order(s) for ${symbol}`,
          );
        }

        return cancelledCount > 0;
      } else {
        // Numeric order index passed - cancel directly
        const orderIndex = Math.floor(parseFloat(orderId));
        if (isNaN(orderIndex) || orderIndex <= 0) {
          this.logger.error(`❌ Invalid order index: ${orderId}`);
          throw new ExchangeError(
            `Invalid order index: ${orderId}`,
            ExchangeType.LIGHTER,
          );
        }

        // Need market index - get from symbol
        if (!symbol) {
          this.logger.error('❌ Cannot cancel order: symbol is required');
          throw new ExchangeError(
            'Symbol is required to cancel Lighter order',
            ExchangeType.LIGHTER,
          );
        }

        const marketIndex = await this.getMarketIndex(symbol);

        this.logger.log(
          `🗑️ Cancelling Lighter order ${orderIndex} for market ${marketIndex}...`,
        );

        // SDK types are incorrect - it actually accepts { marketIndex, orderIndex, nonce } object
        const result = await this.callApi(this.WEIGHT_TX, () => (
          this.signerClient as any
        ).cancelOrder({
          marketIndex,
          orderIndex,
          nonce: nonce || undefined
        })) as [any, string, string | null];
        const [tx, txHash, error] = result;

        if (error) {
          this.logger.error(`❌ Cancel order failed: ${error}`);
          throw new ExchangeError(
            `Failed to cancel order: ${error}`,
            ExchangeType.LIGHTER,
          );
        }

        // Wait for cancellation to be processed
        try {
          await this.signerClient!.waitForTransaction(txHash, 15000, 2000);
        } catch (waitError: any) {
          this.logger.debug(
            `Cancel wait timeout (may still succeed): ${waitError.message}`,
          );
        }

        this.logger.log(
          `✅ Order ${orderIndex} cancelled successfully (tx: ${txHash.substring(0, 16)}...)`,
        );
        return true;
      }
    } catch (error: any) {
      if (this.isNonceError(error) && attempt < maxRetries - 1) {
        this.consecutiveNonceErrors++;
        this.logger.warn(`⚠️ Nonce error cancelling order: ${error.message}. Retrying...`);
        
        let refreshed = false;
        if (this.consecutiveNonceErrors < 3) {
          refreshed = await this.tryLightweightNonceRefresh();
        }
        if (!refreshed) {
          await this.resetSignerClient();
        }
        continue;
      }
      throw error;
    }
  }
  return false;
    } catch (error: any) {
      this.logger.error(`Failed to cancel order: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel order: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
} finally {
  // Always release the mutex when done
  releaseMutex();
    }
  }

async cancelAllOrders(symbol: string, maxRetries: number = 3): Promise<number> {
const releaseMutex = await this.acquireOrderMutex();
    try {
      await this.ensureInitialized();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        this.logger.warn(`Retrying cancelAllOrders for ${symbol} after ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // Fetch a fresh nonce
      const nonce = await this.getFreshNonce();

      const marketIndex = await this.getMarketIndex(symbol);

      // Get open orders for this specific market first
      const authToken = await this.signerClient!.createAuthTokenWithExpiry(600);
      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(
        `${this.config.baseUrl}/api/v1/accountActiveOrders`,
        {
          params: {
            auth: authToken,
            market_id: marketIndex,
            account_index: this.config.accountIndex,
          },
          timeout: 10000,
          headers: { accept: 'application/json' },
        },
      ));

      if (!response.data || response.data.code !== 200) {
        this.logger.debug(`No open orders found for ${symbol}`);
        return 0;
      }

      const orders = response.data.orders || [];
      if (orders.length === 0) {
        this.logger.debug(`No open orders to cancel for ${symbol}`);
        return 0;
      }

      this.logger.log(
        `🗑️ Cancelling ${orders.length} order(s) for ${symbol}...`,
      );

      // Cancel each order individually (more reliable than cancelAllOrders which affects ALL markets)
      let cancelledCount = 0;
      for (const order of orders) {
        const orderIndex = parseInt(order.order_id || order.order_index || '0');
        if (orderIndex <= 0) continue;

        try {
          // SDK types are incorrect - it actually accepts { marketIndex, orderIndex, nonce } object
          const [tx, txHash, error] = await (
            this.signerClient as any
          ).cancelOrder({
            marketIndex,
            orderIndex,
            nonce: nonce || undefined
          });

          if (error) {
            this.logger.warn(`Failed to cancel order ${orderIndex}: ${error}`);
            continue;
          }

          // Wait briefly for cancellation
          try {
            await this.signerClient!.waitForTransaction(txHash, 10000, 2000);
          } catch (waitError: any) {
            this.logger.debug(`Cancel wait timeout: ${waitError.message}`);
          }

          cancelledCount++;
          this.logger.debug(`Cancelled order ${orderIndex}`);
        } catch (cancelError: any) {
          this.logger.warn(
            `Error cancelling order ${orderIndex}: ${cancelError.message}`,
          );
        }
      }

      if (cancelledCount > 0) {
        this.logger.log(
          `✅ Cancelled ${cancelledCount}/${orders.length} order(s) for ${symbol}`,
        );
      }

      return cancelledCount;
    } catch (error: any) {
      if (this.isNonceError(error) && attempt < maxRetries - 1) {
        this.consecutiveNonceErrors++;
        this.logger.warn(`⚠️ Nonce error cancelling all orders for ${symbol}: ${error.message}. Retrying...`);
        
        let refreshed = false;
        if (this.consecutiveNonceErrors < 3) {
          refreshed = await this.tryLightweightNonceRefresh();
        }
        if (!refreshed) {
          await this.resetSignerClient();
        }
        continue;
      }
      throw error;
    }
  }
  return 0;
    } catch (error: any) {
      this.logger.error(`Failed to cancel all orders: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel all orders: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
} finally {
  // Always release the mutex
  releaseMutex();
    }
  }

  /**
   * Get all open orders for this account
   * Uses Lighter API: /api/v1/accountActiveOrders (requires auth token)
   *
   * Returns orders with: orderId, symbol, side, price, size, filledSize, timestamp
   * Used for deduplication checks to prevent placing multiple orders for single-leg hedging
   */
  async getOpenOrders(): Promise<OpenOrder[]> {
    try {
      await this.ensureInitialized();

      // 1. WebSocket First Strategy (Latency: ~0ms)
      if (this.wsProvider?.hasOrderData()) {
        const cachedOrders = this.wsProvider.getCachedOrders();
        if (cachedOrders) {
          const mappedOrders: OpenOrder[] = [];
          for (const order of cachedOrders.values()) {
            const symbol = await this.getSymbolFromMarketIndex(order.marketIndex);
            if (symbol) {
              mappedOrders.push({
                orderId: order.orderId,
                symbol,
                side: order.side,
                price: order.price,
                size: order.size,
                filledSize: order.filledSize,
                timestamp: order.lastUpdated,
              });
            }
          }
          if (mappedOrders.length > 0) return mappedOrders;
        }
      }

      this.logger.debug('📡 WS cache miss/unsynced. Falling back to Lighter REST API...');

      // 2. Optimized REST Fetch
      const authToken = await this.signerClient!.createAuthTokenWithExpiry(600);
      const accountResponse = await this.callApi<any>(this.WEIGHT_INFO, () => axios.get(
        `${this.config.baseUrl}/api/v1/account`,
        {
          params: { by: 'index', value: String(this.config.accountIndex) },
          timeout: 10000,
          headers: { accept: 'application/json' },
        },
      ));

      const positions = (accountResponse.data?.accounts?.[0]?.positions || []) as LighterPosition[];
      const activeMarketIds = positions
        .filter(p => (Number(p.open_order_count) || 0) > 0 || (Number(p.pending_order_count) || 0) > 0)
        .map(p => Number(p.market_id));

      if (activeMarketIds.length === 0) return [];

      // 3. Parallel Execution
      const orderPromises = activeMarketIds.map(async (marketId) => {
        try {
          const response = await this.callApi<any>(this.WEIGHT_INFO, () => axios.get(
            `${this.config.baseUrl}/api/v1/accountActiveOrders`,
            {
              params: {
                auth: authToken,
                market_id: marketId,
                account_index: this.config.accountIndex,
              },
              timeout: 10000,
              headers: { accept: 'application/json' },
            },
          ));
          return { marketId, orders: (response.data?.orders || []) as LighterOrder[] };
        } catch (e: any) {
          this.logger.error(`Failed to fetch orders for market ${marketId}: ${e.message}`);
          return { marketId, orders: [] };
        }
      });

      const results = await Promise.all(orderPromises);
      const allOrders: OpenOrder[] = [];

      for (const { marketId, orders } of results) {
        const symbol = await this.getSymbolFromMarketIndex(marketId);
        if (!symbol) continue;

        for (const o of orders) {
          allOrders.push(this.mapLighterOrderToOpenOrder(o, symbol));
        }
      }

      return allOrders;
    } catch (error: any) {
      this.recordError('FETCH_OPEN_ORDERS_FAILED', error.message);
      return [];
    }
  }

  /**
   * Maps a raw LighterOrder to the domain OpenOrder structure
   */
  private mapLighterOrderToOpenOrder(o: LighterOrder, symbol: string): OpenOrder {
    return {
      orderId: String(o.order_id || o.order_index || ''),
      symbol,
      side: o.is_ask ? 'sell' : 'buy',
      price: parseFloat(o.price || '0'),
      size: Math.abs(parseFloat(o.remaining_base_amount || o.initial_base_amount || '0')),
      filledSize: Math.abs(parseFloat(o.filled_base_amount || '0')),
      timestamp: this.parseLighterTimestamp(o),
    };
  }

  /**
   * Parses various timestamp formats from Lighter API responses
   */
  private parseLighterTimestamp(o: any): Date {
    if (o.created_time) {
      return new Date(o.created_time < 1e12 ? o.created_time * 1000 : o.created_time);
    }
    
    if (o.nonce) {
      const nonceTimestamp = Math.floor(Number(o.nonce) / 2 ** 32);
      if (nonceTimestamp > 0 && nonceTimestamp < 2e9) {
        return new Date(nonceTimestamp * 1000);
      }
    }

    return new Date();
  }

  async getOrderStatus(
    orderId: string,
    symbol?: string,
  ): Promise<PerpOrderResponse> {
    try {
      await this.ensureInitialized();

      if (!symbol) {
        this.logger.warn(
          'getOrderStatus: Symbol required for Lighter order status check',
        );
        return new PerpOrderResponse(
          orderId,
          OrderStatus.SUBMITTED,
          'UNKNOWN',
          OrderSide.LONG,
          undefined,
          undefined,
          undefined,
          'Symbol required for Lighter order status check',
          new Date(),
        );
      }

      // STEP 1: Check WebSocket cache first (fastest, real-time)
      // According to Lighter WebSocket docs: https://apidocs.lighter.xyz/docs/websocket-reference
      // The account_all_orders channel provides real-time order status including status, filled_base_amount
      if (this.wsProvider) {
        const cachedOrders = this.wsProvider.getCachedOrders();
        if (cachedOrders) {
          const cachedOrder = cachedOrders.get(orderId);
          if (cachedOrder) {
            // Map Lighter status to our OrderStatus
            // From WebSocket docs: status can be "filled", "open", "cancelled", etc.
            let status: OrderStatus;
            if (cachedOrder.status === 'filled' || cachedOrder.status === 'FILLED') {
              status = OrderStatus.FILLED;
            } else if (cachedOrder.status === 'cancelled' || cachedOrder.status === 'CANCELLED') {
              status = OrderStatus.CANCELLED;
            } else {
              status = OrderStatus.SUBMITTED; // open, pending, etc.
            }

            this.logger.debug(
              `📡 getOrderStatus (WebSocket): Order ${orderId} status=${cachedOrder.status}, ` +
              `filled=${cachedOrder.filledSize}/${cachedOrder.size}`,
            );

            return new PerpOrderResponse(
              orderId,
              status,
              symbol,
              cachedOrder.side === 'buy' ? OrderSide.LONG : OrderSide.SHORT,
              undefined,
              cachedOrder.filledSize,
              cachedOrder.price,
              undefined,
              cachedOrder.lastUpdated,
            );
          }
        }
      }

      // STEP 2: Fallback to REST API (check open orders)
      try {
        const openOrders = await this.getOpenOrders();
        
        // CRITICAL FIX: orderId might be a transaction hash, but openOrders use Lighter order index
        // First try direct match (in case orderId is already an order index)
        let orderStillOpen = openOrders.find((o) => o.orderId === orderId);
        
        // If no direct match and we have tracking info, match by symbol/side/size
        if (!orderStillOpen) {
          const trackedOrder = this.pendingOrdersMap.get(orderId);
          if (trackedOrder) {
            // Find matching order by symbol and side
            const sideStr = trackedOrder.side === OrderSide.LONG ? 'buy' : 'sell';
            orderStillOpen = openOrders.find((o) => 
              o.symbol === trackedOrder.symbol && 
              o.side.toLowerCase() === sideStr &&
              // Match size within 1% tolerance (Lighter may round)
              Math.abs(o.size - trackedOrder.size) / trackedOrder.size < 0.01
            );
            
            if (orderStillOpen) {
              this.logger.debug(
                `📍 Matched tx hash ${orderId.substring(0, 16)}... to Lighter order ${orderStillOpen.orderId} ` +
                `(${trackedOrder.symbol} ${sideStr} ${trackedOrder.size})`
              );
            }
          }
        }
        
        if (orderStillOpen) {
          // Order is still open - return SUBMITTED with filled size
          return new PerpOrderResponse(
            orderId,
            OrderStatus.SUBMITTED,
            symbol,
            orderStillOpen.side === 'buy' ? OrderSide.LONG : OrderSide.SHORT,
            undefined,
            orderStillOpen.filledSize || 0,
            orderStillOpen.price,
            undefined,
            new Date(),
          );
        }

        // STEP 3: Order not in open orders - check if we have tracking info
        const trackedOrder = this.pendingOrdersMap.get(orderId);
        
        // CRITICAL FIX: We can ONLY determine FILLED if:
        // 1. We have tracking info for this order (we know what we placed)
        // 2. The order is NOT in open orders (confirmed above)
        // 3. AND we can verify the position INCREASED by the expected amount
        // 
        // Previously, we incorrectly assumed "position exists = filled" which caused
        // massive imbalances when existing positions were mistaken for new fills.
        
        if (trackedOrder) {
          const orderAge = Date.now() - trackedOrder.placedAt.getTime();
          
          // If order is very new (< 5 seconds), give Lighter time to process it
          // The order might not have appeared in open orders yet
          if (orderAge < 5000) {
            this.logger.debug(
              `getOrderStatus: Order ${orderId.substring(0, 16)}... not found in open orders yet ` +
              `(age: ${orderAge}ms, expected size: ${trackedOrder.size}). ` +
              `Waiting for Lighter to process...`
            );
            return new PerpOrderResponse(
              orderId,
              OrderStatus.SUBMITTED,
              symbol,
              trackedOrder.side,
              undefined,
              0,
              trackedOrder.price,
              undefined,
              new Date(),
            );
          }
          
          // Order is old enough - check if position changed
          const positions = await this.getPositions();
          const matchingPosition = positions.find(
            (p) => p.symbol === symbol && 
            p.side === trackedOrder.side &&
            Math.abs(p.size) > 0.0001,
          );
          
          if (matchingPosition) {
            // If order is missing from open orders but a position exists, 
            // it's highly likely it filled. We return FILLED to stop the repricer.
            this.pendingOrdersMap.delete(orderId);
            this.logger.log(
              `✅ getOrderStatus: Order ${orderId.substring(0, 16)}... filled (detected via position existence, age: ${Math.round(orderAge / 1000)}s)`,
            );
            return new PerpOrderResponse(
              orderId,
              OrderStatus.FILLED,
              symbol,
              trackedOrder.side,
              undefined,
              trackedOrder.size, // Use expected size as we assume full fill
              trackedOrder.price,
              undefined,
              new Date(),
            );
          } else {
            // No matching position - order might have been cancelled or still processing
            if (orderAge >= 300000) {
              this.pendingOrdersMap.delete(orderId);
              this.logger.debug(
                `getOrderStatus: Order ${orderId.substring(0, 16)}... not in open orders after ${Math.round(orderAge/1000)}s ` +
                `and no position for ${symbol}. Assuming CANCELLED.`
              );
              return new PerpOrderResponse(
                orderId,
                OrderStatus.CANCELLED,
                symbol,
                trackedOrder.side,
                undefined,
                0,
                trackedOrder.price,
                undefined,
                new Date(),
              );
            } else {
              // Still waiting
              this.logger.debug(
                `getOrderStatus: Order ${orderId.substring(0, 16)}... not found yet (age: ${orderAge}ms). Returning SUBMITTED.`
              );
              return new PerpOrderResponse(
                orderId,
                OrderStatus.SUBMITTED,
                symbol,
                trackedOrder.side,
                undefined,
                0,
                trackedOrder.price,
                undefined,
                new Date(),
              );
            }
          }
        }
        
        // No tracking info - we don't know what this order was
        // Check if position exists as a last resort
        const positions = await this.getPositions();
        const matchingPosition = positions.find(
          (p) => p.symbol === symbol && Math.abs(p.size) > 0.0001,
        );

        if (matchingPosition) {
          // Position exists but we have no tracking info
          // This is ambiguous - could be from a different order
          this.logger.warn(
            `⚠️ getOrderStatus: Order ${orderId.substring(0, 16)}... has no tracking info. ` +
            `Position exists for ${symbol} (${matchingPosition.side}, size: ${matchingPosition.size}) ` +
            `but cannot confirm this order filled. Returning SUBMITTED to force position delta check.`
          );
          // Return SUBMITTED instead of FILLED to force the caller to verify via position delta
          return new PerpOrderResponse(
            orderId,
            OrderStatus.SUBMITTED,
            symbol,
            matchingPosition.side === OrderSide.LONG ? OrderSide.LONG : OrderSide.SHORT,
            undefined,
            0, // Don't report filled size - we don't know!
            matchingPosition.entryPrice || matchingPosition.markPrice,
            undefined,
            new Date(),
          );
        } else {
          // No position exists and no tracking info
          // Order not in open orders + no position = likely cancelled
          this.logger.debug(
            `getOrderStatus: Order ${orderId.substring(0, 16)}... not in open orders and no position for ${symbol}. May be cancelled.`,
          );
          return new PerpOrderResponse(
            orderId,
            OrderStatus.CANCELLED,
            symbol,
            OrderSide.LONG, // Default, actual side unknown
            undefined,
            0,
            undefined,
            undefined,
            new Date(),
          );
        }
      } catch (error: any) {
        this.logger.debug(
          `Could not check order status: ${error.message}. Returning SUBMITTED.`,
        );
        // Fallback: return SUBMITTED if we can't determine status
        return new PerpOrderResponse(
          orderId,
          OrderStatus.SUBMITTED,
          symbol,
          OrderSide.LONG, // Default, actual side unknown
          undefined,
          undefined,
          undefined,
          undefined,
          new Date(),
        );
      }
    } catch (error: any) {
      this.logger.error(`Failed to get order status: ${error.message}`);
      throw new ExchangeError(
        `Failed to get order status: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  private mapLighterOrderStatus(lighterStatus: string): OrderStatus {
    const statusMap: Record<string, OrderStatus> = {
      PENDING: OrderStatus.PENDING,
      OPEN: OrderStatus.SUBMITTED,
      FILLED: OrderStatus.FILLED,
      PARTIALLY_FILLED: OrderStatus.PARTIALLY_FILLED,
      CANCELLED: OrderStatus.CANCELLED,
      REJECTED: OrderStatus.REJECTED,
    };
    return statusMap[lighterStatus] || OrderStatus.PENDING;
  }

  // Price cache: key = symbol, value = { price: number, timestamp: number }
  private priceCache: Map<string, { price: number; timestamp: number }> =
    new Map();
  private readonly PRICE_CACHE_TTL = 10000; // 10 seconds cache

  // Order book cache: key = symbol, value = { bestBid, bestAsk, timestamp }
  private orderBookCache: Map<
    string,
    { bestBid: number; bestAsk: number; timestamp: number }
  > = new Map();
  private readonly ORDER_BOOK_CACHE_TTL = 2000; // 2 seconds - short TTL for order execution

  /**
   * Get actual bid/ask prices from the order book using /api/v1/orderBookOrders
   * This is more accurate than candlesticks for order execution
   */
  /**
   * Get best bid and ask prices for a symbol (IPerpExchangeAdapter compliance)
   */
  async getBestBidAsk(
    symbol: string,
    cacheOnly: boolean = false,
  ): Promise<{ bestBid: number; bestAsk: number } | null> {
    try {
      // 1. Try WebSocket provider first (zero cost, real-time)
      if (this.wsProvider) {
        try {
          const marketIndex = await this.getMarketIndex(symbol);
          const wsBest = this.wsProvider.getBestBidAsk(marketIndex);
          if (wsBest) {
            this.logger.debug(`🔍 getBestBidAsk: WebSocket best bid/ask for ${symbol}: bid=${wsBest.bestBid.toFixed(4)}, ask=${wsBest.bestAsk.toFixed(4)}`);
            return wsBest;
          } else {
            this.logger.debug(`🔍 getBestBidAsk: No WebSocket data yet for ${symbol}`);
          }
        } catch (e) {
          this.logger.warn(`⚠️ getBestBidAsk: WebSocket lookup failed for ${symbol}: ${e.message}`);
        }
      }

      if (cacheOnly) {
        this.logger.debug(`🔍 getBestBidAsk: Cache only mode for ${symbol}`);
        return null;
      }

      // 2. Fall back to existing method
      const restBest = await this.getOrderBookBidAsk(symbol);
      this.logger.debug(`🔍 getBestBidAsk: REST best bid/ask for ${symbol}: bid=${restBest?.bestBid.toFixed(4)}, ask=${restBest?.bestAsk.toFixed(4)}`);
      return restBest;
    } catch (error) {
      this.logger.warn(`⚠️ getBestBidAsk: Failed to get best bid/ask for ${symbol}: ${error.message}`);
      return null;
    }
  }

  async getOrderBookBidAsk(
    symbol: string,
  ): Promise<{ bestBid: number; bestAsk: number }> {
    // Check cache first (short TTL for execution accuracy)
    const cached = this.orderBookCache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.ORDER_BOOK_CACHE_TTL) {
      return { bestBid: cached.bestBid, bestAsk: cached.bestAsk };
    }

    try {
      await this.ensureInitialized();
      const marketIndex = await this.getMarketIndex(symbol);
      const baseUrl = this.config.baseUrl;

      // Use the orderBookOrders endpoint - requires market_id and limit
      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(`${baseUrl}/api/v1/orderBookOrders`, {
        params: {
          market_id: marketIndex,
          limit: 20,
        },
        timeout: 10000,
      }));

      const data = response.data;
      if (data.code !== 200) {
        throw new Error(`API returned code ${data.code}: ${data.message || 'Unknown error'}`);
      }

      const bids = data.bids || [];
      const asks = data.asks || [];

      if (bids.length === 0 && asks.length === 0) {
        throw new Error(`No orders in order book for ${symbol}`);
      }

      // Sort bids descending by price (highest bid first)
      bids.sort(
        (a: any, b: any) =>
          parseFloat(b.price || '0') - parseFloat(a.price || '0'),
      );
      // Sort asks ascending by price (lowest ask first)
      asks.sort(
        (a: any, b: any) =>
          parseFloat(a.price || '0') - parseFloat(b.price || '0'),
      );

      const bestBid = bids.length > 0 ? parseFloat(bids[0].price || '0') : 0;
      const bestAsk = asks.length > 0 ? parseFloat(asks[0].price || '0') : 0;

      if (bestBid <= 0 && bestAsk <= 0) {
        throw new Error(`Invalid order book prices for ${symbol}: bid=${bestBid}, ask=${bestAsk}`);
      }

      // Cache the result
      this.orderBookCache.set(symbol, {
        bestBid,
        bestAsk,
        timestamp: Date.now(),
      });

      return { bestBid, bestAsk };
    } catch (error: any) {
      this.logger.warn(
        `Failed to get order book for ${symbol}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Clear order book cache for a symbol (used before order execution)
   */
  clearOrderBookCache(symbol?: string): void {
    if (symbol) {
      this.orderBookCache.delete(symbol);
    } else {
      this.orderBookCache.clear();
    }
  }

  async getMarkPrice(symbol: string): Promise<number> {
    // Check cache first
    const cached = this.priceCache.get(symbol);
    if (cached && Date.now() - cached.timestamp < this.PRICE_CACHE_TTL) {
      return cached.price;
    }

    try {
      await this.ensureInitialized();
      const marketIndex = await this.getMarketIndex(symbol);

      // Method 1: Try WebSocket provider (zero cost, real-time)
      if (this.wsProvider) {
        const wsPrice = this.wsProvider.getMarkPrice(marketIndex);
        if (wsPrice !== undefined && wsPrice > 0) {
          this.priceCache.set(symbol, {
            price: wsPrice,
            timestamp: Date.now(),
          });
          return wsPrice;
        }
      }

      let markPrice: number | null = null;
      let lastError: string | null = null;

      // Method 2: Try candlesticks endpoint (proven to work reliably)
      // Using axios directly to avoid ES module import issues with @api/zklighter
      // Add retry logic for rate limiting (429 errors) with improved exponential backoff
      const maxRetries = 8; // Increased from 6 to 8 for more aggressive backoff
      const baseDelay = 3000; // 3 seconds base delay (was 2s)
      const maxDelay = 300000; // 5 minutes max delay (was 60s)

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            // Exponential backoff with jitter: 3s, 6s, 12s, 24s, 48s, 96s, 192s, 300s (capped)
            const exponentialDelay = Math.min(
              baseDelay * Math.pow(2, attempt - 1),
              maxDelay,
            );
            // Add jitter (±20%) to avoid thundering herd problem
            const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1); // Random between -20% and +20%
            const delay = Math.max(1000, exponentialDelay + jitter); // Minimum 1 second

            this.logger.debug(
              `Retrying candlesticks API for ${symbol} after ${Math.floor(delay / 1000)}s ` +
                `(attempt ${attempt + 1}/${maxRetries}, exponential: ${Math.floor(exponentialDelay / 1000)}s)`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          const now = Math.floor(Date.now() / 1000);
          const oneMinuteAgo = now - 60;
          const baseUrl = this.config.baseUrl;

          const candlestickResponse = await this.callApi(this.WEIGHT_INFO, () => axios.get(
            `${baseUrl}/api/v1/candlesticks`,
            {
              params: {
                market_id: marketIndex,
                resolution: '1m',
                start_timestamp: oneMinuteAgo,
                end_timestamp: now,
                count_back: 1,
                set_timestamp_to_end: true,
              },
              timeout: 10000,
            },
          ));

          const candlestickData = candlestickResponse.data;
          const candlesticks = candlestickData?.candlesticks || [];

          if (
            candlesticks &&
            Array.isArray(candlesticks) &&
            candlesticks.length > 0
          ) {
            const latest = candlesticks[candlesticks.length - 1];
            const closePrice = latest?.close; // Already a number from the API

            if (
              closePrice &&
              typeof closePrice === 'number' &&
              !isNaN(closePrice) &&
              closePrice > 0
            ) {
              markPrice = closePrice;
              this.priceCache.set(symbol, {
                price: markPrice,
                timestamp: Date.now(),
              });
              this.logger.debug(
                `Got price for ${symbol} from candlesticks: $${markPrice.toFixed(2)}`,
              );
              return markPrice;
            }
          }

          // If we got here, no price found but no error - break retry loop
          break;
        } catch (candlestickError: any) {
          const errorMsg =
            candlestickError?.message ||
            candlestickError?.toString() ||
            String(candlestickError);
          const errorResponse =
            candlestickError?.response?.data ||
            candlestickError?.response ||
            candlestickError?.data;
          const statusCode = candlestickError?.response?.status;

          // If it's a 429 (rate limit), retry with improved backoff
          if (statusCode === 429 && attempt < maxRetries - 1) {
            lastError = `Candlesticks API: Rate limited (429), will retry`;
            // Silenced 429 warnings - only show errors
            this.logger.debug(
              `Candlesticks method rate limited for ${symbol} (attempt ${attempt + 1}/${maxRetries}): ${errorMsg}. ` +
                `Will retry with exponential backoff.`,
            );
            continue; // Retry
          }

          // For other errors or final attempt, log and break
          lastError = `Candlesticks API: ${errorMsg}`;
          this.logger.debug(
            `Candlesticks method failed for ${symbol}: ${errorMsg}\n` +
              `Error response: ${JSON.stringify(errorResponse || {}).substring(0, 200)}`,
          );

          // If not a retryable error, break
          if (statusCode !== 429) {
            break;
          }
        }
      }

      // Method 1: Try order book (most accurate for bid/ask spread)
      // Try getOrderBookDetails with marketIndex (number)
      try {
        const response = await this.orderApi!.getOrderBookDetails({
          marketIndex: marketIndex,
        } as any);

        // Log the actual response structure for debugging
        this.logger.debug(
          `Order book response for ${symbol} (marketIndex: ${marketIndex}): ` +
            `${JSON.stringify(response).substring(0, 300)}`,
        );

        // Response structure: { code: 200, order_book_details: { bestBid: {...}, bestAsk: {...} } }
        const orderBook = (response as any)?.order_book_details || response;
        const bestBid = orderBook?.bestBid || orderBook?.best_bid;
        const bestAsk = orderBook?.bestAsk || orderBook?.best_ask;

        if (bestBid?.price && bestAsk?.price) {
          markPrice =
            (parseFloat(bestBid.price) + parseFloat(bestAsk.price)) / 2;
          if (markPrice > 0) {
            this.priceCache.set(symbol, {
              price: markPrice,
              timestamp: Date.now(),
            });
            return markPrice;
          }
        } else {
          // No price found in response - log what we got
          lastError = `Order book: No price data in response. Response keys: ${Object.keys(response || {}).join(', ')}. OrderBook keys: ${Object.keys(orderBook || {}).join(', ')}`;
          this.logger.warn(
            `Order book method returned no price for ${symbol} (marketIndex: ${marketIndex}). ` +
              `Response structure: ${JSON.stringify(response).substring(0, 400)}`,
          );
        }
      } catch (orderBookError: any) {
        const errorMsg =
          orderBookError?.message ||
          orderBookError?.toString() ||
          String(orderBookError);
        const errorResponse =
          orderBookError?.response?.data ||
          orderBookError?.response ||
          orderBookError?.data;
        lastError = `Order book (marketIndex): ${errorMsg}`;
        this.logger.error(
          `Order book method (marketIndex) failed for ${symbol} (marketIndex: ${marketIndex}): ` +
            `${errorMsg}\n` +
            `Error response: ${errorResponse ? JSON.stringify(errorResponse).substring(0, 400) : 'No error response'}\n` +
            `Full error: ${orderBookError ? JSON.stringify(orderBookError).substring(0, 400) : 'No error object'}`,
        );
      }

      // Method 1b: Try orderBooks with market_id as string (alternative endpoint)
      try {
        const apiClient = new ApiClient({ host: this.config.baseUrl });
        const orderBooksResponse = await (apiClient as any).order?.orderBooks({
          market_id: marketIndex.toString(),
        });

        // orderBooks returns metadata, not prices, but check if there's price data nested
        if (
          orderBooksResponse?.order_books &&
          Array.isArray(orderBooksResponse.order_books)
        ) {
          const marketBook = orderBooksResponse.order_books.find(
            (book: any) =>
              book.market_id === marketIndex ||
              book.market_id === marketIndex.toString(),
          );

          // orderBooks endpoint returns metadata (fees, min amounts) but not prices
          // So we can't get mark price from this endpoint
          // But we can verify the market exists and is active
          if (marketBook && marketBook.status === 'active') {
            this.logger.debug(
              `Market ${marketIndex} (${symbol}) verified via orderBooks API as active`,
            );
            // Continue to next method to get actual prices
          }
        }
      } catch (orderBooksError: any) {
        // This is expected - orderBooks doesn't return prices, just metadata
        this.logger.debug(
          `orderBooks API (metadata only, no prices): ${orderBooksError.message}`,
        );
      }

      // Method 2: Try funding rates API (may include mark price) - this is cached by LighterFundingDataProvider
      let fundingRates: any[] = [];
      try {
        const baseUrl =
          this.configService.get<string>('LIGHTER_API_BASE_URL') ||
          'https://mainnet.zklighter.elliot.ai';
        const fundingUrl = `${baseUrl}/api/v1/funding-rates`;
        const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(fundingUrl, {
          timeout: 10000,
        }));

        // Handle different response structures
        if (
          response.data?.funding_rates &&
          Array.isArray(response.data.funding_rates)
        ) {
          fundingRates = response.data.funding_rates;
        } else if (Array.isArray(response.data)) {
          fundingRates = response.data;
        }

        if (fundingRates.length > 0) {
          const marketRate = fundingRates.find(
            (r: any) =>
              r.market_id === marketIndex ||
              r.market_index === marketIndex ||
              r.marketIndex === marketIndex,
          );

          if (marketRate) {
            if (marketRate.mark_price) {
              markPrice = parseFloat(marketRate.mark_price);
            } else if (marketRate.price) {
              markPrice = parseFloat(marketRate.price);
            } else if (marketRate.lastPrice) {
              markPrice = parseFloat(marketRate.lastPrice);
            }

            if (markPrice && markPrice > 0) {
              this.priceCache.set(symbol, {
                price: markPrice,
                timestamp: Date.now(),
              });
              return markPrice;
            }
          }
        }
      } catch (fundingError: any) {
        const errorMsg =
          fundingError?.message ||
          fundingError?.toString() ||
          String(fundingError);
        const errorResponse =
          fundingError?.response?.data ||
          fundingError?.response ||
          fundingError?.data;
        lastError = `Funding rates API: ${errorMsg}`;
        const errorResponseStr = errorResponse
          ? JSON.stringify(errorResponse).substring(0, 400)
          : 'No error response';
        this.logger.warn(
          `Funding rates API method failed for ${symbol}: ${errorMsg}\n` +
            `Error response: ${errorResponseStr}`,
        );
      }

      // If funding rates API succeeded but no price found, log it
      if (!markPrice && fundingRates.length > 0) {
        const marketRate = fundingRates.find(
          (r: any) =>
            r.market_id === marketIndex ||
            r.market_index === marketIndex ||
            r.marketIndex === marketIndex,
        );
        if (marketRate) {
          lastError = `Funding rates API: Found market rate but no price field. Rate keys: ${Object.keys(marketRate).join(', ')}`;
          this.logger.warn(
            `Funding rates API returned data for ${symbol} but no price: ` +
              `${JSON.stringify(marketRate).substring(0, 300)}`,
          );
        } else {
          lastError = `Funding rates API: No market rate found for marketIndex ${marketIndex} in ${fundingRates.length} rates`;
        }
      }

      // Method 3: Try Explorer API: https://explorer.elliot.ai/api/markets/{SYMBOL}/logs
      // Retry with improved exponential backoff for rate limiting
      const explorerMaxRetries = 5;
      const explorerBaseDelay = 2000;
      const explorerMaxDelay = 60000;

      for (let attempt = 0; attempt < explorerMaxRetries; attempt++) {
        try {
          if (attempt > 0) {
            // Exponential backoff with jitter: 2s, 4s, 8s, 16s, 32s, 60s (capped)
            const exponentialDelay = Math.min(
              explorerBaseDelay * Math.pow(2, attempt - 1),
              explorerMaxDelay,
            );
            const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);
            const delay = Math.max(1000, exponentialDelay + jitter);

            this.logger.debug(
              `Retrying explorer API for ${symbol} after ${Math.floor(delay / 1000)}s ` +
                `(attempt ${attempt + 1}/${explorerMaxRetries})`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          const explorerUrl = `https://explorer.elliot.ai/api/markets/${symbol}/logs`;
          const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(explorerUrl, {
            timeout: 10000,
            headers: { accept: 'application/json' },
          }));

          // Try multiple response structures
          if (response.data) {
            // Structure 1: Direct price fields
            if (
              typeof response.data === 'object' &&
              !Array.isArray(response.data)
            ) {
              if (
                response.data.price &&
                !isNaN(parseFloat(response.data.price))
              ) {
                markPrice = parseFloat(response.data.price);
              } else if (
                response.data.markPrice &&
                !isNaN(parseFloat(response.data.markPrice))
              ) {
                markPrice = parseFloat(response.data.markPrice);
              } else if (
                response.data.lastPrice &&
                !isNaN(parseFloat(response.data.lastPrice))
              ) {
                markPrice = parseFloat(response.data.lastPrice);
              }
              // Structure 2: Nested data object
              else if (response.data.data) {
                if (response.data.data.price)
                  markPrice = parseFloat(response.data.data.price);
                else if (response.data.data.markPrice)
                  markPrice = parseFloat(response.data.data.markPrice);
                else if (response.data.data.lastPrice)
                  markPrice = parseFloat(response.data.data.lastPrice);
              }
              // Structure 3: Array of logs (get latest)
              else if (
                Array.isArray(response.data) &&
                response.data.length > 0
              ) {
                const latest = response.data[0];
                if (latest.price) markPrice = parseFloat(latest.price);
                else if (latest.markPrice)
                  markPrice = parseFloat(latest.markPrice);
                else if (latest.lastPrice)
                  markPrice = parseFloat(latest.lastPrice);
                else if (latest.price_usd)
                  markPrice = parseFloat(latest.price_usd);
              }
            }
            // Structure 4: Direct array
            else if (Array.isArray(response.data) && response.data.length > 0) {
              const latest = response.data[0];
              if (latest.price) markPrice = parseFloat(latest.price);
              else if (latest.markPrice)
                markPrice = parseFloat(latest.markPrice);
              else if (latest.lastPrice)
                markPrice = parseFloat(latest.lastPrice);
            }

            if (markPrice && markPrice > 0) {
              this.priceCache.set(symbol, {
                price: markPrice,
                timestamp: Date.now(),
              });
              return markPrice;
            }
          }
        } catch (explorerError: any) {
          const errorMsg =
            explorerError?.message ||
            explorerError?.toString() ||
            String(explorerError);
          const errorResponse =
            explorerError?.response?.data ||
            explorerError?.response ||
            explorerError?.data;
          lastError = `Explorer API (attempt ${attempt + 1}): ${errorMsg}`;
          if (attempt === 2) {
            this.logger.warn(
              `Explorer API method failed for ${symbol} after 3 attempts: ${errorMsg}\n` +
                `Error response: ${errorResponse ? JSON.stringify(errorResponse).substring(0, 400) : 'No error response'}`,
            );
          }
        }
      }

      // Method 4: Try market data API as last resort
      let marketData: any = null;
      try {
        await this.ensureInitialized();
        const apiClient = new ApiClient({ host: this.config.baseUrl });
        marketData = await (apiClient as any).market?.getMarketData({
          marketIndex,
        });
        if (marketData?.markPrice && !isNaN(parseFloat(marketData.markPrice))) {
          markPrice = parseFloat(marketData.markPrice);
        } else if (marketData?.price && !isNaN(parseFloat(marketData.price))) {
          markPrice = parseFloat(marketData.price);
        }

        if (markPrice && markPrice > 0) {
          this.priceCache.set(symbol, {
            price: markPrice,
            timestamp: Date.now(),
          });
          return markPrice;
        }
      } catch (marketDataError: any) {
        const errorMsg =
          marketDataError?.message ||
          marketDataError?.toString() ||
          String(marketDataError);
        const errorResponse =
          marketDataError?.response?.data ||
          marketDataError?.response ||
          marketDataError?.data;
        lastError = `Market data API: ${errorMsg}`;
        this.logger.warn(
          `Market data API method failed for ${symbol}: ${errorMsg}\n` +
            `Error response: ${JSON.stringify(errorResponse).substring(0, 400)}`,
        );
      }

      // If market data API succeeded but no price found, log it
      if (!markPrice && marketData) {
        lastError = `Market data API: Response received but no price field. Keys: ${Object.keys(marketData).join(', ')}`;
        this.logger.warn(
          `Market data API returned data for ${symbol} but no price: ` +
            `${JSON.stringify(marketData).substring(0, 300)}`,
        );
      }

      // All methods failed - log detailed error information
      const errorMsg =
        `Unable to determine mark price for ${symbol} (marketIndex: ${marketIndex}). ` +
        `Tried: order book, funding rates API, explorer API (3 attempts), market data API. ` +
        `Last error: ${lastError || 'All methods returned no data (no exceptions thrown)'}`;
      this.logger.error(
        `❌ All price fetching methods failed for ${symbol}: ${errorMsg}\n` +
          `   Market Index: ${marketIndex}\n` +
          `   Base URL: ${this.config.baseUrl}\n` +
          `   Order API initialized: ${!!this.orderApi}\n` +
          `   Last error details: ${lastError}`,
      );
      throw new Error(errorMsg);
    } catch (error: any) {
      this.logger.error(
        `Failed to get mark price for ${symbol}: ${error.message}`,
      );
      throw new ExchangeError(
        `Failed to get mark price: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  /**
   * Get the tick size (minimum price increment) for a symbol
   */
  async getTickSize(symbol: string): Promise<number> {
    try {
      await this.ensureInitialized();
      const marketIndex = await this.getMarketIndex(symbol);
      const market = this.marketHelpers.get(marketIndex);
      if (market) {
        // market.tickSize is available in Lighter MarketHelper
        // MarketHelper may have tickSize as a property or method
        const tickSize = (market as any).tickSize || (market as any).getTickSize?.();
        if (tickSize) {
          return parseFloat(tickSize.toString()) / 1e8; // Lighter uses 1e8 for prices
        }
      }
    } catch (error: any) {
      this.logger.debug(`Failed to get tick size for ${symbol}: ${error.message}`);
    }
    return 0.0001; // Default fallback
  }

  async supportsSymbol(symbol: string): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const baseSymbol = symbol
        .replace('USDC', '')
        .replace('USDT', '')
        .replace('-PERP', '')
        .toUpperCase();
      
      await this.refreshMarketIndexCache();
      return this.marketIndexCache.has(baseSymbol);
    } catch (error) {
      return false;
    }
  }

  async getBalance(): Promise<number> {
    const accountIndex = this.config.accountIndex!;

    // Retry logic for rate limiting (429 errors) with improved exponential backoff
    const maxRetries = 8; // Increased from 6 to 8
    const baseDelay = 3000; // 3 seconds base delay
    const maxDelay = 300000; // 5 minutes max delay

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff with jitter: 3s, 6s, 12s, 24s, 48s, 96s, 192s, 300s (capped)
          const exponentialDelay = Math.min(
            baseDelay * Math.pow(2, attempt - 1),
            maxDelay,
          );
          // Add jitter (±20%) to avoid thundering herd problem
          const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1); // Random between -20% and +20%
          const delay = Math.max(1000, exponentialDelay + jitter); // Minimum 1 second

          this.logger.debug(
            `Retrying Lighter balance query after ${Math.floor(delay / 1000)}s ` +
              `(attempt ${attempt + 1}/${maxRetries}, exponential: ${Math.floor(exponentialDelay / 1000)}s)`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        // Use AccountApi from SDK - it works and returns the correct structure
        // Based on official docs: https://apidocs.lighter.xyz/reference/account-1
        // The response is wrapped in { code: 200, accounts: [...] }
        const apiClient = new ApiClient({ host: this.config.baseUrl });
        const { AccountApi } = await import('@reservoir0x/lighter-ts-sdk');
        const accountApi = new AccountApi(apiClient);

        // Call getAccount with proper parameters
        const response = await this.callApi(this.WEIGHT_INFO, () => (accountApi.getAccount as any)({
          by: 'index',
          value: String(accountIndex),
        })) as any;

        // Response structure from actual API call:
        // { code: 200, total: 1, accounts: [{ collateral, available_balance, status, ... }] }
        if (
          response &&
          response.code === 200 &&
          response.accounts &&
          response.accounts.length > 0
        ) {
          const account = response.accounts[0];
          // Use available_balance or collateral (they should be the same)
          const balance = parseFloat(
            account.available_balance || account.collateral || '0',
          );
          const status = account.status === 1 ? 'active' : 'inactive';
          this.logger.debug(
            `Lighter balance retrieved: $${balance.toFixed(2)} (Status: ${status}, Index: ${account.index})`,
          );
          return balance;
        }

        // Fallback: try direct REST API call if SDK response structure is different
        try {
          const httpResponse = await this.callApi(this.WEIGHT_INFO, () => axios.get(
            `${this.config.baseUrl}/api/v1/account`,
            {
              params: {
                by: 'index',
                value: String(accountIndex),
              },
              timeout: 10000,
            },
          ));

          if (httpResponse.data && httpResponse.data.collateral !== undefined) {
            const balance = parseFloat(httpResponse.data.collateral || '0');
            this.logger.debug(
              `Lighter balance retrieved (REST fallback): $${balance.toFixed(2)}`,
            );
            return balance;
          }
        } catch (httpError: any) {
          const httpStatusCode = httpError?.response?.status;
          // If it's a 429, let the outer retry loop handle it
          if (httpStatusCode === 429 && attempt < maxRetries - 1) {
            continue; // Retry
          }
          this.logger.debug(`REST API fallback failed: ${httpError.message}`);
        }

        this.logger.warn(
          'Lighter account API returned data but no balance found',
        );
        return 0;
      } catch (error: any) {
        const statusCode = error?.response?.status;
        const errorMsg = error?.message || String(error);

        // If it's a 429 (rate limit), retry with improved backoff
        if (statusCode === 429 && attempt < maxRetries - 1) {
          // Silenced 429 warnings - only show errors
          this.logger.debug(
            `Lighter balance query rate limited (attempt ${attempt + 1}/${maxRetries}): ${errorMsg}. ` +
              `Will retry with exponential backoff.`,
          );
          continue; // Retry
        }

        // For other errors or final attempt
        this.logger.error(`Failed to get balance: ${errorMsg}`);
        if (error.response) {
          this.logger.debug(
            `Lighter API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
          );
        }

        // If not a retryable error, break
        if (statusCode !== 429) {
          break;
        }
      }
    }

    // If all retries failed, return 0 instead of throwing to allow system to continue
    this.logger.warn(
      'Returning 0 balance due to error - Lighter balance query may need authentication',
    );
    return 0;
  }

  async getEquity(): Promise<number> {
    try {
      // For Lighter, equity is typically the same as balance
      return await this.getBalance();
    } catch (error: any) {
      this.logger.error(`Failed to get equity: ${error.message}`);
      throw new ExchangeError(
        `Failed to get equity: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  /**
   * Get available margin for new positions
   *
   * This calculates the margin available for opening new positions by:
   * 1. Getting the total balance
   * 2. Subtracting margin used by existing positions
   * 3. Applying a safety buffer for maintenance margin
   *
   * This prevents "not enough margin to create the order" errors by ensuring
   * we only try to open positions we can actually afford.
   */
  async getAvailableMargin(): Promise<number> {
    try {
      const totalBalance = await this.getBalance();
      const positions = await this.getPositions();

      // Calculate margin used by existing positions
      let marginUsed = 0;
      for (const pos of positions) {
        // Estimate margin based on position value and leverage
        // Lighter typically uses cross margin, so we estimate based on notional value
        const positionValue = Math.abs(pos.size) * pos.markPrice;

        // Use position's leverage if available, otherwise assume 10x (Lighter default)
        const leverage = pos.leverage || 10;
        const estimatedMargin = positionValue / leverage;
        marginUsed += estimatedMargin;

        this.logger.debug(
          `Position ${pos.symbol}: value=$${positionValue.toFixed(2)}, ` +
            `leverage=${leverage}x, margin=$${estimatedMargin.toFixed(2)}`,
        );
      }

      // Apply safety buffers:
      // 1. 10% buffer for maintenance margin requirements
      // 2. Additional 5% buffer for price movements during order execution
      const MAINTENANCE_BUFFER = 0.1; // 10%
      const EXECUTION_BUFFER = 0.05; // 5%
      const TOTAL_BUFFER = MAINTENANCE_BUFFER + EXECUTION_BUFFER; // 15%

      const availableMargin = (totalBalance - marginUsed) * (1 - TOTAL_BUFFER);

      this.logger.debug(
        `Available margin calculation: totalBalance=$${totalBalance.toFixed(2)}, ` +
          `marginUsed=$${marginUsed.toFixed(2)}, buffer=${(TOTAL_BUFFER * 100).toFixed(0)}%, ` +
          `available=$${Math.max(0, availableMargin).toFixed(2)}`,
      );

      return Math.max(0, availableMargin);
    } catch (error: any) {
      this.logger.warn(
        `Failed to calculate available margin: ${error.message}, falling back to getBalance`,
      );
      // Fallback to total balance with a conservative buffer
      try {
        const balance = await this.getBalance();
        return balance * 0.7; // 30% buffer as fallback
      } catch {
        return 0;
      }
    }
  }

  /**
   * Set leverage for a symbol
   * Note: Lighter uses account-level margin mode settings.
   * This method logs the request for tracking but actual leverage is managed via Lighter UI.
   * @param symbol Trading symbol
   * @param leverage Target leverage (e.g., 3, 5, 10)
   * @param isCross Whether to use cross margin (true) or isolated margin (false). Defaults to cross.
   * @returns True (leverage setting is assumed to be handled via exchange UI)
   */
  async setLeverage(
    symbol: string,
    leverage: number,
    isCross: boolean = true,
  ): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const marketIndex = await this.getMarketIndex(symbol);

      this.logger.debug(
        `Lighter leverage for ${symbol} (market ${marketIndex}): ${leverage}x (${isCross ? 'cross' : 'isolated'}) - ` +
          `Note: Set leverage via Lighter UI or ensure account default is correct`,
      );

      // Lighter leverage is typically managed at account level via UI
      // The SDK's updateLeverage method may not be available in all versions
      // For now, we just log and return true
      return true;
    } catch (error: any) {
      this.logger.warn(
        `Failed to process Lighter leverage for ${symbol}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Get max leverage allowed for a symbol
   * @param symbol Trading symbol
   * @returns Maximum leverage allowed
   */
  async getMaxLeverage(symbol: string): Promise<number> {
    try {
      await this.ensureInitialized();
      const marketIndex = await this.getMarketIndex(symbol);

      // Fetch market info from Lighter API with retry logic
      const maxRetries = 3;
      let lastError: any = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }

          const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(`${this.config.baseUrl}/api/v1/markets`, {
            timeout: 10000,
          }));
          const markets = response.data?.data || response.data?.markets || response.data;

          if (Array.isArray(markets)) {
            const marketData = markets.find(
              (m: any) => m.market_index === marketIndex || m.marketIndex === marketIndex,
            );
            if (marketData?.max_leverage || marketData?.maxLeverage) {
              return parseFloat(marketData.max_leverage || marketData.maxLeverage);
            }
          }
          break; // If we got a valid response but no market data, break and return default
        } catch (err: any) {
          lastError = err;
          if (err.response?.status === 429) continue;
          break;
        }
      }

      // Default max leverage for Lighter
      return 20;
    } catch (error: any) {
      // Don't log full 404/429 errors as warnings to keep logs clean
      const status = error.response?.status;
      if (status !== 404 && status !== 429) {
        this.logger.warn(`Failed to get max leverage for ${symbol}: ${error.message}`);
      }
      return 10; // Safe default
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.testConnection();
      return true;
    } catch {
      return false;
    }
  }

  async testConnection(): Promise<void> {
    try {
      await this.ensureInitialized();
      // Test by trying to get order book (more reliable than account API)
      const apiClient = new ApiClient({ host: this.config.baseUrl });
      const orderApi = new OrderApi(apiClient);
      // Try to get order book for market 0 (ETH/USDC) as a connection test
      await orderApi.getOrderBookDetails({ marketIndex: 0 } as any);
    } catch (error: any) {
      throw new ExchangeError(
        `Connection test failed: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  // ==================== Fast Withdraw Helper Methods ====================

  /**
   * Get fast withdraw pool availability in USDC
   * Returns the amount available in the fast withdraw pool, or null if unable to check
   *
   * This is useful for checking if the pool has sufficient liquidity before attempting a withdrawal
   */
  async getFastWithdrawPoolAvailability(): Promise<number | null> {
    try {
      await this.ensureInitialized();

      // Create auth token
      const authToken = await this.signerClient!.createAuthTokenWithExpiry(600);

      // Get pool info
      const poolInfo = await this.getFastWithdrawInfo(authToken);

      if (poolInfo.withdraw_limit !== undefined) {
        const availableUsdc = poolInfo.withdraw_limit / 1e6;
        this.logger.debug(
          `Lighter fast withdraw pool availability: $${availableUsdc.toFixed(2)} USDC`,
        );
        return availableUsdc;
      }

      return null;
    } catch (error: any) {
      this.logger.warn(
        `Failed to check fast withdraw pool availability: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Build memo from Ethereum address for fast withdraw
   * Format: 20 bytes address + 12 zeros = 32 bytes total
   */
  private buildFastWithdrawMemo(address: string): string {
    const cleanAddress = address.toLowerCase().replace(/^0x/, '');
    if (cleanAddress.length !== 40) {
      throw new Error(`Invalid address length: ${cleanAddress.length}`);
    }

    // Convert address to bytes (20 bytes)
    const addrBytes = Buffer.from(cleanAddress, 'hex');

    // Create 32-byte memo: 20 bytes address + 12 zeros
    const memo = Buffer.alloc(32, 0);
    addrBytes.copy(memo, 0);

    // Return as hex string (without 0x prefix)
    return memo.toString('hex');
  }

  /**
   * Get fast withdraw pool info from Lighter API
   */
  private async getFastWithdrawInfo(
    authToken: string,
    maxRetries: number = 3,
  ): Promise<{ to_account_index: number; withdraw_limit?: number }> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(
          `${this.config.baseUrl}/api/v1/fastwithdraw/info`,
          {
            params: {
              account_index: this.config.accountIndex,
              auth: authToken,
            },
            timeout: 30000,
          },
        ));

        if (response.data.code !== 200) {
          throw new Error(
            `Pool info failed: ${response.data.message || 'Unknown error'}`,
          );
        }

        return {
          to_account_index: response.data.to_account_index,
          withdraw_limit: response.data.withdraw_limit,
        };
      } catch (error: any) {
        lastError = error;
        this.logger.debug(
          `Fast withdraw info attempt ${attempt}/${maxRetries} failed: ${error.message}`,
        );

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    throw lastError;
  }

  /**
   * Get transfer fee for fast withdraw
   */
  private async getFastWithdrawFee(
    toAccountIndex: number,
    authToken: string,
  ): Promise<number> {
    const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(
      `${this.config.baseUrl}/api/v1/transferFeeInfo`,
      {
        params: {
          account_index: this.config.accountIndex,
          to_account_index: toAccountIndex,
          auth: authToken,
        },
        timeout: 10000,
      },
    ));

    if (response.data.code !== 200) {
      throw new Error(
        `Transfer fee failed: ${response.data.message || 'Unknown error'}`,
      );
    }

    // transfer_fee_usdc is in micro-USDC (1e6)
    return response.data.transfer_fee_usdc;
  }

  /**
   * Get next nonce for Lighter transactions
   */
  private async getFastWithdrawNonce(): Promise<{
    apiKeyIndex: number;
    nonce: number;
  }> {
    const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(
      `${this.config.baseUrl}/api/v1/nextNonce`,
      {
        params: {
          account_index: this.config.accountIndex,
          api_key_index: this.config.apiKeyIndex,
        },
        timeout: 10000,
      },
    ));

    if (response.data && typeof response.data === 'object') {
      if (
        response.data.nonce !== undefined &&
        response.data.api_key_index !== undefined
      ) {
        return {
          apiKeyIndex: response.data.api_key_index,
          nonce: response.data.nonce,
        };
      } else if (response.data.nonce !== undefined) {
        return {
          apiKeyIndex: this.config.apiKeyIndex!,
          nonce: response.data.nonce,
        };
      }
    } else if (typeof response.data === 'number') {
      return {
        apiKeyIndex: this.config.apiKeyIndex!,
        nonce: response.data,
      };
    }

    throw new Error(
      `Unexpected nonce format: ${JSON.stringify(response.data)}`,
    );
  }

  // ==================== End Fast Withdraw Helper Methods ====================

  async transferInternal(amount: number, toPerp: boolean): Promise<string> {
    try {
      if (amount <= 0) {
        throw new Error('Transfer amount must be greater than 0');
      }

      // Lighter is a zk-rollup where all funds are already in the perp account
      // There's no separate spot account, so internal transfers don't apply
      // However, we'll log this and return a success message
      this.logger.log(
        `Lighter uses a unified account model - all funds are already available for perp trading. ` +
          `No internal transfer needed. Amount: $${amount.toFixed(2)}`,
      );

      // Return a placeholder transaction ID since no actual transfer occurs
      return `lighter-no-transfer-${Date.now()}`;
    } catch (error: any) {
      this.logger.error(`Failed to transfer on Lighter: ${error.message}`);
      throw new ExchangeError(
        `Failed to transfer: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  async depositExternal(
    amount: number,
    asset: string,
    destination?: string,
  ): Promise<string> {
    try {
      if (amount <= 0) {
        throw new Error('Deposit amount must be greater than 0');
      }

      // Only USDC is supported for deposits
      if (asset.toUpperCase() !== 'USDC') {
        throw new Error(`Only USDC deposits are supported. Received: ${asset}`);
      }

      this.logger.log(
        `Depositing $${amount.toFixed(2)} ${asset} to Lighter...`,
      );

      // Lighter deposit contract on Arbitrum
      // User confirmed: transfer to 0xB512443BB7737E90401DEF0BCF442aB5454A94f8
      const LIGHTER_DEPOSIT_CONTRACT =
        '0xB512443BB7737E90401DEF0BCF442aB5454A94f8';
      const USDC_CONTRACT_ADDRESS =
        '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // USDC on Arbitrum

      // Get Arbitrum RPC URL
      const arbitrumRpcUrl =
        this.configService.get<string>('ARBITRUM_RPC_URL') ||
        this.configService.get<string>('ARB_RPC_URL') ||
        'https://arb1.arbitrum.io/rpc'; // Public RPC fallback

      // Get private key for signing transactions
      const privateKey =
        this.configService.get<string>('PRIVATE_KEY') ||
        this.configService.get<string>('LIGHTER_PRIVATE_KEY');
      if (!privateKey) {
        throw new Error(
          'PRIVATE_KEY or LIGHTER_PRIVATE_KEY required for on-chain deposits',
        );
      }

      const normalizedPrivateKey = privateKey.startsWith('0x')
        ? privateKey
        : `0x${privateKey}`;
      const provider = new ethers.JsonRpcProvider(arbitrumRpcUrl);
      const wallet = new ethers.Wallet(normalizedPrivateKey, provider);

      this.logger.debug(
        `Lighter deposit details:\n` +
          `  Deposit contract: ${LIGHTER_DEPOSIT_CONTRACT}\n` +
          `  USDC contract: ${USDC_CONTRACT_ADDRESS}\n` +
          `  Amount: ${amount} USDC\n` +
          `  Wallet: ${wallet.address}\n` +
          `  RPC: ${arbitrumRpcUrl}`,
      );

      // ERC20 ABI for USDC (approve, transfer, allowance, balanceOf, decimals)
      const erc20Abi = [
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function transfer(address to, uint256 amount) external returns (bool)',
        'function allowance(address owner, address spender) external view returns (uint256)',
        'function balanceOf(address account) external view returns (uint256)',
        'function decimals() external view returns (uint8)',
      ];

      const usdcContract = new ethers.Contract(
        USDC_CONTRACT_ADDRESS,
        erc20Abi,
        wallet,
      );

      // Get USDC decimals (convert BigInt to number)
      const decimalsBigInt = await usdcContract.decimals();
      const decimals = Number(decimalsBigInt);
      const amountWei = ethers.parseUnits(amount.toFixed(decimals), decimals);

      // Wait for funds to arrive (similar to Hyperliquid - withdrawals take time)
      const maxWaitTime = 300000; // 5 minutes maximum wait
      const initialDelay = 2000; // 2 seconds initial delay
      const maxDelay = 30000; // 30 seconds max delay between checks
      const startTime = Date.now();
      let attempt = 0;
      let balanceFormatted = 0;
      let balanceWei: bigint;

      // Wait for funds to arrive (at least the requested amount)
      // Note: Hyperliquid withdrawals can take 1-2 minutes to arrive on-chain
      while (true) {
        attempt++;
        try {
          balanceWei = await usdcContract.balanceOf(wallet.address);
          balanceFormatted = Number(ethers.formatUnits(balanceWei, decimals));
        } catch (error: any) {
          this.logger.error(`Failed to check balance: ${error.message}`);
          throw new Error(`Failed to check USDC balance: ${error.message}`);
        }

        this.logger.debug(
          `Balance check attempt ${attempt}: ${balanceFormatted.toFixed(2)} USDC ` +
            `(requested: ${amount.toFixed(2)} USDC)`,
        );

        const elapsed = Date.now() - startTime;

        // Tolerance for withdrawal fees: accept balance within 5% or $0.50 of requested amount
        const tolerance = Math.max(amount * 0.05, 0.5);
        const minAcceptableAmount = amount - tolerance;

        // After 2 minutes, accept balance if it's at least 80% of requested (handles withdrawal fees)
        const acceptPartialAfter = 120000; // 2 minutes
        const minPartialAmount = amount * 0.8;

        // Check if we have sufficient balance
        if (balanceFormatted >= amount) {
          // Removed funds arrival log - only execution/order logs shown
          break;
        }

        // Accept balance within tolerance (handles withdrawal fees)
        if (balanceFormatted >= minAcceptableAmount && balanceFormatted > 0) {
          // Removed funds arrival log - only execution/order logs shown
          break;
        }

        // After 2 minutes, accept partial balance if reasonable (at least 80% of requested)
        if (
          elapsed >= acceptPartialAfter &&
          balanceFormatted >= minPartialAmount &&
          balanceFormatted > 0
        ) {
          this.logger.log(
            `✅ Accepting partial balance after ${Math.floor(elapsed / 1000)}s wait. ` +
              `Available: ${balanceFormatted.toFixed(2)} USDC (requested: ${amount.toFixed(2)} USDC). ` +
              `Withdrawal fees may have reduced the amount.`,
          );
          break;
        }

        // Timeout after max wait time
        if (elapsed >= maxWaitTime) {
          if (balanceFormatted > 0) {
            // If we have some balance, use it instead of failing
            this.logger.warn(
              `⚠️ Timeout reached but accepting available balance: ${balanceFormatted.toFixed(2)} USDC ` +
                `(requested: ${amount.toFixed(2)} USDC). Withdrawal fees may have reduced the amount.`,
            );
            break;
          }
          throw new Error(
            `Insufficient USDC balance after ${Math.floor(elapsed / 1000)}s wait. ` +
              `Required: ${amount.toFixed(2)} USDC, Available: ${balanceFormatted.toFixed(2)} USDC. ` +
              `Funds may still be in transit from withdrawal. Check withdrawal status.`,
          );
        }

        // Exponential backoff: 2s, 4s, 8s, 16s, capped at 30s
        const delay = Math.min(
          initialDelay * Math.pow(2, attempt - 1),
          maxDelay,
        );
        const remaining = maxWaitTime - elapsed;
        const waitTime = Math.min(delay, remaining);

        this.logger.warn(
          `Waiting for funds to arrive. ` +
            `Current: ${balanceFormatted.toFixed(2)} USDC, Required: ${amount.toFixed(2)} USDC. ` +
            `Waiting ${waitTime / 1000}s (attempt ${attempt}, ${Math.floor(elapsed / 1000)}s elapsed)...`,
        );

        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      this.logger.log(
        `✅ Funds confirmed (${balanceFormatted.toFixed(2)} USDC). ` +
          `Proceeding with deposit to Lighter contract ${LIGHTER_DEPOSIT_CONTRACT}...`,
      );

      // Determine deposit amount:
      // - If balance is significantly larger than requested amount, deposit only requested amount
      //   (this indicates a wallet deposit, not a rebalance from withdrawal)
      // - Otherwise, deposit full balance (this handles rebalancing where withdrawal fees reduce the amount)
      // We use a small buffer to identify rebalances where fees might have reduced the arriving amount
      const feeBuffer = Math.max(amount * 0.1, 1.0); // 10% or $1.00 buffer
      const isRebalance = balanceFormatted <= amount + feeBuffer;
      const depositAmount = isRebalance ? balanceFormatted : amount;
      const depositAmountWei = isRebalance
        ? balanceWei
        : ethers.parseUnits(depositAmount.toFixed(decimals), decimals);

      // Check current allowance
      this.logger.log(
        `Checking allowance for Lighter deposit contract ${LIGHTER_DEPOSIT_CONTRACT}...`,
      );
      const currentAllowance = await usdcContract.allowance(
        wallet.address,
        LIGHTER_DEPOSIT_CONTRACT,
      );
      this.logger.debug(
        `Current allowance: ${ethers.formatUnits(currentAllowance, decimals)} USDC`,
      );

      // Approve deposit contract if needed
      if (currentAllowance < depositAmountWei) {
        this.logger.log(
          `Approving Lighter deposit contract to spend ${depositAmount.toFixed(2)} USDC...`,
        );
        const approveTx = await usdcContract.approve(
          LIGHTER_DEPOSIT_CONTRACT,
          depositAmountWei,
        );
        this.logger.log(`⏳ Approval transaction submitted: ${approveTx.hash}`);
        const approveReceipt = await approveTx.wait();
        this.logger.log(
          `✅ Approval confirmed: ${approveReceipt.hash}, Block: ${approveReceipt.blockNumber}`,
        );
      } else {
        this.logger.log(
          `Sufficient allowance already exists (${ethers.formatUnits(currentAllowance, decimals)} USDC)`,
        );
      }

      // Transfer USDC to Lighter deposit contract
      this.logger.log(
        `🚀 Executing transfer to Lighter deposit contract ${LIGHTER_DEPOSIT_CONTRACT}...`,
      );
      if (!isRebalance) {
        this.logger.log(
          `Transferring ${depositAmount.toFixed(2)} USDC (requested amount) to Lighter deposit contract... ` +
            `(wallet has ${balanceFormatted.toFixed(2)} USDC total, depositing only ${depositAmount.toFixed(2)} USDC)`,
        );
      } else {
        this.logger.log(
          `Transferring ${depositAmount.toFixed(2)} USDC (available balance) to Lighter deposit contract... ` +
            `(requested amount was ${amount.toFixed(2)} USDC, but depositing available balance to handle potential fees)`,
        );
      }

      this.logger.log(
        `Calling transfer(${LIGHTER_DEPOSIT_CONTRACT}, ${depositAmountWei.toString()})...`,
      );
      const transferTx = await usdcContract.transfer(
        LIGHTER_DEPOSIT_CONTRACT,
        depositAmountWei,
      );
      this.logger.log(`⏳ Deposit transaction submitted: ${transferTx.hash}`);
      const receipt = await transferTx.wait();

      if (receipt.status === 1) {
        this.logger.log(
          `✅ Deposit successful! Transaction: ${receipt.hash}, Block: ${receipt.blockNumber}`,
        );
        return receipt.hash;
      } else {
        throw new Error(`Deposit transaction failed: ${receipt.hash}`);
      }
    } catch (error: any) {
      if (error instanceof ExchangeError) {
        throw error;
      }
      this.logger.error(`Failed to deposit ${asset}: ${error.message}`);
      if (error.transactionHash) {
        this.logger.error(`Transaction hash: ${error.transactionHash}`);
      }
      throw new ExchangeError(
        `Failed to deposit: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  /**
   * Withdraw funds from Lighter to an external Ethereum address using fast withdraw
   *
   * Fast withdraw works by:
   * 1. Creating an auth token with the SDK
   * 2. Getting the fast withdraw pool info
   * 3. Getting the transfer fee
   * 4. Signing the transfer with BOTH L2 (Lighter) and L1 (Ethereum) signatures
   * 5. Submitting to the fast withdraw endpoint
   */
  async withdrawExternal(
    amount: number,
    asset: string,
    destination: string,
  ): Promise<string> {
    try {
      if (amount <= 0) {
        throw new Error('Withdrawal amount must be greater than 0');
      }

      if (!destination || !destination.match(/^0x[a-fA-F0-9]{40}$/)) {
        throw new Error(
          'Invalid destination address. Must be a valid Ethereum address (0x followed by 40 hex characters)',
        );
      }

      // Only USDC is supported for fast withdrawals
      if (asset.toUpperCase() !== 'USDC') {
        throw new Error(
          `Only USDC withdrawals are supported. Received: ${asset}`,
        );
      }

      this.logger.log(
        `🏦 Fast withdrawing $${amount.toFixed(2)} ${asset} to ${destination} on Lighter...`,
      );

      await this.ensureInitialized();

      // Get Ethereum private key for L1 signing
      const ethPrivateKey =
        this.configService.get<string>('ETH_PRIVATE_KEY') ||
        this.configService.get<string>('PRIVATE_KEY') ||
        this.configService.get<string>('LIGHTER_PRIVATE_KEY');
      if (!ethPrivateKey) {
        throw new Error(
          'ETH_PRIVATE_KEY, PRIVATE_KEY, or LIGHTER_PRIVATE_KEY required for fast withdrawals (L1 signature)',
        );
      }
      const normalizedEthKey = ethPrivateKey.startsWith('0x')
        ? ethPrivateKey
        : `0x${ethPrivateKey}`;

      // Constants
      const ASSET_ID_USDC = 3;
      const ROUTE_PERP = 0;
      const CHAIN_ID = 304; // Lighter chain ID

      // 1. Create auth token using the proper SignerClient method
      this.logger.debug('Creating auth token...');
      const authToken = await this.signerClient!.createAuthTokenWithExpiry(600); // 10 minutes

      // 2. Get fast withdraw pool info
      this.logger.debug('Getting fast withdraw pool info...');
      const poolInfo = await this.getFastWithdrawInfo(authToken);
      const toAccountIndex = poolInfo.to_account_index;

      // Log pool info but DON'T fail based on it - the pool check is often stale/inaccurate
      // The actual API call may succeed even when pool shows low availability
      if (poolInfo.withdraw_limit !== undefined) {
        const limitUsdc = poolInfo.withdraw_limit / 1e6;
        if (amount > limitUsdc) {
          this.logger.warn(
            `⚠️ Pool shows $${limitUsdc.toFixed(2)} available but requesting $${amount.toFixed(2)}. ` +
              `Attempting anyway - pool limit check may be stale.`,
          );
        }
      }
      this.logger.debug(
        `Pool: ${toAccountIndex}, Limit: ${poolInfo.withdraw_limit ? (poolInfo.withdraw_limit / 1e6).toFixed(2) : 'N/A'} USDC`,
      );

      // 3. Get transfer fee
      this.logger.debug('Getting transfer fee...');
      const fee = await this.getFastWithdrawFee(toAccountIndex, authToken);
      const feeUsdc = fee / 1e6;
      this.logger.debug(`Transfer fee: $${feeUsdc.toFixed(2)} USDC`);

      // 4. Get next nonce
      this.logger.debug('Getting next nonce...');
      const { apiKeyIndex, nonce } = await this.getFastWithdrawNonce();
      this.logger.debug(`Nonce: ${nonce}, API Key Index: ${apiKeyIndex}`);

      // 5. Build memo (20-byte address + 12 zeros)
      const memoHex = this.buildFastWithdrawMemo(destination);

      // 6. Sign transfer with BOTH L2 (Lighter) and L1 (Ethereum) signatures
      this.logger.debug('Signing transfer...');
      const amountMicroUsdc = Math.floor(amount * 1e6);

      // Build the L1 message (matching SDK format)
      const toHex = (value: number): string =>
        '0x' + value.toString(16).padStart(16, '0');

      const l1Message = `Transfer\n\nnonce: ${toHex(nonce)}\nfrom: ${toHex(this.config.accountIndex!)} (route ${toHex(ROUTE_PERP)})\napi key: ${toHex(apiKeyIndex)}\nto: ${toHex(toAccountIndex)} (route ${toHex(ROUTE_PERP)})\nasset: ${toHex(ASSET_ID_USDC)}\namount: ${toHex(amountMicroUsdc)}\nfee: ${toHex(fee)}\nchainId: ${toHex(CHAIN_ID)}\nmemo: ${memoHex}\nOnly sign this message for a trusted client!`;

      // Sign L1 message with Ethereum private key
      const wallet = new ethers.Wallet(normalizedEthKey);
      const l1Sig = await wallet.signMessage(l1Message);

      // Access the internal wallet signer from the SignerClient
      const wasmSigner = (this.signerClient as any).wallet;

      // Sign transfer using the internal WASM signer (which has the correct Lighter key)
      const transferResult = await wasmSigner.signTransfer({
        toAccountIndex: toAccountIndex,
        assetIndex: ASSET_ID_USDC,
        fromRouteType: ROUTE_PERP,
        toRouteType: ROUTE_PERP,
        amount: amountMicroUsdc,
        usdcFee: fee,
        memo: memoHex,
        nonce: nonce,
      });

      if (transferResult.error) {
        throw new Error(`Failed to sign transfer: ${transferResult.error}`);
      }

      // Add L1 signature to the tx_info
      const txInfoParsed = JSON.parse(transferResult.txInfo);
      txInfoParsed.L1Sig = l1Sig;
      const txInfoStr = JSON.stringify(txInfoParsed);

      // 7. Submit to fastwithdraw endpoint (auth as query param)
      this.logger.log(
        `📤 Submitting fast withdraw of $${amount.toFixed(2)} USDC to ${destination}...`,
      );

      const formData = new URLSearchParams();
      formData.append('tx_info', txInfoStr);
      formData.append('to_address', destination);

      const response = await this.callApi(this.WEIGHT_TX, () => axios.post(
        `${this.config.baseUrl}/api/v1/fastwithdraw?auth=${encodeURIComponent(authToken)}`,
        formData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 30000,
        },
      ));

      if (response.data.code === 200) {
        const txHash =
          response.data.tx_hash ||
          response.data.txHash ||
          `lighter-fastwithdraw-${Date.now()}`;
        this.logger.log(`✅ Fast withdrawal successful! TX: ${txHash}`);
        this.logger.log(
          `   Amount: $${amount.toFixed(2)} USDC (fee: $${feeUsdc.toFixed(2)})`,
        );
        this.logger.log(`   Destination: ${destination}`);
        return txHash;
      } else {
        throw new Error(
          `Fast withdrawal failed: ${response.data.message || JSON.stringify(response.data)}`,
        );
      }
    } catch (error: any) {
      if (error instanceof ExchangeError) {
        throw error;
      }
      this.logger.error(
        `Failed to withdraw ${asset} to ${destination}: ${error.message}`,
      );
      throw new ExchangeError(
        `Failed to withdraw: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  /**
   * Get historical funding payments for the account
   * Uses the Lighter positionFunding endpoint with authentication
   * @param startTime Optional start time in milliseconds (not used by Lighter API)
   * @param endTime Optional end time in milliseconds (not used by Lighter API)
   * @returns Array of funding payments
   */
  async getFundingPayments(
    startTime?: number,
    endTime?: number,
  ): Promise<FundingPayment[]> {
    try {
      await this.ensureInitialized();

      this.logger.debug(
        `Fetching funding payments from Lighter for account ${this.config.accountIndex}`,
      );

      // Create auth token for the request
      const authToken = await this.signerClient!.createAuthTokenWithExpiry(600); // 10 minutes

      // Call the positionFunding endpoint
      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(
        `${this.config.baseUrl}/api/v1/positionFunding`,
        {
          params: {
            account_index: this.config.accountIndex,
            limit: 100,
            auth: authToken,
          },
          timeout: 30000,
          headers: {
            accept: 'application/json',
          },
        },
      ));

      const data = response.data;

      // Parse response: { code: 200, position_fundings: [...] }
      let fundingData: any[] = [];
      if (data.position_fundings && Array.isArray(data.position_fundings)) {
        fundingData = data.position_fundings;
      } else if (Array.isArray(data)) {
        fundingData = data;
      }

      const payments: FundingPayment[] = [];

      // Get market symbol mapping
      await this.refreshMarketIndexCache();

      for (const entry of fundingData) {
        // Lighter API response format:
        // { timestamp, market_id, funding_id, change, rate, position_size, position_side }
        const amount = parseFloat(entry.change || '0');
        const marketId = entry.market_id || 0;

        // Get symbol from market index
        let symbol = `Market-${marketId}`;
        for (const [sym, idx] of this.marketIndexCache.entries()) {
          if (idx === marketId) {
            symbol = sym;
            break;
          }
        }

        payments.push({
          exchange: ExchangeType.LIGHTER,
          symbol: symbol,
          amount: amount,
          fundingRate: parseFloat(entry.rate || '0'),
          positionSize: parseFloat(entry.position_size || '0'),
          timestamp: new Date((entry.timestamp || Date.now() / 1000) * 1000), // Unix seconds to ms
        });
      }

      this.logger.debug(
        `Retrieved ${payments.length} funding payments from Lighter`,
      );
      return payments;
    } catch (error: any) {
      this.logger.error(`Failed to get funding payments: ${error.message}`);
      throw new ExchangeError(
        `Failed to get funding payments: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  /**
   * Wait for an order to fill using a combination of WebSocket events and REST polling.
   * CRITICAL: Also actively reprices the order to stay at top of book!
   */
  async waitForOrderFill(
    orderId: string, 
    symbol: string, 
    timeoutMs: number,
    expectedSize: number
  ): Promise<PerpOrderResponse> {
    const start = Date.now();
    this.logger.log(`⏳ Waiting for Lighter order ${orderId} fill (timeout: ${timeoutMs/1000}s, size: ${expectedSize})...`);

    if (!this.wsProvider) {
      this.logger.warn('WebSocket provider not available, falling back to pure polling for waitForOrderFill');
    }

    // Get order details from pending orders map
    const pendingOrder = this.pendingOrdersMap.get(orderId);
    const orderSide = pendingOrder?.side;
    const originalPrice = pendingOrder?.price;

    return new Promise(async (resolve) => {
      let isResolved = false;
      let checkInterval: NodeJS.Timeout | null = null;
      let repriceInterval: NodeJS.Timeout | null = null;
      let wsHandler: ((update: LighterOrderUpdate) => void) | null = null;
      let currentOrderId = orderId; // Track current order ID (may change after reprice)
      let repriceCount = 0;
      const MAX_REPRICES = 20; // Max reprices before giving up
      const REPRICE_INTERVAL_MS = 15000; // Reprice every 15 seconds

      const cleanup = () => {
        isResolved = true;
        if (checkInterval) clearInterval(checkInterval);
        if (repriceInterval) clearInterval(repriceInterval);
        if (wsHandler && this.wsProvider) {
          this.wsProvider.removeListener('order_update', wsHandler);
        }
      };

      // 1. WebSocket Listener (fastest)
      if (this.wsProvider) {
        wsHandler = (update: LighterOrderUpdate) => {
          if (isResolved) return;
          
          // Check if this is our order (by current ID or original ID)
          if (String(update.orderId) === String(currentOrderId) || String(update.orderId) === String(orderId)) {
            if (update.status === 'filled') {
              this.logger.log(`✅ Order ${update.orderId} filled via WebSocket event`);
              cleanup();
              resolve(new PerpOrderResponse(
                update.orderId,
                OrderStatus.FILLED,
                symbol,
                update.side === 'bid' ? OrderSide.LONG : OrderSide.SHORT,
                undefined,
                parseFloat(update.filledSize),
                parseFloat(update.price),
                undefined,
                new Date()
              ));
            } else if (update.status === 'canceled') {
              // Only treat as cancelled if we didn't reprice it ourselves
              if (repriceCount === 0) {
                this.logger.warn(`❌ Order ${update.orderId} canceled via WebSocket event`);
                cleanup();
                resolve(new PerpOrderResponse(
                  update.orderId,
                  OrderStatus.CANCELLED,
                  symbol,
                  update.side === 'bid' ? OrderSide.LONG : OrderSide.SHORT,
                  undefined,
                  0,
                  undefined,
                  undefined,
                  new Date()
                ));
              }
            }
          }
        };
        this.wsProvider.on('order_update', wsHandler);
      }

      // 2. Active Repricing Loop - stays at top of book
      const doReprice = async () => {
        if (isResolved || !orderSide || repriceCount >= MAX_REPRICES) return;

        try {
          // Get current best bid/ask - try WebSocket first, then REST fallback
          let book: { bestBid: number; bestAsk: number } | null = null;
          
          try {
            const marketIndex = await this.getMarketIndex(symbol);
            book = this.wsProvider?.getBestBidAsk(marketIndex) ?? null;
          } catch (e) {
            this.logger.warn(`⚠️ REPRICE: WebSocket lookup failed for ${symbol}: ${e.message}`);
          }
          
          // CRITICAL: Fall back to REST if WebSocket has no data
          if (!book) {
            try {
              book = await this.getBestBidAsk(symbol);
              if (book) {
                this.logger.log(`📡 REPRICE: Using REST fallback for ${symbol} order book: bid=${book.bestBid.toFixed(4)}, ask=${book.bestAsk.toFixed(4)}`);
              }
            } catch (e: any) {
              this.logger.warn(`⚠️ REPRICE: REST fallback failed for ${symbol}: ${e.message}`);
            }
          }
          
          if (!book) {
            this.logger.debug(`No order book data for repricing ${symbol} (tried WS + REST)`);
            return;
          }

          const isSellOrder = orderSide === OrderSide.SHORT;
          const targetPrice = isSellOrder ? book.bestAsk : book.bestBid;
          
          // Get current order status to check if still open
          const currentOpenOrders = await this.getOpenOrders().catch(() => []) as any[];
          const ourOrder = currentOpenOrders.find(o => 
            o.symbol.toUpperCase() === symbol.toUpperCase() && 
            ((isSellOrder && o.side === 'sell') || (!isSellOrder && o.side === 'buy'))
          );

          if (!ourOrder) {
            // Order might have filled while we were checking - verify via position delta
            this.logger.debug(`Order no longer in open orders list, checking if filled via position...`);
            
            try {
              // Check if order filled by looking at position delta
              const positions = await this.getPositions();
              const position = positions.find(
                (p) => p.symbol === symbol && 
                       ((isSellOrder && p.side === OrderSide.SHORT) || (!isSellOrder && p.side === OrderSide.LONG))
              );
              
              if (position && Math.abs(position.size) >= expectedSize * 0.95) {
                // Position exists with expected size - order likely filled!
                this.logger.log(`✅ Order ${currentOrderId.substring(0, 16)}... appears to have FILLED (position: ${position.size.toFixed(2)})`);
                cleanup();
                resolve(new PerpOrderResponse(
                  currentOrderId,
                  OrderStatus.FILLED,
                  symbol,
                  orderSide!,
                  undefined,
                  Math.abs(position.size),
                  originalPrice || 0,
                  undefined,
                  new Date()
                ));
                return;
              }
            } catch (e: any) {
              this.logger.debug(`Could not verify fill via position: ${e.message}`);
            }
            
            // Order not found and position check inconclusive - might have filled or been cancelled
            this.logger.debug(`Order not found in open orders and position check inconclusive - will continue checking`);
            return;
          }

          // Check if we're at top of book (within a small tolerance)
          const tickSize = await this.getTickSize(symbol).catch(() => 0.0001);
          const priceDiff = Math.abs(ourOrder.price - targetPrice);
          
          if (priceDiff > tickSize * 0.5) {
            // We're not at top of book - reprice!
            const priceChangePct = ((targetPrice - ourOrder.price) / ourOrder.price * 100).toFixed(3);
            this.logger.log(
              `🔄 REPRICE ${symbol} ${isSellOrder ? 'SELL' : 'BUY'} on LIGHTER: ` +
              `${ourOrder.price.toFixed(4)} → ${targetPrice.toFixed(4)} ` +
              `(${priceChangePct}%, diff: ${priceDiff.toFixed(6)}, size: ${expectedSize.toFixed(2)}) ` +
              `[Book: bid=${book.bestBid.toFixed(4)}, ask=${book.bestAsk.toFixed(4)}]`
            );
            
            // Cancel current order
            try {
              await this.cancelOrder(String(ourOrder.orderId), symbol);
              this.logger.debug(`✅ Canceled old order ${ourOrder.orderId.substring(0, 16)}... for repricing`);
            } catch (e: any) {
              this.logger.warn(`⚠️ Cancel during reprice failed (may already be filled): ${e.message}`);
              return;
            }
            
            // Place new order at better price
            const newOrder = new PerpOrderRequest(
              symbol,
              orderSide,
              OrderType.LIMIT,
              expectedSize,
              targetPrice,
              TimeInForce.GTC
            );
            
            try {
              const newResp = await this.placeOrder(newOrder);
              if (newResp.orderId) {
                currentOrderId = newResp.orderId;
                repriceCount++;
                this.logger.log(
                  `✅ REPRICE SUCCESS ${symbol} on LIGHTER: New order ${currentOrderId.substring(0, 16)}... ` +
                  `@ ${targetPrice.toFixed(4)} (reprice #${repriceCount})`
                );
              }
            } catch (e: any) {
              this.logger.error(`❌ REPRICE FAILED ${symbol} on LIGHTER: Failed to place repriced order: ${e.message}`);
            }
          } else {
            this.logger.debug(`✓ Order ${symbol} still competitive (price: ${ourOrder.price.toFixed(4)}, target: ${targetPrice.toFixed(4)}, diff: ${priceDiff.toFixed(6)})`);
          }
        } catch (e: any) {
          this.logger.debug(`Reprice check error for ${symbol}: ${e.message}`);
        }
      };

      // Start repricing loop after a short delay
      setTimeout(() => {
        if (!isResolved) {
          repriceInterval = setInterval(doReprice, REPRICE_INTERVAL_MS);
        }
      }, 5000); // Start repricing after 5 seconds

      // 3. Slow REST Poll (safety)
      const safetyPoll = async () => {
        if (isResolved) return;
        try {
          const status = await this.getOrderStatus(currentOrderId, symbol);
          if (status.status === OrderStatus.FILLED || status.status === OrderStatus.CANCELLED || status.status === OrderStatus.REJECTED) {
            this.logger.log(`✅ Order ${currentOrderId} reached terminal state ${status.status} via safety poll`);
            cleanup();
            resolve(status);
          }
        } catch (e: any) {
          this.logger.debug(`Safety poll error for ${currentOrderId}: ${e.message}`);
        }
      };

      checkInterval = setInterval(safetyPoll, 30000); // Every 30 seconds
      
      // 4. Timeout
      setTimeout(() => {
        if (isResolved) return;
        this.logger.warn(`⏰ Timeout waiting for Lighter order ${currentOrderId} fill after ${timeoutMs/1000}s (repriced ${repriceCount} times)`);
        cleanup();
        
        // Final attempt to get status
        this.getOrderStatus(currentOrderId, symbol)
          .then(resolve)
          .catch(() => resolve(new PerpOrderResponse(
            currentOrderId,
            OrderStatus.SUBMITTED,
            symbol,
            OrderSide.LONG, // side unknown but mandatory
            undefined,
            0,
            undefined,
            'TIMEOUT',
            new Date()
          )));
      }, timeoutMs);

      // Perform initial check immediately
      await safetyPoll();
    });
  }

  // ==================== ILighterExchangeAdapter Implementation ====================

  /**
   * Get account index for the configured account
   */
  async getAccountIndex(): Promise<number> {
    return this.config.accountIndex!;
  }

  /**
   * Place order using Lighter-specific order request
   * Note: This is a convenience method that converts LighterOrderRequest to PerpOrderRequest.
   * For full functionality, use placeOrder() with a PerpOrderRequest that includes the symbol.
   */
  async placeLighterOrder(request: LighterOrderRequest): Promise<PerpOrderResponse> {
    // We need symbol to use placeOrder - try to get it from marketIndex cache
    // This is a limitation: LighterOrderRequest uses marketIndex but placeOrder needs symbol
    let symbol: string | null = null;
    for (const [sym, idx] of this.marketIndexCache.entries()) {
      if (idx === request.marketIndex) {
        symbol = sym;
        break;
      }
    }

    if (!symbol) {
      // Refresh cache and try again
      await this.refreshMarketIndexCache();
      for (const [sym, idx] of this.marketIndexCache.entries()) {
        if (idx === request.marketIndex) {
          symbol = sym;
          break;
        }
      }
    }

    if (!symbol) {
      throw new ExchangeError(
        `Could not resolve symbol for marketIndex ${request.marketIndex}. Use placeOrder() with symbol instead.`,
        ExchangeType.LIGHTER,
      );
    }

    // Convert LighterOrderRequest to PerpOrderRequest
    const perpRequest = new PerpOrderRequest(
      symbol,
      request.side === 'buy' ? OrderSide.LONG : OrderSide.SHORT,
      request.orderType === 'MARKET' ? OrderType.MARKET : OrderType.LIMIT,
      parseFloat(request.size),
      request.price ? parseFloat(request.price) : undefined,
      request.timeInForce === 'GTC' ? TimeInForce.GTC :
      request.timeInForce === 'IOC' ? TimeInForce.IOC :
      request.timeInForce === 'FOK' ? TimeInForce.FOK : TimeInForce.GTC,
      request.reduceOnly || false,
      undefined,
      request.clientOrderId,
    );

    return this.placeOrder(perpRequest);
  }

  /**
   * Modify order using Lighter-specific modification request
   */
  async modifyLighterOrder(request: LighterModifyOrderRequest): Promise<PerpOrderResponse> {
    // We need to find the order first - try all markets or use a symbol lookup
    // This is a limitation: we need symbol or marketIndex to find the order efficiently
    // For now, we'll search through open orders
    const openOrders = await this.getOpenOrders();
    const order = openOrders.find(o => o.orderId === request.orderId);
    
    if (!order) {
      throw new ExchangeError(
        `Order ${request.orderId} not found in open orders`,
        ExchangeType.LIGHTER,
      );
    }

    // Build modification request
    const modifyRequest = new PerpOrderRequest(
      order.symbol,
      order.side === 'buy' ? OrderSide.LONG : OrderSide.SHORT,
      OrderType.LIMIT, // Assume limit order for modification
      parseFloat(request.newSize?.toString() || order.size.toString()),
      request.newPrice ? parseFloat(request.newPrice) : undefined,
    );

    return this.modifyOrder(request.orderId, modifyRequest);
  }

  /**
   * Get order by order index
   */
  async getLighterOrder(orderIndex: number, marketIndex: number): Promise<LighterOrder | null> {
    try {
      await this.ensureInitialized();
      const orders = await this.getLighterOrders(marketIndex);
      return orders.find(o => o.order_index === orderIndex || parseInt(o.order_id) === orderIndex) || null;
    } catch (error: any) {
      this.logger.error(`Failed to get Lighter order ${orderIndex}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get all orders for a market
   */
  async getLighterOrders(marketIndex: number): Promise<LighterOrder[]> {
    try {
      await this.ensureInitialized();
      
      // Try WebSocket provider first if available
      if (this.wsProvider) {
        const cachedOrders = this.wsProvider.getCachedOrders();
        if (cachedOrders) {
          // Filter orders by marketIndex and convert to LighterOrder format
          const marketOrders: LighterOrder[] = [];
          for (const order of cachedOrders.values()) {
            if (order.marketIndex === marketIndex) {
              marketOrders.push({
                order_index: parseInt(order.orderId),
                client_order_index: 0,
                order_id: order.orderId,
                client_order_id: order.orderId,
                market_index: marketIndex,
                owner_account_index: this.config.accountIndex!,
                initial_base_amount: order.size.toString(),
                price: order.price.toString(),
                nonce: 0,
                remaining_base_amount: (order.size - order.filledSize).toString(),
                is_ask: order.side === 'sell',
                base_size: 0,
                base_price: 0,
                filled_base_amount: order.filledSize.toString(),
                filled_quote_amount: '0',
                side: order.side,
                type: 'LIMIT',
                time_in_force: 'GTC',
                reduce_only: order.reduceOnly,
                trigger_price: '0',
                order_expiry: 0,
                status: order.status,
                trigger_status: '',
                trigger_time: 0,
                parent_order_index: 0,
                parent_order_id: '',
                to_trigger_order_id_0: '',
                to_trigger_order_id_1: '',
                to_cancel_order_id_0: '',
                block_height: 0,
                timestamp: order.lastUpdated.getTime(),
                created_at: order.lastUpdated.getTime(),
                updated_at: order.lastUpdated.getTime(),
                transaction_time: order.lastUpdated.getTime(),
              });
            }
          }
          if (marketOrders.length > 0) {
            return marketOrders;
          }
        }
      }

      // Fallback to REST API
      const apiClient = new ApiClient({ host: this.config.baseUrl });
      const orderApi = new OrderApi(apiClient);
      
      // Note: This is a placeholder - actual implementation depends on Lighter SDK
      // The SDK may not expose this directly, so we might need to use getOpenOrders
      const openOrders = await this.getOpenOrders();
      return openOrders
        .filter(o => {
          // We'd need marketIndex from symbol - this is a limitation
          return true; // Placeholder
        })
        .map(o => ({
          order_index: parseInt(o.orderId),
          client_order_index: 0,
          order_id: o.orderId,
          client_order_id: o.orderId,
          market_index: marketIndex,
          owner_account_index: this.config.accountIndex!,
          initial_base_amount: o.size.toString(),
          price: o.price.toString(),
          nonce: 0,
          remaining_base_amount: (o.size - o.filledSize).toString(),
          is_ask: o.side === 'sell',
          base_size: 0,
          base_price: 0,
          filled_base_amount: o.filledSize.toString(),
          filled_quote_amount: '0',
          side: o.side,
          type: 'LIMIT',
          time_in_force: 'GTC',
          reduce_only: false,
          trigger_price: '0',
          order_expiry: 0,
          status: 'open',
          trigger_status: '',
          trigger_time: 0,
          parent_order_index: 0,
          parent_order_id: '',
          to_trigger_order_id_0: '',
          to_trigger_order_id_1: '',
          to_cancel_order_id_0: '',
          block_height: 0,
          timestamp: o.timestamp.getTime(),
          created_at: o.timestamp.getTime(),
          updated_at: o.timestamp.getTime(),
          transaction_time: o.timestamp.getTime(),
        })) as LighterOrder[];
    } catch (error: any) {
      this.logger.error(`Failed to get Lighter orders for market ${marketIndex}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get position for a market
   */
  async getLighterPosition(marketIndex: number): Promise<LighterPosition | null> {
    try {
      const positions = await this.getLighterPositions();
      return positions.get(marketIndex) || null;
    } catch (error: any) {
      this.logger.error(`Failed to get Lighter position for market ${marketIndex}: ${error.message}`);
      return null;
    }
  }

  /**
   * Get all positions
   */
  async getLighterPositions(): Promise<Map<number, LighterPosition>> {
    try {
      await this.ensureInitialized();
      const positions = await this.getPositions();
      const result = new Map<number, LighterPosition>();

      for (const pos of positions) {
        const marketIndex = await this.getMarketIndex(pos.symbol);
        result.set(marketIndex, {
          market_id: marketIndex,
          symbol: pos.symbol,
          initial_margin_fraction: '0.1', // Default
          open_order_count: 0,
          pending_order_count: 0,
          position_tied_order_count: 0,
          sign: pos.side === OrderSide.LONG ? 1 : -1,
          position: Math.abs(pos.size).toString(),
          avg_entry_price: pos.entryPrice.toString(),
          position_value: pos.getPositionValue().toString(),
          unrealized_pnl: pos.unrealizedPnl.toString(),
          realized_pnl: '0',
          liquidation_price: pos.liquidationPrice?.toString() || '0',
          margin_mode: 0,
          allocated_margin: '0',
        });
      }

      return result;
    } catch (error: any) {
      this.logger.error(`Failed to get Lighter positions: ${error.message}`);
      return new Map();
    }
  }

  /**
   * Get trades for a market
   */
  async getLighterTrades(marketIndex: number, limit?: number): Promise<LighterTrade[]> {
    // This would require accessing trade history from WebSocket or REST API
    // Placeholder implementation
    this.logger.warn('getLighterTrades not fully implemented - requires trade history API access');
    return [];
  }

  /**
   * Get order book for a market
   */
  async getLighterOrderBook(marketIndex: number): Promise<LighterOrderBookResponse> {
    try {
      await this.ensureInitialized();
      const apiClient = new ApiClient({ host: this.config.baseUrl });
      const orderBooks = await (apiClient as any).order?.getOrderBooks();
      
      if (orderBooks && orderBooks[marketIndex]) {
        const book = orderBooks[marketIndex];
        return {
          channel: `orderbook:${marketIndex}`,
          market_index: marketIndex,
          bids: (book.bids || []).map((b: any) => ({
            price: b.price?.toString() || '0',
            size: b.size?.toString() || '0',
          })),
          asks: (book.asks || []).map((a: any) => ({
            price: a.price?.toString() || '0',
            size: a.size?.toString() || '0',
          })),
          type: 'update/orderbook',
        };
      }

      throw new Error(`Order book not found for market index ${marketIndex}`);
    } catch (error: any) {
      throw new ExchangeError(
        `Failed to get order book: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  /**
   * Get market stats for a market
   */
  async getLighterMarketStats(marketIndex: number): Promise<LighterMarketStatsResponse> {
    // This would require accessing market stats API
    // Placeholder implementation
    this.logger.warn('getLighterMarketStats not fully implemented - requires market stats API access');
    return {
      channel: `market_stats:${marketIndex}`,
      market_stats: {},
      type: 'update/market_stats',
    };
  }

  /**
   * Subscribe to account market updates
   * Note: Requires WebSocket provider enhancement - see LighterWebSocketProvider
   */
  async subscribeAccountMarket(
    marketIndex: number,
    callback: (data: LighterAccountMarketResponse) => void,
  ): Promise<string> {
    if (!this.wsProvider) {
      throw new ExchangeError(
        'WebSocket provider not available',
        ExchangeType.LIGHTER,
      );
    }
    // TODO: Implement in LighterWebSocketProvider
    throw new ExchangeError(
      'subscribeAccountMarket not yet implemented in LighterWebSocketProvider',
      ExchangeType.LIGHTER,
    );
  }

  /**
   * Subscribe to account all orders updates
   * Note: Requires WebSocket provider enhancement - see LighterWebSocketProvider
   */
  async subscribeAccountAllOrders(
    callback: (data: LighterAccountAllOrdersResponse) => void,
  ): Promise<string> {
    if (!this.wsProvider) {
      throw new ExchangeError(
        'WebSocket provider not available',
        ExchangeType.LIGHTER,
      );
    }
    // TODO: Implement in LighterWebSocketProvider
    throw new ExchangeError(
      'subscribeAccountAllOrders not yet implemented in LighterWebSocketProvider',
      ExchangeType.LIGHTER,
    );
  }

  /**
   * Subscribe to account orders updates for a specific market
   * Note: Requires WebSocket provider enhancement - see LighterWebSocketProvider
   */
  async subscribeAccountOrders(
    marketIndex: number,
    callback: (data: LighterAccountOrdersResponse) => void,
  ): Promise<string> {
    if (!this.wsProvider) {
      throw new ExchangeError(
        'WebSocket provider not available',
        ExchangeType.LIGHTER,
      );
    }
    // TODO: Implement in LighterWebSocketProvider
    throw new ExchangeError(
      'subscribeAccountOrders not yet implemented in LighterWebSocketProvider',
      ExchangeType.LIGHTER,
    );
  }

  /**
   * Subscribe to account all trades updates
   * Note: Requires WebSocket provider enhancement - see LighterWebSocketProvider
   */
  async subscribeAccountAllTrades(
    callback: (data: LighterAccountAllTradesResponse) => void,
  ): Promise<string> {
    if (!this.wsProvider) {
      throw new ExchangeError(
        'WebSocket provider not available',
        ExchangeType.LIGHTER,
      );
    }
    // TODO: Implement in LighterWebSocketProvider
    throw new ExchangeError(
      'subscribeAccountAllTrades not yet implemented in LighterWebSocketProvider',
      ExchangeType.LIGHTER,
    );
  }

  /**
   * Subscribe to account all positions updates
   * Note: Requires WebSocket provider enhancement - see LighterWebSocketProvider
   */
  async subscribeAccountAllPositions(
    callback: (data: LighterAccountAllPositionsResponse) => void,
  ): Promise<string> {
    if (!this.wsProvider) {
      throw new ExchangeError(
        'WebSocket provider not available',
        ExchangeType.LIGHTER,
      );
    }
    // TODO: Implement in LighterWebSocketProvider
    throw new ExchangeError(
      'subscribeAccountAllPositions not yet implemented in LighterWebSocketProvider',
      ExchangeType.LIGHTER,
    );
  }

  /**
   * Subscribe to account all assets updates
   * Note: Requires WebSocket provider enhancement - see LighterWebSocketProvider
   */
  async subscribeAccountAllAssets(
    callback: (data: LighterAccountAllAssetsResponse) => void,
  ): Promise<string> {
    if (!this.wsProvider) {
      throw new ExchangeError(
        'WebSocket provider not available',
        ExchangeType.LIGHTER,
      );
    }
    // TODO: Implement in LighterWebSocketProvider
    throw new ExchangeError(
      'subscribeAccountAllAssets not yet implemented in LighterWebSocketProvider',
      ExchangeType.LIGHTER,
    );
  }

  /**
   * Send transaction via WebSocket
   * 
   * @param txType Transaction type (integer from SignerClient)
   * @param txInfo Transaction info (generated using sign methods in SignerClient)
   * @returns Transaction hash
   */
  async sendWebSocketTransaction(txType: number, txInfo: any): Promise<string> {
    if (!this.wsProvider) {
      throw new ExchangeError(
        'WebSocket provider not available',
        ExchangeType.LIGHTER,
      );
    }

    try {
      return await this.wsProvider.sendTransaction(txType, txInfo);
    } catch (error: any) {
      throw new ExchangeError(
        `Failed to send WebSocket transaction: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  /**
   * Send batch transactions via WebSocket
   * 
   * @param txTypes Array of transaction types
   * @param txInfos Array of transaction infos (must match txTypes length)
   * @returns Array of transaction hashes
   */
  async sendWebSocketBatchTransactions(
    txTypes: number[],
    txInfos: any[],
  ): Promise<string[]> {
    if (!this.wsProvider) {
      throw new ExchangeError(
        'WebSocket provider not available',
        ExchangeType.LIGHTER,
      );
    }

    try {
      return await this.wsProvider.sendBatchTransactions(txTypes, txInfos);
    } catch (error: any) {
      throw new ExchangeError(
        `Failed to send WebSocket batch transactions: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }
}
