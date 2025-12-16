import { Test, TestingModule } from '@nestjs/testing';
import { PortfolioOptimizer } from './PortfolioOptimizer';
import { CostCalculator } from './CostCalculator';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import {
  HistoricalFundingRateService,
  HistoricalMetrics,
} from '../../../infrastructure/services/HistoricalFundingRateService';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { ExchangeType } from '../../value-objects/ExchangeConfig';

describe('PortfolioOptimizer', () => {
  let optimizer: PortfolioOptimizer;
  let mockCostCalculator: jest.Mocked<CostCalculator>;
  let mockHistoricalService: jest.Mocked<HistoricalFundingRateService>;
  let config: StrategyConfig;

  beforeEach(async () => {
    config = StrategyConfig.withDefaults();

    mockCostCalculator = {
      calculateSlippageCost: jest.fn(),
      predictFundingRateImpact: jest.fn(),
      calculateFees: jest.fn(),
      calculateBreakEvenHours: jest.fn(),
    } as any;

    mockHistoricalService = {
      getWeightedAverageRate: jest.fn(),
      getAverageSpread: jest.fn(),
      getHistoricalData: jest.fn(),
      getSpreadVolatilityMetrics: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioOptimizer,
        { provide: CostCalculator, useValue: mockCostCalculator },
        {
          provide: HistoricalFundingRateService,
          useValue: mockHistoricalService,
        },
        { provide: StrategyConfig, useValue: config },
      ],
    }).compile();

    optimizer = module.get<PortfolioOptimizer>(PortfolioOptimizer);
  });

  describe('calculateMaxPortfolioForTargetAPY', () => {
    const createMockOpportunity = (): ArbitrageOpportunity => ({
      symbol: 'ETHUSDT',
      longExchange: ExchangeType.LIGHTER,
      shortExchange: ExchangeType.ASTER,
      longRate: 0.0003,
      shortRate: 0.0001,
      spread: 0.0002,
      expectedReturn: 0.219,
      longMarkPrice: 3001,
      shortMarkPrice: 3000,
      longOpenInterest: 1000000,
      shortOpenInterest: 1000000,
      timestamp: new Date(),
    });

    beforeEach(() => {
      mockCostCalculator.calculateSlippageCost.mockReturnValue(1.0);
      mockCostCalculator.predictFundingRateImpact.mockReturnValue(0);
      mockHistoricalService.getWeightedAverageRate.mockImplementation(
        (symbol, exchange, currentRate) => currentRate,
      );
      mockHistoricalService.getAverageSpread.mockReturnValue(0.0002);
      mockHistoricalService.getHistoricalData.mockReturnValue([]);
    });

    it('should return null if gross APY is too low', async () => {
      const opportunity = createMockOpportunity();
      mockHistoricalService.getAverageSpread.mockReturnValue(0.00001); // Very low spread

      const result = await optimizer.calculateMaxPortfolioForTargetAPY(
        opportunity,
        { bestBid: 2999, bestAsk: 3001 },
        { bestBid: 3000, bestAsk: 3002 },
        0.35,
      );

      expect(result).toBeNull();
    });

    it('should return null if open interest is zero', async () => {
      const opportunity = createMockOpportunity();
      opportunity.longOpenInterest = 0;
      opportunity.shortOpenInterest = 0;

      const result = await optimizer.calculateMaxPortfolioForTargetAPY(
        opportunity,
        { bestBid: 2999, bestAsk: 3001 },
        { bestBid: 3000, bestAsk: 3002 },
        0.35,
      );

      expect(result).toBeNull();
    });

    it('should calculate max portfolio using binary search', async () => {
      const opportunity = createMockOpportunity();

      const result = await optimizer.calculateMaxPortfolioForTargetAPY(
        opportunity,
        { bestBid: 2999, bestAsk: 3001 },
        { bestBid: 3000, bestAsk: 3002 },
        0.35,
      );

      expect(result).not.toBeNull();
      expect(result!).toBeGreaterThan(1000); // Minimum $1k
      expect(result!).toBeLessThan(100000); // Less than 10% of OI
    });

    it('should apply volatility adjustments when volatility metrics available', async () => {
      const opportunity = createMockOpportunity();
      const volatilityMetrics: HistoricalMetrics = {
        stabilityScore: 0.3, // Low stability = high volatility
        maxHourlySpreadChange: 0.0002,
        spreadReversals: 10,
        spreadDropsToZero: 2,
      };
      mockHistoricalService.getSpreadVolatilityMetrics.mockReturnValue(
        volatilityMetrics,
      );

      const result = await optimizer.calculateMaxPortfolioForTargetAPY(
        opportunity,
        { bestBid: 2999, bestAsk: 3001 },
        { bestBid: 3000, bestAsk: 3002 },
        0.35,
      );

      expect(result).not.toBeNull();
      // Should be reduced due to volatility
      expect(result!).toBeGreaterThanOrEqual(1000);
    });

    it('should use historical rates instead of current rates', async () => {
      const opportunity = createMockOpportunity();
      mockHistoricalService.getWeightedAverageRate.mockImplementation(
        (symbol, exchange, currentRate) => {
          // Return historical rate (different from current)
          return exchange === ExchangeType.LIGHTER ? 0.00025 : 0.00015;
        },
      );

      const result = await optimizer.calculateMaxPortfolioForTargetAPY(
        opportunity,
        { bestBid: 2999, bestAsk: 3001 },
        { bestBid: 3000, bestAsk: 3002 },
        0.35,
      );

      expect(mockHistoricalService.getWeightedAverageRate).toHaveBeenCalled();
      expect(result).not.toBeNull();
    });

    it('should account for funding rate impact in calculations', async () => {
      const opportunity = createMockOpportunity();
      // Mock funding impact
      mockCostCalculator.predictFundingRateImpact.mockReturnValue(0.00001);

      const result = await optimizer.calculateMaxPortfolioForTargetAPY(
        opportunity,
        { bestBid: 2999, bestAsk: 3001 },
        { bestBid: 3000, bestAsk: 3002 },
        0.35,
      );

      expect(mockCostCalculator.predictFundingRateImpact).toHaveBeenCalled();
      expect(result).not.toBeNull();
    });

    it('should converge within iteration limit', async () => {
      const opportunity = createMockOpportunity();

      const result = await optimizer.calculateMaxPortfolioForTargetAPY(
        opportunity,
        { bestBid: 2999, bestAsk: 3001 },
        { bestBid: 3000, bestAsk: 3002 },
        0.35,
      );

      // Should converge (not null) and be reasonable
      expect(result).not.toBeNull();
      expect(result!).toBeGreaterThan(0);
    });
  });

  describe('calculateOptimalAllocation', () => {
    const createMockOpportunityInput = () => ({
      opportunity: {
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longRate: 0.0003,
        shortRate: 0.0001,
        spread: 0.0002,
        expectedReturn: 0.219,
        longMarkPrice: 3001,
        shortMarkPrice: 3000,
        longOpenInterest: 1000000,
        shortOpenInterest: 1000000,
        timestamp: new Date(),
      } as ArbitrageOpportunity,
      maxPortfolioFor35APY: 50000,
      longBidAsk: { bestBid: 2999, bestAsk: 3001 },
      shortBidAsk: { bestBid: 3000, bestAsk: 3002 },
    });

    beforeEach(() => {
      mockCostCalculator.calculateSlippageCost.mockReturnValue(1.0);
      mockCostCalculator.predictFundingRateImpact.mockReturnValue(0);
      mockHistoricalService.getAverageSpread.mockReturnValue(0.0002);
      mockHistoricalService.getWeightedAverageRate.mockImplementation(
        (symbol, exchange, currentRate) => currentRate,
      );
      mockHistoricalService.getSpreadVolatilityMetrics.mockReturnValue(null);
      mockHistoricalService.getHistoricalData.mockReturnValue([]);
    });

    it('should filter out opportunities without maxPortfolio', async () => {
      const opportunities = [
        createMockOpportunityInput(),
        {
          ...createMockOpportunityInput(),
          opportunity: {
            ...createMockOpportunityInput().opportunity,
            symbol: 'BTCUSDT',
          },
          maxPortfolioFor35APY: null,
        },
      ];

      // Mock validation to pass for the first opportunity
      const currentSpread = Math.abs(
        opportunities[0].opportunity.longRate -
          opportunities[0].opportunity.shortRate,
      );
      // Make sure historical spread is different from current
      mockHistoricalService.getAverageSpread.mockReturnValue(
        currentSpread + 0.0001,
      );

      const result = await optimizer.calculateOptimalAllocation(
        opportunities,
        100000,
        0.35,
      );

      expect(result.allocations.size).toBe(1);
      expect(result.allocations.has('ETHUSDT')).toBe(true);
    });

    it('should filter out opportunities with invalid historical data', async () => {
      const opportunities = [createMockOpportunityInput()];
      // Mock validation to fail
      mockHistoricalService.getAverageSpread.mockReturnValue(0.6); // > 50% threshold

      const result = await optimizer.calculateOptimalAllocation(
        opportunities,
        100000,
        0.35,
      );

      expect(result.allocations.size).toBe(0);
      expect(result.dataQualityWarnings.length).toBeGreaterThan(0);
    });

    it('should allocate proportionally based on max portfolios', async () => {
      const opportunities = [
        createMockOpportunityInput(),
        {
          ...createMockOpportunityInput(),
          opportunity: {
            ...createMockOpportunityInput().opportunity,
            symbol: 'BTCUSDT',
          },
          maxPortfolioFor35APY: 30000,
        },
      ];

      // Mock validation to pass for both opportunities
      mockHistoricalService.getAverageSpread.mockImplementation(() => {
        // Return different spread than current to pass validation
        return 0.0003; // Different from current spread (0.0002)
      });

      const result = await optimizer.calculateOptimalAllocation(
        opportunities,
        100000,
        0.35,
      );

      expect(result.allocations.size).toBe(2);
      expect(result.totalPortfolio).toBeGreaterThan(0);
      expect(result.aggregateAPY).toBeGreaterThan(0);
    });

    it('should respect totalCapital constraint', async () => {
      const opportunities = [
        {
          ...createMockOpportunityInput(),
          maxPortfolioFor35APY: 200000, // Very large
        },
      ];

      const result = await optimizer.calculateOptimalAllocation(
        opportunities,
        50000, // Limited capital
        0.35,
      );

      expect(result.totalPortfolio).toBeLessThanOrEqual(50000);
    });

    it('should apply data quality risk factor to allocations', async () => {
      const opportunities = [createMockOpportunityInput()];
      // Mock poor data quality
      mockHistoricalService.getHistoricalData.mockReturnValue(
        new Array(10), // Very few data points
      );
      // Mock validation to pass
      mockHistoricalService.getAverageSpread.mockReturnValue(0.0003);

      const result = await optimizer.calculateOptimalAllocation(
        opportunities,
        100000,
        0.35,
      );

      // Should still allocate but potentially reduced
      expect(result.allocations.size).toBeGreaterThan(0);
    });

    it('should return empty allocation if no valid opportunities', async () => {
      const opportunities = [
        {
          ...createMockOpportunityInput(),
          maxPortfolioFor35APY: null,
        },
      ];

      const result = await optimizer.calculateOptimalAllocation(
        opportunities,
        100000,
        0.35,
      );

      expect(result.allocations.size).toBe(0);
      expect(result.totalPortfolio).toBe(0);
      expect(result.aggregateAPY).toBe(0);
    });
  });

  describe('calculateDataQualityRiskFactor', () => {
    const createMockOpportunity = (): ArbitrageOpportunity => ({
      symbol: 'ETHUSDT',
      longExchange: ExchangeType.LIGHTER,
      shortExchange: ExchangeType.ASTER,
      longRate: 0.0003,
      shortRate: 0.0001,
      spread: 0.0002,
      expectedReturn: 0.219,
      longMarkPrice: 3001,
      shortMarkPrice: 3000,
      longOpenInterest: 1000000,
      shortOpenInterest: 1000000,
      timestamp: new Date(),
    });

    it('should return 0.3 for very poor data (<10% of target)', () => {
      const opportunity = createMockOpportunity();
      mockHistoricalService.getHistoricalData.mockReturnValue(
        new Array(5), // Very few data points
      );

      const riskFactor = optimizer.calculateDataQualityRiskFactor(opportunity);

      expect(riskFactor).toBe(0.3);
    });

    it('should return higher factor for better data (50%+ of target)', () => {
      const opportunity = createMockOpportunity();
      mockHistoricalService.getHistoricalData.mockReturnValue(
        new Array(100), // Good data
      );

      const riskFactor = optimizer.calculateDataQualityRiskFactor(opportunity);

      expect(riskFactor).toBeGreaterThan(0.7);
      expect(riskFactor).toBeLessThanOrEqual(1.0);
    });

    it('should use Aster-specific thresholds for Aster exchange', () => {
      const opportunity = createMockOpportunity();
      opportunity.longExchange = ExchangeType.ASTER;
      opportunity.shortExchange = ExchangeType.ASTER;
      // 15 points for Aster (target is 21) = 15/21 = 0.714, which is > 0.5, so goes to "good data" range
      // Use fewer points to stay in "poor data" range
      mockHistoricalService.getHistoricalData.mockReturnValue(
        new Array(10), // 10 points for Aster (target is 21) = 10/21 = 0.476, which is < 0.5
      );

      const riskFactor = optimizer.calculateDataQualityRiskFactor(opportunity);

      // Should be between 0.3 and 0.7 (poor data range)
      expect(riskFactor).toBeGreaterThanOrEqual(0.3);
      expect(riskFactor).toBeLessThanOrEqual(0.7);
    });

    it('should use minimum quality from both exchanges', () => {
      const opportunity = createMockOpportunity();
      mockHistoricalService.getHistoricalData.mockImplementation(
        (symbol, exchange) => {
          // Long exchange has good data, short has poor data
          return exchange === ExchangeType.LIGHTER
            ? new Array(200)
            : new Array(10);
        },
      );

      const riskFactor = optimizer.calculateDataQualityRiskFactor(opportunity);

      // Should use minimum (poor data from short exchange)
      expect(riskFactor).toBeLessThan(0.7);
    });

    it('should clamp risk factor between 0.1 and 1.0', () => {
      const opportunity = createMockOpportunity();
      mockHistoricalService.getHistoricalData.mockReturnValue([]); // No data

      const riskFactor = optimizer.calculateDataQualityRiskFactor(opportunity);

      expect(riskFactor).toBeGreaterThanOrEqual(0.1);
      expect(riskFactor).toBeLessThanOrEqual(1.0);
    });
  });

  describe('validateHistoricalDataQuality', () => {
    const createMockOpportunity = (): ArbitrageOpportunity => ({
      symbol: 'ETHUSDT',
      longExchange: ExchangeType.LIGHTER,
      shortExchange: ExchangeType.ASTER,
      longRate: 0.0003,
      shortRate: 0.0001,
      spread: 0.0002,
      expectedReturn: 0.219,
      longMarkPrice: 3001,
      shortMarkPrice: 3000,
      longOpenInterest: 1000000,
      shortOpenInterest: 1000000,
      timestamp: new Date(),
    });

    it('should reject spreads exceeding 50% threshold', () => {
      const opportunity = createMockOpportunity();
      const historicalSpread = 0.6; // 60% - exceeds threshold

      const result = optimizer.validateHistoricalDataQuality(
        opportunity,
        historicalSpread,
      );

      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('exceeds 50% threshold');
    });

    it('should accept valid spreads', () => {
      const opportunity = createMockOpportunity();
      // Historical spread must be different from current spread to pass validation
      const currentSpread = Math.abs(
        opportunity.longRate - opportunity.shortRate,
      );
      const historicalSpread = currentSpread + 0.0001; // Different from current

      const result = optimizer.validateHistoricalDataQuality(
        opportunity,
        historicalSpread,
      );

      expect(result.isValid).toBe(true);
    });

    it('should reject when historical spread equals current spread (fallback)', () => {
      const opportunity = createMockOpportunity();
      const currentSpread = Math.abs(
        opportunity.longRate - opportunity.shortRate,
      );
      const historicalSpread = currentSpread; // Same as current

      const result = optimizer.validateHistoricalDataQuality(
        opportunity,
        historicalSpread,
      );

      expect(result.isValid).toBe(false);
      expect(result.reason).toContain('No historical matched data');
    });

    it('should accept negative spreads (reverse arbitrage)', () => {
      const opportunity = createMockOpportunity();
      const historicalSpread = -0.0001; // Negative spread

      const result = optimizer.validateHistoricalDataQuality(
        opportunity,
        historicalSpread,
      );

      expect(result.isValid).toBe(true);
    });
  });
});
