import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UniswapGraphAdapter } from './UniswapGraphAdapter';
import { GraphQLClient } from 'graphql-request';

// Mock GraphQLClient
jest.mock('graphql-request');

describe('UniswapGraphAdapter', () => {
  let adapter: UniswapGraphAdapter;
  let mockClient: jest.Mocked<GraphQLClient>;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UniswapGraphAdapter,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(undefined), // No API key by default
          },
        },
      ],
    }).compile();

    adapter = module.get<UniswapGraphAdapter>(UniswapGraphAdapter);
    configService = module.get<ConfigService>(ConfigService);

    // Get the mocked client instance
    mockClient = (adapter as any).client as jest.Mocked<GraphQLClient>;
  });

  describe('getPoolFeeTier', () => {
    const poolAddress = '0x4f8d9a26Ae95f14a179439a2A0B3431E52940496';

    it('should return 1% fee tier for 1% pool', async () => {
      mockClient.request.mockResolvedValueOnce({
        pool: {
          feeTier: 10000, // 1% in basis points (10000 / 1e6 = 0.01)
        },
      });

      const feeTier = await adapter.getPoolFeeTier(poolAddress);
      expect(feeTier).toBe(0.01);
    });

    it('should return 0.05% fee tier for 0.05% pool', async () => {
      mockClient.request.mockResolvedValueOnce({
        pool: {
          feeTier: 500, // 0.05% in basis points (500 / 1e6 = 0.0005)
        },
      });

      const feeTier = await adapter.getPoolFeeTier(poolAddress);
      expect(feeTier).toBe(0.0005);
    });

    it('should return 0.3% fee tier for 0.3% pool', async () => {
      mockClient.request.mockResolvedValueOnce({
        pool: {
          feeTier: 3000, // 0.3% in basis points (3000 / 1e6 = 0.003)
        },
      });

      const feeTier = await adapter.getPoolFeeTier(poolAddress);
      expect(feeTier).toBe(0.003);
    });

    it('should return fallback 0.05% when pool data is missing', async () => {
      mockClient.request.mockResolvedValueOnce({
        pool: null,
      });

      const feeTier = await adapter.getPoolFeeTier(poolAddress);
      expect(feeTier).toBe(0.0005); // Fallback
    });

    it('should return fallback 0.05% when feeTier is undefined', async () => {
      mockClient.request.mockResolvedValueOnce({
        pool: {
          feeTier: undefined,
        },
      });

      const feeTier = await adapter.getPoolFeeTier(poolAddress);
      expect(feeTier).toBe(0.0005); // Fallback
    });

    it('should handle errors and return fallback', async () => {
      mockClient.request.mockRejectedValueOnce(new Error('Network error'));

      const feeTier = await adapter.getPoolFeeTier(poolAddress);
      expect(feeTier).toBe(0.0005); // Fallback
    });

    it('should convert pool address to lowercase', async () => {
      const upperCaseAddress = '0x4F8D9A26AE95F14A179439A2A0B3431E52940496';

      mockClient.request.mockResolvedValueOnce({
        pool: {
          feeTier: 10000,
        },
      });

      await adapter.getPoolFeeTier(upperCaseAddress);

      // Check that the request was called with lowercase address
      const callArgs = mockClient.request.mock.calls[0] as any;
      expect(callArgs).toBeDefined();
      // The request function may be called with (query, variables) or a single options object
      const variables = callArgs.length > 1 ? callArgs[1] : callArgs[0]?.variables;
      expect(variables).toHaveProperty('pool', upperCaseAddress.toLowerCase());
    });
  });
});
