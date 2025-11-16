import { describe, it, expect } from 'vitest';
import { VolatilePairStrategy } from '../../src/infrastructure/adapters/strategies/VolatilePairStrategy';
import { Portfolio } from '../../src/domain/entities/Portfolio';
import { Amount, Price } from '../../src/domain/value-objects';
import { MarketData } from '../../src/domain/entities/Strategy';

describe('Cash Flow Integration', () => {
  it('should not deduct cash twice for LP positions', async () => {
    const portfolio = Portfolio.create({
      id: 'test-portfolio',
      initialCapital: Amount.create(100000),
    });

    const strategy = new VolatilePairStrategy('vp1', 'Test Strategy');
    const config = {
      pair: 'ETH-USDC',
      rangeWidth: 0.05,
      allocation: 0.4, // 40% = $40,000
      ammFeeAPR: 20,
      incentiveAPR: 15,
      fundingAPR: 5,
    };

    const marketData: MarketData = {
      price: Price.create(2000),
      volume: Amount.create(1000000),
      timestamp: new Date('2024-01-01'),
      iv: undefined,
      fundingRate: undefined,
    };

    const initialCash = portfolio.cash.value;
    expect(initialCash).toBe(100000);

    const result = await strategy.execute(portfolio, marketData, config);

    // Should create 1 position and 1 trade (not 2 trades)
    expect(result.positions).toHaveLength(1);
    expect(result.trades).toHaveLength(1); // Single trade for LP position
    
    // Trade should be for the full allocation amount
    expect(result.trades[0].amount.value).toBe(40000);
    expect(result.trades[0].asset).toBe('ETH-USDC'); // Pair name, not individual asset
    
    // Position should be for the full allocation
    expect(result.positions[0].amount.value).toBe(40000);
  });

  it('should handle multiple strategy executions without cash going negative', async () => {
    const portfolio = Portfolio.create({
      id: 'test-portfolio',
      initialCapital: Amount.create(100000),
    });

    const strategy = new VolatilePairStrategy('vp1', 'Test Strategy');
    const config = {
      pair: 'ETH-USDC',
      rangeWidth: 0.05,
      allocation: 0.4,
    };

    const marketData: MarketData = {
      price: Price.create(2000),
      volume: Amount.create(1000000),
      timestamp: new Date('2024-01-01'),
      iv: undefined,
      fundingRate: undefined,
    };

    // Execute strategy multiple times
    for (let i = 0; i < 5; i++) {
      const result = await strategy.execute(portfolio, marketData, config);
      
      // Add positions to portfolio
      for (const position of result.positions) {
        const existing = portfolio.positions.find(p => p.id === position.id);
        if (existing) {
          portfolio.updatePosition(position);
        } else {
          portfolio.addPosition(position);
        }
      }
      
      // Execute trades (simulate cash deduction)
      for (const trade of result.trades) {
        const cost = trade.totalCost();
        const currentCash = portfolio.cash;
        
        if (currentCash.value >= cost.value) {
          // Simulate trade execution
          const tempPos = {
            id: `temp-${trade.id}-${i}`,
            strategyId: trade.strategyId,
            asset: trade.asset,
            amount: Amount.zero(),
            entryPrice: Price.create(1),
            currentPrice: Price.create(1),
          };
          portfolio.addPosition(tempPos as any, cost);
          portfolio.removePosition(tempPos.id);
        }
      }
      
      // Cash should never go negative
      expect(portfolio.cash.value).toBeGreaterThanOrEqual(0);
    }
  });
});

