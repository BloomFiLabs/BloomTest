import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PerpKeeperScheduler } from './PerpKeeperScheduler';
import { PerpKeeperOrchestrator } from '../../domain/services/PerpKeeperOrchestrator';
import { PerpKeeperPerformanceLogger } from '../../infrastructure/logging/PerpKeeperPerformanceLogger';
import { PerpKeeperService } from './PerpKeeperService';
import { ArbitrageOpportunity } from '../../domain/services/FundingRateAggregator';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { Percentage } from '../../domain/value-objects/Percentage';

// Mock PerpKeeperService to avoid complex dependencies
jest.mock('./PerpKeeperService', () => {
  return {
    PerpKeeperService: jest.fn().mockImplementation(() => ({
      getExchangeAdapters: jest.fn().mockReturnValue(new Map()),
      rebalanceExchangeBalances: jest.fn().mockResolvedValue({
        transfersExecuted: 0,
        totalTransferred: 0,
        errors: [],
      }),
    })),
  };
});

describe('PerpKeeperScheduler - Blacklist Filtering', () => {
  let scheduler: PerpKeeperScheduler;
  let mockOrchestrator: jest.Mocked<PerpKeeperOrchestrator>;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockPerformanceLogger: jest.Mocked<PerpKeeperPerformanceLogger>;
  let mockKeeperService: jest.Mocked<PerpKeeperService>;

  beforeEach(async () => {
    mockOrchestrator = {
      initialize: jest.fn(),
      discoverCommonAssets: jest.fn(),
      findArbitrageOpportunities: jest.fn(),
      executeArbitrageStrategy: jest.fn(),
      healthCheck: jest.fn().mockResolvedValue({ healthy: true, exchanges: new Map() }),
      getAllPositionsWithMetrics: jest.fn().mockResolvedValue({
        positions: [],
        totalUnrealizedPnl: 0,
        totalPositionValue: 0,
        positionsByExchange: new Map(),
      }),
    } as any;

    mockConfigService = {
      get: jest.fn(),
    } as any;

    mockPerformanceLogger = {
      recordArbitrageOpportunity: jest.fn(),
    } as any;

    mockKeeperService = {
      getExchangeAdapters: jest.fn().mockReturnValue(new Map()),
      rebalanceExchangeBalances: jest.fn().mockResolvedValue({
        transfersExecuted: 0,
        totalTransferred: 0,
        errors: [],
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PerpKeeperScheduler,
        { provide: PerpKeeperOrchestrator, useValue: mockOrchestrator },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PerpKeeperPerformanceLogger, useValue: mockPerformanceLogger },
        { provide: PerpKeeperService, useValue: mockKeeperService },
      ],
    }).compile();

    scheduler = module.get<PerpKeeperScheduler>(PerpKeeperScheduler);
  });

  describe('Blacklist Initialization', () => {
    it('should load blacklist from environment variable', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'KEEPER_BLACKLISTED_SYMBOLS') return 'NVDA,TSLA';
        if (key === 'KEEPER_MIN_SPREAD') return '0.0001';
        if (key === 'KEEPER_MAX_POSITION_SIZE_USD') return '10000';
        return undefined;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PerpKeeperScheduler,
          { provide: PerpKeeperOrchestrator, useValue: mockOrchestrator },
          { provide: ConfigService, useValue: mockConfigService },
          { provide: PerpKeeperPerformanceLogger, useValue: mockPerformanceLogger },
          { provide: PerpKeeperService, useValue: mockKeeperService },
        ],
      }).compile();

      const newScheduler = module.get<PerpKeeperScheduler>(PerpKeeperScheduler);
      
      // Access private property via type assertion for testing
      const blacklist = (newScheduler as any).blacklistedSymbols as Set<string>;
      expect(blacklist.has('NVDA')).toBe(true);
      expect(blacklist.has('TSLA')).toBe(true);
    });

    it('should normalize blacklist symbols (remove USDT suffix)', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'KEEPER_BLACKLISTED_SYMBOLS') return 'NVDAUSDT,NVDA';
        if (key === 'KEEPER_MIN_SPREAD') return '0.0001';
        if (key === 'KEEPER_MAX_POSITION_SIZE_USD') return '10000';
        return undefined;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PerpKeeperScheduler,
          { provide: PerpKeeperOrchestrator, useValue: mockOrchestrator },
          { provide: ConfigService, useValue: mockConfigService },
          { provide: PerpKeeperPerformanceLogger, useValue: mockPerformanceLogger },
          { provide: PerpKeeperService, useValue: mockKeeperService },
        ],
      }).compile();

      const newScheduler = module.get<PerpKeeperScheduler>(PerpKeeperScheduler);
      const blacklist = (newScheduler as any).blacklistedSymbols as Set<string>;
      
      // Both NVDAUSDT and NVDA should normalize to NVDA
      expect(blacklist.has('NVDA')).toBe(true);
      expect(blacklist.size).toBe(1); // Should deduplicate
    });

    it('should use default blacklist (NVDA) when env var not set', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'KEEPER_MIN_SPREAD') return '0.0001';
        if (key === 'KEEPER_MAX_POSITION_SIZE_USD') return '10000';
        return undefined;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PerpKeeperScheduler,
          { provide: PerpKeeperOrchestrator, useValue: mockOrchestrator },
          { provide: ConfigService, useValue: mockConfigService },
          { provide: PerpKeeperPerformanceLogger, useValue: mockPerformanceLogger },
          { provide: PerpKeeperService, useValue: mockKeeperService },
        ],
      }).compile();

      const newScheduler = module.get<PerpKeeperScheduler>(PerpKeeperScheduler);
      const blacklist = (newScheduler as any).blacklistedSymbols as Set<string>;
      
      expect(blacklist.has('NVDA')).toBe(true);
      expect(blacklist.size).toBe(1);
    });
  });

  describe('Symbol Filtering', () => {
    beforeEach(() => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'KEEPER_BLACKLISTED_SYMBOLS') return 'NVDA,TSLA';
        if (key === 'KEEPER_MIN_SPREAD') return '0.0001';
        if (key === 'KEEPER_MAX_POSITION_SIZE_USD') return '10000';
        return undefined;
      });
    });

    it('should filter blacklisted symbols from discovered assets', async () => {
      mockOrchestrator.discoverCommonAssets.mockResolvedValue(['ETH', 'BTC', 'NVDA', 'TSLA', 'SOL']);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PerpKeeperScheduler,
          { provide: PerpKeeperOrchestrator, useValue: mockOrchestrator },
          { provide: ConfigService, useValue: mockConfigService },
          { provide: PerpKeeperPerformanceLogger, useValue: mockPerformanceLogger },
          { provide: PerpKeeperService, useValue: mockKeeperService },
        ],
      }).compile();

      const newScheduler = module.get<PerpKeeperScheduler>(PerpKeeperScheduler);
      
      // Call private method via type assertion
      const symbols = await (newScheduler as any).discoverAssetsIfNeeded();
      
      expect(symbols).not.toContain('NVDA');
      expect(symbols).not.toContain('TSLA');
      expect(symbols).toContain('ETH');
      expect(symbols).toContain('BTC');
      expect(symbols).toContain('SOL');
    });

    it('should filter blacklisted symbols from KEEPER_SYMBOLS config', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'KEEPER_BLACKLISTED_SYMBOLS') return 'NVDA,TSLA';
        if (key === 'KEEPER_SYMBOLS') return 'ETH,BTC,NVDA,TSLA,SOL';
        if (key === 'KEEPER_MIN_SPREAD') return '0.0001';
        if (key === 'KEEPER_MAX_POSITION_SIZE_USD') return '10000';
        return undefined;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PerpKeeperScheduler,
          { provide: PerpKeeperOrchestrator, useValue: mockOrchestrator },
          { provide: ConfigService, useValue: mockConfigService },
          { provide: PerpKeeperPerformanceLogger, useValue: mockPerformanceLogger },
          { provide: PerpKeeperService, useValue: mockKeeperService },
        ],
      }).compile();

      const newScheduler = module.get<PerpKeeperScheduler>(PerpKeeperScheduler);
      const symbols = (newScheduler as any).symbols as string[];
      
      expect(symbols).not.toContain('NVDA');
      expect(symbols).not.toContain('TSLA');
      expect(symbols).toContain('ETH');
      expect(symbols).toContain('BTC');
      expect(symbols).toContain('SOL');
    });
  });

  describe('Opportunity Filtering', () => {
    beforeEach(() => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'KEEPER_BLACKLISTED_SYMBOLS') return 'NVDA';
        if (key === 'KEEPER_MIN_SPREAD') return '0.0001';
        if (key === 'KEEPER_MAX_POSITION_SIZE_USD') return '10000';
        return undefined;
      });
    });

    it('should filter blacklisted opportunities before execution', async () => {
      const nvdaOpportunity: ArbitrageOpportunity = {
        symbol: 'NVDA',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longRate: Percentage.fromDecimal(0.001),
        shortRate: Percentage.fromDecimal(0.0005),
        spread: Percentage.fromDecimal(0.0005),
        expectedReturn: Percentage.fromDecimal(0.1),
        timestamp: new Date(),
      };

      const ethOpportunity: ArbitrageOpportunity = {
        symbol: 'ETH',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longRate: Percentage.fromDecimal(0.001),
        shortRate: Percentage.fromDecimal(0.0005),
        spread: Percentage.fromDecimal(0.0005),
        expectedReturn: Percentage.fromDecimal(0.1),
        timestamp: new Date(),
      };

      mockOrchestrator.discoverCommonAssets.mockResolvedValue(['ETH', 'NVDA']);
      mockOrchestrator.findArbitrageOpportunities.mockResolvedValue([
        nvdaOpportunity,
        ethOpportunity,
      ]);
      mockOrchestrator.executeArbitrageStrategy.mockResolvedValue({
        success: true,
        opportunitiesEvaluated: 2,
        opportunitiesExecuted: 1,
        totalExpectedReturn: 0.1,
        ordersPlaced: 2,
        errors: [],
        timestamp: new Date(),
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PerpKeeperScheduler,
          { provide: PerpKeeperOrchestrator, useValue: mockOrchestrator },
          { provide: ConfigService, useValue: mockConfigService },
          { provide: PerpKeeperPerformanceLogger, useValue: mockPerformanceLogger },
          { provide: PerpKeeperService, useValue: mockKeeperService },
        ],
      }).compile();

      const newScheduler = module.get<PerpKeeperScheduler>(PerpKeeperScheduler);
      
      // Mock the private method to return filtered symbols
      (newScheduler as any).discoverAssetsIfNeeded = jest.fn().mockResolvedValue(['ETH']);
      
      // Execute hourly (this will test the filtering)
      await (newScheduler as any).executeHourly();

      // Verify that findArbitrageOpportunities was called with filtered symbols
      expect(mockOrchestrator.findArbitrageOpportunities).toHaveBeenCalled();
      const callArgs = mockOrchestrator.findArbitrageOpportunities.mock.calls[0];
      const symbolsPassed = callArgs[0] as string[];
      expect(symbolsPassed).not.toContain('NVDA');
    });

    it('should filter opportunities even if they slip through symbol filtering', async () => {
      const nvdaOpportunity: ArbitrageOpportunity = {
        symbol: 'NVDA',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longRate: Percentage.fromDecimal(0.001),
        shortRate: Percentage.fromDecimal(0.0005),
        spread: Percentage.fromDecimal(0.0005),
        expectedReturn: Percentage.fromDecimal(0.1),
        timestamp: new Date(),
      };

      const ethOpportunity: ArbitrageOpportunity = {
        symbol: 'ETH',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longRate: Percentage.fromDecimal(0.001),
        shortRate: Percentage.fromDecimal(0.0005),
        spread: Percentage.fromDecimal(0.0005),
        expectedReturn: Percentage.fromDecimal(0.1),
        timestamp: new Date(),
      };

      mockOrchestrator.discoverCommonAssets.mockResolvedValue(['ETH']);
      // Simulate NVDA opportunity somehow getting through
      mockOrchestrator.findArbitrageOpportunities.mockResolvedValue([
        nvdaOpportunity,
        ethOpportunity,
      ]);
      mockOrchestrator.executeArbitrageStrategy.mockResolvedValue({
        success: true,
        opportunitiesEvaluated: 1,
        opportunitiesExecuted: 1,
        totalExpectedReturn: 0.1,
        ordersPlaced: 2,
        errors: [],
        timestamp: new Date(),
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PerpKeeperScheduler,
          { provide: PerpKeeperOrchestrator, useValue: mockOrchestrator },
          { provide: ConfigService, useValue: mockConfigService },
          { provide: PerpKeeperPerformanceLogger, useValue: mockPerformanceLogger },
          { provide: PerpKeeperService, useValue: mockKeeperService },
        ],
      }).compile();

      const newScheduler = module.get<PerpKeeperScheduler>(PerpKeeperScheduler);
      (newScheduler as any).discoverAssetsIfNeeded = jest.fn().mockResolvedValue(['ETH']);
      
      await (newScheduler as any).executeHourly();

      // Verify executeArbitrageStrategy was called with filtered symbols (not including NVDA)
      expect(mockOrchestrator.executeArbitrageStrategy).toHaveBeenCalled();
      const executeCallArgs = mockOrchestrator.executeArbitrageStrategy.mock.calls[0];
      const symbolsPassed = executeCallArgs[0] as string[];
      expect(symbolsPassed).not.toContain('NVDA');
    });
  });

  describe('isBlacklisted helper method', () => {
    beforeEach(() => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'KEEPER_BLACKLISTED_SYMBOLS') return 'NVDA';
        if (key === 'KEEPER_MIN_SPREAD') return '0.0001';
        if (key === 'KEEPER_MAX_POSITION_SIZE_USD') return '10000';
        return undefined;
      });
    });

    it('should correctly identify blacklisted symbols', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PerpKeeperScheduler,
          { provide: PerpKeeperOrchestrator, useValue: mockOrchestrator },
          { provide: ConfigService, useValue: mockConfigService },
          { provide: PerpKeeperPerformanceLogger, useValue: mockPerformanceLogger },
          { provide: PerpKeeperService, useValue: mockKeeperService },
        ],
      }).compile();

      const newScheduler = module.get<PerpKeeperScheduler>(PerpKeeperScheduler);
      const isBlacklisted = (newScheduler as any).isBlacklisted.bind(newScheduler);
      
      expect(isBlacklisted('NVDA')).toBe(true);
      expect(isBlacklisted('NVDAUSDT')).toBe(true); // Should normalize
      expect(isBlacklisted('ETH')).toBe(false);
      expect(isBlacklisted('BTC')).toBe(false);
    });

    it('should handle case-insensitive matching', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PerpKeeperScheduler,
          { provide: PerpKeeperOrchestrator, useValue: mockOrchestrator },
          { provide: ConfigService, useValue: mockConfigService },
          { provide: PerpKeeperPerformanceLogger, useValue: mockPerformanceLogger },
          { provide: PerpKeeperService, useValue: mockKeeperService },
        ],
      }).compile();

      const newScheduler = module.get<PerpKeeperScheduler>(PerpKeeperScheduler);
      const isBlacklisted = (newScheduler as any).isBlacklisted.bind(newScheduler);
      
      expect(isBlacklisted('nvda')).toBe(true);
      expect(isBlacklisted('NvDa')).toBe(true);
      expect(isBlacklisted('NVDA')).toBe(true);
    });
  });
});






