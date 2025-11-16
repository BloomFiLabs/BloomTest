import { describe, it, expect } from 'vitest';
import { Price } from '@domain/value-objects/Price';

describe('Price', () => {
  it('should create a valid price', () => {
    const price = Price.create(100.5);
    expect(price.value).toBe(100.5);
  });

  it('should throw error for negative price', () => {
    expect(() => Price.create(-1)).toThrow('Price must be positive');
  });

  it('should throw error for zero price', () => {
    expect(() => Price.create(0)).toThrow('Price must be positive');
  });

  it('should compare prices correctly', () => {
    const price1 = Price.create(100);
    const price2 = Price.create(200);
    const price3 = Price.create(100);

    expect(price1.equals(price2)).toBe(false);
    expect(price1.equals(price3)).toBe(true);
  });

  it('should calculate percentage change', () => {
    const price1 = Price.create(100);
    const price2 = Price.create(110);
    expect(price1.percentageChange(price2)).toBe(10);
  });
});

