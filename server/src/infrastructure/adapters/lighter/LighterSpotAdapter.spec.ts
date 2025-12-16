import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LighterSpotAdapter } from './LighterSpotAdapter';
import { ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import { SpotOrderRequest } from '../../../domain/value-objects/SpotOrder';
import { OrderSide, OrderType } from '../../../domain/value-objects/PerpOrder';
import { SpotExchangeError } from '../../../domain/ports/ISpotExchangeAdapter';

describe('LighterSpotAdapter', () => {
  let adapter: LighterSpotAdapter;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, any> = {
          LIGHTER_API_BASE_URL: 'https://mainnet.zklighter.elliot.ai',
          LIGHTER_API_KEY: 'test_api_key',
          LIGHTER_ACCOUNT_INDEX: '1000',
        };
        return config[key];
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LighterSpotAdapter,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    adapter = module.get<LighterSpotAdapter>(LighterSpotAdapter);
  });

  describe('getConfig', () => {
    it('should return correct config', () => {
      const config = adapter.getConfig();
      expect(config.exchangeType).toBe(ExchangeType.LIGHTER);
    });
  });

  describe('getExchangeType', () => {
    it('should return LIGHTER', () => {
      expect(adapter.getExchangeType()).toBe(ExchangeType.LIGHTER);
    });
  });

  describe('placeSpotOrder', () => {
    it('should throw SpotExchangeError (not supported)', async () => {
      const request = new SpotOrderRequest(
        'ETH',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );

      await expect(adapter.placeSpotOrder(request)).rejects.toThrow(SpotExchangeError);
      await expect(adapter.placeSpotOrder(request)).rejects.toThrow('Spot trading is not supported');
    });
  });

  describe('getSpotPosition', () => {
    it('should throw SpotExchangeError (not supported)', async () => {
      await expect(adapter.getSpotPosition('ETH')).rejects.toThrow(SpotExchangeError);
    });
  });

  describe('getSpotPositions', () => {
    it('should throw SpotExchangeError (not supported)', async () => {
      await expect(adapter.getSpotPositions()).rejects.toThrow(SpotExchangeError);
    });
  });

  describe('cancelSpotOrder', () => {
    it('should throw SpotExchangeError (not supported)', async () => {
      await expect(adapter.cancelSpotOrder('12345')).rejects.toThrow(SpotExchangeError);
    });
  });

  describe('getSpotOrderStatus', () => {
    it('should throw SpotExchangeError (not supported)', async () => {
      await expect(adapter.getSpotOrderStatus('12345')).rejects.toThrow(SpotExchangeError);
    });
  });

  describe('getSpotBalance', () => {
    it('should throw SpotExchangeError (not supported)', async () => {
      await expect(adapter.getSpotBalance('ETH')).rejects.toThrow(SpotExchangeError);
    });
  });

  describe('getSpotPrice', () => {
    it('should throw SpotExchangeError (not supported)', async () => {
      await expect(adapter.getSpotPrice('ETH')).rejects.toThrow(SpotExchangeError);
    });
  });

  describe('transferInternal', () => {
    it('should throw SpotExchangeError (not supported)', async () => {
      await expect(adapter.transferInternal(1000, true)).rejects.toThrow(SpotExchangeError);
    });
  });

  describe('isReady', () => {
    it('should return false (not supported)', async () => {
      const ready = await adapter.isReady();
      expect(ready).toBe(false);
    });
  });

  describe('testConnection', () => {
    it('should not throw (allows adapter instantiation)', async () => {
      await expect(adapter.testConnection()).resolves.not.toThrow();
    });
  });

  describe('constructor', () => {
    it('should throw error if API key not provided', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'LIGHTER_API_KEY') {
          return undefined;
        }
        return 'test';
      });

      await expect(
        Test.createTestingModule({
          providers: [
            LighterSpotAdapter,
            { provide: ConfigService, useValue: mockConfigService },
          ],
        }).compile(),
      ).rejects.toThrow('Lighter spot adapter requires LIGHTER_API_KEY');
    });
  });
});

