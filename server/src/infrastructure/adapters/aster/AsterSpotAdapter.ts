import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import * as crypto from 'crypto';
import { ExchangeConfig, ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import {
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForce,
} from '../../../domain/value-objects/PerpOrder';
import { SpotOrderRequest, SpotOrderResponse } from '../../../domain/value-objects/SpotOrder';
import { SpotPosition } from '../../../domain/entities/SpotPosition';
import { ISpotExchangeAdapter, SpotExchangeError } from '../../../domain/ports/ISpotExchangeAdapter';

/**
 * AsterSpotAdapter - Implements ISpotExchangeAdapter for Aster DEX
 * 
 * Uses REST API with EIP-712 signing for authenticated requests
 * Spot endpoints: /api/v1/spot/... (may need verification)
 */
@Injectable()
export class AsterSpotAdapter implements ISpotExchangeAdapter {
  private readonly logger = new Logger(AsterSpotAdapter.name);
  private readonly config: ExchangeConfig;
  private readonly client: AxiosInstance;
  private readonly wallet: ethers.Wallet | null;
  private readonly apiKey: string | undefined;
  private readonly apiSecret: string | undefined;

  constructor(private readonly configService: ConfigService) {
    let baseUrl = this.configService.get<string>('ASTER_BASE_URL') || 'https://fapi.asterdex.com';
    baseUrl = baseUrl.replace(/\/$/, '');
    const user = this.configService.get<string>('ASTER_USER');
    const signer = this.configService.get<string>('ASTER_SIGNER');
    const privateKey = this.configService.get<string>('ASTER_PRIVATE_KEY');
    const apiKey = this.configService.get<string>('ASTER_API_KEY');
    const apiSecret = this.configService.get<string>('ASTER_API_SECRET');

    if (!user || !signer || !privateKey) {
      if (!apiKey || !apiSecret) {
        this.logger.warn(
          'Aster spot adapter requires either (ASTER_USER, ASTER_SIGNER, ASTER_PRIVATE_KEY) ' +
          'or (ASTER_API_KEY, ASTER_API_SECRET) for authentication'
        );
      }
    }

    this.apiKey = apiKey;
    this.apiSecret = apiSecret;

    this.config = new ExchangeConfig(
      ExchangeType.ASTER,
      baseUrl,
      user,
      signer,
      privateKey,
      apiKey,
      apiSecret,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );

    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
    });

    if (privateKey) {
      const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      this.wallet = new ethers.Wallet(normalizedPrivateKey);
    } else {
      this.wallet = null;
    }
  }

  /**
   * Sign parameters with EIP-712 (Ethereum signature)
   */
  private signParams(params: Record<string, any>, nonce: number): Record<string, any> {
    if (!this.wallet || !this.config.userAddress || !this.config.signerAddress) {
      throw new Error('Ethereum signature authentication requires wallet, user, and signer');
    }

    const cleanParams = { ...params };
    const jsonStr = JSON.stringify(cleanParams);

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
      ['string', 'address', 'address', 'uint256'],
      [jsonStr, this.config.userAddress!, this.config.signerAddress!, nonce],
    );

    const keccakHash = ethers.keccak256(encoded);
    const hashBytes = ethers.getBytes(keccakHash);

    const prefix = '\x19Ethereum Signed Message:\n';
    const lengthStr = hashBytes.length.toString();
    const message = ethers.concat([
      ethers.toUtf8Bytes(prefix),
      ethers.toUtf8Bytes(lengthStr),
      hashBytes,
    ]);

    const messageHash = ethers.keccak256(message);
    const signature = this.wallet.signingKey.sign(ethers.getBytes(messageHash));

    const signatureHex = ethers.Signature.from({
      r: signature.r,
      s: signature.s,
      v: signature.v,
    }).serialized;

    return {
      ...cleanParams,
      nonce,
      user: this.config.userAddress,
      signer: this.config.signerAddress,
      signature: signatureHex,
    };
  }

  /**
   * Sign parameters with API key (HMAC)
   */
  private signParamsWithApiKey(params: Record<string, any>): Record<string, any> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('API key authentication requires ASTER_API_KEY and ASTER_API_SECRET');
    }

    const timestamp = Date.now();
    const queryString = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&');

    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');

    return {
      ...params,
      timestamp,
      signature,
    };
  }

  /**
   * Format symbol for Aster (e.g., "ETH" -> "ETHUSDT")
   */
  private formatSymbol(symbol: string): string {
    if (symbol.includes('USDT') || symbol.includes('USDC')) {
      return symbol;
    }
    return `${symbol}USDT`;
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): ExchangeType {
    return ExchangeType.ASTER;
  }

  async placeSpotOrder(request: SpotOrderRequest): Promise<SpotOrderResponse> {
    try {
      this.logger.log(
        `📤 Placing spot ${request.side} order on Aster: ${request.size} ${request.symbol} @ ${request.price || 'MARKET'}`
      );

      const symbol = this.formatSymbol(request.symbol);
      const nonce = Math.floor(Date.now() * 1000);

      const params: Record<string, any> = {
        symbol,
        side: request.side === OrderSide.LONG ? 'BUY' : 'SELL',
        type: request.type === OrderType.MARKET ? 'MARKET' : 'LIMIT',
        quantity: request.size.toString(),
      };

      if (request.type === OrderType.LIMIT && request.price) {
        params.price = request.price.toString();
        params.timeInForce = request.timeInForce || TimeInForce.GTC;
      }

      let signedParams: Record<string, any>;
      let headers: Record<string, string> = {};

      if (this.apiKey && this.apiSecret) {
        signedParams = this.signParamsWithApiKey(params);
        headers['X-MBX-APIKEY'] = this.apiKey;
      } else if (this.wallet) {
        signedParams = this.signParams(params, nonce);
      } else {
        throw new Error('Authentication required for spot orders');
      }

      // Aster spot endpoint (may need verification)
      const response = await this.client.post('/api/v1/spot/order', signedParams, { headers });

      if (response.data && response.data.orderId) {
        const orderId = response.data.orderId.toString();
        const filledSize = parseFloat(response.data.executedQty || '0');
        const averagePrice = response.data.avgPrice ? parseFloat(response.data.avgPrice) : undefined;

        const status = response.data.status === 'FILLED'
          ? OrderStatus.FILLED
          : (response.data.status === 'PARTIALLY_FILLED'
            ? OrderStatus.PARTIALLY_FILLED
            : OrderStatus.SUBMITTED);

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
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async getSpotPosition(symbol: string): Promise<SpotPosition | null> {
    const positions = await this.getSpotPositions();
    const formattedSymbol = this.formatSymbol(symbol);
    return positions.find(p => p.symbol === formattedSymbol || p.symbol === symbol) || null;
  }

  async getSpotPositions(): Promise<SpotPosition[]> {
    try {
      const nonce = Math.floor(Date.now() * 1000);
      const params = {};

      let signedParams: Record<string, any>;
      let headers: Record<string, string> = {};

      if (this.apiKey && this.apiSecret) {
        signedParams = this.signParamsWithApiKey(params);
        headers['X-MBX-APIKEY'] = this.apiKey;
      } else if (this.wallet) {
        signedParams = this.signParams(params, nonce);
      } else {
        throw new Error('Authentication required for spot positions');
      }

      // Aster spot balance endpoint (may need verification)
      const response = await this.client.get('/api/v1/spot/balance', {
        params: signedParams,
        headers,
      });

      const positions: SpotPosition[] = [];

      if (Array.isArray(response.data)) {
        for (const balance of response.data) {
          const asset = balance.asset || '';
          const free = parseFloat(balance.free || '0');
          const locked = parseFloat(balance.locked || '0');
          const total = free + locked;

          if (total > 0 && asset !== 'USDT' && asset !== 'USDC') {
            // Get current price
            const price = await this.getSpotPrice(asset);

            positions.push(
              new SpotPosition(
                ExchangeType.ASTER,
                asset,
                OrderSide.LONG,
                total,
                price,
                price,
                0, // No unrealized PnL for spot
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
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async cancelSpotOrder(orderId: string, symbol?: string): Promise<boolean> {
    try {
      const nonce = Math.floor(Date.now() * 1000);
      const params: Record<string, any> = {
        orderId,
      };

      if (symbol) {
        params.symbol = this.formatSymbol(symbol);
      }

      let signedParams: Record<string, any>;
      let headers: Record<string, string> = {};

      if (this.apiKey && this.apiSecret) {
        signedParams = this.signParamsWithApiKey(params);
        headers['X-MBX-APIKEY'] = this.apiKey;
      } else if (this.wallet) {
        signedParams = this.signParams(params, nonce);
      } else {
        throw new Error('Authentication required to cancel spot order');
      }

      const response = await this.client.delete('/api/v1/spot/order', {
        params: signedParams,
        headers,
      });

      return response.data && response.data.status === 'CANCELED';
    } catch (error: any) {
      this.logger.error(`Failed to cancel spot order: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to cancel spot order: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async getSpotOrderStatus(orderId: string, symbol?: string): Promise<SpotOrderResponse> {
    try {
      const nonce = Math.floor(Date.now() * 1000);
      const params: Record<string, any> = {
        orderId,
      };

      if (symbol) {
        params.symbol = this.formatSymbol(symbol);
      }

      let signedParams: Record<string, any>;
      let headers: Record<string, string> = {};

      if (this.apiKey && this.apiSecret) {
        signedParams = this.signParamsWithApiKey(params);
        headers['X-MBX-APIKEY'] = this.apiKey;
      } else if (this.wallet) {
        signedParams = this.signParams(params, nonce);
      } else {
        throw new Error('Authentication required for spot order status');
      }

      const response = await this.client.get('/api/v1/spot/order', {
        params: signedParams,
        headers,
      });

      if (response.data) {
        const side = response.data.side === 'BUY' ? OrderSide.LONG : OrderSide.SHORT;
        const filledSize = parseFloat(response.data.executedQty || '0');
        const averagePrice = response.data.avgPrice ? parseFloat(response.data.avgPrice) : undefined;

        const status = response.data.status === 'FILLED'
          ? OrderStatus.FILLED
          : (response.data.status === 'PARTIALLY_FILLED'
            ? OrderStatus.PARTIALLY_FILLED
            : (response.data.status === 'CANCELED'
              ? OrderStatus.CANCELLED
              : OrderStatus.SUBMITTED));

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
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async getSpotBalance(asset: string): Promise<number> {
    try {
      const nonce = Math.floor(Date.now() * 1000);
      const params = {};

      let signedParams: Record<string, any>;
      let headers: Record<string, string> = {};

      if (this.apiKey && this.apiSecret) {
        signedParams = this.signParamsWithApiKey(params);
        headers['X-MBX-APIKEY'] = this.apiKey;
      } else if (this.wallet) {
        signedParams = this.signParams(params, nonce);
      } else {
        this.logger.warn('Authentication required for spot balance');
        return 0;
      }

      const response = await this.client.get('/api/v1/spot/balance', {
        params: signedParams,
        headers,
      });

      if (Array.isArray(response.data)) {
        const balance = response.data.find((b: any) => b.asset === asset);
        if (balance) {
          const free = parseFloat(balance.free || '0');
          const locked = parseFloat(balance.locked || '0');
          return free + locked;
        }
      }

      return 0;
    } catch (error: any) {
      this.logger.error(`Failed to get spot balance: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to get spot balance: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }

  async getSpotPrice(symbol: string): Promise<number> {
    try {
      const formattedSymbol = this.formatSymbol(symbol);
      const response = await this.client.get('/api/v1/ticker/price', {
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
        ExchangeType.ASTER,
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

      // Aster API: type 1 = spot to futures, type 2 = futures to spot
      const transferType = toPerp ? 1 : 2;
      const direction = toPerp ? 'spot → futures' : 'futures → spot';
      this.logger.log(`Transferring $${amount.toFixed(2)} ${direction} on Aster...`);

      let params: Record<string, any>;
      let headers: Record<string, string> = {};

      if (this.apiKey && this.apiSecret) {
        params = this.signParamsWithApiKey({
          asset: 'USDT',
          amount: amount.toString(),
          type: transferType,
        });
        headers['X-MBX-APIKEY'] = this.apiKey;
      } else {
        throw new Error('API key and secret required for transfers. Provide ASTER_API_KEY and ASTER_API_SECRET.');
      }

      const queryParams: string[] = [];
      const signatureParam: string[] = [];
      for (const [key, value] of Object.entries(params)) {
        if (key === 'signature') {
          signatureParam.push(`${key}=${value}`);
        } else {
          queryParams.push(`${key}=${value}`);
        }
      }
      queryParams.sort();
      const finalQueryString = queryParams.join('&') + (signatureParam.length > 0 ? `&${signatureParam[0]}` : '');

      const response = await this.client.post(`/fapi/v1/transfer?${finalQueryString}`, {}, { headers });

      if (response.data && response.data.tranId) {
        const tranId = response.data.tranId;
        this.logger.log(`✅ Transfer successful: ${direction} - Transaction ID: ${tranId}`);
        return tranId.toString();
      } else {
        throw new Error(`Transfer failed: ${JSON.stringify(response.data)}`);
      }
    } catch (error: any) {
      this.logger.error(`Failed to transfer ${toPerp ? 'spot → futures' : 'futures → spot'}: ${error.message}`);
      throw new SpotExchangeError(
        `Failed to transfer: ${error.message}`,
        ExchangeType.ASTER,
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
      await this.client.get('/api/v1/ping');
    } catch (error: any) {
      throw new SpotExchangeError(
        `Connection test failed: ${error.message}`,
        ExchangeType.ASTER,
        undefined,
        error,
      );
    }
  }
}





