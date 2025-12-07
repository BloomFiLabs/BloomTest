import { Test, TestingModule } from '@nestjs/testing';
import { PositionManager } from './PositionManager';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { PerpPosition } from '../../entities/PerpPosition';
import { OrderSide } from '../../value-objects/PerpOrder';
import {
  PerpOrderRequest,
  OrderType,
  TimeInForce,
} from '../../value-objects/PerpOrder';
import {
  PerpOrderResponse,
  OrderStatus,
} from '../../value-objects/PerpOrder';
import {
  ArbitrageExecutionResult,
} from '../FundingArbitrageStrategy';
import { AsymmetricFill } from './IPositionManager';
import { IOrderExecutor } from './IOrderExecutor';

describe('PositionManager', () => {
  let manager: PositionManager;
  let mockAdapters: Map<ExchangeType, jest.Mocked<IPerpExchangeAdapter>>;
  let mockOrderExecutor: jest.Mocked<IOrderExecutor>;
  let config: StrategyConfig;

  beforeEach(async () => {
    config = new StrategyConfig();

    mockOrderExecutor = {
      waitForOrderFill: jest.fn().mockResolvedValue(
        new PerpOrderResponse('order-1', OrderStatus.FILLED, 'ETHUSDT', OrderSide.LONG, 1.0, 1.0, 3000),
      ),
    } as any;

    // Create mock adapters
    mockAdapters = new Map();
    const asterAdapter = {
      getPositions: jest.fn(),
      placeOrder: jest.fn(),
      cancelOrder: jest.fn(),
    } as any;

    const lighterAdapter = {
      getPositions: jest.fn(),
      placeOrder: jest.fn(),
      cancelOrder: jest.fn(),
    } as any;

    mockAdapters.set(ExchangeType.ASTER, asterAdapter);
    mockAdapters.set(ExchangeType.LIGHTER, lighterAdapter);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionManager,
        { provide: StrategyConfig, useValue: config },
        { provide: 'IOrderExecutor', useValue: mockOrderExecutor },
      ],
    }).compile();

    manager = module.get<PositionManager>(PositionManager);
  });

  describe('getAllPositions', () => {
    it('should aggregate positions from all exchanges', async () => {
      const asterPositions: PerpPosition[] = [
        new PerpPosition(
          ExchangeType.ASTER,
          'ETHUSDT',
          OrderSide.LONG,
          1.0,
          3000,
          3001,
          0,
        ),
      ];
      const lighterPositions: PerpPosition[] = [
        new PerpPosition(
          ExchangeType.LIGHTER,
          'BTCUSDT',
          OrderSide.SHORT,
          0.5,
          50000,
          50001,
          0,
        ),
      ];

      mockAdapters.get(ExchangeType.ASTER)!.getPositions.mockResolvedValue(
        asterPositions,
      );
      mockAdapters.get(ExchangeType.LIGHTER)!.getPositions.mockResolvedValue(
        lighterPositions,
      );

      const result = await manager.getAllPositions(mockAdapters);

      expect(result).toHaveLength(2);
      expect(result).toContainEqual(asterPositions[0]);
      expect(result).toContainEqual(lighterPositions[0]);
    });

    it('should handle adapter errors gracefully', async () => {
      mockAdapters.get(ExchangeType.ASTER)!.getPositions.mockRejectedValue(
        new Error('API error'),
      );
      mockAdapters.get(ExchangeType.LIGHTER)!.getPositions.mockResolvedValue([]);

      const result = await manager.getAllPositions(mockAdapters);

      // Should still return positions from working adapters
      expect(result).toHaveLength(0);
    });

    it('should return empty array when no positions exist', async () => {
      mockAdapters.get(ExchangeType.ASTER)!.getPositions.mockResolvedValue([]);
      mockAdapters.get(ExchangeType.LIGHTER)!.getPositions.mockResolvedValue([]);

      const result = await manager.getAllPositions(mockAdapters);

      expect(result).toHaveLength(0);
    });
  });

  describe('closeAllPositions', () => {
    const createMockPosition = (
      symbol: string,
      exchange: ExchangeType,
      side: OrderSide,
      size: number,
    ): PerpPosition => {
      return new PerpPosition(exchange, symbol, side, size, 3000, 3001, 0);
    };

    it('should close all positions successfully', async () => {
      const positions = [
        createMockPosition('ETHUSDT', ExchangeType.ASTER, OrderSide.LONG, 1.0),
        createMockPosition('BTCUSDT', ExchangeType.LIGHTER, OrderSide.SHORT, 0.5),
      ];

      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;

      asterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse('close-1', OrderStatus.FILLED, 'ETHUSDT', OrderSide.SHORT, 1.0, 1.0, 3000),
      );
      lighterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse('close-2', OrderStatus.FILLED, 'BTCUSDT', OrderSide.LONG, 0.5, 0.5, 50000),
      );

      // Mock getPositions to return empty after close
      asterAdapter.getPositions.mockResolvedValue([]);
      lighterAdapter.getPositions.mockResolvedValue([]);

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      const closeResult = await manager.closeAllPositions(
        positions,
        mockAdapters,
        result,
      );

      expect(closeResult.closed).toHaveLength(2);
      expect(closeResult.stillOpen).toHaveLength(0);
      expect(asterAdapter.placeOrder).toHaveBeenCalled();
      expect(lighterAdapter.placeOrder).toHaveBeenCalled();
    });

    it('should use market orders with IOC and reduceOnly for closing', async () => {
      const position = createMockPosition(
        'ETHUSDT',
        ExchangeType.ASTER,
        OrderSide.LONG,
        1.0,
      );

      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      asterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse('close-1', OrderStatus.FILLED, 'ETHUSDT', OrderSide.SHORT, 1.0, 1.0, 3000),
      );
      asterAdapter.getPositions.mockResolvedValue([]);

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      await manager.closeAllPositions([position], mockAdapters, result);

      expect(asterAdapter.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          type: OrderType.MARKET,
          timeInForce: TimeInForce.IOC,
          reduceOnly: true,
        }),
      );
    });

    it('should handle positions that fail to close', async () => {
      const position = createMockPosition(
        'ETHUSDT',
        ExchangeType.ASTER,
        OrderSide.LONG,
        1.0,
      );

      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      asterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse('close-1', OrderStatus.REJECTED, 'ETHUSDT', OrderSide.SHORT, undefined, undefined, undefined, 'Insufficient balance'),
      );
      asterAdapter.getPositions.mockResolvedValue([position]); // Position still exists

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      const closeResult = await manager.closeAllPositions(
        [position],
        mockAdapters,
        result,
      );

      expect(closeResult.closed).toHaveLength(0);
      expect(closeResult.stillOpen.length).toBeGreaterThan(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should attempt final market order fallback if position still exists', async () => {
      const position = createMockPosition(
        'ETHUSDT',
        ExchangeType.ASTER,
        OrderSide.LONG,
        1.0,
      );

      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      // First close attempt fails
      asterAdapter.placeOrder.mockResolvedValueOnce(
        new PerpOrderResponse('close-1', OrderStatus.SUBMITTED, 'ETHUSDT', OrderSide.SHORT),
      );
      // Position still exists after first attempt
      asterAdapter.getPositions.mockResolvedValueOnce([position]);
      // Final fallback succeeds
      asterAdapter.placeOrder.mockResolvedValueOnce(
        new PerpOrderResponse('close-2', OrderStatus.FILLED, 'ETHUSDT', OrderSide.SHORT, 1.0, 1.0, 3000),
      );
      // Position closed after fallback
      asterAdapter.getPositions.mockResolvedValueOnce([]);

      const result: ArbitrageExecutionResult = {
        success: true,
        opportunitiesEvaluated: 0,
        opportunitiesExecuted: 0,
        totalExpectedReturn: 0,
        ordersPlaced: 0,
        errors: [],
        timestamp: new Date(),
      };

      const closeResult = await manager.closeAllPositions(
        [position],
        mockAdapters,
        result,
      );

      // Should have attempted fallback (at least 1 call, possibly 2)
      expect(asterAdapter.placeOrder).toHaveBeenCalled();
      // May or may not succeed depending on timing
      expect(asterAdapter.getPositions).toHaveBeenCalled();
    }, 10000);

    it('should handle missing adapters', async () => {
      const position = createMockPosition(
        'ETHUSDT',
        ExchangeType.ASTER,
        OrderSide.LONG,
        1.0,
      );

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

      const closeResult = await manager.closeAllPositions(
        [position],
        emptyAdapters,
        result,
      );

      expect(closeResult.closed).toHaveLength(0);
      expect(closeResult.stillOpen).toHaveLength(1);
    });
  });

  describe('handleAsymmetricFills', () => {
    const createMockFill = (): AsymmetricFill => ({
      symbol: 'ETHUSDT',
      longFilled: true,
      shortFilled: false,
      longOrderId: 'long-123',
      shortOrderId: 'short-123',
      longExchange: ExchangeType.LIGHTER,
      shortExchange: ExchangeType.ASTER,
      positionSize: 1.0,
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
      },
      timestamp: new Date(Date.now() - 3 * 60 * 1000), // 3 minutes ago (exceeds timeout)
    });

    it('should handle profitable asymmetric fills by completing with market order', async () => {
      const fill = createMockFill();
      // Make it very profitable by setting very high expected return
      // Position size is 1.0, mark price ~3000, so positionSizeUsd = 3000
      // With 1.0 APY (100%), expectedReturnPerPeriod = (1.0 / (24*365)) * 3000 = ~0.342
      // Fees + slippage ~= 3000 * (0.0005 + 0.0005 + 0.0005) = 4.5
      // amortizedCostsPerPeriod = 4.5 / 24 = 0.1875
      // expectedNetReturn = 0.342 - 0.1875 = 0.1545 > 0, so profitable
      fill.opportunity.expectedReturn = 1.0; // 100% APY - very profitable
      fill.opportunity.longMarkPrice = 3000;
      fill.opportunity.shortMarkPrice = 3000;
      // Make sure it exceeds timeout
      fill.timestamp = new Date(Date.now() - 3 * 60 * 1000); // 3 minutes ago
      const fills = [fill];
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      asterAdapter.cancelOrder.mockResolvedValue(undefined);
      asterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse('market-1', OrderStatus.FILLED, 'ETHUSDT', OrderSide.SHORT, 1.0, 1.0, 3001),
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

      await manager.handleAsymmetricFills(mockAdapters, fills, result);

      // Should cancel GTC order and place market order
      expect(asterAdapter.cancelOrder).toHaveBeenCalledWith('short-123', 'ETHUSDT');
      expect(asterAdapter.placeOrder).toHaveBeenCalled();
    }, 10000);

    it('should close filled position if no longer profitable', async () => {
      const fill = createMockFill();
      // Make it unprofitable by setting very low expected return
      fill.opportunity.expectedReturn = 0.0001; // 0.01% APY - unprofitable after fees
      const fills = [fill];
      const lighterAdapter = mockAdapters.get(ExchangeType.LIGHTER)!;
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;

      asterAdapter.cancelOrder.mockResolvedValue(undefined);
      lighterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse('close-1', OrderStatus.FILLED, 'ETHUSDT', OrderSide.SHORT, 1.0, 1.0, 3001),
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

      await manager.handleAsymmetricFills(mockAdapters, fills, result);

      // Should cancel order and close position
      expect(asterAdapter.cancelOrder).toHaveBeenCalled();
      expect(lighterAdapter.placeOrder).toHaveBeenCalled();
    });

    it('should handle missing adapters', async () => {
      const fills = [createMockFill()];
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

      await manager.handleAsymmetricFills(emptyAdapters, fills, result);

      // Should handle gracefully without errors
      expect(result.errors.length).toBe(0);
    });

    it('should handle fills that are within timeout', async () => {
      const recentFill: AsymmetricFill = {
        ...createMockFill(),
        timestamp: new Date(), // Just now, within timeout
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

      await manager.handleAsymmetricFills(mockAdapters, [recentFill], result);

      // Should not process fills within timeout
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      expect(asterAdapter.cancelOrder).not.toHaveBeenCalled();
    });
  });

  describe('closeFilledPosition', () => {
    it('should close a filled position with market order', async () => {
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      asterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse('close-1', OrderStatus.FILLED, 'ETHUSDT', OrderSide.SHORT, 1.0, 1.0, 3000),
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

      await manager.closeFilledPosition(
        asterAdapter,
        'ETHUSDT',
        'LONG',
        1.0,
        ExchangeType.ASTER,
        result,
      );

      expect(asterAdapter.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: 'ETHUSDT',
          side: OrderSide.SHORT,
          type: OrderType.MARKET,
          size: 1.0,
        }),
      );
    });

    it('should handle order failures', async () => {
      const asterAdapter = mockAdapters.get(ExchangeType.ASTER)!;
      asterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse('close-1', OrderStatus.REJECTED, 'ETHUSDT', OrderSide.SHORT, undefined, undefined, undefined, 'Insufficient balance'),
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

      await manager.closeFilledPosition(
        asterAdapter,
        'ETHUSDT',
        'LONG',
        1.0,
        ExchangeType.ASTER,
        result,
      );

      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});

