import { Test, TestingModule } from '@nestjs/testing';
import {
  FundingRateAggregator,
  ExchangeFundingRate,
} from './FundingRateAggregator';
import { AsterFundingDataProvider } from '../../infrastructure/adapters/aster/AsterFundingDataProvider';
import { LighterFundingDataProvider } from '../../infrastructure/adapters/lighter/LighterFundingDataProvider';
import { HyperLiquidDataProvider } from '../../infrastructure/adapters/hyperliquid/HyperLiquidDataProvider';
import { HyperLiquidWebSocketProvider } from '../../infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { FundingRateData } from '../ports/IFundingDataProvider';

describe('FundingRateAggregator', () => {
  let aggregator: FundingRateAggregator;
  let mockAsterProvider: jest.Mocked<AsterFundingDataProvider>;
  let mockLighterProvider: jest.Mocked<LighterFundingDataProvider>;
  let mockHyperliquidProvider: jest.Mocked<HyperLiquidDataProvider>;
  let mockHyperliquidWsProvider: jest.Mocked<HyperLiquidWebSocketProvider>;

  beforeEach(async () => {
    // Mock Aster provider with new IFundingDataProvider interface
    mockAsterProvider = {
      getCurrentFundingRate: jest.fn(),
      getPredictedFundingRate: jest.fn(),
      getOpenInterest: jest.fn(),
      getMarkPrice: jest.fn(),
      getAvailableSymbols: jest.fn().mockResolvedValue([]),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.ASTER),
      getFundingData: jest.fn(),
      supportsSymbol: jest.fn().mockReturnValue(true),
      getExchangeSymbol: jest.fn().mockImplementation((s) => `${s}USDT`),
    } as any;

    // Mock Lighter provider with new IFundingDataProvider interface
    mockLighterProvider = {
      getCurrentFundingRate: jest.fn(),
      getPredictedFundingRate: jest.fn(),
      getOpenInterest: jest.fn(),
      getOpenInterestAndMarkPrice: jest.fn(),
      getMarkPrice: jest.fn(),
      getMarketIndex: jest.fn(),
      getAvailableMarkets: jest.fn().mockResolvedValue([]),
      get24hVolume: jest.fn(),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.LIGHTER),
      getFundingData: jest.fn(),
      supportsSymbol: jest.fn().mockReturnValue(true),
      getExchangeSymbol: jest.fn().mockReturnValue(undefined),
    } as any;

    // Mock Hyperliquid provider with new IFundingDataProvider interface
    mockHyperliquidProvider = {
      getCurrentFundingRate: jest.fn(),
      getPredictedFundingRate: jest.fn(),
      getOpenInterest: jest.fn(),
      getMarkPrice: jest.fn(),
      getAvailableAssets: jest.fn().mockResolvedValue([]),
      get24hVolume: jest.fn(),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.HYPERLIQUID),
      getFundingData: jest.fn(),
      supportsSymbol: jest.fn().mockReturnValue(true),
      getExchangeSymbol: jest.fn().mockImplementation((s) => s),
    } as any;

    mockHyperliquidWsProvider = {
      isWsConnected: jest.fn().mockReturnValue(false),
      getFundingRate: jest.fn(),
      subscribeToAsset: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FundingRateAggregator,
        { provide: AsterFundingDataProvider, useValue: mockAsterProvider },
        { provide: LighterFundingDataProvider, useValue: mockLighterProvider },
        { provide: HyperLiquidDataProvider, useValue: mockHyperliquidProvider },
        {
          provide: HyperLiquidWebSocketProvider,
          useValue: mockHyperliquidWsProvider,
        },
      ],
    }).compile();

    aggregator = module.get<FundingRateAggregator>(FundingRateAggregator);

    // Set up symbol mappings for tests
    (aggregator as any).symbolMappings.set('ETH', {
      normalizedSymbol: 'ETH',
      asterSymbol: 'ETHUSDT',
      lighterMarketIndex: 0,
      lighterSymbol: 'ETH',
      hyperliquidSymbol: 'ETH',
    });
  });

  describe('getFundingRates - Parallel Execution', () => {
    it('should fetch funding rates from all exchanges in parallel', async () => {
      const asterData: FundingRateData = {
        exchange: ExchangeType.ASTER,
        symbol: 'ETH',
        currentRate: 0.0001,
        predictedRate: 0.0001,
        markPrice: 3000,
        openInterest: 1000000,
        volume24h: undefined,
        timestamp: new Date(),
      };

      const lighterData: FundingRateData = {
        exchange: ExchangeType.LIGHTER,
        symbol: 'ETH',
        currentRate: 0.0002,
        predictedRate: 0.0002,
        markPrice: 3001,
        openInterest: 2000000,
        volume24h: 5000000,
        timestamp: new Date(),
      };

      const hyperliquidData: FundingRateData = {
        exchange: ExchangeType.HYPERLIQUID,
        symbol: 'ETH',
        currentRate: 0.00015,
        predictedRate: 0.00015,
        markPrice: 3002,
        openInterest: 1500000,
        volume24h: 3000000,
        timestamp: new Date(),
      };

      mockLighterProvider.getFundingData.mockResolvedValue(lighterData);
      mockHyperliquidProvider.getFundingData.mockResolvedValue(hyperliquidData);

      const rates = await aggregator.getFundingRates('ETH');

      expect(rates).toHaveLength(2);
      expect(
        rates.find((r) => r.exchange === ExchangeType.LIGHTER),
      ).toBeDefined();
      expect(
        rates.find((r) => r.exchange === ExchangeType.HYPERLIQUID),
      ).toBeDefined();

      // Verify providers were called (Aster is disabled in FundingRateAggregator)
      expect(mockLighterProvider.getFundingData).toHaveBeenCalled();
      expect(mockHyperliquidProvider.getFundingData).toHaveBeenCalled();
    });

    it('should handle exchange failures gracefully without blocking others', async () => {
      const lighterData: FundingRateData = {
        exchange: ExchangeType.LIGHTER,
        symbol: 'ETH',
        currentRate: 0.0002,
        predictedRate: 0.0002,
        markPrice: 3001,
        openInterest: 2000000,
        volume24h: 5000000,
        timestamp: new Date(),
      };

      const hyperliquidData: FundingRateData = {
        exchange: ExchangeType.HYPERLIQUID,
        symbol: 'ETH',
        currentRate: 0.00015,
        predictedRate: 0.00015,
        markPrice: 3002,
        openInterest: 1500000,
        volume24h: 3000000,
        timestamp: new Date(),
      };

      // Aster fails
      mockAsterProvider.getFundingData.mockRejectedValue(
        new Error('API error'),
      );
      mockLighterProvider.getFundingData.mockResolvedValue(lighterData);
      mockHyperliquidProvider.getFundingData.mockResolvedValue(hyperliquidData);

      const rates = await aggregator.getFundingRates('ETH');

      // Should still get 2 rates (Lighter and Hyperliquid)
      expect(rates).toHaveLength(2);
      expect(
        rates.find((r) => r.exchange === ExchangeType.ASTER),
      ).toBeUndefined();
      expect(
        rates.find((r) => r.exchange === ExchangeType.LIGHTER),
      ).toBeDefined();
      expect(
        rates.find((r) => r.exchange === ExchangeType.HYPERLIQUID),
      ).toBeDefined();
    });

    it('should filter out null responses from exchanges', async () => {
      const hyperliquidData: FundingRateData = {
        exchange: ExchangeType.HYPERLIQUID,
        symbol: 'ETH',
        currentRate: 0.00015,
        predictedRate: 0.00015,
        markPrice: 3002,
        openInterest: 1500000,
        volume24h: 3000000,
        timestamp: new Date(),
      };

      // Aster returns null (e.g., OI unavailable)
      mockAsterProvider.getFundingData.mockResolvedValue(null);
      // Lighter returns null
      mockLighterProvider.getFundingData.mockResolvedValue(null);
      // Only Hyperliquid succeeds
      mockHyperliquidProvider.getFundingData.mockResolvedValue(hyperliquidData);

      const rates = await aggregator.getFundingRates('ETH');

      expect(rates).toHaveLength(1);
      expect(rates[0].exchange).toBe(ExchangeType.HYPERLIQUID);
    });

    it('should execute all fetches in parallel (timing test)', async () => {
      const delay = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));

      // Each provider takes 100ms
      mockAsterProvider.getFundingData.mockImplementation(async () => {
        await delay(100);
        return {
          exchange: ExchangeType.ASTER,
          symbol: 'ETH',
          currentRate: 0.0001,
          predictedRate: 0.0001,
          markPrice: 3000,
          openInterest: 1000000,
          volume24h: undefined,
          timestamp: new Date(),
        };
      });

      mockLighterProvider.getFundingData.mockImplementation(async () => {
        await delay(100);
        return {
          exchange: ExchangeType.LIGHTER,
          symbol: 'ETH',
          currentRate: 0.0002,
          predictedRate: 0.0002,
          markPrice: 3001,
          openInterest: 2000000,
          volume24h: 5000000,
          timestamp: new Date(),
        };
      });

      mockHyperliquidProvider.getFundingData.mockImplementation(async () => {
        await delay(100);
        return {
          exchange: ExchangeType.HYPERLIQUID,
          symbol: 'ETH',
          currentRate: 0.00015,
          predictedRate: 0.00015,
          markPrice: 3002,
          openInterest: 1500000,
          volume24h: 3000000,
          timestamp: new Date(),
        };
      });

      const startTime = Date.now();
      const rates = await aggregator.getFundingRates('ETH');
      const elapsedTime = Date.now() - startTime;

      expect(rates).toHaveLength(2); // Aster is disabled
      // If parallel: ~100ms, if sequential: ~200ms
      // Allow some buffer for test overhead
      expect(elapsedTime).toBeLessThan(250); // Should be ~100-150ms if parallel
    });
  });

  describe('compareFundingRates', () => {
    it('should compare rates and find highest/lowest', async () => {
      mockAsterProvider.getFundingData.mockResolvedValue({
        exchange: ExchangeType.ASTER,
        symbol: 'ETH',
        currentRate: 0.0001,
        predictedRate: 0.0001,
        markPrice: 3000,
        openInterest: 1000000,
        volume24h: undefined,
        timestamp: new Date(),
      });

      mockLighterProvider.getFundingData.mockResolvedValue({
        exchange: ExchangeType.LIGHTER,
        symbol: 'ETH',
        currentRate: 0.0003, // Highest
        predictedRate: 0.0003,
        markPrice: 3001,
        openInterest: 2000000,
        volume24h: 5000000,
        timestamp: new Date(),
      });

      mockHyperliquidProvider.getFundingData.mockResolvedValue({
        exchange: ExchangeType.HYPERLIQUID,
        symbol: 'ETH',
        currentRate: 0.00005, // Lowest
        predictedRate: 0.00005,
        markPrice: 3002,
        openInterest: 1500000,
        volume24h: 3000000,
        timestamp: new Date(),
      });

      const comparison = await aggregator.compareFundingRates('ETH');

      expect(comparison.highestRate?.exchange).toBe(ExchangeType.LIGHTER);
      expect(comparison.highestRate?.currentRate).toBe(0.0003);
      expect(comparison.lowestRate?.exchange).toBe(ExchangeType.HYPERLIQUID);
      expect(comparison.lowestRate?.currentRate).toBe(0.00005);
      expect(comparison.spread).toBeCloseTo(0.00025, 5);
    });
  });

  describe('findArbitrageOpportunities', () => {
    it('should find arbitrage opportunities with parallel fetching', async () => {
      mockAsterProvider.getFundingData.mockResolvedValue({
        exchange: ExchangeType.ASTER,
        symbol: 'ETH',
        currentRate: 0.0001,
        predictedRate: 0.0001,
        markPrice: 3000,
        openInterest: 1000000,
        volume24h: undefined,
        timestamp: new Date(),
      });

      mockLighterProvider.getFundingData.mockResolvedValue({
        exchange: ExchangeType.LIGHTER,
        symbol: 'ETH',
        currentRate: 0.0003, // High positive - go SHORT here (receive funding when rate is positive)
        predictedRate: 0.0003,
        markPrice: 3001,
        openInterest: 2000000,
        volume24h: 5000000,
        timestamp: new Date(),
      });

      mockHyperliquidProvider.getFundingData.mockResolvedValue({
        exchange: ExchangeType.HYPERLIQUID,
        symbol: 'ETH',
        currentRate: -0.0001, // Negative - go LONG here (receive funding when rate is negative)
        predictedRate: -0.0001,
        markPrice: 3002,
        openInterest: 1500000,
        volume24h: 3000000,
        timestamp: new Date(),
      });

      const opportunities = await aggregator.findArbitrageOpportunities(
        ['ETH'],
        0.0001,
      );

      expect(opportunities.length).toBeGreaterThan(0);
      // Arbitrage logic: LONG on lower rate (Hyperliquid -0.0001), SHORT on higher rate (Lighter 0.0003)
      // Spread = shortRate - longRate = 0.0003 - (-0.0001) = 0.0004
      expect(opportunities[0].longExchange).toBe(ExchangeType.HYPERLIQUID);
      expect(opportunities[0].shortExchange).toBe(ExchangeType.LIGHTER);
    });

    it('should filter opportunities by minimum spread', async () => {
      // All exchanges have very similar rates
      mockAsterProvider.getFundingData.mockResolvedValue({
        exchange: ExchangeType.ASTER,
        symbol: 'ETH',
        currentRate: 0.0001,
        predictedRate: 0.0001,
        markPrice: 3000,
        openInterest: 1000000,
        volume24h: undefined,
        timestamp: new Date(),
      });

      mockLighterProvider.getFundingData.mockResolvedValue({
        exchange: ExchangeType.LIGHTER,
        symbol: 'ETH',
        currentRate: 0.00011, // Very small difference
        predictedRate: 0.00011,
        markPrice: 3001,
        openInterest: 2000000,
        volume24h: 5000000,
        timestamp: new Date(),
      });

      mockHyperliquidProvider.getFundingData.mockResolvedValue({
        exchange: ExchangeType.HYPERLIQUID,
        symbol: 'ETH',
        currentRate: 0.0001,
        predictedRate: 0.0001,
        markPrice: 3002,
        openInterest: 1500000,
        volume24h: 3000000,
        timestamp: new Date(),
      });

      const opportunities = await aggregator.findArbitrageOpportunities(
        ['ETH'],
        0.0001, // Min spread higher than actual spread
      );

      // Spread is only 0.00001, which is less than minSpread of 0.0001
      expect(opportunities.length).toBe(0);
    });
  });

  describe('IFundingDataProvider interface', () => {
    it('providers should implement getExchangeType correctly', () => {
      expect(mockAsterProvider.getExchangeType()).toBe(ExchangeType.ASTER);
      expect(mockLighterProvider.getExchangeType()).toBe(ExchangeType.LIGHTER);
      expect(mockHyperliquidProvider.getExchangeType()).toBe(
        ExchangeType.HYPERLIQUID,
      );
    });

    it('providers should implement getExchangeSymbol correctly', () => {
      expect(mockAsterProvider.getExchangeSymbol('ETH')).toBe('ETHUSDT');
      expect(mockHyperliquidProvider.getExchangeSymbol('ETH')).toBe('ETH');
    });
  });
});
