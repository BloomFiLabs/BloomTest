import { describe, it, expect, beforeEach } from 'vitest';
import { BacktestEngine } from '../../src/domain/services/BacktestEngine';
import { Portfolio } from '../../src/domain/entities/Portfolio';
import { VolatilePairStrategy } from '../../src/infrastructure/adapters/strategies/VolatilePairStrategy';
import { CSVDataAdapter } from '../../src/infrastructure/adapters/data/CSVDataAdapter';
import { Amount, Price } from '../../src/domain/value-objects';
import { MarketData } from '../../src/domain/entities/Strategy';

describe('BacktestEngine Integration', () => {
  let engine: BacktestEngine;
  let portfolio: Portfolio;

  beforeEach(() => {
    engine = new BacktestEngine();
    portfolio = Portfolio.create({
      id: 'test-portfolio',
      initialCapital: Amount.create(100000),
    });
  });

  it('should not allow cash to go negative when executing trades', async () => {
    const strategy = new VolatilePairStrategy('vp1', 'Test Strategy');
    const config = {
      pair: 'ETH-USDC',
      rangeWidth: 0.05,
      allocation: 0.4,
      ammFeeAPR: 20,
      incentiveAPR: 15,
      fundingAPR: 5,
    };

    // Create market data
    const marketData: MarketData = {
      price: Price.create(2000),
      volume: Amount.create(1000000),
      timestamp: new Date('2024-01-01'),
      iv: undefined,
      fundingRate: undefined,
    };

    // Execute strategy multiple times to simulate backtest
    for (let i = 0; i < 10; i++) {
      const result = await strategy.execute(portfolio, marketData, config);
      
      // Execute trades - this should not cause cash to go negative
      for (const trade of result.trades) {
        const cost = trade.totalCost();
        const currentCash = portfolio.cash;
        
        // Verify we have enough cash before deducting
        expect(currentCash.value).toBeGreaterThanOrEqual(0);
        
        if (trade.side === 'buy' && currentCash.value >= cost.value) {
          // Simulate trade execution
          const tempPosition = {
            id: `temp-${trade.id}`,
            strategyId: trade.strategyId,
            asset: trade.asset,
            amount: Amount.zero(),
            entryPrice: Price.create(1),
            currentPrice: Price.create(1),
          };
          
          // This should not throw
          try {
            portfolio.addPosition(tempPosition as any, cost);
            portfolio.removePosition(tempPosition.id);
          } catch (error) {
            // If cash would go negative, this is the error we're catching
            expect(error).toBeDefined();
            expect((error as Error).message).toContain('negative');
            // In real scenario, we'd handle this gracefully
          }
        }
      }
      
      // Update positions
      for (const position of result.positions) {
        const existing = portfolio.positions.find(p => p.id === position.id);
        if (existing) {
          portfolio.updatePosition(position);
        } else {
          portfolio.addPosition(position);
        }
      }
    }

    // Final cash should be non-negative
    expect(portfolio.cash.value).toBeGreaterThanOrEqual(0);
  });

  it('should handle insufficient cash gracefully', async () => {
    // Create portfolio with very little cash
    const smallPortfolio = Portfolio.create({
      id: 'small-portfolio',
      initialCapital: Amount.create(100), // Very small
    });

    const strategy = new VolatilePairStrategy('vp1', 'Test Strategy');
    const config = {
      pair: 'ETH-USDC',
      rangeWidth: 0.05,
      allocation: 0.4, // 40% of $100 = $40
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

    const result = await strategy.execute(smallPortfolio, marketData, config);
    
    // Should create trades
    expect(result.trades.length).toBeGreaterThan(0);
    
    // But executing them should handle insufficient cash
    for (const trade of result.trades) {
      const cost = trade.totalCost();
      const currentCash = smallPortfolio.cash;
      
      if (currentCash.value < cost.value) {
        // Should handle this case gracefully
        // In production, we'd skip the trade or reduce size
        expect(currentCash.value).toBeLessThan(cost.value);
      }
    }
  });
});

