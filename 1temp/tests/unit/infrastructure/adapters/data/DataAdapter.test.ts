import { describe, it, expect } from 'vitest';
import { Price, Amount, IV, FundingRate } from '@domain/value-objects';

describe('DataAdapter interfaces', () => {
  it('should define market data structure', () => {
    const marketData = {
      price: Price.create(2000),
      timestamp: new Date('2024-01-01'),
      iv: IV.create(50),
      fundingRate: FundingRate.create(0.0001),
      volume: Amount.create(1000000),
    };

    expect(marketData.price.value).toBe(2000);
    expect(marketData.iv.value).toBe(50);
  });
});

