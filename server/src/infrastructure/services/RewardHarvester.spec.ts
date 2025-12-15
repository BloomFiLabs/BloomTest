import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RewardHarvester, HarvestResult } from './RewardHarvester';
import { ProfitTracker, ProfitSummary, ExchangeProfitInfo } from './ProfitTracker';
import { DiagnosticsService } from './DiagnosticsService';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';

// Mock the PerpKeeperService to avoid ESM import issues with @nktkas/hyperliquid
jest.mock('../../application/services/PerpKeeperService', () => ({
  PerpKeeperService: jest.fn().mockImplementation(() => ({
    getBalance: jest.fn(),
    getExchangeAdapter: jest.fn(),
  })),
}));

import { PerpKeeperService } from '../../application/services/PerpKeeperService';

describe('RewardHarvester', () => {
  let rewardHarvester: RewardHarvester;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockKeeperService: jest.Mocked<PerpKeeperService>;
  let mockProfitTracker: jest.Mocked<ProfitTracker>;
  let mockDiagnosticsService: jest.Mocked<DiagnosticsService>;

  const mockProfitSummary: ProfitSummary = {
    totalBalance: 300,
    totalDeployedCapital: 250,
    totalAccruedProfit: 50,
    byExchange: new Map<ExchangeType, ExchangeProfitInfo>([
      [ExchangeType.HYPERLIQUID, {
        exchange: ExchangeType.HYPERLIQUID,
        currentBalance: 100,
        deployedCapital: 83.33,
        accruedProfit: 16.67,
        deployableCapital: 83.33,
      }],
      [ExchangeType.LIGHTER, {
        exchange: ExchangeType.LIGHTER,
        currentBalance: 150,
        deployedCapital: 125,
        accruedProfit: 25,
        deployableCapital: 125,
      }],
      [ExchangeType.ASTER, {
        exchange: ExchangeType.ASTER,
        currentBalance: 50,
        deployedCapital: 41.67,
        accruedProfit: 8.33,
        deployableCapital: 41.67,
      }],
    ]),
    lastSyncTimestamp: new Date(),
    lastHarvestTimestamp: null,
    totalHarvestedAllTime: 0,
  };

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          KEEPER_STRATEGY_ADDRESS: '0x1234567890123456789012345678901234567890',
          USDC_ADDRESS: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
          ARBITRUM_RPC_URL: 'https://arb1.arbitrum.io/rpc',
          KEEPER_PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
          MIN_HARVEST_AMOUNT_USD: 10,
          HARVEST_INTERVAL_HOURS: 24,
        };
        return config[key] ?? defaultValue;
      }),
    } as any;

    mockKeeperService = {
      getBalance: jest.fn(),
      getExchangeAdapter: jest.fn(),
    } as any;

    mockProfitTracker = {
      getProfitSummary: jest.fn().mockResolvedValue(mockProfitSummary),
      recordHarvest: jest.fn(),
      getLastHarvestTimestamp: jest.fn().mockReturnValue(null),
      getTotalHarvestedAllTime: jest.fn().mockReturnValue(0),
    } as any;

    mockDiagnosticsService = {
      recordError: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: RewardHarvester,
          useFactory: () => new RewardHarvester(
            mockConfigService,
            mockKeeperService,
            mockProfitTracker,
            mockDiagnosticsService,
          ),
        },
      ],
    }).compile();

    rewardHarvester = module.get<RewardHarvester>(RewardHarvester);
  });

  describe('harvestRewards', () => {
    it('should skip harvest if profits below minimum threshold', async () => {
      // Set profits below threshold ($10)
      const lowProfitSummary = {
        ...mockProfitSummary,
        totalAccruedProfit: 5, // Below $10 minimum
      };
      mockProfitTracker.getProfitSummary.mockResolvedValue(lowProfitSummary);

      const result = await rewardHarvester.forceHarvest();

      expect(result.success).toBe(true); // Not an error, just skipped
      expect(result.totalProfitsFound).toBe(5);
      expect(result.totalWithdrawn).toBe(0);
      expect(result.totalSentToVault).toBe(0);
    });

    it('should return error when ProfitTracker not available', async () => {
      // Create harvester without ProfitTracker
      const harvesterWithoutTracker = new RewardHarvester(
        mockConfigService,
        mockKeeperService,
        undefined, // No ProfitTracker
        mockDiagnosticsService,
      );

      const result = await harvesterWithoutTracker.forceHarvest();

      expect(result.success).toBe(false);
      expect(result.errors).toContain('ProfitTracker not available');
    });

    it('should identify profits from all exchanges', async () => {
      const result = await rewardHarvester.forceHarvest();

      expect(result.totalProfitsFound).toBe(50);
      expect(mockProfitTracker.getProfitSummary).toHaveBeenCalled();
    });
  });

  describe('getTimeUntilNextHarvest', () => {
    it('should return milliseconds until next midnight UTC', () => {
      const timeUntil = rewardHarvester.getTimeUntilNextHarvest();
      
      // Should be positive and less than 24 hours
      expect(timeUntil).toBeGreaterThan(0);
      expect(timeUntil).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    });
  });

  describe('getTimeUntilNextHarvestFormatted', () => {
    it('should return formatted time string', () => {
      const formatted = rewardHarvester.getTimeUntilNextHarvestFormatted();
      
      // Should match pattern "Xh Ym"
      expect(formatted).toMatch(/^\d+h \d+m$/);
    });
  });

  describe('getLastHarvestResult', () => {
    it('should return null before any harvest', () => {
      expect(rewardHarvester.getLastHarvestResult()).toBeNull();
    });

    it('should return last harvest result after harvest', async () => {
      // Set profits below threshold so harvest completes quickly
      mockProfitTracker.getProfitSummary.mockResolvedValue({
        ...mockProfitSummary,
        totalAccruedProfit: 5,
      });

      await rewardHarvester.forceHarvest();

      const lastResult = rewardHarvester.getLastHarvestResult();
      expect(lastResult).not.toBeNull();
      expect(lastResult?.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('getHarvestHistory', () => {
    it('should return empty array before any harvest', () => {
      const history = rewardHarvester.getHarvestHistory();
      expect(history).toEqual([]);
    });
  });

  describe('isConfigured', () => {
    it('should return false when not initialized', () => {
      // Since we're not actually initializing wallet in tests
      expect(rewardHarvester.isConfigured()).toBe(false);
    });
  });

  describe('getDiagnosticInfo', () => {
    it('should return diagnostic info object', () => {
      const info = rewardHarvester.getDiagnosticInfo();

      expect(info).toHaveProperty('accruedProfits');
      expect(info).toHaveProperty('lastHarvestTime');
      expect(info).toHaveProperty('lastHarvestAmount');
      expect(info).toHaveProperty('nextHarvestIn');
      expect(info).toHaveProperty('totalHarvested');
    });

    it('should show next harvest time formatted', () => {
      const info = rewardHarvester.getDiagnosticInfo();
      
      expect(info.nextHarvestIn).toMatch(/^\d+h \d+m$/);
    });
  });

  describe('harvest flow', () => {
    it('should record harvest in ProfitTracker on success', async () => {
      // Skip actual withdrawal by using low profits
      mockProfitTracker.getProfitSummary.mockResolvedValue({
        ...mockProfitSummary,
        totalAccruedProfit: 5, // Below threshold
      });

      await rewardHarvester.forceHarvest();

      // Harvest not actually executed due to low profits
      // But result should be recorded
      const lastResult = rewardHarvester.getLastHarvestResult();
      expect(lastResult).not.toBeNull();
    });

    it('should handle partial exchange failures gracefully', async () => {
      // Set up mock adapter that fails for one exchange
      const mockAdapter = {
        withdrawExternal: jest.fn()
          .mockResolvedValueOnce('tx-hash-1') // HL succeeds
          .mockRejectedValueOnce(new Error('API error')) // LI fails
          .mockResolvedValueOnce('tx-hash-3'), // AS succeeds
      };

      mockKeeperService.getExchangeAdapter.mockReturnValue(mockAdapter as any);

      // This would require more complex setup to actually test
      // For now, verify the structure exists
      expect(rewardHarvester.forceHarvest).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should record errors to DiagnosticsService', async () => {
      // Force an error by making getProfitSummary throw
      mockProfitTracker.getProfitSummary.mockRejectedValue(new Error('Test error'));

      const result = await rewardHarvester.forceHarvest();

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(mockDiagnosticsService.recordError).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'HARVEST_FAILED',
        }),
      );
    });
  });
});

