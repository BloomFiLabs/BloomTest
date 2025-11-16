import { describe, it, expect, beforeEach } from 'vitest';
import { StablePairStrategy } from '@infrastructure/adapters/strategies/StablePairStrategy';
import { Portfolio } from '@domain/entities/Portfolio';
import { Amount, Price, APR } from '@domain/value-objects';

describe('StablePairStrategy', () => {
  let strategy: StablePairStrategy;
  let portfolio: Portfolio;

  beforeEach(() => {
    strategy = new StablePairStrategy('stable-pair-1', 'Stable Pair Strategy');
    portfolio = Portfolio.create({
      id: 'portfolio-1',
      initialCapital: Amount.create(100000),
    });
  });

  it('should create strategy with correct id and name', () => {
    expect(strategy.id).toBe('stable-pair-1');
    expect(strategy.name).toBe('Stable Pair Strategy');
  });

  it('should validate config with required parameters', () => {
    const validConfig = {
      pair: 'USDC-USDT',
      rangeWidth: 0.002, // 0.2%
      leverage: 2.0,
      collateralRatio: 1.6,
    };

    expect(strategy.validateConfig(validConfig)).toBe(true);
  });

  it('should reject invalid config', () => {
    const invalidConfig = {
      pair: 'USDC-USDT',
      // Missing required parameters
    };

    expect(strategy.validateConfig(invalidConfig)).toBe(false);
  });

  it('should calculate expected yield', async () => {
    const config = {
      pair: 'USDC-USDT',
      rangeWidth: 0.002,
      leverage: 2.0,
      collateralRatio: 1.6,
      ammFeeAPR: 12,
      incentiveAPR: 15,
      borrowAPR: 3,
    };

    const marketData = {
      price: Price.create(1.0),
      timestamp: new Date(),
    };

    const yield_ = strategy.calculateExpectedYield(config, marketData);
    // Expected: (12 + 15) * 2.0 - 3 = 51% gross, but capped realistically
    expect(yield_.value).toBeGreaterThan(0);
  });

  it('should execute strategy and create positions', async () => {
    const config = {
      pair: 'USDC-USDT',
      rangeWidth: 0.002,
      leverage: 1.5,
      collateralRatio: 1.6,
      allocation: 0.3, // 30% of portfolio
    };

    const marketData = {
      price: Price.create(1.0),
      timestamp: new Date(),
    };

    const result = await strategy.execute(portfolio, marketData, config);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
  });

  it('should trigger rebalance when price moves outside range', async () => {
    const config = {
      pair: 'USDC-USDT',
      rangeWidth: 0.002, // ±0.1%
      leverage: 1.5,
      collateralRatio: 1.6,
      allocation: 0.3,
    };

    // Price within range
    const marketData1 = {
      price: Price.create(1.0005),
      timestamp: new Date(),
    };

    const result1 = await strategy.execute(portfolio, marketData1, config);
    expect(result1.shouldRebalance).toBe(false);

    // Price outside range
    const marketData2 = {
      price: Price.create(1.003), // Outside ±0.1% range
      timestamp: new Date(),
    };

    const result2 = await strategy.execute(portfolio, marketData2, config);
    // Should trigger rebalance
    expect(result2.shouldRebalance).toBe(true);
  });
});

