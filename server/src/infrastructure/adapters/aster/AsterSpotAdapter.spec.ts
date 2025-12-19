import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AsterSpotAdapter } from './AsterSpotAdapter';
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
import axios from 'axios';
import * as ethers from 'ethers';
import * as crypto from 'crypto';

jest.mock('axios');
jest.mock('ethers');

// Mock crypto module
jest.mock('crypto', () => {
  const actualCrypto = jest.requireActual('crypto');
  return {
    ...actualCrypto,
    createHmac: jest.fn().mockImplementation(() => ({
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue('mock_signature'),
    })),
  };
});

describe('AsterSpotAdapter', () => {
  let adapter: AsterSpotAdapter;
  let mockConfigService: jest.Mocked<ConfigService>;
  const mockedAxios = axios as jest.Mocked<typeof axios>;
  let mockClient: any;
  let mockWallet: any;

  beforeEach(async () => {
    mockWallet = {
      address: '0x' + '1'.repeat(40),
      signingKey: {
        sign: jest.fn().mockReturnValue({
          r: '0x' + '1'.repeat(64),
          s: '0x' + '2'.repeat(64),
          v: 27,
        }),
      },
    };

    (ethers.Wallet as unknown as jest.Mock).mockImplementation(() => mockWallet);
    (ethers.AbiCoder as any).defaultAbiCoder = jest.fn().mockReturnValue({
      encode: jest.fn().mockReturnValue('0xencoded'),
    });
    (ethers.keccak256 as unknown as jest.Mock) = jest
      .fn()
      .mockReturnValue('0x' + '3'.repeat(64));
    (ethers.getBytes as jest.Mock) = jest
      .fn()
      .mockImplementation(() => new Uint8Array(32));
    (ethers.toUtf8Bytes as jest.Mock) = jest
      .fn()
      .mockImplementation((x: string) => new Uint8Array(x.length));
    (ethers.concat as jest.Mock) = jest
      .fn()
      .mockReturnValue(new Uint8Array(64));
    (ethers.Signature as any).from = jest.fn().mockReturnValue({
      serialized: '0x' + '4'.repeat(130),
    });

    mockClient = {
      get: jest.fn(),
      post: jest.fn(),
      delete: jest.fn(),
    };

    mockedAxios.create = jest.fn(() => mockClient) as any;

    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          ASTER_BASE_URL: 'https://fapi.asterdex.com',
          ASTER_USER: '0x1111111111111111111111111111111111111111',
          ASTER_SIGNER: '0x2222222222222222222222222222222222222222',
          ASTER_PRIVATE_KEY:
            '0x1234567890123456789012345678901234567890123456789012345678901234',
          ASTER_API_KEY: 'test_api_key',
          ASTER_API_SECRET: 'test_api_secret',
        };
        return config[key];
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AsterSpotAdapter,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    adapter = module.get<AsterSpotAdapter>(AsterSpotAdapter);
  });

  describe('getConfig', () => {
    it('should return correct config', () => {
      const config = adapter.getConfig();
      expect(config.exchangeType).toBe(ExchangeType.ASTER);
      expect(config.baseUrl).toBe('https://fapi.asterdex.com');
    });
  });

  describe('getExchangeType', () => {
    it('should return ASTER', () => {
      expect(adapter.getExchangeType()).toBe(ExchangeType.ASTER);
    });
  });

  describe('placeSpotOrder', () => {
    it('should place a market buy order with API key', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          orderId: '12345',
          status: 'FILLED',
          executedQty: '1.0',
          avgPrice: '3000.0',
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
      expect(mockClient.post).toHaveBeenCalled();
    });

    it('should place a limit sell order', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          orderId: '67890',
          status: 'SUBMITTED',
          executedQty: '0',
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

    it('should throw SpotExchangeError on order failure', async () => {
      mockClient.post.mockRejectedValue(new Error('Insufficient balance'));

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
      mockClient.get.mockResolvedValueOnce({
        data: [
          {
            asset: 'ETH',
            free: '1.0',
            locked: '0.5',
          },
        ],
      });
      mockClient.get.mockResolvedValueOnce({
        data: { price: '3000' },
      });

      const position = await adapter.getSpotPosition('ETH');

      expect(position).not.toBeNull();
      expect(position!.symbol).toBe('ETH');
      expect(position!.size).toBe(1.5);
    });

    it('should return null if no position exists', async () => {
      mockClient.get.mockResolvedValueOnce({
        data: [],
      });

      const position = await adapter.getSpotPosition('ETH');

      expect(position).toBeNull();
    });
  });

  describe('getSpotPositions', () => {
    it('should return all spot positions', async () => {
      mockClient.get.mockResolvedValueOnce({
        data: [
          {
            asset: 'ETH',
            free: '1.0',
            locked: '0.5',
          },
          {
            asset: 'BTC',
            free: '0.1',
            locked: '0',
          },
        ],
      });
      mockClient.get.mockResolvedValue({ data: { price: '3000' } });

      const positions = await adapter.getSpotPositions();

      expect(positions.length).toBe(2);
      expect(positions[0].symbol).toBe('ETH');
      expect(positions[1].symbol).toBe('BTC');
    });
  });

  describe('cancelSpotOrder', () => {
    it('should cancel order successfully', async () => {
      mockClient.delete.mockResolvedValue({
        data: { status: 'CANCELED' },
      });

      const result = await adapter.cancelSpotOrder('12345', 'ETH');

      expect(result).toBe(true);
    });

    it('should throw SpotExchangeError on cancellation failure', async () => {
      mockClient.delete.mockRejectedValue(new Error('Order not found'));

      await expect(adapter.cancelSpotOrder('12345')).rejects.toThrow(
        SpotExchangeError,
      );
    });
  });

  describe('getSpotOrderStatus', () => {
    it('should return order status', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          orderId: '12345',
          symbol: 'ETHUSDT',
          side: 'BUY',
          status: 'PARTIALLY_FILLED',
          executedQty: '0.5',
          avgPrice: '3000.5',
        },
      });

      const response = await adapter.getSpotOrderStatus('12345', 'ETH');

      expect(response.orderId).toBe('12345');
      expect(response.status).toBe(OrderStatus.PARTIALLY_FILLED);
      expect(response.filledSize).toBe(0.5);
    });
  });

  describe('getSpotBalance', () => {
    it('should return spot balance', async () => {
      mockClient.get.mockResolvedValue({
        data: [
          {
            asset: 'ETH',
            free: '2.0',
            locked: '0.5',
          },
        ],
      });

      const balance = await adapter.getSpotBalance('ETH');

      expect(balance).toBe(2.5);
    });

    it('should return 0 if balance not found', async () => {
      mockClient.get.mockResolvedValue({
        data: [],
      });

      const balance = await adapter.getSpotBalance('ETH');

      expect(balance).toBe(0);
    });
  });

  describe('getSpotPrice', () => {
    it('should return spot price', async () => {
      mockClient.get.mockResolvedValue({
        data: { price: '3000.5' },
      });

      const price = await adapter.getSpotPrice('ETH');

      expect(price).toBe(3000.5);
    });

    it('should throw error if price not found', async () => {
      mockClient.get.mockResolvedValue({
        data: {},
      });

      await expect(adapter.getSpotPrice('ETH')).rejects.toThrow();
    });
  });

  describe('transferInternal', () => {
    it('should transfer from spot to futures', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          tranId: '12345',
        },
      });

      const tranId = await adapter.transferInternal(1000, true);

      expect(tranId).toBe('12345');
      expect(mockClient.post).toHaveBeenCalled();
    });

    it('should transfer from futures to spot', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          tranId: '67890',
        },
      });

      const tranId = await adapter.transferInternal(1000, false);

      expect(tranId).toBe('67890');
    });

    it('should throw error for invalid amount', async () => {
      await expect(adapter.transferInternal(0, true)).rejects.toThrow();
      await expect(adapter.transferInternal(-100, true)).rejects.toThrow();
    });

    it('should throw error if API key not available', async () => {
      // Test that transferInternal throws an error when API keys are not available
      // We'll modify the existing adapter's API keys to be undefined
      // Note: This tests the error handling in transferInternal

      // Create adapter with wallet credentials (no API keys)
      const testConfigService = {
        get: jest.fn((key: string) => {
          const config: Record<string, any> = {
            ASTER_BASE_URL: 'https://fapi.asterdex.com',
            ASTER_USER: '0x1111111111111111111111111111111111111111',
            ASTER_SIGNER: '0x2222222222222222222222222222222222222222',
            ASTER_PRIVATE_KEY:
              '0x1234567890123456789012345678901234567890123456789012345678901234',
            // Explicitly set API keys to undefined
            ASTER_API_KEY: undefined,
            ASTER_API_SECRET: undefined,
          };
          return config[key];
        }),
      } as any;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AsterSpotAdapter,
          { provide: ConfigService, useValue: testConfigService },
        ],
      }).compile();

      const newAdapter = module.get<AsterSpotAdapter>(AsterSpotAdapter);

      // transferInternal requires API keys, so it should throw an error
      await expect(newAdapter.transferInternal(1000, true)).rejects.toThrow();
    });
  });

  describe('isReady', () => {
    it('should return true if connection test passes', async () => {
      mockClient.get.mockResolvedValue({});

      const ready = await adapter.isReady();

      expect(ready).toBe(true);
    });

    it('should return false if connection test fails', async () => {
      mockClient.get.mockRejectedValue(new Error('Connection failed'));

      const ready = await adapter.isReady();

      expect(ready).toBe(false);
    });
  });

  describe('testConnection', () => {
    it('should throw SpotExchangeError on connection failure', async () => {
      mockClient.get.mockRejectedValue(new Error('Network error'));

      await expect(adapter.testConnection()).rejects.toThrow(SpotExchangeError);
    });
  });

  describe('formatSymbol', () => {
    it('should format symbol correctly for ETH', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          orderId: '12345',
          status: 'FILLED',
          executedQty: '1.0',
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      await adapter.placeSpotOrder(request);

      // Verify symbol was formatted to ETHUSDT
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/v1/spot/order',
        expect.objectContaining({ symbol: 'ETHUSDT' }),
        expect.any(Object),
      );
    });

    it('should preserve symbol if already includes USDT', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          orderId: '12345',
          status: 'FILLED',
          executedQty: '1.0',
        },
      });

      const request = new SpotOrderRequest(
        'ETHUSDT',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      await adapter.placeSpotOrder(request);

      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/v1/spot/order',
        expect.objectContaining({ symbol: 'ETHUSDT' }),
        expect.any(Object),
      );
    });
  });

  describe('authentication methods', () => {
    it('should use wallet authentication when API keys not available', async () => {
      const testConfigService = {
        get: jest.fn((key: string) => {
          const config: Record<string, any> = {
            ASTER_BASE_URL: 'https://fapi.asterdex.com',
            ASTER_USER: '0x1111111111111111111111111111111111111111',
            ASTER_SIGNER: '0x2222222222222222222222222222222222222222',
            ASTER_PRIVATE_KEY:
              '0x1234567890123456789012345678901234567890123456789012345678901234',
            ASTER_API_KEY: undefined,
            ASTER_API_SECRET: undefined,
          };
          return config[key];
        }),
      } as any;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AsterSpotAdapter,
          { provide: ConfigService, useValue: testConfigService },
        ],
      }).compile();

      const walletAdapter = module.get<AsterSpotAdapter>(AsterSpotAdapter);

      mockClient.post.mockResolvedValue({
        data: {
          orderId: '12345',
          status: 'FILLED',
          executedQty: '1.0',
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      await walletAdapter.placeSpotOrder(request);

      // Should use wallet signing (signParams) instead of API key
      expect(mockClient.post).toHaveBeenCalled();
    });

    it('should throw error when no authentication available', async () => {
      const testConfigService = {
        get: jest.fn(() => undefined),
      } as any;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AsterSpotAdapter,
          { provide: ConfigService, useValue: testConfigService },
        ],
      }).compile();

      const noAuthAdapter = module.get<AsterSpotAdapter>(AsterSpotAdapter);

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      await expect(noAuthAdapter.placeSpotOrder(request)).rejects.toThrow();
    });
  });

  describe('placeSpotOrder edge cases', () => {
    it('should handle PARTIALLY_FILLED status', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          orderId: '12345',
          status: 'PARTIALLY_FILLED',
          executedQty: '0.5',
          avgPrice: '3000.0',
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      const response = await adapter.placeSpotOrder(request);

      expect(response.status).toBe(OrderStatus.PARTIALLY_FILLED);
      expect(response.filledSize).toBe(0.5);
    });

    it('should handle missing avgPrice', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          orderId: '12345',
          status: 'SUBMITTED',
          executedQty: '0',
        },
      });

      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      const response = await adapter.placeSpotOrder(request);

      expect(response.averagePrice).toBeUndefined();
    });

    it('should handle unexpected response format', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          // Missing orderId
          status: 'PENDING',
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

  describe('getSpotPositions edge cases', () => {
    it('should filter out USDT and USDC balances', async () => {
      mockClient.get.mockResolvedValueOnce({
        data: [
          {
            asset: 'ETH',
            free: '1.0',
            locked: '0.5',
          },
          {
            asset: 'USDT',
            free: '1000',
            locked: '0',
          },
          {
            asset: 'USDC',
            free: '500',
            locked: '0',
          },
        ],
      });
      mockClient.get.mockResolvedValue({ data: { price: '3000' } });

      const positions = await adapter.getSpotPositions();

      expect(positions.length).toBe(1);
      expect(positions[0].symbol).toBe('ETH');
    });

    it('should handle zero balances', async () => {
      mockClient.get.mockResolvedValueOnce({
        data: [
          {
            asset: 'ETH',
            free: '0',
            locked: '0',
          },
        ],
      });

      const positions = await adapter.getSpotPositions();

      expect(positions.length).toBe(0);
    });
  });

  describe('getSpotOrderStatus edge cases', () => {
    it('should handle CANCELED status', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          orderId: '12345',
          symbol: 'ETHUSDT',
          side: 'BUY',
          status: 'CANCELED',
          executedQty: '0',
        },
      });

      const response = await adapter.getSpotOrderStatus('12345', 'ETH');

      expect(response.status).toBe(OrderStatus.CANCELLED);
    });

    it('should handle missing symbol in response', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          orderId: '12345',
          side: 'BUY',
          status: 'FILLED',
          executedQty: '1.0',
        },
      });

      const response = await adapter.getSpotOrderStatus('12345', 'ETH');

      expect(response.symbol).toBe('ETH');
    });
  });

  describe('getSpotBalance edge cases', () => {
    it('should return 0 when authentication not available', async () => {
      const testConfigService = {
        get: jest.fn(() => undefined),
      } as any;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AsterSpotAdapter,
          { provide: ConfigService, useValue: testConfigService },
        ],
      }).compile();

      const noAuthAdapter = module.get<AsterSpotAdapter>(AsterSpotAdapter);

      const balance = await noAuthAdapter.getSpotBalance('ETH');

      expect(balance).toBe(0);
    });

    it('should handle non-array response', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          asset: 'ETH',
          balance: '2.5',
        },
      });

      const balance = await adapter.getSpotBalance('ETH');

      expect(balance).toBe(0);
    });
  });

  describe('getSpotPrice edge cases', () => {
    it('should handle missing price in response', async () => {
      mockClient.get.mockResolvedValue({
        data: {},
      });

      await expect(adapter.getSpotPrice('ETH')).rejects.toThrow(
        SpotExchangeError,
      );
    });

    it('should handle network errors', async () => {
      mockClient.get.mockRejectedValue(new Error('Network timeout'));

      await expect(adapter.getSpotPrice('ETH')).rejects.toThrow(
        SpotExchangeError,
      );
    });
  });

  describe('transferInternal edge cases', () => {
    it('should handle transfer response without tranId', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          status: 'success',
        },
      });

      await expect(adapter.transferInternal(1000, true)).rejects.toThrow(
        SpotExchangeError,
      );
    });

    it('should format query string correctly', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          tranId: '12345',
        },
      });

      await adapter.transferInternal(1000, true);

      expect(mockClient.post).toHaveBeenCalledWith(
        expect.stringContaining('/fapi/v1/transfer'),
        {},
        expect.any(Object),
      );
    });
  });
});
