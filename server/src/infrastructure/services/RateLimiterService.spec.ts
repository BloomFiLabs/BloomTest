import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RateLimiterService } from './RateLimiterService';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';

describe('RateLimiterService', () => {
  let service: RateLimiterService;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn().mockReturnValue(undefined),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimiterService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<RateLimiterService>(RateLimiterService);
  });

  afterEach(() => {
    service.resetAll();
  });

  describe('initialization', () => {
    it('should initialize with default limits', () => {
      const lighterLimit = service.getLimit(ExchangeType.LIGHTER);
      expect(lighterLimit).toBeDefined();
      expect(lighterLimit?.maxRequestsPerSecond).toBe(12);
      expect(lighterLimit?.maxRequestsPerMinute).toBe(60);
    });

    it('should have limits for all exchanges', () => {
      const hyperliquidLimit = service.getLimit(ExchangeType.HYPERLIQUID);
      const asterLimit = service.getLimit(ExchangeType.ASTER);

      expect(hyperliquidLimit).toBeDefined();
      expect(asterLimit).toBeDefined();
    });
  });

  describe('acquire', () => {
    it('should allow requests within limit', async () => {
      // Acquire 3 requests (within 5/s limit for Lighter)
      await service.acquire(ExchangeType.LIGHTER);
      await service.acquire(ExchangeType.LIGHTER);
      await service.acquire(ExchangeType.LIGHTER);

      const usage = service.getUsage(ExchangeType.LIGHTER);
      expect(usage.currentWeightPerSecond).toBe(3);
    });

    it('should track per-exchange limits independently', async () => {
      await service.acquire(ExchangeType.LIGHTER);
      await service.acquire(ExchangeType.LIGHTER);
      await service.acquire(ExchangeType.HYPERLIQUID);

      const lighterUsage = service.getUsage(ExchangeType.LIGHTER);
      const hyperliquidUsage = service.getUsage(ExchangeType.HYPERLIQUID);

      expect(lighterUsage.currentWeightPerSecond).toBe(2);
      expect(hyperliquidUsage.currentWeightPerSecond).toBe(1);
    });
  });

  describe('tryAcquire', () => {
    it('should return true when within limits', () => {
      const result = service.tryAcquire(ExchangeType.LIGHTER);
      expect(result).toBe(true);
    });

    it('should return false when at limit', () => {
      // Set a very low limit for testing
      service.setLimit(ExchangeType.LIGHTER, { maxRequestsPerSecond: 2 });

      // Acquire 2 (at limit)
      service.tryAcquire(ExchangeType.LIGHTER);
      service.tryAcquire(ExchangeType.LIGHTER);

      // Third should fail
      const result = service.tryAcquire(ExchangeType.LIGHTER);
      expect(result).toBe(false);
    });
  });

  describe('getUsage', () => {
    it('should return accurate usage statistics', async () => {
      await service.acquire(ExchangeType.LIGHTER);
      await service.acquire(ExchangeType.LIGHTER);

      const usage = service.getUsage(ExchangeType.LIGHTER);

      expect(usage.currentWeightPerSecond).toBe(2);
      expect(usage.currentWeightPerMinute).toBe(2);
      expect(usage.maxWeightPerSecond).toBe(12);
      expect(usage.maxWeightPerMinute).toBe(60);
      expect(usage.queuedRequests).toBe(0);
    });

    it('should return zero for unknown exchange', () => {
      const usage = service.getUsage('UNKNOWN' as ExchangeType);

      expect(usage.currentWeightPerSecond).toBe(0);
      expect(usage.maxWeightPerSecond).toBe(0);
    });
  });

  describe('getAllUsage', () => {
    it('should return usage for all exchanges', async () => {
      await service.acquire(ExchangeType.LIGHTER);
      await service.acquire(ExchangeType.HYPERLIQUID);

      const allUsage = service.getAllUsage();

      expect(allUsage.size).toBeGreaterThan(0);
      expect(allUsage.get(ExchangeType.LIGHTER)?.currentWeightPerSecond).toBe(
        1,
      );
      expect(
        allUsage.get(ExchangeType.HYPERLIQUID)?.currentWeightPerSecond,
      ).toBe(1);
    });
  });

  describe('setLimit', () => {
    it('should update rate limits at runtime', () => {
      service.setLimit(ExchangeType.LIGHTER, {
        maxRequestsPerSecond: 3,
        maxRequestsPerMinute: 50,
      });

      const limit = service.getLimit(ExchangeType.LIGHTER);
      expect(limit?.maxRequestsPerSecond).toBe(3);
      expect(limit?.maxRequestsPerMinute).toBe(50);
    });
  });

  describe('reset', () => {
    it('should clear rate limit counters', async () => {
      await service.acquire(ExchangeType.LIGHTER);
      await service.acquire(ExchangeType.LIGHTER);

      let usage = service.getUsage(ExchangeType.LIGHTER);
      expect(usage.currentWeightPerSecond).toBe(2);

      service.reset(ExchangeType.LIGHTER);

      usage = service.getUsage(ExchangeType.LIGHTER);
      expect(usage.currentWeightPerSecond).toBe(0);
    });
  });

  describe('resetAll', () => {
    it('should clear all rate limit counters', async () => {
      await service.acquire(ExchangeType.LIGHTER);
      await service.acquire(ExchangeType.HYPERLIQUID);

      service.resetAll();

      const lighterUsage = service.getUsage(ExchangeType.LIGHTER);
      const hyperliquidUsage = service.getUsage(ExchangeType.HYPERLIQUID);

      expect(lighterUsage.currentWeightPerSecond).toBe(0);
      expect(hyperliquidUsage.currentWeightPerSecond).toBe(0);
    });
  });

  describe('rate limiting behavior', () => {
    it('should throttle requests when limit exceeded', async () => {
      // Set a very low limit for testing
      service.setLimit(ExchangeType.LIGHTER, {
        maxRequestsPerSecond: 2,
        maxRequestsPerMinute: 100,
      });

      const startTime = Date.now();

      // First 2 requests should be immediate
      await service.acquire(ExchangeType.LIGHTER);
      await service.acquire(ExchangeType.LIGHTER);

      // Third request should wait
      await service.acquire(ExchangeType.LIGHTER);

      const elapsed = Date.now() - startTime;

      // Should have waited at least some time (100ms minimum due to buffer)
      expect(elapsed).toBeGreaterThanOrEqual(100);
    }, 5000);

    it('should allow requests after window expires', async () => {
      service.setLimit(ExchangeType.LIGHTER, {
        maxRequestsPerSecond: 2,
        maxRequestsPerMinute: 100,
      });

      // Acquire 2 (at limit)
      await service.acquire(ExchangeType.LIGHTER);
      await service.acquire(ExchangeType.LIGHTER);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be able to acquire again
      const result = service.tryAcquire(ExchangeType.LIGHTER);
      expect(result).toBe(true);
    }, 5000);
  });

  describe('config overrides', () => {
    it('should apply config overrides on initialization', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'RATE_LIMIT_LIGHTER_PER_SECOND') return 3;
        if (key === 'RATE_LIMIT_LIGHTER_PER_MINUTE') return 50;
        return undefined;
      });

      // Create new service with config
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimiterService,
          { provide: ConfigService, useValue: mockConfigService },
        ],
      }).compile();

      const configuredService =
        module.get<RateLimiterService>(RateLimiterService);
      const limit = configuredService.getLimit(ExchangeType.LIGHTER);

      expect(limit?.maxRequestsPerSecond).toBe(3);
      expect(limit?.maxRequestsPerMinute).toBe(50);
    });
  });
});
