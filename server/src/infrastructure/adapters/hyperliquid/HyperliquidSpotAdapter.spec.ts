import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import {
  SpotOrderRequest,
  SpotOrderResponse,
} from '../../../domain/value-objects/SpotOrder';
import {
  OrderSide,
  OrderType,
  OrderStatus,
  TimeInForce,
} from '../../../domain/value-objects/PerpOrder';
import { SpotExchangeError } from '../../../domain/ports/ISpotExchangeAdapter';

// Mock the Hyperliquid SDK modules before importing the adapter
jest.mock('@nktkas/hyperliquid', () => ({
  HttpTransport: jest.fn().mockImplementation(() => ({})),
  ExchangeClient: jest.fn().mockImplementation(() => ({
    placeOrder: jest.fn(),
    cancel: jest.fn(),
  })),
  InfoClient: jest.fn().mockImplementation(() => ({
    allMids: jest.fn(),
    meta: jest.fn(),
    clearinghouseState: jest.fn(),
    openOrders: jest.fn(),
  })),
}));

jest.mock('@nktkas/hyperliquid/utils', () => ({
  SymbolConverter: {
    create: jest.fn(),
  },
  formatSize: jest.fn((size: string) => size),
  formatPrice: jest.fn((price: string) => price),
}));

jest.mock('ethers', () => ({
  ethers: {
    Wallet: jest.fn().mockImplementation(() => ({
      address: '0x' + '1'.repeat(40),
    })),
  },
}));

import { HyperliquidSpotAdapter } from './HyperliquidSpotAdapter';
import { HttpTransport, ExchangeClient, InfoClient } from '@nktkas/hyperliquid';
import { SymbolConverter } from '@nktkas/hyperliquid/utils';
import { ethers } from 'ethers';

describe('HyperliquidSpotAdapter', () => {
  let adapter: HyperliquidSpotAdapter;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockTransport: jest.Mocked<HttpTransport>;
  let mockExchangeClient: jest.Mocked<ExchangeClient>;
  let mockInfoClient: jest.Mocked<InfoClient>;
  let mockSymbolConverter: jest.Mocked<SymbolConverter>;
  let mockWallet: any;

  beforeEach(async () => {
    mockWallet = {
      address: '0x' + '1'.repeat(40),
    };

    mockTransport = {} as any;
    mockExchangeClient = {
      placeOrder: jest.fn(),
      cancel: jest.fn(),
    } as any;
    mockInfoClient = {
      allMids: jest.fn(),
      meta: jest.fn(),
      clearinghouseState: jest.fn(),
      openOrders: jest.fn(),
    } as any;
    mockSymbolConverter = {
      getAssetId: jest.fn(),
      getSzDecimals: jest.fn(),
    } as any;

    (SymbolConverter.create as jest.Mock).mockResolvedValue(
      mockSymbolConverter,
    );
    (HttpTransport as jest.Mock).mockImplementation(() => mockTransport);
    (ExchangeClient as jest.Mock).mockImplementation(() => mockExchangeClient);
    (InfoClient as jest.Mock).mockImplementation(() => mockInfoClient);
    (ethers.Wallet as jest.Mock).mockImplementation(() => mockWallet);

    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          PRIVATE_KEY:
            '0x1234567890123456789012345678901234567890123456789012345678901234',
          HYPERLIQUID_TESTNET: false,
        };
        return config[key];
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HyperliquidSpotAdapter,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    adapter = module.get<HyperliquidSpotAdapter>(HyperliquidSpotAdapter);
  });

  describe('getConfig', () => {
    it('should return correct config', () => {
      const config = adapter.getConfig();
      expect(config.exchangeType).toBe(ExchangeType.HYPERLIQUID);
    });
  });

  describe('getExchangeType', () => {
    it('should return HYPERLIQUID', () => {
      expect(adapter.getExchangeType()).toBe(ExchangeType.HYPERLIQUID);
    });
  });

  describe('placeSpotOrder', () => {
    it('should place a market buy order', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(4);
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
      });

      mockExchangeClient.placeOrder.mockResolvedValue({
        response: {
          type: 'order',
          data: {
            statuses: [
              {
                filled: {
                  oid: BigInt('12345'),
                  totalSz: '1.0',
                  avgPx: '3000.5',
                },
              },
            ],
          },
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );

      const response = await adapter.placeSpotOrder(request);

      expect(response.orderId).toBe('12345');
      expect(response.status).toBe(OrderStatus.FILLED);
      expect(response.filledSize).toBe(1.0);
      expect(response.averagePrice).toBe(3000.5);
    });

    it('should place a limit sell order', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(4);

      mockExchangeClient.placeOrder.mockResolvedValue({
        response: {
          type: 'order',
          data: {
            statuses: [
              {
                resting: {
                  oid: BigInt('67890'),
                },
              },
            ],
          },
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.SHORT,
        OrderType.LIMIT,
        1.0,
        3100,
        TimeInForce.GTC,
      );

      const response = await adapter.placeSpotOrder(request);

      expect(response.orderId).toBe('67890');
      expect(response.status).toBe(OrderStatus.SUBMITTED);
    });

    it('should throw SpotExchangeError on order rejection', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(4);
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
      });

      mockExchangeClient.placeOrder.mockResolvedValue({
        response: {
          type: 'order',
          data: {
            statuses: [
              {
                error: 'Insufficient balance',
              },
            ],
          },
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );

      await expect(adapter.placeSpotOrder(request)).rejects.toThrow(
        SpotExchangeError,
      );
    });
  });

  describe('getSpotPosition', () => {
    it('should return position for symbol', async () => {
      // Mock getSpotPositions which calls clearinghouseState and getSpotPrice
      mockInfoClient.clearinghouseState.mockResolvedValue({
        spotBalances: [
          {
            coin: 'ETH-SPOT',
            total: '1.5',
          },
        ],
      });
      // Mock allMids for getSpotPrice call (called internally by getSpotPositions)
      // getSpotPrice is called with 'ETH-SPOT' (the coin from spotBalances)
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
      });

      // getSpotPosition('ETH') will call getSpotPositions() which returns positions with symbol 'ETH-SPOT'
      // Then it tries to find a match: p.symbol === 'ETH' || p.symbol === 'ETH'.replace('USDT', '').replace('USDC', '')
      // Since position.symbol is 'ETH-SPOT', it won't match 'ETH', so we need to search for 'ETH-SPOT'
      const position = await adapter.getSpotPosition('ETH-SPOT');

      expect(position).not.toBeNull();
      if (position) {
        expect(position.symbol).toBe('ETH-SPOT');
        expect(position.size).toBe(1.5);
      }
      // Verify clearinghouseState was called
      expect(mockInfoClient.clearinghouseState).toHaveBeenCalled();
    });

    it('should return null if no position exists', async () => {
      mockInfoClient.clearinghouseState.mockResolvedValue({
        spotBalances: [],
      });

      const position = await adapter.getSpotPosition('ETH');

      expect(position).toBeNull();
    });
  });

  describe('getSpotPositions', () => {
    it('should return all spot positions', async () => {
      mockInfoClient.clearinghouseState.mockResolvedValue({
        spotBalances: [
          {
            coin: 'ETH-SPOT',
            total: '1.5',
          },
          {
            coin: 'BTC-SPOT',
            total: '0.1',
          },
        ],
      });
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
        'BTC-SPOT': { bid: '50000', ask: '50001' },
      });

      const positions = await adapter.getSpotPositions();

      expect(positions.length).toBe(2);
      expect(positions[0].symbol).toBe('ETH-SPOT');
      expect(positions[1].symbol).toBe('BTC-SPOT');
    });
  });

  describe('cancelSpotOrder', () => {
    it('should cancel order successfully', async () => {
      mockExchangeClient.cancel.mockResolvedValue({
        status: 'ok',
      });

      const result = await adapter.cancelSpotOrder('12345', 'ETH');

      expect(result).toBe(true);
      expect(mockExchangeClient.cancel).toHaveBeenCalledWith({
        coin: 'ETH-SPOT',
        oid: BigInt('12345'),
      });
    });

    it('should throw SpotExchangeError on cancellation failure', async () => {
      mockExchangeClient.cancel.mockRejectedValue(new Error('Order not found'));

      await expect(adapter.cancelSpotOrder('12345')).rejects.toThrow(
        SpotExchangeError,
      );
    });
  });

  describe('getSpotOrderStatus', () => {
    it('should return order status', async () => {
      mockInfoClient.openOrders.mockResolvedValue([
        {
          oid: BigInt('12345'),
          coin: 'ETH-SPOT',
          side: 'B',
          sz: '1.0',
          filled: '0.5',
          avgPx: '3000.5',
        },
      ]);

      const response = await adapter.getSpotOrderStatus('12345');

      expect(response.orderId).toBe('12345');
      expect(response.status).toBe(OrderStatus.PARTIALLY_FILLED);
      expect(response.filledSize).toBe(0.5);
    });

    it('should throw error if order not found', async () => {
      mockInfoClient.openOrders.mockResolvedValue([]);

      await expect(adapter.getSpotOrderStatus('12345')).rejects.toThrow();
    });
  });

  describe('getSpotBalance', () => {
    it('should return spot balance', async () => {
      mockInfoClient.clearinghouseState.mockResolvedValue({
        spotBalances: [
          {
            coin: 'ETH-SPOT',
            total: '2.5',
          },
        ],
      });

      const balance = await adapter.getSpotBalance('ETH');

      expect(balance).toBe(2.5);
    });

    it('should return 0 if balance not found', async () => {
      mockInfoClient.clearinghouseState.mockResolvedValue({
        spotBalances: [],
      });

      const balance = await adapter.getSpotBalance('ETH');

      expect(balance).toBe(0);
    });

    it('should use cache for repeated calls', async () => {
      mockInfoClient.clearinghouseState.mockResolvedValue({
        spotBalances: [
          {
            coin: 'ETH-SPOT',
            total: '2.5',
          },
        ],
      });

      await adapter.getSpotBalance('ETH');
      await adapter.getSpotBalance('ETH');

      // Should only call once due to cache
      expect(mockInfoClient.clearinghouseState).toHaveBeenCalledTimes(1);
    });
  });

  describe('getSpotPrice', () => {
    it('should return spot price from allMids', async () => {
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
      });

      const price = await adapter.getSpotPrice('ETH');

      expect(price).toBe(3000.5); // Mid price
    });

    it('should fallback to mark price if allMids unavailable', async () => {
      mockInfoClient.allMids.mockResolvedValue({});
      mockInfoClient.meta.mockResolvedValue({
        universe: [
          {
            name: 'ETH-SPOT',
            markPx: '3000.5',
          },
        ],
      });

      const price = await adapter.getSpotPrice('ETH');

      expect(price).toBe(3000.5);
    });
  });

  describe('transferInternal', () => {
    it('should transfer from spot to perp', async () => {
      const mockTransferMethod = jest.fn().mockResolvedValue({
        status: 'ok',
        response: {
          data: {
            txHash: '0xabc123',
          },
        },
      });

      (adapter as any).exchangeClient.transferBetweenSpotAndPerp =
        mockTransferMethod;

      const txHash = await adapter.transferInternal(1000, true);

      expect(txHash).toBe('0xabc123');
      expect(mockTransferMethod).toHaveBeenCalledWith(1000, true);
    });

    it('should throw error if transfer method not available', async () => {
      await expect(adapter.transferInternal(1000, true)).rejects.toThrow(
        SpotExchangeError,
      );
    });

    it('should throw error for invalid amount', async () => {
      await expect(adapter.transferInternal(0, true)).rejects.toThrow();
      await expect(adapter.transferInternal(-100, true)).rejects.toThrow();
    });
  });

  describe('isReady', () => {
    it('should return true if connection test passes', async () => {
      mockInfoClient.meta.mockResolvedValue({});

      const ready = await adapter.isReady();

      expect(ready).toBe(true);
    });

    it('should return false if connection test fails', async () => {
      mockInfoClient.meta.mockRejectedValue(new Error('Connection failed'));

      const ready = await adapter.isReady();

      expect(ready).toBe(false);
    });
  });

  describe('testConnection', () => {
    it('should throw SpotExchangeError on connection failure', async () => {
      mockInfoClient.meta.mockRejectedValue(new Error('Network error'));

      await expect(adapter.testConnection()).rejects.toThrow(SpotExchangeError);
    });
  });

  describe('formatSpotCoin', () => {
    it('should format symbol to spot coin format', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(4);
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
      });
      mockExchangeClient.placeOrder.mockResolvedValue({
        response: {
          type: 'order',
          data: {
            statuses: [
              {
                filled: {
                  oid: BigInt('12345'),
                  totalSz: '1.0',
                  avgPx: '3000.5',
                },
              },
            ],
          },
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      await adapter.placeSpotOrder(request);

      expect(mockExchangeClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ coin: 'ETH-SPOT' }),
      );
    });

    it('should preserve symbol if already formatted', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(4);
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
      });
      mockExchangeClient.placeOrder.mockResolvedValue({
        response: {
          type: 'order',
          data: {
            statuses: [
              {
                filled: {
                  oid: BigInt('12345'),
                  totalSz: '1.0',
                },
              },
            ],
          },
        },
      });

      const request = new SpotOrderRequest(
        'ETH-SPOT',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      await adapter.placeSpotOrder(request);

      expect(mockExchangeClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ coin: 'ETH-SPOT' }),
      );
    });

    it('should remove USDT/USDC suffix', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(4);
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
      });
      mockExchangeClient.placeOrder.mockResolvedValue({
        response: {
          type: 'order',
          data: {
            statuses: [
              {
                filled: {
                  oid: BigInt('12345'),
                  totalSz: '1.0',
                },
              },
            ],
          },
        },
      });

      const request = new SpotOrderRequest(
        'ETHUSDT',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      await adapter.placeSpotOrder(request);

      expect(mockExchangeClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ coin: 'ETH-SPOT' }),
      );
    });
  });

  describe('SymbolConverter initialization', () => {
    it('should retry on rate limit errors', async () => {
      const rateLimitError = new Error('429 Too Many Requests');
      (rateLimitError as any).response = { status: 429 };

      // First 2 attempts fail with rate limit, third succeeds
      (SymbolConverter.create as jest.Mock)
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValue(mockSymbolConverter);

      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(4);
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
      });
      mockExchangeClient.placeOrder.mockResolvedValue({
        response: {
          type: 'order',
          data: {
            statuses: [
              {
                filled: {
                  oid: BigInt('12345'),
                  totalSz: '1.0',
                },
              },
            ],
          },
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      await adapter.placeSpotOrder(request);

      expect(SymbolConverter.create).toHaveBeenCalledTimes(3);
    });

    it('should throw error after max retries', async () => {
      const rateLimitError = new Error('429 Too Many Requests');
      (rateLimitError as any).response = { status: 429 };

      (SymbolConverter.create as jest.Mock).mockRejectedValue(rateLimitError);

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );

      await expect(adapter.placeSpotOrder(request)).rejects.toThrow(
        SpotExchangeError,
      );
      expect(SymbolConverter.create).toHaveBeenCalledTimes(5); // Max retries
    });

    it('should not retry on non-rate-limit errors', async () => {
      const networkError = new Error('Network error');

      (SymbolConverter.create as jest.Mock).mockRejectedValue(networkError);

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );

      await expect(adapter.placeSpotOrder(request)).rejects.toThrow(
        SpotExchangeError,
      );
      expect(SymbolConverter.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('getBestBidAsk', () => {
    it('should use best bid/ask for market orders', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(4);
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
      });
      mockExchangeClient.placeOrder.mockResolvedValue({
        response: {
          type: 'order',
          data: {
            statuses: [
              {
                filled: {
                  oid: BigInt('12345'),
                  totalSz: '1.0',
                  avgPx: '3000.5',
                },
              },
            ],
          },
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      await adapter.placeSpotOrder(request);

      // Should use bestAsk (3001) for buy orders
      expect(mockExchangeClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ limit_px: '3001' }),
      );
    });

    it('should fallback to mark price if allMids unavailable', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(4);
      mockInfoClient.allMids.mockResolvedValue({});
      mockInfoClient.meta.mockResolvedValue({
        universe: [
          {
            name: 'ETH-SPOT',
            markPx: '3000.5',
          },
        ],
      });
      mockExchangeClient.placeOrder.mockResolvedValue({
        response: {
          type: 'order',
          data: {
            statuses: [
              {
                filled: {
                  oid: BigInt('12345'),
                  totalSz: '1.0',
                },
              },
            ],
          },
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      await adapter.placeSpotOrder(request);

      expect(mockInfoClient.meta).toHaveBeenCalled();
    });
  });

  describe('placeSpotOrder edge cases', () => {
    it('should handle order rejection', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(4);
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
      });

      mockExchangeClient.placeOrder.mockResolvedValue({
        response: {
          type: 'order',
          data: {
            statuses: [
              {
                error: 'Insufficient balance',
              },
            ],
          },
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );

      await expect(adapter.placeSpotOrder(request)).rejects.toThrow(
        SpotExchangeError,
      );
    });

    it('should handle missing asset ID', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(undefined);

      const request = new SpotOrderRequest(
        'INVALID',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );

      await expect(adapter.placeSpotOrder(request)).rejects.toThrow(
        SpotExchangeError,
      );
    });

    it('should handle missing szDecimals', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(undefined);

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );

      await expect(adapter.placeSpotOrder(request)).rejects.toThrow(
        SpotExchangeError,
      );
    });

    it('should handle limit order without price', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(4);

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.LIMIT,
        1.0,
        undefined, // No price
      );

      await expect(adapter.placeSpotOrder(request)).rejects.toThrow();
    });

    it('should handle FOK time in force', async () => {
      mockSymbolConverter.getAssetId.mockReturnValue(0);
      mockSymbolConverter.getSzDecimals.mockReturnValue(4);
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
      });
      mockExchangeClient.placeOrder.mockResolvedValue({
        response: {
          type: 'order',
          data: {
            statuses: [
              {
                filled: {
                  oid: BigInt('12345'),
                  totalSz: '1.0',
                },
              },
            ],
          },
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.LIMIT,
        1.0,
        3000,
        TimeInForce.FOK,
      );

      await adapter.placeSpotOrder(request);

      expect(mockExchangeClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          order_type: { limit: { tif: 'Ioc' } },
        }),
      );
    });
  });

  describe('getSpotPositions edge cases', () => {
    it('should filter out non-spot balances', async () => {
      mockInfoClient.clearinghouseState.mockResolvedValue({
        spotBalances: [
          {
            coin: 'ETH-SPOT',
            total: '1.5',
          },
          {
            coin: 'ETH-PERP',
            total: '0.5',
          },
        ],
      });
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3001' },
      });

      const positions = await adapter.getSpotPositions();

      expect(positions.length).toBe(1);
      expect(positions[0].symbol).toBe('ETH-SPOT');
    });

    it('should filter out zero balances', async () => {
      mockInfoClient.clearinghouseState.mockResolvedValue({
        spotBalances: [
          {
            coin: 'ETH-SPOT',
            total: '0',
          },
        ],
      });

      const positions = await adapter.getSpotPositions();

      expect(positions.length).toBe(0);
    });
  });

  describe('getSpotOrderStatus edge cases', () => {
    it('should handle string orderId in openOrders', async () => {
      mockInfoClient.openOrders.mockResolvedValue([
        {
          oid: '12345', // String instead of BigInt
          coin: 'ETH-SPOT',
          side: 'B',
          sz: '1.0',
          filled: '0.5',
        },
      ]);

      const response = await adapter.getSpotOrderStatus('12345');

      expect(response.orderId).toBe('12345');
    });

    it('should handle BigInt orderId', async () => {
      mockInfoClient.openOrders.mockResolvedValue([
        {
          oid: BigInt('12345'),
          coin: 'ETH-SPOT',
          side: 'B',
          sz: '1.0',
          filled: '1.0',
        },
      ]);

      const response = await adapter.getSpotOrderStatus('12345');

      expect(response.status).toBe(OrderStatus.FILLED);
    });

    it('should handle fully filled order', async () => {
      mockInfoClient.openOrders.mockResolvedValue([
        {
          oid: BigInt('12345'),
          coin: 'ETH-SPOT',
          side: 'B',
          sz: '1.0',
          filled: '1.0',
        },
      ]);

      const response = await adapter.getSpotOrderStatus('12345');

      expect(response.status).toBe(OrderStatus.FILLED);
    });
  });

  describe('getSpotBalance cache', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should cache balance for TTL duration', async () => {
      mockInfoClient.clearinghouseState.mockResolvedValue({
        spotBalances: [
          {
            coin: 'ETH-SPOT',
            total: '2.5',
          },
        ],
      });

      await adapter.getSpotBalance('ETH');
      await adapter.getSpotBalance('ETH');

      // Should only call once due to cache
      expect(mockInfoClient.clearinghouseState).toHaveBeenCalledTimes(1);
    });

    it('should refresh cache after TTL expires', async () => {
      mockInfoClient.clearinghouseState.mockResolvedValue({
        spotBalances: [
          {
            coin: 'ETH-SPOT',
            total: '2.5',
          },
        ],
      });

      await adapter.getSpotBalance('ETH');

      // Advance time past cache TTL (5 seconds)
      jest.advanceTimersByTime(6000);

      await adapter.getSpotBalance('ETH');

      // Should call twice after cache expires
      expect(mockInfoClient.clearinghouseState).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSpotPrice edge cases', () => {
    it('should calculate mid price from bid/ask', async () => {
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '3000', ask: '3002' },
      });

      const price = await adapter.getSpotPrice('ETH');

      expect(price).toBe(3001); // (3000 + 3002) / 2
    });

    it('should handle zero bid/ask', async () => {
      mockInfoClient.allMids.mockResolvedValue({
        'ETH-SPOT': { bid: '0', ask: '0' },
      });
      mockInfoClient.meta.mockResolvedValue({
        universe: [
          {
            name: 'ETH-SPOT',
            markPx: '3000.5',
          },
        ],
      });

      const price = await adapter.getSpotPrice('ETH');

      expect(price).toBe(3000.5); // Should fallback to mark price
    });
  });

  describe('transferInternal edge cases', () => {
    it('should clear balance cache after transfer', async () => {
      const mockTransferMethod = jest.fn().mockResolvedValue({
        status: 'ok',
        response: {
          data: {
            txHash: '0xabc123',
          },
        },
      });

      (adapter as any).exchangeClient.transferBetweenSpotAndPerp =
        mockTransferMethod;
      (adapter as any).spotBalanceCache.set('ETH', {
        balance: 2.5,
        timestamp: Date.now(),
      });

      await adapter.transferInternal(1000, true);

      expect((adapter as any).spotBalanceCache.size).toBe(0);
    });

    it('should handle different response formats', async () => {
      const mockTransferMethod = jest.fn().mockResolvedValue({
        status: 'ok',
        response: {
          txHash: '0xabc123', // Different format
        },
      });

      (adapter as any).exchangeClient.transferBetweenSpotAndPerp =
        mockTransferMethod;

      const txHash = await adapter.transferInternal(1000, true);

      expect(txHash).toBe('0xabc123');
    });
  });

  describe('constructor', () => {
    it('should use HYPERLIQUID_PRIVATE_KEY if PRIVATE_KEY not available', async () => {
      const testConfigService = {
        get: jest.fn((key: string) => {
          const config: Record<string, any> = {
            PRIVATE_KEY: undefined,
            HYPERLIQUID_PRIVATE_KEY:
              '0x1234567890123456789012345678901234567890123456789012345678901234',
            HYPERLIQUID_TESTNET: false,
          };
          return config[key];
        }),
      } as any;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          HyperliquidSpotAdapter,
          { provide: ConfigService, useValue: testConfigService },
        ],
      }).compile();

      const testAdapter = module.get<HyperliquidSpotAdapter>(
        HyperliquidSpotAdapter,
      );
      expect(testAdapter).toBeDefined();
    });

    it('should throw error if no private key provided', async () => {
      const testConfigService = {
        get: jest.fn(() => undefined),
      } as any;

      await expect(
        Test.createTestingModule({
          providers: [
            HyperliquidSpotAdapter,
            { provide: ConfigService, useValue: testConfigService },
          ],
        }).compile(),
      ).rejects.toThrow(
        'Hyperliquid spot adapter requires PRIVATE_KEY or HYPERLIQUID_PRIVATE_KEY',
      );
    });

    it('should normalize private key without 0x prefix', async () => {
      const testConfigService = {
        get: jest.fn((key: string) => {
          const config: Record<string, any> = {
            PRIVATE_KEY:
              '1234567890123456789012345678901234567890123456789012345678901234', // Without 0x
            HYPERLIQUID_TESTNET: false,
          };
          return config[key];
        }),
      } as any;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          HyperliquidSpotAdapter,
          { provide: ConfigService, useValue: testConfigService },
        ],
      }).compile();

      const testAdapter = module.get<HyperliquidSpotAdapter>(
        HyperliquidSpotAdapter,
      );
      expect(testAdapter).toBeDefined();
    });
  });
});
