import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
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
import { ExtendedSigningService } from './ExtendedSigningService';

/**
 * ExtendedSpotAdapter - Implements ISpotExchangeAdapter for Extended exchange
 *
 * Extended is a Starknet-based exchange. Spot trading endpoints may need verification.
 * Uses REST API with SNIP12/EIP712 signing for authenticated requests.
 */
@Injectable()
export class ExtendedSpotAdapter implements ISpotExchangeAdapter {
  private readonly logger = new Logger(ExtendedSpotAdapter.name);
  private readonly config: ExchangeConfig;
  private readonly client: AxiosInstance;
  private readonly signingService: ExtendedSigningService;
  private readonly apiKey: string;
  private readonly starkPublicKey: string;
  private readonly vaultNumber: number;
  private readonly isTestnet: boolean;

  constructor(private readonly configService: ConfigService) {
    const baseUrl =
      this.configService.get<string>('EXTENDED_API_BASE_URL') ||
      'https://api.starknet.extended.exchange';
    const apiKey = this.configService.get<string>('EXTENDED_API_KEY');
    const starkPrivateKey =
      this.configService.get<string>('EXTENDED_STARK_PRIVATE_KEY') ||
      this.configService.get<string>('EXTENDED_STARK_KEY');
    const starkPublicKey = this.configService.get<string>(
      'EXTENDED_STARK_PUBLIC_KEY',
    );
    const vaultNumber = parseInt(
      this.configService.get<string>('EXTENDED_VAULT_NUMBER') || '0',
    );
    const isTestnet =
      this.configService.get<string>('EXTENDED_TESTNET') === 'true';

    if (!apiKey) {
      throw new Error('Extended spot adapter requires EXTENDED_API_KEY');
    }
    if (!starkPrivateKey) {
      throw new Error(
        'Extended spot adapter requires EXTENDED_STARK_PRIVATE_KEY',
      );
    }
    if (!starkPublicKey) {
      throw new Error(
        'Extended spot adapter requires EXTENDED_STARK_PUBLIC_KEY',
      );
    }
    if (vaultNumber === 0) {
      throw new Error('Extended spot adapter requires EXTENDED_VAULT_NUMBER');
    }

    this.apiKey = apiKey;
    this.starkPublicKey = starkPublicKey.startsWith('0x')
      ? starkPublicKey
      : `0x${starkPublicKey}`;
    this.vaultNumber = vaultNumber;
    this.isTestnet = isTestnet;

    this.signingService = new ExtendedSigningService(
      starkPrivateKey,
      isTestnet,
    );

    this.config = new ExchangeConfig(
      ExchangeType.EXTENDED,
      baseUrl,
      apiKey,
      undefined, // apiSecret
      undefined, // privateKey
      undefined, // userAddress
      undefined, // signerAddress
      undefined, // accountIndex
      undefined, // apiKeyIndex
      undefined, // recvWindow
      starkPrivateKey, // starkKey
      vaultNumber, // vaultNumber
      undefined, // starknetRpcUrl
      undefined, // rateLimitRps
      undefined, // timeout
      isTestnet, // testnet
    );

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'Bloom-Vault-Bot/1.0',
      },
    });
  }

  /**
   * Format symbol for Extended (may need adjustment based on actual API)
   */
  private formatSymbol(symbol: string): string {
    // Extended may use different format - adjust as needed
    if (symbol.includes('-USD') || symbol.includes('-USDT')) {
      return symbol;
    }
    return `${symbol}-USD`;
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): ExchangeType {
    return ExchangeType.EXTENDED;
  }

  async placeSpotOrder(request: SpotOrderRequest): Promise<SpotOrderResponse> {
    try {
      this.logger.log(
        `📤 Placing spot ${request.side} order on Extended: ${request.size} ${request.symbol} @ ${request.price || 'MARKET'}`,
      );

      const symbol = this.formatSymbol(request.symbol);

      // Extended spot order endpoint (may need verification)
      // Using similar structure to perp orders
      const orderDataForSigning = {
        symbol,
        side: (request.side === OrderSide.LONG ? 'buy' : 'sell') as
          | 'buy'
          | 'sell',
        orderType: (request.type === OrderType.MARKET ? 'market' : 'limit') as
          | 'limit'
          | 'market',
        size: request.size.toString(),
        price: request.price?.toString(),
        timeInForce: request.timeInForce || TimeInForce.GTC,
      };

      // Sign the order (Extended uses SNIP12/EIP712)
      const signature =
        await this.signingService.signOrder(orderDataForSigning);

      const orderData = {
        symbol,
        side: request.side === OrderSide.LONG ? 'BUY' : 'SELL',
        type: request.type === OrderType.MARKET ? 'MARKET' : 'LIMIT',
        quantity: request.size.toString(),
        price: request.price?.toString(),
        timeInForce: request.timeInForce || TimeInForce.GTC,
        vaultNumber: this.vaultNumber,
      };

      const response = await this.client.post('/api/v1/spot/order', {
        ...orderData,
        signature,
        publicKey: this.starkPublicKey,
      });

      if (response.data && response.data.orderId) {
        const orderId = response.data.orderId.toString();
        const filledSize = parseFloat(response.data.executedQty || '0');
        const averagePrice = response.data.avgPrice
          ? parseFloat(response.data.avgPrice)
          : undefined;

        const status =
          response.data.status === 'FILLED'
            ? OrderStatus.FILLED
            : response.data.status === 'PARTIALLY_FILLED'
              ? OrderStatus.PARTIALLY_FILLED
              : OrderStatus.SUBMITTED;

        this.logger.log(`✅ Spot order placed: ${orderId} (${status})`);

        return new SpotOrderResponse(
          orderId,
          request.symbol,
          request.side,
          status,
          filledSize,
          averagePrice,
          new Date(),
          request.clientOrderId,
        );
      }

      throw new Error(`Unexpected response: ${JSON.stringify(response.data)}`);
    } catch (error: any) {
      this.logger.error(`Failed to place spot order: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to place spot order: ${error.message}`,
        ExchangeType.EXTENDED,
        undefined,
        error,
      );
    }
  }

  async getSpotPosition(symbol: string): Promise<SpotPosition | null> {
    const positions = await this.getSpotPositions();
    const formattedSymbol = this.formatSymbol(symbol);
    return (
      positions.find(
        (p) => p.symbol === formattedSymbol || p.symbol === symbol,
      ) || null
    );
  }

  async getSpotPositions(): Promise<SpotPosition[]> {
    try {
      const response = await this.client.get('/api/v1/spot/positions', {
        params: {
          vaultNumber: this.vaultNumber,
        },
      });

      const positions: SpotPosition[] = [];

      if (Array.isArray(response.data?.data || response.data)) {
        const data = response.data?.data || response.data;
        for (const position of data) {
          const asset = position.asset || position.symbol || '';
          const size = parseFloat(position.size || position.quantity || '0');

          if (size > 0) {
            const price = await this.getSpotPrice(asset);

            positions.push(
              new SpotPosition(
                ExchangeType.EXTENDED,
                asset,
                OrderSide.LONG,
                size,
                price,
                price,
                0,
                undefined,
                new Date(),
              ),
            );
          }
        }
      }

      return positions;
    } catch (error: any) {
      this.logger.error(`Failed to get spot positions: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to get spot positions: ${error.message}`,
        ExchangeType.EXTENDED,
        undefined,
        error,
      );
    }
  }

  async cancelSpotOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      const params: Record<string, any> = {
        orderId,
        vaultNumber: this.vaultNumber,
      };

      if (symbol) {
        params.symbol = this.formatSymbol(symbol);
      }

      const response = await this.client.delete('/api/v1/spot/order', {
        params,
      });

      return response.data && response.data.status === 'CANCELED';
    } catch (error: any) {
      this.logger.error(`Failed to cancel spot order: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to cancel spot order: ${error.message}`,
        ExchangeType.EXTENDED,
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
      const params: Record<string, any> = {
        orderId,
        vaultNumber: this.vaultNumber,
      };

      if (symbol) {
        params.symbol = this.formatSymbol(symbol);
      }

      const response = await this.client.get('/api/v1/spot/order', { params });

      if (response.data) {
        const side =
          response.data.side === 'BUY' ? OrderSide.LONG : OrderSide.SHORT;
        const filledSize = parseFloat(response.data.executedQty || '0');
        const averagePrice = response.data.avgPrice
          ? parseFloat(response.data.avgPrice)
          : undefined;

        const status =
          response.data.status === 'FILLED'
            ? OrderStatus.FILLED
            : response.data.status === 'PARTIALLY_FILLED'
              ? OrderStatus.PARTIALLY_FILLED
              : response.data.status === 'CANCELED'
                ? OrderStatus.CANCELLED
                : OrderStatus.SUBMITTED;

        return new SpotOrderResponse(
          orderId,
          response.data.symbol || symbol || '',
          side,
          status,
          filledSize,
          averagePrice,
          new Date(),
        );
      }

      throw new Error(`Order ${orderId} not found`);
    } catch (error: any) {
      this.logger.error(`Failed to get spot order status: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to get spot order status: ${error.message}`,
        ExchangeType.EXTENDED,
        undefined,
        error,
      );
    }
  }

  async getSpotBalance(asset: string): Promise<number> {
    try {
      const response = await this.client.get('/api/v1/spot/balance', {
        params: {
          asset,
          vaultNumber: this.vaultNumber,
        },
      });

      if (response.data) {
        const balance = response.data.balance || response.data.available || '0';
        return parseFloat(balance);
      }

      return 0;
    } catch (error: any) {
      this.logger.error(`Failed to get spot balance: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to get spot balance: ${error.message}`,
        ExchangeType.EXTENDED,
        undefined,
        error,
      );
    }
  }

  async getSpotPrice(symbol: string): Promise<number> {
    try {
      const formattedSymbol = this.formatSymbol(symbol);
      const response = await this.client.get('/api/v1/spot/ticker/price', {
        params: { symbol: formattedSymbol },
      });

      if (response.data && response.data.price) {
        return parseFloat(response.data.price);
      }

      throw new Error(`Could not find spot price for ${formattedSymbol}`);
    } catch (error: any) {
      this.logger.error(`Failed to get spot price: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to get spot price: ${error.message}`,
        ExchangeType.EXTENDED,
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

      // Extended uses vault-based system, internal transfers are between vaults
      const transferData = {
        asset: 'USDC',
        amount: amount.toString(),
        toVault: toPerp ? this.vaultNumber : 0, // Simplified - adjust based on actual API
        fromVault: toPerp ? 0 : this.vaultNumber,
      };

      const signature = await this.signingService.signTransfer(transferData);

      const response = await this.client.post('/api/v1/user/transfer', {
        ...transferData,
        signature,
      });

      if (response.data && response.data.transferId) {
        return response.data.transferId.toString();
      }
      throw new Error(`Transfer failed: ${JSON.stringify(response.data)}`);
    } catch (error: any) {
      const errorMsg =
        error.response?.data?.message || error.message || String(error);
      throw new SpotExchangeError(
        `Failed to transfer: ${errorMsg}`,
        ExchangeType.EXTENDED,
        error.response?.data?.code,
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
      await this.client.get('/api/v1/ping');
    } catch (error: any) {
      throw new SpotExchangeError(
        `Connection test failed: ${error.message}`,
        ExchangeType.EXTENDED,
        undefined,
        error,
      );
    }
  }
}
