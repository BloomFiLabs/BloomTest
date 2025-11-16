import { describe, it, expect, beforeEach } from 'vitest';
import { Portfolio } from '@domain/entities/Portfolio';
import { Amount, Price } from '@domain/value-objects';
import { Position } from '@domain/entities/Position';

describe('Portfolio', () => {
  let portfolio: Portfolio;

  beforeEach(() => {
    portfolio = Portfolio.create({
      id: 'portfolio-1',
      initialCapital: Amount.create(100000),
    });
  });

  it('should create a portfolio', () => {
    expect(portfolio.id).toBe('portfolio-1');
    expect(portfolio.initialCapital.value).toBe(100000);
  });

  it('should add a position', () => {
    const position = Position.create({
      id: 'pos-1',
      strategyId: 'strategy-1',
      asset: 'ETH',
      amount: Amount.create(10),
      entryPrice: Price.create(2000),
      currentPrice: Price.create(2000),
    });

    portfolio.addPosition(position);
    expect(portfolio.positions.length).toBe(1);
  });

  it('should calculate total value', () => {
    const position1 = Position.create({
      id: 'pos-1',
      strategyId: 'strategy-1',
      asset: 'ETH',
      amount: Amount.create(10),
      entryPrice: Price.create(2000),
      currentPrice: Price.create(2100),
    });

    const position2 = Position.create({
      id: 'pos-2',
      strategyId: 'strategy-1',
      asset: 'USDC',
      amount: Amount.create(50000),
      entryPrice: Price.create(1),
      currentPrice: Price.create(1),
    });

    // Add positions with their entry costs
    portfolio.addPosition(position1, position1.entryValue());
    portfolio.addPosition(position2, position2.entryValue());

    const totalValue = portfolio.totalValue();
    // Positions: 10 * 2100 + 50000 = 71000
    // Cash: 100000 - 20000 - 50000 = 30000
    // Total: 71000 + 30000 = 101000
    expect(totalValue.value).toBe(101000);
  });

  it('should calculate total PnL', () => {
    const position = Position.create({
      id: 'pos-1',
      strategyId: 'strategy-1',
      asset: 'ETH',
      amount: Amount.create(10),
      entryPrice: Price.create(2000),
      currentPrice: Price.create(2100),
    });

    portfolio.addPosition(position, position.entryValue());
    const pnl = portfolio.totalPnL();
    // Position value: 10 * 2100 = 21000
    // Cash remaining: 100000 - 20000 = 80000
    // Total value: 21000 + 80000 = 101000
    // PnL: 101000 - 100000 = 1000
    expect(pnl.value).toBe(1000);
  });
});

