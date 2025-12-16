import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { PositionStateRepository, PersistedPositionState } from './PositionStateRepository';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';

// Mock fs module
jest.mock('fs');

describe('PositionStateRepository', () => {
  let repository: PositionStateRepository;
  let mockConfigService: jest.Mocked<ConfigService>;
  const mockFs = fs as jest.Mocked<typeof fs>;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        if (key === 'POSITION_STATE_DIR') return 'test-data';
        return defaultValue;
      }),
    } as any;

    // Setup fs mocks
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
    mockFs.renameSync.mockReturnValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionStateRepository,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    repository = module.get<PositionStateRepository>(PositionStateRepository);
  });

  describe('generateId', () => {
    it('should generate IDs with correct format', () => {
      const id = repository.generateId('ETHUSDT', ExchangeType.LIGHTER, ExchangeType.ASTER);
      
      expect(id).toContain('ETHUSDT');
      expect(id).toContain('LIGHTER');
      expect(id).toContain('ASTER');
      // Should have a timestamp component
      expect(id.split('-').length).toBeGreaterThanOrEqual(4);
    });

    it('should generate different IDs when called with delay', async () => {
      const id1 = repository.generateId('ETHUSDT', ExchangeType.LIGHTER, ExchangeType.ASTER);
      await new Promise(resolve => setTimeout(resolve, 2));
      const id2 = repository.generateId('ETHUSDT', ExchangeType.LIGHTER, ExchangeType.ASTER);
      
      // IDs should be different due to timestamp
      expect(id1).not.toBe(id2);
    });
  });

  describe('save and get', () => {
    it('should save and retrieve a position state', async () => {
      const state: PersistedPositionState = {
        id: 'test-id-1',
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longFilled: true,
        shortFilled: true,
        positionSize: 1.0,
        positionSizeUsd: 3000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'COMPLETE',
      };

      await repository.save(state);
      const retrieved = repository.get('test-id-1');

      expect(retrieved).toBeDefined();
      expect(retrieved?.symbol).toBe('ETHUSDT');
      expect(retrieved?.status).toBe('COMPLETE');
    });

    it('should update updatedAt on save', async () => {
      const originalDate = new Date('2024-01-01');
      const state: PersistedPositionState = {
        id: 'test-id-2',
        symbol: 'BTCUSDT',
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        longFilled: false,
        shortFilled: false,
        positionSize: 0.1,
        positionSizeUsd: 5000,
        createdAt: originalDate,
        updatedAt: originalDate,
        status: 'PENDING',
      };

      await repository.save(state);
      const retrieved = repository.get('test-id-2');

      expect(retrieved?.updatedAt.getTime()).toBeGreaterThan(originalDate.getTime());
    });
  });

  describe('update', () => {
    it('should update existing position state', async () => {
      const state: PersistedPositionState = {
        id: 'test-id-3',
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longFilled: true,
        shortFilled: false,
        positionSize: 1.0,
        positionSizeUsd: 3000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'SINGLE_LEG',
      };

      await repository.save(state);
      await repository.update('test-id-3', { shortFilled: true, status: 'COMPLETE' });

      const retrieved = repository.get('test-id-3');
      expect(retrieved?.shortFilled).toBe(true);
      expect(retrieved?.status).toBe('COMPLETE');
    });

    it('should not throw for non-existent position', async () => {
      await expect(
        repository.update('non-existent', { status: 'CLOSED' })
      ).resolves.not.toThrow();
    });
  });

  describe('getAll', () => {
    it('should return all positions', async () => {
      await repository.save({
        id: 'pos-1',
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longFilled: true,
        shortFilled: true,
        positionSize: 1.0,
        positionSizeUsd: 3000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'COMPLETE',
      });

      await repository.save({
        id: 'pos-2',
        symbol: 'BTCUSDT',
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        longFilled: true,
        shortFilled: false,
        positionSize: 0.1,
        positionSizeUsd: 5000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'SINGLE_LEG',
      });

      const all = repository.getAll();
      expect(all).toHaveLength(2);
    });
  });

  describe('getByStatus', () => {
    it('should filter by status', async () => {
      await repository.save({
        id: 'complete-1',
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longFilled: true,
        shortFilled: true,
        positionSize: 1.0,
        positionSizeUsd: 3000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'COMPLETE',
      });

      await repository.save({
        id: 'single-leg-1',
        symbol: 'BTCUSDT',
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        longFilled: true,
        shortFilled: false,
        positionSize: 0.1,
        positionSizeUsd: 5000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'SINGLE_LEG',
      });

      const singleLeg = repository.getByStatus('SINGLE_LEG');
      expect(singleLeg).toHaveLength(1);
      expect(singleLeg[0].id).toBe('single-leg-1');
    });
  });

  describe('getActive', () => {
    it('should return non-closed positions', async () => {
      await repository.save({
        id: 'active-1',
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longFilled: true,
        shortFilled: true,
        positionSize: 1.0,
        positionSizeUsd: 3000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'COMPLETE',
      });

      await repository.save({
        id: 'closed-1',
        symbol: 'BTCUSDT',
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        longFilled: true,
        shortFilled: true,
        positionSize: 0.1,
        positionSizeUsd: 5000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'CLOSED',
      });

      const active = repository.getActive();
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('active-1');
    });
  });

  describe('delete', () => {
    it('should delete a position', async () => {
      await repository.save({
        id: 'to-delete',
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longFilled: true,
        shortFilled: true,
        positionSize: 1.0,
        positionSizeUsd: 3000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'COMPLETE',
      });

      expect(repository.get('to-delete')).toBeDefined();
      
      await repository.delete('to-delete');
      
      expect(repository.get('to-delete')).toBeUndefined();
    });
  });

  describe('markClosed', () => {
    it('should mark position as closed', async () => {
      await repository.save({
        id: 'to-close',
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longFilled: true,
        shortFilled: true,
        positionSize: 1.0,
        positionSizeUsd: 3000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'COMPLETE',
      });

      await repository.markClosed('to-close');

      const position = repository.get('to-close');
      expect(position?.status).toBe('CLOSED');
    });
  });

  describe('markSingleLeg', () => {
    it('should mark position as single-leg with correct flags', async () => {
      await repository.save({
        id: 'single-leg',
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longFilled: false,
        shortFilled: false,
        positionSize: 1.0,
        positionSizeUsd: 3000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'PENDING',
      });

      await repository.markSingleLeg('single-leg', true, false);

      const position = repository.get('single-leg');
      expect(position?.status).toBe('SINGLE_LEG');
      expect(position?.longFilled).toBe(true);
      expect(position?.shortFilled).toBe(false);
    });
  });

  describe('incrementRetryCount', () => {
    it('should increment retry count', async () => {
      await repository.save({
        id: 'retry-test',
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longFilled: true,
        shortFilled: false,
        positionSize: 1.0,
        positionSizeUsd: 3000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'SINGLE_LEG',
        retryCount: 0,
      });

      const count1 = await repository.incrementRetryCount('retry-test');
      expect(count1).toBe(1);

      const count2 = await repository.incrementRetryCount('retry-test');
      expect(count2).toBe(2);

      const position = repository.get('retry-test');
      expect(position?.retryCount).toBe(2);
    });
  });

  describe('getStatusCounts', () => {
    it('should return correct counts by status', async () => {
      await repository.save({
        id: 'p1',
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longFilled: true,
        shortFilled: true,
        positionSize: 1.0,
        positionSizeUsd: 3000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'COMPLETE',
      });

      await repository.save({
        id: 'p2',
        symbol: 'BTCUSDT',
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
        longFilled: true,
        shortFilled: false,
        positionSize: 0.1,
        positionSizeUsd: 5000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'SINGLE_LEG',
      });

      await repository.save({
        id: 'p3',
        symbol: 'SOLUSDT',
        longExchange: ExchangeType.ASTER,
        shortExchange: ExchangeType.HYPERLIQUID,
        longFilled: true,
        shortFilled: false,
        positionSize: 10,
        positionSizeUsd: 1000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'SINGLE_LEG',
      });

      const counts = repository.getStatusCounts();
      expect(counts.COMPLETE).toBe(1);
      expect(counts.SINGLE_LEG).toBe(2);
      expect(counts.PENDING).toBe(0);
      expect(counts.CLOSED).toBe(0);
    });
  });

  describe('file persistence', () => {
    it('should call writeFileSync when saving', async () => {
      await repository.save({
        id: 'persist-test',
        symbol: 'ETHUSDT',
        longExchange: ExchangeType.LIGHTER,
        shortExchange: ExchangeType.ASTER,
        longFilled: true,
        shortFilled: true,
        positionSize: 1.0,
        positionSizeUsd: 3000,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'COMPLETE',
      });

      expect(mockFs.writeFileSync).toHaveBeenCalled();
      expect(mockFs.renameSync).toHaveBeenCalled();
    });
  });

  describe('loading from file', () => {
    it('should load positions from file on init', async () => {
      const savedPositions = [
        {
          id: 'loaded-1',
          symbol: 'ETHUSDT',
          longExchange: 'LIGHTER',
          shortExchange: 'ASTER',
          longFilled: true,
          shortFilled: true,
          positionSize: 1.0,
          positionSizeUsd: 3000,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          status: 'COMPLETE',
        },
      ];

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(savedPositions));

      // Create new repository to trigger onModuleInit
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PositionStateRepository,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const newRepo = module.get<PositionStateRepository>(PositionStateRepository);
      await newRepo.onModuleInit();

      const loaded = newRepo.get('loaded-1');
      expect(loaded).toBeDefined();
      expect(loaded?.symbol).toBe('ETHUSDT');
    });

    it('should handle corrupted state file gracefully', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json {{{');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PositionStateRepository,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const newRepo = module.get<PositionStateRepository>(PositionStateRepository);
      
      // Should not throw
      await expect(newRepo.onModuleInit()).resolves.not.toThrow();
      
      // Should start with empty state
      expect(newRepo.getAll()).toHaveLength(0);
    });
  });
});

