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
} from '../../../domain/ports/IPerpExchangeAdapter';
import { DiagnosticsService } from '../../services/DiagnosticsService';
import { MarketQualityFilter } from '../../../domain/services/MarketQualityFilter';
import { RateLimiterService, RateLimitPriority } from '../../services/RateLimiterService';

import { LighterWebSocketProvider } from './LighterWebSocketProvider';

/**
 * LighterExchangeAdapter - Implements IPerpExchangeAdapter for Lighter Protocol
 *
 * Based on the existing lighter-order-simple.ts script logic
 */
@Injectable()
export class LighterExchangeAdapter
  implements IPerpExchangeAdapter, OnModuleDestroy
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
    }
  }

  /**
   * Explicitly get a fresh nonce from the Lighter API
   * This is called before every transaction to ensure we're in sync with the sequencer
   */
  private async getFreshNonce(): Promise<number | null> {
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

      let nonce: number | null = null;
      if (response.data && typeof response.data === 'object') {
        if (response.data.nonce !== undefined) {
          nonce = Number(response.data.nonce);
        }
      } else if (typeof response.data === 'number') {
        nonce = response.data;
      }

      if (nonce !== null && !isNaN(nonce)) {
        this.lastNonceSyncTime = Date.now();
        this.logger.debug(`📡 Fetched fresh nonce from API: ${nonce}`);
        
        // Also try to update the SDK's internal counter if possible to keep it in sync
        if (this.signerClient) {
          try {
            // Some versions of the SDK allow syncing the nonce manager
            if ((this.signerClient as any).nonceManager?.setNonce) {
              (this.signerClient as any).nonceManager.setNonce(nonce);
            }
          } catch (e) {
            // Non-critical
          }
        }
        
        return nonce;
      }
      
      // Fallback to SDK method if API fails
      if (this.signerClient) {
        const sdkNonce = await (this.signerClient as any).getNextNonce();
        return (typeof sdkNonce === 'object' && sdkNonce !== null) ? sdkNonce.nonce : sdkNonce;
      }
      
      return null;
    } catch (e: any) {
      this.logger.warn(`Failed to get fresh nonce from API: ${e.message}. Falling back to SDK.`);
      if (this.signerClient) {
        try {
          const sdkNonce = await (this.signerClient as any).getNextNonce();
          return (typeof sdkNonce === 'object' && sdkNonce !== null) ? sdkNonce.nonce : sdkNonce;
        } catch (sdkError) {
          return null;
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
    const releaseMutex = await this.acquireOrderMutex();

    try {
      return await this.placeOrderInternal(request);
    } finally {
      // Always release the mutex when done
      releaseMutex();
    }
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
   * Internal order placement logic - must only be called while holding the order mutex
   */
  private async placeOrderInternal(
    request: PerpOrderRequest,
  ): Promise<PerpOrderResponse> {
    // Add retry logic with exponential backoff for order placement (rate limiting)
    // For market orders, limit to 5 retries with progressive price improvement
    const maxRetries = request.type === OrderType.MARKET ? 5 : 6;
    const baseDelay = 2000; // 2 seconds base delay
    const maxDelay = 60000; // 60 seconds max delay
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

          this.logger.warn(
            `Retrying order placement for ${request.symbol} after ${Math.floor(delay / 1000)}s ` +
              `(attempt ${attempt + 1}/${maxRetries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        this.logger.debug(
          `Initializing Lighter adapter for order placement (attempt ${attempt + 1})...`,
        );
        await this.ensureInitialized();
        
        // Fetch a fresh nonce explicitly before each order attempt
        const nonce = await this.getFreshNonce();
        this.logger.debug(`Using fresh nonce for ${request.symbol}: ${nonce}`);

        this.logger.debug(`Getting market index for ${request.symbol}...`);
        const marketIndex = await this.getMarketIndex(request.symbol);
        this.logger.debug(`Market index for ${request.symbol}: ${marketIndex}`);

        this.logger.debug(`Getting market helper for market ${marketIndex}...`);
        const market = await this.getMarketHelper(marketIndex);

        const isBuy = request.side === OrderSide.LONG;
        const isAsk = !isBuy;

        // Convert size to market units
        this.logger.debug(`Converting size ${request.size} to market units...`);
        const baseAmount = market.amountToUnits(request.size);
        this.logger.debug(`Base amount: ${baseAmount}`);

        let orderParams: any;
        let useCreateMarketOrder = false;

        if (request.type === OrderType.MARKET) {
          // For closing positions (reduceOnly=true), use createMarketOrder
          if (request.reduceOnly) {
            useCreateMarketOrder = true;

            // Strategy for closing:
            // - Attempt 0: Use mark price (candlesticks) for fair value
            // - Attempt 1: Use actual order book at best bid/ask (no slippage)
            // - Attempt 2+: Use order book with progressive slippage
            let avgExecutionPrice: number;

            // Progressive slippage: starts at attempt 2
            // [attempt 0 = mark, attempt 1 = book no slippage, attempt 2+ = book + slippage]
            const priceImprovements = [0, 0, 0.001, 0.005, 0.01, 0.02, 0.05];
            const priceImprovement =
              priceImprovements[Math.min(attempt, priceImprovements.length - 1)];

            if (attempt === 0) {
              // First attempt: try mark price (fair value)
            try {
              const markPrice = await this.getMarkPrice(request.symbol);
              avgExecutionPrice = markPrice;
                this.logger.debug(
                  `Closing ${request.symbol}: using mark price $${markPrice.toFixed(6)}`,
                );
            } catch (priceError: any) {
                // Mark price failed, fall back to order book immediately
                this.logger.warn(
                  `Mark price unavailable for ${request.symbol} close, using order book: ${priceError.message}`,
                );
                this.clearOrderBookCache(request.symbol);
                const { bestBid, bestAsk } = await this.getOrderBookBidAsk(request.symbol);
                avgExecutionPrice = isBuy ? bestAsk : bestBid;
              }
            } else if (attempt === 1) {
              // Second attempt: use order book at best price (no slippage yet)
              this.logger.warn(
                `🔄 Closing retry ${attempt + 1}/${maxRetries} for ${request.symbol}: ` +
                  `Using order book at best price (no slippage)`,
              );
              this.clearOrderBookCache(request.symbol);
              
              try {
                const { bestBid, bestAsk } = await this.getOrderBookBidAsk(request.symbol);
                avgExecutionPrice = isBuy ? bestAsk : bestBid;
              } catch (obError: any) {
                // Order book failed, try mark price
                this.logger.warn(
                  `Order book unavailable for ${request.symbol} close, using mark price: ${obError.message}`,
                );
                avgExecutionPrice = await this.getMarkPrice(request.symbol);
              }
            } else {
              // Subsequent retries: use order book with progressive slippage
              this.logger.warn(
                `🔄 Closing retry ${attempt + 1}/${maxRetries} for ${request.symbol}: ` +
                  `Using order book with ${(priceImprovement * 100).toFixed(2)}% slippage`,
              );
              this.clearOrderBookCache(request.symbol);
              
              try {
                const { bestBid, bestAsk } = await this.getOrderBookBidAsk(request.symbol);
                avgExecutionPrice = isBuy ? bestAsk : bestBid;
              } catch (obError: any) {
                // Order book failed, try mark price
                this.logger.warn(
                  `Order book unavailable for ${request.symbol} close, using mark price: ${obError.message}`,
                );
                avgExecutionPrice = await this.getMarkPrice(request.symbol);
              }
            }

            if (!avgExecutionPrice || avgExecutionPrice <= 0) {
              throw new Error(
                `Could not determine price for closing ${request.symbol}: avgExecutionPrice=${avgExecutionPrice}`,
              );
            }

            // Apply price improvement (worse price = better chance to fill)
            // For BUY (closing SHORT): worse = higher price
            // For SELL (closing LONG): worse = lower price
            const adjustedPrice = isBuy
              ? avgExecutionPrice * (1 + priceImprovement)
              : avgExecutionPrice * (1 - priceImprovement);

            if (attempt > 1 && priceImprovement > 0) {
              this.logger.warn(
                `🔄 Closing ${request.symbol}: Applying ${(priceImprovement * 100).toFixed(2)}% slippage ` +
                  `($${adjustedPrice.toFixed(6)} vs base $${avgExecutionPrice.toFixed(6)})`,
              );
            }

            // Use createMarketOrder for closing positions (per Lighter docs)
            const [tx, hash, error] = await this.callApi(this.WEIGHT_TX, () =>
              this.signerClient!.createMarketOrder({
                marketIndex,
                clientOrderIndex: Date.now(),
                baseAmount,
                avgExecutionPrice: market.priceToUnits(adjustedPrice),
                isAsk,
                reduceOnly: true,
              })
            );

            if (error) {
              throw new Error(`Failed to close position: ${error}`);
            }

            // Wait for transaction
            try {
              await this.signerClient!.waitForTransaction(hash, 30000, 2000);
            } catch (waitError: any) {
              this.logger.warn(`Transaction wait failed: ${waitError.message}`);
            }

            // Track successful order - reset consecutive nonce error counter
            this.consecutiveNonceErrors = 0;
            this.lastSuccessfulOrderTime = new Date();

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
          } else {
            // For opening market orders, use createUnifiedOrder with idealPrice and maxSlippage
            // Strategy: 
            // - Attempt 0: Use mark price (candlesticks) for fair price
            // - Attempt 1: Use actual order book at best bid/ask (no slippage)
            // - Attempt 2+: Use order book with progressive slippage
            
            let idealPrice: number;
            
            // Progressive price improvement: starts at attempt 2
            // [attempt 0 = mark, attempt 1 = book no slippage, attempt 2+ = book + slippage]
            const priceImprovements = [0, 0, 0.001, 0.005, 0.01, 0.02, 0.05];
            const priceImprovement =
              priceImprovements[Math.min(attempt, priceImprovements.length - 1)];

            if (attempt === 0) {
              // First attempt: try mark price (fair value)
              try {
                const markPrice = await this.getMarkPrice(request.symbol);
                idealPrice = markPrice;
                  this.logger.debug(
                  `Market order ${request.symbol}: using mark price $${markPrice.toFixed(6)}`,
                );
              } catch (markError: any) {
                // Mark price failed, fall back to order book immediately
                this.logger.warn(
                  `Mark price unavailable for ${request.symbol}, using order book: ${markError.message}`,
                  );
                this.clearOrderBookCache(request.symbol);
                const { bestBid, bestAsk } = await this.getOrderBookBidAsk(request.symbol);
                idealPrice = isBuy ? bestAsk : bestBid;
              }
            } else if (attempt === 1) {
              // Second attempt: use order book at best price (no slippage yet)
              this.logger.warn(
                `🔄 Market order retry ${attempt + 1}/${maxRetries} for ${request.symbol}: ` +
                  `Using order book at best price (no slippage)`,
              );
              this.clearOrderBookCache(request.symbol);
              
              try {
                const { bestBid, bestAsk } = await this.getOrderBookBidAsk(request.symbol);
                idealPrice = isBuy ? bestAsk : bestBid;
              } catch (obError: any) {
                // Order book failed, try mark price
                this.logger.warn(
                  `Order book unavailable for ${request.symbol}, using mark price: ${obError.message}`,
                );
                idealPrice = await this.getMarkPrice(request.symbol);
              }
            } else {
              // Subsequent retries: use order book with progressive slippage
              this.logger.warn(
                `🔄 Market order retry ${attempt + 1}/${maxRetries} for ${request.symbol}: ` +
                  `Using order book with ${(priceImprovement * 100).toFixed(2)}% slippage`,
              );
              this.clearOrderBookCache(request.symbol);
              
              try {
                const { bestBid, bestAsk } = await this.getOrderBookBidAsk(request.symbol);
                // Apply slippage to take from the book
            idealPrice = isBuy
                  ? bestAsk * (1 + priceImprovement)
                  : bestBid * (1 - priceImprovement);
              } catch (obError: any) {
                // Order book failed, try mark price + slippage
              this.logger.warn(
                  `Order book unavailable for ${request.symbol}, using mark price + slippage: ${obError.message}`,
                );
                const markPrice = await this.getMarkPrice(request.symbol);
                idealPrice = isBuy
                  ? markPrice * (1 + priceImprovement)
                  : markPrice * (1 - priceImprovement);
              }
            }

            if (!idealPrice || idealPrice <= 0) {
              throw new Error(
                `Could not determine price for ${request.symbol}: idealPrice=${idealPrice}`,
              );
            }

            // Use createUnifiedOrder with MARKET order type (per Lighter docs)
            // For opening market orders: orderExpiry = 0
            const now = Date.now();
            orderParams = {
              marketIndex,
              clientOrderIndex: now,
              baseAmount,
              isAsk,
              orderType: LighterOrderType.MARKET,
              idealPrice: market.priceToUnits(idealPrice),
              maxSlippage: 0.01, // 1% max slippage
              orderExpiry: 0, // 0 for opening market orders
            };
          }
        } else {
          // Limit order
          if (!request.price) {
            throw new Error('Limit price is required for LIMIT orders');
          }

          // Updated to match the known working implementation:
          // 1 hour expiry, uses Date.now() for clientOrderIndex, no expiredAt field
          const now = Date.now();
          const EXPIRY_DURATION_MS = 60 * 60 * 1000; // 1 hour
          const orderExpiry = now + EXPIRY_DURATION_MS;

          this.logger.debug(
            `LIMIT order for ${request.symbol}: using 1 hour expiry (${new Date(orderExpiry).toISOString()})`,
          );

          orderParams = {
            marketIndex,
            clientOrderIndex: now,
            baseAmount,
            price: market.priceToUnits(request.price),
            isAsk,
            orderType: LighterOrderType.LIMIT,
            orderExpiry,
            reduceOnly: request.reduceOnly || false,
          };
        }

        // Log order details
        if (request.type === OrderType.LIMIT) {
          this.logger.log(
            `📋 LIMIT order for ${request.symbol}: 1 hour expiry (${new Date(orderParams.orderExpiry).toISOString()}), reduceOnly: ${orderParams.reduceOnly}`,
          );
        }

        this.logger.debug(
          `Creating unified order with params: ${JSON.stringify({
            marketIndex: orderParams.marketIndex,
            clientOrderIndex: orderParams.clientOrderIndex,
            baseAmount: orderParams.baseAmount.toString(),
            price:
              orderParams.price?.toString() ||
              orderParams.idealPrice?.toString() ||
              'N/A',
            isAsk: orderParams.isAsk,
            orderType: orderParams.orderType,
            orderExpiry: orderParams.orderExpiry,
            reduceOnly: orderParams.reduceOnly,
          })}`,
        );

        await this.rateLimiter.acquire(ExchangeType.LIGHTER, this.WEIGHT_TX);
        // Cast to any because the type definition might missing the nonce parameter
        const result = await (this.signerClient as any).createUnifiedOrder({
          ...orderParams,
          nonce: nonce || undefined
        });

        if (!result.success) {
          const errorMsg = result.mainOrder.error || 'Order creation failed';
          this.logger.error(`❌ Lighter order creation failed: ${errorMsg}`);
          this.logger.error(`Order params: ${JSON.stringify(orderParams)}`);
          this.recordError(
            'LIGHTER_ORDER_CREATION_FAILED',
            errorMsg,
            request.symbol,
            { orderParams },
          );
          throw new Error(errorMsg);
        }

        const orderId = result.mainOrder.hash;
        this.logger.log(`✅ Lighter order created successfully: ${orderId}`);

        // Wait for transaction to be processed (matching script behavior)
        try {
          await this.signerClient!.waitForTransaction(orderId, 30000, 2000);
        } catch (error: any) {
          // Transaction wait might fail, but order may still be submitted
          this.logger.warn(`Order transaction wait failed: ${error.message}`);
          this.recordError(
            'LIGHTER_TX_WAIT_FAILED',
            error.message,
            request.symbol,
            { orderId },
          );
        }

        // CRITICAL: Wait a short time and check if order was immediately filled or canceled
        // Lighter may cancel orders immediately if they don't meet certain conditions
        await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 second wait

        // Check positions to see if order filled immediately
        try {
          const positions = await this.getPositions();
          const matchingPosition = positions.find(
            (p) =>
              p.symbol === request.symbol &&
              p.side === request.side &&
              Math.abs(p.size) > 0.0001,
          );

          if (matchingPosition) {
            // Order filled immediately - check if size matches
            const expectedSize = request.size;
            const actualSize = matchingPosition.size;
            const sizeMatch = Math.abs(actualSize - expectedSize) < 0.0001;

            if (sizeMatch || actualSize >= expectedSize * 0.9) {
              // Allow 10% tolerance
              this.logger.log(
                `✅ Lighter order ${orderId} filled immediately: ${actualSize.toFixed(4)} ${request.symbol}`,
              );
              // Record success for market quality tracking
              this.recordSuccess(request.symbol);
              return new PerpOrderResponse(
                orderId,
                OrderStatus.FILLED,
                request.symbol,
                request.side,
                request.clientOrderId,
                actualSize,
                undefined,
                undefined,
                new Date(),
              );
            }
          }
        } catch (positionError: any) {
          this.logger.debug(
            `Could not check positions immediately after order placement: ${positionError.message}`,
          );
        }

        // Order is resting on the book (or may have been canceled - will be checked in waitForOrderFill)
        // Mark as SUBMITTED - caller should verify via waitForOrderFill

        // Track successful order - reset consecutive nonce error counter
        this.consecutiveNonceErrors = 0;
        this.lastSuccessfulOrderTime = new Date();

        return new PerpOrderResponse(
          orderId,
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
        lastError = error;
        const errorMsg = error?.message || String(error);
        const errorStack = error?.stack || '';

        // Log detailed error information
        this.logger.error(
          `❌ Lighter order placement failed (attempt ${attempt + 1}/${maxRetries}): ${errorMsg}`,
        );
        if (errorStack) {
          this.logger.debug(`Error stack: ${errorStack}`);
        }
        if (error?.response) {
          this.logger.debug(
            `Error response: ${JSON.stringify(error.response.data)}`,
          );
        }

        const isRateLimit =
          errorMsg.includes('Too Many Requests') ||
          errorMsg.includes('429') ||
          errorMsg.includes('rate limit') ||
          errorMsg.includes('market config');
        const isMarginModeError =
          errorMsg.includes('invalid margin mode') ||
          errorMsg.includes('margin mode');
        const isNonceError =
          errorMsg.toLowerCase().includes('invalid nonce') ||
          errorMsg.toLowerCase().includes('nonce');

        if (isRateLimit && attempt < maxRetries - 1) {
          // Silenced 429/rate limit warnings - only show errors
          this.logger.debug(
            `Order placement rate limited for ${request.symbol} ` +
              `(attempt ${attempt + 1}/${maxRetries}): ${errorMsg}. Will retry.`,
          );
          continue;
        }

        // Nonce errors - reset client and retry (with max consecutive error limit)
        const MAX_CONSECUTIVE_NONCE_ERRORS = 10; // Stop retrying after 10 consecutive nonce errors
        if (isNonceError && attempt < maxRetries - 1) {
          this.consecutiveNonceErrors++;
          const timeSinceLastSuccess = this.lastSuccessfulOrderTime
            ? `${Math.round((Date.now() - this.lastSuccessfulOrderTime.getTime()) / 1000)}s ago`
            : 'never';

          // If we've hit too many consecutive nonce errors, something is fundamentally wrong
          // Stop retrying and let the error propagate
          if (this.consecutiveNonceErrors >= MAX_CONSECUTIVE_NONCE_ERRORS) {
            this.logger.error(
              `❌ Lighter nonce error limit reached (${this.consecutiveNonceErrors} consecutive errors). ` +
                `Stopping retries. Last successful order: ${timeSinceLastSuccess}. ` +
                `This may indicate a fundamental issue with the Lighter SDK or account state.`,
            );
            this.recordError(
              'LIGHTER_NONCE_ERROR_LIMIT',
              `Consecutive nonce error limit (${MAX_CONSECUTIVE_NONCE_ERRORS}) reached`,
              request.symbol,
              {
                consecutiveNonceErrors: this.consecutiveNonceErrors,
                lastSuccessfulOrder: timeSinceLastSuccess,
                originalError: errorMsg,
              },
            );
            // Don't continue - let it fall through to the final error handling
          } else {
            this.logger.warn(
              `⚠️ Lighter nonce error #${this.consecutiveNonceErrors} for ${request.symbol}: ${errorMsg}. ` +
                `Last successful order: ${timeSinceLastSuccess}. ` +
                `Re-syncing nonce and retrying (attempt ${attempt + 1}/${maxRetries})...`,
            );
            this.recordError('LIGHTER_NONCE_ERROR', errorMsg, request.symbol, {
              attempt: attempt + 1,
              consecutiveNonceErrors: this.consecutiveNonceErrors,
              lastSuccessfulOrder: timeSinceLastSuccess,
            });

            // IMPROVED: Try lightweight refresh first (faster, less disruptive)
            // Only do full reset if lightweight refresh fails or after 3+ consecutive errors
            let refreshed = false;
            if (this.consecutiveNonceErrors < 3) {
              refreshed = await this.tryLightweightNonceRefresh();
            }
            
            if (!refreshed) {
              // Fall back to full SignerClient recreation
              await this.resetSignerClient();
            }

            // Progressive backoff for nonce errors - reduced for faster recovery
            // 500ms, 1s, 2s, 4s... capped at 5s
            const nonceBackoff = Math.min(
              500 * Math.pow(2, this.consecutiveNonceErrors - 1),
              5000,
            );
            this.logger.debug(
              `Waiting ${nonceBackoff}ms before retry after nonce error`,
            );
            await new Promise((resolve) => setTimeout(resolve, nonceBackoff));
            continue;
          }
        }

        // Margin mode errors are not retryable - account configuration issue
        if (isMarginModeError) {
          this.logger.error(
            `❌ MARGIN MODE ERROR on ${request.symbol}: ${errorMsg}. ` +
              `Order details: ${request.side} ${request.size} @ ${request.price} (type: ${request.type}). ` +
              `This indicates the account may need margin mode configured for this market. ` +
              `Please check your Lighter account settings or contact support.`,
          );
          this.recordError(
            'LIGHTER_MARGIN_MODE_ERROR',
            `${request.symbol}: ${errorMsg}`,
            request.symbol,
            {
              orderSide: request.side,
              orderSize: request.size,
              orderPrice: request.price,
              orderType: request.type,
              reduceOnly: request.reduceOnly,
              rawError: errorMsg,
              timestamp: new Date().toISOString(),
            },
          );
          
          // Track this symbol as having margin mode issues
          if (this.diagnosticsService) {
            this.diagnosticsService.recordMarginModeError?.(
              request.symbol,
              ExchangeType.LIGHTER,
              errorMsg,
            );
          }
          
          throw new ExchangeError(
            `Invalid margin mode for ${request.symbol}: Account may need margin mode configured. ${errorMsg}`,
            ExchangeType.LIGHTER,
            undefined,
            error,
          );
        }

        // Not retryable or max retries reached
        this.logger.error(`Failed to place order: ${errorMsg}`);
        this.recordError('LIGHTER_ORDER_FAILED', errorMsg, request.symbol, {
          attempt: attempt + 1,
          maxRetries,
        });
        throw new ExchangeError(
          `Failed to place order: ${errorMsg}`,
          ExchangeType.LIGHTER,
          undefined,
          error,
        );
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

      // Use Lighter Explorer API to get positions
      // Endpoint: https://explorer.elliot.ai/api/accounts/{accountIndex}/positions
      const accountIndex = this.config.accountIndex!;
      const explorerUrl = `https://explorer.elliot.ai/api/accounts/${accountIndex}/positions`;

      this.logger.debug(
        `Fetching positions from Lighter Explorer API for account ${accountIndex}...`,
      );

      const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(explorerUrl, {
        timeout: 10000,
        headers: { accept: 'application/json' },
      }));

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
      const matchingOrder = activeOrders.find(o => 
        o.symbol === request.symbol && 
        o.side.toLowerCase() === request.side.toLowerCase()
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
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          // Fetch a fresh nonce explicitly before each modify attempt
          const nonce = await this.getFreshNonce();
          
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

        // Not a nonce error or last attempt - throw
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
  async getOpenOrders(): Promise<
    import('../../../domain/ports/IPerpExchangeAdapter').OpenOrder[]
  > {
    try {
      await this.ensureInitialized();

      this.logger.debug('🔍 Fetching open orders from Lighter...');

      // Create auth token for authenticated endpoint
      const authToken = await this.signerClient!.createAuthTokenWithExpiry(600); // 10 minutes

      // Note: accountActiveOrders requires market_id, so we need to query each market
      // For now, query all markets we care about (0-100) or use a different endpoint
      // Actually, let's try the account endpoint which includes open_order_count per position
      const accountResponse = await this.callApi(this.WEIGHT_INFO, () => axios.get(
        `${this.config.baseUrl}/api/v1/account`,
        {
          params: {
            by: 'index',
            value: String(this.config.accountIndex),
          },
          timeout: 10000,
          headers: { accept: 'application/json' },
        },
      ));

      if (!accountResponse.data || accountResponse.data.code !== 200) {
        this.logger.debug(
          `Lighter account API returned: ${JSON.stringify(accountResponse.data).substring(0, 200)}`,
        );
        return [];
      }

      // Find markets with open orders from account data
      const positions = accountResponse.data.accounts?.[0]?.positions || [];
      const marketsWithOrders = positions
        .filter(
          (p: any) =>
            (p.open_order_count || 0) > 0 || (p.pending_order_count || 0) > 0,
        )
        .map((p: any) => p.market_id);

      if (marketsWithOrders.length === 0) {
        this.logger.debug(
          '🔍 No markets with open orders found in account data',
        );
        return [];
      }

      this.logger.log(
        `🔍 Found ${marketsWithOrders.length} market(s) with open orders: ${marketsWithOrders.join(', ')}`,
      );

      // Query each market with open orders
      const allOrders: import('../../../domain/ports/IPerpExchangeAdapter').OpenOrder[] =
        [];

      for (const marketId of marketsWithOrders) {
        try {
          const response = await this.callApi(this.WEIGHT_INFO, () => axios.get(
            `${this.config.baseUrl}/api/v1/accountActiveOrders`,
            {
              params: {
                auth: authToken,
                market_id: marketId,
                account_index: this.config.accountIndex, // Required parameter!
              },
              timeout: 10000,
              headers: { accept: 'application/json' },
            },
          ));

          if (!response.data || response.data.code !== 200) {
            this.logger.debug(
              `Lighter accountActiveOrders for market ${marketId} returned: ${JSON.stringify(response.data).substring(0, 200)}`,
            );
            continue;
          }

          const ordersData = response.data.orders || [];
          this.logger.debug(
            `🔍 Market ${marketId}: Found ${ordersData.length} order(s)`,
          );

          for (const orderData of ordersData) {
            try {
              // API returns: order_id, initial_base_amount, remaining_base_amount, price, is_ask, filled_base_amount
              const orderId = String(
                orderData.order_id || orderData.order_index || '',
              );
              const symbol = await this.getSymbolFromMarketIndex(marketId);
              if (!symbol || !orderId) continue;

              // is_ask: false = buy/long, true = sell/short
              const side: 'buy' | 'sell' = orderData.is_ask ? 'sell' : 'buy';

              const price = parseFloat(String(orderData.price || '0'));
              // Use remaining_base_amount for current size
              const size = Math.abs(
                parseFloat(
                  String(
                    orderData.remaining_base_amount ||
                      orderData.initial_base_amount ||
                      '0',
                  ),
                ),
              );
              const initialSize = Math.abs(
                parseFloat(String(orderData.initial_base_amount || '0')),
              );
              const filledSize = Math.abs(
                parseFloat(String(orderData.filled_base_amount || '0')),
              );

              // Parse timestamp from nonce or created_time
              let timestamp = new Date();
              if (orderData.created_time) {
                timestamp = new Date(
                  orderData.created_time < 1e12
                    ? orderData.created_time * 1000
                    : orderData.created_time,
                );
              } else if (orderData.nonce) {
                // Nonce includes timestamp in high bits - extract rough timestamp
                // This is a fallback; actual created_time should be preferred
                const nonceTimestamp = Math.floor(orderData.nonce / 2 ** 32);
                if (nonceTimestamp > 0 && nonceTimestamp < 2e9) {
                  timestamp = new Date(nonceTimestamp * 1000);
                }
              }

              allOrders.push({
                orderId,
                symbol,
                side,
                price,
                size,
                filledSize,
                timestamp,
              });
              this.logger.debug(
                `  Order: ${orderId} ${side} ${size} ${symbol} @ ${price}`,
              );
            } catch (e: any) {
              this.logger.debug(`Failed to parse order: ${e.message}`);
            }
          }
        } catch (marketError: any) {
          this.logger.debug(
            `Failed to get orders for market ${marketId}: ${marketError.message}`,
          );
        }
      }

      if (allOrders.length > 0) {
        this.logger.log(
          `🔍 Total open orders on Lighter: ${allOrders.length} - ${allOrders.map((o) => `${o.symbol} ${o.side} ${o.size}@${o.price}`).join(', ')}`,
        );
      }
      return allOrders;
    } catch (error: any) {
      this.logger.warn(
        `⚠️ Failed to get open orders from Lighter: ${error.message}`,
      );
      return [];
    }
  }

  async getOrderStatus(
    orderId: string,
    symbol?: string,
  ): Promise<PerpOrderResponse> {
    try {
      await this.ensureInitialized();

      // Lighter SDK limitation: The @reservoir0x/lighter-ts-sdk doesn't provide a method to query order status
      // by order ID. We work around this by checking positions to see if the order filled.
      // If no matching position exists, the order may be resting on the book or canceled.

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

      // Check positions to see if order filled
      try {
        const positions = await this.getPositions();

        // Try to infer order side from positions (if we have a position for this symbol)
        // Note: This is imperfect but better than always returning SUBMITTED
        const matchingPosition = positions.find(
          (p) => p.symbol === symbol && Math.abs(p.size) > 0.0001,
        );

        if (matchingPosition) {
          // Position exists - order may have filled (but we can't be 100% sure it's this specific order)
          // Return SUBMITTED to let waitForOrderFill continue checking
          this.logger.debug(
            `getOrderStatus: Found position for ${symbol} (${matchingPosition.side}, size: ${matchingPosition.size}), ` +
              `but cannot confirm if order ${orderId} filled. Returning SUBMITTED.`,
          );
        } else {
          // No position found - order may be resting on book or canceled
          // We can't distinguish between these cases without querying open orders
          this.logger.debug(
            `getOrderStatus: No position found for ${symbol}. Order ${orderId} may be resting or canceled.`,
          );
        }
      } catch (positionError: any) {
        this.logger.debug(
          `Could not check positions for order status: ${positionError.message}`,
        );
      }

      // Return SUBMITTED - waitForOrderFill will continue checking positions
      return new PerpOrderResponse(
        orderId,
        OrderStatus.SUBMITTED,
        symbol,
        OrderSide.LONG, // Default, actual side unknown without order data
        undefined,
        undefined,
        undefined,
        undefined,
        new Date(),
      );
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
            return wsBest;
          }
        } catch (e) {
          // Fall back to REST if market index lookup fails
        }
      }

      if (cacheOnly) return null;

      // 2. Fall back to existing method
      return await this.getOrderBookBidAsk(symbol);
    } catch (error) {
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
}
