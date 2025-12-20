import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BloomGraphAdapter } from './BloomGraphAdapter';
import { GraphQLClient } from 'graphql-request';

jest.mock('graphql-request');

describe('BloomGraphAdapter', () => {
  let adapter: BloomGraphAdapter;
  let configService: ConfigService;
  let graphClientMock: jest.Mocked<GraphQLClient>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BloomGraphAdapter,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'BLOOM_SUBGRAPH_URL') return 'http://mock-subgraph';
              if (key === 'GRAPH_API_KEY') return 'mock-api-key';
              return null;
            }),
          },
        },
      ],
    }).compile();

    adapter = module.get<BloomGraphAdapter>(BloomGraphAdapter);
    configService = module.get<ConfigService>(ConfigService);
    graphClientMock = (adapter as any).client;
  });

  it('should be defined', () => {
    expect(adapter).toBeDefined();
  });

  describe('getPendingWithdrawals', () => {
    it('should fetch pending withdrawals from subgraph', async () => {
      const mockData = {
        withdrawalRequests: [
          {
            id: '1',
            sharesEscrow: '100',
            owner: '0x123',
            claimableAt: '1234567890',
            requestedAt: '1234567800',
          },
        ],
      };

      graphClientMock.request.mockResolvedValueOnce(mockData);

      const result = await adapter.getPendingWithdrawals();

      expect(result).toEqual(mockData.withdrawalRequests);
      expect(graphClientMock.request).toHaveBeenCalled();
    });

    it('should return empty array on error', async () => {
      graphClientMock.request.mockRejectedValueOnce(new Error('Network error'));

      const result = await adapter.getPendingWithdrawals();

      expect(result).toEqual([]);
    });
  });
});
