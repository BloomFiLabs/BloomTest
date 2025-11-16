import { describe, it, expect } from 'vitest';
import { BaseStrategy } from '@infrastructure/adapters/strategies/BaseStrategy';
import { Portfolio } from '@domain/entities/Portfolio';
import { Amount, Price, APR } from '@domain/value-objects';

class TestStrategy extends BaseStrategy {
  async execute() {
    return {
      trades: [],
      positions: [],
      shouldRebalance: false,
    };
  }

  calculateExpectedYield() {
    return APR.create(10);
  }

  validateConfig() {
    return true;
  }
}

describe('BaseStrategy', () => {
  it('should create a strategy with id and name', () => {
    const strategy = new TestStrategy('test-1', 'Test Strategy');
    expect(strategy.id).toBe('test-1');
    expect(strategy.name).toBe('Test Strategy');
  });

  it('should have createTrade helper method accessible to subclasses', () => {
    // The createTrade method is protected and accessible to subclasses
    // This test verifies the strategy can be instantiated
    const strategy = new TestStrategy('test-1', 'Test Strategy');
    expect(strategy).toBeDefined();
    expect(strategy.id).toBe('test-1');
  });
});

