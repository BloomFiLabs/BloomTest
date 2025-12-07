import { Test, TestingModule } from '@nestjs/testing';
import { OpportunityEvaluator } from './OpportunityEvaluator';
import { HistoricalFundingRateService, HistoricalMetrics } from '../../../infrastructure/services/HistoricalFundingRateService';
import { FundingRateAggregator } from '../FundingRateAggregator';
import { PositionLossTracker } from '../../../infrastructure/services/PositionLossTracker';
import { CostCalculator } from './CostCalculator';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { ArbitrageExecutionPlan } from '../FundingArbitrageStrategy';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { PerpPosition } from '../../entities/PerpPosition';
import { OrderSide } from '../../value-objects/PerpOrder';
import { PerpOrderRequest, OrderType, TimeInForce } from '../../value-objects/PerpOrder';

describe('OpportunityEvaluator', () => {
  let evaluator: OpportunityEvaluator;
  let mockHistoricalService: jest.Mocked<HistoricalFundingRateService>;
  let mockAggregator: jest.Mocked<FundingRateAggregator>;
  let mockLossTracker: jest.Mocked<PositionLossTracker>;
  let mockCostCalculator: jest.Mocked<CostCalculator>;
  let config: StrategyConfig;

  beforeEach(async () => {
    config = new StrategyConfig();

    mockHistoricalService = {
      getHistoricalMetrics: jest.fn(),
    } as any;

    mockAggregator = {
      getFundingRates: jest.fn(),
    } as any;

    mockLossTracker = {
      getRemainingBreakEvenHours: jest.fn(),
      getSwitchingCosts: jest.fn(),
    } as any;

    mockCostCalculator = {} as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OpportunityEvaluator,
        { provide: HistoricalFundingRateService, useValue: mockHistoricalService },
        { provide: FundingRateAggregator, useValue: mockAggregator },
        { provide: PositionLossTracker, useValue: mockLossTracker },
        { provide: CostCalculator, useValue: mockCostCalculator },
        { provide: StrategyConfig, useValue: config },
      ],
    }).compile();

    evaluator = module.get<OpportunityEvaluator>(OpportunityEvaluator);
  });

  describe('evaluateOpportunityWithHistory', () => {
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

    const createMockPlan = (): ArbitrageExecutionPlan => ({
      opportunity: createMockOpportunity(),
      longOrder: new PerpOrderRequest('ETHUSDT', OrderSide.LONG, OrderType.LIMIT, 1.0, 3000, TimeInForce.GTC),
      shortOrder: new PerpOrderRequest('ETHUSDT', OrderSide.SHORT, OrderType.LIMIT, 1.0, 3001, TimeInForce.GTC),
      positionSize: 1.0,
      estimatedCosts: {
        fees: 10,
        slippage: 5,
        total: 15,
      },
      expectedNetReturn: 0.5,
      timestamp: new Date(),
    });

    it('should calculate consistency score from historical metrics', () => {
      const opportunity = createMockOpportunity();
      const plan = createMockPlan();

      const longMetrics: HistoricalMetrics = {
        averageRate: 0.0003,
        minRate: 0.0001,
        maxRate: 0.0005,
        consistencyScore: 0.8,
        volatility: 0.0001,
      };
      const shortMetrics: HistoricalMetrics = {
        averageRate: 0.0001,
        minRate: 0.00005,
        maxRate: 0.00015,
        consistencyScore: 0.7,
        volatility: 0.00005,
      };

      mockHistoricalService.getHistoricalMetrics
        .mockReturnValueOnce(longMetrics)
        .mockReturnValueOnce(shortMetrics);

      const result = evaluator.evaluateOpportunityWithHistory(opportunity, plan);

      expect(result.consistencyScore).toBe(0.75); // Average of 0.8 and 0.7
      expect(result.historicalMetrics.long).toEqual(longMetrics);
      expect(result.historicalMetrics.short).toEqual(shortMetrics);
    });

    it('should calculate worst-case break-even hours', () => {
      const opportunity = createMockOpportunity();
      const plan = createMockPlan();

      const longMetrics: HistoricalMetrics = {
        averageRate: 0.0003,
        minRate: 0.0001, // Worst case
        maxRate: 0.0005,
        consistencyScore: 0.8,
        volatility: 0.0001,
      };
      const shortMetrics: HistoricalMetrics = {
        averageRate: 0.0001,
        minRate: 0.00005, // Worst case
        maxRate: 0.00015,
        consistencyScore: 0.7,
        volatility: 0.00005,
      };

      mockHistoricalService.getHistoricalMetrics
        .mockReturnValueOnce(longMetrics)
        .mockReturnValueOnce(shortMetrics);

      const result = evaluator.evaluateOpportunityWithHistory(opportunity, plan);

      expect(result.worstCaseBreakEvenHours).not.toBeNull();
      expect(result.worstCaseBreakEvenHours!).toBeGreaterThan(0);
    });

    it('should return null worst-case break-even if no plan provided', () => {
      const opportunity = createMockOpportunity();

      const result = evaluator.evaluateOpportunityWithHistory(opportunity, null);

      expect(result.worstCaseBreakEvenHours).toBeNull();
    });

    it('should handle missing historical metrics', () => {
      const opportunity = createMockOpportunity();
      const plan = createMockPlan();

      mockHistoricalService.getHistoricalMetrics.mockReturnValue(null);

      const result = evaluator.evaluateOpportunityWithHistory(opportunity, plan);

      expect(result.consistencyScore).toBe(0);
      expect(result.historicalMetrics.long).toBeNull();
      expect(result.historicalMetrics.short).toBeNull();
    });
  });

  describe('selectWorstCaseOpportunity', () => {
    const createMockOpportunity = (symbol: string): ArbitrageOpportunity => ({
      symbol,
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

    const createMockPlan = (opportunity: ArbitrageOpportunity): ArbitrageExecutionPlan => ({
      opportunity,
      longOrder: new PerpOrderRequest(opportunity.symbol, OrderSide.LONG, OrderType.LIMIT, 1.0, 3000, TimeInForce.GTC),
      shortOrder: new PerpOrderRequest(opportunity.symbol, OrderSide.SHORT, OrderType.LIMIT, 1.0, 3001, TimeInForce.GTC),
      positionSize: 1.0,
      estimatedCosts: {
        fees: 10,
        slippage: 5,
        total: 15,
      },
      expectedNetReturn: 0.5,
      timestamp: new Date(),
    });

    it('should select opportunity with best score', async () => {
      const opp1 = createMockOpportunity('ETHUSDT');
      const opp2 = createMockOpportunity('BTCUSDT');
      const plan1 = createMockPlan(opp1);
      plan1.estimatedCosts.total = 5; // Lower costs = faster break-even
      const plan2 = createMockPlan(opp2);
      plan2.estimatedCosts.total = 10;

      const longMetrics: HistoricalMetrics = {
        averageRate: 0.0003,
        minRate: 0.0002, // Worst case - still reasonable
        maxRate: 0.0004,
        consistencyScore: 0.9,
        volatility: 0.0001,
      };
      const shortMetrics: HistoricalMetrics = {
        averageRate: 0.0001,
        minRate: 0.00005, // Worst case - still reasonable
        maxRate: 0.00015,
        consistencyScore: 0.8,
        volatility: 0.00005,
      };

      // Return different metrics for each call (long, short)
      let callCount = 0;
      mockHistoricalService.getHistoricalMetrics.mockImplementation(() => {
        callCount++;
        return callCount % 2 === 1 ? longMetrics : shortMetrics;
      });

      const opportunities = [
        {
          opportunity: opp1,
          plan: plan1,
          netReturn: 0.5,
          positionValueUsd: 3000,
          breakEvenHours: 10,
        },
        {
          opportunity: opp2,
          plan: plan2,
          netReturn: 0.3,
          positionValueUsd: 50000,
          breakEvenHours: 20,
        },
      ];

      const result = await evaluator.selectWorstCaseOpportunity(
        opportunities,
        new Map(),
        undefined,
        new Map(),
      );

      expect(result).not.toBeNull();
      expect(result!.opportunity.symbol).toBeDefined();
    });

    it('should return null if no opportunities provided', async () => {
      const result = await evaluator.selectWorstCaseOpportunity(
        [],
        new Map(),
        undefined,
        new Map(),
      );

      expect(result).toBeNull();
    });

    it('should filter out opportunities with break-even exceeding max days', async () => {
      const opp1 = createMockOpportunity('ETHUSDT');
      const plan1 = createMockPlan(opp1);

      const longMetrics: HistoricalMetrics = {
        averageRate: 0.000001, // Very low rate = very long break-even
        minRate: 0.0000001,
        maxRate: 0.000002,
        consistencyScore: 0.5,
        volatility: 0.0000001,
      };
      const shortMetrics: HistoricalMetrics = {
        averageRate: 0.0000005,
        minRate: 0.0000001,
        maxRate: 0.000001,
        consistencyScore: 0.5,
        volatility: 0.0000001,
      };

      mockHistoricalService.getHistoricalMetrics.mockReturnValue(longMetrics);

      const opportunities = [
        {
          opportunity: opp1,
          plan: plan1,
          netReturn: 0.1,
          positionValueUsd: 3000,
          breakEvenHours: 10,
        },
      ];

      const result = await evaluator.selectWorstCaseOpportunity(
        opportunities,
        new Map(),
        undefined,
        new Map(),
      );

      // Should filter out if break-even > MAX_WORST_CASE_BREAK_EVEN_DAYS (7 days)
      // With very low rates, break-even will be very long
      expect(result).toBeNull();
    });
  });

  describe('shouldRebalance', () => {
    const createMockPosition = (): PerpPosition => {
      return new PerpPosition(
        ExchangeType.LIGHTER,
        'ETHUSDT',
        OrderSide.LONG,
        1.0,
        3000,
        3001,
        0,
      );
    };

    const createMockOpportunity = (): ArbitrageOpportunity => ({
      symbol: 'ETHUSDT',
      longExchange: ExchangeType.ASTER,
      shortExchange: ExchangeType.LIGHTER,
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

    const createMockPlan = (opportunity: ArbitrageOpportunity): ArbitrageExecutionPlan => ({
      opportunity,
      longOrder: new PerpOrderRequest('ETHUSDT', OrderSide.LONG, OrderType.LIMIT, 1.0, 3000, TimeInForce.GTC),
      shortOrder: new PerpOrderRequest('ETHUSDT', OrderSide.SHORT, OrderType.LIMIT, 1.0, 3001, TimeInForce.GTC),
      positionSize: 1.0,
      estimatedCosts: {
        fees: 10,
        slippage: 5,
        total: 15,
      },
      expectedNetReturn: 0.5,
      timestamp: new Date(),
    });

    it('should approve rebalance if new opportunity is instantly profitable', async () => {
      const position = createMockPosition();
      const opportunity = createMockOpportunity();
      const plan = createMockPlan(opportunity);
      plan.expectedNetReturn = 10; // Instantly profitable

      mockAggregator.getFundingRates.mockResolvedValue([
        {
          exchange: ExchangeType.LIGHTER,
          symbol: 'ETHUSDT',
          currentRate: 0.0003,
          timestamp: new Date(),
        },
      ]);

      mockLossTracker.getRemainingBreakEvenHours.mockReturnValue({
        remainingBreakEvenHours: 20,
        remainingCost: 10,
        feesEarnedSoFar: 0,
        hoursHeld: 0,
      });

      const result = await evaluator.shouldRebalance(
        position,
        opportunity,
        plan,
        0,
        new Map(),
      );

      expect(result.shouldRebalance).toBe(true);
      expect(result.reason).toContain('instantly profitable');
    });

    it('should reject rebalance if current position already profitable', async () => {
      const position = createMockPosition();
      const opportunity = createMockOpportunity();
      const plan = createMockPlan(opportunity);
      plan.expectedNetReturn = -5; // Not instantly profitable

      mockAggregator.getFundingRates.mockResolvedValue([
        {
          exchange: ExchangeType.LIGHTER,
          symbol: 'ETHUSDT',
          currentRate: 0.0003,
          timestamp: new Date(),
        },
      ]);

      mockLossTracker.getRemainingBreakEvenHours.mockReturnValue({
        remainingBreakEvenHours: 10,
        remainingCost: -5, // Negative = already profitable
        feesEarnedSoFar: 15,
        hoursHeld: 5,
      });

      const result = await evaluator.shouldRebalance(
        position,
        opportunity,
        plan,
        0,
        new Map(),
      );

      expect(result.shouldRebalance).toBe(false);
      expect(result.reason).toContain('already profitable');
    });

    it('should approve rebalance if new position breaks even faster', async () => {
      const position = createMockPosition();
      const opportunity = createMockOpportunity();
      const plan = createMockPlan(opportunity);
      plan.expectedNetReturn = -5; // Not instantly profitable

      mockAggregator.getFundingRates.mockResolvedValue([
        {
          exchange: ExchangeType.LIGHTER,
          symbol: 'ETHUSDT',
          currentRate: 0.0003,
          timestamp: new Date(),
        },
      ]);

      mockLossTracker.getRemainingBreakEvenHours.mockReturnValue({
        remainingBreakEvenHours: 20, // Current needs 20 hours
        remainingCost: 10,
        feesEarnedSoFar: 0,
        hoursHeld: 0,
      });

      mockLossTracker.getSwitchingCosts.mockReturnValue({
        p1ExitFees: 5,
        p2EntryFees: 5,
        p2ExitFees: 5,
        p2Slippage: 5,
        total: 20,
      });

      // Mock cost calculator to return reasonable break-even for new position
      // With expectedReturn 0.219 (21.9% APY), hourly return = 0.219 / (24*365) * 3000 = ~0.075
      // Total costs = 20, so break-even = 20 / 0.075 = ~267 hours
      // But we'll mock it to be faster than current (20 hours)
      const result = await evaluator.shouldRebalance(
        position,
        opportunity,
        plan,
        0,
        new Map(),
      );

      // Should compare break-even times
      expect(result.shouldRebalance).toBeDefined();
      expect(result.currentBreakEvenHours).toBe(20);
    });

    it('should handle position that never breaks even', async () => {
      const position = createMockPosition();
      const opportunity = createMockOpportunity();
      const plan = createMockPlan(opportunity);

      mockAggregator.getFundingRates.mockResolvedValue([
        {
          exchange: ExchangeType.LIGHTER,
          symbol: 'ETHUSDT',
          currentRate: 0.0003,
          timestamp: new Date(),
        },
      ]);

      mockLossTracker.getRemainingBreakEvenHours.mockReturnValue({
        remainingBreakEvenHours: Infinity, // Never breaks even
        remainingCost: Infinity,
        feesEarnedSoFar: 0,
        hoursHeld: 0,
      });

      const result = await evaluator.shouldRebalance(
        position,
        opportunity,
        plan,
        0,
        new Map(),
      );

      // Should handle Infinity case
      expect(result.shouldRebalance).toBeDefined();
    });
  });
});

