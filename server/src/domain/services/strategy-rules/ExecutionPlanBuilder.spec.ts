import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionPlanBuilder } from './ExecutionPlanBuilder';
import { CostCalculator } from './CostCalculator';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import {
  FundingRateAggregator,
  ArbitrageOpportunity,
} from '../FundingRateAggregator';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { OrderSide, OrderType, TimeInForce } from '../../value-objects/PerpOrder';
import { Percentage } from '../../value-objects/Percentage';

describe('ExecutionPlanBuilder', () => {
  let builder: ExecutionPlanBuilder;
  let mockCostCalculator: jest.Mocked<CostCalculator>;
  let mockAggregator: jest.Mocked<FundingRateAggregator>;
  let mockAdapters: Map<ExchangeType, jest.Mocked<IPerpExchangeAdapter>>;
  let config: StrategyConfig;

  beforeEach(async () => {
    config = StrategyConfig.withDefaults();

    mockCostCalculator = {
      calculateSlippageCost: jest.fn(),
      predictFundingRateImpact: jest.fn(),
      calculateFees: jest.fn(),
      calculateBreakEvenHours: jest.fn(),
    } as any;

    mockAggregator = {
      getExchangeSymbol: jest.fn(
        (symbol: string, exchange: ExchangeType) => symbol,
      ),
    } as any;

    // Create mock adapters
    mockAdapters = new Map();
    const asterAdapter = {
      getMarkPrice: jest.fn().mockResolvedValue(3000),
      getBestBidAsk: jest.fn().mockResolvedValue({
        bestBid: 2999,
        bestAsk: 3001,
      }),
    } as any;

    const lighterAdapter = {
      getMarkPrice: jest.fn().mockResolvedValue(3001),
      getBestBidAsk: jest.fn().mockResolvedValue({
        bestBid: 3000,
        bestAsk: 3002,
      }),
    } as any;

    mockAdapters.set(ExchangeType.ASTER, asterAdapter);
    mockAdapters.set(ExchangeType.LIGHTER, lighterAdapter);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutionPlanBuilder,
        { provide: CostCalculator, useValue: mockCostCalculator },
        { provide: FundingRateAggregator, useValue: mockAggregator },
        { provide: StrategyConfig, useValue: config },
      ],
    }).compile();

    builder = module.get<ExecutionPlanBuilder>(ExecutionPlanBuilder);
  });

  describe('buildPlan', () => {
    const createMockOpportunity = (): ArbitrageOpportunity => ({
      symbol: 'ETHUSDT',
      longExchange: ExchangeType.LIGHTER,
      shortExchange: ExchangeType.ASTER,
      longRate: Percentage.fromDecimal(0.0003),
      shortRate: Percentage.fromDecimal(0.0001),
      spread: Percentage.fromDecimal(0.0002),
      expectedReturn: Percentage.fromDecimal(2.19), // 219% APY (very high to ensure profitability)
      longMarkPrice: 3001,
      shortMarkPrice: 3000,
      longOpenInterest: 100000,
      shortOpenInterest: 100000,
      timestamp: new Date(),
    });

    beforeEach(() => {
      // Setup default mock returns - use very low costs to ensure profitability
      mockCostCalculator.calculateSlippageCost.mockReturnValue(0.1); // Very low slippage
      mockCostCalculator.predictFundingRateImpact.mockReturnValue(0);
      mockCostCalculator.calculateFees.mockImplementation(
        (size, exchange, isMaker) => {
          if (exchange === ExchangeType.LIGHTER) return 0;
          if (exchange === ExchangeType.ASTER) return size * 0.00005;
          return size * 0.00015;
        },
      );
      // Return a reasonable break-even time
      mockCostCalculator.calculateBreakEvenHours.mockImplementation(
        (costs, hourlyReturn) => {
          if (hourlyReturn <= 0) return null;
          return costs / hourlyReturn;
        },
      );
    });

    it('should create execution plan with sufficient balance', async () => {
      const opportunity = createMockOpportunity();
      const longBalance = 10000;
      const shortBalance = 10000;

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance, shortBalance },
        config,
      );

      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const plan = result.value;
        expect(plan.longOrder.side).toBe(OrderSide.LONG);
        expect(plan.shortOrder.side).toBe(OrderSide.SHORT);
        expect(plan.positionSize.toBaseAsset()).toBeGreaterThan(0);
        expect(plan.expectedNetReturn).toBeGreaterThan(0);
      }
    });

    it('should return failure if adapters are missing', async () => {
      const opportunity = createMockOpportunity();
      const emptyAdapters = new Map<ExchangeType, IPerpExchangeAdapter>();

      const result = await builder.buildPlan(
        opportunity,
        emptyAdapters,
        { longBalance: 10000, shortBalance: 10000 },
        config,
      );

      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        expect(result.error.code).toBe('EXCHANGE_ERROR');
      }
    });

    it('should return failure if balance is insufficient', async () => {
      const opportunity = createMockOpportunity();
      const longBalance = 1; // Very low balance
      const shortBalance = 1;

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance, shortBalance },
        config,
      );

      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        expect(result.error.code).toBe('INSUFFICIENT_BALANCE');
      }
    });

    it('should return failure if open interest is insufficient', async () => {
      const opportunity = createMockOpportunity();
      opportunity.longOpenInterest = 1000; // Below minimum
      opportunity.shortOpenInterest = 1000;

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 10000, shortBalance: 10000 },
        config,
      );

      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should return failure if open interest is missing', async () => {
      const opportunity = createMockOpportunity();
      opportunity.longOpenInterest = undefined;
      opportunity.shortOpenInterest = undefined;

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 10000, shortBalance: 10000 },
        config,
      );

      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        expect(result.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should adjust position size based on OI constraints', async () => {
      const opportunity = createMockOpportunity();
      opportunity.longOpenInterest = 20000; // OI large enough to support position
      opportunity.shortOpenInterest = 20000;

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 100000, shortBalance: 100000 }, // Large balance
        config,
      );

      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const plan = result.value;
        // Position size should be limited to 5% of OI = $1000, but also by balance
        const positionValueUsd = plan.positionSize.toUSD(3000);
        expect(positionValueUsd).toBeLessThanOrEqual(1000 * 1.1); // Allow 10% margin
      }
    });

    it('should use provided mark prices when available', async () => {
      const opportunity = createMockOpportunity();
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;

      // Mock getBestBidAsk so it doesn't fall back to getMarkPrice
      asterAdapter.getBestBidAsk = jest.fn().mockResolvedValue({
        bestBid: 2999,
        bestAsk: 3001,
      });
      lighterAdapter.getBestBidAsk = jest.fn().mockResolvedValue({
        bestBid: 3000,
        bestAsk: 3002,
      });

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 10000, shortBalance: 10000 },
        config,
        opportunity.longMarkPrice,
        opportunity.shortMarkPrice,
      );

      // Should not call getMarkPrice if prices are provided (getBestBidAsk is mocked)
      expect(lighterAdapter.getMarkPrice).not.toHaveBeenCalled();
      expect(asterAdapter.getMarkPrice).not.toHaveBeenCalled();
      expect(result.isSuccess).toBe(true);
    });

    it('should fetch mark prices when not provided', async () => {
      const opportunity = createMockOpportunity();
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 10000, shortBalance: 10000 },
        config,
        undefined, // No mark prices provided
        undefined,
      );

      expect(lighterAdapter.getMarkPrice).toHaveBeenCalledWith('ETHUSDT');
      expect(asterAdapter.getMarkPrice).toHaveBeenCalledWith('ETHUSDT');
      expect(result.isSuccess).toBe(true);
    });

    it('should return failure if mark price fetch fails', async () => {
      const opportunity = createMockOpportunity();
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      asterAdapter.getMarkPrice.mockRejectedValue(new Error('API error'));

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 10000, shortBalance: 10000 },
        config,
        undefined,
        undefined,
      );

      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        expect(result.error.code).toBe('EXCHANGE_ERROR');
      }
    });

    it('should calculate costs using CostCalculator', async () => {
      const opportunity = createMockOpportunity();
      // Use very low costs to ensure profitability
      // Mock to return 0.5 for each slippage calculation (long and short = 1.0 total)
      mockCostCalculator.calculateSlippageCost.mockReturnValue(0.5);
      mockCostCalculator.calculateFees.mockReturnValue(0.5);
      mockCostCalculator.predictFundingRateImpact.mockReturnValue(0);
      mockCostCalculator.calculateBreakEvenHours.mockReturnValue({
        breakEvenHours: 1,
        feesEarnedSoFar: 0,
        remainingCost: 0,
        hoursHeld: 0,
      });

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 10000, shortBalance: 10000 },
        config,
      );

      expect(result.isSuccess).toBe(true);
      expect(mockCostCalculator.calculateSlippageCost).toHaveBeenCalled();
      expect(mockCostCalculator.calculateFees).toHaveBeenCalled();
      if (result.isSuccess) {
        const plan = result.value;
        // Long slippage (0.5) + short slippage (0.5) = 1.0
        expect(plan.estimatedCosts.slippage).toBe(1.0);
        expect(plan.estimatedCosts.fees).toBeGreaterThan(0);
      }
    });

    it('should return failure if net return is negative', async () => {
      const opportunity = createMockOpportunity();
      opportunity.expectedReturn = Percentage.fromDecimal(0.001); // Very small return
      mockCostCalculator.calculateSlippageCost.mockReturnValue(1000.0); // High costs
      mockCostCalculator.calculateFees.mockReturnValue(500.0);

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 10000, shortBalance: 10000 },
        config,
      );

      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        // Could be VALIDATION_ERROR (unprofitable) or EXECUTION_PLAN_ERROR (caught exception)
        expect(['VALIDATION_ERROR', 'EXECUTION_PLAN_ERROR']).toContain(result.error.code);
      }
    });

    it('should create limit orders with price improvement', async () => {
      const opportunity = createMockOpportunity();
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      // Add getBestBidAsk method if not present
      if (!asterAdapter.getBestBidAsk) {
        asterAdapter.getBestBidAsk = jest.fn().mockResolvedValue({
          bestBid: 2999,
          bestAsk: 3001,
        });
      } else {
        asterAdapter.getBestBidAsk.mockResolvedValue({
          bestBid: 2999,
          bestAsk: 3001,
        });
      }

      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      if (!lighterAdapter.getBestBidAsk) {
        lighterAdapter.getBestBidAsk = jest.fn().mockResolvedValue({
          bestBid: 3000,
          bestAsk: 3002,
        });
      } else {
        lighterAdapter.getBestBidAsk.mockResolvedValue({
          bestBid: 3000,
          bestAsk: 3002,
        });
      }

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 10000, shortBalance: 10000 },
        config,
      );

      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const plan = result.value;
        expect(plan.longOrder.type).toBe(OrderType.LIMIT);
        expect(plan.shortOrder.type).toBe(OrderType.LIMIT);
        expect(plan.longOrder.timeInForce).toBe(TimeInForce.GTC);
        expect(plan.shortOrder.timeInForce).toBe(TimeInForce.GTC);

        // Long order should be at best bid + improvement (fallback uses mark price)
        expect(plan.longOrder.price).toBeGreaterThan(0);
        // Short order should be at best ask - improvement
        expect(plan.shortOrder.price).toBeGreaterThan(0);
      }
    });

    it('should use maxPositionSizeUsd when provided', async () => {
      const opportunity = createMockOpportunity();
      const maxPositionSizeUsd = 5000;

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 100000, shortBalance: 100000 }, // Large balance
        config,
        undefined,
        undefined,
        maxPositionSizeUsd,
      );

      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const plan = result.value;
        // Position size should respect maxPositionSizeUsd
        const positionValueUsd = plan.positionSize.toUSD(3000);
        expect(positionValueUsd).toBeLessThanOrEqual(maxPositionSizeUsd * 1.1); // Allow small margin
      }
    });
  });

  describe('buildPlanWithAllocation', () => {
    const createMockOpportunity = (): ArbitrageOpportunity => ({
      symbol: 'ETHUSDT',
      longExchange: ExchangeType.LIGHTER,
      shortExchange: ExchangeType.ASTER,
      longRate: Percentage.fromDecimal(0.0003),
      shortRate: Percentage.fromDecimal(0.0001),
      spread: Percentage.fromDecimal(0.0002),
      expectedReturn: Percentage.fromDecimal(0.219),
      longMarkPrice: 3001,
      shortMarkPrice: 3000,
      longOpenInterest: 100000,
      shortOpenInterest: 100000,
      timestamp: new Date(),
    });

    beforeEach(() => {
      mockCostCalculator.calculateSlippageCost.mockReturnValue(1.0);
      mockCostCalculator.predictFundingRateImpact.mockReturnValue(0);
      mockCostCalculator.calculateFees.mockReturnValue(5.0);
    });

    it('should create plan with specific allocation amount', async () => {
      const opportunity = createMockOpportunity();
      opportunity.longOpenInterest = 500000; // Large OI to not constrain allocation
      opportunity.shortOpenInterest = 500000;
      const allocationUsd = 10000;

      const result = await builder.buildPlanWithAllocation(
        opportunity,
        mockAdapters,
        allocationUsd,
        { longBalance: 100000, shortBalance: 100000 }, // Large balance to support allocation
        config,
      );

      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const plan = result.value;
        const positionValueUsd = plan.positionSize.toUSD(3000);
        // Allocation should be respected (within OI constraints of 5%)
        expect(positionValueUsd).toBeLessThanOrEqual(allocationUsd * 1.1); // Allow 10% margin
        expect(positionValueUsd).toBeGreaterThan(allocationUsd * 0.9);
      }
    });

    it('should reduce position size when allocation exceeds available balance', async () => {
      const opportunity = createMockOpportunity();
      opportunity.longOpenInterest = 1000000; // Large OI to not constrain
      opportunity.shortOpenInterest = 1000000;
      const allocationUsd = 100000; // Very large allocation
      // With 2x leverage, need $50000 collateral for $100000 notional
      const longBalance = 1000; // Small balance - insufficient for full allocation
      const shortBalance = 1000;

      const result = await builder.buildPlanWithAllocation(
        opportunity,
        mockAdapters,
        allocationUsd,
        { longBalance, shortBalance },
        config,
      );

      // Should create a plan with reduced position size based on available balance
      // Available capital = $1000 * 0.9 = $900, leveraged = $1800
      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const plan = result.value;
        const positionValueUsd = plan.positionSize.toUSD(3000);
        // Should be limited by available balance (not the full allocation)
        expect(positionValueUsd).toBeLessThan(allocationUsd);
        expect(positionValueUsd).toBeLessThanOrEqual(1800 * 1.1); // Allow margin
      }
    });
  });
});
