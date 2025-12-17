import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpTransport, ExchangeClient, InfoClient } from '@nktkas/hyperliquid';
import { SymbolConverter, formatSize, formatPrice } from '@nktkas/hyperliquid/utils';
import { ethers } from 'ethers';
import axios from 'axios';
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
import { HyperLiquidDataProvider } from './HyperLiquidDataProvider';
import { DiagnosticsService } from '../../services/DiagnosticsService';
import { MarketQualityFilter } from '../../../domain/services/MarketQualityFilter';

/**
 * HyperliquidExchangeAdapter - Implements IPerpExchangeAdapter for Hyperliquid
 * 
 * Uses the @nktkas/hyperliquid SDK
 * Uses WebSocket data provider to reduce rate limits (REST API has 1200 weight/minute limit)
 */
@Injectable()
export class HyperliquidExchangeAdapter implements IPerpExchangeAdapter {
  private readonly logger = new Logger(HyperliquidExchangeAdapter.name);
  private readonly config: ExchangeConfig;
  private readonly transport: HttpTransport;
  private readonly exchangeClient: ExchangeClient;
  private readonly infoClient: InfoClient;
  private symbolConverter: SymbolConverter | null = null;
  private walletAddress: string;

  // Balance cache: reduce clearinghouseState calls (weight 2 each, 1200 weight/minute limit)
  private balanceCache: { balance: number; timestamp: number } | null = null;
  private readonly BALANCE_CACHE_TTL = 5000; // 5 seconds cache (reduced from 30s to ensure fresh data)

  constructor(
    private readonly configService: ConfigService,
    private readonly dataProvider: HyperLiquidDataProvider,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
    @Optional() private readonly marketQualityFilter?: MarketQualityFilter,
  ) {
    const privateKey = this.configService.get<string>('PRIVATE_KEY') || this.configService.get<string>('HYPERLIQUID_PRIVATE_KEY');
    const isTestnet = this.configService.get<boolean>('HYPERLIQUID_TESTNET') || false;

    if (!privateKey) {
      throw new Error('Hyperliquid exchange requires PRIVATE_KEY or HYPERLIQUID_PRIVATE_KEY');
    }

    const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(normalizedPrivateKey);
    this.walletAddress = wallet.address;

    this.config = new ExchangeConfig(
      ExchangeType.HYPERLIQUID,
      'https://api.hyperliquid.xyz',
      undefined,
      undefined,
      normalizedPrivateKey,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined, // recvWindow
      undefined, // starkKey
      undefined, // vaultNumber
      undefined, // starknetRpcUrl
      undefined, // rateLimitRps
      undefined, // timeout
      isTestnet, // testnet
    );

    this.transport = new HttpTransport({ isTestnet });
    this.exchangeClient = new ExchangeClient({ wallet: normalizedPrivateKey as `0x${string}`, transport: this.transport });
    this.infoClient = new InfoClient({ transport: this.transport });

    // Don't initialize symbol converter in constructor - initialize lazily when needed
    // This prevents rate limiting during startup

    // Removed adapter initialization log - only execution logs shown
  }

  /**
   * Record an error to diagnostics service and market quality filter
   */
  private recordError(type: string, message: string, symbol?: string, context?: Record<string, any>): void {
    if (this.diagnosticsService) {
      this.diagnosticsService.recordError({
        type,
        message,
        exchange: ExchangeType.HYPERLIQUID,
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
        exchange: ExchangeType.HYPERLIQUID,
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
      this.marketQualityFilter.recordSuccess(symbol, ExchangeType.HYPERLIQUID);
    }
  }

  /**
   * Ensure SymbolConverter is initialized with retry logic for rate limiting
   */
  private async ensureSymbolConverter(): Promise<SymbolConverter> {
    if (this.symbolConverter) {
      return this.symbolConverter;
    }

    // Retry logic with exponential backoff for rate limiting
    const maxRetries = 5;
    const baseDelay = 1000; // 1 second base delay
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.logger.debug(`Initializing SymbolConverter (attempt ${attempt + 1}/${maxRetries})...`);
        this.symbolConverter = await SymbolConverter.create({ transport: this.transport });
        this.logger.debug('SymbolConverter initialized successfully');
        return this.symbolConverter;
      } catch (error: any) {
        // Check if it's a rate limit error (429)
        const isRateLimit = error?.response?.status === 429 || 
                           error?.message?.includes('429') ||
                           error?.message?.includes('Too Many Requests');
        
        if (isRateLimit && attempt < maxRetries - 1) {
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s
          const delay = baseDelay * Math.pow(2, attempt);
          // Silenced 429 warnings - only show errors
          this.logger.debug(
            `Rate limit hit (429) when initializing SymbolConverter. ` +
            `Retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // If it's not a rate limit error, or we've exhausted retries, throw
        this.logger.error(`Failed to initialize SymbolConverter: ${error.message}`);
        throw new ExchangeError(
          `Failed to initialize SymbolConverter: ${error.message}`,
          ExchangeType.HYPERLIQUID,
          undefined,
          error,
        );
      }
    }
    
    // Should never reach here, but TypeScript needs it
    throw new Error('Failed to initialize SymbolConverter after all retries');
  }

  /**
   * Convert symbol to Hyperliquid coin format (e.g., "ETH" -> "ETH-PERP")
   */
  private formatCoin(symbol: string): string {
    if (symbol.includes('-PERP')) {
      return symbol;
    }
    // Remove USDT/USDC suffix if present
    const baseSymbol = symbol.replace('USDT', '').replace('USDC', '');
    return `${baseSymbol}-PERP`;
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): string {
    return ExchangeType.HYPERLIQUID;
  }

  async placeOrder(request: PerpOrderRequest): Promise<PerpOrderResponse> {
    try {
      this.logger.log(
        `📤 Placing ${request.side} order on Hyperliquid: ${request.size} ${request.symbol} @ ${request.price || 'MARKET'} ` +
        `(type: ${request.type}, reduceOnly: ${request.reduceOnly || false})`
      );
      
      await this.ensureSymbolConverter();
      
      // Get asset ID and decimals
      const baseCoin = request.symbol.replace('USDT', '').replace('USDC', '').replace('-PERP', '');
      const assetId = this.symbolConverter!.getAssetId(baseCoin);
      
      if (assetId === undefined) {
        throw new Error(`Could not find asset ID for "${baseCoin}"`);
      }

      const szDecimals = this.symbolConverter!.getSzDecimals(baseCoin);
      if (szDecimals === undefined) {
        throw new Error(`Could not find szDecimals for "${baseCoin}"`);
      }

      const isBuy = request.side === OrderSide.LONG;
      const isPerp = !request.symbol.includes('-SPOT');

      // Format size using utilities (matching simple-hyperliquid-order.ts)
      const formattedSize = formatSize(request.size.toString(), szDecimals);
      
      // For market orders, Hyperliquid requires a limit price (uses IOC for market execution)
      // Use best bid/ask from order book for more accurate execution
      let orderPrice: number;
      if (request.price) {
        orderPrice = request.price;
      } else if (request.type === OrderType.MARKET) {
        // Get best bid/ask from order book for accurate IOC execution
        const { bestBid, bestAsk } = await this.getBestBidAsk(request.symbol);
        // Use best ask for buy orders (we pay the ask), best bid for sell orders (we get the bid)
        orderPrice = request.side === OrderSide.LONG ? bestAsk : bestBid;
        this.logger.debug(
          `Market order: using order book price ${orderPrice} (${request.side === OrderSide.LONG ? 'ask' : 'bid'}) for ${request.symbol}`
        );
      } else {
        throw new Error('Price is required for LIMIT orders');
      }

      // Determine time in force
      // For MARKET orders: Use IOC (immediate execution, cancel if not filled)
      // For LIMIT orders: Use GTC (can sit on order book) - matching sdk-perp-order.ts
      let tif: 'Gtc' | 'Ioc' = 'Gtc';
      if (request.type === OrderType.MARKET) {
        tif = 'Ioc'; // Market orders use IOC (Immediate or Cancel) for immediate execution
      } else {
        // LIMIT orders use GTC by default (can sit on order book)
        // This matches the working script which uses 'Gtc' for limit orders
        if (request.timeInForce) {
          const tifMap: Record<TimeInForce, 'Gtc' | 'Ioc'> = {
            [TimeInForce.GTC]: 'Gtc',
            [TimeInForce.IOC]: 'Ioc',
            [TimeInForce.FOK]: 'Ioc', // FOK maps to IOC for Hyperliquid
          };
          tif = tifMap[request.timeInForce] || 'Gtc';
        } else {
          tif = 'Gtc'; // Default to GTC for limit orders (can sit on book)
        }
      }

      // Retry logic: up to 5 attempts with fresh order book prices
      const MAX_RETRIES = 5;
      let lastError: Error | null = null;
      let result: any = null;
      let formattedPrice: string;
      
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          // For IOC orders, refresh order book price on retry to get latest market price
          if (attempt > 0 && tif === 'Ioc' && request.type === OrderType.MARKET) {
            // Clear cache to force fresh order book fetch
            this.orderBookCache.delete(request.symbol);
            const { bestBid, bestAsk } = await this.getBestBidAsk(request.symbol);
            orderPrice = request.side === OrderSide.LONG ? bestAsk : bestBid;
            
            this.logger.debug(
              `Retry ${attempt + 1}/${MAX_RETRIES}: Updated order book price ${orderPrice} for ${request.symbol}`
            );
            
            // Small delay before retry
            await new Promise(resolve => setTimeout(resolve, 200 * attempt));
          }
          
          // Format price using utilities (re-format on each retry if price changed)
          formattedPrice = formatPrice(orderPrice.toString(), szDecimals, isPerp);
          
          // Validate price is not zero
          if (parseFloat(formattedPrice) <= 0) {
            throw new Error(`Invalid order price: ${formattedPrice} (original: ${orderPrice})`);
          }
          
          // Use the order() method matching simple-hyperliquid-order.ts format
          result = await this.exchangeClient.order({
            orders: [{
              a: assetId,
              b: isBuy,
              p: formattedPrice,
              r: request.reduceOnly || false,
              s: formattedSize,
              t: { limit: { tif } },
            }],
            grouping: 'na',
          });

          // Parse response matching the script format
          if (result.status === 'ok' && result.response?.type === 'order' && result.response?.data?.statuses) {
            const status = result.response.data.statuses[0];
            
            if ('error' in status && status.error) {
              const errorMsg = typeof status.error === 'string' ? status.error : JSON.stringify(status.error);
              
              // Check if error is retryable (order couldn't match)
              const isRetryable = errorMsg.includes('could not immediately match') || 
                                 errorMsg.includes('Order could not immediately match');
              
              if (isRetryable && attempt < MAX_RETRIES - 1) {
                lastError = new Error(errorMsg);
                this.logger.warn(
                  `Order failed to match (attempt ${attempt + 1}/${MAX_RETRIES}): ${errorMsg}. Retrying with fresh price...`
                );
                continue; // Retry with fresh price
              }
              
              // Non-retryable error or max retries reached
              throw new Error(errorMsg);
            }
            
            // Order succeeded (filled or resting)
            break; // Exit retry loop
          } else {
            throw new Error(`Unexpected order response format: ${JSON.stringify(result).substring(0, 200)}`);
          }
        } catch (error: any) {
          lastError = error;
          const errorMsg = error?.message || error?.toString() || String(error);
          
          // Check if error is retryable
          const isRetryable = errorMsg.includes('could not immediately match') || 
                             errorMsg.includes('Order could not immediately match') ||
                             (errorMsg.includes('match') && attempt < MAX_RETRIES - 1);
          
          if (isRetryable && attempt < MAX_RETRIES - 1) {
            this.logger.warn(
              `Order placement failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${errorMsg}. Retrying...`
            );
            continue; // Retry
          }
          
          // Non-retryable error or max retries reached
          throw error;
        }
      }
      
      // If we get here, all retries failed
      if (!result || (result.status !== 'ok')) {
        throw lastError || new Error(`Order placement failed after ${MAX_RETRIES} attempts`);
      }

      // Parse successful response
      if (result.status === 'ok' && result.response?.type === 'order' && result.response?.data?.statuses) {
        const status = result.response.data.statuses[0];

        let orderId: string;
        let orderStatus: OrderStatus;
        let filledSize: number | undefined;
        let avgFillPrice: number | undefined;

        if ('filled' in status && status.filled) {
          orderId = status.filled.oid?.toString() || 'unknown';
          orderStatus = OrderStatus.FILLED;
          filledSize = parseFloat(status.filled.totalSz || '0');
          avgFillPrice = status.filled.avgPx ? parseFloat(status.filled.avgPx) : undefined;
        } else if ('resting' in status && status.resting) {
          orderId = status.resting.oid?.toString() || 'unknown';
          orderStatus = OrderStatus.SUBMITTED;
        } else {
          throw new Error('Unknown order status');
        }

        const response = new PerpOrderResponse(
          orderId,
          orderStatus,
          request.symbol,
          request.side,
          request.clientOrderId,
          filledSize,
          avgFillPrice,
          undefined,
          new Date(),
        );
        
        this.logger.log(
          `✅ Hyperliquid order ${orderStatus === OrderStatus.FILLED ? 'filled' : 'placed'} successfully: ` +
          `${orderId} (${request.side} ${request.size} ${request.symbol} @ ${avgFillPrice || request.price || 'MARKET'})`
        );
        
        // Record success for market quality tracking
        this.recordSuccess(request.symbol);
        
        return response;
      }

      throw new Error('Unknown response format from Hyperliquid');
    } catch (error: any) {
      this.logger.error(`Failed to place order: ${error.message}`);
      this.recordError('HYPERLIQUID_ORDER_FAILED', error.message, request.symbol);
      throw new ExchangeError(
        `Failed to place order: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async getPosition(symbol: string): Promise<PerpPosition | null> {
    try {
      const positions = await this.getPositions();
      return positions.find((p) => p.symbol === symbol) || null;
    } catch (error: any) {
      this.logger.error(`Failed to get position: ${error.message}`);
      throw new ExchangeError(
        `Failed to get position: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async getPositions(): Promise<PerpPosition[]> {
    try {
      // Always fetch fresh positions (no caching to ensure we see latest state)
      this.logger.debug(`Fetching fresh positions from Hyperliquid for ${this.walletAddress}...`);
      const clearinghouseState = await this.infoClient.clearinghouseState({ user: this.walletAddress });
      const positions: PerpPosition[] = [];

      if (clearinghouseState.assetPositions) {
        for (const assetPos of clearinghouseState.assetPositions) {
          const size = parseFloat(assetPos.position.szi || '0');
          // Filter out positions with very small sizes (likely rounding errors or stale data)
          // Use absolute value and check against a minimum threshold
          if (Math.abs(size) > 0.0001) {
            const side = size > 0 ? OrderSide.LONG : OrderSide.SHORT;
            const entryPrice = parseFloat(assetPos.position.entryPx || '0');
            const unrealizedPnl = parseFloat(assetPos.position.unrealizedPnl || '0');
            
            // Calculate mark price from position value or use entry price
            const positionValue = parseFloat(assetPos.position.positionValue || '0');
            const markPrice = Math.abs(size) > 0 ? positionValue / Math.abs(size) : entryPrice;
            
            const marginUsed = parseFloat(assetPos.position.marginUsed || '0');
            const liquidationPrice = parseFloat(assetPos.position.liquidationPx || '0') || undefined;

            // Get coin name - Hyperliquid API can return either:
            // 1. Coin name directly as string (e.g., "RESOLV", "BTC", "ETH")
            // 2. Asset index as number (e.g., 0, 1, 2)
            // 3. Asset index as string (e.g., "0", "1", "2")
            let coin: string;
            if (typeof assetPos.position.coin === 'string') {
              // Check if it's a numeric string (index) or coin name
              const parsed = parseInt(assetPos.position.coin, 10);
              if (!isNaN(parsed) && String(parsed) === assetPos.position.coin) {
                // It's a numeric string, treat as index
                coin = await this.getCoinFromAssetIndex(parsed);
              } else {
                // It's already a coin name (e.g., "RESOLV", "BTC")
                coin = assetPos.position.coin;
              }
            } else if (typeof assetPos.position.coin === 'number') {
              // It's a numeric index
              coin = await this.getCoinFromAssetIndex(assetPos.position.coin);
            } else {
              this.logger.error(
                `Invalid coin type for position: ${JSON.stringify(assetPos.position.coin)} (type: ${typeof assetPos.position.coin})`
              );
              continue; // Skip this position
            }
            
            if (!coin || coin.startsWith('ASSET-')) {
              this.logger.warn(
                `Could not resolve coin name for position coin: ${JSON.stringify(assetPos.position.coin)}, skipping position`
              );
              continue; // Skip positions we can't identify
            }

            positions.push(
              new PerpPosition(
                ExchangeType.HYPERLIQUID,
                coin,
                side,
                Math.abs(size),
                entryPrice,
                markPrice,
                unrealizedPnl,
                undefined,
                liquidationPrice,
                marginUsed,
                undefined,
                new Date(),
              ),
            );
          }
        }
      }

      return positions;
    } catch (error: any) {
      this.logger.error(`Failed to get positions: ${error.message}`);
      throw new ExchangeError(
        `Failed to get positions: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  private async getCoinFromAssetIndex(assetIndex: number): Promise<string> {
    try {
      if (isNaN(assetIndex) || assetIndex < 0) {
        this.logger.error(`Invalid asset index: ${assetIndex}`);
        throw new Error(`Invalid asset index: ${assetIndex}`);
      }
      
      await this.ensureSymbolConverter();
      const meta = await this.infoClient.meta();
      
      // Find asset by index in universe array
      if (meta.universe && Array.isArray(meta.universe)) {
        // Asset index corresponds to position in universe array
        if (assetIndex >= 0 && assetIndex < meta.universe.length) {
          const asset = meta.universe[assetIndex];
          if (asset?.name) {
            return asset.name;
          }
        }
      }
      
      // Fallback: try to find by matching index
      const asset = meta.universe?.find((a: any, index: number) => index === assetIndex);
      if (asset?.name) {
        return asset.name;
      }
      
      throw new Error(`Asset not found for index ${assetIndex}`);
    } catch (error: any) {
      this.logger.error(`Failed to get coin from asset index ${assetIndex}: ${error.message}`);
      throw new Error(`Could not find asset ID for index ${assetIndex}`);
    }
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      await this.ensureSymbolConverter();
      
      if (!symbol) {
        throw new Error('Symbol is required for canceling orders on Hyperliquid');
      }

      // Get asset index from symbol
      const baseCoin = symbol.replace('USDT', '').replace('USDC', '').replace('-PERP', '');
      const assetId = this.symbolConverter!.getAssetId(baseCoin);
      
      if (assetId === undefined) {
        throw new Error(`Could not find asset ID for "${baseCoin}"`);
      }

      // Convert orderId to number (Hyperliquid uses numeric order IDs)
      const orderIdNum = parseInt(orderId, 10);
      if (isNaN(orderIdNum)) {
        throw new Error(`Invalid order ID format: ${orderId}`);
      }

      this.logger.debug(`Cancelling order ${orderId} for ${symbol} (asset index: ${assetId})`);

      // Hyperliquid SDK: Use the cancel() method (not cancelOrder)
      // See: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#cancel-order-s
      const result = await this.exchangeClient.cancel({
        cancels: [
          {
            a: assetId,      // Asset index
            o: orderIdNum,   // Order ID
          },
        ],
      });

      if (result.status === 'ok') {
        this.logger.log(`✅ Order ${orderId} cancelled successfully on Hyperliquid`);
        return true;
      } else {
        this.logger.warn(`Failed to cancel order ${orderId}: ${JSON.stringify(result)}`);
        return false;
      }
    } catch (error: any) {
      this.logger.error(`Failed to cancel order: ${error.message}`);
      this.recordError('HYPERLIQUID_CANCEL_FAILED', error.message);
      throw new ExchangeError(
        `Failed to cancel order: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async cancelAllOrders(symbol: string): Promise<number> {
    try {
      await this.ensureSymbolConverter();
      
      // Get asset index from symbol
      const baseCoin = symbol.replace('USDT', '').replace('USDC', '').replace('-PERP', '');
      const assetId = this.symbolConverter!.getAssetId(baseCoin);
      
      if (assetId === undefined) {
        throw new Error(`Could not find asset ID for "${baseCoin}"`);
      }

      this.logger.debug(`Cancelling all orders for ${symbol} (asset index: ${assetId})`);

      // Fetch open orders first
      const openOrders = await this.infoClient.openOrders({ user: this.walletAddress });
      
      // Filter orders for this specific asset
      const ordersToCancel = openOrders.filter((o: any) => {
        // Check if order matches the asset index
        return o.asset === assetId || o.coin === baseCoin;
      });

      if (ordersToCancel.length === 0) {
        this.logger.debug(`No open orders found for ${symbol}`);
        return 0;
      }

      // Cancel all orders for this asset
      const cancels = ordersToCancel.map((o: any) => {
        const orderId = typeof o.oid === 'bigint' ? Number(o.oid) : parseInt(String(o.oid || '0'), 10);
        return {
          a: assetId,
          o: orderId,
        };
      });

      // Hyperliquid SDK: Use the cancel() method
      // See: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint#cancel-order-s
      const result = await this.exchangeClient.cancel({
        cancels,
      });

      if (result.status === 'ok') {
        this.logger.log(`✅ Cancelled ${cancels.length} order(s) for ${symbol} on Hyperliquid`);
        return cancels.length;
      } else {
        this.logger.warn(`Failed to cancel all orders for ${symbol}: ${JSON.stringify(result)}`);
        return 0;
      }
    } catch (error: any) {
      this.logger.error(`Failed to cancel all orders: ${error.message}`);
      throw new ExchangeError(
        `Failed to cancel all orders: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async getOrderStatus(orderId: string, symbol?: string): Promise<PerpOrderResponse> {
    try {
      const orderIdBigInt = BigInt(orderId);
      const openOrders = await this.infoClient.openOrders({ user: this.walletAddress });
      const order = openOrders.find((o: any) => {
        const oid = typeof o.oid === 'bigint' ? o.oid : BigInt(o.oid || '0');
        return oid === orderIdBigInt;
      });

      if (!order) {
        // Order might be filled or cancelled - check user fills
        const userFills = await this.infoClient.userFills({ user: this.walletAddress });
        const fill = userFills.find((f: any) => {
          const oid = typeof f.oid === 'bigint' ? f.oid : BigInt(f.oid || '0');
          return oid === orderIdBigInt;
        });
        
        if (fill) {
          // Get coin name from asset ID if needed
          let coinName = symbol || fill.coin || 'UNKNOWN';
          if (typeof fill.coin === 'number') {
            coinName = await this.getCoinFromAssetIndex(fill.coin);
          }

          // Hyperliquid fills use 'side' property: "B" = buy/long, "A" = sell/short
          const side = (fill as any).side === 'B' ? OrderSide.LONG : OrderSide.SHORT;

          return new PerpOrderResponse(
            orderId,
            OrderStatus.FILLED,
            coinName,
            side,
            undefined,
            parseFloat(fill.sz || '0'),
            parseFloat(fill.px || '0'),
            undefined,
            new Date(fill.time || Date.now()),
          );
        }

        throw new Error(`Order ${orderId} not found`);
      }

      // Get coin name from asset ID if needed
      let coinName = symbol || order.coin || 'UNKNOWN';
      if (typeof order.coin === 'number') {
        coinName = await this.getCoinFromAssetIndex(order.coin);
      }

      // Hyperliquid orders use 'b' property (boolean) for buy/sell
      const isBuy = (order as any).b === true;
      const side = isBuy ? OrderSide.LONG : OrderSide.SHORT;

      return new PerpOrderResponse(
        orderId,
        OrderStatus.SUBMITTED,
        coinName,
        side,
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
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  // Price cache: key = symbol, value = { price: number, timestamp: number }
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
  private readonly PRICE_CACHE_TTL = 10000; // 10 seconds cache

  // Order book cache: key = symbol, value = { bestBid: number, bestAsk: number, timestamp: number }
  private orderBookCache: Map<string, { bestBid: number; bestAsk: number; timestamp: number }> = new Map();
  private readonly ORDER_BOOK_CACHE_TTL = 2000; // 2 seconds cache (very short for order execution)

  /**
   * Get best bid and ask prices from order book for more accurate IOC order execution
   * Uses REST API l2Book endpoint to get current order book snapshot
   */
  async getBestBidAsk(symbol: string): Promise<{ bestBid: number; bestAsk: number }> {
    await this.ensureSymbolConverter();
    
    const baseCoin = symbol.replace('USDT', '').replace('USDC', '').replace('-PERP', '');
    const coin = this.formatCoin(symbol);
    
    // Check cache first (very short TTL for order execution)
    const cached = this.orderBookCache.get(symbol);
    if (cached && (Date.now() - cached.timestamp) < this.ORDER_BOOK_CACHE_TTL) {
      return { bestBid: cached.bestBid, bestAsk: cached.bestAsk };
    }

    try {
      // Use REST API l2Book endpoint directly to get order book snapshot
      // Hyperliquid API: POST /info with { type: "l2Book", coin: "ETH" }
      const baseUrl = this.config.baseUrl || 'https://api.hyperliquid.xyz';
      const response = await axios.post(
        `${baseUrl}/info`,
        { type: 'l2Book', coin },
        { timeout: 5000 }
      );
      
      const l2Book = response.data;
      
      if (l2Book && l2Book.levels) {
        const levels = l2Book.levels;
        
        // Hyperliquid l2Book format: { levels: [[px, sz], ...] }
        // First half are bids (sorted descending), second half are asks (sorted ascending)
        // Or format: { levels: { bids: [[px, sz], ...], asks: [[px, sz], ...] } }
        let bestBid = 0;
        let bestAsk = 0;
        
        if (Array.isArray(levels)) {
          // Find midpoint - bids are first (descending), asks are second (ascending)
          const midpoint = Math.floor(levels.length / 2);
          if (midpoint > 0) {
            // Best bid is the first (highest) bid
            const topBid = levels[0];
            bestBid = parseFloat(Array.isArray(topBid) ? topBid[0] : topBid.px || topBid);
            
            // Best ask is the first ask (lowest) after midpoint
            const topAsk = levels[midpoint];
            bestAsk = parseFloat(Array.isArray(topAsk) ? topAsk[0] : topAsk.px || topAsk);
          }
        } else if (levels.bids && levels.asks) {
          // Format: { bids: [[px, sz], ...], asks: [[px, sz], ...] }
          if (levels.bids.length > 0) {
            const topBid = levels.bids[0];
            bestBid = parseFloat(Array.isArray(topBid) ? topBid[0] : topBid.px || topBid);
          }
          if (levels.asks.length > 0) {
            const topAsk = levels.asks[0];
            bestAsk = parseFloat(Array.isArray(topAsk) ? topAsk[0] : topAsk.px || topAsk);
          }
        }
        
        if (bestBid > 0 && bestAsk > 0) {
          // Cache the result
          this.orderBookCache.set(symbol, { bestBid, bestAsk, timestamp: Date.now() });
          this.logger.debug(`Order book for ${symbol}: bid=${bestBid.toFixed(4)}, ask=${bestAsk.toFixed(4)}`);
          return { bestBid, bestAsk };
        }
      }
      
      throw new Error(`Could not parse order book data for ${symbol}: ${JSON.stringify(l2Book).substring(0, 200)}`);
    } catch (error: any) {
      this.logger.debug(`Failed to get order book for ${symbol}: ${error.message}. Falling back to mark price.`);
      
      // Fallback to mark price if order book fails
      const markPrice = await this.getMarkPrice(symbol);
      // Use mark price as both bid and ask (with small spread estimate)
      const spread = markPrice * 0.001; // 0.1% spread estimate
      return {
        bestBid: markPrice - spread,
        bestAsk: markPrice + spread,
      };
    }
  }

  async getMarkPrice(symbol: string): Promise<number> {
    // Check cache first
    const cached = this.priceCache.get(symbol);
    if (cached && (Date.now() - cached.timestamp) < this.PRICE_CACHE_TTL) {
      return cached.price;
    }

    // Try WebSocket first (no rate limits! weight 0)
    try {
      const wsPrice = await this.dataProvider.getMarkPrice(symbol);
      if (wsPrice > 0) {
        this.priceCache.set(symbol, { price: wsPrice, timestamp: Date.now() });
        return wsPrice;
      }
    } catch (error: any) {
      // WebSocket not available or data not ready, fall back to REST
      this.logger.debug(`WebSocket mark price not available for ${symbol}, using REST API`);
    }

    // Fallback to REST API (allMids has weight 2, but we cache results)
    // Retry logic: up to 3 attempts with exponential backoff
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.pow(2, attempt) * 1000; // 2s, 4s delays
          await new Promise(resolve => setTimeout(resolve, delay));
          this.logger.debug(`Retrying mark price fetch for ${symbol} (attempt ${attempt + 1}/3)`);
        }

        // Use allMids() to get mark prices (matching simple-hyperliquid-order.ts)
        // Weight: 2 per request (1200 weight/minute limit = 600 requests/minute max)
        const allMidsData = await this.infoClient.allMids();
        const coin = this.formatCoin(symbol);
        const baseCoin = coin.replace('-PERP', '');
        
        const markPrice = parseFloat((allMidsData as any)[baseCoin] || (allMidsData as any)[coin] || '0');
        if (markPrice > 0) {
          // Cache the result
          this.priceCache.set(symbol, { price: markPrice, timestamp: Date.now() });
          return markPrice;
        }

        throw new Error(`Mark price not found for ${symbol} (coin: ${coin}, baseCoin: ${baseCoin})`);
      } catch (error: any) {
        lastError = error;
        if (attempt === 2) {
          // Last attempt failed
          this.logger.error(
            `Failed to get mark price for ${symbol} after 3 attempts: ${error.message}. ` +
            `Tried coin formats: ${this.formatCoin(symbol)}, ${this.formatCoin(symbol).replace('-PERP', '')}`
          );
        }
      }
    }

    // All attempts failed
    throw new ExchangeError(
      `Failed to get mark price for ${symbol} after 3 retries: ${lastError?.message || 'unknown error'}`,
      ExchangeType.HYPERLIQUID,
      undefined,
      lastError || undefined,
    );
  }

  /**
   * Clear balance cache to force fresh data fetch on next call
   */
  clearBalanceCache(): void {
    this.balanceCache = null;
    this.logger.debug('Balance cache cleared - next getBalance() will fetch fresh data');
  }

  async getBalance(): Promise<number> {

    // Check cache first (clearinghouseState has weight 2, 1200 weight/minute limit)
    if (this.balanceCache && (Date.now() - this.balanceCache.timestamp) < this.BALANCE_CACHE_TTL) {
      const cacheAge = Math.round((Date.now() - this.balanceCache.timestamp) / 1000);
      this.logger.debug(`Using cached balance: $${this.balanceCache.balance.toFixed(2)} (age: ${cacheAge}s)`);
      return this.balanceCache.balance;
    }

    try {
      // clearinghouseState has weight 2 (1200 weight/minute = 600 requests/minute max)
      this.logger.debug(`Fetching fresh balance from Hyperliquid for ${this.walletAddress}...`);
      const clearinghouseState = await this.infoClient.clearinghouseState({ user: this.walletAddress });
      const marginSummary = clearinghouseState.marginSummary;
      
      const accountValue = parseFloat(marginSummary.accountValue || '0');
      const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
      const freeCollateral = accountValue - totalMarginUsed;
      
      // Cache the result
      this.balanceCache = { balance: freeCollateral, timestamp: Date.now() };
      
      // Log detailed balance info for debugging
      this.logger.debug(
        `HyperLiquid balance for ${this.walletAddress}: ` +
        `Account Value: $${accountValue.toFixed(2)}, ` +
        `Margin Used: $${totalMarginUsed.toFixed(2)}, ` +
        `Free Collateral: $${freeCollateral.toFixed(2)}`
      );
      
      return freeCollateral; // Free collateral
    } catch (error: any) {
      // If we have cached balance, return it even if expired (graceful degradation)
      if (this.balanceCache) {
        const cacheAge = Math.round((Date.now() - this.balanceCache.timestamp) / 1000);
        this.logger.warn(
          `Failed to get fresh balance, using cached value: ${error.message}. ` +
          `Cached balance: $${this.balanceCache.balance.toFixed(2)} (age: ${cacheAge}s)`
        );
        return this.balanceCache.balance;
      }

      this.logger.error(`Failed to get balance: ${error.message}`);
      throw new ExchangeError(
        `Failed to get balance: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async getEquity(): Promise<number> {
    // Use cached balance if available (equity = accountValue, which we get from clearinghouseState)
    // If balance cache exists, we can derive equity from it (equity = balance + marginUsed)
    // But for simplicity, we'll just call clearinghouseState with caching
    try {
      // Reuse balance cache if recent (both use clearinghouseState)
      if (this.balanceCache && (Date.now() - this.balanceCache.timestamp) < this.BALANCE_CACHE_TTL) {
        // We need accountValue, not freeCollateral, so we still need to fetch
        // But we can reduce calls by using the same cached clearinghouseState
        // For now, just fetch (it's cached in getBalance, but we need accountValue specifically)
        const clearinghouseState = await this.infoClient.clearinghouseState({ user: this.walletAddress });
        const marginSummary = clearinghouseState.marginSummary;
        return parseFloat(marginSummary.accountValue || '0');
      }

      // If balance cache is expired, getBalance will refresh it, but we still need accountValue
      // So we fetch here (weight 2, but cached for 30s)
      const clearinghouseState = await this.infoClient.clearinghouseState({ user: this.walletAddress });
      const marginSummary = clearinghouseState.marginSummary;
      const accountValue = parseFloat(marginSummary.accountValue || '0');
      
      // Update balance cache while we're at it
      const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
      const freeCollateral = accountValue - totalMarginUsed;
      this.balanceCache = { balance: freeCollateral, timestamp: Date.now() };
      
      return accountValue;
    } catch (error: any) {
      this.logger.error(`Failed to get equity: ${error.message}`);
      throw new ExchangeError(
        `Failed to get equity: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  /**
   * Get available margin for opening new positions
   * Hyperliquid provides this directly via marginSummary
   */
  async getAvailableMargin(): Promise<number> {
    try {
      const clearinghouseState = await this.infoClient.clearinghouseState({ user: this.walletAddress });
      const marginSummary = clearinghouseState.marginSummary;
      
      // Hyperliquid provides availableMargin directly
      // This is the margin available for new positions, accounting for existing positions
      const accountValue = parseFloat(marginSummary.accountValue || '0');
      const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
      
      // Apply a 15% safety buffer (10% maintenance + 5% execution)
      const availableMargin = (accountValue - totalMarginUsed) * 0.85;
      
      this.logger.debug(
        `Hyperliquid available margin: accountValue=$${accountValue.toFixed(2)}, ` +
        `marginUsed=$${totalMarginUsed.toFixed(2)}, available=$${Math.max(0, availableMargin).toFixed(2)}`
      );
      
      return Math.max(0, availableMargin);
    } catch (error: any) {
      this.logger.warn(`Failed to get available margin: ${error.message}, falling back to getBalance`);
      try {
        const balance = await this.getBalance();
        return balance * 0.7; // 30% buffer as fallback
      } catch {
        return 0;
      }
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
      await this.infoClient.meta();
    } catch (error: any) {
      throw new ExchangeError(
        `Connection test failed: ${error.message}`,
        ExchangeType.HYPERLIQUID,
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

      const direction = toPerp ? 'spot → perp margin' : 'perp margin → spot';
      this.logger.log(`Transferring $${amount.toFixed(2)} ${direction} on Hyperliquid...`);

      // Check if ExchangeClient has transfer method (may vary by SDK version)
      // Try the method if it exists, otherwise use direct API call
      if (typeof (this.exchangeClient as any).transferBetweenSpotAndPerp === 'function') {
        const result = await (this.exchangeClient as any).transferBetweenSpotAndPerp(amount, toPerp);

        if (result.status === 'ok') {
          const txHash = result.response?.data?.txHash || result.response?.txHash || 'unknown';
          this.logger.log(`✅ Transfer successful: ${direction} - TX: ${txHash}`);
          return txHash;
        } else {
          const errorMsg = result.response?.data?.error || result.response?.error || 'Unknown error';
          throw new Error(`Transfer failed: ${errorMsg}`);
        }
      } else {
        // Fallback: Hyperliquid transfers may require signed actions
        // For now, throw an error indicating the method is not available in this SDK version
        // The transfer functionality may need to be implemented using the Hyperliquid action format
        throw new Error(
          `transferBetweenSpotAndPerp method not available in @nktkas/hyperliquid SDK. ` +
          `Hyperliquid internal transfers require signed actions. ` +
          `Please use the Hyperliquid web interface or implement using the action-based API. ` +
          `See Hyperliquid documentation for transfer action format.`
        );
      }
    } catch (error: any) {
      this.logger.error(`Failed to transfer ${toPerp ? 'spot → perp' : 'perp → spot'}: ${error.message}`);
      throw new ExchangeError(
        `Failed to transfer: ${error.message}`,
        ExchangeType.HYPERLIQUID,
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

      // Minimum deposit is 5 USDC (per Bridge2 documentation)
      if (amount < 5) {
        throw new Error(`Deposit amount must be at least 5 USDC. Received: ${amount}`);
      }

      // Only USDC is supported for deposits via Bridge2
      if (asset.toUpperCase() !== 'USDC') {
        throw new Error(`Only USDC deposits are supported via Bridge2. Received: ${asset}`);
      }

      this.logger.log(`Depositing $${amount.toFixed(2)} ${asset} to Hyperliquid via Bridge2...`);

      // Bridge2 contract addresses
      const BRIDGE_CONTRACT_ADDRESS = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7'; // Arbitrum mainnet
      const USDC_CONTRACT_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // USDC on Arbitrum
      
      // Get Arbitrum RPC URL
      const arbitrumRpcUrl = this.configService.get<string>('ARBITRUM_RPC_URL') ||
                             this.configService.get<string>('ARB_RPC_URL') ||
                             'https://arb1.arbitrum.io/rpc'; // Public RPC fallback
      
      // Get private key for signing transactions
      const privateKey = this.configService.get<string>('PRIVATE_KEY') || 
                        this.configService.get<string>('HYPERLIQUID_PRIVATE_KEY');
      if (!privateKey) {
        throw new Error('PRIVATE_KEY or HYPERLIQUID_PRIVATE_KEY required for deposits');
      }

      const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      const provider = new ethers.JsonRpcProvider(arbitrumRpcUrl);
      const wallet = new ethers.Wallet(normalizedPrivateKey, provider);

      this.logger.debug(
        `Bridge deposit details:\n` +
        `  Bridge contract: ${BRIDGE_CONTRACT_ADDRESS}\n` +
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

      // Check USDC balance with retry logic (funds may be in transit from withdrawal)
      // IMPORTANT: We deposit the ENTIRE available balance, not the requested amount,
      // because withdrawal fees reduce the amount that actually arrives
      const decimals = await usdcContract.decimals();
      
      const maxWaitTime = 300000; // 5 minutes maximum wait
      const initialDelay = 2000; // 2 seconds initial delay
      const maxDelay = 30000; // 30 seconds max delay between checks
      const startTime = Date.now();
      let attempt = 0;
      let balanceFormatted = 0;
      let balanceWei: bigint;
      
      // Wait for funds to arrive (at least the minimum deposit amount)
      while (true) {
        attempt++;
        balanceWei = await usdcContract.balanceOf(wallet.address);
        balanceFormatted = Number(ethers.formatUnits(balanceWei, decimals));
        
        this.logger.debug(
          `Balance check attempt ${attempt}: ${balanceFormatted.toFixed(2)} USDC ` +
          `(requested: ${amount.toFixed(2)} USDC, minimum: 5 USDC)`
        );

        // Wait until we have at least the minimum deposit amount (5 USDC)
        if (balanceFormatted >= 5) {
          this.logger.log(
            `✅ Funds arrived. Available balance: ${balanceFormatted.toFixed(2)} USDC ` +
            `(will deposit entire balance, not just requested ${amount.toFixed(2)} USDC)`
          );
          break;
        }

        const elapsed = Date.now() - startTime;
        if (elapsed >= maxWaitTime) {
          throw new Error(
            `Insufficient USDC balance after ${Math.floor(elapsed / 1000)}s wait. ` +
            `Required: 5 USDC (minimum), Available: ${balanceFormatted.toFixed(2)} USDC. ` +
            `Funds may still be in transit from withdrawal.`
          );
        }

        // Exponential backoff: 2s, 4s, 8s, 16s, capped at 30s
        const delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
        const remaining = maxWaitTime - elapsed;
        const waitTime = Math.min(delay, remaining);
        
        this.logger.warn(
          `Waiting for funds to arrive (minimum 5 USDC required). ` +
          `Current: ${balanceFormatted.toFixed(2)} USDC. ` +
          `Waiting ${waitTime / 1000}s (attempt ${attempt}, ${Math.floor(elapsed / 1000)}s elapsed)...`
        );
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

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
      const currentAllowance = await usdcContract.allowance(wallet.address, BRIDGE_CONTRACT_ADDRESS);
      
      // Approve bridge contract if needed
      if (currentAllowance < depositAmountWei) {
        this.logger.log(`Approving Bridge2 contract to spend ${depositAmount.toFixed(2)} USDC...`);
        const approveTx = await usdcContract.approve(BRIDGE_CONTRACT_ADDRESS, depositAmountWei);
        this.logger.debug(`Approve transaction hash: ${approveTx.hash}`);
        const approveReceipt = await approveTx.wait();
        this.logger.log(`✅ Approval confirmed in block ${approveReceipt.blockNumber}`);
      } else {
        this.logger.debug(`Bridge contract already has sufficient allowance`);
      }

      // Transfer USDC to bridge contract
      // Note: Bridge2 accepts direct transfers - sending USDC to the bridge contract credits the account
      if (isWalletDeposit) {
        this.logger.log(
          `Transferring ${depositAmount.toFixed(2)} USDC (requested amount) to Bridge2 contract... ` +
          `(wallet has ${balanceFormatted.toFixed(2)} USDC total, depositing only ${depositAmount.toFixed(2)} USDC)`
        );
      } else {
        this.logger.log(
          `Transferring ${depositAmount.toFixed(2)} USDC (full wallet balance) to Bridge2 contract... ` +
          `(requested amount was ${amount.toFixed(2)} USDC, but depositing available balance after fees)`
        );
      }
      const transferTx = await usdcContract.transfer(BRIDGE_CONTRACT_ADDRESS, depositAmountWei);
      this.logger.debug(`Transfer transaction hash: ${transferTx.hash}`);
      
      // Wait for confirmation
      const receipt = await transferTx.wait();
      this.logger.log(
        `✅ Deposit confirmed! Deposited ${depositAmount.toFixed(2)} USDC. ` +
        `Transaction hash: ${receipt.hash}, Block: ${receipt.blockNumber}. ` +
        `Funds should be credited to Hyperliquid account in <1 minute.`
      );

      // Return transaction hash
      return receipt.hash;
    } catch (error: any) {
      if (error instanceof ExchangeError) {
        throw error;
      }
      this.logger.error(`Failed to deposit ${asset}: ${error.message}`);
      throw new ExchangeError(
        `Failed to deposit: ${error.message}`,
        ExchangeType.HYPERLIQUID,
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

      // Hyperliquid has a 1 USDC withdrawal fee that is deducted from the amount
      // The fee is automatically deducted by Hyperliquid, so if you request $10, you'll receive $9
      // We need to ensure the user has enough balance to cover both the amount and the fee
      const WITHDRAWAL_FEE_USDC = 1.0;
      const totalRequired = amount + WITHDRAWAL_FEE_USDC; // Amount + fee
      const minWithdrawalAmount = WITHDRAWAL_FEE_USDC + 0.1; // Minimum to cover fee + small buffer
      
      if (amount < minWithdrawalAmount) {
        throw new Error(
          `Withdrawal amount must be at least $${minWithdrawalAmount.toFixed(2)} ` +
          `(to cover $${WITHDRAWAL_FEE_USDC.toFixed(2)} withdrawal fee). ` +
          `Requested: $${amount.toFixed(2)}`
        );
      }

      this.logger.log(
        `Withdrawing $${amount.toFixed(2)} ${asset} to ${destination} on Hyperliquid... ` +
        `(Total required: $${totalRequired.toFixed(2)} including $${WITHDRAWAL_FEE_USDC.toFixed(2)} fee, ` +
        `net amount received: $${(amount).toFixed(2)})`
      );

      // Step 1: Ensure funds are in perp account (withdrawals come from perp, not spot)
      // According to Hyperliquid: "If you have USDC in your Spot Balances, transfer to Perps to make it available to withdraw"
      try {
        const clearinghouseState = await this.infoClient.clearinghouseState({ user: this.walletAddress });
        const marginSummary = clearinghouseState.marginSummary;
        const accountValue = parseFloat(marginSummary.accountValue || '0');
        const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
        const perpAvailable = accountValue - totalMarginUsed; // Available equity in perps (free collateral)
        
        this.logger.debug(
          `Balance check: Perp Available=$${perpAvailable.toFixed(2)}, ` +
          `Account Value=$${accountValue.toFixed(2)}, Margin Used=$${totalMarginUsed.toFixed(2)}, ` +
          `Required=$${totalRequired.toFixed(2)}`
        );

        // Check if we have sufficient perp balance
        if (perpAvailable < totalRequired) {
          // Try to transfer from spot to perp if needed
          // We don't know spot balance from marginSummary, so we'll try the transfer
          // and let it fail if there's no spot balance
          const transferAmount = totalRequired - perpAvailable + 1; // Transfer a bit extra for safety
          this.logger.log(
            `Insufficient perp balance ($${perpAvailable.toFixed(2)}). ` +
            `Attempting to transfer $${transferAmount.toFixed(2)} from spot to perp margin...`
          );
          
          try {
            // Transfer from spot to perp margin using internal transfer
            await this.transferInternal(transferAmount, true); // true = spot to perp
            
            // Wait a bit for transfer to settle
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Re-check perp balance after transfer
            const updatedState = await this.infoClient.clearinghouseState({ user: this.walletAddress });
            const updatedMarginSummary = updatedState.marginSummary;
            const updatedAccountValue = parseFloat(updatedMarginSummary.accountValue || '0');
            const updatedMarginUsed = parseFloat(updatedMarginSummary.totalMarginUsed || '0');
            const updatedPerpAvailable = updatedAccountValue - updatedMarginUsed;
            
            if (updatedPerpAvailable < totalRequired) {
              throw new Error(
                `Insufficient perp balance after transfer. ` +
                `Perp Available: $${updatedPerpAvailable.toFixed(2)}, ` +
                `Required: $${totalRequired.toFixed(2)}. ` +
                `Please ensure sufficient funds are available in spot or perp account.`
              );
            }
          } catch (transferError: any) {
            // Transfer failed - might be no spot balance or other error
            throw new Error(
              `Insufficient perp balance ($${perpAvailable.toFixed(2)}) and failed to transfer from spot: ${transferError.message}. ` +
              `Required: $${totalRequired.toFixed(2)}. ` +
              `Please ensure funds are available in perp account or transfer from spot manually.`
            );
          }
        }
      } catch (balanceError: any) {
        this.logger.warn(`Failed to check/transfer balance before withdrawal: ${balanceError.message}`);
        // Continue anyway - the withdrawal will fail if balance is insufficient
      }

      // Step 2: Use SDK's withdraw3 method for external withdrawals to Arbitrum
      // The withdraw3 method handles the bridge to Arbitrum automatically
      // Withdrawals come from perp account balance
      // NOTE: spotSend (action type 3) only sends assets within Hyperliquid mainnet,
      // it does NOT bridge to Arbitrum. We must use withdraw3 for external withdrawals.
      if (asset.toUpperCase() !== 'USDC' && asset.toUpperCase() !== 'USDT') {
        this.logger.warn(
          `Asset ${asset} may not be supported for external withdrawal. ` +
          `Only USDC withdrawals to Arbitrum are confirmed to work.`
        );
      }

      this.logger.debug(
        `Calling withdraw3: destination=${destination} (Arbitrum), amount=${amount} USDC`
      );

      // Check if ExchangeClient has withdraw3 method (this is the correct method name)
      // withdraw3 expects an object with destination and amount properties
      if (typeof (this.exchangeClient as any).withdraw3 === 'function') {
        const result = await (this.exchangeClient as any).withdraw3({
          destination: destination,
          amount: amount,
        });

        if (result && result.status === 'ok') {
          // Hyperliquid withdraw3 returns { status: 'ok', response: { type: 'default' } }
          // The actual transaction hash may not be immediately available
          // Generate a unique ID for tracking
          const txHash = result.response?.txHash || 
                        result.response?.data?.txHash || 
                        result.response?.id || 
                        `hyperliquid-withdraw-${Date.now()}`;
          this.logger.log(
            `✅ Withdrawal initiated successfully - ID: ${txHash}. ` +
            `Amount requested: $${amount.toFixed(2)}, ` +
            `Fee deducted: $${WITHDRAWAL_FEE_USDC.toFixed(2)}, ` +
            `Net amount received: $${(amount).toFixed(2)} (fee deducted by Hyperliquid)`
          );
          return txHash;
        } else {
          const errorMsg = result?.response?.data?.error || 
                          result?.response?.error || 
                          JSON.stringify(result);
          throw new Error(`Withdrawal failed: ${errorMsg}`);
        }
      } else {
        // Cannot use spotSend as it only works within Hyperliquid mainnet, not for Arbitrum
        throw new Error(
          `withdraw3 method not found in Hyperliquid SDK. ` +
          `External withdrawals to Arbitrum require the SDK's withdraw3 method. ` +
          `Please ensure you're using a compatible version of @nktkas/hyperliquid SDK. ` +
          `spotSend (action type 3) only transfers assets within Hyperliquid mainnet and cannot bridge to Arbitrum.`
        );
      }
    } catch (error: any) {
      if (error instanceof ExchangeError) {
        throw error;
      }
      
      // Provide helpful error messages
      let errorMessage = error.message;
      if (error.response?.status === 422) {
        errorMessage = `Invalid withdrawal request (422): ${error.response?.data?.message || error.message}. ` +
          `Check that: 1) Amount is sufficient (min $${(1.0 + 0.1).toFixed(2)} including $1.00 fee), ` +
          `2) Destination address is valid, 3) You have sufficient balance on HyperCore spot.`;
      }
      
      // Fix error message: Hyperliquid withdrawals use USDC, not USDT
      const assetDisplay = asset.toUpperCase() === 'USDT' ? 'USDC' : asset;
      this.logger.error(`Failed to withdraw ${assetDisplay} to ${destination}: ${errorMessage}`);
      if (error.response?.data) {
        this.logger.debug(`Hyperliquid API error response: ${JSON.stringify(error.response.data)}`);
      }
      
      throw new ExchangeError(
        `Failed to withdraw: ${errorMessage}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  /**
   * Get historical funding payments for the account
   * Uses the Hyperliquid userFunding endpoint
   * @param startTime Optional start time in milliseconds (default: 7 days ago)
   * @param endTime Optional end time in milliseconds (default: now)
   * @returns Array of funding payments
   */
  async getFundingPayments(startTime?: number, endTime?: number): Promise<FundingPayment[]> {
    try {
      const now = Date.now();
      const start = startTime || now - (7 * 24 * 60 * 60 * 1000); // Default: 7 days ago
      const end = endTime || now;

      this.logger.debug(
        `Fetching funding payments from Hyperliquid for ${this.walletAddress} ` +
        `(${new Date(start).toISOString()} to ${new Date(end).toISOString()})`
      );

      // Call the userFunding endpoint
      const response = await axios.post(
        `${this.config.baseUrl}/info`,
        {
          type: 'userFunding',
          user: this.walletAddress,
          startTime: start,
          endTime: end,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000,
        }
      );

      const data = response.data;
      
      if (!Array.isArray(data)) {
        this.logger.warn(`Unexpected userFunding response format: ${JSON.stringify(data).substring(0, 200)}`);
        return [];
      }

      const payments: FundingPayment[] = [];

      for (const entry of data) {
        if (entry.delta?.type === 'funding') {
          const amount = parseFloat(entry.delta.usdc || '0');
          const rate = parseFloat(entry.delta.fundingRate || '0');
          const size = parseFloat(entry.delta.szi || '0');

          payments.push({
            exchange: ExchangeType.HYPERLIQUID,
            symbol: entry.delta.coin,
            amount: amount,
            fundingRate: rate,
            positionSize: Math.abs(size),
            timestamp: new Date(entry.time),
          });
        }
      }

      this.logger.debug(`Retrieved ${payments.length} funding payments from Hyperliquid`);
      return payments;
    } catch (error: any) {
      this.logger.error(`Failed to get funding payments: ${error.message}`);
      throw new ExchangeError(
        `Failed to get funding payments: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  /**
   * Get all open orders
   * @returns Array of open orders with timestamp for stale order detection
   */
  async getOpenOrders(): Promise<import('../../../domain/ports/IPerpExchangeAdapter').OpenOrder[]> {
    try {
      await this.ensureSymbolConverter();
      
      const openOrders = await this.infoClient.openOrders({ user: this.walletAddress });
      
      return openOrders.map((order: any) => {
        const orderId = typeof order.oid === 'bigint' 
          ? order.oid.toString() 
          : String(order.oid || '');
        
        return {
          orderId,
          symbol: order.coin || '',
          side: order.side === 'B' ? 'buy' : 'sell',
          price: parseFloat(order.limitPx || '0'),
          size: parseFloat(order.sz || '0'),
          filledSize: parseFloat(order.sz || '0') - parseFloat(order.origSz || order.sz || '0'),
          timestamp: new Date(order.timestamp || Date.now()),
        };
      });
    } catch (error: any) {
      this.logger.error(`Failed to get open orders: ${error.message}`);
      throw new ExchangeError(
        `Failed to get open orders: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }
}

