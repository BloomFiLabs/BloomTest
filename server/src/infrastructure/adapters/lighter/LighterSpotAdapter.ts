import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 * LighterSpotAdapter - Implements ISpotExchangeAdapter for Lighter Protocol
 * 
 * Note: Lighter may not support spot trading. This adapter will return errors
 * if spot trading is not available. Check Lighter documentation for spot support.
 */
@Injectable()
export class LighterSpotAdapter implements ISpotExchangeAdapter {
  private readonly logger = new Logger(LighterSpotAdapter.name);
  private readonly config: ExchangeConfig;

  constructor(private readonly configService: ConfigService) {
    const baseUrl = this.configService.get<string>('LIGHTER_API_BASE_URL') || 'https://mainnet.zklighter.elliot.ai';
    const apiKey = this.configService.get<string>('LIGHTER_API_KEY');
    const accountIndex = parseInt(this.configService.get<string>('LIGHTER_ACCOUNT_INDEX') || '1000');

    if (!apiKey) {
      throw new Error('Lighter spot adapter requires LIGHTER_API_KEY');
    }

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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
  }

  private throwNotSupported(): never {
    throw new SpotExchangeError(
      'Spot trading is not supported on Lighter Protocol. ' +
      'Please verify if Lighter has added spot trading support.',
      ExchangeType.LIGHTER,
      'SPOT_NOT_SUPPORTED',
    );
  }

  getConfig(): ExchangeConfig {
    return this.config;
  }

  getExchangeType(): ExchangeType {
    return ExchangeType.LIGHTER;
  }

  async placeSpotOrder(request: SpotOrderRequest): Promise<SpotOrderResponse> {
    this.logger.warn('Lighter spot trading not supported');
    this.throwNotSupported();
  }

  async getSpotPosition(symbol: string): Promise<SpotPosition | null> {
    this.throwNotSupported();
  }

  async getSpotPositions(): Promise<SpotPosition[]> {
    this.throwNotSupported();
  }

  async cancelSpotOrder(orderId: string, symbol?: string): Promise<boolean> {
    this.throwNotSupported();
  }

  async getSpotOrderStatus(orderId: string, symbol?: string): Promise<SpotOrderResponse> {
    this.throwNotSupported();
  }

  async getSpotBalance(asset: string): Promise<number> {
    this.throwNotSupported();
  }

  async getSpotPrice(symbol: string): Promise<number> {
    this.throwNotSupported();
  }

  async transferInternal(amount: number, toPerp: boolean): Promise<string> {
    this.throwNotSupported();
  }

  async isReady(): Promise<boolean> {
    return false; // Not supported
  }

  async testConnection(): Promise<void> {
    // Connection test passes, but spot trading is not supported
    // This allows the adapter to be instantiated without errors
  }
}

