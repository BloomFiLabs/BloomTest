import { Test, TestingModule } from '@nestjs/testing';
import { PerpKeeperOrchestrator } from './PerpKeeperOrchestrator';
import { FundingRateAggregator } from './FundingRateAggregator';
import { FundingArbitrageStrategy } from './FundingArbitrageStrategy';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { Percentage } from '../value-objects/Percentage';
import {
  PerpOrderRequest,
  OrderSide,
  OrderType,
  OrderStatus,
} from '../value-objects/PerpOrder';
import { IPerpExchangeAdapter } from '../ports/IPerpExchangeAdapter';

describe('PerpKeeperOrchestrator', () => {
  let orchestrator: PerpKeeperOrchestrator;
  let mockAggregator: jest.Mocked<FundingRateAggregator>;
  let mockStrategy: jest.Mocked<FundingArbitrageStrategy>;
  let mockAdapters: Map<ExchangeType, jest.Mocked<IPerpExchangeAdapter>>;

  beforeEach(async () => {
    mockAggregator = {
      compareFundingRates: jest.fn(),
      findArbitrageOpportunities: jest.fn(),
      findAllOpportunities: jest.fn(),
    } as any;

    mockStrategy = {
      executeStrategy: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PerpKeeperOrchestrator,
        { provide: FundingRateAggregator, useValue: mockAggregator },
        { provide: FundingArbitrageStrategy, useValue: mockStrategy },
      ],
    }).compile();

    orchestrator = module.get<PerpKeeperOrchestrator>(PerpKeeperOrchestrator);

    // Create mock adapters
    mockAdapters = new Map();
    const adapter = {
      isReady: jest.fn().mockResolvedValue(true),
      testConnection: jest.fn().mockResolvedValue(undefined),
      getPositions: jest.fn().mockResolvedValue([]),
    } as any;

    mockAdapters.set(ExchangeType.ASTER, adapter);
    mockAdapters.set(ExchangeType.LIGHTER, adapter);
    mockAdapters.set(ExchangeType.HYPERLIQUID, adapter);

    orchestrator.initialize(mockAdapters);
  });

  describe('initialize', () => {
    it('should initialize with adapters', () => {
      expect(mockAdapters.size).toBe(3);
    });
  });

  describe('placeAndTrackOrder', () => {
    it('should place and track order', async () => {
      const adapter = mockAdapters.get(ExchangeType.ASTER)!;
      const mockResponse = {
        orderId: 'order123',
        status: OrderStatus.SUBMITTED,
        symbol: 'ETHUSDT',
        side: OrderSide.LONG,
        isSuccess: () => true,
        isFilled: () => false,
        isActive: () => true,
      } as any;
      adapter.placeOrder = jest.fn().mockResolvedValue(mockResponse);

      const request = new PerpOrderRequest(
        'ETHUSDT',
        OrderSide.LONG,
        OrderType.MARKET,
        1.0,
      );

      const result = await orchestrator.placeAndTrackOrder(
        ExchangeType.ASTER,
        request,
      );

      expect(result.order).toBeDefined();
      expect(result.response.orderId).toBe('order123');
    });
  });

  describe('compareFundingRates', () => {
    it('should compare funding rates', async () => {
      mockAggregator.compareFundingRates.mockResolvedValue({
        symbol: 'ETHUSDT',
        rates: [],
        highestRate: null,
        lowestRate: null,
        spread: 0,
        timestamp: new Date(),
      });

      const comparison = await orchestrator.compareFundingRates('ETHUSDT');

      expect(comparison.symbol).toBe('ETHUSDT');
    });
  });

  describe('findArbitrageOpportunities', () => {
    it('should find arbitrage opportunities', async () => {
      mockAggregator.findAllOpportunities.mockResolvedValue([
        {
          symbol: 'ETHUSDT',
          strategyType: 'perp-perp',
          longExchange: ExchangeType.LIGHTER,
          shortExchange: ExchangeType.ASTER,
          longRate: Percentage.fromDecimal(0.0003),
          shortRate: Percentage.fromDecimal(0.0001),
          spread: Percentage.fromDecimal(0.0002),
          expectedReturn: Percentage.fromDecimal(0.219),
          timestamp: new Date(),
        },
      ]);

      const opportunities = await orchestrator.findArbitrageOpportunities([
        'ETHUSDT',
      ]);

      expect(opportunities.length).toBe(1);
    });
  });

  describe('healthCheck', () => {
    it('should check health of all exchanges', async () => {
      const health = await orchestrator.healthCheck();

      expect(health.healthy).toBeDefined();
      expect(health.exchanges).toBeDefined();
    });
  });

  describe('getAllPositionsWithMetrics', () => {
    it('should get positions with aggregated metrics', async () => {
      const adapter = mockAdapters.get(ExchangeType.ASTER)!;
      adapter.getPositions = jest.fn().mockResolvedValue([]);

      const metrics = await orchestrator.getAllPositionsWithMetrics();

      expect(metrics.positions).toBeDefined();
      expect(metrics.totalUnrealizedPnl).toBeDefined();
      expect(metrics.totalPositionValue).toBeDefined();
    });
  });
});
