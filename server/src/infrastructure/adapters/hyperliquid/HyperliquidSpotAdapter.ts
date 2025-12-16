import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpTransport, ExchangeClient, InfoClient } from '@nktkas/hyperliquid';
import {
  SymbolConverter,
  formatSize,
  formatPrice,
} from '@nktkas/hyperliquid/utils';
import { ethers } from 'ethers';
import {
  ExchangeConfig,
  ExchangeType,
} from '../../../domain/value-objects/ExchangeConfig';
import {
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForce,
} from '../../../domain/value-objects/PerpOrder';
import {
  SpotOrderRequest,
  SpotOrderResponse,
} from '../../../domain/value-objects/SpotOrder';
import { SpotPosition } from '../../../domain/entities/SpotPosition';
import {
  ISpotExchangeAdapter,
  SpotExchangeError,
} from '../../../domain/ports/ISpotExchangeAdapter';

/**
 * HyperliquidSpotAdapter - Implements ISpotExchangeAdapter for Hyperliquid
 *
 * Uses the @nktkas/hyperliquid SDK
 * Spot assets use {COIN}-SPOT format (e.g., ETH-SPOT)
 */
@Injectable()
export class HyperliquidSpotAdapter implements ISpotExchangeAdapter {
  private readonly logger = new Logger(HyperliquidSpotAdapter.name);
  private readonly config: ExchangeConfig;
  private readonly transport: HttpTransport;
  private readonly exchangeClient: ExchangeClient;
  private readonly infoClient: InfoClient;
  private symbolConverter: SymbolConverter | null = null;
  private walletAddress: string;

  // Balance cache: reduce clearinghouseState calls (weight 2 each, 1200 weight/minute limit)
  private spotBalanceCache: Map<
    string,
    { balance: number; timestamp: number }
  > = new Map();
  private readonly BALANCE_CACHE_TTL = 5000; // 5 seconds cache

  constructor(private readonly configService: ConfigService) {
    const privateKey =
      this.configService.get<string>('PRIVATE_KEY') ||
      this.configService.get<string>('HYPERLIQUID_PRIVATE_KEY');
    const isTestnet =
      this.configService.get<boolean>('HYPERLIQUID_TESTNET') || false;

    if (!privateKey) {
      throw new Error(
        'Hyperliquid spot adapter requires PRIVATE_KEY or HYPERLIQUID_PRIVATE_KEY',
      );
    }

    const normalizedPrivateKey = privateKey.startsWith('0x')
      ? privateKey
      : `0x${privateKey}`;
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      isTestnet,
    );

    this.transport = new HttpTransport({ isTestnet });
    this.exchangeClient = new ExchangeClient({
      wallet: normalizedPrivateKey as `0x${string}`,
      transport: this.transport,
    });
    this.infoClient = new InfoClient({ transport: this.transport });
  }

  /**
   * Ensure SymbolConverter is initialized with retry logic for rate limiting
   */
  private async ensureSymbolConverter(): Promise<SymbolConverter> {
    if (this.symbolConverter) {
      return this.symbolConverter;
    }

    const maxRetries = 5;
    const baseDelay = 1000;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.logger.debug(
          `Initializing SymbolConverter (attempt ${attempt + 1}/${maxRetries})...`,
        );
        this.symbolConverter = await SymbolConverter.create({
          transport: this.transport,
        });
        this.logger.debug('SymbolConverter initialized successfully');
        return this.symbolConverter;
      } catch (error: any) {
        const isRateLimit =
          error?.response?.status === 429 ||
          error?.message?.includes('429') ||
          error?.message?.includes('Too Many Requests');

        if (isRateLimit && attempt < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, attempt);
          this.logger.debug(`Rate limit hit. Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        this.logger.error(
          `Failed to initialize SymbolConverter: ${error.message}`,
        );
        throw new SpotExchangeError(
          `Failed to initialize SymbolConverter: ${error.message}`,
          ExchangeType.HYPERLIQUID,
          undefined,
          error,
        );
      }
    }

    throw new Error('Failed to initialize SymbolConverter after all retries');
  }

  /**
   * Convert symbol to Hyperliquid spot coin format (e.g., "ETH" -> "ETH-SPOT")
   */
  private formatSpotCoin(symbol: string): string {
    if (symbol.includes('-SPOT')) {
      return symbol;
    }
    // Remove USDT/USDC suffix if present
    const baseSymbol = symbol.replace('USDT', '').replace('USDC', '');
    return `${baseSymbol}-SPOT`;
  }

  /**
   * Get best bid/ask from order book for spot
   */
  private async getBestBidAsk(
    symbol: string,
  ): Promise<{ bestBid: number; bestAsk: number }> {
    try {
      const spotCoin = this.formatSpotCoin(symbol);
      const allMids = await this.infoClient.allMids();

      // Find spot pair in allMids
      const spotPair = allMids[spotCoin];
      if (
        spotPair &&
        typeof spotPair === 'object' &&
        'bid' in spotPair &&
        'ask' in spotPair
      ) {
        return {
          bestBid: parseFloat((spotPair as any).bid || '0'),
          bestAsk: parseFloat((spotPair as any).ask || '0'),
        };
      }

      // Fallback: use mark price if available
      const meta = await this.infoClient.meta();
      const asset = meta.universe?.find(
        (a: any) => a.name === spotCoin || a.name === symbol,
      );
      if (asset && 'markPx' in asset) {
        const markPrice = parseFloat((asset as any).markPx);
        return {
          bestBid: markPrice * 0.999, // Estimate
          bestAsk: markPrice * 1.001, // Estimate
        };
      }

      throw new Error(`Could not find spot price for ${spotCoin}`);
    } catch (error: any) {
      this.logger.error(
        `Failed to get best bid/ask for ${symbol}: ${error.message}`,
      );
      throw new SpotExchangeError(
        `Failed to get best bid/ask: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): ExchangeType {
    return ExchangeType.HYPERLIQUID;
  }

  async placeSpotOrder(request: SpotOrderRequest): Promise<SpotOrderResponse> {
    try {
      this.logger.log(
        `📤 Placing spot ${request.side} order on Hyperliquid: ${request.size} ${request.symbol} @ ${request.price || 'MARKET'} ` +
          `(type: ${request.type})`,
      );

      await this.ensureSymbolConverter();

      const spotCoin = this.formatSpotCoin(request.symbol);
      const baseCoin = spotCoin.replace('-SPOT', '');

      // Get asset ID and decimals
      const assetId = this.symbolConverter!.getAssetId(baseCoin);
      if (assetId === undefined) {
        throw new Error(`Could not find asset ID for "${baseCoin}"`);
      }

      const szDecimals = this.symbolConverter!.getSzDecimals(baseCoin);
      if (szDecimals === undefined) {
        throw new Error(`Could not find szDecimals for "${baseCoin}"`);
      }

      const isBuy = request.side === OrderSide.LONG;
      const formattedSize = formatSize(request.size.toString(), szDecimals);

      // For market orders, use best bid/ask
      let orderPrice: number;
      if (request.price) {
        orderPrice = request.price;
      } else if (request.type === OrderType.MARKET) {
        const { bestBid, bestAsk } = await this.getBestBidAsk(request.symbol);
        orderPrice = request.side === OrderSide.LONG ? bestAsk : bestBid;
        this.logger.debug(`Market order: using ${orderPrice} for ${spotCoin}`);
      } else {
        throw new Error('Price is required for LIMIT orders');
      }

      const formattedPrice = formatPrice(orderPrice.toString(), szDecimals);

      // Determine time in force
      let tif: 'Gtc' | 'Ioc' | 'Alo';
      if (request.timeInForce === TimeInForce.IOC) {
        tif = 'Ioc';
      } else if (request.timeInForce === TimeInForce.FOK) {
        tif = 'Ioc'; // FOK not directly supported, use IOC
      } else {
        tif = 'Gtc';
      }

      const orderType =
        request.type === OrderType.MARKET
          ? { limit: { tif: 'Ioc' } } // Market orders use IOC
          : { limit: { tif } };

      const result = await (this.exchangeClient as any).placeOrder({
        coin: spotCoin,
        is_buy: isBuy,
        sz: formattedSize,
        limit_px: formattedPrice,
        order_type: orderType,
        reduce_only: false,
      });

      if (
        result.response?.type === 'order' &&
        result.response?.data?.statuses
      ) {
        const status = result.response.data.statuses[0];

        if (status?.error) {
          throw new Error(`Order rejected: ${status.error}`);
        }

        const orderId =
          status?.resting?.oid?.toString() ||
          status?.filled?.oid?.toString() ||
          'unknown';

        const filledSize = status?.filled?.totalSz
          ? parseFloat(status.filled.totalSz)
          : 0;

        const averagePrice = status?.filled?.avgPx
          ? parseFloat(status.filled.avgPx)
          : orderPrice;

        const orderStatus = status?.filled
          ? filledSize > 0 && filledSize < request.size
            ? OrderStatus.PARTIALLY_FILLED
            : OrderStatus.FILLED
          : status?.resting
            ? OrderStatus.SUBMITTED
            : OrderStatus.PENDING;

        this.logger.log(
          `✅ Spot order placed: ${orderId} (${orderStatus}) - Filled: ${filledSize}/${request.size}`,
        );

        return new SpotOrderResponse(
          orderId,
          request.symbol,
          request.side,
          orderStatus,
          filledSize,
          averagePrice,
          new Date(),
          request.clientOrderId,
        );
      }

      throw new Error('Unexpected response format from Hyperliquid');
    } catch (error: any) {
      this.logger.error(`Failed to place spot order: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to place spot order: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async getSpotPosition(symbol: string): Promise<SpotPosition | null> {
    const positions = await this.getSpotPositions();
    return (
      positions.find(
        (p) =>
          p.symbol === symbol ||
          p.symbol === symbol.replace('USDT', '').replace('USDC', ''),
      ) || null
    );
  }

  async getSpotPositions(): Promise<SpotPosition[]> {
    try {
      const clearinghouseState = await this.infoClient.clearinghouseState({
        user: this.walletAddress,
      });

      const positions: SpotPosition[] = [];

      if ((clearinghouseState as any).spotBalances) {
        for (const spotBalance of (clearinghouseState as any).spotBalances) {
          const coin = spotBalance.coin || '';
          if (!coin || !coin.includes('-SPOT')) {
            continue; // Skip non-spot assets
          }

          const size = parseFloat(spotBalance.total || '0');
          if (size <= 0) {
            continue; // Skip zero balances
          }

          // Get current price
          const spotPrice = await this.getSpotPrice(coin);

          // For spot, we always have LONG positions (holding the asset)
          // Entry price is current price (we don't track entry for spot)
          const entryPrice = spotPrice;
          const currentPrice = spotPrice;
          const unrealizedPnl = 0; // Spot doesn't have unrealized PnL in the same way

          positions.push(
            new SpotPosition(
              ExchangeType.HYPERLIQUID,
              coin,
              OrderSide.LONG,
              size,
              entryPrice,
              currentPrice,
              unrealizedPnl,
              undefined,
              new Date(),
            ),
          );
        }
      }

      return positions;
    } catch (error: any) {
      this.logger.error(`Failed to get spot positions: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to get spot positions: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async cancelSpotOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      const result = await (this.exchangeClient as any).cancel({
        oid: BigInt(orderId),
        ...(symbol ? { coin: this.formatSpotCoin(symbol) } : {}),
      });

      if (result.status === 'ok') {
        this.logger.log(`✅ Spot order cancelled: ${orderId}`);
        return true;
      }

      return false;
    } catch (error: any) {
      this.logger.error(`Failed to cancel spot order: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to cancel spot order: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async getSpotOrderStatus(
    orderId: string,
    symbol?: string,
  ): Promise<SpotOrderResponse> {
    try {
      const openOrders = await this.infoClient.openOrders({
        user: this.walletAddress,
      });

      const order = openOrders.find((o: any) => {
        const oid =
          typeof o.oid === 'bigint' ? o.oid.toString() : String(o.oid || '');
        return oid === orderId;
      });

      if (!order) {
        // Order not found in open orders, assume it's filled or cancelled
        throw new Error(`Order ${orderId} not found`);
      }

      const coin = order.coin || '';
      const side = order.side === 'B' ? OrderSide.LONG : OrderSide.SHORT;
      const filledSize = parseFloat((order as any).filled || order.sz || '0');
      const totalSize = parseFloat(order.sz || '0');
      const averagePrice = (order as any).avgPx
        ? parseFloat((order as any).avgPx)
        : undefined;

      const status =
        filledSize >= totalSize
          ? OrderStatus.FILLED
          : filledSize > 0
            ? OrderStatus.PARTIALLY_FILLED
            : OrderStatus.SUBMITTED;

      return new SpotOrderResponse(
        orderId,
        coin,
        side,
        status,
        filledSize,
        averagePrice,
        new Date(),
      );
    } catch (error: any) {
      this.logger.error(`Failed to get spot order status: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to get spot order status: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async getSpotBalance(asset: string): Promise<number> {
    try {
      // Check cache first
      const cached = this.spotBalanceCache.get(asset);
      if (cached && Date.now() - cached.timestamp < this.BALANCE_CACHE_TTL) {
        return cached.balance;
      }

      const clearinghouseState = await this.infoClient.clearinghouseState({
        user: this.walletAddress,
      });

      if ((clearinghouseState as any).spotBalances) {
        // Find balance for the asset
        const spotAsset = asset.includes('-SPOT') ? asset : `${asset}-SPOT`;
        const balance = (clearinghouseState as any).spotBalances.find(
          (b: any) => b.coin === spotAsset || b.coin === asset,
        );

        if (balance) {
          const balanceValue = parseFloat(balance.total || '0');
          this.spotBalanceCache.set(asset, {
            balance: balanceValue,
            timestamp: Date.now(),
          });
          return balanceValue;
        }
      }

      // Return 0 if not found
      this.spotBalanceCache.set(asset, { balance: 0, timestamp: Date.now() });
      return 0;
    } catch (error: any) {
      this.logger.error(`Failed to get spot balance: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to get spot balance: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }

  async getSpotPrice(symbol: string): Promise<number> {
    try {
      const spotCoin = this.formatSpotCoin(symbol);
      const allMids = await this.infoClient.allMids();

      const spotPair = allMids[spotCoin];
      if (
        spotPair &&
        typeof spotPair === 'object' &&
        'bid' in spotPair &&
        'ask' in spotPair
      ) {
        const midPrice =
          (parseFloat((spotPair as any).bid || '0') +
            parseFloat((spotPair as any).ask || '0')) /
          2;
        if (midPrice > 0) {
          return midPrice;
        }
      } else if (typeof spotPair === 'string') {
        // If it's a string (mark price), use it directly
        const midPrice = parseFloat(spotPair);
        if (midPrice > 0) {
          return midPrice;
        }
      }

      // Fallback: use mark price from meta
      const meta = await this.infoClient.meta();
      const asset = meta.universe?.find(
        (a: any) => a.name === spotCoin || a.name === symbol,
      );
      if (asset && 'markPx' in asset) {
        return parseFloat((asset as any).markPx);
      }

      throw new Error(`Could not find spot price for ${spotCoin}`);
    } catch (error: any) {
      this.logger.error(`Failed to get spot price: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to get spot price: ${error.message}`,
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
      this.logger.log(
        `Transferring $${amount.toFixed(2)} ${direction} on Hyperliquid...`,
      );

      // Use SDK transfer method
      if (
        typeof (this.exchangeClient as any).transferBetweenSpotAndPerp ===
        'function'
      ) {
        const result = await (
          this.exchangeClient as any
        ).transferBetweenSpotAndPerp(amount, toPerp);

        if (result.status === 'ok') {
          const txHash =
            result.response?.data?.txHash ||
            result.response?.txHash ||
            'unknown';
          this.logger.log(
            `✅ Transfer successful: ${direction} - TX: ${txHash}`,
          );

          // Clear balance cache after transfer
          this.spotBalanceCache.clear();

          return txHash;
        } else {
          const errorMsg =
            result.response?.data?.error ||
            result.response?.error ||
            'Unknown error';
          throw new Error(`Transfer failed: ${errorMsg}`);
        }
      } else {
        throw new Error(
          `transferBetweenSpotAndPerp method not available in @nktkas/hyperliquid SDK. ` +
            `Hyperliquid internal transfers require signed actions.`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to transfer ${toPerp ? 'spot → perp' : 'perp → spot'}: ${error.message}`,
      );
      throw new SpotExchangeError(
        `Failed to transfer: ${error.message}`,
        ExchangeType.HYPERLIQUID,
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
      await this.infoClient.meta();
    } catch (error: any) {
      throw new SpotExchangeError(
        `Connection test failed: ${error.message}`,
        ExchangeType.HYPERLIQUID,
        undefined,
        error,
      );
    }
  }
}
