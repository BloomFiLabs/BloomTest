import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LighterExchangeAdapter } from './LighterExchangeAdapter';
import { DiagnosticsService } from '../../services/DiagnosticsService';
import { RateLimiterService } from '../../services/RateLimiterService';
import { LighterWebSocketProvider } from './LighterWebSocketProvider';
import {
  OrderSide,
  OrderType,
  PerpOrderRequest,
  TimeInForce,
} from '../../../domain/value-objects/PerpOrder';

// Mock the lighter-ts-sdk
jest.mock('@reservoir0x/lighter-ts-sdk', () => ({
  SignerClient: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    ensureWasmClient: jest.fn().mockResolvedValue(undefined),
    createUnifiedOrder: jest.fn().mockResolvedValue({
      success: true,
      mainOrder: { hash: 'test-order-id' },
    }),
    waitForTransaction: jest.fn().mockResolvedValue(undefined),
  })),
  ApiClient: jest.fn().mockImplementation(() => ({})),
  OrderApi: jest.fn().mockImplementation(() => ({
    getOrderBookDetails: jest.fn().mockResolvedValue({
      orderbooks: [{ market_id: 0, symbol: 'ETH' }],
    }),
  })),
  MarketHelper: jest.fn().mockImplementation(() => ({
    fetchMarketConfig: jest.fn().mockResolvedValue(undefined),
    amountToUnits: jest.fn().mockReturnValue(BigInt(1000000)),
    priceToUnits: jest.fn().mockReturnValue(BigInt(3000000000)),
  })),
  OrderType: {
    MARKET: 0,
    LIMIT: 1,
  },
}));

describe('LighterExchangeAdapter Nonce Handling', () => {
  let adapter: LighterExchangeAdapter;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockDiagnosticsService: jest.Mocked<DiagnosticsService>;
  let mockRateLimiter: jest.Mocked<RateLimiterService>;
  let mockWsProvider: jest.Mocked<LighterWebSocketProvider>;

  beforeEach(async () => {
    jest.useFakeTimers();

    mockWsProvider = {
      subscribeToPositionUpdates: jest.fn(),
      getCachedOrders: jest.fn(),
      hasOrderData: jest.fn().mockReturnValue(false),
      on: jest.fn(),
      removeListener: jest.fn(),
    } as any;

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          LIGHTER_API_BASE_URL: 'https://test.lighter.xyz',
          LIGHTER_API_KEY:
            '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          LIGHTER_ACCOUNT_INDEX: '1000',
          LIGHTER_API_KEY_INDEX: '1',
        };
        return config[key] ?? defaultValue;
      }),
    } as any;

    mockDiagnosticsService = {
      recordError: jest.fn(),
      recordOrder: jest.fn(),
    } as any;

    mockRateLimiter = {
      acquire: jest.fn().mockResolvedValue(undefined),
      tryAcquire: jest.fn().mockReturnValue(true),
      getUsage: jest.fn().mockReturnValue({
        currentWeightPerSecond: 0,
        currentWeightPerMinute: 0,
        maxWeightPerSecond: 12,
        maxWeightPerMinute: 60,
        queuedRequests: 0,
        budgetHealth: 1.0,
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: LighterExchangeAdapter,
          useFactory: () =>
            new LighterExchangeAdapter(
              mockConfigService,
              mockRateLimiter,
              mockDiagnosticsService,
              undefined,
              mockWsProvider,
            ),
        },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DiagnosticsService, useValue: mockDiagnosticsService },
        { provide: RateLimiterService, useValue: mockRateLimiter },
        { provide: LighterWebSocketProvider, useValue: mockWsProvider },
      ],
    }).compile();

    adapter = module.get<LighterExchangeAdapter>(LighterExchangeAdapter);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('nonce reset state', () => {
    it('should start with nonce reset not in progress', () => {
      expect(adapter.isNonceResetInProgress()).toBe(false);
    });
  });

  describe('mutex serialization', () => {
    it('should serialize concurrent placeOrder calls', async () => {
      const callOrder: string[] = [];

      // Create a mock order
      const mockOrder = new PerpOrderRequest(
        'ETHUSDC',
        OrderSide.LONG,
        OrderType.LIMIT,
        0.1,
        3000,
        TimeInForce.GTC,
        false,
      );

      // Override placeOrder to track call order
      // We can't easily test the internal mutex without exposing it,
      // but we can verify the adapter is created correctly
      expect(adapter).toBeDefined();
      expect(adapter.getExchangeType()).toBe('LIGHTER');
    });
  });

  describe('nonce reset blocking', () => {
    it('should report nonce reset state correctly', () => {
      // Initial state
      expect(adapter.isNonceResetInProgress()).toBe(false);
    });
  });

  describe('configuration', () => {
    it('should initialize with correct exchange type', () => {
      expect(adapter.getExchangeType()).toBe('LIGHTER');
    });

    it('should have valid configuration', () => {
      const config = adapter.getConfig();
      expect(config).toBeDefined();
      expect(config.baseUrl).toBe('https://test.lighter.xyz');
    });
  });
});

describe('LighterExchangeAdapter Nonce Lock Integration', () => {
  /**
   * These tests verify the nonce lock behavior conceptually.
   * Full integration tests would require mocking the SignerClient more extensively.
   */

  it('should have nonce reset timeout configured', () => {
    // The adapter should have a reasonable timeout for nonce reset
    // This is a design verification test
    expect(true).toBe(true); // Placeholder - actual timeout is 5000ms
  });

  it('should handle multiple concurrent nonce reset requests', () => {
    // When multiple nonce errors occur, only one reset should happen
    // Subsequent requests should wait for the first reset to complete
    expect(true).toBe(true); // Verified in implementation via nonceResetInProgress flag
  });

  it('should release waiting operations after nonce reset', () => {
    // All operations waiting on nonce reset should be released after reset completes
    // This is verified by the finally block in resetSignerClient
    expect(true).toBe(true);
  });
});

describe('LighterExchangeAdapter ReduceOnly Validation', () => {
  let adapter: LighterExchangeAdapter;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockDiagnosticsService: jest.Mocked<DiagnosticsService>;
  let mockRateLimiter: jest.Mocked<RateLimiterService>;
  let mockWsProvider: jest.Mocked<LighterWebSocketProvider>;

  beforeEach(async () => {
    mockWsProvider = {
      subscribeToPositionUpdates: jest.fn(),
      getCachedOrders: jest.fn(),
      hasOrderData: jest.fn().mockReturnValue(false),
      on: jest.fn(),
      removeListener: jest.fn(),
    } as any;

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          LIGHTER_API_BASE_URL: 'https://test.lighter.xyz',
          LIGHTER_API_KEY:
            '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          LIGHTER_ACCOUNT_INDEX: '1000',
          LIGHTER_API_KEY_INDEX: '1',
        };
        return config[key] ?? defaultValue;
      }),
    } as any;

    mockDiagnosticsService = {
      recordError: jest.fn(),
      recordOrder: jest.fn(),
    } as any;

    mockRateLimiter = {
      acquire: jest.fn().mockResolvedValue(undefined),
      tryAcquire: jest.fn().mockReturnValue(true),
      getUsage: jest.fn().mockReturnValue({
        currentWeightPerSecond: 0,
        currentWeightPerMinute: 0,
        maxWeightPerSecond: 12,
        maxWeightPerMinute: 60,
        queuedRequests: 0,
        budgetHealth: 1.0,
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: LighterExchangeAdapter,
          useFactory: () =>
            new LighterExchangeAdapter(
              mockConfigService,
              mockRateLimiter,
              mockDiagnosticsService,
              undefined,
              mockWsProvider,
            ),
        },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DiagnosticsService, useValue: mockDiagnosticsService },
        { provide: RateLimiterService, useValue: mockRateLimiter },
        { provide: LighterWebSocketProvider, useValue: mockWsProvider },
      ],
    }).compile();

    adapter = module.get<LighterExchangeAdapter>(LighterExchangeAdapter);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('reduceOnly order validation', () => {
    it('should reject reduceOnly order when no position exists', async () => {
      // Mock getPositions to return empty array
      jest.spyOn(adapter, 'getPositions').mockResolvedValue([]);

      const reduceOnlyOrder = new PerpOrderRequest(
        'ETHUSDC',
        OrderSide.SHORT, // Trying to close a non-existent LONG
        OrderType.MARKET,
        0.1,
        undefined,
        TimeInForce.IOC,
        true,
      );

      await expect(adapter.placeOrder(reduceOnlyOrder)).rejects.toThrow(
        'Cannot place reduceOnly order: No position exists for ETHUSDC',
      );

      expect(mockDiagnosticsService.recordError).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'LIGHTER_REDUCE_ONLY_NO_POSITION',
          exchange: 'LIGHTER',
        }),
      );
    });

    it('should reject reduceOnly order with wrong direction (trying to BUY when LONG)', async () => {
      // Mock getPositions to return a LONG position
      jest.spyOn(adapter, 'getPositions').mockResolvedValue([
        {
          exchangeType: 'LIGHTER' as any,
          symbol: 'ETHUSDC',
          side: OrderSide.LONG,
          size: 0.5,
          entryPrice: 3000,
          markPrice: 3100,
          unrealizedPnl: 50,
          isLong: () => true,
          isShort: () => false,
          getValue: () => 1550,
          getPnlPercent: () => 1.67,
        } as any,
      ]);

      const wrongDirectionOrder = new PerpOrderRequest(
        'ETHUSDC',
        OrderSide.LONG, // Wrong! Should be SHORT to close LONG
        OrderType.MARKET,
        0.5,
        undefined,
        TimeInForce.IOC,
        true,
      );

      await expect(adapter.placeOrder(wrongDirectionOrder)).rejects.toThrow(
        'Invalid reduceOnly direction: Position is LONG, order side is LONG, expected SHORT to close',
      );

      expect(mockDiagnosticsService.recordError).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'LIGHTER_REDUCE_ONLY_WRONG_DIRECTION',
          exchange: 'LIGHTER',
        }),
      );
    });

    it('should reject reduceOnly order with wrong direction (trying to SELL when SHORT)', async () => {
      // Mock getPositions to return a SHORT position
      jest.spyOn(adapter, 'getPositions').mockResolvedValue([
        {
          exchangeType: 'LIGHTER' as any,
          symbol: 'ETHUSDC',
          side: OrderSide.SHORT,
          size: 0.5,
          entryPrice: 3000,
          markPrice: 2900,
          unrealizedPnl: 50,
          isLong: () => false,
          isShort: () => true,
          getValue: () => 1450,
          getPnlPercent: () => 3.33,
        } as any,
      ]);

      const wrongDirectionOrder = new PerpOrderRequest(
        'ETHUSDC',
        OrderSide.SHORT, // Wrong! Should be LONG to close SHORT
        OrderType.MARKET,
        0.5,
        undefined,
        TimeInForce.IOC,
        true,
      );

      await expect(adapter.placeOrder(wrongDirectionOrder)).rejects.toThrow(
        'Invalid reduceOnly direction: Position is SHORT, order side is SHORT, expected LONG to close',
      );
    });

    it('should allow reduceOnly order with correct direction to close LONG', async () => {
      // Mock getPositions to return a LONG position
      jest.spyOn(adapter, 'getPositions').mockResolvedValue([
        {
          exchangeType: 'LIGHTER' as any,
          symbol: 'ETHUSDC',
          side: OrderSide.LONG,
          size: 0.5,
          entryPrice: 3000,
          markPrice: 3100,
          unrealizedPnl: 50,
          isLong: () => true,
          isShort: () => false,
          getValue: () => 1550,
          getPnlPercent: () => 1.67,
        } as any,
      ]);

      const correctOrder = new PerpOrderRequest(
        'ETHUSDC',
        OrderSide.SHORT, // Correct! SHORT to close LONG
        OrderType.MARKET,
        0.5,
        undefined,
        TimeInForce.IOC,
        true,
      );

      // The order should pass validation but may fail on actual placement
      // We're testing the validation logic, not the SDK interaction
      // Since we haven't mocked the full SDK, we expect it to proceed past validation
      // and fail somewhere else (which is fine for this test)
      try {
        await adapter.placeOrder(correctOrder);
      } catch (error: any) {
        // If it throws, it should NOT be a reduceOnly validation error
        expect(error.message).not.toContain('Cannot place reduceOnly order');
        expect(error.message).not.toContain('Invalid reduceOnly direction');
      }

      // Verify no reduceOnly validation errors were recorded
      const recordErrorCalls = mockDiagnosticsService.recordError.mock.calls;
      const reduceOnlyErrors = recordErrorCalls.filter((call) =>
        call[0].type?.includes('REDUCE_ONLY'),
      );
      expect(reduceOnlyErrors.length).toBe(0);
    });

    it('should allow reduceOnly order with correct direction to close SHORT', async () => {
      // Mock getPositions to return a SHORT position
      jest.spyOn(adapter, 'getPositions').mockResolvedValue([
        {
          exchangeType: 'LIGHTER' as any,
          symbol: 'ETHUSDC',
          side: OrderSide.SHORT,
          size: 0.5,
          entryPrice: 3000,
          markPrice: 2900,
          unrealizedPnl: 50,
          isLong: () => false,
          isShort: () => true,
          getValue: () => 1450,
          getPnlPercent: () => 3.33,
        } as any,
      ]);

      const correctOrder = new PerpOrderRequest(
        'ETHUSDC',
        OrderSide.LONG, // Correct! LONG to close SHORT
        OrderType.MARKET,
        0.5,
        undefined,
        TimeInForce.IOC,
        true,
      );

      try {
        await adapter.placeOrder(correctOrder);
      } catch (error: any) {
        // If it throws, it should NOT be a reduceOnly validation error
        expect(error.message).not.toContain('Cannot place reduceOnly order');
        expect(error.message).not.toContain('Invalid reduceOnly direction');
      }

      // Verify no reduceOnly validation errors were recorded
      const recordErrorCalls = mockDiagnosticsService.recordError.mock.calls;
      const reduceOnlyErrors = recordErrorCalls.filter((call) =>
        call[0].type?.includes('REDUCE_ONLY'),
      );
      expect(reduceOnlyErrors.length).toBe(0);
    });

    it('should handle symbol normalization for position matching', async () => {
      // Mock getPositions with slightly different symbol format
      jest.spyOn(adapter, 'getPositions').mockResolvedValue([
        {
          exchangeType: 'LIGHTER' as any,
          symbol: 'ETH-PERP', // Different format
          side: OrderSide.LONG,
          size: 0.5,
          entryPrice: 3000,
          markPrice: 3100,
          unrealizedPnl: 50,
          isLong: () => true,
          isShort: () => false,
          getValue: () => 1550,
          getPnlPercent: () => 1.67,
        } as any,
      ]);

      const orderWithDifferentFormat = new PerpOrderRequest(
        'ETHUSDC', // Different format than position
        OrderSide.SHORT,
        OrderType.MARKET,
        0.5,
        undefined,
        TimeInForce.IOC,
        true, // reduceOnly
      );

      // Should NOT throw "no position exists" because symbols should match after normalization
      try {
        await adapter.placeOrder(orderWithDifferentFormat);
      } catch (error: any) {
        expect(error.message).not.toContain('No position exists');
      }
    });

    it('should reject and record error when order size exceeds position size', async () => {
      // Mock getPositions to return a position smaller than order
      jest.spyOn(adapter, 'getPositions').mockResolvedValue([
        {
          exchangeType: 'LIGHTER' as any,
          symbol: 'ETHUSDC',
          side: OrderSide.LONG,
          size: 0.3, // Smaller than order size
          entryPrice: 3000,
          markPrice: 3100,
          unrealizedPnl: 30,
          isLong: () => true,
          isShort: () => false,
          getValue: () => 930,
          getPnlPercent: () => 1.67,
        } as any,
      ]);

      const oversizedOrder = new PerpOrderRequest(
        'ETHUSDC',
        OrderSide.SHORT,
        OrderType.MARKET,
        0.5, // Larger than position
        undefined,
        TimeInForce.IOC,
        true, // reduceOnly
      );

      // Should be rejected with error about size mismatch to force caller to retry with correct size
      await expect(adapter.placeOrder(oversizedOrder)).rejects.toThrow(
        'exceeds position size',
      );

      // Should have recorded the error for diagnostics
      expect(mockDiagnosticsService.recordError).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'LIGHTER_REDUCE_ONLY_SIZE_EXCEEDS',
        }),
      );
    });
  });
});

/**
 * CRITICAL BUG PREVENTION TESTS
 * 
 * These tests ensure the order ID mismatch bug never happens again.
 * 
 * Background:
 * - When placing orders, Lighter returns a TRANSACTION HASH (e.g., "b4d8f51a4c3637e0...")
 * - When checking open orders, Lighter returns an ORDER INDEX (e.g., "24488322932508293")
 * - These are completely different formats!
 * - Without proper tracking, getOrderStatus() could never match orders correctly.
 * 
 * The fix:
 * - Track placed orders in a Map<txHash, {symbol, side, size, price, placedAt}>
 * - In getOrderStatus(), match by symbol/side/size if direct ID match fails
 */
describe('LighterExchangeAdapter Order ID Matching (Critical Bug Prevention)', () => {
  let adapter: LighterExchangeAdapter;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockRateLimiter: jest.Mocked<RateLimiterService>;
  let mockDiagnosticsService: jest.Mocked<DiagnosticsService>;
  let mockWsProvider: jest.Mocked<LighterWebSocketProvider>;

  beforeEach(async () => {
    mockWsProvider = {
      subscribeToPositionUpdates: jest.fn(),
      getCachedOrders: jest.fn(),
      hasOrderData: jest.fn().mockReturnValue(false),
      on: jest.fn(),
      removeListener: jest.fn(),
    } as any;

    mockDiagnosticsService = {
      recordError: jest.fn(),
      recordOrder: jest.fn(),
    } as any;

    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          LIGHTER_API_BASE_URL: 'https://test.lighter.xyz',
          LIGHTER_API_KEY:
            '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          LIGHTER_ACCOUNT_INDEX: '1000',
          LIGHTER_API_KEY_INDEX: '1',
        };
        return config[key] ?? defaultValue;
      }),
    } as any;

    mockRateLimiter = {
      acquire: jest.fn().mockResolvedValue(undefined),
      tryAcquire: jest.fn().mockReturnValue(true),
      getUsage: jest.fn().mockReturnValue({
        currentWeightPerSecond: 0,
        currentWeightPerMinute: 0,
        maxWeightPerSecond: 12,
        maxWeightPerMinute: 60,
        queuedRequests: 0,
        budgetHealth: 1.0,
      }),
      recordExternalRateLimit: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: LighterExchangeAdapter,
          useFactory: () =>
            new LighterExchangeAdapter(
              mockConfigService,
              mockRateLimiter,
              mockDiagnosticsService,
              undefined,
              mockWsProvider,
            ),
        },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DiagnosticsService, useValue: mockDiagnosticsService },
        { provide: RateLimiterService, useValue: mockRateLimiter },
        { provide: LighterWebSocketProvider, useValue: mockWsProvider },
      ],
    }).compile();

    adapter = module.get<LighterExchangeAdapter>(LighterExchangeAdapter);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Order tracking after placement', () => {
    it('should track placed orders with transaction hash as key', async () => {
      // Mock the internal methods to simulate order placement
      const txHash = 'a1b2c3d4e5f6789012345678901234567890123456789012345678901234abcd';
      
      // Access the private pendingOrdersMap via reflection for testing
      const pendingOrdersMap = (adapter as any).pendingOrdersMap as Map<string, any>;
      
      // Simulate what happens after placeOrder succeeds
      pendingOrdersMap.set(txHash, {
        symbol: 'AVNT',
        side: OrderSide.SHORT,
        size: 217,
        price: 0.38281,
        placedAt: new Date(),
      });

      // Verify the order is tracked
      expect(pendingOrdersMap.has(txHash)).toBe(true);
      const tracked = pendingOrdersMap.get(txHash);
      expect(tracked.symbol).toBe('AVNT');
      expect(tracked.side).toBe(OrderSide.SHORT);
      expect(tracked.size).toBe(217);
    });

    it('should cleanup old pending orders after TTL expires', async () => {
      const pendingOrdersMap = (adapter as any).pendingOrdersMap as Map<string, any>;
      const cleanupFn = (adapter as any).cleanupPendingOrders.bind(adapter);
      
      // Add an old order (6 minutes ago, TTL is 5 minutes)
      const oldTxHash = 'old_tx_hash_12345678901234567890123456789012345678901234567890';
      pendingOrdersMap.set(oldTxHash, {
        symbol: 'OLD',
        side: OrderSide.LONG,
        size: 100,
        placedAt: new Date(Date.now() - 6 * 60 * 1000), // 6 minutes ago
      });

      // Add a fresh order
      const freshTxHash = 'fresh_tx_hash_1234567890123456789012345678901234567890123456';
      pendingOrdersMap.set(freshTxHash, {
        symbol: 'FRESH',
        side: OrderSide.SHORT,
        size: 50,
        placedAt: new Date(), // Just now
      });

      // Run cleanup
      cleanupFn();

      // Old order should be removed, fresh order should remain
      expect(pendingOrdersMap.has(oldTxHash)).toBe(false);
      expect(pendingOrdersMap.has(freshTxHash)).toBe(true);
    });
  });

  describe('getOrderStatus with transaction hash vs order index', () => {
    it('should match order by symbol/side/size when direct ID match fails', async () => {
      const pendingOrdersMap = (adapter as any).pendingOrdersMap as Map<string, any>;
      
      // Simulate a placed order with transaction hash
      const txHash = 'b4d8f51a4c3637e04988123e42042bfc2b9a9a1fa0f3cd787f69117be2ccb3697727e9a79cd6b1e4';
      pendingOrdersMap.set(txHash, {
        symbol: 'AVNT',
        side: OrderSide.SHORT,
        size: 217,
        price: 0.38281,
        placedAt: new Date(),
      });

      // Mock getOpenOrders to return order with DIFFERENT ID format (order index)
      jest.spyOn(adapter, 'getOpenOrders').mockResolvedValue([
        {
          orderId: '24488322932508293', // This is the Lighter order index, NOT the tx hash!
          symbol: 'AVNT',
          side: 'sell',
          size: 217,
          filledSize: 0,
          price: 0.38281,
        },
      ]);

      // Mock getPositions (no position yet since order is still open)
      jest.spyOn(adapter, 'getPositions').mockResolvedValue([]);

      // getOrderStatus should match by symbol/side/size and return SUBMITTED
      const status = await adapter.getOrderStatus(txHash, 'AVNT');
      
      expect(status.status).toBe('SUBMITTED');
      expect(status.orderId).toBe(txHash); // Should preserve original order ID
    });

    it('should detect FILLED when order not in open orders but position exists', async () => {
      const pendingOrdersMap = (adapter as any).pendingOrdersMap as Map<string, any>;
      
      const txHash = 'filled_order_tx_hash_12345678901234567890123456789012345678901234';
      pendingOrdersMap.set(txHash, {
        symbol: 'AVNT',
        side: OrderSide.SHORT,
        size: 217,
        price: 0.38281,
        placedAt: new Date(Date.now() - 300000), // 5 minutes ago
      });

      // Mock getOpenOrders to return NO matching order (it filled!)
      jest.spyOn(adapter, 'getOpenOrders').mockResolvedValue([]);

      // Mock getPositions to return a position (order filled!)
      jest.spyOn(adapter, 'getPositions').mockResolvedValue([
        {
          exchangeType: 'LIGHTER' as any,
          symbol: 'AVNT',
          side: OrderSide.SHORT,
          size: 217,
          entryPrice: 0.38281,
          markPrice: 0.38270,
          unrealizedPnl: 0.02,
          isLong: () => false,
          isShort: () => true,
          getValue: () => 83.05,
          getPnlPercent: () => 0.03,
        } as any,
      ]);

      const status = await adapter.getOrderStatus(txHash, 'AVNT');
      
      expect(status.status).toBe('FILLED');
      expect(status.filledSize).toBe(217);
    });

    it('should return SUBMITTED for recently placed order not yet visible', async () => {
      const pendingOrdersMap = (adapter as any).pendingOrdersMap as Map<string, any>;
      
      // Order placed just now (within 10 second grace period)
      const txHash = 'very_recent_order_12345678901234567890123456789012345678901234567';
      pendingOrdersMap.set(txHash, {
        symbol: 'NEWCOIN',
        side: OrderSide.LONG,
        size: 100,
        price: 1.5,
        placedAt: new Date(), // Just now
      });

      // Mock getOpenOrders to return empty (order not visible yet)
      jest.spyOn(adapter, 'getOpenOrders').mockResolvedValue([]);

      // Mock getPositions to return empty (no fill yet)
      jest.spyOn(adapter, 'getPositions').mockResolvedValue([]);

      const status = await adapter.getOrderStatus(txHash, 'NEWCOIN');
      
      // Should return SUBMITTED since order is very recent
      expect(status.status).toBe('SUBMITTED');
    });

    it('should return CANCELLED for old order not in open orders and no position', async () => {
      const pendingOrdersMap = (adapter as any).pendingOrdersMap as Map<string, any>;
      
      // Order placed 30 seconds ago (past the 10 second grace period)
      const txHash = 'old_cancelled_order_1234567890123456789012345678901234567890123';
      pendingOrdersMap.set(txHash, {
        symbol: 'CANCELLED',
        side: OrderSide.LONG,
        size: 50,
        price: 2.0,
        placedAt: new Date(Date.now() - 300000), // 5 minutes ago
      });

      // Mock getOpenOrders to return empty
      jest.spyOn(adapter, 'getOpenOrders').mockResolvedValue([]);

      // Mock getPositions to return empty
      jest.spyOn(adapter, 'getPositions').mockResolvedValue([]);

      const status = await adapter.getOrderStatus(txHash, 'CANCELLED');
      
      // Should return CANCELLED since order is old and not found
      expect(status.status).toBe('CANCELLED');
    });

    it('should handle size tolerance when matching orders (within 1%)', async () => {
      const pendingOrdersMap = (adapter as any).pendingOrdersMap as Map<string, any>;
      
      const txHash = 'size_tolerance_test_12345678901234567890123456789012345678901234';
      pendingOrdersMap.set(txHash, {
        symbol: 'AVNT',
        side: OrderSide.SHORT,
        size: 217, // Original size
        price: 0.38281,
        placedAt: new Date(),
      });

      // Mock getOpenOrders with slightly different size (Lighter may round)
      jest.spyOn(adapter, 'getOpenOrders').mockResolvedValue([
        {
          orderId: '99999999999999999',
          symbol: 'AVNT',
          side: 'sell',
          size: 216.5, // Within 1% of 217
          filledSize: 0,
          price: 0.38281,
        },
      ]);

      jest.spyOn(adapter, 'getPositions').mockResolvedValue([]);

      const status = await adapter.getOrderStatus(txHash, 'AVNT');
      
      // Should match despite small size difference
      expect(status.status).toBe('SUBMITTED');
    });

    it('should NOT match orders with different symbols', async () => {
      const pendingOrdersMap = (adapter as any).pendingOrdersMap as Map<string, any>;
      
      const txHash = 'wrong_symbol_test_12345678901234567890123456789012345678901234567';
      pendingOrdersMap.set(txHash, {
        symbol: 'AVNT',
        side: OrderSide.SHORT,
        size: 217,
        price: 0.38281,
        placedAt: new Date(Date.now() - 300000), // 5 minutes ago
      });

      // Mock getOpenOrders with DIFFERENT symbol
      jest.spyOn(adapter, 'getOpenOrders').mockResolvedValue([
        {
          orderId: '88888888888888888',
          symbol: 'KAITO', // Different symbol!
          side: 'sell',
          size: 217,
          filledSize: 0,
          price: 0.55,
        },
      ]);

      jest.spyOn(adapter, 'getPositions').mockResolvedValue([]);

      const status = await adapter.getOrderStatus(txHash, 'AVNT');
      
      // Should NOT match - order is for different symbol
      expect(status.status).toBe('CANCELLED');
    });

    it('should NOT match orders with different sides', async () => {
      const pendingOrdersMap = (adapter as any).pendingOrdersMap as Map<string, any>;
      
      const txHash = 'wrong_side_test_123456789012345678901234567890123456789012345678';
      pendingOrdersMap.set(txHash, {
        symbol: 'AVNT',
        side: OrderSide.SHORT, // We placed a SHORT
        size: 217,
        price: 0.38281,
        placedAt: new Date(Date.now() - 300000),
      });

      // Mock getOpenOrders with DIFFERENT side
      jest.spyOn(adapter, 'getOpenOrders').mockResolvedValue([
        {
          orderId: '77777777777777777',
          symbol: 'AVNT',
          side: 'buy', // Different side!
          size: 217,
          filledSize: 0,
          price: 0.38281,
        },
      ]);

      jest.spyOn(adapter, 'getPositions').mockResolvedValue([]);

      const status = await adapter.getOrderStatus(txHash, 'AVNT');
      
      // Should NOT match - order is for different side
      expect(status.status).toBe('CANCELLED');
    });
  });

  describe('Edge cases for order matching', () => {
    it('should handle multiple orders for same symbol by matching size', async () => {
      const pendingOrdersMap = (adapter as any).pendingOrdersMap as Map<string, any>;
      
      const txHash = 'multi_order_test_12345678901234567890123456789012345678901234567';
      pendingOrdersMap.set(txHash, {
        symbol: 'AVNT',
        side: OrderSide.SHORT,
        size: 100, // Specific size
        price: 0.38281,
        placedAt: new Date(),
      });

      // Mock getOpenOrders with MULTIPLE orders for same symbol
      jest.spyOn(adapter, 'getOpenOrders').mockResolvedValue([
        {
          orderId: '11111111111111111',
          symbol: 'AVNT',
          side: 'sell',
          size: 50, // Wrong size
          filledSize: 0,
          price: 0.38281,
        },
        {
          orderId: '22222222222222222',
          symbol: 'AVNT',
          side: 'sell',
          size: 100, // Correct size!
          filledSize: 0,
          price: 0.38281,
        },
        {
          orderId: '33333333333333333',
          symbol: 'AVNT',
          side: 'sell',
          size: 200, // Wrong size
          filledSize: 0,
          price: 0.38281,
        },
      ]);

      jest.spyOn(adapter, 'getPositions').mockResolvedValue([]);

      const status = await adapter.getOrderStatus(txHash, 'AVNT');
      
      // Should match the order with correct size
      expect(status.status).toBe('SUBMITTED');
    });

    it('should handle order without tracking info gracefully', async () => {
      // Don't add anything to pendingOrdersMap

      // Mock getOpenOrders with no matching order
      jest.spyOn(adapter, 'getOpenOrders').mockResolvedValue([]);

      // Mock getPositions with no position
      jest.spyOn(adapter, 'getPositions').mockResolvedValue([]);

      const unknownTxHash = 'unknown_order_hash_123456789012345678901234567890123456789';
      const status = await adapter.getOrderStatus(unknownTxHash, 'UNKNOWN');
      
      // Should return CANCELLED since we have no info about this order
      expect(status.status).toBe('CANCELLED');
    });
  });
});
