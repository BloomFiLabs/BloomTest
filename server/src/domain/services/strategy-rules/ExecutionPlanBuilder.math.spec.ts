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
import { Percentage } from '../../value-objects/Percentage';

describe('ExecutionPlanBuilder Mathematical Validation', () => {
  let builder: ExecutionPlanBuilder;
  let costCalculator: CostCalculator;
  let mockAggregator: jest.Mocked<FundingRateAggregator>;
  let mockHistoricalService: any;
  let mockAdapters: Map<ExchangeType, jest.Mocked<IPerpExchangeAdapter>>;
  let config: StrategyConfig;

  beforeEach(async () => {
    config = StrategyConfig.withDefaults();

    mockAggregator = {
      getExchangeSymbol: jest.fn(
        (symbol: string, exchange: ExchangeType) => symbol,
      ),
    } as any;

    mockHistoricalService = {
      getHistoricalFundingRates: jest.fn().mockResolvedValue([]),
    };

    mockAdapters = new Map();
    const hlAdapter = {
      getMarkPrice: jest.fn().mockResolvedValue(100),
      getBestBidAsk: jest.fn().mockResolvedValue({
        bestBid: 99.99,
        bestAsk: 100.01,
      }),
    } as any;

    const lighterAdapter = {
      getMarkPrice: jest.fn().mockResolvedValue(100),
      getBestBidAsk: jest.fn().mockResolvedValue({
        bestBid: 99.99,
        bestAsk: 100.01,
      }),
    } as any;

    mockAdapters.set(ExchangeType.HYPERLIQUID, hlAdapter);
    mockAdapters.set(ExchangeType.LIGHTER, lighterAdapter);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutionPlanBuilder,
        CostCalculator, // Use REAL CostCalculator
        { provide: FundingRateAggregator, useValue: mockAggregator },
        {
          provide: 'IHistoricalFundingRateService',
          useValue: mockHistoricalService,
        },
        { provide: StrategyConfig, useValue: config },
      ],
    }).compile();

    builder = module.get<ExecutionPlanBuilder>(ExecutionPlanBuilder);
    costCalculator = module.get<CostCalculator>(CostCalculator);
  });

  describe('Funding Rate Impact Math', () => {
    it('should correctly predict funding rate impact as a positive shift', async () => {
      // Scenario:
      // Long Exchange (HL): Funding Rate is -0.01% (Shorts pay Longs)
      // If we add a LONG position on HL, the funding rate should increase (become less negative).
      
      const impact = costCalculator.predictFundingRateImpact(1000, 1000000, -0.0001);
      
      // Impact should be positive shift of 0.1 bps per 1% of OI
      // Ratio = 1000 / 1000000 = 0.001 (0.1% of OI)
      // Impact = 0.001 * 0.001 (basisPointImpact) = 0.000001 (0.1 bps)
      expect(impact).toBeGreaterThan(0);
      expect(impact).toBe(0.000001);
    });
  });

  describe('Position Sizing Math', () => {
    it('should correctly scale position size based on available capital and leverage', async () => {
      const opportunity: ArbitrageOpportunity = {
        symbol: 'TEST',
        strategyType: 'perp-perp',
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        longRate: Percentage.fromDecimal(0.0001),
        shortRate: Percentage.fromDecimal(0.0005),
        spread: Percentage.fromDecimal(0.0004),
        expectedReturn: Percentage.fromDecimal(3.504), // 350% APY
        longMarkPrice: 100,
        shortMarkPrice: 100,
        longOpenInterest: 10000000,
        shortOpenInterest: 10000000,
        long24hVolume: 10000000,
        short24hVolume: 10000000,
        timestamp: new Date(),
      };

      // Balances: $1000 on each
      // Config: 90% usage, 2x leverage
      // Available per exchange: $1000 * 0.9 = $900
      // Leveraged per exchange: $900 * 2 = $1800
      // Position size should be $1800
      
      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 1000, shortBalance: 1000 },
        config,
      );

      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const plan = result.value;
        const positionSizeUsd = plan.positionSize.toUSD(100);
        expect(positionSizeUsd).toBeCloseTo(1800, 0);
      }
    });
  });

  describe('Price Discrepancy Math', () => {
    it('should respect per-exchange balance limits when prices differ significantly', async () => {
      // Scenario:
      // HL Price: $100
      // Lighter Price: $101 (1% difference - within basis risk limit but still tests balance limits)
      // Balance: $1000 on each
      // Leverage: 1x, Usage: 90% (default)
      // Basis: ((101-100)/((100+101)/2)) * 10000 = 99.5 bps < 300 bps limit ✓
      
      const opportunity: ArbitrageOpportunity = {
        symbol: 'TEST',
        strategyType: 'perp-perp',
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        longRate: Percentage.fromDecimal(0.0001),
        shortRate: Percentage.fromDecimal(0.0005),
        spread: Percentage.fromDecimal(0.0004),
        expectedReturn: Percentage.fromDecimal(3.504),
        longMarkPrice: 100,
        shortMarkPrice: 101,
        longOpenInterest: 10000000,
        shortOpenInterest: 10000000,
        long24hVolume: 10000000,
        short24hVolume: 10000000,
        timestamp: new Date(),
      };

      // Mock prices
      (mockAdapters.get(ExchangeType.HYPERLIQUID)!.getMarkPrice as jest.Mock).mockResolvedValue(100);
      (mockAdapters.get(ExchangeType.LIGHTER)!.getMarkPrice as jest.Mock).mockResolvedValue(101);

      // Create custom config with 1x leverage
      const customConfig = StrategyConfig.withDefaults(1.0);
      
      // Available per exchange: $1000 * 0.9 (default) = $900.
      // Leveraged: $900 * 1.0 = $900 USD notional limit.
      
      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 1000, shortBalance: 1000 },
        customConfig,
      );

      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        const plan = result.value;
        
        // Limits:
        // HL Max Units = $900 / 100 = 9 units
        // Lighter Max Units = $900 / 101 = 8.91 units
        // Resulting size should be limited by Lighter (8.91 units).
        
        // The position size should be constrained by the exchange with the higher price
        expect(plan.longOrder.size).toBeGreaterThan(0);
        expect(plan.shortOrder.size).toBeGreaterThan(0);
        
        // Both orders should have the same size (hedged)
        expect(plan.longOrder.size).toBeCloseTo(plan.shortOrder.size, 1);
        
        // Final notional on HL: size * 100 <= $900
        // Final notional on Lighter: size * 101 <= $900
        expect(plan.longOrder.size * 100).toBeLessThanOrEqual(901);
        expect(plan.shortOrder.size * 101).toBeLessThanOrEqual(901);
      }
    });
  });

  describe('Profitability Math', () => {
    it('should reject opportunity if spread is too small to cover costs within 7 days', async () => {
      // Spread: 2% APY = 0.00000228 per hour
      // Costs: Entry HL (0.02%) + Exit HL (0.02%) + Slippage (0.02% total) = 0.06% = 0.0006
      // Break-even hours = 0.0006 / 0.00000228 = 263 hours
      // 263 hours > 168 hours (7 days) -> REJECT
      
      const opportunity: ArbitrageOpportunity = {
        symbol: 'TEST',
        strategyType: 'perp-perp',
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        longRate: Percentage.fromDecimal(0.0001),
        shortRate: Percentage.fromDecimal(0.00010228), // 0.0228 bps spread per hour
        spread: Percentage.fromDecimal(0.00000228),
        expectedReturn: Percentage.fromDecimal(0.02), // 2% APY
        longMarkPrice: 100,
        shortMarkPrice: 100,
        longOpenInterest: 10000000,
        shortOpenInterest: 10000000,
        long24hVolume: 10000000,
        short24hVolume: 10000000,
        timestamp: new Date(),
      };

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 10000, shortBalance: 10000 },
        config,
      );

      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        expect(result.error.message).toContain('break-even');
      }
    });

    it('should accept opportunity if spread covers costs within 7 days', async () => {
      // Same costs: 0.06%
      // Spread: 10% APY = 0.0000114 per hour
      // Break-even hours = 0.0006 / 0.0000114 = 52 hours
      // 52 hours < 168 hours (7 days) -> ACCEPT
      
      const opportunity: ArbitrageOpportunity = {
        symbol: 'TEST',
        strategyType: 'perp-perp',
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        longRate: Percentage.fromDecimal(0.0001),
        shortRate: Percentage.fromDecimal(0.0001114),
        spread: Percentage.fromDecimal(0.0000114),
        expectedReturn: Percentage.fromDecimal(0.1), // 10% APY
        longMarkPrice: 100,
        shortMarkPrice: 100,
        longOpenInterest: 10000000,
        shortOpenInterest: 10000000,
        long24hVolume: 10000000,
        short24hVolume: 10000000,
        timestamp: new Date(),
      };

      const result = await builder.buildPlan(
        opportunity,
        mockAdapters,
        { longBalance: 10000, shortBalance: 10000 },
        config,
      );

      expect(result.isSuccess).toBe(true);
    });
  });
});
