import { Test, TestingModule } from '@nestjs/testing';
import { PerpSpotExecutionPlanBuilder } from './PerpSpotExecutionPlanBuilder';
import { PerpSpotBalanceManager } from './PerpSpotBalanceManager';
import { CostCalculator } from './CostCalculator';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ISpotExchangeAdapter } from '../../ports/ISpotExchangeAdapter';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { Percentage } from '../../value-objects/Percentage';
import { OrderSide } from '../../value-objects/PerpOrder';
import { Result } from '../../common/Result';

describe('PerpSpotExecutionPlanBuilder', () => {
  let builder: PerpSpotExecutionPlanBuilder;
  let mockBalanceManager: jest.Mocked<PerpSpotBalanceManager>;
  let mockCostCalculator: jest.Mocked<CostCalculator>;
  let mockPerpAdapter: jest.Mocked<IPerpExchangeAdapter>;
  let mockSpotAdapter: jest.Mocked<ISpotExchangeAdapter>;
  let mockConfig: StrategyConfig;

  beforeEach(async () => {
    mockBalanceManager = {
      ensureOptimalBalanceDistribution: jest.fn(),
    } as any;

    mockCostCalculator = {
      calculateFees: jest.fn().mockReturnValue(10),
      calculateSlippageCost: jest.fn().mockReturnValue(5),
    } as any;

    mockPerpAdapter = {
      getBalance: jest.fn().mockResolvedValue(1000),
      getMarkPrice: jest.fn().mockResolvedValue(3000),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.HYPERLIQUID),
    } as any;

    mockSpotAdapter = {
      getSpotBalance: jest.fn().mockResolvedValue(1000),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.HYPERLIQUID),
    } as any;

    mockConfig = StrategyConfig.withDefaults();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PerpSpotExecutionPlanBuilder,
        { provide: PerpSpotBalanceManager, useValue: mockBalanceManager },
        { provide: CostCalculator, useValue: mockCostCalculator },
      ],
    }).compile();

    builder = module.get<PerpSpotExecutionPlanBuilder>(
      PerpSpotExecutionPlanBuilder,
    );
  });

  describe('buildExecutionPlan', () => {
    const createOpportunity = (): ArbitrageOpportunity => ({
      symbol: 'ETH',
      strategyType: 'perp-spot',
      longExchange: ExchangeType.HYPERLIQUID,
      spotExchange: ExchangeType.HYPERLIQUID,
      longRate: Percentage.fromDecimal(0.0001), // Positive funding
      shortRate: Percentage.fromDecimal(0), // Required field
      spread: Percentage.fromDecimal(0.0001),
      expectedReturn: Percentage.fromDecimal(0.876), // Annualized
      timestamp: new Date(),
    });

    it('should build execution plan for positive funding (Long spot + Short perp)', async () => {
      mockBalanceManager.ensureOptimalBalanceDistribution.mockResolvedValue(
        Result.success(false), // No rebalancing needed
      );

      const opportunity = createOpportunity();
      const result = await builder.buildExecutionPlan(
        opportunity,
        mockPerpAdapter,
        mockSpotAdapter,
        mockConfig,
        5000, // maxPositionSizeUsd
        2, // leverage
      );

      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const plan = result.value;
        expect(plan.opportunity).toBe(opportunity);
        expect(plan.perpOrder.side).toBe(OrderSide.SHORT); // Short perp to receive funding
        expect(plan.spotOrder.side).toBe(OrderSide.LONG); // Long spot to hedge
        expect(plan.perpOrder.size).toBe(plan.spotOrder.size); // Delta neutral
        expect(plan.estimatedCosts.total).toBeGreaterThan(0);
      }
    });

    it('should build execution plan for negative funding (Short spot + Long perp)', async () => {
      mockBalanceManager.ensureOptimalBalanceDistribution.mockResolvedValue(
        Result.success(false),
      );

      const opportunity: ArbitrageOpportunity = {
        symbol: 'ETH',
        strategyType: 'perp-spot',
        longExchange: ExchangeType.HYPERLIQUID,
        spotExchange: ExchangeType.HYPERLIQUID,
        longRate: Percentage.fromDecimal(-0.0001), // Negative funding
        shortRate: Percentage.fromDecimal(0),
        spread: Percentage.fromDecimal(0.0001),
        expectedReturn: Percentage.fromDecimal(0.876),
        timestamp: new Date(),
      };

      const result = await builder.buildExecutionPlan(
        opportunity,
        mockPerpAdapter,
        mockSpotAdapter,
        mockConfig,
        5000,
        2,
      );

      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const plan = result.value;
        expect(plan.perpOrder.side).toBe(OrderSide.LONG); // Long perp to receive funding
        expect(plan.spotOrder.side).toBe(OrderSide.SHORT); // Short spot to hedge
      }
    });

    it('should call balance manager before building plan', async () => {
      mockBalanceManager.ensureOptimalBalanceDistribution.mockResolvedValue(
        Result.success(true), // Rebalancing occurred
      );

      const opportunity = createOpportunity();
      await builder.buildExecutionPlan(
        opportunity,
        mockPerpAdapter,
        mockSpotAdapter,
        mockConfig,
        5000,
        2,
      );

      expect(
        mockBalanceManager.ensureOptimalBalanceDistribution,
      ).toHaveBeenCalledWith(
        ExchangeType.HYPERLIQUID,
        mockPerpAdapter,
        mockSpotAdapter,
        expect.any(Number), // targetPositionSize
        2, // leverage
      );
    });

    it('should fail for non-perp-spot opportunity', async () => {
      const opportunity: ArbitrageOpportunity = {
        symbol: 'ETH',
        strategyType: 'perp-perp',
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.ASTER,
        longRate: Percentage.fromDecimal(0.0001),
        shortRate: Percentage.fromDecimal(0.0002),
        spread: Percentage.fromDecimal(0.0001),
        expectedReturn: Percentage.fromDecimal(0.876),
        timestamp: new Date(),
      };

      const result = await builder.buildExecutionPlan(
        opportunity,
        mockPerpAdapter,
        mockSpotAdapter,
        mockConfig,
      );

      expect(result.isFailure).toBe(true);
    });

    it('should fail when spot exchange differs from perp exchange', async () => {
      const opportunity: ArbitrageOpportunity = {
        symbol: 'ETH',
        strategyType: 'perp-spot',
        longExchange: ExchangeType.HYPERLIQUID,
        spotExchange: ExchangeType.ASTER, // Different exchange
        longRate: Percentage.fromDecimal(0.0001),
        shortRate: Percentage.fromDecimal(0),
        spread: Percentage.fromDecimal(0.0001),
        expectedReturn: Percentage.fromDecimal(0.876),
        timestamp: new Date(),
      };

      const result = await builder.buildExecutionPlan(
        opportunity,
        mockPerpAdapter,
        mockSpotAdapter,
        mockConfig,
      );

      expect(result.isFailure).toBe(true);
    });

    it('should calculate position size based on available balances', async () => {
      mockPerpAdapter.getBalance.mockResolvedValue(500);
      mockSpotAdapter.getSpotBalance.mockResolvedValue(2000);
      mockBalanceManager.ensureOptimalBalanceDistribution.mockResolvedValue(
        Result.success(false),
      );

      const opportunity = createOpportunity();
      const result = await builder.buildExecutionPlan(
        opportunity,
        mockPerpAdapter,
        mockSpotAdapter,
        mockConfig,
        10000, // maxPositionSizeUsd
        2, // leverage
      );

      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const plan = result.value;
        // Position size should be constrained by perp capacity: 500 * 2 = 1000
        // Or spot capacity: 2000
        // Min of these = 1000
        const expectedSize = 1000 / 3000; // positionValue / markPrice
        expect(plan.positionSize.toBaseAsset()).toBeCloseTo(expectedSize, 2);
      }
    });
  });
});
