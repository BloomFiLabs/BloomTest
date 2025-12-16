import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AsterFundingDataProvider } from './AsterFundingDataProvider';
import { ExchangeType } from '../../../domain/value-objects/ExchangeConfig';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('AsterFundingDataProvider', () => {
  let provider: AsterFundingDataProvider;
  let mockAxiosInstance: any;

  beforeEach(async () => {
    mockAxiosInstance = {
      get: jest.fn(),
    };
    mockedAxios.create.mockReturnValue(mockAxiosInstance);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AsterFundingDataProvider,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('https://fapi.asterdex.com'),
          },
        },
      ],
    }).compile();

    provider = module.get<AsterFundingDataProvider>(AsterFundingDataProvider);
  });

  describe('IFundingDataProvider interface', () => {
    it('should return correct exchange type', () => {
      expect(provider.getExchangeType()).toBe(ExchangeType.ASTER);
    });

    it('should convert normalized symbol to Aster format', () => {
      expect(provider.getExchangeSymbol('ETH')).toBe('ETHUSDT');
      expect(provider.getExchangeSymbol('BTC')).toBe('BTCUSDT');
    });

    it('should support all symbols', () => {
      expect(provider.supportsSymbol('ETH')).toBe(true);
      expect(provider.supportsSymbol('BTC')).toBe(true);
    });
  });

  describe('getFundingData', () => {
    it('should fetch all funding data in parallel', async () => {
      // Mock API responses
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: { lastFundingRate: '0.0001' } }) // getCurrentFundingRate
        .mockResolvedValueOnce({ data: { price: '3000' } }) // getMarkPrice
        .mockResolvedValueOnce({ data: { openInterest: '1000', markPrice: '3000' } }); // getOpenInterest

      const result = await provider.getFundingData({
        normalizedSymbol: 'ETH',
        exchangeSymbol: 'ETHUSDT',
      });

      expect(result).not.toBeNull();
      expect(result!.exchange).toBe(ExchangeType.ASTER);
      expect(result!.symbol).toBe('ETH');
      expect(result!.currentRate).toBe(0.0001);
      expect(result!.markPrice).toBe(3000);
      expect(result!.openInterest).toBe(3000000); // 1000 * 3000
    });

    it('should return null when OI is unavailable', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({ data: { lastFundingRate: '0.0001' } })
        .mockResolvedValueOnce({ data: { price: '3000' } })
        .mockRejectedValueOnce(new Error('OI API error')); // OI fails

      const result = await provider.getFundingData({
        normalizedSymbol: 'ETH',
        exchangeSymbol: 'ETHUSDT',
      });

      expect(result).toBeNull();
    });

    it('should return null on API error', async () => {
      mockAxiosInstance.get.mockRejectedValue(new Error('API error'));

      const result = await provider.getFundingData({
        normalizedSymbol: 'ETH',
        exchangeSymbol: 'ETHUSDT',
      });

      expect(result).toBeNull();
    });
  });

  describe('getCurrentFundingRate', () => {
    it('should fetch and parse funding rate', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: { lastFundingRate: '0.0001' },
      });

      const rate = await provider.getCurrentFundingRate('ETHUSDT');

      expect(rate).toBe(0.0001);
      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/fapi/v1/premiumIndex', {
        params: { symbol: 'ETHUSDT' },
      });
    });

    it('should handle fundingRate field', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: { fundingRate: '0.0002' },
      });

      const rate = await provider.getCurrentFundingRate('ETHUSDT');

      expect(rate).toBe(0.0002);
    });
  });

  describe('getOpenInterest', () => {
    it('should calculate OI in USD', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: { openInterest: '1000', markPrice: '3000' },
        });

      const oi = await provider.getOpenInterest('ETHUSDT');

      expect(oi).toBe(3000000); // 1000 * 3000
    });

    it('should throw error when openInterest is missing', async () => {
      mockAxiosInstance.get.mockResolvedValue({
        data: { markPrice: '3000' },
      });

      await expect(provider.getOpenInterest('ETHUSDT')).rejects.toThrow(
        'openInterest field missing',
      );
    });
  });
});

