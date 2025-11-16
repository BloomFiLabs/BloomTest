import { describe, it, expect } from 'vitest';
import { HealthFactor } from '@domain/value-objects/HealthFactor';

describe('HealthFactor', () => {
  it('should create a valid health factor', () => {
    const hf = HealthFactor.create(1.5);
    expect(hf.value).toBe(1.5);
  });

  it('should throw error for negative health factor', () => {
    expect(() => HealthFactor.create(-1)).toThrow('Health factor must be positive');
  });

  it('should check if healthy', () => {
    const hf1 = HealthFactor.create(1.5);
    const hf2 = HealthFactor.create(0.9);
    expect(hf1.isHealthy()).toBe(true);
    expect(hf2.isHealthy()).toBe(false);
  });

  it('should check if at risk', () => {
    const hf1 = HealthFactor.create(1.4);
    const hf2 = HealthFactor.create(1.6);
    expect(hf1.isAtRisk(1.5)).toBe(true);
    expect(hf2.isAtRisk(1.5)).toBe(false);
  });
});

