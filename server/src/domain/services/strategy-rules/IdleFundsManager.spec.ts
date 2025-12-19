import { IdleFundsManager } from './IdleFundsManager';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { ExecutionPlanBuilder } from './ExecutionPlanBuilder';
import { CostCalculator } from './CostCalculator';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { PerpPosition } from '../../entities/PerpPosition';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { Percentage } from '../../value-objects/Percentage';
import { OrderSide, OrderStatus } from '../../value-objects/PerpOrder';
import { PerpOrderResponse } from '../../value-objects/PerpOrder';

describe('IdleFundsManager', () => {
  let manager: IdleFundsManager;
  let mockExecutionPlanBuilder: jest.Mocked<ExecutionPlanBuilder>;
  let mockCostCalculator: jest.Mocked<CostCalculator>;
  let mockAdapters: Map<ExchangeType, jest.Mocked<IPerpExchangeAdapter>>;
  let config: StrategyConfig;

  beforeEach(() => {
    config = StrategyConfig.withDefaults();
    mockExecutionPlanBuilder = {
      buildPlan: jest.fn(),
    } as any;
    mockCostCalculator = {} as any;

    manager = new IdleFundsManager(
      config,
      mockExecutionPlanBuilder,
      mockCostCalculator,
    );

    // Create mock adapters
    mockAdapters = new Map();
    const createMockAdapter = (
      exchange: ExchangeType,
    ): jest.Mocked<IPerpExchangeAdapter> =>
      ({
        getBalance: jest.fn(),
        getPositions: jest.fn(),
        getOrderStatus: jest.fn(),
        placeOrder: jest.fn(),
        cancelOrder: jest.fn(),
        getMarkPrice: jest.fn(),
      }) as any;

    mockAdapters.set(
      ExchangeType.HYPERLIQUID,
      createMockAdapter(ExchangeType.HYPERLIQUID),
    );
    mockAdapters.set(
      ExchangeType.LIGHTER,
      createMockAdapter(ExchangeType.LIGHTER),
    );
    mockAdapters.set(ExchangeType.ASTER, createMockAdapter(ExchangeType.ASTER));
  });

  const createMockPosition = (
    symbol: string,
    exchange: ExchangeType,
    side: OrderSide,
    size: number,
    markPrice: number,
  ): PerpPosition => {
    return new PerpPosition(
      exchange,
      symbol,
      side,
      size,
      markPrice,
      markPrice,
      0,
      undefined,
      undefined,
      undefined,
      new Date(),
    );
  };

  const createMockOpportunity = (
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    expectedReturn: number = 0.35,
  ): ArbitrageOpportunity => {
    return {
      symbol,
      strategyType: 'perp-perp',
      longExchange,
      shortExchange,
      longRate: Percentage.fromDecimal(0.001),
      shortRate: Percentage.fromDecimal(-0.0005),
      spread: Percentage.fromDecimal(0.0015),
      expectedReturn: Percentage.fromDecimal(expectedReturn),
      longMarkPrice: 100,
      shortMarkPrice: 100.1,
      timestamp: new Date(),
    } as ArbitrageOpportunity;
  };

  describe('detectIdleFunds', () => {
    it('should detect unused balance on exchanges with no positions or orders', async () => {
      const positions: PerpPosition[] = [];
      const openOrders = new Map<ExchangeType, string[]>();
      const failedOrders = new Map<
        ExchangeType,
        Array<{ orderId: string; symbol: string; timestamp: Date }>
      >();

      mockAdapters
        .get(ExchangeType.HYPERLIQUID)!
        .getBalance.mockResolvedValue(1000);
      mockAdapters.get(ExchangeType.LIGHTER)!.getBalance.mockResolvedValue(500);
      mockAdapters.get(ExchangeType.ASTER)!.getBalance.mockResolvedValue(0);

      const result = await manager.detectIdleFunds(
        mockAdapters,
        positions,
        openOrders,
        failedOrders,
      );

      expect(result.isSuccess).toBe(true);
      expect((result as any).value.length).toBe(2);
      expect(
        (result as any).value.some(
          (info: any) =>
            info.exchange === ExchangeType.HYPERLIQUID &&
            info.idleBalance === 1000,
        ),
      ).toBe(true);
      expect(
        (result as any).value.some(
          (info: any) =>
            info.exchange === ExchangeType.LIGHTER && info.idleBalance === 500,
        ),
      ).toBe(true);
    });

    it('should not detect idle funds below minimum threshold', async () => {
      const positions: PerpPosition[] = [];
      const openOrders = new Map<ExchangeType, string[]>();
      const failedOrders = new Map<
        ExchangeType,
        Array<{ orderId: string; symbol: string; timestamp: Date }>
      >();

      mockAdapters
        .get(ExchangeType.HYPERLIQUID)!
        .getBalance.mockResolvedValue(5); // Below $10 threshold

      const result = await manager.detectIdleFunds(
        mockAdapters,
        positions,
        openOrders,
        failedOrders,
      );

      expect(result.isSuccess).toBe(true);
      expect((result as any).value.length).toBe(0);
    });

    it('should detect idle funds from failed orders after timeout', async () => {
      const positions: PerpPosition[] = [];
      const openOrders = new Map<ExchangeType, string[]>();
      const failedOrders = new Map<
        ExchangeType,
        Array<{ orderId: string; symbol: string; timestamp: Date }>
      >();

      const oldTimestamp = new Date(Date.now() - 6 * 60 * 1000); // 6 minutes ago
      failedOrders.set(ExchangeType.HYPERLIQUID, [
        { orderId: 'failed-1', symbol: 'ETHUSDT', timestamp: oldTimestamp },
      ]);

      mockAdapters
        .get(ExchangeType.HYPERLIQUID)!
        .getBalance.mockResolvedValue(1000);
      mockAdapters
        .get(ExchangeType.HYPERLIQUID)!
        .getOrderStatus.mockResolvedValue(
          new PerpOrderResponse(
            'failed-1',
            OrderStatus.SUBMITTED,
            'ETHUSDT',
            OrderSide.LONG,
          ),
        );

      const result = await manager.detectIdleFunds(
        mockAdapters,
        positions,
        openOrders,
        failedOrders,
      );

      expect(result.isSuccess).toBe(true);
      const failedOrderIdle = (result as any).value.find(
        (info) => info.reason === 'unfilled_order',
      );
      expect(failedOrderIdle).toBeDefined();
      expect(failedOrderIdle?.orderId).toBe('failed-1');
    });

    it('should account for margin used by existing positions', async () => {
      const positions = [
        createMockPosition(
          'ETHUSDT',
          ExchangeType.HYPERLIQUID,
          OrderSide.LONG,
          1,
          100,
        ),
      ];
      const openOrders = new Map<ExchangeType, string[]>();
      const failedOrders = new Map<
        ExchangeType,
        Array<{ orderId: string; symbol: string; timestamp: Date }>
      >();

      // Position value = 1 * 100 = $100, margin = $100 / 10 (leverage) = $10
      mockAdapters
        .get(ExchangeType.HYPERLIQUID)!
        .getBalance.mockResolvedValue(1000);
      // Available = 1000 - 10 = 990

      const result = await manager.detectIdleFunds(
        mockAdapters,
        positions,
        openOrders,
        failedOrders,
      );

      expect(result.isSuccess).toBe(true);
      // Should detect idle funds (990 - buffer)
      const hyperliquidIdle = (result as any).value.find(
        (info) => info.exchange === ExchangeType.HYPERLIQUID,
      );
      expect(hyperliquidIdle).toBeDefined();
      expect(hyperliquidIdle!.idleBalance).toBeGreaterThan(0);
    });
  });

  describe('rankPositionsByPerformance', () => {
    it('should rank positions by expected return (best first)', () => {
      const positions = [
        createMockPosition(
          'ETHUSDT',
          ExchangeType.HYPERLIQUID,
          OrderSide.LONG,
          1,
          100,
        ),
        createMockPosition(
          'BTCUSDT',
          ExchangeType.LIGHTER,
          OrderSide.SHORT,
          0.5,
          50000,
        ),
      ];

      const opportunities = [
        createMockOpportunity(
          'ETHUSDT',
          ExchangeType.HYPERLIQUID,
          ExchangeType.LIGHTER,
          0.5,
        ), // 50% APY
        createMockOpportunity(
          'BTCUSDT',
          ExchangeType.LIGHTER,
          ExchangeType.ASTER,
          0.2,
        ), // 20% APY
      ];

      const ranked = manager.rankPositionsByPerformance(
        positions,
        opportunities,
      );

      expect(ranked.length).toBe(2);
      expect(ranked[0].position.symbol).toBe('ETHUSDT'); // Higher APY first
      expect(ranked[0].expectedAPY).toBe(0.5);
      expect(ranked[1].position.symbol).toBe('BTCUSDT');
      expect(ranked[1].expectedAPY).toBe(0.2);
    });

    it('should handle positions without matching opportunities', () => {
      const positions = [
        createMockPosition(
          'ETHUSDT',
          ExchangeType.HYPERLIQUID,
          OrderSide.LONG,
          1,
          100,
        ),
      ];

      const opportunities: ArbitrageOpportunity[] = [];

      const ranked = manager.rankPositionsByPerformance(
        positions,
        opportunities,
      );

      expect(ranked.length).toBe(1);
      expect(ranked[0].expectedAPY).toBe(0);
      expect(ranked[0].expectedReturnPerPeriod).toBe(0);
    });
  });

  describe('allocateIdleFunds', () => {
    it('should allocate idle funds to best performing positions first', () => {
      const idleFunds = [
        {
          exchange: ExchangeType.HYPERLIQUID,
          idleBalance: 100,
          reason: 'unused_balance' as const,
        },
      ];

      const positions = [
        createMockPosition(
          'ETHUSDT',
          ExchangeType.HYPERLIQUID,
          OrderSide.LONG,
          1,
          100,
        ),
      ];

      const opportunities = [
        createMockOpportunity(
          'ETHUSDT',
          ExchangeType.HYPERLIQUID,
          ExchangeType.LIGHTER,
          0.5,
        ),
      ];

      const exchangeBalances = new Map<ExchangeType, number>();
      exchangeBalances.set(ExchangeType.HYPERLIQUID, 1000);

      const result = manager.allocateIdleFunds(
        idleFunds,
        opportunities,
        positions,
        exchangeBalances,
      );

      expect(result.isSuccess).toBe(true);
      expect((result as any).value.length).toBeGreaterThan(0);
      const bestPerformingAlloc = (result as any).value.find(
        (alloc) => alloc.target.reason === 'best_performing',
      );
      expect(bestPerformingAlloc).toBeDefined();
      expect(bestPerformingAlloc!.target.opportunity.symbol).toBe('ETHUSDT');
    });

    it('should allocate remaining idle funds to next best opportunities', () => {
      const idleFunds = [
        {
          exchange: ExchangeType.HYPERLIQUID,
          idleBalance: 200,
          reason: 'unused_balance' as const,
        },
        {
          exchange: ExchangeType.LIGHTER,
          idleBalance: 200,
          reason: 'unused_balance' as const,
        },
      ];

      const positions: PerpPosition[] = [];
      const opportunities = [
        createMockOpportunity(
          'ETHUSDT',
          ExchangeType.HYPERLIQUID,
          ExchangeType.LIGHTER,
          0.5,
        ),
        createMockOpportunity(
          'BTCUSDT',
          ExchangeType.HYPERLIQUID,
          ExchangeType.ASTER,
          0.3,
        ),
      ];

      const exchangeBalances = new Map<ExchangeType, number>();
      exchangeBalances.set(ExchangeType.HYPERLIQUID, 1000);
      exchangeBalances.set(ExchangeType.LIGHTER, 1000);

      const result = manager.allocateIdleFunds(
        idleFunds,
        opportunities,
        positions,
        exchangeBalances,
      );

      expect(result.isSuccess).toBe(true);
      expect((result as any).value.length).toBeGreaterThan(0);
      const nextOpportunityAlloc = (result as any).value.find(
        (alloc) => alloc.target.reason === 'next_opportunity',
      );
      expect(nextOpportunityAlloc).toBeDefined();
      // Should allocate to ETHUSDT first (higher expected return)
      const ethAlloc = (result as any).value.find(
        (alloc) => alloc.target.opportunity.symbol === 'ETHUSDT',
      );
      expect(ethAlloc).toBeDefined();
    });

    it('should return empty array if no idle funds', () => {
      const idleFunds: any[] = [];
      const opportunities = [
        createMockOpportunity(
          'ETHUSDT',
          ExchangeType.HYPERLIQUID,
          ExchangeType.LIGHTER,
        ),
      ];
      const positions: PerpPosition[] = [];
      const exchangeBalances = new Map<ExchangeType, number>();

      const result = manager.allocateIdleFunds(
        idleFunds,
        opportunities,
        positions,
        exchangeBalances,
      );

      expect(result.isSuccess).toBe(true);
      expect((result as any).value.length).toBe(0);
    });

    it('should return empty array if no opportunities', () => {
      const idleFunds = [
        {
          exchange: ExchangeType.HYPERLIQUID,
          idleBalance: 100,
          reason: 'unused_balance' as const,
        },
      ];
      const opportunities: ArbitrageOpportunity[] = [];
      const positions: PerpPosition[] = [];
      const exchangeBalances = new Map<ExchangeType, number>();

      const result = manager.allocateIdleFunds(
        idleFunds,
        opportunities,
        positions,
        exchangeBalances,
      );

      expect(result.isSuccess).toBe(true);
      expect((result as any).value.length).toBe(0);
    });
  });

  describe('executeAllocations', () => {
    it('should execute allocations successfully', async () => {
      const allocations = [
        {
          source: {
            exchange: ExchangeType.HYPERLIQUID,
            idleBalance: 100,
            reason: 'unused_balance' as const,
          },
          target: {
            opportunity: createMockOpportunity(
              'ETHUSDT',
              ExchangeType.HYPERLIQUID,
              ExchangeType.LIGHTER,
            ),
            allocation: 100,
            reason: 'best_performing' as const,
          },
        },
      ];

      mockExecutionPlanBuilder.buildPlan.mockResolvedValue({
        isSuccess: true,
        value: {
          longOrder: { price: 100 } as any,
          shortOrder: { price: 100.1 } as any,
        },
      } as any);

      mockAdapters
        .get(ExchangeType.HYPERLIQUID)!
        .placeOrder.mockResolvedValue(
          new PerpOrderResponse(
            'order-1',
            OrderStatus.FILLED,
            'ETHUSDT',
            OrderSide.LONG,
          ),
        );

      const result = await manager.executeAllocations(
        allocations,
        mockAdapters,
      );

      expect(result.isSuccess).toBe(true);
      expect((result as any).value.allocated).toBe(100);
      expect((result as any).value.allocations).toBe(1);
      expect(
        mockAdapters.get(ExchangeType.HYPERLIQUID)!.placeOrder,
      ).toHaveBeenCalled();
    });

    it('should cancel failed orders before allocating', async () => {
      const allocations = [
        {
          source: {
            exchange: ExchangeType.HYPERLIQUID,
            idleBalance: 100,
            reason: 'unfilled_order' as const,
            orderId: 'failed-1',
            symbol: 'ETHUSDT',
          },
          target: {
            opportunity: createMockOpportunity(
              'ETHUSDT',
              ExchangeType.HYPERLIQUID,
              ExchangeType.LIGHTER,
            ),
            allocation: 100,
            reason: 'next_opportunity' as const,
          },
        },
      ];

      mockAdapters
        .get(ExchangeType.HYPERLIQUID)!
        .cancelOrder.mockResolvedValue(true);
      mockExecutionPlanBuilder.buildPlan.mockResolvedValue({
        isSuccess: true,
        value: {
          longOrder: { price: 100 } as any,
          shortOrder: { price: 100.1 } as any,
        },
      } as any);
      mockAdapters
        .get(ExchangeType.HYPERLIQUID)!
        .placeOrder.mockResolvedValue(
          new PerpOrderResponse(
            'order-1',
            OrderStatus.FILLED,
            'ETHUSDT',
            OrderSide.LONG,
          ),
        );

      const result = await manager.executeAllocations(
        allocations,
        mockAdapters,
      );

      expect(result.isSuccess).toBe(true);
      expect(
        mockAdapters.get(ExchangeType.HYPERLIQUID)!.cancelOrder,
      ).toHaveBeenCalledWith('failed-1', 'ETHUSDT');
    });

    it('should handle execution plan build failure gracefully', async () => {
      const allocations = [
        {
          source: {
            exchange: ExchangeType.HYPERLIQUID,
            idleBalance: 100,
            reason: 'unused_balance' as const,
          },
          target: {
            opportunity: createMockOpportunity(
              'ETHUSDT',
              ExchangeType.HYPERLIQUID,
              ExchangeType.LIGHTER,
            ),
            allocation: 100,
            reason: 'best_performing' as const,
          },
        },
      ];

      mockExecutionPlanBuilder.buildPlan.mockResolvedValue({
        isSuccess: false,
        error: { message: 'Build failed' } as any,
      } as any);

      const result = await manager.executeAllocations(
        allocations,
        mockAdapters,
      );

      expect(result.isSuccess).toBe(true);
      expect((result as any).value.allocated).toBe(0);
      expect((result as any).value.allocations).toBe(0);
    });

    it('should return empty result for empty allocations', async () => {
      const result = await manager.executeAllocations([], mockAdapters);

      expect(result.isSuccess).toBe(true);
      expect((result as any).value.allocated).toBe(0);
      expect((result as any).value.allocations).toBe(0);
    });
  });
});
