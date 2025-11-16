import { describe, it, expect } from 'vitest';
import { APR } from '@domain/value-objects/APR';

describe('APR', () => {
  it('should create a valid APR', () => {
    const apr = APR.create(20);
    expect(apr.value).toBe(20);
  });

  it('should create APR from decimal', () => {
    const apr = APR.fromDecimal(0.2);
    expect(apr.value).toBe(20);
  });

  it('should convert to decimal', () => {
    const apr = APR.create(20);
    expect(apr.toDecimal()).toBe(0.2);
  });

  it('should calculate period return', () => {
    const apr = APR.create(12); // 12% APR
    const dailyReturn = apr.periodReturn(365);
    expect(dailyReturn).toBeCloseTo(0.12 / 365, 6);
  });

  it('should add APRs', () => {
    const apr1 = APR.create(10);
    const apr2 = APR.create(5);
    const result = apr1.add(apr2);
    expect(result.value).toBe(15);
  });
});

