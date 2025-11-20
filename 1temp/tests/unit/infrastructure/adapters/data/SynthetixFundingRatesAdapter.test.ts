import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { SynthetixFundingRatesAdapter, FundingRateUpdate } from '@infrastructure/adapters/data/SynthetixFundingRatesAdapter';

// Mock axios
vi.mock('axios');
const mockedAxios = axios as any;

describe('SynthetixFundingRatesAdapter', () => {
  let adapter: SynthetixFundingRatesAdapter;
  const mockApiKey = 'test-api-key-123';

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new SynthetixFundingRatesAdapter({ apiKey: mockApiKey });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Schema Parsing', () => {
    it('should correctly parse fundingRateUpdates from GraphQL response', async () => {
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [
              {
                id: '0x1',
                timestamp: '1700000000',
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000', // sETH
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '100000000000000', // 0.0001 in 18 decimals
                funding: '1000000000000000000', // 1.0 ETH
              },
              {
                id: '0x2',
                timestamp: '1700028800',
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '-50000000000000', // -0.00005 in 18 decimals
                funding: '-500000000000000000', // -0.5 ETH
              },
            ],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const startDate = new Date('2023-11-14T00:00:00Z');
      const endDate = new Date('2023-11-15T00:00:00Z');
      const updates = await adapter.fetchFundingHistory('sETH', startDate, endDate);

      expect(updates).toHaveLength(2);
      expect(updates[0].timestamp).toBeInstanceOf(Date);
      expect(updates[0].timestamp.getTime()).toBe(1700000000 * 1000);
      expect(updates[0].marketKey).toBe('sETH');
      expect(updates[1].fundingRatePerInterval).toBeLessThan(0); // Negative rate
    });

    it('should handle empty fundingRateUpdates array', async () => {
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const startDate = new Date('2023-11-14');
      const endDate = new Date('2023-11-15');
      const updates = await adapter.fetchFundingHistory('sETH', startDate, endDate);

      expect(updates).toHaveLength(0);
      expect(Array.isArray(updates)).toBe(true);
    });

    it('should throw error on GraphQL errors', async () => {
      const mockResponse = {
        data: {
          errors: [{ message: 'Field "fundingRate" not found' }],
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const startDate = new Date('2023-11-14');
      const endDate = new Date('2023-11-15');

      await expect(
        adapter.fetchFundingHistory('sETH', startDate, endDate)
      ).rejects.toThrow('GraphQL errors: Field "fundingRate" not found');
    });
  });

  describe('Funding Rate Conversion', () => {
    it('should correctly convert positive funding rate from 18 decimals', async () => {
      // fundingRate: 100000000000000 = 0.0001 = 0.01% per interval
      // Assuming 8-hour intervals, this is 0.03% per day = ~10.95% APR
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [
              {
                id: '0x1',
                timestamp: '1700000000',
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '100000000000000', // 0.0001 = 0.01% per interval
                funding: '1000000000000000000',
              },
            ],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const updates = await adapter.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2023-11-15'));
      
      expect(updates[0].fundingRateRaw).toBe('100000000000000');
      expect(updates[0].fundingRatePerInterval).toBeCloseTo(0.0001, 6);
      
      // 3 intervals per day (8h each), 365 days per year
      // APR = 0.0001 * 3 * 365 = 10.95%
      expect(updates[0].annualizedFundingAPR).toBeCloseTo(10.95, 2);
    });

    it('should correctly convert negative funding rate', async () => {
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [
              {
                id: '0x1',
                timestamp: '1700000000',
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '-200000000000000', // -0.0002 = -0.02% per interval
                funding: '-2000000000000000000',
              },
            ],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const updates = await adapter.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2023-11-15'));
      
      expect(updates[0].fundingRatePerInterval).toBeCloseTo(-0.0002, 6);
      expect(updates[0].annualizedFundingAPR).toBeCloseTo(-21.9, 2); // -0.0002 * 3 * 365
      expect(updates[0].fundingRatePerInterval).toBeLessThan(0);
    });

    it('should handle zero funding rate', async () => {
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [
              {
                id: '0x1',
                timestamp: '1700000000',
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '0',
                funding: '0',
              },
            ],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const updates = await adapter.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2023-11-15'));
      
      expect(updates[0].fundingRatePerInterval).toBe(0);
      expect(updates[0].annualizedFundingAPR).toBe(0);
    });

    it('should handle very large funding rates without overflow', async () => {
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [
              {
                id: '0x1',
                timestamp: '1700000000',
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '10000000000000000', // 0.01 = 1% per interval (extreme)
                funding: '100000000000000000000',
              },
            ],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const updates = await adapter.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2023-11-15'));
      
      expect(updates[0].fundingRatePerInterval).toBeCloseTo(0.01, 6);
      expect(updates[0].annualizedFundingAPR).toBeCloseTo(1095, 2); // 1% * 3 * 365 = 1095%
    });
  });

  describe('Time-Window Filtering', () => {
    it('should only return updates within the specified time range', async () => {
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [
              {
                id: '0x1',
                timestamp: '1700000000', // 2023-11-14 22:13:20 UTC
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '100000000000000',
                funding: '1000000000000000000',
              },
              {
                id: '0x2',
                timestamp: '1700028800', // 2023-11-15 06:13:20 UTC
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '200000000000000',
                funding: '2000000000000000000',
              },
            ],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const startDate = new Date('2023-11-14T00:00:00Z');
      const endDate = new Date('2023-11-16T00:00:00Z');
      const updates = await adapter.fetchFundingHistory('sETH', startDate, endDate);

      // Both updates should be within range
      expect(updates).toHaveLength(2);
      expect(updates.every(u => u.timestamp >= startDate && u.timestamp <= endDate)).toBe(true);
    });

    it('should handle queries with no results in time range', async () => {
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const startDate = new Date('2020-01-01');
      const endDate = new Date('2020-01-02');
      const updates = await adapter.fetchFundingHistory('sETH', startDate, endDate);

      expect(updates).toHaveLength(0);
    });

    it('should correctly query subgraph with timestamp filters', async () => {
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const startDate = new Date('2023-11-14T00:00:00Z');
      const endDate = new Date('2023-11-15T00:00:00Z');
      
      await adapter.fetchFundingHistory('sETH', startDate, endDate);

      const callArgs = mockedAxios.post.mock.calls[0];
      const variables = callArgs[1].variables;
      
      // Variables are sent as strings in the GraphQL query
      expect(variables.startTimestamp).toBe(Math.floor(startDate.getTime() / 1000).toString());
      expect(variables.endTimestamp).toBe(Math.floor(endDate.getTime() / 1000).toString());
    });
  });

  describe('Multi-Market Support', () => {
    it('should fetch markets list with metadata', async () => {
      const mockResponse = {
        data: {
          data: {
            futuresMarkets: [
              {
                id: '0x1',
                asset: '0x4200000000000000000000000000000000000006',
                marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                marketStats: {
                  trades: '12345',
                  volume: '1000000000000000000000',
                },
              },
              {
                id: '0x2',
                asset: '0x1234567890abcdef',
                marketKey: '0x7342544300000000000000000000000000000000000000000000000000000000',
                marketStats: {
                  trades: '54321',
                  volume: '5000000000000000000000',
                },
              },
            ],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const markets = await adapter.fetchAvailableMarkets();

      expect(markets).toHaveLength(2);
      expect(markets[0].marketKey).toBe('sETH');
      expect(markets[0].asset).toBe('0x4200000000000000000000000000000000000006');
      expect(markets[1].marketKey).toBe('sBTC');
    });

    it('should filter funding updates by market', async () => {
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [
              {
                id: '0x1',
                timestamp: '1700000000',
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000', // sETH
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '100000000000000',
                funding: '1000000000000000000',
              },
            ],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const updates = await adapter.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2023-11-15'));

      expect(updates).toHaveLength(1);
      expect(updates[0].marketKey).toBe('sETH');
      
      // Verify query was sent with correct market filter
      const callArgs = mockedAxios.post.mock.calls[0];
      expect(callArgs[1].variables.marketKey).toContain('7345544800'); // sETH hex prefix
    });

    it('should handle multiple markets with different funding rates', async () => {
      const mockResponseETH = {
        data: {
          data: {
            fundingRateUpdates: [
              {
                id: '0x1',
                timestamp: '1700000000',
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '100000000000000',
                funding: '1000000000000000000',
              },
            ],
          },
        },
      };

      const mockResponseBTC = {
        data: {
          data: {
            fundingRateUpdates: [
              {
                id: '0x2',
                timestamp: '1700000000',
                market: {
                  marketKey: '0x7342544300000000000000000000000000000000000000000000000000000000',
                  asset: '0x1234567890abcdef',
                },
                fundingRate: '200000000000000',
                funding: '2000000000000000000',
              },
            ],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponseETH);
      const updatesETH = await adapter.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2023-11-15'));

      mockedAxios.post.mockResolvedValueOnce(mockResponseBTC);
      const updatesBTC = await adapter.fetchFundingHistory('sBTC', new Date('2023-11-14'), new Date('2023-11-15'));

      expect(updatesETH[0].marketKey).toBe('sETH');
      expect(updatesBTC[0].marketKey).toBe('sBTC');
      expect(updatesBTC[0].fundingRatePerInterval).toBeGreaterThan(updatesETH[0].fundingRatePerInterval);
    });
  });

  describe('Error Handling', () => {
    it('should throw error on network failure', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        adapter.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2023-11-15'))
      ).rejects.toThrow('Synthetix subgraph query failed: Network error');
    });

    it('should throw error on HTTP error response', async () => {
      const mockError = {
        response: {
          status: 500,
          data: { error: 'Internal server error' },
        },
      };

      mockedAxios.post.mockRejectedValueOnce(mockError);

      await expect(
        adapter.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2023-11-15'))
      ).rejects.toThrow('Synthetix subgraph query failed (500)');
    });

    it('should throw error on authentication failure', async () => {
      const mockError = {
        response: {
          status: 401,
          data: { error: 'Unauthorized' },
        },
      };

      mockedAxios.post.mockRejectedValueOnce(mockError);

      await expect(
        adapter.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2023-11-15'))
      ).rejects.toThrow('Synthetix subgraph query failed (401)');
    });

    it('should include authorization header when API key provided', async () => {
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      await adapter.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2023-11-15'));

      const callArgs = mockedAxios.post.mock.calls[0];
      const headers = callArgs[2].headers;
      
      expect(headers.Authorization).toBe(`Bearer ${mockApiKey}`);
    });

    it('should work without API key for public queries', async () => {
      const adapterNoKey = new SynthetixFundingRatesAdapter();
      
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      await adapterNoKey.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2023-11-15'));

      const callArgs = mockedAxios.post.mock.calls[0];
      const headers = callArgs[2].headers;
      
      expect(headers.Authorization).toBeUndefined();
    });
  });

  describe('Pagination', () => {
    it('should handle large result sets with pagination', async () => {
      // First page
      const mockResponse1 = {
        data: {
          data: {
            fundingRateUpdates: Array(1000).fill(null).map((_, i) => ({
              id: `0x${i}`,
              timestamp: (1700000000 + i * 28800).toString(), // Every 8 hours
              market: {
                marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                asset: '0x4200000000000000000000000000000000000006',
              },
              fundingRate: '100000000000000',
              funding: '1000000000000000000',
            })),
          },
        },
      };

      // Second page (smaller)
      const mockResponse2 = {
        data: {
          data: {
            fundingRateUpdates: Array(500).fill(null).map((_, i) => ({
              id: `0x${i + 1000}`,
              timestamp: (1700000000 + (i + 1000) * 28800).toString(),
              market: {
                marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                asset: '0x4200000000000000000000000000000000000006',
              },
              fundingRate: '100000000000000',
              funding: '1000000000000000000',
            })),
          },
        },
      };

      mockedAxios.post
        .mockResolvedValueOnce(mockResponse1)
        .mockResolvedValueOnce(mockResponse2);

      const updates = await adapter.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2024-11-15'));

      expect(updates.length).toBeGreaterThan(1000); // Should have paginated
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('Statistics and Analysis', () => {
    it('should calculate funding rate statistics', async () => {
      const mockResponse = {
        data: {
          data: {
            fundingRateUpdates: [
              {
                id: '0x1',
                timestamp: '1700000000',
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '100000000000000',
                funding: '1000000000000000000',
              },
              {
                id: '0x2',
                timestamp: '1700028800',
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '200000000000000',
                funding: '2000000000000000000',
              },
              {
                id: '0x3',
                timestamp: '1700057600',
                market: {
                  marketKey: '0x7345544800000000000000000000000000000000000000000000000000000000',
                  asset: '0x4200000000000000000000000000000000000006',
                },
                fundingRate: '150000000000000',
                funding: '1500000000000000000',
              },
            ],
          },
        },
      };

      mockedAxios.post.mockResolvedValueOnce(mockResponse);

      const updates = await adapter.fetchFundingHistory('sETH', new Date('2023-11-14'), new Date('2023-11-16'));
      const stats = adapter.calculateStatistics(updates);

      expect(stats.avgFundingAPR).toBeCloseTo(16.425, 2); // (10.95 + 21.9 + 16.425) / 3
      expect(stats.minFundingAPR).toBeCloseTo(10.95, 2);
      expect(stats.maxFundingAPR).toBeCloseTo(21.9, 2);
      expect(stats.totalUpdates).toBe(3);
    });
  });
});

