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

describe('UnifiedExecutionService', () => {
  let service: UnifiedExecutionService;
  let mockLongAdapter: jest.Mocked<IPerpExchangeAdapter>;
  let mockShortAdapter: jest.Mocked<IPerpExchangeAdapter>;

  beforeEach(async () => {
    mockLongAdapter = {
      placeOrder: jest.fn(),
      getOrderStatus: jest.fn(),
      getEquity: jest.fn().mockResolvedValue(10000),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      getMarkPrice: jest.fn().mockResolvedValue(3000),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.LIGHTER),
    } as any;

    mockShortAdapter = {
      placeOrder: jest.fn(),
      getOrderStatus: jest.fn(),
      getEquity: jest.fn().mockResolvedValue(10000),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      getMarkPrice: jest.fn().mockResolvedValue(3001),
      getExchangeType: jest.fn().mockReturnValue(ExchangeType.HYPERLIQUID),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [UnifiedExecutionService],
    }).compile();

    service = module.get<UnifiedExecutionService>(UnifiedExecutionService);
  });

  describe('executeSmartHedge', () => {
    it('should execute sequentially when one exchange is Lighter (Lighter first)', async () => {
      const callOrder: string[] = [];

      mockLongAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('lighter-start');
        return new PerpOrderResponse('order-long', OrderStatus.FILLED, 'ETHUSDT', OrderSide.LONG, undefined, 1.0, 3000);
      });

      mockShortAdapter.placeOrder.mockImplementation(async () => {
        callOrder.push('other-start');
        return new PerpOrderResponse('order-short', OrderStatus.FILLED, 'ETHUSDT', OrderSide.SHORT, undefined, 1.0, 3001);
      });

      // Mock status checks for immediate fill
      mockLongAdapter.getOrderStatus.mockResolvedValue(new PerpOrderResponse('order-long', OrderStatus.FILLED, 'ETHUSDT', OrderSide.LONG, undefined, 1.0, 3000));
      mockShortAdapter.getOrderStatus.mockResolvedValue(new PerpOrderResponse('order-short', OrderStatus.FILLED, 'ETHUSDT', OrderSide.SHORT, undefined, 1.0, 3001));

      const result = await service.executeSmartHedge(
        mockLongAdapter,
        mockShortAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { minSlices: 1, maxSlices: 1 } // Single slice for simplicity
      );

      expect(result.success).toBe(true);
      expect(callOrder).toEqual(['lighter-start', 'other-start']);
    });

    it('should rollback if first leg fills but second fails', async () => {
      // Leg A (Lighter) succeeds
      mockLongAdapter.placeOrder.mockResolvedValue(new PerpOrderResponse('order-long', OrderStatus.FILLED, 'ETHUSDT', OrderSide.LONG, undefined, 1.0, 3000));
      mockLongAdapter.getOrderStatus.mockResolvedValue(new PerpOrderResponse('order-long', OrderStatus.FILLED, 'ETHUSDT', OrderSide.LONG, undefined, 1.0, 3000));

      // Leg B fails
      mockShortAdapter.placeOrder.mockRejectedValue(new Error('API Error'));

      const result = await service.executeSmartHedge(
        mockLongAdapter,
        mockShortAdapter,
        'ETHUSDT',
        1.0,
        3000,
        3001,
        ExchangeType.LIGHTER,
        ExchangeType.HYPERLIQUID,
        { minSlices: 1, maxSlices: 1 }
      );

      expect(result.success).toBe(false);
      // Verify rollback call on Leg A (placing a SHORT to close the LONG)
      expect(mockLongAdapter.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
        side: OrderSide.SHORT,
        type: OrderType.MARKET
      }));
    });
  });
});

