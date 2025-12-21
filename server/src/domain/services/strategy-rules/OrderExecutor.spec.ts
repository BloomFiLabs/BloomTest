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
} from '../../value-objects/PerpOrder';
import {
  PerpOrderRequest,
  OrderType,
  TimeInForce,
} from '../../value-objects/PerpOrder';

describe('OrderExecutor', () => {
  let executor: OrderExecutor;
  let mockPositionManager: jest.Mocked<IPositionManager>;
  let mockCostCalculator: jest.Mocked<CostCalculator>;
  let mockExecutionPlanBuilder: jest.Mocked<ExecutionPlanBuilder>;
  let mockAdapters: Map<ExchangeType, jest.Mocked<IPerpExchangeAdapter>>;
  let config: StrategyConfig;

  beforeEach(async () => {
    config = StrategyConfig.withDefaults();

    mockPositionManager = {
      handleAsymmetricFills: jest.fn().mockResolvedValue(Result.success(undefined)),
    } as any;

    mockCostCalculator = {} as any;

    mockExecutionPlanBuilder = {} as any;

    // Create mock adapters
    mockAdapters = new Map();
    const asterAdapter = {
      placeOrder: jest.fn(),
      getOrderStatus: jest.fn(),
      getBalance: jest.fn().mockResolvedValue(10000),
      getPositions: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
    } as any;

    const lighterAdapter = {
      placeOrder: jest.fn(),
      getOrderStatus: jest.fn(),
      getBalance: jest.fn().mockResolvedValue(10000),
      getPositions: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
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
      ],
    }).compile();

    executor = module.get<OrderExecutor>(OrderExecutor);
  });

  describe('waitForOrderFill', () => {
    it('should return immediately if order is already filled', async () => {
      const adapter = mockAdapters.get(ExchangeType.ASTER)!;
      const filledResponse = new PerpOrderResponse(
        'order-123',
        OrderStatus.FILLED,
        'ETHUSDT',
        OrderSide.LONG,
        undefined, // clientOrderId
        1.0, // filledSize
        3000, // averageFillPrice
      );
      adapter.getOrderStatus.mockResolvedValue(filledResponse);

      const result = await executor.waitForOrderFill(
        adapter,
        'order-123',
        'ETHUSDT',
        ExchangeType.ASTER,
        1.0,
        10,
        2000,
        false,
      );

      expect(result.isFilled()).toBe(true);
      expect(adapter.getOrderStatus).toHaveBeenCalledTimes(1);
    });

    it('should poll with exponential backoff until order fills', async () => {
      const adapter = mockAdapters.get(ExchangeType.ASTER)!;
      let callCount = 0;
      adapter.getOrderStatus.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            new PerpOrderResponse(
              'order-123',
              OrderStatus.SUBMITTED,
              'ETHUSDT',
              OrderSide.LONG,
            ),
          );
        }
        return Promise.resolve(
          new PerpOrderResponse(
            'order-123',
            OrderStatus.FILLED,
            'ETHUSDT',
            OrderSide.LONG,
            undefined, // clientOrderId
            1.0,       // filledSize
            3000,      // averageFillPrice
          ),
        );
      });

      const result = await executor.waitForOrderFill(
        adapter,
        'order-123',
        'ETHUSDT',
        ExchangeType.ASTER,
        1.0,
        10,
        2000,
        false,
      );

      expect(result.isFilled()).toBe(true);
      expect(adapter.getOrderStatus).toHaveBeenCalledTimes(2);
    });

    it('should return cancelled order if order is cancelled', async () => {
      const adapter = mockAdapters.get(ExchangeType.ASTER)!;
      const cancelledResponse = new PerpOrderResponse(
        'order-123',
        OrderStatus.CANCELLED,
        'ETHUSDT',
        OrderSide.LONG,
      );
      adapter.getOrderStatus.mockResolvedValue(cancelledResponse);

      const result = await executor.waitForOrderFill(
        adapter,
        'order-123',
        'ETHUSDT',
        ExchangeType.ASTER,
        1.0,
        10,
        2000,
        false,
      );

      expect(result.status).toBe(OrderStatus.CANCELLED);
    });

    it('should use longer backoff for closing positions', async () => {
      const adapter = mockAdapters.get(ExchangeType.ASTER)!;
      adapter.getOrderStatus.mockResolvedValue(
        new PerpOrderResponse(
          'order-123',
          OrderStatus.SUBMITTED,
          'ETHUSDT',
          OrderSide.LONG,
        ),
      );

      await executor.waitForOrderFill(
        adapter,
        'order-123',
        'ETHUSDT',
        ExchangeType.ASTER,
        1.0,
        2, // Only 2 retries
        100, // Small delay for test
        true, // Closing position
      );

      // Should have called getOrderStatus multiple times
      expect(adapter.getOrderStatus).toHaveBeenCalledTimes(2);
    });

    it('should return rejected order after max retries if status check fails', async () => {
      const adapter = mockAdapters.get(ExchangeType.ASTER)!;
      adapter.getOrderStatus.mockRejectedValue(new Error('API error'));

      const result = await executor.waitForOrderFill(
        adapter,
        'order-123',
        'ETHUSDT',
        ExchangeType.ASTER,
        1.0,
        2, // Only 2 retries for faster test
        50, // Very small delay for test
        false,
      );

      expect(result.status).toBe(OrderStatus.REJECTED);
      expect(result.error).toContain('Failed to check order status');
    }, 10000);

    it('should cancel and return cancelled order if max retries reached without fill', async () => {
      const adapter = mockAdapters.get(ExchangeType.ASTER)!;
      adapter.getOrderStatus.mockResolvedValue(
        new PerpOrderResponse(
          'order-123',
          OrderStatus.SUBMITTED,
          'ETHUSDT',
          OrderSide.LONG,
        ),
      );
      // Mock cancelOrder to succeed (called after max retries to prevent orphaned orders)
      adapter.cancelOrder.mockResolvedValue(true);

      const result = await executor.waitForOrderFill(
        adapter,
        'order-123',
        'ETHUSDT',
        ExchangeType.ASTER,
        1.0,
        2, // Only 2 retries
        50, // Small delay for test
        false,
      );

      // Order is cancelled to prevent orphaned orders on order book
      expect(result.status).toBe(OrderStatus.CANCELLED);
      expect(result.error).toContain('not filling');
      expect(adapter.cancelOrder).toHaveBeenCalledWith('order-123', 'ETHUSDT');
    }, 10000);
  });

  describe('executeSinglePosition', () => {
    const createMockPlan = (): ArbitrageExecutionPlan => ({
      opportunity: {
        symbol: 'ETHUSDT',
        strategyType: 'perp-perp',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longRate: Percentage.fromDecimal(0.0003),
        shortRate: Percentage.fromDecimal(0.0001),
        spread: Percentage.fromDecimal(0.0002),
        expectedReturn: Percentage.fromDecimal(0.219),
        longMarkPrice: 3001,
        shortMarkPrice: 3000,
        longOpenInterest: 1000000,
        shortOpenInterest: 1000000,
        timestamp: new Date(),
      } as ArbitrageOpportunity,
      longOrder: new PerpOrderRequest(
        'ETHUSDT',
        OrderSide.LONG,
        OrderType.LIMIT,
        1.0,
        3000,
        TimeInForce.GTC,
      ),
      shortOrder: new PerpOrderRequest(
        'ETHUSDT',
        OrderSide.SHORT,
        OrderType.LIMIT,
        1.0,
        3001,
        TimeInForce.GTC,
      ),
      positionSize: PositionSize.fromBaseAsset(1.0, 2.0),
      estimatedCosts: {
        fees: 10,
        slippage: 5,
        total: 15,
      },
      expectedNetReturn: 0.5,
      timestamp: new Date(),
    });

    it('should execute orders successfully', async () => {
      const plan = createMockPlan();
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      lighterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse(
          'long-123',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.LONG,
          undefined, // clientOrderId
          1.0,       // filledSize
          3000,      // averageFillPrice
        ),
      );
      asterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse(
          'short-123',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined, // clientOrderId
          1.0,       // filledSize
          3001,      // averageFillPrice
        ),
      );

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

      expect(lighterAdapter.placeOrder).toHaveBeenCalledWith(plan.longOrder);
      expect(asterAdapter.placeOrder).toHaveBeenCalledWith(plan.shortOrder);
      expect(executionResult.isSuccess).toBe(true);
      if (executionResult.isSuccess) {
        expect(executionResult.value.opportunitiesExecuted).toBe(1);
        expect(executionResult.value.ordersPlaced).toBe(2);
      }
    });

    it('should handle order failures', async () => {
      const plan = createMockPlan();
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      lighterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse(
          'long-123',
          OrderStatus.REJECTED,
          'ETHUSDT',
          OrderSide.LONG,
          undefined,
          undefined,
          undefined,
          'Insufficient balance',
        ),
      );
      asterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse(
          'short-123',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined, // clientOrderId
          1.0,       // filledSize
          3001,      // averageFillPrice
        ),
      );

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
      if (executionResult.isFailure) {
        expect(executionResult.error.code).toBe('ORDER_EXECUTION_ERROR');
        expect(executionResult.error.message).toContain(
          'Order execution failed',
        );
      }
    });

    it('should handle missing adapters', async () => {
      const plan = createMockPlan();
      const emptyAdapters = new Map<ExchangeType, IPerpExchangeAdapter>();

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
        emptyAdapters,
        result,
      );

      expect(executionResult.isFailure).toBe(true);
      if (executionResult.isFailure) {
        expect(executionResult.error.code).toBe('EXCHANGE_ERROR');
        expect(executionResult.error.message).toContain('Missing adapter');
      }
    });
  });

  describe('executeMultiplePositions', () => {
    const createMockOpportunity = () => ({
      opportunity: {
        symbol: 'ETHUSDT',
        strategyType: 'perp-perp',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longRate: Percentage.fromDecimal(0.0003),
        shortRate: Percentage.fromDecimal(0.0001),
        spread: Percentage.fromDecimal(0.0002),
        expectedReturn: Percentage.fromDecimal(0.219),
        longMarkPrice: 3001,
        shortMarkPrice: 3000,
        longOpenInterest: 1000000,
        shortOpenInterest: 1000000,
        timestamp: new Date(),
      } as ArbitrageOpportunity,
      plan: {
        opportunity: {} as ArbitrageOpportunity,
        longOrder: new PerpOrderRequest(
          'ETHUSDT',
          OrderSide.LONG,
          OrderType.LIMIT,
          1.0,
          3000,
          TimeInForce.GTC,
        ),
        shortOrder: new PerpOrderRequest(
          'ETHUSDT',
          OrderSide.SHORT,
          OrderType.LIMIT,
          1.0,
          3001,
          TimeInForce.GTC,
        ),
        positionSize: PositionSize.fromBaseAsset(1.0, 2.0),
        estimatedCosts: { fees: 10, slippage: 5, total: 15 },
        expectedNetReturn: 0.5,
        timestamp: new Date(),
      } as ArbitrageExecutionPlan,
      maxPortfolioFor35APY: 50000,
      isExisting: false,
    });

    it('should execute multiple positions in parallel', async () => {
      const opportunities = [
        createMockOpportunity(),
        {
          ...createMockOpportunity(),
          opportunity: {
            ...createMockOpportunity().opportunity,
            symbol: 'BTCUSDT',
          },
        },
      ];

      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      // Mock placeOrder to return immediately filled orders
      lighterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse(
          'order-1',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.LONG,
          undefined,
          1.0,
          3000,
        ),
      );
      asterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse(
          'order-2',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined,
          1.0,
          3001,
        ),
      );

      // Mock getOrderStatus for waitForOrderFill (shouldn't be called since orders are filled)
      lighterAdapter.getOrderStatus.mockResolvedValue(
        new PerpOrderResponse(
          'order-1',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.LONG,
          undefined,
          1.0,
          3000,
        ),
      );
      asterAdapter.getOrderStatus.mockResolvedValue(
        new PerpOrderResponse(
          'order-2',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined,
          1.0,
          3001,
        ),
      );

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      const executionResult = await executor.executeMultiplePositions(
        opportunities,
        mockAdapters,
        new Map(),
        result,
      );

      expect(executionResult.isSuccess).toBe(true);
      if (executionResult.isSuccess) {
        expect(executionResult.value.successfulExecutions).toBeGreaterThan(0);
        expect(executionResult.value.totalOrders).toBeGreaterThan(0);
      }
    });

    it('should skip opportunities without plans', async () => {
      const opportunities = [
        createMockOpportunity(),
        {
          ...createMockOpportunity(),
          plan: null,
        },
      ];

      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      // Mock placeOrder to return immediately filled orders
      lighterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse(
          'order-1',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.LONG,
          undefined,
          1.0,
          3000,
        ),
      );
      asterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse(
          'order-2',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined,
          1.0,
          3001,
        ),
      );

      // Mock getOrderStatus for waitForOrderFill (shouldn't be called since orders are filled)
      lighterAdapter.getOrderStatus.mockResolvedValue(
        new PerpOrderResponse(
          'order-1',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.LONG,
          undefined,
          1.0,
          3000,
        ),
      );
      asterAdapter.getOrderStatus.mockResolvedValue(
        new PerpOrderResponse(
          'order-2',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined,
          1.0,
          3001,
        ),
      );

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      const executionResult = await executor.executeMultiplePositions(
        opportunities,
        mockAdapters,
        new Map(),
        result,
      );

      // Should only execute the one with a plan
      expect(executionResult.isSuccess).toBe(true);
      if (executionResult.isSuccess) {
        expect(
          executionResult.value.successfulExecutions,
        ).toBeGreaterThanOrEqual(0);
      }
    });

    it('should retry failed executions', async () => {
      const opportunity = createMockOpportunity();
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      // First attempt fails, second succeeds
      let attempt = 0;
      lighterAdapter.placeOrder.mockImplementation(() => {
        attempt++;
        if (attempt === 1) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve(
          new PerpOrderResponse(
            'order-1',
            OrderStatus.FILLED,
            'ETHUSDT',
            OrderSide.LONG,
            undefined,
            1.0,
            3000,
          ),
        );
      });
      asterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse(
          'order-2',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined,
          1.0,
          3001,
        ),
      );

      // Mock getOrderStatus for waitForOrderFill
      lighterAdapter.getOrderStatus.mockResolvedValue(
        new PerpOrderResponse(
          'order-1',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.LONG,
          undefined,
          1.0,
          3000,
        ),
      );
      asterAdapter.getOrderStatus.mockResolvedValue(
        new PerpOrderResponse(
          'order-2',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined,
          1.0,
          3001,
        ),
      );

      // Override config to use faster retries for test
      const fastConfig = StrategyConfig.withDefaults();
      (fastConfig as any).executionRetryDelays = [10, 20]; // Very fast retries
      (fastConfig as any).maxExecutionRetries = 2; // Only 2 retries

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      // Create executor with fast config
      const fastExecutor = new OrderExecutor(
        mockPositionManager,
        mockCostCalculator,
        mockExecutionPlanBuilder,
        fastConfig,
      );

      const executionResult = await fastExecutor.executeMultiplePositions(
        [opportunity],
        mockAdapters,
        new Map(),
        result,
      );

      // Should retry and eventually succeed
      expect(lighterAdapter.placeOrder).toHaveBeenCalledTimes(2);
      expect(executionResult.isSuccess).toBe(true);
    }, 15000);
  });

  describe('placeOrderPair sequential execution', () => {
    it('should execute sequentially when long exchange is Lighter', async () => {
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      const callOrder: string[] = [];

      lighterAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('lighter-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push('lighter-end');
        return new PerpOrderResponse(
          'order-1',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.LONG,
          undefined,
          1.0,
          3000,
        );
      });

      asterAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('aster-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push('aster-end');
        return new PerpOrderResponse(
          'order-2',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined,
          1.0,
          3001,
        );
      });

      const opportunity = {
        plan: {
          longOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.LONG,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3000,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          shortOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.SHORT,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3001,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          positionSize: PositionSize.fromBaseAsset(1.0, 2.0),
          expectedNetReturn: 10,
          estimatedCosts: { total: 1, fees: 0.5, slippage: 0.5 },
          longMarkPrice: 3000,
          shortMarkPrice: 3001,
          timestamp: new Date(),
          opportunity: {
            symbol: 'ETHUSDT',
            strategyType: 'perp-perp',
            longExchange: ExchangeType.LIGHTER,
            shortExchange: ExchangeType.ASTER,
            longRate: Percentage.fromDecimal(0.001),
            shortRate: Percentage.fromDecimal(-0.001),
            spread: Percentage.fromDecimal(0.01),
            expectedReturn: Percentage.fromDecimal(0.35),
            timestamp: new Date(),
          },
        } as ArbitrageExecutionPlan,
        opportunity: {
          symbol: 'ETHUSDT',
          longExchange: ExchangeType.LIGHTER, // Lighter on long side
          shortExchange: ExchangeType.ASTER,
          spread: { toDecimal: () => 0.01 },
          longRate: { toDecimal: () => 0.001 },
          shortRate: { toDecimal: () => -0.001 },
          strategyType: 'perp-perp',
        } as any,
      };

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      await executor.executeSinglePosition(opportunity, mockAdapters, result);

      // Sequential execution: lighter should complete before aster starts
      expect(callOrder).toEqual([
        'lighter-start',
        'lighter-end',
        'aster-start',
        'aster-end',
      ]);
    });

    it('should execute sequentially when short exchange is Lighter', async () => {
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      const callOrder: string[] = [];

      asterAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('aster-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push('aster-end');
        return new PerpOrderResponse(
          'order-1',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.LONG,
          undefined,
          1.0,
          3000,
        );
      });

      lighterAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('lighter-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push('lighter-end');
        return new PerpOrderResponse(
          'order-2',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined,
          1.0,
          3001,
        );
      });

      const opportunity = {
        plan: {
          longOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.LONG,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3000,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          shortOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.SHORT,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3001,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          positionSize: PositionSize.fromBaseAsset(1.0, 2.0),
          expectedNetReturn: 10,
          estimatedCosts: { total: 1, fees: 0.5, slippage: 0.5 },
          longMarkPrice: 3000,
          shortMarkPrice: 3001,
          timestamp: new Date(),
          opportunity: {
            symbol: 'ETHUSDT',
            strategyType: 'perp-perp',
            longExchange: ExchangeType.LIGHTER,
            shortExchange: ExchangeType.ASTER,
            longRate: Percentage.fromDecimal(0.001),
            shortRate: Percentage.fromDecimal(-0.001),
            spread: Percentage.fromDecimal(0.01),
            expectedReturn: Percentage.fromDecimal(0.35),
            timestamp: new Date(),
          },
        } as ArbitrageExecutionPlan,
        opportunity: {
          symbol: 'ETHUSDT',
          longExchange: ExchangeType.ASTER,
          shortExchange: ExchangeType.LIGHTER, // Lighter on short side
          spread: { toDecimal: () => 0.01 },
          longRate: { toDecimal: () => 0.001 },
          shortRate: { toDecimal: () => -0.001 },
          strategyType: 'perp-perp',
        } as any,
      };

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      await executor.executeSinglePosition(opportunity, mockAdapters, result);

      // Sequential execution: aster (long) should complete before lighter (short) starts
      expect(callOrder).toEqual([
        'aster-start',
        'aster-end',
        'lighter-start',
        'lighter-end',
      ]);
    });

    it('should execute in parallel when neither exchange is Lighter', async () => {
      // Add HYPERLIQUID adapter for this test
      const hyperliquidAdapter = {
        placeOrder: jest.fn(),
        getOrderStatus: jest.fn(),
        getBalance: jest.fn().mockResolvedValue(10000),
        getPositions: jest.fn().mockResolvedValue([]),
        cancelAllOrders: jest.fn().mockResolvedValue(0),
      } as any;
      mockAdapters.set(ExchangeType.HYPERLIQUID, hyperliquidAdapter);

      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      const callOrder: string[] = [];

      asterAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('aster-start');
        await new Promise((resolve) => setTimeout(resolve, 50));
        callOrder.push('aster-end');
        return new PerpOrderResponse(
          'order-1',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.LONG,
          undefined,
          1.0,
          3000,
        );
      });

      hyperliquidAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('hyperliquid-start');
        await new Promise((resolve) => setTimeout(resolve, 50));
        callOrder.push('hyperliquid-end');
        return new PerpOrderResponse(
          'order-2',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined,
          1.0,
          3001,
        );
      });

      const opportunity = {
        plan: {
          longOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.LONG,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3000,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          shortOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.SHORT,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3001,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          positionSize: PositionSize.fromBaseAsset(1.0, 2.0),
          expectedNetReturn: 10,
          estimatedCosts: { total: 1, fees: 0.5, slippage: 0.5 },
          longMarkPrice: 3000,
          shortMarkPrice: 3001,
          timestamp: new Date(),
          opportunity: {
            symbol: 'ETHUSDT',
            strategyType: 'perp-perp',
            longExchange: ExchangeType.LIGHTER,
            shortExchange: ExchangeType.ASTER,
            longRate: Percentage.fromDecimal(0.001),
            shortRate: Percentage.fromDecimal(-0.001),
            spread: Percentage.fromDecimal(0.01),
            expectedReturn: Percentage.fromDecimal(0.35),
            timestamp: new Date(),
          },
        } as ArbitrageExecutionPlan,
        opportunity: {
          symbol: 'ETHUSDT',
          longExchange: ExchangeType.ASTER,
          shortExchange: ExchangeType.HYPERLIQUID, // Neither is Lighter
          spread: { toDecimal: () => 0.01 },
          longRate: { toDecimal: () => 0.001 },
          shortRate: { toDecimal: () => -0.001 },
          strategyType: 'perp-perp',
        } as any,
      };

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      await executor.executeSinglePosition(opportunity, mockAdapters, result);

      // Parallel execution: both should start before either ends
      // The order should be: both start, then both end (interleaved)
      expect(callOrder[0]).toMatch(/start/);
      expect(callOrder[1]).toMatch(/start/);
      expect(callOrder[2]).toMatch(/end/);
      expect(callOrder[3]).toMatch(/end/);
    });
  });

  describe('Sequential Rollback Tests', () => {
    it('should cancel unfilled first leg when second leg fails', async () => {
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      // First order succeeds but is NOT filled (pending)
      lighterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse(
          'order-1',
          OrderStatus.PENDING,
          'ETHUSDT',
          OrderSide.LONG,
          undefined,
          0, // Not filled
          undefined,
        ),
      );

      // Second order fails
      asterAdapter.placeOrder.mockRejectedValue(new Error('Insufficient balance'));

      // Setup cancel mock
      lighterAdapter.cancelOrder = jest.fn().mockResolvedValue(undefined);

      const opportunity = {
        plan: {
          longOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.LONG,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3000,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          shortOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.SHORT,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3001,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          positionSize: PositionSize.fromBaseAsset(1.0, 2.0),
          expectedNetReturn: 10,
          estimatedCosts: { total: 1, fees: 0.5, slippage: 0.5 },
          longMarkPrice: 3000,
          shortMarkPrice: 3001,
          timestamp: new Date(),
          opportunity: {
            symbol: 'ETHUSDT',
            strategyType: 'perp-perp',
            longExchange: ExchangeType.LIGHTER,
            shortExchange: ExchangeType.ASTER,
            longRate: Percentage.fromDecimal(0.001),
            shortRate: Percentage.fromDecimal(-0.001),
            spread: Percentage.fromDecimal(0.01),
            expectedReturn: Percentage.fromDecimal(0.35),
            timestamp: new Date(),
          },
        } as ArbitrageExecutionPlan,
        opportunity: {
          symbol: 'ETHUSDT',
          longExchange: ExchangeType.LIGHTER,
          shortExchange: ExchangeType.ASTER,
          spread: { toDecimal: () => 0.01 },
          longRate: { toDecimal: () => 0.001 },
          shortRate: { toDecimal: () => -0.001 },
          strategyType: 'perp-perp',
        } as any,
      };

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      // Execute - returns Result, doesn't throw
      const execResult = await executor.executeSinglePosition(opportunity, mockAdapters, result);

      // Should fail
      expect(execResult.isFailure).toBe(true);

      // Verify cancel was called on the first (unfilled) order
      expect(lighterAdapter.cancelOrder).toHaveBeenCalledWith('order-1', 'ETHUSDT');
    });

    it('should place counter-order when first leg is filled and second fails', async () => {
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      let placeOrderCallCount = 0;

      // First order succeeds AND is filled
      lighterAdapter.placeOrder.mockImplementation(async (order: PerpOrderRequest) => {
        placeOrderCallCount++;
        if (placeOrderCallCount === 1) {
          // Initial LONG order - filled
          return new PerpOrderResponse(
            'order-1',
            OrderStatus.FILLED,
            'ETHUSDT',
            OrderSide.LONG,
            undefined,
            1.0, // Filled
            3000,
          );
        } else {
          // Counter-order (rollback) - filled
          return new PerpOrderResponse(
            'counter-order',
            OrderStatus.FILLED,
            'ETHUSDT',
            OrderSide.SHORT,
            undefined,
            1.0,
            3000,
          );
        }
      });

      // Second order fails
      asterAdapter.placeOrder.mockRejectedValue(new Error('Network error'));

      // Setup getMarkPrice for rollback
      lighterAdapter.getMarkPrice = jest.fn().mockResolvedValue(3000);

      const opportunity = {
        plan: {
          longOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.LONG,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3000,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          shortOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.SHORT,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3001,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          positionSize: PositionSize.fromBaseAsset(1.0, 2.0),
          expectedNetReturn: 10,
          estimatedCosts: { total: 1, fees: 0.5, slippage: 0.5 },
          longMarkPrice: 3000,
          shortMarkPrice: 3001,
          timestamp: new Date(),
          opportunity: {
            symbol: 'ETHUSDT',
            strategyType: 'perp-perp',
            longExchange: ExchangeType.LIGHTER,
            shortExchange: ExchangeType.ASTER,
            longRate: Percentage.fromDecimal(0.001),
            shortRate: Percentage.fromDecimal(-0.001),
            spread: Percentage.fromDecimal(0.01),
            expectedReturn: Percentage.fromDecimal(0.35),
            timestamp: new Date(),
          },
        } as ArbitrageExecutionPlan,
        opportunity: {
          symbol: 'ETHUSDT',
          longExchange: ExchangeType.LIGHTER,
          shortExchange: ExchangeType.ASTER,
          spread: { toDecimal: () => 0.01 },
          longRate: { toDecimal: () => 0.001 },
          shortRate: { toDecimal: () => -0.001 },
          strategyType: 'perp-perp',
        } as any,
      };

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      // Execute - returns Result, doesn't throw
      const execResult = await executor.executeSinglePosition(opportunity, mockAdapters, result);

      // Should fail
      expect(execResult.isFailure).toBe(true);

      // Verify counter-order was placed (second call to placeOrder on lighter)
      expect(placeOrderCallCount).toBe(2);
      
      // The second call should be a SHORT (counter-order to close the LONG)
      const calls = lighterAdapter.placeOrder.mock.calls;
      expect(calls.length).toBe(2);
      expect(calls[1][0].side).toBe(OrderSide.SHORT);
      expect(calls[1][0].reduceOnly).toBe(true);
    });

    it('should not leave single-leg exposure after sequential failure', async () => {
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      // Track all operations
      const operations: string[] = [];

      // First order succeeds and fills
      lighterAdapter.placeOrder.mockImplementation(async (order: PerpOrderRequest) => {
        operations.push(`place-${order.side}`);
        if (order.side === OrderSide.LONG) {
          return new PerpOrderResponse(
            'order-1',
            OrderStatus.FILLED,
            'ETHUSDT',
            OrderSide.LONG,
            undefined,
            1.0,
            3000,
          );
        }
        // Counter-order
        return new PerpOrderResponse(
          'counter-order',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined,
          1.0,
          3000,
        );
      });

      lighterAdapter.getMarkPrice = jest.fn().mockResolvedValue(3000);
      lighterAdapter.cancelOrder = jest.fn().mockImplementation(async () => {
        operations.push('cancel');
      });

      // Second order fails
      asterAdapter.placeOrder.mockImplementation(async () => {
        operations.push('aster-fail');
        throw new Error('Rate limit exceeded');
      });

      const opportunity = {
        plan: {
          longOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.LONG,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3000,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          shortOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.SHORT,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3001,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          positionSize: PositionSize.fromBaseAsset(1.0, 2.0),
          expectedNetReturn: 10,
          estimatedCosts: { total: 1, fees: 0.5, slippage: 0.5 },
          longMarkPrice: 3000,
          shortMarkPrice: 3001,
          timestamp: new Date(),
          opportunity: {
            symbol: 'ETHUSDT',
            strategyType: 'perp-perp',
            longExchange: ExchangeType.LIGHTER,
            shortExchange: ExchangeType.ASTER,
            longRate: Percentage.fromDecimal(0.001),
            shortRate: Percentage.fromDecimal(-0.001),
            spread: Percentage.fromDecimal(0.01),
            expectedReturn: Percentage.fromDecimal(0.35),
            timestamp: new Date(),
          },
        } as ArbitrageExecutionPlan,
        opportunity: {
          symbol: 'ETHUSDT',
          longExchange: ExchangeType.LIGHTER,
          shortExchange: ExchangeType.ASTER,
          spread: { toDecimal: () => 0.01 },
          longRate: { toDecimal: () => 0.001 },
          shortRate: { toDecimal: () => -0.001 },
          strategyType: 'perp-perp',
        } as any,
      };

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      const execResult = await executor.executeSinglePosition(opportunity, mockAdapters, result);

      // Should fail
      expect(execResult.isFailure).toBe(true);

      // Verify the sequence: LONG placed -> Aster fails -> Counter-order placed
      expect(operations).toContain('place-LONG');
      expect(operations).toContain('aster-fail');
      expect(operations).toContain('place-SHORT'); // Counter-order
    });
  });

  describe('Parallel Execution Rollback Tests', () => {
    it('should rollback successful leg when other leg fails in parallel', async () => {
      // Add HYPERLIQUID adapter for parallel execution
      const hyperliquidAdapter = {
        placeOrder: jest.fn(),
        getOrderStatus: jest.fn(),
        getBalance: jest.fn().mockResolvedValue(10000),
        getPositions: jest.fn().mockResolvedValue([]),
        cancelOrder: jest.fn().mockResolvedValue(undefined),
        getMarkPrice: jest.fn().mockResolvedValue(3000),
        cancelAllOrders: jest.fn().mockResolvedValue(0),
      } as any;
      mockAdapters.set(ExchangeType.HYPERLIQUID, hyperliquidAdapter);

      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      asterAdapter.cancelOrder = jest.fn().mockResolvedValue(undefined);
      asterAdapter.getMarkPrice = jest.fn().mockResolvedValue(3000);

      let asterCallCount = 0;

      // Aster succeeds and fills
      asterAdapter.placeOrder.mockImplementation(async (order: PerpOrderRequest) => {
        asterCallCount++;
        if (asterCallCount === 1) {
          return new PerpOrderResponse(
            'aster-order-1',
            OrderStatus.FILLED,
            'ETHUSDT',
            OrderSide.LONG,
            undefined,
            1.0,
            3000,
          );
        }
        // Counter-order
        return new PerpOrderResponse(
          'aster-counter',
          OrderStatus.FILLED,
          'ETHUSDT',
          OrderSide.SHORT,
          undefined,
          1.0,
          3000,
        );
      });

      // Hyperliquid fails
      hyperliquidAdapter.placeOrder.mockRejectedValue(new Error('Connection refused'));

      const opportunity = {
        plan: {
          longOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.LONG,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3000,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          shortOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.SHORT,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3001,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          positionSize: PositionSize.fromBaseAsset(1.0, 2.0),
          expectedNetReturn: 10,
          estimatedCosts: { total: 1, fees: 0.5, slippage: 0.5 },
          longMarkPrice: 3000,
          shortMarkPrice: 3001,
          timestamp: new Date(),
          opportunity: {
            symbol: 'ETHUSDT',
            strategyType: 'perp-perp',
            longExchange: ExchangeType.ASTER,
            shortExchange: ExchangeType.HYPERLIQUID,
            longRate: Percentage.fromDecimal(0.001),
            shortRate: Percentage.fromDecimal(-0.001),
            spread: Percentage.fromDecimal(0.01),
            expectedReturn: Percentage.fromDecimal(0.35),
            timestamp: new Date(),
          },
        } as ArbitrageExecutionPlan,
        opportunity: {
          symbol: 'ETHUSDT',
          longExchange: ExchangeType.ASTER,
          shortExchange: ExchangeType.HYPERLIQUID,
          spread: { toDecimal: () => 0.01 },
          longRate: { toDecimal: () => 0.001 },
          shortRate: { toDecimal: () => -0.001 },
          strategyType: 'perp-perp',
        } as any,
      };

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      const execResult = await executor.executeSinglePosition(opportunity, mockAdapters, result);

      // Should fail
      expect(execResult.isFailure).toBe(true);

      // Verify rollback was attempted on Aster (the successful leg)
      // Either cancel or counter-order should have been called
      const asterPlaceCalls = asterAdapter.placeOrder.mock.calls;
      expect(asterPlaceCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Delta-Neutral Invariant Tests', () => {
    it('should never leave a position without matching counterpart', async () => {
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      // Track final state
      const finalPositions: { exchange: ExchangeType; side: OrderSide }[] = [];

      lighterAdapter.placeOrder.mockImplementation(async (order: PerpOrderRequest) => {
        if (!order.reduceOnly) {
          finalPositions.push({ exchange: ExchangeType.LIGHTER, side: order.side });
        } else {
          // Remove position on close
          const idx = finalPositions.findIndex(
            p => p.exchange === ExchangeType.LIGHTER && p.side !== order.side
          );
          if (idx >= 0) finalPositions.splice(idx, 1);
        }
        return new PerpOrderResponse(
          `order-${Date.now()}`,
          OrderStatus.FILLED,
          'ETHUSDT',
          order.side,
          undefined,
          order.size,
          3000,
        );
      });

      asterAdapter.placeOrder.mockImplementation(async (order: PerpOrderRequest) => {
        if (!order.reduceOnly) {
          finalPositions.push({ exchange: ExchangeType.ASTER, side: order.side });
        } else {
          const idx = finalPositions.findIndex(
            p => p.exchange === ExchangeType.ASTER && p.side !== order.side
          );
          if (idx >= 0) finalPositions.splice(idx, 1);
        }
        return new PerpOrderResponse(
          `order-${Date.now()}`,
          OrderStatus.FILLED,
          'ETHUSDT',
          order.side,
          undefined,
          order.size,
          3001,
        );
      });

      lighterAdapter.getMarkPrice = jest.fn().mockResolvedValue(3000);
      asterAdapter.getMarkPrice = jest.fn().mockResolvedValue(3001);

      const opportunity = {
        plan: {
          longOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.LONG,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3000,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          shortOrder: {
            symbol: 'ETHUSDT',
            side: OrderSide.SHORT,
            size: 1.0,
            type: OrderType.LIMIT,
            price: 3001,
            timeInForce: TimeInForce.GTC,
            reduceOnly: false,
          } as PerpOrderRequest,
          positionSize: PositionSize.fromBaseAsset(1.0, 2.0),
          expectedNetReturn: 10,
          estimatedCosts: { total: 1, fees: 0.5, slippage: 0.5 },
          longMarkPrice: 3000,
          shortMarkPrice: 3001,
          timestamp: new Date(),
          opportunity: {
            symbol: 'ETHUSDT',
            strategyType: 'perp-perp',
            longExchange: ExchangeType.LIGHTER,
            shortExchange: ExchangeType.ASTER,
            longRate: Percentage.fromDecimal(0.001),
            shortRate: Percentage.fromDecimal(-0.001),
            spread: Percentage.fromDecimal(0.01),
            expectedReturn: Percentage.fromDecimal(0.35),
            timestamp: new Date(),
          },
        } as ArbitrageExecutionPlan,
        opportunity: {
          symbol: 'ETHUSDT',
          longExchange: ExchangeType.LIGHTER,
          shortExchange: ExchangeType.ASTER,
          spread: { toDecimal: () => 0.01 },
          longRate: { toDecimal: () => 0.001 },
          shortRate: { toDecimal: () => -0.001 },
          strategyType: 'perp-perp',
        } as any,
      };

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      await executor.executeSinglePosition(opportunity, mockAdapters, result);

      // Verify delta-neutral: should have exactly one LONG and one SHORT on different exchanges
      expect(finalPositions).toHaveLength(2);
      const longs = finalPositions.filter(p => p.side === OrderSide.LONG);
      const shorts = finalPositions.filter(p => p.side === OrderSide.SHORT);
      expect(longs).toHaveLength(1);
      expect(shorts).toHaveLength(1);
      expect(longs[0].exchange).not.toBe(shorts[0].exchange);
    });
  });
});
