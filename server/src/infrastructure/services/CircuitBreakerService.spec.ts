import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService, CircuitState } from './CircuitBreakerService';

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    jest.useFakeTimers();
    
    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          'CIRCUIT_BREAKER_ERROR_THRESHOLD': 10,
          'CIRCUIT_BREAKER_COOLDOWN_MS': 300000, // 5 minutes
          'CIRCUIT_BREAKER_HALF_OPEN_ATTEMPTS': 3,
          'CIRCUIT_BREAKER_ERROR_WINDOW_MS': 3600000, // 1 hour
        };
        return config[key] ?? defaultValue;
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircuitBreakerService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<CircuitBreakerService>(CircuitBreakerService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      expect(service.getState()).toBe(CircuitState.CLOSED);
    });

    it('should allow new positions when CLOSED', () => {
      expect(service.canOpenNewPosition()).toBe(true);
    });

    it('should have zero errors initially', () => {
      expect(service.getErrorCountInWindow()).toBe(0);
    });
  });

  describe('CLOSED -> OPEN transition', () => {
    it('should open circuit when error threshold exceeded', () => {
      // Record 9 errors (below threshold of 10)
      for (let i = 0; i < 9; i++) {
        service.recordError('TEST_ERROR');
      }
      
      // Still closed below threshold
      expect(service.getState()).toBe(CircuitState.CLOSED);
      
      // 10th error hits threshold and opens the circuit
      service.recordError('TEST_ERROR');
      expect(service.getState()).toBe(CircuitState.OPEN);
      expect(service.canOpenNewPosition()).toBe(false);
    });

    it('should track different error types', () => {
      for (let i = 0; i < 5; i++) {
        service.recordError('LIGHTER_NONCE_ERROR');
      }
      for (let i = 0; i < 6; i++) {
        service.recordError('HYPERLIQUID_ORDER_FAILED');
      }
      
      expect(service.getState()).toBe(CircuitState.OPEN);
      
      const breakdown = service.getErrorBreakdown();
      expect(breakdown.get('LIGHTER_NONCE_ERROR')).toBe(5);
      expect(breakdown.get('HYPERLIQUID_ORDER_FAILED')).toBe(6);
    });

    it('should not open circuit if errors are spread over time window and old ones expire', () => {
      // Record 5 errors
      for (let i = 0; i < 5; i++) {
        service.recordError('TEST_ERROR');
      }
      
      // Advance time by 50 minutes
      jest.advanceTimersByTime(50 * 60 * 1000);
      
      // Record 4 more errors
      for (let i = 0; i < 4; i++) {
        service.recordError('TEST_ERROR');
      }
      
      // 9 errors total, still below threshold
      expect(service.getState()).toBe(CircuitState.CLOSED);
      
      // Advance another 15 minutes (first 5 errors are now > 1 hour old)
      jest.advanceTimersByTime(15 * 60 * 1000);
      
      // Now only 4 errors remain in window
      expect(service.getErrorCountInWindow()).toBe(4);
      expect(service.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('OPEN -> HALF_OPEN transition', () => {
    it('should transition to HALF_OPEN after cooldown', () => {
      // Open the circuit
      for (let i = 0; i < 11; i++) {
        service.recordError('TEST_ERROR');
      }
      expect(service.getState()).toBe(CircuitState.OPEN);
      
      // Advance time past cooldown (5 minutes)
      jest.advanceTimersByTime(300001);
      
      // Should transition to HALF_OPEN on next check
      expect(service.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('should report correct cooldown remaining', () => {
      // Open the circuit
      for (let i = 0; i < 11; i++) {
        service.recordError('TEST_ERROR');
      }
      
      // Advance 2 minutes
      jest.advanceTimersByTime(120000);
      
      const diagnostics = service.getDiagnostics();
      expect(diagnostics.state).toBe(CircuitState.OPEN);
      // Should have ~3 minutes remaining (180000ms)
      expect(diagnostics.cooldownRemainingMs).toBeLessThanOrEqual(180000);
      expect(diagnostics.cooldownRemainingMs).toBeGreaterThan(170000);
    });

    it('should allow new positions in HALF_OPEN', () => {
      // Open the circuit
      for (let i = 0; i < 11; i++) {
        service.recordError('TEST_ERROR');
      }
      
      // Advance past cooldown
      jest.advanceTimersByTime(300001);
      
      expect(service.getState()).toBe(CircuitState.HALF_OPEN);
      expect(service.canOpenNewPosition()).toBe(true);
    });
  });

  describe('HALF_OPEN -> CLOSED transition', () => {
    it('should close circuit after successful operations in HALF_OPEN', () => {
      // Open the circuit
      for (let i = 0; i < 11; i++) {
        service.recordError('TEST_ERROR');
      }
      
      // Advance past cooldown
      jest.advanceTimersByTime(300001);
      expect(service.getState()).toBe(CircuitState.HALF_OPEN);
      
      // Record 3 successful operations
      for (let i = 0; i < 3; i++) {
        service.recordSuccess();
      }
      
      expect(service.getState()).toBe(CircuitState.CLOSED);
    });

    it('should not close circuit before required successes', () => {
      // Open and transition to HALF_OPEN
      for (let i = 0; i < 11; i++) {
        service.recordError('TEST_ERROR');
      }
      jest.advanceTimersByTime(300001);
      
      // Only 2 successes
      service.recordSuccess();
      service.recordSuccess();
      
      expect(service.getState()).toBe(CircuitState.HALF_OPEN);
    });
  });

  describe('HALF_OPEN -> OPEN transition', () => {
    it('should re-open circuit on error during HALF_OPEN', () => {
      // Open and transition to HALF_OPEN
      for (let i = 0; i < 11; i++) {
        service.recordError('TEST_ERROR');
      }
      jest.advanceTimersByTime(300001);
      expect(service.getState()).toBe(CircuitState.HALF_OPEN);
      
      // Record an error
      service.recordError('NEW_ERROR');
      
      expect(service.getState()).toBe(CircuitState.OPEN);
    });

    it('should reset success count when re-opening', () => {
      // Open and transition to HALF_OPEN
      for (let i = 0; i < 10; i++) {
        service.recordError('TEST_ERROR');
      }
      jest.advanceTimersByTime(300001);
      expect(service.getState()).toBe(CircuitState.HALF_OPEN);
      
      // Record 2 successes
      service.recordSuccess();
      service.recordSuccess();
      expect(service.getDiagnostics().successCountInHalfOpen).toBe(2);
      
      // Error re-opens - need to record an error that pushes us over threshold again
      // The old errors are still in window, so this one error should trigger re-open
      service.recordError('ERROR');
      expect(service.getState()).toBe(CircuitState.OPEN);
      
      // Wait for cooldown again
      jest.advanceTimersByTime(300001);
      expect(service.getState()).toBe(CircuitState.HALF_OPEN);
      
      // Success count should be reset
      const diagnostics = service.getDiagnostics();
      expect(diagnostics.successCountInHalfOpen).toBe(0);
    });
  });

  describe('reduce-only operations', () => {
    it('should allow reduce-only operations when circuit is OPEN', () => {
      // Open the circuit
      for (let i = 0; i < 11; i++) {
        service.recordError('TEST_ERROR');
      }
      expect(service.getState()).toBe(CircuitState.OPEN);
      
      // Reduce-only should always be allowed
      expect(service.canClosePosition()).toBe(true);
    });

    it('should allow reduce-only operations in all states', () => {
      expect(service.canClosePosition()).toBe(true);
      
      // Open circuit
      for (let i = 0; i < 11; i++) {
        service.recordError('TEST_ERROR');
      }
      expect(service.canClosePosition()).toBe(true);
      
      // HALF_OPEN
      jest.advanceTimersByTime(300001);
      expect(service.canClosePosition()).toBe(true);
    });
  });

  describe('error window pruning', () => {
    it('should reset error count at hour boundary', () => {
      // Record errors
      for (let i = 0; i < 8; i++) {
        service.recordError('TEST_ERROR');
      }
      expect(service.getErrorCountInWindow()).toBe(8);
      
      // Advance past the error window (1 hour)
      jest.advanceTimersByTime(3600001);
      
      // Errors should be pruned
      expect(service.getErrorCountInWindow()).toBe(0);
    });

    it('should prune old errors while keeping recent ones', () => {
      // Record 5 errors
      for (let i = 0; i < 5; i++) {
        service.recordError('OLD_ERROR');
      }
      
      // Advance 45 minutes
      jest.advanceTimersByTime(45 * 60 * 1000);
      
      // Record 3 more errors
      for (let i = 0; i < 3; i++) {
        service.recordError('NEW_ERROR');
      }
      
      expect(service.getErrorCountInWindow()).toBe(8);
      
      // Advance 20 more minutes (old errors now > 1 hour old)
      jest.advanceTimersByTime(20 * 60 * 1000);
      
      // Only new errors should remain
      expect(service.getErrorCountInWindow()).toBe(3);
    });
  });

  describe('diagnostics', () => {
    it('should return complete diagnostics', () => {
      const diagnostics = service.getDiagnostics();
      
      expect(diagnostics).toHaveProperty('state');
      expect(diagnostics).toHaveProperty('errorsThisHour');
      expect(diagnostics).toHaveProperty('threshold');
      expect(diagnostics).toHaveProperty('cooldownRemainingMs');
      expect(diagnostics).toHaveProperty('lastStateChange');
      expect(diagnostics).toHaveProperty('successCountInHalfOpen');
    });

    it('should show null cooldown when not in OPEN state', () => {
      const diagnostics = service.getDiagnostics();
      expect(diagnostics.cooldownRemainingMs).toBeNull();
    });
  });

  describe('reset', () => {
    it('should reset circuit to initial state', () => {
      // Open the circuit
      for (let i = 0; i < 11; i++) {
        service.recordError('TEST_ERROR');
      }
      expect(service.getState()).toBe(CircuitState.OPEN);
      
      // Reset
      service.reset();
      
      expect(service.getState()).toBe(CircuitState.CLOSED);
      expect(service.getErrorCountInWindow()).toBe(0);
      expect(service.canOpenNewPosition()).toBe(true);
    });
  });

  describe('forceState', () => {
    it('should allow forcing state for admin purposes', () => {
      expect(service.getState()).toBe(CircuitState.CLOSED);
      
      service.forceState(CircuitState.OPEN);
      expect(service.getState()).toBe(CircuitState.OPEN);
      
      service.forceState(CircuitState.HALF_OPEN);
      expect(service.getState()).toBe(CircuitState.HALF_OPEN);
      
      service.forceState(CircuitState.CLOSED);
      expect(service.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('concurrent error recording', () => {
    it('should handle rapid error recording', () => {
      // Simulate rapid errors
      for (let i = 0; i < 100; i++) {
        service.recordError(`ERROR_${i % 5}`);
      }
      
      expect(service.getState()).toBe(CircuitState.OPEN);
      expect(service.getErrorCountInWindow()).toBe(100);
    });
  });
});

