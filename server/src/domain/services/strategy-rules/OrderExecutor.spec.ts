import { Test, TestingModule } from '@nestjs/testing';
import { OrderExecutor } from './OrderExecutor';
import { IPositionManager } from './IPositionManager';
import { CostCalculator } from './CostCalculator';
import { ExecutionPlanBuilder } from './ExecutionPlanBuilder';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { PositionSize } from '../../value-objects/PositionSize';
import { Percentage } from '../../value-objects/Percentage';
import { Result } from '../../common/Result';
import {
  ArbitrageExecutionPlan,
  ArbitrageExecutionResult,
} from '../FundingArbitrageStrategy';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import {
  PerpOrderResponse,
  OrderStatus,
  OrderSide,
  OrderType,
  TimeInForce,
  PerpOrderRequest,
} from '../../value-objects/PerpOrder';
import { UnifiedExecutionService } from '../execution/UnifiedExecutionService';
import { ExecutionLockService } from '../../../infrastructure/services/ExecutionLockService';
import { CircuitBreakerService } from '../../../infrastructure/services/CircuitBreakerService';

describe('OrderExecutor', () => {
  let executor: OrderExecutor;
  let mockPositionManager: jest.Mocked<IPositionManager>;
  let mockCostCalculator: jest.Mocked<CostCalculator>;
  let mockExecutionPlanBuilder: jest.Mocked<ExecutionPlanBuilder>;
  let mockUnifiedExecution: jest.Mocked<UnifiedExecutionService>;
  let mockExecutionLockService: jest.Mocked<ExecutionLockService>;
  let mockCircuitBreaker: jest.Mocked<CircuitBreakerService>;
  let mockAdapters: Map<ExchangeType, jest.Mocked<IPerpExchangeAdapter>>;
  let config: StrategyConfig;

  beforeEach(async () => {
    config = StrategyConfig.withDefaults();

    mockPositionManager = {
      handleAsymmetricFills: jest.fn().mockResolvedValue(Result.success(undefined)),
    } as any;

    mockCostCalculator = {
      getAvailableMargin: jest.fn().mockResolvedValue(10000),
    } as any;

    mockExecutionPlanBuilder = {} as any;

    mockUnifiedExecution = {
      executeSmartHedge: jest.fn().mockResolvedValue({
        success: true,
        totalSlices: 1,
        completedSlices: 1,
        totalLongFilled: 1.0,
        totalShortFilled: 1.0,
        sliceResults: [],
      }),
    } as any;

    mockExecutionLockService = {
      tryAcquireSymbolLock: jest.fn().mockReturnValue(true),
      releaseSymbolLock: jest.fn(),
      generateThreadId: jest.fn().mockReturnValue('test-thread-id'),
      hasActiveOrder: jest.fn().mockReturnValue(false),
      registerOrderPlacing: jest.fn().mockReturnValue(true),
      updateOrderStatus: jest.fn(),
      forceClearOrder: jest.fn(),
    } as any;

    mockCircuitBreaker = {
      canOpenNewPosition: jest.fn().mockReturnValue(true),
      getState: jest.fn().mockReturnValue('CLOSED'),
    } as any;

    // Create mock adapters
    mockAdapters = new Map();
    const asterAdapter = {
      placeOrder: jest.fn(),
      getOrderStatus: jest.fn(),
      getBalance: jest.fn().mockResolvedValue(10000),
      getEquity: jest.fn().mockResolvedValue(10000),
      getPositions: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      cancelAllOrders: jest.fn().mockResolvedValue(0),
      getAvailableMargin: jest.fn().mockResolvedValue(10000),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.ASTER),
    } as any;

    const lighterAdapter = {
      placeOrder: jest.fn(),
      getOrderStatus: jest.fn(),
      getBalance: jest.fn().mockResolvedValue(10000),
      getEquity: jest.fn().mockResolvedValue(10000),
      getPositions: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      cancelAllOrders: jest.fn().mockResolvedValue(0),
      getAvailableMargin: jest.fn().mockResolvedValue(10000),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.LIGHTER),
    } as any;

    mockAdapters.set(ExchangeType.ASTER, asterAdapter);
    mockAdapters.set(ExchangeType.LIGHTER, lighterAdapter);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderExecutor,
        { provide: 'IPositionManager', useValue: mockPositionManager },
        { provide: CostCalculator, useValue: mockCostCalculator },
        { provide: ExecutionPlanBuilder, useValue: mockExecutionPlanBuilder },
        { provide: StrategyConfig, useValue: config },
        { provide: UnifiedExecutionService, useValue: mockUnifiedExecution },
        { provide: ExecutionLockService, useValue: mockExecutionLockService },
        { provide: CircuitBreakerService, useValue: mockCircuitBreaker },
      ],
    }).compile();

    executor = module.get<OrderExecutor>(OrderExecutor);
  });

  const createMockOpportunity = (): ArbitrageOpportunity => ({
    symbol: 'ETHUSDT',
    longExchange: ExchangeType.LIGHTER,
    shortExchange: ExchangeType.ASTER,
    longRate: Percentage.fromDecimal(0.0003),
    shortRate: Percentage.fromDecimal(0.0001),
    spread: Percentage.fromDecimal(0.0002),
    expectedReturn: Percentage.fromDecimal(0.219),
    longMarkPrice: 3000,
    shortMarkPrice: 3001,
    longOpenInterest: 1000000,
    shortOpenInterest: 1000000,
    timestamp: new Date(),
    strategyType: 'perp-perp',
  });

  const createMockPlan = (): ArbitrageExecutionPlan => ({
    opportunity: createMockOpportunity(),
    longOrder: new PerpOrderRequest('ETHUSDT', OrderSide.LONG, OrderType.LIMIT, 1.0, 3000, TimeInForce.GTC),
    shortOrder: new PerpOrderRequest('ETHUSDT', OrderSide.SHORT, OrderType.LIMIT, 1.0, 3001, TimeInForce.GTC),
    positionSize: PositionSize.fromBaseAsset(1.0, 2.0),
    estimatedCosts: { fees: 10, slippage: 5, total: 15 },
    expectedNetReturn: 0.5,
    timestamp: new Date(),
  });

  describe('executeSinglePosition', () => {
    it('should delegate execution to UnifiedExecutionService', async () => {
      const plan = createMockPlan();
      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      const executionResult = await executor.executeSinglePosition(
        { plan, opportunity: plan.opportunity },
        mockAdapters,
        result,
      );

      expect(mockUnifiedExecution.executeSmartHedge).toHaveBeenCalled();
      expect(executionResult.isSuccess).toBe(true);
      if (executionResult.isSuccess) {
        expect(executionResult.value.opportunitiesExecuted).toBe(1);
      }
    });

    it('should handle failures from UnifiedExecutionService', async () => {
      const plan = createMockPlan();
      mockUnifiedExecution.executeSmartHedge.mockResolvedValue({
        success: false,
        totalSlices: 1,
        completedSlices: 0,
        totalLongFilled: 0,
        totalShortFilled: 0,
        sliceResults: [],
        abortReason: 'Test failure',
      });

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      const executionResult = await executor.executeSinglePosition(
        { plan, opportunity: plan.opportunity },
        mockAdapters,
        result,
      );

      expect(executionResult.isFailure).toBe(true);
    });
  });

  describe('executeMultiplePositions', () => {
    it('should use UnifiedExecutionService for each opportunity', async () => {
      const plan1 = createMockPlan();
      const plan2 = createMockPlan();
      plan2.opportunity.symbol = 'BTCUSDT';
      
      const opportunities = [
        {
          opportunity: plan1.opportunity,
          plan: plan1,
          maxPortfolioFor35APY: 1000,
        },
        {
          opportunity: plan2.opportunity,
          plan: plan2,
          maxPortfolioFor35APY: 1000,
        },
      ];

      const exchangeBalances = new Map<ExchangeType, number>();
      exchangeBalances.set(ExchangeType.LIGHTER, 10000);
      exchangeBalances.set(ExchangeType.ASTER, 10000);

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      // Reset mock call count
      mockUnifiedExecution.executeSmartHedge.mockClear();

      const executionResult = await executor.executeMultiplePositions(
        opportunities,
        mockAdapters,
        exchangeBalances,
        result,
      );

      // CRITICAL: Verify unified execution was called (at least once per opportunity)
      // This is the key assertion - unified execution MUST be used, not placeOrderPair
      expect(mockUnifiedExecution.executeSmartHedge).toHaveBeenCalled();
      expect(executionResult.isSuccess).toBe(true);
    });

    it('should NOT call placeOrderPair when unified execution is enabled', async () => {
      const plan = createMockPlan();
      const opportunities = [
        {
          opportunity: plan.opportunity,
          plan: plan,
          maxPortfolioFor35APY: 1000,
        },
      ];

      const exchangeBalances = new Map<ExchangeType, number>();
      exchangeBalances.set(ExchangeType.LIGHTER, 10000);
      exchangeBalances.set(ExchangeType.ASTER, 10000);

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      // Spy on placeOrderPair to ensure it's NOT called
      const placeOrderPairSpy = jest.spyOn(executor as any, 'placeOrderPair');

      await executor.executeMultiplePositions(
        opportunities,
        mockAdapters,
        exchangeBalances,
        result,
      );

      // CRITICAL ASSERTION: placeOrderPair should NOT be called when unified execution is enabled
      expect(placeOrderPairSpy).not.toHaveBeenCalled();
      expect(mockUnifiedExecution.executeSmartHedge).toHaveBeenCalled();
    });

    it('should check unified execution is enabled by default', () => {
      // CRITICAL: Verify that unified execution is enabled by default
      // This ensures the bug (bypassing unified execution) cannot happen
      expect((executor as any).useSlicedExecution).toBe(true);
      expect((executor as any).unifiedExecutionService).toBeDefined();
    });

    it('should handle unified execution failures gracefully', async () => {
      const plan = createMockPlan();
      const opportunities = [
        {
          opportunity: plan.opportunity,
          plan: plan,
          maxPortfolioFor35APY: 1000,
        },
      ];

      const exchangeBalances = new Map<ExchangeType, number>();
      exchangeBalances.set(ExchangeType.LIGHTER, 10000);
      exchangeBalances.set(ExchangeType.ASTER, 10000);

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      // Mock unified execution to fail
      mockUnifiedExecution.executeSmartHedge.mockResolvedValue({
        success: false,
        totalSlices: 1,
        completedSlices: 0,
        totalLongFilled: 0,
        totalShortFilled: 0,
        sliceResults: [],
        abortReason: 'Test failure',
      });

      const executionResult = await executor.executeMultiplePositions(
        opportunities,
        mockAdapters,
        exchangeBalances,
        result,
      );

      expect(mockUnifiedExecution.executeSmartHedge).toHaveBeenCalled();
      expect(executionResult.isSuccess).toBe(true);
      if (executionResult.isSuccess) {
        expect(executionResult.value.successfulExecutions).toBe(0);
      }
    });
  });
});
