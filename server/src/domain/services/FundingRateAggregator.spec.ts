import { Test, TestingModule } from '@nestjs/testing';
import { FundingRateAggregator } from './FundingRateAggregator';
import { AsterFundingDataProvider } from '../../infrastructure/adapters/aster/AsterFundingDataProvider';
import { LighterFundingDataProvider } from '../../infrastructure/adapters/lighter/LighterFundingDataProvider';
import { HyperLiquidDataProvider } from '../../infrastructure/adapters/hyperliquid/HyperLiquidDataProvider';
import { ExchangeType } from '../value-objects/ExchangeConfig';

describe('FundingRateAggregator', () => {
  let aggregator: FundingRateAggregator;
  let mockAsterProvider: jest.Mocked<AsterFundingDataProvider>;
  let mockLighterProvider: jest.Mocked<LighterFundingDataProvider>;
  let mockHyperliquidProvider: jest.Mocked<HyperLiquidDataProvider>;

  beforeEach(async () => {
    mockAsterProvider = {
      getCurrentFundingRate: jest.fn(),
      getPredictedFundingRate: jest.fn(),
      getOpenInterest: jest.fn(),
      getMarkPrice: jest.fn(),
    } as any;

    mockLighterProvider = {
      getCurrentFundingRate: jest.fn(),
      getPredictedFundingRate: jest.fn(),
      getOpenInterest: jest.fn(),
      getMarkPrice: jest.fn(),
      getMarketIndex: jest.fn(),
    } as any;

    mockHyperliquidProvider = {
      getCurrentFundingRate: jest.fn(),
      getPredictedFundingRate: jest.fn(),
      getOpenInterest: jest.fn(),
      getMarkPrice: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FundingRateAggregator,
        { provide: AsterFundingDataProvider, useValue: mockAsterProvider },
        { provide: LighterFundingDataProvider, useValue: mockLighterProvider },
        { provide: HyperLiquidDataProvider, useValue: mockHyperliquidProvider },
      ],
    }).compile();

    aggregator = module.get<FundingRateAggregator>(FundingRateAggregator);
  });

  describe('getFundingRates', () => {
    it('should aggregate funding rates from all exchanges', async () => {
      mockAsterProvider.getCurrentFundingRate.mockResolvedValue(0.0001);
      mockAsterProvider.getPredictedFundingRate.mockResolvedValue(0.0001);
      mockAsterProvider.getMarkPrice.mockResolvedValue(3000);
      mockAsterProvider.getOpenInterest.mockResolvedValue(1000000);

      mockLighterProvider.getMarketIndex.mockResolvedValue(0);
      mockLighterProvider.getCurrentFundingRate.mockResolvedValue(0.0002);
      mockLighterProvider.getPredictedFundingRate.mockResolvedValue(0.0002);
      mockLighterProvider.getMarkPrice.mockResolvedValue(3001);
      mockLighterProvider.getOpenInterest.mockResolvedValue(2000000);

      mockHyperliquidProvider.getCurrentFundingRate.mockResolvedValue(0.00015);
      mockHyperliquidProvider.getPredictedFundingRate.mockResolvedValue(
        0.00015,
      );
      mockHyperliquidProvider.getMarkPrice.mockResolvedValue(3002);
      mockHyperliquidProvider.getOpenInterest.mockResolvedValue(1500000);

      const rates = await aggregator.getFundingRates('ETHUSDT');

      expect(rates).toHaveLength(3);
      expect(
        rates.find((r) => r.exchange === ExchangeType.ASTER),
      ).toBeDefined();
      expect(
        rates.find((r) => r.exchange === ExchangeType.LIGHTER),
      ).toBeDefined();
      expect(
        rates.find((r) => r.exchange === ExchangeType.HYPERLIQUID),
      ).toBeDefined();
    });

    it('should handle exchange failures gracefully', async () => {
      mockAsterProvider.getCurrentFundingRate.mockRejectedValue(
        new Error('API error'),
      );
      mockLighterProvider.getMarketIndex.mockResolvedValue(0);
      mockLighterProvider.getCurrentFundingRate.mockResolvedValue(0.0002);
      mockLighterProvider.getPredictedFundingRate.mockResolvedValue(0.0002);
      mockLighterProvider.getMarkPrice.mockResolvedValue(3001);
      mockLighterProvider.getOpenInterest.mockResolvedValue(2000000);
      mockHyperliquidProvider.getCurrentFundingRate.mockResolvedValue(0.00015);
      mockHyperliquidProvider.getPredictedFundingRate.mockResolvedValue(
        0.00015,
      );
      mockHyperliquidProvider.getMarkPrice.mockResolvedValue(3002);
      mockHyperliquidProvider.getOpenInterest.mockResolvedValue(1500000);

      const rates = await aggregator.getFundingRates('ETHUSDT');

      expect(rates).toHaveLength(2);
      expect(
        rates.find((r) => r.exchange === ExchangeType.ASTER),
      ).toBeUndefined();
    });
  });

  describe('compareFundingRates', () => {
    it('should compare rates and find highest/lowest', async () => {
      mockAsterProvider.getCurrentFundingRate.mockResolvedValue(0.0001);
      mockAsterProvider.getPredictedFundingRate.mockResolvedValue(0.0001);
      mockAsterProvider.getMarkPrice.mockResolvedValue(3000);
      mockAsterProvider.getOpenInterest.mockResolvedValue(1000000);

      mockLighterProvider.getMarketIndex.mockResolvedValue(0);
      mockLighterProvider.getCurrentFundingRate.mockResolvedValue(0.0003);
      mockLighterProvider.getPredictedFundingRate.mockResolvedValue(0.0003);
      mockLighterProvider.getMarkPrice.mockResolvedValue(3001);
      mockLighterProvider.getOpenInterest.mockResolvedValue(2000000);

      mockHyperliquidProvider.getCurrentFundingRate.mockResolvedValue(0.00005);
      mockHyperliquidProvider.getPredictedFundingRate.mockResolvedValue(
        0.00005,
      );
      mockHyperliquidProvider.getMarkPrice.mockResolvedValue(3002);
      mockHyperliquidProvider.getOpenInterest.mockResolvedValue(1500000);

      const comparison = await aggregator.compareFundingRates('ETHUSDT');

      expect(comparison.highestRate?.exchange).toBe(ExchangeType.LIGHTER);
      expect(comparison.highestRate?.currentRate).toBe(0.0003);
      expect(comparison.lowestRate?.exchange).toBe(ExchangeType.HYPERLIQUID);
      expect(comparison.lowestRate?.currentRate).toBe(0.00005);
      expect(comparison.spread).toBeCloseTo(0.00025, 5);
    });
  });

  describe('findArbitrageOpportunities', () => {
    it('should find arbitrage opportunities', async () => {
      mockAsterProvider.getCurrentFundingRate.mockResolvedValue(0.0001);
      mockAsterProvider.getPredictedFundingRate.mockResolvedValue(0.0001);
      mockAsterProvider.getMarkPrice.mockResolvedValue(3000);
      mockAsterProvider.getOpenInterest.mockResolvedValue(1000000);

      mockLighterProvider.getMarketIndex.mockResolvedValue(0);
      mockLighterProvider.getCurrentFundingRate.mockResolvedValue(0.0003);
      mockLighterProvider.getPredictedFundingRate.mockResolvedValue(0.0003);
      mockLighterProvider.getMarkPrice.mockResolvedValue(3001);
      mockLighterProvider.getOpenInterest.mockResolvedValue(2000000);

      mockHyperliquidProvider.getCurrentFundingRate.mockResolvedValue(-0.0001);
      mockHyperliquidProvider.getPredictedFundingRate.mockResolvedValue(
        -0.0001,
      );
      mockHyperliquidProvider.getMarkPrice.mockResolvedValue(3002);
      mockHyperliquidProvider.getOpenInterest.mockResolvedValue(1500000);

      const opportunities = await aggregator.findArbitrageOpportunities(
        ['ETHUSDT'],
        0.0001,
      );

      expect(opportunities.length).toBeGreaterThan(0);
      expect(opportunities[0].longExchange).toBe(ExchangeType.LIGHTER);
      expect(opportunities[0].shortExchange).toBe(ExchangeType.HYPERLIQUID);
      expect(opportunities[0].spread).toBeGreaterThan(0.0001);
    });

    it('should filter opportunities by minimum spread', async () => {
      mockAsterProvider.getCurrentFundingRate.mockResolvedValue(0.0001);
      mockAsterProvider.getPredictedFundingRate.mockResolvedValue(0.0001);
      mockAsterProvider.getMarkPrice.mockResolvedValue(3000);
      mockAsterProvider.getOpenInterest.mockResolvedValue(1000000);

      mockLighterProvider.getMarketIndex.mockResolvedValue(0);
      mockLighterProvider.getCurrentFundingRate.mockResolvedValue(0.00011);
      mockLighterProvider.getPredictedFundingRate.mockResolvedValue(0.00011);
      mockLighterProvider.getMarkPrice.mockResolvedValue(3001);
      mockLighterProvider.getOpenInterest.mockResolvedValue(2000000);

      mockHyperliquidProvider.getCurrentFundingRate.mockResolvedValue(0.0001);
      mockHyperliquidProvider.getPredictedFundingRate.mockResolvedValue(0.0001);
      mockHyperliquidProvider.getMarkPrice.mockResolvedValue(3002);
      mockHyperliquidProvider.getOpenInterest.mockResolvedValue(1500000);

      const opportunities = await aggregator.findArbitrageOpportunities(
        ['ETHUSDT'],
        0.0001,
      );

      // Spread is only 0.00001, which is less than minSpread of 0.0001
      expect(opportunities.length).toBe(0);
    });
  });

  describe('findPerpSpotOpportunities', () => {
    it('should find perp-spot opportunities for exchanges with spot support', async () => {
      // Mock funding rates
      mockHyperliquidProvider.getCurrentFundingRate.mockResolvedValue({
        currentRate: 0.0001, // 0.01% per hour = positive funding
        predictedRate: 0.0001,
        markPrice: 3000,
        openInterest: 1000000,
        volume24h: 5000000,
      });

      const opportunities = await aggregator.findPerpSpotOpportunities(
        ['ETH'],
        0.0001,
        false,
      );

      expect(opportunities.length).toBeGreaterThan(0);
      const opp = opportunities[0];
      expect(opp.strategyType).toBe('perp-spot');
      expect(opp.spotExchange).toBe(ExchangeType.HYPERLIQUID);
      expect(opp.longExchange).toBe(ExchangeType.HYPERLIQUID);
      expect(opp.shortRate).toBeDefined();
    });

    it('should not find opportunities below minimum spread', async () => {
      mockHyperliquidProvider.getCurrentFundingRate.mockResolvedValue({
        currentRate: 0.00001, // Very small rate
        predictedRate: 0.00001,
        markPrice: 3000,
        openInterest: 1000000,
        volume24h: 5000000,
      });

      const opportunities = await aggregator.findPerpSpotOpportunities(
        ['ETH'],
        0.0001, // Min spread higher than rate
        false,
      );

      expect(opportunities.length).toBe(0);
    });
  });
});
