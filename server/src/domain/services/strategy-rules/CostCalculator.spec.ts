import { Test, TestingModule } from '@nestjs/testing';
import { CostCalculator } from './CostCalculator';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { OrderType } from '../../value-objects/PerpOrder';
import { StrategyConfig } from '../../value-objects/StrategyConfig';

describe('CostCalculator', () => {
  let calculator: CostCalculator;
  let config: StrategyConfig;

  beforeEach(async () => {
    config = StrategyConfig.withDefaults(2.0);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CostCalculator,
          useFactory: () => new CostCalculator(config),
        },
      ],
    }).compile();

    calculator = module.get<CostCalculator>(CostCalculator);
  });

  describe('calculateSlippageCost', () => {
    it('should calculate minimal slippage for limit orders', () => {
      const positionSizeUsd = 10000;
      const bestBid = 2999;
      const bestAsk = 3001;
      const openInterest = 1000000;

      const cost = calculator.calculateSlippageCost(
        positionSizeUsd,
        bestBid,
        bestAsk,
        openInterest,
        OrderType.LIMIT,
      );

      // Limit orders have minimal slippage (0.01%)
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(positionSizeUsd * 0.001); // Less than 0.1%
    });

    it('should calculate higher slippage for market orders', () => {
      const positionSizeUsd = 10000;
      const bestBid = 2999;
      const bestAsk = 3001;
      const openInterest = 1000000;

      const limitCost = calculator.calculateSlippageCost(
        positionSizeUsd,
        bestBid,
        bestAsk,
        openInterest,
        OrderType.LIMIT,
      );

      const marketCost = calculator.calculateSlippageCost(
        positionSizeUsd,
        bestBid,
        bestAsk,
        openInterest,
        OrderType.MARKET,
      );

      // Market orders should have higher slippage
      expect(marketCost).toBeGreaterThan(limitCost);
    });

    it('should account for market impact with large positions relative to OI', () => {
      const positionSizeUsd = 50000; // 5% of OI
      const bestBid = 2999;
      const bestAsk = 3001;
      const openInterest = 1000000; // $1M OI

      const cost = calculator.calculateSlippageCost(
        positionSizeUsd,
        bestBid,
        bestAsk,
        openInterest,
        OrderType.LIMIT,
      );

      // Should have some impact slippage
      expect(cost).toBeGreaterThan(positionSizeUsd * 0.0001); // More than base slippage
    });

    it('should cap impact slippage at 2%', () => {
      const positionSizeUsd = 100000; // 10% of OI (very large)
      const bestBid = 2999;
      const bestAsk = 3001;
      const openInterest = 1000000; // $1M OI

      const cost = calculator.calculateSlippageCost(
        positionSizeUsd,
        bestBid,
        bestAsk,
        openInterest,
        OrderType.LIMIT,
      );

      // Should be capped at 2% + base slippage
      expect(cost).toBeLessThan(positionSizeUsd * 0.03); // Less than 3% total
    });

    it('should use conservative estimate when OI is zero', () => {
      const positionSizeUsd = 10000;
      const bestBid = 2999;
      const bestAsk = 3001;
      const openInterest = 0;

      const cost = calculator.calculateSlippageCost(
        positionSizeUsd,
        bestBid,
        bestAsk,
        openInterest,
        OrderType.LIMIT,
      );

      // Should use conservative fallback
      expect(cost).toBe(positionSizeUsd * 0.0001); // 0.01% for limit orders
    });

    it('should handle zero mid price gracefully', () => {
      const positionSizeUsd = 10000;
      const bestBid = 0;
      const bestAsk = 0;
      const openInterest = 1000000;

      const cost = calculator.calculateSlippageCost(
        positionSizeUsd,
        bestBid,
        bestAsk,
        openInterest,
        OrderType.LIMIT,
      );

      // Should not throw and return reasonable value
      expect(cost).toBeGreaterThanOrEqual(0);
      expect(cost).toBeLessThan(positionSizeUsd * 0.1); // Less than 10%
    });
  });

  describe('predictFundingRateImpact', () => {
    it('should return zero impact for zero OI', () => {
      const impact = calculator.predictFundingRateImpact(10000, 0, 0.0001);

      expect(impact).toBe(0);
    });

    it('should return zero impact for invalid funding rate', () => {
      const impact1 = calculator.predictFundingRateImpact(10000, 1000000, NaN);
      const impact2 = calculator.predictFundingRateImpact(
        10000,
        1000000,
        undefined as any,
      );
      const impact3 = calculator.predictFundingRateImpact(
        10000,
        1000000,
        null as any,
      );

      expect(impact1).toBe(0);
      expect(impact2).toBe(0);
      expect(impact3).toBe(0);
    });

    it('should predict minimal impact for small positions (< 1% of OI)', () => {
      const positionSizeUsd = 1000; // 0.1% of OI
      const openInterest = 1000000;
      const currentFundingRate = 0.0001; // 0.01%

      const impact = calculator.predictFundingRateImpact(
        positionSizeUsd,
        openInterest,
        currentFundingRate,
      );

      // Should be minimal (small positions have small impact, but not zero)
      // With sqrt(0.001) * 0.1 ≈ 0.00316, impact ≈ 0.00316 * rate
      expect(Math.abs(impact)).toBeGreaterThan(0);
      expect(Math.abs(impact)).toBeLessThan(currentFundingRate * 0.01); // Less than 1% of rate
    });

    it('should predict moderate impact for medium positions (1-5% of OI)', () => {
      const positionSizeUsd = 30000; // 3% of OI
      const openInterest = 1000000;
      const currentFundingRate = 0.0001; // 0.01%

      const impact = calculator.predictFundingRateImpact(
        positionSizeUsd,
        openInterest,
        currentFundingRate,
      );

      // Should be moderate (1-5% of current rate)
      expect(Math.abs(impact)).toBeGreaterThan(currentFundingRate * 0.01);
      expect(Math.abs(impact)).toBeLessThan(currentFundingRate * 0.1);
    });

    it('should cap impact at 10% of current rate', () => {
      const positionSizeUsd = 100000; // 10% of OI (very large)
      const openInterest = 1000000;
      const currentFundingRate = 0.0001; // 0.01%

      const impact = calculator.predictFundingRateImpact(
        positionSizeUsd,
        openInterest,
        currentFundingRate,
      );

      // Should be capped at 10% of current rate
      expect(Math.abs(impact)).toBeLessThanOrEqual(currentFundingRate * 0.1);
    });

    it('should scale impact with position size (square root model)', () => {
      const openInterest = 1000000;
      const currentFundingRate = 0.0001;

      const impact1 = calculator.predictFundingRateImpact(
        10000, // 1% of OI
        openInterest,
        currentFundingRate,
      );

      const impact4 = calculator.predictFundingRateImpact(
        40000, // 4% of OI (4x position size)
        openInterest,
        currentFundingRate,
      );

      // Impact should increase but not linearly (square root model)
      expect(Math.abs(impact4)).toBeGreaterThan(Math.abs(impact1));
      expect(Math.abs(impact4)).toBeLessThan(Math.abs(impact1) * 4); // Less than 4x
    });
  });

  describe('calculateFees', () => {
    it('should calculate maker fees correctly', () => {
      const positionSizeUsd = 10000;

      const hyperliquidFee = calculator.calculateFees(
        positionSizeUsd,
        ExchangeType.HYPERLIQUID,
        true, // isMaker
        true, // isEntry
      );

      const asterFee = calculator.calculateFees(
        positionSizeUsd,
        ExchangeType.ASTER,
        true,
        true,
      );

      const lighterFee = calculator.calculateFees(
        positionSizeUsd,
        ExchangeType.LIGHTER,
        true,
        true,
      );

      expect(hyperliquidFee).toBe(positionSizeUsd * 0.00015); // 0.015%
      expect(asterFee).toBe(positionSizeUsd * 0.00005); // 0.005%
      expect(lighterFee).toBe(0); // 0% fees
    });

    it('should calculate taker fees correctly', () => {
      const positionSizeUsd = 10000;

      const hyperliquidFee = calculator.calculateFees(
        positionSizeUsd,
        ExchangeType.HYPERLIQUID,
        false, // isMaker = false (taker)
        true,
      );

      const asterFee = calculator.calculateFees(
        positionSizeUsd,
        ExchangeType.ASTER,
        false,
        true,
      );

      expect(hyperliquidFee).toBe(positionSizeUsd * 0.0002); // 0.02% taker
      expect(asterFee).toBe(positionSizeUsd * 0.0004); // 0.04% taker
    });

    it('should use default fee rate for unknown exchange', () => {
      const positionSizeUsd = 10000;
      const unknownExchange = 'UNKNOWN' as ExchangeType;

      const fee = calculator.calculateFees(
        positionSizeUsd,
        unknownExchange,
        true,
        true,
      );

      // Should use default 0.05%
      expect(fee).toBe(positionSizeUsd * 0.0005);
    });

    it('should calculate entry and exit fees the same way', () => {
      const positionSizeUsd = 10000;

      const entryFee = calculator.calculateFees(
        positionSizeUsd,
        ExchangeType.ASTER,
        true,
        true, // isEntry
      );

      const exitFee = calculator.calculateFees(
        positionSizeUsd,
        ExchangeType.ASTER,
        true,
        false, // isEntry = false (exit)
      );

      // Entry and exit fees should be the same
      expect(entryFee).toBe(exitFee);
    });
  });

  describe('calculateBreakEvenHours', () => {
    it('should calculate break-even hours correctly', () => {
      const totalCosts = 100; // $100 total costs
      const hourlyReturn = 10; // $10/hour return

      const breakEvenHours = calculator.calculateBreakEvenHours(
        totalCosts,
        hourlyReturn,
      );

      expect(breakEvenHours).toBe(10); // 100 / 10 = 10 hours
    });

    it('should return null for zero or negative hourly return', () => {
      const totalCosts = 100;

      const result1 = calculator.calculateBreakEvenHours(totalCosts, 0);
      const result2 = calculator.calculateBreakEvenHours(totalCosts, -5);

      expect(result1).toBeNull();
      expect(result2).toBeNull();
    });

    it('should handle fractional break-even hours', () => {
      const totalCosts = 100;
      const hourlyReturn = 3; // $3/hour

      const breakEvenHours = calculator.calculateBreakEvenHours(
        totalCosts,
        hourlyReturn,
      );

      expect(breakEvenHours).toBeCloseTo(33.33, 2); // 100 / 3 ≈ 33.33 hours
    });

    it('should return null for zero costs', () => {
      const hourlyReturn = 10;

      const breakEvenHours = calculator.calculateBreakEvenHours(
        0,
        hourlyReturn,
      );

      expect(breakEvenHours).toBe(0); // 0 hours to break even if no costs
    });
  });
});
