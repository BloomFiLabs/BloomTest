import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ExtendedSpotAdapter } from './ExtendedSpotAdapter';
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
import { ExtendedSigningService } from './ExtendedSigningService';

jest.mock('axios');
jest.mock('./ExtendedSigningService');

describe('ExtendedSpotAdapter', () => {
  let adapter: ExtendedSpotAdapter;
  let mockConfigService: jest.Mocked<ConfigService>;
  const mockedAxios = axios as jest.Mocked<typeof axios>;
  let mockClient: any;
  let mockSigningService: jest.Mocked<ExtendedSigningService>;

  // Define config values outside beforeEach to ensure they're available
  const STARK_PRIVATE_KEY =
    '0x1234567890123456789012345678901234567890123456789012345678901234';
  const STARK_PUBLIC_KEY = '0x' + '1'.repeat(64);

  beforeEach(async () => {
    mockSigningService = {
      signOrder: jest.fn().mockResolvedValue('0xsignature'),
      signTransfer: jest.fn().mockResolvedValue('0xsignature'),
    } as any;

    (ExtendedSigningService as jest.Mock).mockImplementation(
      () => mockSigningService,
    );

    mockClient = {
      get: jest.fn(),
      post: jest.fn(),
      delete: jest.fn(),
    };

    mockedAxios.create = jest.fn(() => mockClient) as any;

    // Set up mock config service - ensure it returns values correctly
    // Using the same pattern as AsterSpotAdapter
    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          EXTENDED_API_BASE_URL: 'https://api.starknet.extended.exchange',
          EXTENDED_API_KEY: 'test_api_key',
          EXTENDED_STARK_PRIVATE_KEY: STARK_PRIVATE_KEY,
          EXTENDED_STARK_KEY: STARK_PRIVATE_KEY, // Fallback
          EXTENDED_STARK_PUBLIC_KEY: STARK_PUBLIC_KEY,
          EXTENDED_VAULT_NUMBER: '1',
          EXTENDED_TESTNET: 'false',
        };
        return config[key];
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExtendedSpotAdapter,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    adapter = module.get<ExtendedSpotAdapter>(ExtendedSpotAdapter);
  });

  describe('getConfig', () => {
    it('should return correct config', () => {
      const config = adapter.getConfig();
      expect(config.exchangeType).toBe(ExchangeType.EXTENDED);
      expect(config.baseUrl).toBe('https://api.starknet.extended.exchange');
    });
  });

  describe('getExchangeType', () => {
    it('should return EXTENDED', () => {
      expect(adapter.getExchangeType()).toBe(ExchangeType.EXTENDED);
    });
  });

  describe('placeSpotOrder', () => {
    it('should place a market buy order', async () => {
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
      expect(mockSigningService.signOrder).toHaveBeenCalled();
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
        data: {
          data: [
            {
              asset: 'ETH',
              size: '1.5',
            },
          ],
        },
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
        data: {
          data: [],
        },
      });

      const position = await adapter.getSpotPosition('ETH');

      expect(position).toBeNull();
    });
  });

  describe('getSpotPositions', () => {
    it('should return all spot positions', async () => {
      mockClient.get.mockResolvedValueOnce({
        data: {
          data: [
            {
              asset: 'ETH',
              size: '1.5',
            },
            {
              asset: 'BTC',
              size: '0.1',
            },
          ],
        },
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
          symbol: 'ETH-USD',
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
        data: {
          balance: '2.5',
        },
      });

      const balance = await adapter.getSpotBalance('ETH');

      expect(balance).toBe(2.5);
    });

    it('should return 0 if balance not found', async () => {
      mockClient.get.mockResolvedValue({
        data: {},
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
    it('should transfer from spot to perp', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          transferId: '12345',
        },
      });

      const transferId = await adapter.transferInternal(1000, true);

      expect(transferId).toBe('12345');
      expect(mockClient.post).toHaveBeenCalled();
      expect(mockSigningService.signTransfer).toHaveBeenCalled();
    });

    it('should transfer from perp to spot', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          transferId: '67890',
        },
      });

      const transferId = await adapter.transferInternal(1000, false);

      expect(transferId).toBe('67890');
    });

    it('should throw error for invalid amount', async () => {
      await expect(adapter.transferInternal(0, true)).rejects.toThrow();
      await expect(adapter.transferInternal(-100, true)).rejects.toThrow();
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

  describe('constructor', () => {
    it('should throw error if API key not provided', async () => {
      const testConfigService = {
        get: jest.fn((key: string) => {
          if (key === 'EXTENDED_API_KEY') {
            return undefined;
          }
          return 'test';
        }),
      } as any;

      await expect(
        Test.createTestingModule({
          providers: [
            ExtendedSpotAdapter,
            { provide: ConfigService, useValue: testConfigService },
          ],
        }).compile(),
      ).rejects.toThrow('Extended spot adapter requires EXTENDED_API_KEY');
    });

    it('should throw error if private key not provided', async () => {
      const testConfigService = {
        get: jest.fn((key: string) => {
          if (
            key === 'EXTENDED_STARK_PRIVATE_KEY' ||
            key === 'EXTENDED_STARK_KEY'
          ) {
            return undefined;
          }
          if (key === 'EXTENDED_API_KEY') {
            return 'test_api_key';
          }
          return 'test';
        }),
      } as any;

      await expect(
        Test.createTestingModule({
          providers: [
            ExtendedSpotAdapter,
            { provide: ConfigService, useValue: testConfigService },
          ],
        }).compile(),
      ).rejects.toThrow(
        'Extended spot adapter requires EXTENDED_STARK_PRIVATE_KEY',
      );
    });

    it('should throw error if public key not provided', async () => {
      const testConfigService = {
        get: jest.fn((key: string) => {
          if (key === 'EXTENDED_STARK_PUBLIC_KEY') {
            return undefined;
          }
          if (key === 'EXTENDED_API_KEY') {
            return 'test_api_key';
          }
          if (
            key === 'EXTENDED_STARK_PRIVATE_KEY' ||
            key === 'EXTENDED_STARK_KEY'
          ) {
            return STARK_PRIVATE_KEY;
          }
          return 'test';
        }),
      } as any;

      await expect(
        Test.createTestingModule({
          providers: [
            ExtendedSpotAdapter,
            { provide: ConfigService, useValue: testConfigService },
          ],
        }).compile(),
      ).rejects.toThrow(
        'Extended spot adapter requires EXTENDED_STARK_PUBLIC_KEY',
      );
    });

    it('should throw error if vault number not provided', async () => {
      const testConfigService = {
        get: jest.fn((key: string) => {
          if (key === 'EXTENDED_VAULT_NUMBER') {
            return '0';
          }
          if (key === 'EXTENDED_API_KEY') {
            return 'test_api_key';
          }
          if (
            key === 'EXTENDED_STARK_PRIVATE_KEY' ||
            key === 'EXTENDED_STARK_KEY'
          ) {
            return STARK_PRIVATE_KEY;
          }
          if (key === 'EXTENDED_STARK_PUBLIC_KEY') {
            return STARK_PUBLIC_KEY;
          }
          return 'test';
        }),
      } as any;

      await expect(
        Test.createTestingModule({
          providers: [
            ExtendedSpotAdapter,
            { provide: ConfigService, useValue: testConfigService },
          ],
        }).compile(),
      ).rejects.toThrow('Extended spot adapter requires EXTENDED_VAULT_NUMBER');
    });

    it('should normalize public key without 0x prefix', async () => {
      const testConfigService = {
        get: jest.fn((key: string) => {
          const config: Record<string, any> = {
            EXTENDED_API_BASE_URL: 'https://api.starknet.extended.exchange',
            EXTENDED_API_KEY: 'test_api_key',
            EXTENDED_STARK_PRIVATE_KEY: STARK_PRIVATE_KEY,
            EXTENDED_STARK_PUBLIC_KEY: STARK_PUBLIC_KEY.slice(2), // Without 0x
            EXTENDED_VAULT_NUMBER: '1',
            EXTENDED_TESTNET: 'false',
          };
          return config[key];
        }),
      } as any;

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ExtendedSpotAdapter,
          { provide: ConfigService, useValue: testConfigService },
        ],
      }).compile();

      const testAdapter = module.get<ExtendedSpotAdapter>(ExtendedSpotAdapter);
      expect(testAdapter).toBeDefined();
    });
  });

  describe('formatSymbol', () => {
    it('should format symbol correctly', async () => {
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

      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/v1/spot/order',
        expect.objectContaining({ symbol: 'ETH-USD' }),
        expect.any(Object),
      );
    });

    it('should preserve symbol if already formatted', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          orderId: '12345',
          status: 'FILLED',
          executedQty: '1.0',
        },
      });

      const request = new SpotOrderRequest(
        'ETH-USD',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );
      await adapter.placeSpotOrder(request);

      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/v1/spot/order',
        expect.objectContaining({ symbol: 'ETH-USD' }),
        expect.any(Object),
      );
    });
  });

  describe('placeSpotOrder edge cases', () => {
    it('should handle signing service errors', async () => {
      mockSigningService.signOrder.mockRejectedValue(
        new Error('Signing failed'),
      );

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

    it('should include publicKey in request', async () => {
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

      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/v1/spot/order',
        expect.objectContaining({ publicKey: STARK_PUBLIC_KEY }),
        expect.any(Object),
      );
    });
  });

  describe('getSpotPositions edge cases', () => {
    it('should handle response.data format', async () => {
      mockClient.get.mockResolvedValueOnce({
        data: {
          data: [
            {
              asset: 'ETH',
              size: '1.5',
            },
          ],
        },
      });
      mockClient.get.mockResolvedValue({ data: { price: '3000' } });

      const positions = await adapter.getSpotPositions();

      expect(positions.length).toBe(1);
    });

    it('should handle direct array response', async () => {
      mockClient.get.mockResolvedValueOnce({
        data: [
          {
            symbol: 'ETH',
            quantity: '1.5',
          },
        ],
      });
      mockClient.get.mockResolvedValue({ data: { price: '3000' } });

      const positions = await adapter.getSpotPositions();

      expect(positions.length).toBe(1);
    });

    it('should filter out zero positions', async () => {
      mockClient.get.mockResolvedValueOnce({
        data: {
          data: [
            {
              asset: 'ETH',
              size: '0',
            },
          ],
        },
      });

      const positions = await adapter.getSpotPositions();

      expect(positions.length).toBe(0);
    });
  });

  describe('getSpotBalance edge cases', () => {
    it('should handle balance field', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          balance: '2.5',
        },
      });

      const balance = await adapter.getSpotBalance('ETH');

      expect(balance).toBe(2.5);
    });

    it('should handle available field', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          available: '1.5',
        },
      });

      const balance = await adapter.getSpotBalance('ETH');

      expect(balance).toBe(1.5);
    });

    it('should include vaultNumber in params', async () => {
      mockClient.get.mockResolvedValue({
        data: {
          balance: '2.5',
        },
      });

      await adapter.getSpotBalance('ETH');

      expect(mockClient.get).toHaveBeenCalledWith(
        '/api/v1/spot/balance',
        expect.objectContaining({
          params: expect.objectContaining({ vaultNumber: 1 }),
        }),
      );
    });
  });

  describe('transferInternal edge cases', () => {
    it('should handle signing service errors', async () => {
      mockSigningService.signTransfer.mockRejectedValue(
        new Error('Signing failed'),
      );

      await expect(adapter.transferInternal(1000, true)).rejects.toThrow(
        SpotExchangeError,
      );
    });

    it('should handle missing transferId in response', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          status: 'success',
        },
      });

      await expect(adapter.transferInternal(1000, true)).rejects.toThrow(
        SpotExchangeError,
      );
    });

    it('should use correct vault numbers for transfers', async () => {
      mockClient.post.mockResolvedValue({
        data: {
          transferId: '12345',
        },
      });

      await adapter.transferInternal(1000, true);

      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/v1/user/transfer',
        expect.objectContaining({
          toVault: 1,
          fromVault: 0,
        }),
        expect.any(Object),
      );
    });
  });
});
