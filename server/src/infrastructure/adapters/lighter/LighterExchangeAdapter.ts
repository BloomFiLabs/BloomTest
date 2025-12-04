import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignerClient, OrderType as LighterOrderType, ApiClient, OrderApi, MarketHelper } from '@reservoir0x/lighter-ts-sdk';
import axios from 'axios';
import { ethers } from 'ethers';
import { ExchangeConfig, ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForce,
} from '../../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../../domain/entities/PerpPosition';
import { IPerpExchangeAdapter, ExchangeError } from '../../../domain/ports/IPerpExchangeAdapter';

/**
 * LighterExchangeAdapter - Implements IPerpExchangeAdapter for Lighter Protocol
 * 
 * Based on the existing lighter-order-simple.ts script logic
 */
@Injectable()
export class LighterExchangeAdapter implements IPerpExchangeAdapter {
  private readonly logger = new Logger(LighterExchangeAdapter.name);
  private readonly config: ExchangeConfig;
  private signerClient: SignerClient | null = null;
  private orderApi: OrderApi | null = null;
  private marketHelpers: Map<number, MarketHelper> = new Map(); // marketIndex -> MarketHelper
  
  // Market index mapping cache: symbol -> marketIndex
  private marketIndexCache: Map<string, number> = new Map();
  private marketIndexCacheTimestamp: number = 0;
  private readonly MARKET_INDEX_CACHE_TTL = 3600000; // 1 hour cache

  constructor(private readonly configService: ConfigService) {
    const baseUrl = this.configService.get<string>('LIGHTER_API_BASE_URL') || 'https://mainnet.zklighter.elliot.ai';
    const apiKey = this.configService.get<string>('LIGHTER_API_KEY');
    const accountIndex = parseInt(this.configService.get<string>('LIGHTER_ACCOUNT_INDEX') || '1000');
    const apiKeyIndex = parseInt(this.configService.get<string>('LIGHTER_API_KEY_INDEX') || '1');

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

    this.logger.log(`Lighter adapter initialized for account index: ${accountIndex}`);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.signerClient) {
      const normalizedKey = this.config.apiKey!;
      
      this.signerClient = new SignerClient({
        url: this.config.baseUrl,
        privateKey: normalizedKey,
        accountIndex: this.config.accountIndex!,
        apiKeyIndex: this.config.apiKeyIndex!,
      });

      await this.signerClient.initialize();
      await this.signerClient.ensureWasmClient();

      const apiClient = new ApiClient({ host: this.config.baseUrl });
      this.orderApi = new OrderApi(apiClient);
    }
  }

  private async getMarketHelper(marketIndex: number): Promise<MarketHelper> {
    if (!this.marketHelpers.has(marketIndex)) {
      await this.ensureInitialized();
      const market = new MarketHelper(marketIndex, this.orderApi!);
      
      // Add retry logic with exponential backoff for market config fetch (rate limiting)
      const maxRetries = 6;
      const baseDelay = 2000; // 2 seconds base delay
      const maxDelay = 60000; // 60 seconds max delay
      let lastError: any = null;
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            // Exponential backoff with jitter: 2s, 4s, 8s, 16s, 32s, 60s (capped)
            const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
            const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);
            const delay = Math.max(1000, exponentialDelay + jitter);
            
            this.logger.debug(
              `Retrying market config fetch for market ${marketIndex} after ${Math.floor(delay / 1000)}s ` +
              `(attempt ${attempt + 1}/${maxRetries})`
            );
            await new Promise(resolve => setTimeout(resolve, delay));
          }
          
          await market.initialize();
          this.marketHelpers.set(marketIndex, market);
          return market;
        } catch (error: any) {
          lastError = error;
          const errorMsg = error?.message || String(error);
          const isRateLimit = errorMsg.includes('Too Many Requests') || 
                             errorMsg.includes('429') ||
                             errorMsg.includes('rate limit');
          
          if (isRateLimit && attempt < maxRetries - 1) {
            this.logger.warn(
              `Market config fetch rate limited for market ${marketIndex} ` +
              `(attempt ${attempt + 1}/${maxRetries}): ${errorMsg}. Will retry.`
            );
            continue;
          }
          
          // Not retryable or max retries reached
          throw error;
        }
      }
      
      // Should never reach here, but just in case
      throw lastError || new Error(`Failed to initialize market helper for market ${marketIndex}`);
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
    if (this.marketIndexCache.size > 0 && (now - this.marketIndexCacheTimestamp) < this.MARKET_INDEX_CACHE_TTL) {
      return;
    }

    try {
      this.logger.debug('Fetching market index mappings from Lighter Explorer API...');
      
      const explorerUrl = 'https://explorer.elliot.ai/api/markets';
      const response = await axios.get(explorerUrl, {
        timeout: 10000,
        headers: { accept: 'application/json' },
      });

      if (!response.data || !Array.isArray(response.data)) {
        this.logger.warn('Lighter Explorer API returned invalid data format');
        return;
      }

      // Clear old cache
      this.marketIndexCache.clear();

      // Parse response: [{ "symbol": "ETH", "market_index": 0 }, ...]
      for (const market of response.data) {
        // API uses "market_index" (with underscore)
        const marketIndex = market.market_index ?? market.marketIndex ?? market.index ?? null;
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
      this.logger.log(`Cached ${this.marketIndexCache.size} market index mappings from Lighter Explorer API`);
    } catch (error: any) {
      this.logger.warn(`Failed to fetch market index mappings from Explorer API: ${error.message}`);
      // Don't throw - allow fallback to hardcoded mapping
    }
  }

  /**
   * Convert symbol to market index
   * Uses cached Explorer API data, with fallback to hardcoded mapping
   */
  private async getMarketIndex(symbol: string): Promise<number> {
    // Refresh cache if needed
    await this.refreshMarketIndexCache();

    // Normalize symbol
    const baseSymbol = symbol.replace('USDC', '').replace('USDT', '').replace('-PERP', '').toUpperCase();

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
      'ETH': 0,
      'BTC': 1,
      // Add more as needed
    };

    const fallbackIndex = symbolToMarketIndex[baseSymbol] ?? 0;
    this.logger.warn(
      `Market index not found for ${symbol} (${baseSymbol}), using fallback index: ${fallbackIndex}. ` +
      `Consider checking Lighter Explorer API: https://explorer.elliot.ai/api/markets`
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
    // Add retry logic with exponential backoff for order placement (rate limiting)
    const maxRetries = 6;
    const baseDelay = 2000; // 2 seconds base delay
    const maxDelay = 60000; // 60 seconds max delay
    let lastError: any = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff with jitter: 2s, 4s, 8s, 16s, 32s, 60s (capped)
          const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
          const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);
          const delay = Math.max(1000, exponentialDelay + jitter);
          
          this.logger.warn(
            `Retrying order placement for ${request.symbol} after ${Math.floor(delay / 1000)}s ` +
            `(attempt ${attempt + 1}/${maxRetries})`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        await this.ensureInitialized();

        const marketIndex = await this.getMarketIndex(request.symbol);
        const market = await this.getMarketHelper(marketIndex);

        const isBuy = request.side === OrderSide.LONG;
        const isAsk = !isBuy;

        // Convert size to market units
        const baseAmount = market.amountToUnits(request.size);

        let orderParams: any;
        if (request.type === OrderType.MARKET) {
          // For market orders, we need to use a limit order with current market price
          // Add retry logic for order book fetch
          let orderBook: any;
          const orderBookMaxRetries = 5;
          for (let obAttempt = 0; obAttempt < orderBookMaxRetries; obAttempt++) {
            try {
              if (obAttempt > 0) {
                const obDelay = Math.min(baseDelay * Math.pow(2, obAttempt - 1), maxDelay);
                const obJitter = obDelay * 0.2 * (Math.random() * 2 - 1);
                const delay = Math.max(1000, obDelay + obJitter);
                this.logger.debug(`Retrying order book fetch (attempt ${obAttempt + 1}/${orderBookMaxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
              }
              // Cast to any since SDK types may be incomplete (script shows this works)
              orderBook = await this.orderApi!.getOrderBookDetails({ marketIndex: marketIndex } as any) as any;
              break;
            } catch (obError: any) {
              const obErrorMsg = obError?.message || String(obError);
              const isObRateLimit = obErrorMsg.includes('Too Many Requests') || 
                                    obErrorMsg.includes('429') ||
                                    obErrorMsg.includes('rate limit');
              if (isObRateLimit && obAttempt < orderBookMaxRetries - 1) {
                continue;
              }
              throw obError;
            }
          }
          
          const price = isBuy 
            ? parseFloat(orderBook.bestAsk?.price || '0')
            : parseFloat(orderBook.bestBid?.price || '0');
          
          orderParams = {
            marketIndex,
            clientOrderIndex: Date.now(),
            baseAmount,
            price: market.priceToUnits(price),
            isAsk,
            orderType: LighterOrderType.MARKET,
            orderExpiry: Date.now() + 3600000, // 1 hour expiry
          };
        } else {
          // Limit order
          if (!request.price) {
            throw new Error('Limit price is required for LIMIT orders');
          }

          orderParams = {
            marketIndex,
            clientOrderIndex: Date.now(),
            baseAmount,
            price: market.priceToUnits(request.price),
            isAsk,
            orderType: LighterOrderType.LIMIT,
            orderExpiry: Date.now() + 3600000, // 1 hour expiry
          };
        }

        const result = await this.signerClient!.createUnifiedOrder(orderParams);

        if (!result.success) {
          const errorMsg = result.mainOrder.error || 'Order creation failed';
          throw new Error(errorMsg);
        }

        const orderId = result.mainOrder.hash;
        
        // Wait for transaction to be processed (matching script behavior)
        try {
          await this.signerClient!.waitForTransaction(orderId, 30000, 2000);
        } catch (error: any) {
          // Transaction wait might fail, but order may still be submitted
          this.logger.warn(`Order transaction wait failed: ${error.message}`);
        }

        // Check if order was filled immediately or is resting
        // Lighter doesn't provide immediate fill status, so we mark as SUBMITTED
        // The actual status can be checked later via getOrderStatus
        const status = OrderStatus.SUBMITTED;

        return new PerpOrderResponse(
          orderId,
          status,
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
        const isRateLimit = errorMsg.includes('Too Many Requests') || 
                           errorMsg.includes('429') ||
                           errorMsg.includes('rate limit') ||
                           errorMsg.includes('market config');
        
        if (isRateLimit && attempt < maxRetries - 1) {
          this.logger.warn(
            `Order placement rate limited for ${request.symbol} ` +
            `(attempt ${attempt + 1}/${maxRetries}): ${errorMsg}. Will retry.`
          );
          continue;
        }
        
        // Not retryable or max retries reached
        this.logger.error(`Failed to place order: ${errorMsg}`);
        throw new ExchangeError(
          `Failed to place order: ${errorMsg}`,
          ExchangeType.LIGHTER,
          undefined,
          error,
        );
      }
    }
    
    // Should never reach here, but just in case
    throw new ExchangeError(
      `Failed to place order after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`,
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
      
      return positions.find((p) => {
        const posSymbol = p.symbol
          .replace('USDC', '')
          .replace('USDT', '')
          .replace('-PERP', '')
          .replace('PERP', '')
          .toUpperCase();
        return posSymbol === normalizedSymbol;
      }) || null;
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
  private async getSymbolFromMarketIndex(marketIndex: number): Promise<string | null> {
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
      const response = await axios.get(explorerUrl, {
        timeout: 10000,
        headers: { accept: 'application/json' },
      });

      if (response.data && Array.isArray(response.data)) {
        for (const market of response.data) {
          const idx = market.market_index ?? market.marketIndex ?? market.index ?? null;
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
      this.logger.debug(`Failed to fetch symbol for market index ${marketIndex}: ${error.message}`);
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
      
      this.logger.debug(`Fetching positions from Lighter Explorer API for account ${accountIndex}...`);
      
      const response = await axios.get(explorerUrl, {
        timeout: 10000,
        headers: { accept: 'application/json' },
      });

      if (!response.data) {
        this.logger.warn('Lighter Explorer API returned empty positions data');
        return [];
      }

      // Lighter API returns positions as an object with market_index as keys
      // Structure: { "positions": { "51": {...}, "52": {...} } }
      const positionsObj = response.data.positions || {};
      if (typeof positionsObj !== 'object' || Array.isArray(positionsObj)) {
        this.logger.warn('Lighter Explorer API returned unexpected positions format');
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
          const marketIndex = posData.market_index ?? posData.marketIndex ?? posData.index ?? null;
          if (marketIndex === null) {
            this.logger.warn(`Position data missing market_index: ${JSON.stringify(posData).substring(0, 200)}`);
            continue;
          }

          // Get symbol from market index
          const symbol = await this.getSymbolFromMarketIndex(marketIndex);
          if (!symbol) {
            this.logger.warn(`Could not resolve symbol for market index ${marketIndex}, skipping position`);
            continue;
          }

          // Parse position size (can be negative for short positions)
          const sizeRaw = posData.size ?? posData.positionSize ?? posData.amount ?? '0';
          const size = parseFloat(String(sizeRaw));
          
          if (size === 0 || isNaN(size)) {
            continue; // Skip zero positions
          }

          // Determine side: API provides "side" field ("long" or "short"), or infer from size sign
          let side: OrderSide;
          if (posData.side) {
            const sideStr = String(posData.side).toLowerCase();
            side = sideStr === 'long' || sideStr === 'l' ? OrderSide.LONG : OrderSide.SHORT;
          } else {
            // Fallback: infer from size sign
            side = size > 0 ? OrderSide.LONG : OrderSide.SHORT;
          }
          const absSize = Math.abs(size);

          // Parse entry price (required)
          const entryPrice = parseFloat(String(posData.entry_price ?? posData.entryPrice ?? posData.avgEntryPrice ?? '0'));
          
          if (entryPrice <= 0) {
            this.logger.warn(`Invalid entry price for ${symbol}: ${entryPrice}`);
            continue;
          }

          // Fetch current mark price (not provided in positions response)
          let markPrice: number;
          try {
            markPrice = await this.getMarkPrice(symbol);
            if (markPrice <= 0) {
              // Fallback to entry price if mark price fetch fails
              this.logger.debug(`Could not fetch mark price for ${symbol}, using entry price`);
              markPrice = entryPrice;
            }
          } catch (error: any) {
            // Fallback to entry price if mark price fetch fails
            this.logger.debug(`Failed to fetch mark price for ${symbol}: ${error.message}, using entry price`);
            markPrice = entryPrice;
          }

          // Parse PnL (unrealized profit/loss)
          const unrealizedPnl = parseFloat(String(posData.pnl ?? posData.unrealized_pnl ?? posData.unrealizedPnl ?? '0'));

          // Lighter API doesn't provide leverage, liquidation price, or margin used in positions response
          // These can be calculated or fetched separately if needed
          const leverage = undefined; // Not provided by API
          const liquidationPrice = undefined; // Not provided by API
          const marginUsed = undefined; // Not provided by API

          positions.push(
            new PerpPosition(
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
            ),
          );
        } catch (error: any) {
          this.logger.warn(`Failed to parse position data: ${error.message}. Data: ${JSON.stringify(posData).substring(0, 200)}`);
          continue;
        }
      }

      this.logger.debug(`Retrieved ${positions.length} positions from Lighter Explorer API`);
      return positions;
    } catch (error: any) {
      this.logger.error(`Failed to get positions: ${error.message}`);
      if (error.response) {
        this.logger.error(`API response: ${JSON.stringify(error.response.data).substring(0, 400)}`);
      }
      throw new ExchangeError(
        `Failed to get positions: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      await this.ensureInitialized();
      
      // Lighter uses order hash for cancellation
      // SDK signature may require different parameters - cast to any for now
      await (this.signerClient!.cancelOrder as any)(orderId);
      return true;
    } catch (error: any) {
      this.logger.error(`Failed to cancel order: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel order: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  async cancelAllOrders(symbol: string): Promise<number> {
    try {
      await this.ensureInitialized();
      
      const marketIndex = await this.getMarketIndex(symbol);
      
      // Cancel all orders for the market
      // SDK requires timeInForce and time parameters - use current time
      const timeInForce = 0; // GTC
      const time = Math.floor(Date.now() / 1000);
      await this.signerClient!.cancelAllOrders(timeInForce, time);
      
      // Lighter doesn't return count, so we return 1 as a placeholder
      return 1;
    } catch (error: any) {
      this.logger.error(`Failed to cancel all orders: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel all orders: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  async getOrderStatus(orderId: string, symbol?: string): Promise<PerpOrderResponse> {
    try {
      await this.ensureInitialized();
      
      // Lighter SDK doesn't have getOrder method on OrderApi
      // For now, return a default response indicating order was submitted
      // In production, you would need to query Lighter's API directly or use a different SDK method
      this.logger.warn('getOrderStatus not fully implemented for Lighter - SDK limitation');
      
      return new PerpOrderResponse(
        orderId,
        OrderStatus.SUBMITTED,
        symbol || 'UNKNOWN',
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
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
  private readonly PRICE_CACHE_TTL = 10000; // 10 seconds cache

  async getMarkPrice(symbol: string): Promise<number> {
    // Check cache first
    const cached = this.priceCache.get(symbol);
    if (cached && (Date.now() - cached.timestamp) < this.PRICE_CACHE_TTL) {
      return cached.price;
    }

    try {
      await this.ensureInitialized();
      
      const marketIndex = await this.getMarketIndex(symbol);
      let markPrice: number | null = null;
      let lastError: string | null = null;

      // Method 0: Try candlesticks endpoint (proven to work reliably)
      // Using axios directly to avoid ES module import issues with @api/zklighter
      // Add retry logic for rate limiting (429 errors) with improved exponential backoff
      const maxRetries = 6; // Increased from 3 to 6
      const baseDelay = 2000; // 2 seconds base delay
      const maxDelay = 60000; // 60 seconds max delay
      
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            // Exponential backoff with jitter: 2s, 4s, 8s, 16s, 32s, 60s (capped)
            const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
            // Add jitter (±20%) to avoid thundering herd problem
            const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1); // Random between -20% and +20%
            const delay = Math.max(1000, exponentialDelay + jitter); // Minimum 1 second
            
            this.logger.debug(
              `Retrying candlesticks API for ${symbol} after ${Math.floor(delay / 1000)}s ` +
              `(attempt ${attempt + 1}/${maxRetries}, exponential: ${Math.floor(exponentialDelay / 1000)}s)`
            );
            await new Promise(resolve => setTimeout(resolve, delay));
          }
          
          const now = Math.floor(Date.now() / 1000);
          const oneMinuteAgo = now - 60;
          const baseUrl = this.config.baseUrl;
          
          const candlestickResponse = await axios.get(`${baseUrl}/api/v1/candlesticks`, {
            params: {
              market_id: marketIndex,
              resolution: '1m',
              start_timestamp: oneMinuteAgo,
              end_timestamp: now,
              count_back: 1,
              set_timestamp_to_end: true
            },
            timeout: 10000,
          });
          
          const candlestickData = candlestickResponse.data;
          const candlesticks = candlestickData?.candlesticks || [];
          
          if (candlesticks && Array.isArray(candlesticks) && candlesticks.length > 0) {
            const latest = candlesticks[candlesticks.length - 1];
            const closePrice = latest?.close; // Already a number from the API
            
            if (closePrice && typeof closePrice === 'number' && !isNaN(closePrice) && closePrice > 0) {
              markPrice = closePrice;
              this.priceCache.set(symbol, { price: markPrice, timestamp: Date.now() });
              this.logger.debug(`Got price for ${symbol} from candlesticks: $${markPrice.toFixed(2)}`);
              return markPrice;
            }
          }
          
          // If we got here, no price found but no error - break retry loop
          break;
        } catch (candlestickError: any) {
          const errorMsg = candlestickError?.message || candlestickError?.toString() || String(candlestickError);
          const errorResponse = candlestickError?.response?.data || candlestickError?.response || candlestickError?.data;
          const statusCode = candlestickError?.response?.status;
          
          // If it's a 429 (rate limit), retry with improved backoff
          if (statusCode === 429 && attempt < maxRetries - 1) {
            lastError = `Candlesticks API: Rate limited (429), will retry`;
            this.logger.warn(
              `Candlesticks method rate limited for ${symbol} (attempt ${attempt + 1}/${maxRetries}): ${errorMsg}. ` +
              `Will retry with exponential backoff.`
            );
            continue; // Retry
          }
          
          // For other errors or final attempt, log and break
          lastError = `Candlesticks API: ${errorMsg}`;
          this.logger.debug(
            `Candlesticks method failed for ${symbol}: ${errorMsg}\n` +
            `Error response: ${JSON.stringify(errorResponse || {}).substring(0, 200)}`
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
        const response = await this.orderApi!.getOrderBookDetails({ marketIndex: marketIndex } as any) as any;
        
        // Log the actual response structure for debugging
        this.logger.debug(
          `Order book response for ${symbol} (marketIndex: ${marketIndex}): ` +
          `${JSON.stringify(response).substring(0, 300)}`
        );
        
        // Response structure: { code: 200, order_book_details: { bestBid: {...}, bestAsk: {...} } }
        const orderBook = response?.order_book_details || response;
        const bestBid = orderBook?.bestBid || orderBook?.best_bid;
        const bestAsk = orderBook?.bestAsk || orderBook?.best_ask;
        
        if (bestBid?.price && bestAsk?.price) {
          markPrice = (parseFloat(bestBid.price) + parseFloat(bestAsk.price)) / 2;
          if (markPrice > 0) {
            this.priceCache.set(symbol, { price: markPrice, timestamp: Date.now() });
            return markPrice;
          }
        } else {
          // No price found in response - log what we got
          lastError = `Order book: No price data in response. Response keys: ${Object.keys(response || {}).join(', ')}. OrderBook keys: ${Object.keys(orderBook || {}).join(', ')}`;
          this.logger.warn(
            `Order book method returned no price for ${symbol} (marketIndex: ${marketIndex}). ` +
            `Response structure: ${JSON.stringify(response).substring(0, 400)}`
          );
        }
      } catch (orderBookError: any) {
        const errorMsg = orderBookError?.message || orderBookError?.toString() || String(orderBookError);
        const errorResponse = orderBookError?.response?.data || orderBookError?.response || orderBookError?.data;
        lastError = `Order book (marketIndex): ${errorMsg}`;
        this.logger.error(
          `Order book method (marketIndex) failed for ${symbol} (marketIndex: ${marketIndex}): ` +
          `${errorMsg}\n` +
          `Error response: ${errorResponse ? JSON.stringify(errorResponse).substring(0, 400) : 'No error response'}\n` +
          `Full error: ${orderBookError ? JSON.stringify(orderBookError).substring(0, 400) : 'No error object'}`
        );
      }

      // Method 1b: Try orderBooks with market_id as string (alternative endpoint)
      try {
        const apiClient = new ApiClient({ host: this.config.baseUrl });
        const orderBooksResponse = await (apiClient as any).order?.orderBooks({ market_id: marketIndex.toString() }) as any;
        
        // orderBooks returns metadata, not prices, but check if there's price data nested
        if (orderBooksResponse?.order_books && Array.isArray(orderBooksResponse.order_books)) {
          const marketBook = orderBooksResponse.order_books.find((book: any) => 
            book.market_id === marketIndex || book.market_id === marketIndex.toString()
          );
          
          // orderBooks endpoint returns metadata (fees, min amounts) but not prices
          // So we can't get mark price from this endpoint
          // But we can verify the market exists and is active
          if (marketBook && marketBook.status === 'active') {
            this.logger.debug(`Market ${marketIndex} (${symbol}) verified via orderBooks API as active`);
            // Continue to next method to get actual prices
          }
        }
      } catch (orderBooksError: any) {
        // This is expected - orderBooks doesn't return prices, just metadata
        this.logger.debug(`orderBooks API (metadata only, no prices): ${orderBooksError.message}`);
      }

      // Method 2: Try funding rates API (may include mark price) - this is cached by LighterFundingDataProvider
      let fundingRates: any[] = [];
      try {
        const baseUrl = this.configService.get<string>('LIGHTER_API_BASE_URL') || 'https://mainnet.zklighter.elliot.ai';
        const fundingUrl = `${baseUrl}/api/v1/funding-rates`;
        const response = await axios.get(fundingUrl, {
          timeout: 10000,
        });

        // Handle different response structures
        if (response.data?.funding_rates && Array.isArray(response.data.funding_rates)) {
          fundingRates = response.data.funding_rates;
        } else if (Array.isArray(response.data)) {
          fundingRates = response.data;
        }

        if (fundingRates.length > 0) {
          const marketRate = fundingRates.find(
            (r: any) => 
              r.market_id === marketIndex || 
              r.market_index === marketIndex ||
              r.marketIndex === marketIndex
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
              this.priceCache.set(symbol, { price: markPrice, timestamp: Date.now() });
              return markPrice;
            }
          }
        }
      } catch (fundingError: any) {
        const errorMsg = fundingError?.message || fundingError?.toString() || String(fundingError);
        const errorResponse = fundingError?.response?.data || fundingError?.response || fundingError?.data;
        lastError = `Funding rates API: ${errorMsg}`;
        const errorResponseStr = errorResponse ? JSON.stringify(errorResponse).substring(0, 400) : 'No error response';
        this.logger.warn(
          `Funding rates API method failed for ${symbol}: ${errorMsg}\n` +
          `Error response: ${errorResponseStr}`
        );
      }
      
      // If funding rates API succeeded but no price found, log it
      if (!markPrice && fundingRates.length > 0) {
        const marketRate = fundingRates.find(
          (r: any) => 
            r.market_id === marketIndex || 
            r.market_index === marketIndex ||
            r.marketIndex === marketIndex
        );
        if (marketRate) {
          lastError = `Funding rates API: Found market rate but no price field. Rate keys: ${Object.keys(marketRate).join(', ')}`;
          this.logger.warn(
            `Funding rates API returned data for ${symbol} but no price: ` +
            `${JSON.stringify(marketRate).substring(0, 300)}`
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
            const exponentialDelay = Math.min(explorerBaseDelay * Math.pow(2, attempt - 1), explorerMaxDelay);
            const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);
            const delay = Math.max(1000, exponentialDelay + jitter);
            
            this.logger.debug(
              `Retrying explorer API for ${symbol} after ${Math.floor(delay / 1000)}s ` +
              `(attempt ${attempt + 1}/${explorerMaxRetries})`
            );
            await new Promise(resolve => setTimeout(resolve, delay));
          }

          const explorerUrl = `https://explorer.elliot.ai/api/markets/${symbol}/logs`;
          const response = await axios.get(explorerUrl, {
            timeout: 10000,
            headers: { accept: 'application/json' },
          });

          // Try multiple response structures
          if (response.data) {
            // Structure 1: Direct price fields
            if (typeof response.data === 'object' && !Array.isArray(response.data)) {
              if (response.data.price && !isNaN(parseFloat(response.data.price))) {
                markPrice = parseFloat(response.data.price);
              } else if (response.data.markPrice && !isNaN(parseFloat(response.data.markPrice))) {
                markPrice = parseFloat(response.data.markPrice);
              } else if (response.data.lastPrice && !isNaN(parseFloat(response.data.lastPrice))) {
                markPrice = parseFloat(response.data.lastPrice);
              }
              // Structure 2: Nested data object
              else if (response.data.data) {
                if (response.data.data.price) markPrice = parseFloat(response.data.data.price);
                else if (response.data.data.markPrice) markPrice = parseFloat(response.data.data.markPrice);
                else if (response.data.data.lastPrice) markPrice = parseFloat(response.data.data.lastPrice);
              }
              // Structure 3: Array of logs (get latest)
              else if (Array.isArray(response.data) && response.data.length > 0) {
                const latest = response.data[0];
                if (latest.price) markPrice = parseFloat(latest.price);
                else if (latest.markPrice) markPrice = parseFloat(latest.markPrice);
                else if (latest.lastPrice) markPrice = parseFloat(latest.lastPrice);
                else if (latest.price_usd) markPrice = parseFloat(latest.price_usd);
              }
            }
            // Structure 4: Direct array
            else if (Array.isArray(response.data) && response.data.length > 0) {
              const latest = response.data[0];
              if (latest.price) markPrice = parseFloat(latest.price);
              else if (latest.markPrice) markPrice = parseFloat(latest.markPrice);
              else if (latest.lastPrice) markPrice = parseFloat(latest.lastPrice);
            }

            if (markPrice && markPrice > 0) {
              this.priceCache.set(symbol, { price: markPrice, timestamp: Date.now() });
              return markPrice;
            }
          }
        } catch (explorerError: any) {
          const errorMsg = explorerError?.message || explorerError?.toString() || String(explorerError);
          const errorResponse = explorerError?.response?.data || explorerError?.response || explorerError?.data;
          lastError = `Explorer API (attempt ${attempt + 1}): ${errorMsg}`;
          if (attempt === 2) {
            this.logger.warn(
              `Explorer API method failed for ${symbol} after 3 attempts: ${errorMsg}\n` +
              `Error response: ${errorResponse ? JSON.stringify(errorResponse).substring(0, 400) : 'No error response'}`
            );
          }
        }
      }

      // Method 4: Try market data API as last resort
      let marketData: any = null;
      try {
        await this.ensureInitialized();
        const apiClient = new ApiClient({ host: this.config.baseUrl });
        marketData = await (apiClient as any).market?.getMarketData({ marketIndex });
        if (marketData?.markPrice && !isNaN(parseFloat(marketData.markPrice))) {
          markPrice = parseFloat(marketData.markPrice);
        } else if (marketData?.price && !isNaN(parseFloat(marketData.price))) {
          markPrice = parseFloat(marketData.price);
        }
        
        if (markPrice && markPrice > 0) {
          this.priceCache.set(symbol, { price: markPrice, timestamp: Date.now() });
          return markPrice;
        }
      } catch (marketDataError: any) {
        const errorMsg = marketDataError?.message || marketDataError?.toString() || String(marketDataError);
        const errorResponse = marketDataError?.response?.data || marketDataError?.response || marketDataError?.data;
        lastError = `Market data API: ${errorMsg}`;
        this.logger.warn(
          `Market data API method failed for ${symbol}: ${errorMsg}\n` +
          `Error response: ${JSON.stringify(errorResponse).substring(0, 400)}`
        );
      }
      
      // If market data API succeeded but no price found, log it
      if (!markPrice && marketData) {
        lastError = `Market data API: Response received but no price field. Keys: ${Object.keys(marketData).join(', ')}`;
        this.logger.warn(
          `Market data API returned data for ${symbol} but no price: ` +
          `${JSON.stringify(marketData).substring(0, 300)}`
        );
      }
      
      // All methods failed - log detailed error information
      const errorMsg = `Unable to determine mark price for ${symbol} (marketIndex: ${marketIndex}). ` +
        `Tried: order book, funding rates API, explorer API (3 attempts), market data API. ` +
        `Last error: ${lastError || 'All methods returned no data (no exceptions thrown)'}`;
      this.logger.error(
        `❌ All price fetching methods failed for ${symbol}: ${errorMsg}\n` +
        `   Market Index: ${marketIndex}\n` +
        `   Base URL: ${this.config.baseUrl}\n` +
        `   Order API initialized: ${!!this.orderApi}\n` +
        `   Last error details: ${lastError}`
      );
      throw new Error(errorMsg);
    } catch (error: any) {
      this.logger.error(`Failed to get mark price for ${symbol}: ${error.message}`);
      throw new ExchangeError(
        `Failed to get mark price: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }

  async getBalance(): Promise<number> {
    const accountIndex = this.config.accountIndex!;
    
    // Retry logic for rate limiting (429 errors) with improved exponential backoff
    const maxRetries = 6; // Increased from 3 to 6
    const baseDelay = 2000; // 2 seconds base delay
    const maxDelay = 60000; // 60 seconds max delay
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff with jitter: 2s, 4s, 8s, 16s, 32s, 60s (capped)
          const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
          // Add jitter (±20%) to avoid thundering herd problem
          const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1); // Random between -20% and +20%
          const delay = Math.max(1000, exponentialDelay + jitter); // Minimum 1 second
          
          this.logger.debug(
            `Retrying Lighter balance query after ${Math.floor(delay / 1000)}s ` +
            `(attempt ${attempt + 1}/${maxRetries}, exponential: ${Math.floor(exponentialDelay / 1000)}s)`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        // Use AccountApi from SDK - it works and returns the correct structure
        // Based on official docs: https://apidocs.lighter.xyz/reference/account-1
        // The response is wrapped in { code: 200, accounts: [...] }
        const apiClient = new ApiClient({ host: this.config.baseUrl });
        const { AccountApi } = await import('@reservoir0x/lighter-ts-sdk');
        const accountApi = new AccountApi(apiClient);
        
        // Call getAccount with proper parameters
        const response = await (accountApi.getAccount as any)({ 
          by: 'index', 
          value: String(accountIndex) 
        });

        // Response structure from actual API call:
        // { code: 200, total: 1, accounts: [{ collateral, available_balance, status, ... }] }
        if (response && response.code === 200 && response.accounts && response.accounts.length > 0) {
          const account = response.accounts[0];
          // Use available_balance or collateral (they should be the same)
          const balance = parseFloat(account.available_balance || account.collateral || '0');
          const status = account.status === 1 ? 'active' : 'inactive';
          this.logger.debug(`Lighter balance retrieved: $${balance.toFixed(2)} (Status: ${status}, Index: ${account.index})`);
          return balance;
        }

        // Fallback: try direct REST API call if SDK response structure is different
        try {
          const httpResponse = await axios.get(`${this.config.baseUrl}/api/v1/account`, {
            params: {
              by: 'index',
              value: String(accountIndex),
            },
            timeout: 10000,
          });

          if (httpResponse.data && httpResponse.data.collateral !== undefined) {
            const balance = parseFloat(httpResponse.data.collateral || '0');
            this.logger.debug(`Lighter balance retrieved (REST fallback): $${balance.toFixed(2)}`);
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

        this.logger.warn('Lighter account API returned data but no balance found');
        return 0;
      } catch (error: any) {
        const statusCode = error?.response?.status;
        const errorMsg = error?.message || String(error);
        
        // If it's a 429 (rate limit), retry with improved backoff
        if (statusCode === 429 && attempt < maxRetries - 1) {
          this.logger.warn(
            `Lighter balance query rate limited (attempt ${attempt + 1}/${maxRetries}): ${errorMsg}. ` +
            `Will retry with exponential backoff.`
          );
          continue; // Retry
        }
        
        // For other errors or final attempt
        this.logger.error(`Failed to get balance: ${errorMsg}`);
        if (error.response) {
          this.logger.debug(`Lighter API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        }
        
        // If not a retryable error, break
        if (statusCode !== 429) {
          break;
        }
      }
    }
    
    // If all retries failed, return 0 instead of throwing to allow system to continue
    this.logger.warn('Returning 0 balance due to error - Lighter balance query may need authentication');
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
        `No internal transfer needed. Amount: $${amount.toFixed(2)}`
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

  async depositExternal(amount: number, asset: string, destination?: string): Promise<string> {
    try {
      if (amount <= 0) {
        throw new Error('Deposit amount must be greater than 0');
      }

      this.logger.log(`Depositing $${amount.toFixed(2)} ${asset} to Lighter Gateway...`);

      // Lighter deposits are done via the Gateway contract on Ethereum mainnet
      // Process: 1) Approve gateway to spend tokens, 2) Call gateway.deposit(token, amount)
      
      // Get configuration
      const privateKey = this.configService.get<string>('PRIVATE_KEY');
      const ethereumRpcUrl = this.configService.get<string>('ETHEREUM_RPC_URL') || 
                             this.configService.get<string>('ETH_MAINNET_RPC_URL') ||
                             'https://eth.llamarpc.com'; // Public RPC fallback
      
      // Lighter Gateway Contract address on Ethereum mainnet
      // Default: 0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7
      // Can be overridden via LIGHTER_GATEWAY_CONTRACT env var
      const gatewayAddress = this.configService.get<string>('LIGHTER_GATEWAY_CONTRACT') || 
                             '0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7';
      
      if (!privateKey) {
        throw new Error('PRIVATE_KEY required for on-chain deposits. Provide PRIVATE_KEY in .env.');
      }

      // Map asset symbol to Ethereum mainnet token address
      const tokenAddresses: Record<string, string> = {
        'USDC': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on Ethereum mainnet (6 decimals)
        'USDT': '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT on Ethereum mainnet (6 decimals)
        'WETH': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH on Ethereum mainnet (18 decimals)
      };
      
      const tokenAddress = tokenAddresses[asset.toUpperCase()];
      if (!tokenAddress) {
        throw new Error(
          `Asset ${asset} not supported for Lighter deposits. ` +
          `Supported assets: ${Object.keys(tokenAddresses).join(', ')}`
        );
      }

      // Get token decimals (USDC/USDT = 6, WETH = 18)
      const decimals = asset.toUpperCase() === 'WETH' ? 18 : 6;
      const amountWei = ethers.parseUnits(amount.toFixed(decimals), decimals);

      // Initialize Ethereum provider and wallet
      const provider = new ethers.JsonRpcProvider(ethereumRpcUrl);
      const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      const wallet = new ethers.Wallet(normalizedKey, provider);
      const walletAddress = wallet.address;

      this.logger.debug(
        `Deposit details: wallet=${walletAddress}, token=${tokenAddress} (${asset}), ` +
        `amount=${amount} (${amountWei.toString()} wei), gateway=${gatewayAddress}`
      );

      // ERC20 ABI (minimal - just what we need)
      const erc20Abi = [
        'function balanceOf(address owner) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
        'function decimals() view returns (uint8)',
      ];

      // Gateway ABI (minimal - just deposit function)
      const gatewayAbi = [
        'function deposit(address token, uint256 amount) external',
        'function getBalance(address user, address token) external view returns (uint256)',
      ];

      // Create contract instances
      const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, wallet);
      const gatewayContract = new ethers.Contract(gatewayAddress, gatewayAbi, wallet);

      // Step 1: Check wallet balance
      const balance = await tokenContract.balanceOf(walletAddress);
      if (balance < amountWei) {
        throw new Error(
          `Insufficient balance. Wallet has ${ethers.formatUnits(balance, decimals)} ${asset}, ` +
          `but ${amount} ${asset} is required.`
        );
      }

      // Step 2: Check current allowance
      const currentAllowance = await tokenContract.allowance(walletAddress, gatewayAddress);
      this.logger.debug(`Current allowance: ${ethers.formatUnits(currentAllowance, decimals)} ${asset}`);

      // Step 3: Approve gateway if needed
      if (currentAllowance < amountWei) {
        this.logger.log(`Approving gateway to spend ${amount} ${asset}...`);
        const approveTx = await tokenContract.approve(gatewayAddress, amountWei);
        this.logger.debug(`Approval transaction: ${approveTx.hash}`);
        const approveReceipt = await approveTx.wait();
        this.logger.log(`✅ Approval confirmed in block ${approveReceipt.blockNumber}`);
      } else {
        this.logger.debug(`Sufficient allowance already exists (${ethers.formatUnits(currentAllowance, decimals)} ${asset})`);
      }

      // Step 4: Deposit to gateway
      this.logger.log(`Depositing ${amount} ${asset} to Lighter Gateway...`);
      const depositTx = await gatewayContract.deposit(tokenAddress, amountWei);
      this.logger.debug(`Deposit transaction: ${depositTx.hash}`);
      
      const depositReceipt = await depositTx.wait();
      this.logger.log(
        `✅ Deposit successful! TX: ${depositReceipt.hash}, Block: ${depositReceipt.blockNumber}`
      );

      // Step 5: Verify balance in gateway
      const gatewayBalance = await gatewayContract.getBalance(walletAddress, tokenAddress);
      this.logger.log(
        `Gateway balance after deposit: ${ethers.formatUnits(gatewayBalance, decimals)} ${asset}`
      );

      return depositReceipt.hash;
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

  async withdrawExternal(amount: number, asset: string, destination: string): Promise<string> {
    try {
      if (amount <= 0) {
        throw new Error('Withdrawal amount must be greater than 0');
      }

      if (!destination || !destination.match(/^0x[a-fA-F0-9]{40}$/)) {
        throw new Error('Invalid destination address. Must be a valid Ethereum address (0x followed by 40 hex characters)');
      }

      this.logger.log(`Withdrawing $${amount.toFixed(2)} ${asset} to ${destination} on Lighter...`);

      // Lighter withdrawals are done via the Gateway contract on Ethereum mainnet
      // Check if there's an API endpoint or SDK method first
      try {
        await this.ensureInitialized();
        const apiClient = new ApiClient({ host: this.config.baseUrl });
        const { AccountApi } = await import('@reservoir0x/lighter-ts-sdk');
        const accountApi = new AccountApi(apiClient);

        // Check if AccountApi has a withdraw method
        if (typeof (accountApi as any).withdraw === 'function') {
          const result = await (accountApi as any).withdraw({
            amount: amount.toString(),
            asset: asset,
            destination: destination,
          });

          if (result && result.code === 200) {
            const txHash = result.txHash || result.id || `lighter-withdraw-${Date.now()}`;
            this.logger.log(`✅ Withdrawal initiated - TX: ${txHash}`);
            return txHash;
          } else {
            throw new Error(`Withdrawal failed: ${JSON.stringify(result)}`);
          }
        }
      } catch (sdkError: any) {
        // SDK doesn't support withdrawals, fall through to Gateway contract message
        this.logger.debug(`SDK withdraw method not available: ${sdkError.message}`);
      }

      // Try direct API call to withdrawal endpoint (if it exists)
      try {
        const response = await axios.post(
          `${this.config.baseUrl}/api/v1/withdraw`,
          {
            amount: amount.toString(),
            asset: asset,
            destination: destination,
          },
          {
            timeout: 30000,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );

        if (response.data && response.data.code === 200) {
          const txHash = response.data.txHash || response.data.id || `lighter-withdraw-${Date.now()}`;
          this.logger.log(`✅ Withdrawal successful - TX: ${txHash}`);
          return txHash;
        } else {
          throw new Error(`Withdrawal failed: ${JSON.stringify(response.data)}`);
        }
      } catch (apiError: any) {
        // If API call fails, provide helpful error message
        throw new Error(
          'External withdrawals from Lighter must be done by interacting with the Lighter Gateway contract on Ethereum mainnet. ' +
          'This adapter does not support on-chain transactions. Please use a wallet or the Gateway contract directly. ' +
          `Error: ${apiError.message}. Gateway contract address can be found in Lighter documentation.`
        );
      }
    } catch (error: any) {
      if (error instanceof ExchangeError) {
        throw error;
      }
      this.logger.error(`Failed to withdraw ${asset} to ${destination}: ${error.message}`);
      throw new ExchangeError(
        `Failed to withdraw: ${error.message}`,
        ExchangeType.LIGHTER,
        undefined,
        error,
      );
    }
  }
}

