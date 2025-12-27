import { Test, TestingModule } from '@nestjs/testing';
import { UnifiedExecutionService, UnifiedExecutionResult } from './UnifiedExecutionService';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderStatus,
  OrderSide,
  OrderType,
  TimeInForce,
} from '../../value-objects/PerpOrder';
import { PerpPosition } from '../../entities/PerpPosition';

/**
 * Comprehensive test suite for UnifiedExecutionService
 * 
 * This covers:
 * 1. Sequential execution (Lighter-first logic)
 * 2. Slice calculation and safety limits
 * 3. Fill detection and position delta handling
 * 4. Rollback scenarios
 * 5. Error handling and edge cases
 * 6. Multi-slice execution
 * 7. Partial fills
 * 8. Timeout handling
 */
describe('UnifiedExecutionService', () => {
  let service: UnifiedExecutionService;
  let mockLighterAdapter: jest.Mocked<IPerpExchangeAdapter>;
  let mockHyperliquidAdapter: jest.Mocked<IPerpExchangeAdapter>;

  // Helper to create a filled order response
  const createFilledOrder = (orderId: string, symbol: string, side: OrderSide, size: number, price: number) =>
    new PerpOrderResponse(orderId, OrderStatus.FILLED, symbol, side, undefined, size, price);

  // Helper to create a submitted order response
  const createSubmittedOrder = (orderId: string, symbol: string, side: OrderSide, price: number) =>
    new PerpOrderResponse(orderId, OrderStatus.SUBMITTED, symbol, side, undefined, 0, price);

  // Helper to create a position
  const createPosition = (exchange: ExchangeType, symbol: string, side: OrderSide, size: number, price: number) =>
    new PerpPosition(exchange, symbol, side, size, price, price, 0);

  beforeEach(async () => {
    // Reset all mocks
    jest.clearAllMocks();

    mockLighterAdapter = {
      placeOrder: jest.fn(),
      getOrderStatus: jest.fn(),
      getEquity: jest.fn().mockResolvedValue(5000),
      getPositions: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      getMarkPrice: jest.fn().mockResolvedValue(100),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.LIGHTER),
    } as any;

    mockHyperliquidAdapter = {
      placeOrder: jest.fn(),
      getOrderStatus: jest.fn(),
      getEquity: jest.fn().mockResolvedValue(5000),
      getPositions: jest.fn().mockResolvedValue([]),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      getMarkPrice: jest.fn().mockResolvedValue(100),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.HYPERLIQUID),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [UnifiedExecutionService],
    }).compile();

    service = module.get<UnifiedExecutionService>(UnifiedExecutionService);
    
    // Mock calculateMinimumTimeToFunding to return 1 hour to avoid time pressure reduction in tests
    jest.spyOn(service as any, 'calculateMinimumTimeToFunding').mockReturnValue(3600000);
  });

  // ============================================
  // SECTION 1: Sequential Execution
  // ============================================
  describe('Sequential Execution', () => {
    it('should execute Lighter first when Lighter is the long exchange', async () => {
      const callOrder: string[] = [];

      // Use small order size relative to portfolio to get single slice
      mockLighterAdapter.getEquity.mockResolvedValue(50000);
      mockHyperliquidAdapter.getEquity.mockResolvedValue(50000);

      mockLighterAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('lighter');
        return createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.1, 3000);
      });

      mockHyperliquidAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('hyperliquid');
        return createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.1, 3001);
      });

      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.1, 3000)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.1, 3001)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        0.1, // Small order: $300 << 5% of $100k portfolio
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { 
          minSlices: 1, 
          maxSlices: 1,
          sliceFillTimeoutMs: 2000,
          fillCheckIntervalMs: 50
        }
      );

      expect(result.success).toBe(true);
      // Verify Lighter was called first for each slice
      // Since there might be multiple slices, check the pattern
      for (let i = 0; i < callOrder.length; i += 2) {
        expect(callOrder[i]).toBe('lighter');
        if (i + 1 < callOrder.length) {
          expect(callOrder[i + 1]).toBe('hyperliquid');
        }
      }
    }, 10000);

    it('should execute Lighter first when Lighter is the short exchange', async () => {
      const callOrder: string[] = [];

      // Use small order size relative to portfolio to get single slice
      mockLighterAdapter.getEquity.mockResolvedValue(50000);
      mockHyperliquidAdapter.getEquity.mockResolvedValue(50000);

      mockLighterAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('lighter');
        return createFilledOrder('order-1', 'ETHUSDT', OrderSide.SHORT, 0.1, 3001);
      });

      mockHyperliquidAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('hyperliquid');
        return createFilledOrder('order-2', 'ETHUSDT', OrderSide.LONG, 0.1, 3000);
      });

      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.SHORT, 0.1, 3001)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.LONG, 0.1, 3000)
      );

      const result = await service.executeSmartHedge(
        mockHyperliquidAdapter, // Long adapter
        mockLighterAdapter,     // Short adapter (Lighter)
        'ETHUSDT',
        0.1, // Small order
        3000,
        3001,
        ExchangeType.HYPERLIQUID,
        ExchangeType.LIGHTER,
        { 
          minSlices: 1, 
          maxSlices: 1,
          sliceFillTimeoutMs: 2000,
          fillCheckIntervalMs: 50
        }
      );

      expect(result.success).toBe(true);
      // Lighter (short) should go first for each slice
      for (let i = 0; i < callOrder.length; i += 2) {
        expect(callOrder[i]).toBe('lighter');
        if (i + 1 < callOrder.length) {
          expect(callOrder[i + 1]).toBe('hyperliquid');
        }
      }
    }, 10000);

    it('should NOT place Leg B until Leg A order status is FILLED', async () => {
      const callOrder: string[] = [];

      mockLighterAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('leg-a-placed');
        return createSubmittedOrder('order-1', 'KAITO', OrderSide.SHORT, 0.55);
      });

      // Order stays SUBMITTED (never fills)
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createSubmittedOrder('order-1', 'KAITO', OrderSide.SHORT, 0.55)
      );

      mockHyperliquidAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('leg-b-placed-TOO-EARLY');
        return createFilledOrder('order-2', 'KAITO', OrderSide.LONG, 168.2, 0.55);
      });

      const result = await service.executeSmartHedge(
        mockHyperliquidAdapter,
        mockLighterAdapter,
        'KAITO',
        168.2,
        0.55,
        0.55,
        ExchangeType.HYPERLIQUID,
        ExchangeType.LIGHTER,
        { 
          minSlices: 1, 
          maxSlices: 1,
          sliceFillTimeoutMs: 500,
          fillCheckIntervalMs: 50
        }
      );

      expect(result.success).toBe(false);
      expect(result.abortReason).toContain('Leg A');
      expect(callOrder).not.toContain('leg-b-placed-TOO-EARLY');
      expect(mockHyperliquidAdapter.placeOrder).not.toHaveBeenCalled();
    });

    it('should NOT be fooled by existing positions when checking if order filled', async () => {
      // This is a critical bug fix test
      const callOrder: string[] = [];

      mockLighterAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('leg-a-placed');
        return createSubmittedOrder('order-1', 'KAITO', OrderSide.SHORT, 0.55);
      });

      // There's an existing position from a previous slice
      const existingPosition = createPosition(ExchangeType.LIGHTER, 'KAITO', OrderSide.SHORT, 168.2, 0.55);
      mockLighterAdapter.getPositions.mockResolvedValue([existingPosition]);

      // Order status: Still SUBMITTED (not filled)
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createSubmittedOrder('order-1', 'KAITO', OrderSide.SHORT, 0.55)
      );

      mockHyperliquidAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('leg-b-placed-TOO-EARLY');
        return createFilledOrder('order-2', 'KAITO', OrderSide.LONG, 168.2, 0.55);
      });

      const result = await service.executeSmartHedge(
        mockHyperliquidAdapter,
        mockLighterAdapter,
        'KAITO',
        168.2,
        0.55,
        0.55,
        ExchangeType.HYPERLIQUID,
        ExchangeType.LIGHTER,
        { 
          minSlices: 1, 
          maxSlices: 1,
          sliceFillTimeoutMs: 500,
          fillCheckIntervalMs: 50
        }
      );

      // Should fail because Leg A never filled (even though position exists)
      expect(result.success).toBe(false);
      expect(callOrder).not.toContain('leg-b-placed-TOO-EARLY');
    });
  });

  // ============================================
  // SECTION 2: Slice Calculation
  // ============================================
  describe('Slice Calculation', () => {
    it('should calculate correct number of slices based on portfolio percentage', async () => {
      // Portfolio: $10,000 (5k + 5k)
      // Max slice: $500 (5% of $10,000)
      // Order: $2,500 -> should be 5 slices
      mockLighterAdapter.getEquity.mockResolvedValue(5000);
      mockHyperliquidAdapter.getEquity.mockResolvedValue(5000);

      mockLighterAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.5, 1000)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.5, 1000)
      );
      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.5, 1000)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.5, 1000)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        2.5, // $2,500 at $1000/token
        1000,
        1000,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        {
          maxPortfolioPctPerSlice: 0.05, // 5%
          maxUsdPerSlice: 10000, // High cap so portfolio % is the constraint
          minSlices: 2,
          maxSlices: 20,
          sliceFillTimeoutMs: 1000,
          fillCheckIntervalMs: 50
        }
      );

      // $2,500 / $500 (5% of $10k) = 5 slices
      expect(result.totalSlices).toBe(5);
    }, 30000);

    it('should respect maxUsdPerSlice cap', async () => {
      // Portfolio: $100,000 (50k + 50k)
      // 5% of portfolio = $5,000
      // But maxUsdPerSlice = $1,000
      // Order: $5,000 -> should be 5 slices (limited by maxUsdPerSlice)
      mockLighterAdapter.getEquity.mockResolvedValue(50000);
      mockHyperliquidAdapter.getEquity.mockResolvedValue(50000);

      mockLighterAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.5, 2000)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.5, 2000)
      );
      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.5, 2000)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.5, 2000)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        2.5, // $5,000 at $2000/token
        2000,
        2000,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        {
          maxPortfolioPctPerSlice: 0.05, // 5% = $5,000
          maxUsdPerSlice: 1000, // But capped at $1,000
          minSlices: 2,
          maxSlices: 20,
          sliceFillTimeoutMs: 1000,
          fillCheckIntervalMs: 50
        }
      );

      // $5,000 / $1,000 (maxUsdPerSlice) = 5 slices
      expect(result.totalSlices).toBe(5);
    }, 30000);

    it('should respect minSlices even for small orders', async () => {
      mockLighterAdapter.getEquity.mockResolvedValue(5000);
      mockHyperliquidAdapter.getEquity.mockResolvedValue(5000);

      mockLighterAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.01, 1000)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.01, 1000)
      );
      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.01, 1000)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.01, 1000)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        0.02, // $20 (tiny order)
        1000,
        1000,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        {
          minSlices: 3, // Force at least 3 slices
          maxSlices: 20,
          sliceFillTimeoutMs: 10000 // Use smaller timeout to avoid time pressure reduction in tests
        }
      );

      expect(result.totalSlices).toBe(3);
    });

    it('should respect maxSlices cap when safety allows', async () => {
      // Portfolio: $20,000
      // Order: $1,000 -> needs 1 slice at 5% ($1000 cap)
      // But minSlices = 3 -> should use 3 slices
      // maxSlices = 5 -> should cap at 5 if needed
      mockLighterAdapter.getEquity.mockResolvedValue(10000);
      mockHyperliquidAdapter.getEquity.mockResolvedValue(10000);

      mockLighterAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.33, 100)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.33, 100)
      );
      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.33, 100)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.33, 100)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1, // $100 order with $20k portfolio
        100,
        100,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        {
          maxPortfolioPctPerSlice: 0.05, // 5% = $1000 per slice (order is way under)
          minSlices: 3,
          maxSlices: 5,
          sliceFillTimeoutMs: 1000,
          fillCheckIntervalMs: 50
        }
      );

      // Should use minSlices (3) since order is small, and be capped at maxSlices (5)
      expect(result.totalSlices).toBeGreaterThanOrEqual(3);
      expect(result.totalSlices).toBeLessThanOrEqual(5);
    }, 10000);

    it('should prioritize safety over maxSlices cap', async () => {
      // Portfolio: $2,000
      // Order: $1,000 -> needs 10 slices at 5% ($100 per slice)
      // maxSlices = 5 -> but safety requires 10, so should use 10
      mockLighterAdapter.getEquity.mockResolvedValue(1000);
      mockHyperliquidAdapter.getEquity.mockResolvedValue(1000);

      mockLighterAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 1, 100)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 1, 100)
      );
      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 1, 100)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 1, 100)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        10, // $1000 order with $2000 portfolio (needs 10 slices for safety)
        100,
        100,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        {
          maxPortfolioPctPerSlice: 0.05, // 5% = $100 per slice
          maxSlices: 5, // Would cap at 5, but safety needs 10
          sliceFillTimeoutMs: 1000,
          fillCheckIntervalMs: 50
        }
      );

      // Safety (10 slices) should override maxSlices (5)
      expect(result.totalSlices).toBe(10);
    }, 30000);

    it('should prioritize safety over time constraints', async () => {
      // Portfolio: $2,000
      // Order: $500 -> needs 5 slices for safety (5% = $100 per slice)
      // Time constraint would only allow 2 slices
      // Safety should win
      mockLighterAdapter.getEquity.mockResolvedValue(1000);
      mockHyperliquidAdapter.getEquity.mockResolvedValue(1000);

      mockLighterAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.5, 200)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.5, 200)
      );
      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.5, 200)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.5, 200)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        2.5, // $500 at $200/token
        200,
        200,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        {
          maxPortfolioPctPerSlice: 0.05, // 5% = $100 per slice -> needs 5 slices
          sliceFillTimeoutMs: 100, // Very short timeout
          fundingBufferMs: 0,
        }
      );

      // Should use 5 slices for safety, not fewer due to time
      expect(result.totalSlices).toBeGreaterThanOrEqual(5);
    });
  });

  // ============================================
  // SECTION 3: Fill Detection
  // ============================================
  describe('Fill Detection', () => {
    it('should detect fill when order status changes to FILLED', async () => {
      let checkCount = 0;

      mockLighterAdapter.placeOrder.mockResolvedValue(
        createSubmittedOrder('order-1', 'ETHUSDT', OrderSide.LONG, 3000)
      );

      mockLighterAdapter.getOrderStatus.mockImplementation(async () => {
        checkCount++;
        if (checkCount < 3) {
          return createSubmittedOrder('order-1', 'ETHUSDT', OrderSide.LONG, 3000);
        }
        return createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 1.0, 3000);
      });

      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 1.0, 3001)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 1.0, 3001)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { 
          minSlices: 1, 
          maxSlices: 1,
          fillCheckIntervalMs: 50,
          sliceFillTimeoutMs: 2000
        }
      );

      expect(result.success).toBe(true);
      expect(checkCount).toBeGreaterThanOrEqual(3);
    }, 10000);

    it('should use position delta to calculate fill size when there is existing position', async () => {
      const existingSize = 100;
      const newOrderSize = 50;

      mockLighterAdapter.placeOrder.mockResolvedValue(
        createSubmittedOrder('order-1', 'KAITO', OrderSide.SHORT, 0.55)
      );

      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'KAITO', OrderSide.SHORT, newOrderSize, 0.55)
      );

      // Position increased from 100 to 150
      mockLighterAdapter.getPositions.mockResolvedValue([
        createPosition(ExchangeType.LIGHTER, 'KAITO', OrderSide.SHORT, existingSize + newOrderSize, 0.55)
      ]);

      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'KAITO', OrderSide.LONG, newOrderSize, 0.55)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'KAITO', OrderSide.LONG, newOrderSize, 0.55)
      );

      const result = await service.executeSmartHedge(
        mockHyperliquidAdapter,
        mockLighterAdapter,
        'KAITO',
        newOrderSize,
        0.55,
        0.55,
        ExchangeType.HYPERLIQUID,
        ExchangeType.LIGHTER,
        { minSlices: 1, maxSlices: 1 }
      );

      expect(result.success).toBe(true);
      expect(result.totalShortFilled).toBe(newOrderSize);
    });

    it('should timeout if order never fills', async () => {
      mockLighterAdapter.placeOrder.mockResolvedValue(
        createSubmittedOrder('order-1', 'ETHUSDT', OrderSide.LONG, 3000)
      );

      // Always returns SUBMITTED (never fills)
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createSubmittedOrder('order-1', 'ETHUSDT', OrderSide.LONG, 3000)
      );

      const startTime = Date.now();
      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { 
          minSlices: 1, 
          maxSlices: 1,
          sliceFillTimeoutMs: 500,
          fillCheckIntervalMs: 50
        }
      );
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(false);
      expect(result.abortReason).toContain('never filled');
      expect(elapsed).toBeGreaterThanOrEqual(450); // Should wait for timeout
    });
  });

  // ============================================
  // SECTION 4: Rollback Scenarios
  // ============================================
  describe('Rollback Scenarios', () => {
    it('should rollback Leg A if Leg B placement fails', async () => {
      mockLighterAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 1.0, 3000)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 1.0, 3000)
      );

      // Leg B fails to place
      mockHyperliquidAdapter.placeOrder.mockRejectedValue(new Error('API Error'));

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { minSlices: 1, maxSlices: 1 }
      );

      expect(result.success).toBe(false);
      // Should have placed rollback order (SHORT to close LONG)
      expect(mockLighterAdapter.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          side: OrderSide.SHORT,
          type: OrderType.MARKET,
          reduceOnly: true
        })
      );
    });

    it('should rollback Leg A if Leg B times out without filling', async () => {
      let placeOrderCalls = 0;
      mockLighterAdapter.placeOrder.mockImplementation(async (order: PerpOrderRequest) => {
        placeOrderCalls++;
        if (placeOrderCalls === 1) {
          // First call: Leg A placement
          return createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 1.0, 3000);
        } else {
          // Second call: Rollback
          return createFilledOrder('rollback', 'ETHUSDT', OrderSide.SHORT, 1.0, 3000);
        }
      });
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 1.0, 3000)
      );

      // Leg B placed but never fills
      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createSubmittedOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 3001)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createSubmittedOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 3001)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { 
          minSlices: 1, 
          maxSlices: 1,
          sliceFillTimeoutMs: 500,
          fillCheckIntervalMs: 50
        }
      );

      expect(result.success).toBe(false);
      // Should have placed rollback order (2 calls: original + rollback)
      expect(placeOrderCalls).toBe(2);
    });

    it('should cancel unfilled Leg A order on timeout', async () => {
      mockLighterAdapter.placeOrder.mockResolvedValue(
        createSubmittedOrder('order-1', 'ETHUSDT', OrderSide.LONG, 3000)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createSubmittedOrder('order-1', 'ETHUSDT', OrderSide.LONG, 3000)
      );

      await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { 
          minSlices: 1, 
          maxSlices: 1,
          sliceFillTimeoutMs: 500,
          fillCheckIntervalMs: 50
        }
      );

      // Should cancel the unfilled order
      expect(mockLighterAdapter.cancelOrder).toHaveBeenCalledWith('order-1', 'ETHUSDT');
    });
  });

  // ============================================
  // SECTION 5: Multi-Slice Execution
  // ============================================
  describe('Multi-Slice Execution', () => {
    it('should execute multiple slices sequentially', async () => {
      const slicesFilled: number[] = [];

      mockLighterAdapter.getEquity.mockResolvedValue(500);
      mockHyperliquidAdapter.getEquity.mockResolvedValue(500);

      let orderCount = 0;
      mockLighterAdapter.placeOrder.mockImplementation(async (order: PerpOrderRequest) => {
        orderCount++;
        slicesFilled.push(order.size);
        return createFilledOrder(`order-${orderCount}`, 'ETHUSDT', OrderSide.LONG, order.size, 100);
      });
      mockLighterAdapter.getOrderStatus.mockImplementation(async () => {
        return createFilledOrder(`order-${orderCount}`, 'ETHUSDT', OrderSide.LONG, slicesFilled[slicesFilled.length - 1], 100);
      });

      mockHyperliquidAdapter.placeOrder.mockImplementation(async (order: PerpOrderRequest) => {
        return createFilledOrder(`order-hl-${orderCount}`, 'ETHUSDT', OrderSide.SHORT, order.size, 100);
      });
      mockHyperliquidAdapter.getOrderStatus.mockImplementation(async () => {
        return createFilledOrder(`order-hl-${orderCount}`, 'ETHUSDT', OrderSide.SHORT, slicesFilled[slicesFilled.length - 1], 100);
      });

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0, // $100 order with $1000 portfolio -> 2 slices (5% = $50 per slice)
        100,
        100,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        {
          maxPortfolioPctPerSlice: 0.05,
          minSlices: 2
        }
      );

      expect(result.success).toBe(true);
      expect(result.totalSlices).toBeGreaterThanOrEqual(2);
      expect(result.completedSlices).toBe(result.totalSlices);
      expect(slicesFilled.length).toBe(result.totalSlices);
    });

    it('should stop execution if a slice fails and report partial completion', async () => {
      mockLighterAdapter.getEquity.mockResolvedValue(500);
      mockHyperliquidAdapter.getEquity.mockResolvedValue(500);

      let sliceCount = 0;
      let currentOrderId = '';
      
      mockLighterAdapter.placeOrder.mockImplementation(async (order: PerpOrderRequest) => {
        if (order.reduceOnly) {
          // Rollback order
          return createFilledOrder('rollback', 'ETHUSDT', order.side, order.size, 100);
        }
        sliceCount++;
        currentOrderId = `order-${sliceCount}`;
        if (sliceCount <= 2) {
          // First 2 slices succeed immediately
          return createFilledOrder(currentOrderId, 'ETHUSDT', OrderSide.LONG, order.size, 100);
        }
        // Third slice: placed but won't fill
        return createSubmittedOrder(currentOrderId, 'ETHUSDT', OrderSide.LONG, 100);
      });
      
      mockLighterAdapter.getOrderStatus.mockImplementation(async (orderId: string) => {
        // Extract slice number from order ID
        const match = orderId.match(/order-(\d+)/);
        const orderSlice = match ? parseInt(match[1]) : 0;
        
        if (orderSlice <= 2) {
          return createFilledOrder(orderId, 'ETHUSDT', OrderSide.LONG, 0.25, 100);
        }
        // Third slice never fills
        return createSubmittedOrder(orderId, 'ETHUSDT', OrderSide.LONG, 100);
      });

      mockHyperliquidAdapter.placeOrder.mockImplementation(async (order: PerpOrderRequest) => {
        return createFilledOrder(`order-hl-${sliceCount}`, 'ETHUSDT', OrderSide.SHORT, order.size, 100);
      });
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-hl', 'ETHUSDT', OrderSide.SHORT, 0.25, 100)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        100,
        100,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        {
          maxPortfolioPctPerSlice: 0.05,
          minSlices: 4,
          maxSlices: 4,
          sliceFillTimeoutMs: 2000, // Need >500ms due to initial delay in waitForFill
          fillCheckIntervalMs: 50
        }
      );

      expect(result.success).toBe(false);
      expect(result.completedSlices).toBe(2);
      expect(result.totalSlices).toBe(4);
      expect(result.abortReason).toContain('Leg A');
      expect(result.sliceResults.length).toBe(3); // 2 successful + 1 failed
    }, 20000);

    it('should track cumulative fill sizes across slices', async () => {
      mockLighterAdapter.getEquity.mockResolvedValue(500);
      mockHyperliquidAdapter.getEquity.mockResolvedValue(500);

      const sliceSize = 0.5;
      mockLighterAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, sliceSize, 100)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, sliceSize, 100)
      );
      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, sliceSize, 100)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, sliceSize, 100)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        100,
        100,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        {
          minSlices: 2,
          maxSlices: 2
        }
      );

      expect(result.success).toBe(true);
      expect(result.totalLongFilled).toBe(1.0); // 0.5 * 2 slices
      expect(result.totalShortFilled).toBe(1.0);
    });
  });

  // ============================================
  // SECTION 6: Error Handling
  // ============================================
  describe('Error Handling', () => {
    it('should handle equity fetch failure gracefully', async () => {
      mockLighterAdapter.getEquity.mockRejectedValue(new Error('Network error'));
      mockHyperliquidAdapter.getEquity.mockRejectedValue(new Error('Network error'));

      mockLighterAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 1.0, 3000)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 1.0, 3000)
      );
      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 1.0, 3001)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 1.0, 3001)
      );

      // Should still execute with fallback behavior
      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { minSlices: 1, maxSlices: 1 }
      );

      // Should succeed with default slice calculation
      expect(result).toBeDefined();
    });

    it('should handle order status check failure gracefully', async () => {
      mockLighterAdapter.placeOrder.mockResolvedValue(
        createSubmittedOrder('order-1', 'ETHUSDT', OrderSide.LONG, 3000)
      );

      let checkCount = 0;
      mockLighterAdapter.getOrderStatus.mockImplementation(async () => {
        checkCount++;
        if (checkCount < 3) {
          throw new Error('Network error');
        }
        return createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 1.0, 3000);
      });

      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 1.0, 3001)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 1.0, 3001)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { 
          minSlices: 1, 
          maxSlices: 1,
          fillCheckIntervalMs: 50,
          sliceFillTimeoutMs: 2000
        }
      );

      // Should retry and eventually succeed
      expect(result.success).toBe(true);
      expect(checkCount).toBeGreaterThanOrEqual(3);
    }, 10000);

    it('should handle Leg A placement failure', async () => {
      mockLighterAdapter.placeOrder.mockRejectedValue(new Error('Insufficient margin'));

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { minSlices: 1, maxSlices: 1 }
      );

      expect(result.success).toBe(false);
      // Leg B should never have been called
      expect(mockHyperliquidAdapter.placeOrder).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // SECTION 7: Edge Cases
  // ============================================
  describe('Edge Cases', () => {
    it('should handle zero-size order gracefully', async () => {
      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        0, // Zero size
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { minSlices: 1, maxSlices: 1 }
      );

      // Should not place any orders
      expect(mockLighterAdapter.placeOrder).not.toHaveBeenCalled();
    });

    it('should handle very small order that results in tiny slices', async () => {
      mockLighterAdapter.getEquity.mockResolvedValue(100000);
      mockHyperliquidAdapter.getEquity.mockResolvedValue(100000);

      mockLighterAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.001, 3000)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 0.001, 3000)
      );
      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.001, 3001)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.001, 3001)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        0.001, // $3 order
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { minSlices: 2 }
      );

      expect(result.success).toBe(true);
    });

    it('should handle same exchange for both sides', async () => {
      const callOrder: string[] = [];

      // Use small order to ensure single slice
      mockLighterAdapter.getEquity.mockResolvedValue(50000);

      mockLighterAdapter.placeOrder.mockImplementation(async (order: PerpOrderRequest) => {
        callOrder.push(order.side === OrderSide.LONG ? 'long' : 'short');
        return createFilledOrder('order', 'ETHUSDT', order.side, 0.1, 3000);
      });
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order', 'ETHUSDT', OrderSide.LONG, 0.1, 3000)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockLighterAdapter, // Same adapter for both
        'ETHUSDT',
        0.1, // Small order
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.LIGHTER,
        { 
          minSlices: 1, 
          maxSlices: 1,
          sliceFillTimeoutMs: 2000,
          fillCheckIntervalMs: 50
        }
      );

      expect(result.success).toBe(true);
      // Should still execute sequentially (pairs of long/short per slice)
      expect(callOrder.length % 2).toBe(0); // Even number of calls
    }, 10000);

    it('should handle order that gets rejected', async () => {
      mockLighterAdapter.placeOrder.mockResolvedValue(
        new PerpOrderResponse('order-1', OrderStatus.REJECTED, 'ETHUSDT', OrderSide.LONG, undefined, 0, 3000, 'Price too far from mark')
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { minSlices: 1, maxSlices: 1 }
      );

      expect(result.success).toBe(false);
      expect(mockHyperliquidAdapter.placeOrder).not.toHaveBeenCalled();
    });

    it('should handle order that gets cancelled externally', async () => {
      mockLighterAdapter.placeOrder.mockResolvedValue(
        createSubmittedOrder('order-1', 'ETHUSDT', OrderSide.LONG, 3000)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        new PerpOrderResponse('order-1', OrderStatus.CANCELLED, 'ETHUSDT', OrderSide.LONG, undefined, 0, 3000)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { 
          minSlices: 1, 
          maxSlices: 1,
          sliceFillTimeoutMs: 500,
          fillCheckIntervalMs: 50
        }
      );

      expect(result.success).toBe(false);
      expect(mockHyperliquidAdapter.placeOrder).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // SECTION 8: Imbalance Detection
  // ============================================
  describe('Imbalance Detection', () => {
    it('should detect and report imbalance when fills differ', async () => {
      mockLighterAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 1.0, 3000)
      );
      mockLighterAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-1', 'ETHUSDT', OrderSide.LONG, 1.0, 3000)
      );

      // Leg B only partially fills
      mockHyperliquidAdapter.placeOrder.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.5, 3001)
      );
      mockHyperliquidAdapter.getOrderStatus.mockResolvedValue(
        createFilledOrder('order-2', 'ETHUSDT', OrderSide.SHORT, 0.5, 3001)
      );

      const result = await service.executeSmartHedge(
        mockLighterAdapter,
        mockHyperliquidAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { 
          minSlices: 1, 
          maxSlices: 1,
          sliceFillTimeoutMs: 2000,
          fillCheckIntervalMs: 50
        }
      );

      // Imbalance was detected and handled via rollback
      // The slice results should show the original imbalance
      expect(result.sliceResults.length).toBeGreaterThan(0);
      const slice = result.sliceResults[0];
      expect(slice.longFilledSize).toBe(1.0);  // Leg A filled fully
      expect(slice.shortFilledSize).toBe(0.5); // Leg B only partially filled
      
      // After rollback, the totals should be balanced
      expect(result.totalLongFilled).toBe(result.totalShortFilled);
    }, 10000);
  });
});
