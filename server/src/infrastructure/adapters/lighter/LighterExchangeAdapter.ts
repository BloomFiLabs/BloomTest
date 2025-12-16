import { Injectable, Logger, Optional } from '@nestjs/common';
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
import { IPerpExchangeAdapter, ExchangeError, FundingPayment } from '../../../domain/ports/IPerpExchangeAdapter';
import { DiagnosticsService } from '../../services/DiagnosticsService';

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
  
  // Mutex for order placement to prevent concurrent nonce conflicts
  // Lighter uses sequential nonces - concurrent orders cause "invalid nonce" errors
  private orderMutex: Promise<void> = Promise.resolve();
  private orderMutexRelease: (() => void) | null = null;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
  ) {
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

    // Removed adapter initialization log - only execution logs shown
  }

  /**
   * Record an error to diagnostics service
   */
  private recordError(type: string, message: string, symbol?: string, context?: Record<string, any>): void {
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

  /**
   * Acquire the order mutex to prevent concurrent order placements
   * Lighter uses sequential nonces - concurrent orders cause "invalid nonce" errors
   * Returns a release function that MUST be called when done
   */
  private async acquireOrderMutex(): Promise<() => void> {
    // Wait for any pending order to complete
    await this.orderMutex;
    
    // Create a new promise that will be resolved when we release
    let release: () => void;
    this.orderMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    
    return release!;
  }

  /**
   * Reset the SignerClient to force re-initialization
   * This is useful when nonce gets out of sync with the server
   */
  private async resetSignerClient(): Promise<void> {
    this.logger.warn('🔄 Resetting Lighter SignerClient to re-sync nonce...');
    
    // Close existing client if it has a close method
    if (this.signerClient && typeof (this.signerClient as any).close === 'function') {
      try {
        await (this.signerClient as any).close();
      } catch (e) {
        // Ignore close errors
      }
    }
    
    // Clear the client to force re-initialization
    this.signerClient = null;
    
    // Re-initialize
    await this.ensureInitialized();
    
    this.logger.log('✅ Lighter SignerClient reset complete');
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
            // Silenced 429/rate limit warnings - only show errors
            this.logger.debug(
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
      // Removed cache log - only execution logs shown
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
    this.logger.log(
      `📤 Placing ${request.side} order on Lighter: ${request.size} ${request.symbol} ` +
      `@ ${request.price || 'market'} (type: ${request.type}, reduceOnly: ${request.reduceOnly})`
    );
    
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
   * Internal order placement logic - must only be called while holding the order mutex
   */
  private async placeOrderInternal(request: PerpOrderRequest): Promise<PerpOrderResponse> {
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
          const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
          const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);
          const delay = Math.max(1000, exponentialDelay + jitter);
          
          this.logger.warn(
            `Retrying order placement for ${request.symbol} after ${Math.floor(delay / 1000)}s ` +
            `(attempt ${attempt + 1}/${maxRetries})`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        this.logger.debug(`Initializing Lighter adapter for order placement (attempt ${attempt + 1})...`);
        await this.ensureInitialized();

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
            
            // Get current mark price for avgExecutionPrice
            let avgExecutionPrice: number;
            try {
              const markPrice = await this.getMarkPrice(request.symbol);
              avgExecutionPrice = markPrice;
            } catch (priceError: any) {
              // Fallback: try to get from order book
              try {
                const orderBook = await this.orderApi!.getOrderBookDetails({ marketIndex: marketIndex } as any) as any;
                avgExecutionPrice = isBuy 
                  ? parseFloat(orderBook.bestAsk?.price || '0')
                  : parseFloat(orderBook.bestBid?.price || '0');
              } catch (obError: any) {
                throw new Error(`Failed to get price for closing position: ${priceError.message}`);
              }
            }
            
            // Progressive price improvement for closing orders: worse prices on retries
            const priceImprovements = [0, 0.001, 0.005, 0.01, 0.02, 0.05];
            const priceImprovement = priceImprovements[Math.min(attempt, priceImprovements.length - 1)];
            
            // Apply price improvement (worse price = better chance to fill)
            // For BUY (closing SHORT): worse = higher price
            // For SELL (closing LONG): worse = lower price
            const adjustedPrice = isBuy
              ? avgExecutionPrice * (1 + priceImprovement)
              : avgExecutionPrice * (1 - priceImprovement);
            
            if (attempt > 0) {
              this.logger.warn(
                `🔄 Closing position retry ${attempt + 1}/${maxRetries} for ${request.symbol}: ` +
                `Using ${(priceImprovement * 100).toFixed(2)}% worse price (${adjustedPrice.toFixed(6)} vs ${avgExecutionPrice.toFixed(6)})`
              );
            }
            
            // Use createMarketOrder for closing positions (per Lighter docs)
            const [tx, hash, error] = await this.signerClient!.createMarketOrder({
              marketIndex,
              clientOrderIndex: Date.now(),
              baseAmount,
              avgExecutionPrice: market.priceToUnits(adjustedPrice),
              isAsk,
              reduceOnly: true,
            });
            
            if (error) {
              throw new Error(`Failed to close position: ${error}`);
            }
            
            // Wait for transaction
            try {
              await this.signerClient!.waitForTransaction(hash, 30000, 2000);
            } catch (waitError: any) {
              this.logger.warn(`Transaction wait failed: ${waitError.message}`);
            }
            
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
            // Get current market price
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
            
            // Progressive price improvement for market orders: worse prices on retries
            const priceImprovements = [0, 0.001, 0.005, 0.01, 0.02, 0.05];
            const priceImprovement = priceImprovements[Math.min(attempt, priceImprovements.length - 1)];
            
            let idealPrice = isBuy 
              ? parseFloat(orderBook.bestAsk?.price || '0')
              : parseFloat(orderBook.bestBid?.price || '0');
            
            // Apply price improvement (worse price = better chance to fill)
            idealPrice = isBuy
              ? idealPrice * (1 + priceImprovement)
              : idealPrice * (1 - priceImprovement);
            
            if (attempt > 0) {
              this.logger.warn(
                `🔄 Market order retry ${attempt + 1}/${maxRetries} for ${request.symbol}: ` +
                `Using ${(priceImprovement * 100).toFixed(2)}% worse price`
              );
            }
            
            // Use createUnifiedOrder with MARKET order type (per Lighter docs)
            // For opening market orders: orderExpiry = 0 (consistent with limit orders)
            orderParams = {
              marketIndex,
              clientOrderIndex: Date.now(),
              baseAmount,
              isAsk,
              orderType: LighterOrderType.MARKET,
              idealPrice: market.priceToUnits(idealPrice),
              maxSlippage: 0.01, // 1% max slippage
              orderExpiry: 0, // 0 for opening orders (consistent with limit orders)
            };
          }
        } else {
          // Limit order
          if (!request.price) {
            throw new Error('Limit price is required for LIMIT orders');
          }

          // LIMIT orders always use GTC (Good Till Cancel/Time) - they can sit on the order book
          // Only MARKET orders use IOC (Immediate Or Cancel) for immediate execution
          // Note: We ignore request.timeInForce for LIMIT orders and always use GTC
          // Lighter API mapping: 0 = IOC, 1 = GTC/GTT (Good Till Time)
          const timeInForce = 1; // Always GTC/GTT (1) for LIMIT orders, regardless of request.timeInForce
          const expiredAt = Date.now() + 3600000; // 1 hour expiry for GTC orders
          
          this.logger.debug(
            `LIMIT order for ${request.symbol}: Using GTC/GTT (timeInForce=1) ` +
            `(request.timeInForce was ${request.timeInForce === TimeInForce.IOC ? 'IOC' : request.timeInForce === TimeInForce.GTC ? 'GTC' : 'undefined'}, but LIMIT orders always use GTC)`
          );

          // orderExpiry: For GTC orders (timeInForce = 1), orderExpiry cannot be 0
          // SDK code shows: wasmOrderExpiry = (timeInForce === IOC) ? 0 : orderExpiry
          // This means for GTC orders, orderExpiry must be a valid timestamp >= expiredAt
          // Use expiredAt + 2 minutes for GTC orders (short expiry for trading bot)
          const orderExpiry = expiredAt + (2 * 60 * 1000); // 2 minutes from expiredAt
          
          orderParams = {
            marketIndex,
            clientOrderIndex: Date.now(),
            baseAmount,
            price: market.priceToUnits(request.price),
            isAsk,
            orderType: LighterOrderType.LIMIT,
            timeInForce, // 0 = IOC, 1 = GTC/GTT (Good Till Time)
            reduceOnly: request.reduceOnly ? 1 : 0, // Critical: must be 1 for closing orders
            orderExpiry, // For GTC orders: expiredAt + 2 minutes (orderExpiry cannot be 0 for GTC)
            expiredAt,
          };
        }

        // Log timeInForce value to verify LIMIT orders use GTC
        if (request.type === OrderType.LIMIT) {
          this.logger.log(
            `📋 LIMIT order for ${request.symbol}: timeInForce=${orderParams.timeInForce} ` +
            `(${orderParams.timeInForce === 1 ? 'GTC/GTT' : 'IOC'}) - ` +
            `request.timeInForce was ${request.timeInForce === TimeInForce.IOC ? 'IOC' : request.timeInForce === TimeInForce.GTC ? 'GTC' : 'undefined'}`
          );
        }
        
        this.logger.debug(`Creating unified order with params: ${JSON.stringify({
          marketIndex: orderParams.marketIndex,
          clientOrderIndex: orderParams.clientOrderIndex,
          baseAmount: orderParams.baseAmount.toString(),
          price: orderParams.price?.toString() || orderParams.idealPrice?.toString() || 'N/A',
          idealPrice: orderParams.idealPrice?.toString(),
          maxSlippage: orderParams.maxSlippage,
          isAsk: orderParams.isAsk,
          orderType: orderParams.orderType,
          timeInForce: orderParams.timeInForce,
          reduceOnly: orderParams.reduceOnly,
        })}`);
        
        const result = await this.signerClient!.createUnifiedOrder(orderParams);

        if (!result.success) {
          const errorMsg = result.mainOrder.error || 'Order creation failed';
          this.logger.error(`❌ Lighter order creation failed: ${errorMsg}`);
          this.logger.error(`Order params: ${JSON.stringify(orderParams)}`);
          this.recordError('LIGHTER_ORDER_CREATION_FAILED', errorMsg, request.symbol, { orderParams });
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
          this.recordError('LIGHTER_TX_WAIT_FAILED', error.message, request.symbol, { orderId });
        }

        // CRITICAL: Wait a short time and check if order was immediately filled or canceled
        // Lighter may cancel orders immediately if they don't meet certain conditions
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second wait
        
        // Check positions to see if order filled immediately
        try {
          const positions = await this.getPositions();
          const matchingPosition = positions.find(
            p => p.symbol === request.symbol && 
                 p.side === request.side &&
                 Math.abs(p.size) > 0.0001
          );
          
          if (matchingPosition) {
            // Order filled immediately - check if size matches
            const expectedSize = request.size;
            const actualSize = matchingPosition.size;
            const sizeMatch = Math.abs(actualSize - expectedSize) < 0.0001;
            
            if (sizeMatch || actualSize >= expectedSize * 0.9) { // Allow 10% tolerance
              this.logger.log(
                `✅ Lighter order ${orderId} filled immediately: ${actualSize.toFixed(4)} ${request.symbol}`
              );
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
          this.logger.debug(`Could not check positions immediately after order placement: ${positionError.message}`);
        }

        // Order is resting on the book (or may have been canceled - will be checked in waitForOrderFill)
        // Mark as SUBMITTED - caller should verify via waitForOrderFill
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
          `❌ Lighter order placement failed (attempt ${attempt + 1}/${maxRetries}): ${errorMsg}`
        );
        if (errorStack) {
          this.logger.debug(`Error stack: ${errorStack}`);
        }
        if (error?.response) {
          this.logger.debug(`Error response: ${JSON.stringify(error.response.data)}`);
        }
        
        const isRateLimit = errorMsg.includes('Too Many Requests') || 
                           errorMsg.includes('429') ||
                           errorMsg.includes('rate limit') ||
                           errorMsg.includes('market config');
        const isMarginModeError = errorMsg.includes('invalid margin mode') || 
                                 errorMsg.includes('margin mode');
        const isNonceError = errorMsg.toLowerCase().includes('invalid nonce') ||
                            errorMsg.toLowerCase().includes('nonce');
        
        if (isRateLimit && attempt < maxRetries - 1) {
          // Silenced 429/rate limit warnings - only show errors
          this.logger.debug(
            `Order placement rate limited for ${request.symbol} ` +
            `(attempt ${attempt + 1}/${maxRetries}): ${errorMsg}. Will retry.`
          );
          continue;
        }
        
        // Nonce errors - reset client and retry
        if (isNonceError && attempt < maxRetries - 1) {
          this.logger.warn(
            `⚠️ Lighter nonce error for ${request.symbol}: ${errorMsg}. ` +
            `Re-syncing nonce and retrying (attempt ${attempt + 1}/${maxRetries})...`
          );
          this.recordError('LIGHTER_NONCE_ERROR', errorMsg, request.symbol, { attempt: attempt + 1 });
          
          // Reset the SignerClient to get a fresh nonce from the server
          await this.resetSignerClient();
          
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        
        // Margin mode errors are not retryable - account configuration issue
        if (isMarginModeError) {
          this.logger.error(
            `❌ Lighter margin mode error for ${request.symbol}: ${errorMsg}. ` +
            `This indicates the account may need margin mode configured. ` +
            `Please check your Lighter account settings or contact support.`
          );
          this.recordError('LIGHTER_MARGIN_MODE_ERROR', errorMsg, request.symbol);
          throw new ExchangeError(
            `Invalid margin mode: Account may need margin mode configured. ${errorMsg}`,
            ExchangeType.LIGHTER,
            undefined,
            error,
          );
        }
        
        // Not retryable or max retries reached
        this.logger.error(`Failed to place order: ${errorMsg}`);
        this.recordError('LIGHTER_ORDER_FAILED', errorMsg, request.symbol, { attempt: attempt + 1, maxRetries });
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
          `❌ Lighter order placement failed after ${maxRetries} attempts: ${finalErrorMsg}`
        );
        if (lastError?.stack) {
          this.logger.error(`Final error stack: ${lastError.stack}`);
        }
        this.recordError('LIGHTER_ORDER_MAX_RETRIES', finalErrorMsg, request.symbol, { maxRetries });
        
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
            `entryPrice=${entryPrice}, markPrice=${markPrice}, pnl=${unrealizedPnl}, marketIndex=${marketIndex}`
          );
          
          positions.push(position);
        } catch (error: any) {
          this.logger.warn(`Failed to parse position data: ${error.message}. Data: ${JSON.stringify(posData).substring(0, 200)}`);
          continue;
        }
      }

      this.logger.debug(`✅ Lighter getPositions() returning ${positions.length} positions: ${positions.map(p => `${p.symbol}(${p.side})`).join(', ')}`);
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

  /**
   * Get all open orders for this account
   * Uses Lighter API: /api/v1/accountActiveOrders (requires auth token)
   * 
   * Returns orders with: orderId, symbol, side, price, size, filledSize, timestamp
   * Used for deduplication checks to prevent placing multiple orders for single-leg hedging
   */
  async getOpenOrders(): Promise<import('../../../domain/ports/IPerpExchangeAdapter').OpenOrder[]> {
    try {
      await this.ensureInitialized();
      
      this.logger.debug('🔍 Fetching open orders from Lighter...');
      
      // Create auth token for authenticated endpoint
      const authToken = await this.signerClient!.createAuthTokenWithExpiry(600); // 10 minutes
      
      // Note: accountActiveOrders requires market_id, so we need to query each market
      // For now, query all markets we care about (0-100) or use a different endpoint
      // Actually, let's try the account endpoint which includes open_order_count per position
      const accountResponse = await axios.get(`${this.config.baseUrl}/api/v1/account`, {
        params: {
          by: 'index',
          value: String(this.config.accountIndex),
        },
        timeout: 10000,
        headers: { accept: 'application/json' },
      });

      if (!accountResponse.data || accountResponse.data.code !== 200) {
        this.logger.debug(`Lighter account API returned: ${JSON.stringify(accountResponse.data).substring(0, 200)}`);
        return [];
      }

      // Find markets with open orders from account data
      const positions = accountResponse.data.accounts?.[0]?.positions || [];
      const marketsWithOrders = positions
        .filter((p: any) => (p.open_order_count || 0) > 0 || (p.pending_order_count || 0) > 0)
        .map((p: any) => p.market_id);

      if (marketsWithOrders.length === 0) {
        this.logger.debug('🔍 No markets with open orders found in account data');
        return [];
      }

      this.logger.log(`🔍 Found ${marketsWithOrders.length} market(s) with open orders: ${marketsWithOrders.join(', ')}`);

      // Query each market with open orders
      const allOrders: import('../../../domain/ports/IPerpExchangeAdapter').OpenOrder[] = [];
      
      for (const marketId of marketsWithOrders) {
        try {
          const response = await axios.get(`${this.config.baseUrl}/api/v1/accountActiveOrders`, {
            params: {
              auth: authToken,
              market_id: marketId,
              account_index: this.config.accountIndex,  // Required parameter!
            },
            timeout: 10000,
            headers: { accept: 'application/json' },
          });

          if (!response.data || response.data.code !== 200) {
            this.logger.debug(`Lighter accountActiveOrders for market ${marketId} returned: ${JSON.stringify(response.data).substring(0, 200)}`);
            continue;
          }

          const ordersData = response.data.orders || [];
          this.logger.debug(`🔍 Market ${marketId}: Found ${ordersData.length} order(s)`);
          
          for (const orderData of ordersData) {
            try {
              // API returns: order_id, initial_base_amount, remaining_base_amount, price, is_ask, filled_base_amount
              const orderId = String(orderData.order_id || orderData.order_index || '');
              const symbol = await this.getSymbolFromMarketIndex(marketId);
              if (!symbol || !orderId) continue;

              // is_ask: false = buy/long, true = sell/short
              const side: 'buy' | 'sell' = orderData.is_ask ? 'sell' : 'buy';

              const price = parseFloat(String(orderData.price || '0'));
              // Use remaining_base_amount for current size
              const size = Math.abs(parseFloat(String(orderData.remaining_base_amount || orderData.initial_base_amount || '0')));
              const initialSize = Math.abs(parseFloat(String(orderData.initial_base_amount || '0')));
              const filledSize = Math.abs(parseFloat(String(orderData.filled_base_amount || '0')));

              // Parse timestamp from nonce or created_time
              let timestamp = new Date();
              if (orderData.created_time) {
                timestamp = new Date(orderData.created_time < 1e12 ? orderData.created_time * 1000 : orderData.created_time);
              } else if (orderData.nonce) {
                // Nonce includes timestamp in high bits - extract rough timestamp
                // This is a fallback; actual created_time should be preferred
                const nonceTimestamp = Math.floor(orderData.nonce / (2 ** 32));
                if (nonceTimestamp > 0 && nonceTimestamp < 2e9) {
                  timestamp = new Date(nonceTimestamp * 1000);
                }
              }

              allOrders.push({ orderId, symbol, side, price, size, filledSize, timestamp });
              this.logger.debug(`  Order: ${orderId} ${side} ${size} ${symbol} @ ${price}`);
            } catch (e: any) {
              this.logger.debug(`Failed to parse order: ${e.message}`);
            }
          }
        } catch (marketError: any) {
          this.logger.debug(`Failed to get orders for market ${marketId}: ${marketError.message}`);
        }
      }

      if (allOrders.length > 0) {
        this.logger.log(`🔍 Total open orders on Lighter: ${allOrders.length} - ${allOrders.map(o => `${o.symbol} ${o.side} ${o.size}@${o.price}`).join(', ')}`);
      }
      return allOrders;
    } catch (error: any) {
      this.logger.warn(`⚠️ Failed to get open orders from Lighter: ${error.message}`);
      return [];
    }
  }

  async getOrderStatus(orderId: string, symbol?: string): Promise<PerpOrderResponse> {
    try {
      await this.ensureInitialized();
      
      // Lighter SDK limitation: The @reservoir0x/lighter-ts-sdk doesn't provide a method to query order status
      // by order ID. We work around this by checking positions to see if the order filled.
      // If no matching position exists, the order may be resting on the book or canceled.
      
      if (!symbol) {
        this.logger.warn('getOrderStatus: Symbol required for Lighter order status check');
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
          p => p.symbol === symbol && Math.abs(p.size) > 0.0001
        );
        
        if (matchingPosition) {
          // Position exists - order may have filled (but we can't be 100% sure it's this specific order)
          // Return SUBMITTED to let waitForOrderFill continue checking
          this.logger.debug(
            `getOrderStatus: Found position for ${symbol} (${matchingPosition.side}, size: ${matchingPosition.size}), ` +
            `but cannot confirm if order ${orderId} filled. Returning SUBMITTED.`
          );
        } else {
          // No position found - order may be resting on book or canceled
          // We can't distinguish between these cases without querying open orders
          this.logger.debug(
            `getOrderStatus: No position found for ${symbol}. Order ${orderId} may be resting or canceled.`
          );
        }
      } catch (positionError: any) {
        this.logger.debug(`Could not check positions for order status: ${positionError.message}`);
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
            // Silenced 429 warnings - only show errors
            this.logger.debug(
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
          // Silenced 429 warnings - only show errors
          this.logger.debug(
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
        this.logger.debug(`Lighter fast withdraw pool availability: $${availableUsdc.toFixed(2)} USDC`);
        return availableUsdc;
      }
      
      return null;
    } catch (error: any) {
      this.logger.warn(`Failed to check fast withdraw pool availability: ${error.message}`);
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
    maxRetries: number = 3
  ): Promise<{ to_account_index: number; withdraw_limit?: number }> {
    let lastError: any;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.get(
          `${this.config.baseUrl}/api/v1/fastwithdraw/info`,
          {
            params: { 
              account_index: this.config.accountIndex,
              auth: authToken
            },
            timeout: 30000,
          }
        );

        if (response.data.code !== 200) {
          throw new Error(`Pool info failed: ${response.data.message || 'Unknown error'}`);
        }

        return {
          to_account_index: response.data.to_account_index,
          withdraw_limit: response.data.withdraw_limit,
        };
      } catch (error: any) {
        lastError = error;
        this.logger.debug(`Fast withdraw info attempt ${attempt}/${maxRetries} failed: ${error.message}`);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000));
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
    authToken: string
  ): Promise<number> {
    const response = await axios.get(
      `${this.config.baseUrl}/api/v1/transferFeeInfo`,
      {
        params: {
          account_index: this.config.accountIndex,
          to_account_index: toAccountIndex,
          auth: authToken,
        },
        timeout: 10000,
      }
    );

    if (response.data.code !== 200) {
      throw new Error(`Transfer fee failed: ${response.data.message || 'Unknown error'}`);
    }

    // transfer_fee_usdc is in micro-USDC (1e6)
    return response.data.transfer_fee_usdc;
  }

  /**
   * Get next nonce for Lighter transactions
   */
  private async getFastWithdrawNonce(): Promise<{ apiKeyIndex: number; nonce: number }> {
    const response = await axios.get(`${this.config.baseUrl}/api/v1/nextNonce`, {
      params: { 
        account_index: this.config.accountIndex, 
        api_key_index: this.config.apiKeyIndex 
      },
      timeout: 10000,
    });

    if (response.data && typeof response.data === 'object') {
      if (response.data.nonce !== undefined && response.data.api_key_index !== undefined) {
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

    throw new Error(`Unexpected nonce format: ${JSON.stringify(response.data)}`);
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

      // Only USDC is supported for deposits
      if (asset.toUpperCase() !== 'USDC') {
        throw new Error(`Only USDC deposits are supported. Received: ${asset}`);
      }

      this.logger.log(`Depositing $${amount.toFixed(2)} ${asset} to Lighter...`);

      // Lighter deposit contract on Arbitrum
      // User confirmed: transfer to 0xB512443BB7737E90401DEF0BCF442aB5454A94f8
      const LIGHTER_DEPOSIT_CONTRACT = '0xB512443BB7737E90401DEF0BCF442aB5454A94f8';
      const USDC_CONTRACT_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // USDC on Arbitrum
      
      // Get Arbitrum RPC URL
      const arbitrumRpcUrl = this.configService.get<string>('ARBITRUM_RPC_URL') ||
                             this.configService.get<string>('ARB_RPC_URL') ||
                             'https://arb1.arbitrum.io/rpc'; // Public RPC fallback
      
      // Get private key for signing transactions
      const privateKey = this.configService.get<string>('PRIVATE_KEY') || 
                        this.configService.get<string>('LIGHTER_PRIVATE_KEY');
      if (!privateKey) {
        throw new Error('PRIVATE_KEY or LIGHTER_PRIVATE_KEY required for on-chain deposits');
      }

      const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      const provider = new ethers.JsonRpcProvider(arbitrumRpcUrl);
      const wallet = new ethers.Wallet(normalizedPrivateKey, provider);

      this.logger.debug(
        `Lighter deposit details:\n` +
        `  Deposit contract: ${LIGHTER_DEPOSIT_CONTRACT}\n` +
        `  USDC contract: ${USDC_CONTRACT_ADDRESS}\n` +
        `  Amount: ${amount} USDC\n` +
        `  Wallet: ${wallet.address}\n` +
        `  RPC: ${arbitrumRpcUrl}`
      );

      // ERC20 ABI for USDC (approve, transfer, allowance, balanceOf, decimals)
      const erc20Abi = [
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function transfer(address to, uint256 amount) external returns (bool)',
        'function allowance(address owner, address spender) external view returns (uint256)',
        'function balanceOf(address account) external view returns (uint256)',
        'function decimals() external view returns (uint8)',
      ];

      const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, erc20Abi, wallet);

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
          `(requested: ${amount.toFixed(2)} USDC)`
        );

        const elapsed = Date.now() - startTime;
        
        // Tolerance for withdrawal fees: accept balance within 5% or $0.50 of requested amount
        const tolerance = Math.max(amount * 0.05, 0.50);
        const minAcceptableAmount = amount - tolerance;
        
        // After 2 minutes, accept balance if it's at least 80% of requested (handles withdrawal fees)
        const acceptPartialAfter = 120000; // 2 minutes
        const minPartialAmount = amount * 0.80;
        
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
        if (elapsed >= acceptPartialAfter && balanceFormatted >= minPartialAmount && balanceFormatted > 0) {
          this.logger.log(
            `✅ Accepting partial balance after ${Math.floor(elapsed / 1000)}s wait. ` +
            `Available: ${balanceFormatted.toFixed(2)} USDC (requested: ${amount.toFixed(2)} USDC). ` +
            `Withdrawal fees may have reduced the amount.`
          );
          break;
        }
        
        // Timeout after max wait time
        if (elapsed >= maxWaitTime) {
          if (balanceFormatted > 0) {
            // If we have some balance, use it instead of failing
            this.logger.warn(
              `⚠️ Timeout reached but accepting available balance: ${balanceFormatted.toFixed(2)} USDC ` +
              `(requested: ${amount.toFixed(2)} USDC). Withdrawal fees may have reduced the amount.`
            );
            break;
          }
          throw new Error(
            `Insufficient USDC balance after ${Math.floor(elapsed / 1000)}s wait. ` +
            `Required: ${amount.toFixed(2)} USDC, Available: ${balanceFormatted.toFixed(2)} USDC. ` +
            `Funds may still be in transit from withdrawal. Check withdrawal status.`
          );
        }

        // Exponential backoff: 2s, 4s, 8s, 16s, capped at 30s
        const delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
        const remaining = maxWaitTime - elapsed;
        const waitTime = Math.min(delay, remaining);
        
        this.logger.warn(
          `Waiting for funds to arrive. ` +
          `Current: ${balanceFormatted.toFixed(2)} USDC, Required: ${amount.toFixed(2)} USDC. ` +
          `Waiting ${waitTime / 1000}s (attempt ${attempt}, ${Math.floor(elapsed / 1000)}s elapsed)...`
        );
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      this.logger.log(
        `✅ Funds confirmed (${balanceFormatted.toFixed(2)} USDC). ` +
        `Proceeding with deposit to Lighter contract ${LIGHTER_DEPOSIT_CONTRACT}...`
      );

      // Determine deposit amount:
      // - If balance is significantly larger than requested amount (3x+), deposit only requested amount
      //   (this indicates a wallet deposit, not a rebalance from withdrawal)
      // - Otherwise, deposit full balance (this handles rebalancing where withdrawal fees reduce the amount)
      const isWalletDeposit = balanceFormatted >= amount * 3;
      const depositAmount = isWalletDeposit ? amount : balanceFormatted;
      const depositAmountWei = isWalletDeposit 
        ? ethers.parseUnits(depositAmount.toFixed(decimals), decimals)
        : balanceWei;

      // Check current allowance
      this.logger.log(`Checking allowance for Lighter deposit contract ${LIGHTER_DEPOSIT_CONTRACT}...`);
      const currentAllowance = await usdcContract.allowance(wallet.address, LIGHTER_DEPOSIT_CONTRACT);
      this.logger.debug(`Current allowance: ${ethers.formatUnits(currentAllowance, decimals)} USDC`);
      
      // Approve deposit contract if needed
      if (currentAllowance < depositAmountWei) {
        this.logger.log(`Approving Lighter deposit contract to spend ${depositAmount.toFixed(2)} USDC...`);
        const approveTx = await usdcContract.approve(LIGHTER_DEPOSIT_CONTRACT, depositAmountWei);
        this.logger.log(`⏳ Approval transaction submitted: ${approveTx.hash}`);
        const approveReceipt = await approveTx.wait();
        this.logger.log(`✅ Approval confirmed: ${approveReceipt.hash}, Block: ${approveReceipt.blockNumber}`);
      } else {
        this.logger.log(`Sufficient allowance already exists (${ethers.formatUnits(currentAllowance, decimals)} USDC)`);
      }

      // Transfer USDC to Lighter deposit contract
      this.logger.log(`🚀 Executing transfer to Lighter deposit contract ${LIGHTER_DEPOSIT_CONTRACT}...`);
      if (isWalletDeposit) {
        this.logger.log(
          `Transferring ${depositAmount.toFixed(2)} USDC (requested amount) to Lighter deposit contract... ` +
          `(wallet has ${balanceFormatted.toFixed(2)} USDC total, depositing only ${depositAmount.toFixed(2)} USDC)`
        );
      } else {
        this.logger.log(
          `Transferring ${depositAmount.toFixed(2)} USDC (full wallet balance) to Lighter deposit contract... ` +
          `(requested amount was ${amount.toFixed(2)} USDC, but depositing available balance after fees)`
        );
      }
      
      this.logger.log(`Calling transfer(${LIGHTER_DEPOSIT_CONTRACT}, ${depositAmountWei.toString()})...`);
      const transferTx = await usdcContract.transfer(LIGHTER_DEPOSIT_CONTRACT, depositAmountWei);
      this.logger.log(`⏳ Deposit transaction submitted: ${transferTx.hash}`);
      const receipt = await transferTx.wait();
      
      if (receipt.status === 1) {
        this.logger.log(`✅ Deposit successful! Transaction: ${receipt.hash}, Block: ${receipt.blockNumber}`);
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
  async withdrawExternal(amount: number, asset: string, destination: string): Promise<string> {
    try {
      if (amount <= 0) {
        throw new Error('Withdrawal amount must be greater than 0');
      }

      if (!destination || !destination.match(/^0x[a-fA-F0-9]{40}$/)) {
        throw new Error('Invalid destination address. Must be a valid Ethereum address (0x followed by 40 hex characters)');
      }

      // Only USDC is supported for fast withdrawals
      if (asset.toUpperCase() !== 'USDC') {
        throw new Error(`Only USDC withdrawals are supported. Received: ${asset}`);
      }

      this.logger.log(`🏦 Fast withdrawing $${amount.toFixed(2)} ${asset} to ${destination} on Lighter...`);

      await this.ensureInitialized();

      // Get Ethereum private key for L1 signing
      const ethPrivateKey = this.configService.get<string>('ETH_PRIVATE_KEY') || 
                           this.configService.get<string>('PRIVATE_KEY') ||
                           this.configService.get<string>('LIGHTER_PRIVATE_KEY');
      if (!ethPrivateKey) {
        throw new Error('ETH_PRIVATE_KEY, PRIVATE_KEY, or LIGHTER_PRIVATE_KEY required for fast withdrawals (L1 signature)');
      }
      const normalizedEthKey = ethPrivateKey.startsWith('0x') ? ethPrivateKey : `0x${ethPrivateKey}`;

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
      
      // Check withdraw limit
      if (poolInfo.withdraw_limit !== undefined) {
        const limitUsdc = poolInfo.withdraw_limit / 1e6;
        if (amount > limitUsdc) {
          throw new Error(`Withdrawal amount ($${amount.toFixed(2)}) exceeds pool limit ($${limitUsdc.toFixed(2)})`);
        }
      }
      this.logger.debug(`Pool: ${toAccountIndex}, Limit: ${poolInfo.withdraw_limit ? (poolInfo.withdraw_limit / 1e6).toFixed(2) : 'N/A'} USDC`);

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
      const toHex = (value: number): string => '0x' + value.toString(16).padStart(16, '0');
      
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
      this.logger.log(`📤 Submitting fast withdraw of $${amount.toFixed(2)} USDC to ${destination}...`);
      
      const formData = new URLSearchParams();
      formData.append('tx_info', txInfoStr);
      formData.append('to_address', destination);

      const response = await axios.post(
        `${this.config.baseUrl}/api/v1/fastwithdraw?auth=${encodeURIComponent(authToken)}`,
        formData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 30000,
        }
      );

      if (response.data.code === 200) {
        const txHash = response.data.tx_hash || response.data.txHash || `lighter-fastwithdraw-${Date.now()}`;
        this.logger.log(`✅ Fast withdrawal successful! TX: ${txHash}`);
        this.logger.log(`   Amount: $${amount.toFixed(2)} USDC (fee: $${feeUsdc.toFixed(2)})`);
        this.logger.log(`   Destination: ${destination}`);
        return txHash;
      } else {
        throw new Error(`Fast withdrawal failed: ${response.data.message || JSON.stringify(response.data)}`);
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

  /**
   * Get historical funding payments for the account
   * Uses the Lighter positionFunding endpoint with authentication
   * @param startTime Optional start time in milliseconds (not used by Lighter API)
   * @param endTime Optional end time in milliseconds (not used by Lighter API)
   * @returns Array of funding payments
   */
  async getFundingPayments(startTime?: number, endTime?: number): Promise<FundingPayment[]> {
    try {
      await this.ensureInitialized();

      this.logger.debug(`Fetching funding payments from Lighter for account ${this.config.accountIndex}`);

      // Create auth token for the request
      const authToken = await this.signerClient!.createAuthTokenWithExpiry(600); // 10 minutes

      // Call the positionFunding endpoint
      const response = await axios.get(`${this.config.baseUrl}/api/v1/positionFunding`, {
        params: {
          account_index: this.config.accountIndex,
          limit: 100,
          auth: authToken,
        },
        timeout: 30000,
        headers: {
          'accept': 'application/json',
        },
      });

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

      this.logger.debug(`Retrieved ${payments.length} funding payments from Lighter`);
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

