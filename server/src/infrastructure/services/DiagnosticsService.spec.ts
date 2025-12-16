import { Test, TestingModule } from '@nestjs/testing';
import { DiagnosticsService } from './DiagnosticsService';
import { CircuitBreakerService, CircuitState } from './CircuitBreakerService';
import { RateLimiterService } from './RateLimiterService';
import { PositionStateRepository } from '../repositories/PositionStateRepository';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';

describe('DiagnosticsService', () => {
  let service: DiagnosticsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiagnosticsService],
    }).compile();

    service = module.get<DiagnosticsService>(DiagnosticsService);
  });

  describe('basic diagnostics', () => {
    it('should return diagnostics with required fields', () => {
      const diagnostics = service.getDiagnostics();

      expect(diagnostics).toHaveProperty('timestamp');
      expect(diagnostics).toHaveProperty('uptime');
      expect(diagnostics).toHaveProperty('health');
      expect(diagnostics).toHaveProperty('orders');
      expect(diagnostics).toHaveProperty('errors');
      expect(diagnostics).toHaveProperty('positions');
    });

    it('should track uptime', () => {
      const diagnostics = service.getDiagnostics();
      expect(diagnostics.uptime.hours).toBeGreaterThanOrEqual(0);
      expect(diagnostics.uptime.since).toBeInstanceOf(Date);
    });
  });

  describe('error recording', () => {
    it('should record errors', () => {
      service.recordError({
        type: 'TEST_ERROR',
        message: 'Test error message',
        exchange: ExchangeType.LIGHTER,
        symbol: 'ETHUSDT',
        timestamp: new Date(),
      });

      const diagnostics = service.getDiagnostics();
      expect(diagnostics.errors.total.last1h).toBeGreaterThanOrEqual(1);
    });

    it('should track errors by type', () => {
      service.recordError({
        type: 'LIGHTER_NONCE_ERROR',
        message: 'Invalid nonce',
        timestamp: new Date(),
      });

      service.recordError({
        type: 'LIGHTER_NONCE_ERROR',
        message: 'Invalid nonce again',
        timestamp: new Date(),
      });

      const diagnostics = service.getDiagnostics();
      expect(diagnostics.errors.byType['LIGHTER_NONCE_ERROR']).toBeDefined();
      expect(diagnostics.errors.byType['LIGHTER_NONCE_ERROR'].count).toBe(2);
    });
  });

  describe('order recording', () => {
    it('should record placed orders', () => {
      service.recordOrder({
        orderId: 'order-1',
        symbol: 'ETHUSDT',
        exchange: ExchangeType.LIGHTER,
        side: 'LONG',
        placedAt: new Date(),
        status: 'PLACED',
      });

      const diagnostics = service.getDiagnostics();
      expect(diagnostics.orders.last1h.placed).toBeGreaterThanOrEqual(1);
    });

    it('should record filled orders', () => {
      const placedAt = new Date();
      const filledAt = new Date(placedAt.getTime() + 1000);

      service.recordOrder({
        orderId: 'order-2',
        symbol: 'ETHUSDT',
        exchange: ExchangeType.LIGHTER,
        side: 'LONG',
        placedAt,
        filledAt,
        status: 'FILLED',
        fillTimeMs: 1000,
      });

      const diagnostics = service.getDiagnostics();
      expect(diagnostics.orders.last1h.filled).toBeGreaterThanOrEqual(1);
    });
  });

  describe('single-leg tracking', () => {
    it('should record single-leg events', () => {
      service.recordSingleLegStart({
        id: 'single-1',
        symbol: 'ETHUSDT',
        exchange: ExchangeType.LIGHTER,
        side: 'LONG',
        startedAt: new Date(),
        retryCount: 0,
      });

      const diagnostics = service.getDiagnostics();
      expect(diagnostics.singleLegs.active.length).toBeGreaterThanOrEqual(1);
    });

    it('should resolve single-leg events', () => {
      const id = 'single-2';
      
      service.recordSingleLegStart({
        id,
        symbol: 'BTCUSDT',
        exchange: ExchangeType.ASTER,
        side: 'SHORT',
        startedAt: new Date(),
        retryCount: 0,
      });

      service.recordSingleLegResolved(id, 'FILLED');

      const diagnostics = service.getDiagnostics();
      const activeSingleLeg = diagnostics.singleLegs.active.find(
        sl => sl.symbol === 'BTCUSDT' && sl.exchange === ExchangeType.ASTER
      );
      expect(activeSingleLeg).toBeUndefined();
    });
  });

  describe('enhanced diagnostics - circuit breaker', () => {
    it('should include circuit breaker diagnostics when set', () => {
      const mockCircuitBreaker = {
        getDiagnostics: jest.fn().mockReturnValue({
          state: CircuitState.CLOSED,
          errorsThisHour: 5,
          threshold: 10,
          cooldownRemainingMs: null,
        }),
      } as unknown as CircuitBreakerService;

      service.setCircuitBreaker(mockCircuitBreaker);

      const diagnostics = service.getDiagnostics();
      expect(diagnostics.circuitBreaker).toBeDefined();
      expect(diagnostics.circuitBreaker?.state).toBe('CLOSED');
      expect(diagnostics.circuitBreaker?.errorsThisHour).toBe(5);
      expect(diagnostics.circuitBreaker?.threshold).toBe(10);
    });

    it('should not include circuit breaker if not set', () => {
      const diagnostics = service.getDiagnostics();
      expect(diagnostics.circuitBreaker).toBeUndefined();
    });
  });

  describe('enhanced diagnostics - rate limiter', () => {
    it('should include rate limiter diagnostics when set', () => {
      const mockRateLimiter = {
        getAllUsage: jest.fn().mockReturnValue(
          new Map([
            [ExchangeType.LIGHTER, {
              currentRequestsPerSecond: 3,
              maxRequestsPerSecond: 5,
              currentRequestsPerMinute: 50,
              maxRequestsPerMinute: 100,
              queuedRequests: 0,
            }],
          ])
        ),
      } as unknown as RateLimiterService;

      service.setRateLimiter(mockRateLimiter);

      const diagnostics = service.getDiagnostics();
      expect(diagnostics.rateLimiter).toBeDefined();
      expect(diagnostics.rateLimiter?.byExchange[ExchangeType.LIGHTER]).toBeDefined();
      expect(diagnostics.rateLimiter?.byExchange[ExchangeType.LIGHTER].currentPerSecond).toBe(3);
      expect(diagnostics.rateLimiter?.byExchange[ExchangeType.LIGHTER].maxPerSecond).toBe(5);
    });

    it('should not include rate limiter if not set', () => {
      const diagnostics = service.getDiagnostics();
      expect(diagnostics.rateLimiter).toBeUndefined();
    });
  });

  describe('enhanced diagnostics - position state', () => {
    it('should include position state diagnostics when set', () => {
      const mockPositionRepo = {
        getAll: jest.fn().mockReturnValue([
          { id: '1', status: 'COMPLETE' },
          { id: '2', status: 'SINGLE_LEG' },
          { id: '3', status: 'PENDING' },
        ]),
        getStatusCounts: jest.fn().mockReturnValue({
          PENDING: 1,
          COMPLETE: 1,
          SINGLE_LEG: 1,
          CLOSED: 0,
          ERROR: 0,
        }),
      } as unknown as PositionStateRepository;

      service.setPositionStateRepository(mockPositionRepo);

      const diagnostics = service.getDiagnostics();
      expect(diagnostics.positionState).toBeDefined();
      expect(diagnostics.positionState?.persisted).toBe(3);
      expect(diagnostics.positionState?.singleLeg).toBe(1);
      expect(diagnostics.positionState?.pending).toBe(1);
      expect(diagnostics.positionState?.complete).toBe(1);
    });

    it('should not include position state if not set', () => {
      const diagnostics = service.getDiagnostics();
      expect(diagnostics.positionState).toBeUndefined();
    });
  });

  describe('health calculation', () => {
    it('should report OK health with no errors', () => {
      const diagnostics = service.getDiagnostics();
      expect(diagnostics.health.overall).toBe('OK');
      expect(diagnostics.health.issues).toHaveLength(0);
    });

    it('should report DEGRADED health with many errors', () => {
      // Record many errors
      for (let i = 0; i < 15; i++) {
        service.recordError({
          type: 'TEST_ERROR',
          message: `Error ${i}`,
          timestamp: new Date(),
        });
      }

      const diagnostics = service.getDiagnostics();
      // Health should be degraded or critical with many errors
      expect(['DEGRADED', 'CRITICAL']).toContain(diagnostics.health.overall);
    });
  });

  describe('data updates', () => {
    it('should update APY data', () => {
      service.updateApyData({
        estimated: 35.5,
        realized: 28.3,
        byExchange: { LIGHTER: 30.0, ASTER: 25.0 },
      });

      const diagnostics = service.getDiagnostics();
      expect(diagnostics.apy.estimated).toBe(35.5);
      expect(diagnostics.apy.realized).toBe(28.3);
    });

    it('should update position data', () => {
      service.updatePositionData({
        count: 5,
        totalValue: 10000,
        unrealizedPnl: 150,
        byExchange: { LIGHTER: 5000, ASTER: 5000 },
      });

      const diagnostics = service.getDiagnostics();
      expect(diagnostics.positions.count).toBe(5);
      expect(diagnostics.positions.totalValue).toBe(10000);
    });

    it('should update rewards data', () => {
      const harvestTime = new Date();
      service.updateRewardsData({
        accruedProfits: 100,
        lastHarvestTime: harvestTime,
        lastHarvestAmount: 50,
        nextHarvestIn: '23h 45m',
        totalHarvested: 500,
      });

      const diagnostics = service.getDiagnostics();
      expect(diagnostics.rewards.accruedProfits).toBe(100);
      expect(diagnostics.rewards.totalHarvested).toBe(500);
    });
  });
});

