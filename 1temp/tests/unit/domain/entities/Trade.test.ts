import { describe, it, expect } from 'vitest';
import { Trade } from '@domain/entities/Trade';
import { Amount, Price } from '@domain/value-objects';

describe('Trade', () => {
  it('should create a buy trade', () => {
    const trade = Trade.create({
      id: 'trade-1',
      strategyId: 'strategy-1',
      asset: 'USDC',
      side: 'buy',
      amount: Amount.create(1000),
      price: Price.create(1.0),
      timestamp: new Date('2024-01-01'),
    });

    expect(trade.id).toBe('trade-1');
    expect(trade.side).toBe('buy');
    expect(trade.amount.value).toBe(1000);
  });

  it('should create a sell trade', () => {
    const trade = Trade.create({
      id: 'trade-2',
      strategyId: 'strategy-1',
      asset: 'ETH',
      side: 'sell',
      amount: Amount.create(1),
      price: Price.create(2000),
      timestamp: new Date('2024-01-01'),
    });

    expect(trade.side).toBe('sell');
  });

  it('should calculate trade value', () => {
    const trade = Trade.create({
      id: 'trade-3',
      strategyId: 'strategy-1',
      asset: 'ETH',
      side: 'buy',
      amount: Amount.create(2),
      price: Price.create(2000),
      timestamp: new Date('2024-01-01'),
    });

    expect(trade.value().value).toBe(4000);
  });
});

