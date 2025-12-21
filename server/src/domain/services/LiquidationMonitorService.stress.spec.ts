import { Test, TestingModule } from '@nestjs/testing';
import { LiquidationMonitorService } from './LiquidationMonitorService';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { OrderSide, OrderStatus, PerpOrderResponse } from '../value-objects/PerpOrder';
import { PerpPosition } from '../entities/PerpPosition';
import { ExecutionLockService } from '../../infrastructure/services/ExecutionLockService';
import { RateLimiterService } from '../../infrastructure/services/RateLimiterService';
import { MarketStateService } from '../../infrastructure/services/MarketStateService';
import { IPerpExchangeAdapter } from '../ports/IPerpExchangeAdapter';

describe('LiquidationMonitorService Stress Tests', () => {
  let service: LiquidationMonitorService;
  let mockMarketState: jest.Mocked<MarketStateService>;
  let mockLockService: jest.Mocked<ExecutionLockService>;
  let mockAdapter: any;

  beforeEach(async () => {
    mockMarketState = {
      getAllPositions: jest.fn(),
      refreshAll: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockLockService = {
      generateThreadId: jest.fn().mockReturnValue('test-thread'),
      tryAcquireSymbolLock: jest.fn().mockReturnValue(true),
      releaseSymbolLock: jest.fn(),
      hasActiveOrder: jest.fn().mockReturnValue(false),
      registerOrderPlacing: jest.fn().mockReturnValue(true),
      updateOrderStatus: jest.fn(),
    } as any;

    mockAdapter = {
      getPositions: jest.fn(),
      getMarkPrice: jest.fn().mockResolvedValue(100),
      placeOrder: jest.fn().mockImplementation((req) => {
        return Promise.resolve(new PerpOrderResponse(
          'emergency-order-id',
          OrderStatus.FILLED,
          req.symbol,
          req.side,
          undefined,
          req.size,
          req.price || 105, // Return a filled price
          undefined,
          new Date()
        ));
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LiquidationMonitorService,
        { provide: MarketStateService, useValue: mockMarketState },
        { provide: ExecutionLockService, useValue: mockLockService },
        { provide: RateLimiterService, useValue: { acquire: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<LiquidationMonitorService>(LiquidationMonitorService);
    
    const adapters = new Map<ExchangeType, IPerpExchangeAdapter>();
    adapters.set(ExchangeType.HYPERLIQUID, mockAdapter);
    adapters.set(ExchangeType.LIGHTER, mockAdapter);
    service.initialize(adapters);

    service.updateConfig({
      emergencyCloseThreshold: 0.80,
      warningThreshold: 0.40,
      enableEmergencyClose: true,
      maxCloseRetries: 1, // Speed up tests
    });
  });

  function createTestPosition(params: {
    symbol: string;
    side: OrderSide;
    leverage: number;
    entryPrice: number;
    markPrice: number;
    exchange: ExchangeType;
  }): PerpPosition {
    const initialBuffer = 1 / params.leverage;
    const maintenanceMargin = 0.015;
    const liqDistance = Math.max(0.01, initialBuffer - maintenanceMargin);
    const liqPrice = params.side === OrderSide.LONG 
      ? params.entryPrice * (1 - liqDistance)
      : params.entryPrice * (1 + liqDistance);

    return new PerpPosition(
      params.exchange,
      params.symbol,
      params.side,
      100,
      params.entryPrice,
      params.markPrice,
      0,
      params.leverage,
      liqPrice,
      1000 / params.leverage
    );
  }

  describe('Survival vs. Planning Decisions', () => {
    it('Scenario 1: Healthy Position (10x, 2% move against) -> Should stay open', async () => {
      const pos = createTestPosition({
        symbol: 'BTC',
        side: OrderSide.LONG,
        leverage: 10,
        entryPrice: 50000,
        markPrice: 49000,
        exchange: ExchangeType.HYPERLIQUID
      });

      mockMarketState.getAllPositions.mockReturnValue([pos]);
      const result = await service.checkLiquidationRisk();

      expect(result.positionsAtRisk).toBe(0);
      expect(result.emergencyClosesTriggered).toBe(0);
    });

    it('Scenario 2: Danger Zone (10x, 7% move against) -> Should trigger EMERGENCY CLOSE at 80% rule', async () => {
      // 10x leverage = 10% buffer. Move is 7% against.
      // With 1.5% maintenance margin, liquidation move is 8.5%.
      // Loss of 7% out of 8.5% = 82% consumption.
      const pos = createTestPosition({
        symbol: 'SOL',
        side: OrderSide.LONG,
        leverage: 10,
        entryPrice: 100,
        markPrice: 93, // 7% drop
        exchange: ExchangeType.HYPERLIQUID
      });

      mockMarketState.getAllPositions.mockReturnValue([pos]);
      const result = await service.checkLiquidationRisk();

      expect(result.positionsAtRisk).toBe(1);
      expect(mockAdapter.placeOrder).toHaveBeenCalled();
    });

    it('Scenario 3: Critical Hit (10x, 9.5% move against) -> Should trigger EMERGENCY CLOSE', async () => {
      const pos = createTestPosition({
        symbol: 'ETH',
        side: OrderSide.LONG,
        leverage: 10,
        entryPrice: 2000,
        markPrice: 1810, // 9.5% drop
        exchange: ExchangeType.HYPERLIQUID
      });

      mockMarketState.getAllPositions.mockReturnValue([pos]);
      const result = await service.checkLiquidationRisk();

      expect(result.positionsAtRisk).toBe(1);
      expect(result.emergencyClosesTriggered).toBe(1);
      expect(mockAdapter.placeOrder).toHaveBeenCalled();
    });

    it('Scenario 6: Hedged Pair - One side at risk -> Should close BOTH legs', async () => {
      const longPos = createTestPosition({
        symbol: 'ARB',
        side: OrderSide.LONG,
        leverage: 10,
        entryPrice: 1.0,
        markPrice: 1.1,
        exchange: ExchangeType.HYPERLIQUID
      });
      const shortPos = createTestPosition({
        symbol: 'ARB',
        side: OrderSide.SHORT,
        leverage: 10,
        entryPrice: 1.0,
        markPrice: 1.1, // Short is 10% against (9% + maintenance margin distance)
        exchange: ExchangeType.LIGHTER
      });

      mockMarketState.getAllPositions.mockReturnValue([longPos, shortPos]);
      const result = await service.checkLiquidationRisk();

      expect(result.emergencyClosesTriggered).toBe(1);
      // Verify that BOTH legs were attempted
      expect(mockAdapter.placeOrder).toHaveBeenCalledTimes(2);
    });

    it('Should capture entry and close prices in the result', async () => {
      const pos = createTestPosition({
        symbol: 'BTC',
        side: OrderSide.LONG,
        leverage: 10,
        entryPrice: 50000,
        markPrice: 40000, // Big drop
        exchange: ExchangeType.HYPERLIQUID
      });

      mockMarketState.getAllPositions.mockReturnValue([pos]);
      const result = await service.checkLiquidationRisk();

      const closeResult = result.emergencyCloses[0];
      expect(closeResult.longEntryPrice).toBe(50000);
      expect(closeResult.longClosePrice).toBeDefined();
      expect(closeResult.longClosePrice).toBeGreaterThan(0);
    });
  });
});
