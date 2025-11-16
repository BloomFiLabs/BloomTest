import { describe, it, expect } from 'vitest';
import { Amount } from '@domain/value-objects/Amount';

describe('Amount', () => {
  it('should create a valid amount', () => {
    const amount = Amount.create(1000.5);
    expect(amount.value).toBe(1000.5);
  });

  it('should throw error for negative amount', () => {
    expect(() => Amount.create(-1)).toThrow('Amount must be non-negative');
  });

  it('should allow zero amount', () => {
    const amount = Amount.create(0);
    expect(amount.value).toBe(0);
  });

  it('should add amounts', () => {
    const amount1 = Amount.create(100);
    const amount2 = Amount.create(200);
    const result = amount1.add(amount2);
    expect(result.value).toBe(300);
  });

  it('should subtract amounts', () => {
    const amount1 = Amount.create(200);
    const amount2 = Amount.create(100);
    const result = amount1.subtract(amount2);
    expect(result.value).toBe(100);
  });

  it('should throw error when subtracting larger amount', () => {
    const amount1 = Amount.create(100);
    const amount2 = Amount.create(200);
    expect(() => amount1.subtract(amount2)).toThrow('Result cannot be negative');
  });

  it('should multiply amount', () => {
    const amount = Amount.create(100);
    const result = amount.multiply(2.5);
    expect(result.value).toBe(250);
  });
});

