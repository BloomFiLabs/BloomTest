import { describe, it, expect } from 'vitest';
import { OnChainDataAdapter } from '@infrastructure/adapters/data/OnChainDataAdapter';
import { Price } from '@domain/value-objects';

describe('OnChainDataAdapter', () => {
  it('should create adapter with RPC URL', () => {
    const adapter = new OnChainDataAdapter('https://eth.llamarpc.com');
    expect(adapter).toBeDefined();
  });

  it('should have methods for fetching on-chain data', () => {
    const adapter = new OnChainDataAdapter('https://eth.llamarpc.com');
    expect(typeof adapter.fetchPrice).toBe('function');
    expect(typeof adapter.fetchOHLCV).toBe('function');
    expect(typeof adapter.fetchFundingRate).toBe('function');
  });

  // Note: Actual on-chain calls would require network access and are better suited for integration tests
});

