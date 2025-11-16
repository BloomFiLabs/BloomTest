import { describe, it, expect } from 'vitest';
import { Position } from '@domain/entities/Position';
import { Amount, Price, PnL } from '@domain/value-objects';

describe('Position', () => {
  it('should create a position', () => {
    const position = Position.create({
      id: 'pos-1',
      strategyId: 'strategy-1',
      asset: 'ETH',
      amount: Amount.create(10),
      entryPrice: Price.create(2000),
      currentPrice: Price.create(2100),
    });

    expect(position.id).toBe('pos-1');
    expect(position.amount.value).toBe(10);
  });

  it('should calculate unrealized PnL', () => {
    const position = Position.create({
      id: 'pos-1',
      strategyId: 'strategy-1',
      asset: 'ETH',
      amount: Amount.create(10),
      entryPrice: Price.create(2000),
      currentPrice: Price.create(2100),
    });

    const pnl = position.unrealizedPnL();
    expect(pnl.value).toBe(1000); // 10 * (2100 - 2000)
  });

  it('should calculate negative PnL', () => {
    const position = Position.create({
      id: 'pos-1',
      strategyId: 'strategy-1',
      asset: 'ETH',
      amount: Amount.create(10),
      entryPrice: Price.create(2000),
      currentPrice: Price.create(1900),
    });

    const pnl = position.unrealizedPnL();
    expect(pnl.value).toBe(-1000);
    expect(pnl.isNegative()).toBe(true);
  });

  it('should update current price', () => {
    const position = Position.create({
      id: 'pos-1',
      strategyId: 'strategy-1',
      asset: 'ETH',
      amount: Amount.create(10),
      entryPrice: Price.create(2000),
      currentPrice: Price.create(2000),
    });

    const updated = position.updatePrice(Price.create(2200));
    expect(updated.currentPrice.value).toBe(2200);
  });
});

