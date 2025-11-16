import { describe, it, expect, beforeEach } from 'vitest';
import { VolatilePairStrategy } from '../../../../../src/infrastructure/adapters/strategies/VolatilePairStrategy';
import { Portfolio } from '../../../../../src/domain/entities/Portfolio';
import { MarketData } from '../../../../../src/domain/entities/Strategy';
import { Amount, Price, APR } from '../../../../../src/domain/value-objects';
import { Position } from '../../../../../src/domain/entities/Position';

describe('VolatilePairStrategy', () => {
  let strategy: VolatilePairStrategy;
  let portfolio: Portfolio;
  let baseMarketData: MarketData;

  beforeEach(() => {
    strategy = new VolatilePairStrategy('vp1', 'Test Volatile Pair');
    portfolio = Portfolio.create({
      id: 'test-portfolio',
      initialCapital: Amount.create(100000),
    });
    baseMarketData = {
      price: Price.create(2000),
      volume: Amount.create(1000000),
      timestamp: new Date('2024-01-01'),
      iv: undefined,
      fundingRate: undefined,
    };
  });

  describe('Position Creation', () => {
    it('should create LP position when no existing position', async () => {
      const config = {
        pair: 'ETH-USDC',
        rangeWidth: 0.05,
        allocation: 0.4,
        ammFeeAPR: 20,
        incentiveAPR: 15,
        fundingAPR: 5,
      };

      const result = await strategy.execute(portfolio, baseMarketData, config);

      expect(result.positions).toHaveLength(1);
      expect(result.positions[0].asset).toBe('ETH-USDC');
      expect(result.positions[0].amount.value).toBeGreaterThan(0);
      expect(result.positions[0].currentPrice.value).toBe(1.0); // LP price
      expect(result.trades).toHaveLength(1); // Single trade for LP position (not two separate asset trades)
      expect(result.trades[0].asset).toBe('ETH-USDC'); // Trade uses pair name
      expect(result.trades[0].amount.value).toBe(result.positions[0].amount.value); // Trade amount matches position amount
    });

    it('should not create position if allocation is zero', async () => {
      // Ensure fresh portfolio with no positions
      const freshPortfolio = Portfolio.create({
        id: 'test-portfolio-zero',
        initialCapital: Amount.create(100000),
      });
      
      const config = {
        pair: 'ETH-USDC',
        rangeWidth: 0.05,
        allocation: 0,
      };

      const result = await strategy.execute(freshPortfolio, baseMarketData, config);

      // When allocation is 0, allocatedAmount will be 0, so no position created
      // Also, if there's an existing position, it won't be returned when allocation is 0
      expect(result.positions).toHaveLength(0);
      expect(result.trades).toHaveLength(0);
    });
  });

  describe('Rebalancing Logic', () => {
    it('should trigger rebalance when price drifts outside range', async () => {
      const config = {
        pair: 'ETH-USDC',
        rangeWidth: 0.05, // ±5%
        allocation: 0.4,
      };

      // Create initial position
      await strategy.execute(portfolio, baseMarketData, config);
      
      // Add position to portfolio for tracking
      const initialPosition = Position.create({
        id: 'vp1-ETH-USDC',
        strategyId: 'vp1',
        asset: 'ETH-USDC',
        amount: Amount.create(40000),
        entryPrice: Price.create(1.0),
        currentPrice: Price.create(1.0),
      });
      portfolio.addPosition(initialPosition);

      // Price moves 6% (outside ±5% range)
      const driftedMarketData: MarketData = {
        ...baseMarketData,
        price: Price.create(2120), // 6% increase
      };

      const result = await strategy.execute(portfolio, driftedMarketData, config);

      expect(result.shouldRebalance).toBe(true);
      expect(result.rebalanceReason).toContain('Price moved');
      expect(result.rebalanceReason).toMatch(/\d+\.\d+%/); // Match any percentage
    });

    it('should not trigger rebalance when price stays within range', async () => {
      const config = {
        pair: 'ETH-USDC',
        rangeWidth: 0.05, // ±5%
        allocation: 0.4,
      };

      // Create initial position
      await strategy.execute(portfolio, baseMarketData, config);
      
      // Add position to portfolio
      const initialPosition = Position.create({
        id: 'vp1-ETH-USDC',
        strategyId: 'vp1',
        asset: 'ETH-USDC',
        amount: Amount.create(40000),
        entryPrice: Price.create(1.0),
        currentPrice: Price.create(1.0),
      });
      portfolio.addPosition(initialPosition);

      // Price moves 3% (within ±5% range)
      const inRangeMarketData: MarketData = {
        ...baseMarketData,
        price: Price.create(2060), // 3% increase
      };

      const result = await strategy.execute(portfolio, inRangeMarketData, config);

      expect(result.shouldRebalance).toBe(false);
    });

    it('should track entry price correctly across multiple executions', async () => {
      const config = {
        pair: 'ETH-USDC',
        rangeWidth: 0.05,
        allocation: 0.4,
      };

      // Initial execution
      await strategy.execute(portfolio, baseMarketData, config);
      const initialPosition = Position.create({
        id: 'vp1-ETH-USDC',
        strategyId: 'vp1',
        asset: 'ETH-USDC',
        amount: Amount.create(40000),
        entryPrice: Price.create(1.0),
        currentPrice: Price.create(1.0),
      });
      portfolio.addPosition(initialPosition);

      // Price moves 6% - triggers rebalance
      const driftedData: MarketData = {
        ...baseMarketData,
        price: Price.create(2120), // 6% increase
      };
      await strategy.execute(portfolio, driftedData, config);

      // After rebalance, price moves 3% from NEW entry point
      const afterRebalanceData: MarketData = {
        ...baseMarketData,
        price: Price.create(2060), // 3% from original, but should be measured from rebalance point
      };
      const result = await strategy.execute(portfolio, afterRebalanceData, config);

      // Should not rebalance again (3% is within range from new entry point)
      expect(result.shouldRebalance).toBe(false);
    });
  });

  describe('Yield Calculation', () => {
    it('should calculate expected yield from config', () => {
      const config = {
        pair: 'ETH-USDC',
        rangeWidth: 0.05,
        ammFeeAPR: 20,
        incentiveAPR: 15,
        fundingAPR: 5,
      };

      const yield_apr = strategy.calculateExpectedYield(config, baseMarketData);

      expect(yield_apr.value).toBe(40); // 20 + 15 + 5
    });

    it('should use default APRs if not specified', () => {
      const config = {
        pair: 'ETH-USDC',
        rangeWidth: 0.05,
      };

      const yield_apr = strategy.calculateExpectedYield(config, baseMarketData);

      expect(yield_apr.value).toBe(40); // Default: 20 + 15 + 5
    });
  });

  describe('Config Validation', () => {
    it('should validate correct config', () => {
      const config = {
        pair: 'ETH-USDC',
        rangeWidth: 0.05,
        hedgeRatio: 1.0,
      };

      expect(strategy.validateConfig(config)).toBe(true);
    });

    it('should reject invalid range width', () => {
      const config1 = {
        pair: 'ETH-USDC',
        rangeWidth: 0.001, // Too narrow
      };
      expect(strategy.validateConfig(config1)).toBe(false);

      const config2 = {
        pair: 'ETH-USDC',
        rangeWidth: 0.5, // Too wide
      };
      expect(strategy.validateConfig(config2)).toBe(false);
    });

    it('should reject invalid hedge ratio', () => {
      const config = {
        pair: 'ETH-USDC',
        rangeWidth: 0.05,
        hedgeRatio: 2.0, // Out of range
      };
      expect(strategy.validateConfig(config)).toBe(false);
    });
  });
});

