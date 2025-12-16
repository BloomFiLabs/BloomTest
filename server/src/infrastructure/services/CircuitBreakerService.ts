import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Circuit breaker states
 */
export enum CircuitState {
  CLOSED = 'CLOSED',       // Normal operation - allowing new positions
  OPEN = 'OPEN',           // Blocking new positions due to high error rate
  HALF_OPEN = 'HALF_OPEN', // Testing if system recovered - allowing limited operations
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  errorThresholdPerHour: number;    // Number of errors per hour to trigger OPEN state
  cooldownPeriodMs: number;         // Time to wait before transitioning to HALF_OPEN
  halfOpenMaxAttempts: number;      // Number of successful operations to close circuit
  errorWindowMs: number;            // Time window for counting errors (default: 1 hour)
}

/**
 * Error record for tracking
 */
interface ErrorRecord {
  type: string;
  timestamp: Date;
}

/**
 * CircuitBreakerService - Prevents cascading failures by stopping new position opening
 * when error rates exceed threshold.
 * 
 * States:
 * - CLOSED: Normal operation, all operations allowed
 * - OPEN: High error rate detected, blocking new position opening (reduce-only allowed)
 * - HALF_OPEN: Testing recovery, allowing limited operations
 * 
 * Transitions:
 * - CLOSED -> OPEN: When error count exceeds threshold within the time window
 * - OPEN -> HALF_OPEN: After cooldown period expires
 * - HALF_OPEN -> CLOSED: After N successful operations
 * - HALF_OPEN -> OPEN: On any error during testing
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  
  private state: CircuitState = CircuitState.CLOSED;
  private errors: ErrorRecord[] = [];
  private successCountInHalfOpen = 0;
  private lastStateChangeTime: Date = new Date();
  private openedAt: Date | null = null;
  
  private readonly config: CircuitBreakerConfig;

  constructor(private readonly configService: ConfigService) {
    this.config = {
      errorThresholdPerHour: this.configService.get<number>('CIRCUIT_BREAKER_ERROR_THRESHOLD', 10),
      cooldownPeriodMs: this.configService.get<number>('CIRCUIT_BREAKER_COOLDOWN_MS', 300000), // 5 minutes
      halfOpenMaxAttempts: this.configService.get<number>('CIRCUIT_BREAKER_HALF_OPEN_ATTEMPTS', 3),
      errorWindowMs: this.configService.get<number>('CIRCUIT_BREAKER_ERROR_WINDOW_MS', 3600000), // 1 hour
    };
    
    this.logger.log(
      `CircuitBreaker initialized: threshold=${this.config.errorThresholdPerHour}/hr, ` +
      `cooldown=${this.config.cooldownPeriodMs}ms, halfOpenAttempts=${this.config.halfOpenMaxAttempts}`
    );
  }

  /**
   * Record an error occurrence
   * @param type - Error type identifier (e.g., 'LIGHTER_NONCE_ERROR')
   */
  recordError(type: string): void {
    const now = new Date();
    this.errors.push({ type, timestamp: now });
    
    // Clean up old errors outside the window
    this.pruneOldErrors();
    
    // Check if we need to open the circuit
    if (this.state === CircuitState.CLOSED) {
      const errorCount = this.getErrorCountInWindow();
      if (errorCount >= this.config.errorThresholdPerHour) {
        this.transitionTo(CircuitState.OPEN);
        this.logger.warn(
          `🔴 Circuit OPENED: ${errorCount} errors in last hour (threshold: ${this.config.errorThresholdPerHour})`
        );
      }
    } else if (this.state === CircuitState.HALF_OPEN) {
      // Any error in HALF_OPEN immediately opens the circuit again
      this.transitionTo(CircuitState.OPEN);
      this.logger.warn(
        `🔴 Circuit re-OPENED: Error during HALF_OPEN testing: ${type}`
      );
    }
  }

  /**
   * Record a successful operation
   * Used to track recovery in HALF_OPEN state
   */
  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCountInHalfOpen++;
      
      if (this.successCountInHalfOpen >= this.config.halfOpenMaxAttempts) {
        this.transitionTo(CircuitState.CLOSED);
        this.logger.log(
          `🟢 Circuit CLOSED: ${this.successCountInHalfOpen} successful operations in HALF_OPEN`
        );
      }
    }
  }

  /**
   * Check if new positions can be opened
   * @returns true if circuit allows new position opening
   */
  canOpenNewPosition(): boolean {
    this.checkStateTransition();
    return this.state === CircuitState.CLOSED || this.state === CircuitState.HALF_OPEN;
  }

  /**
   * Check if reduce-only operations are allowed
   * Reduce-only operations (closing positions) are always allowed
   * @returns true (always allowed)
   */
  canClosePosition(): boolean {
    return true; // Reduce-only operations always allowed
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    this.checkStateTransition();
    return this.state;
  }

  /**
   * Get number of errors in the current window
   */
  getErrorCountInWindow(): number {
    this.pruneOldErrors();
    return this.errors.length;
  }

  /**
   * Get diagnostics information
   */
  getDiagnostics(): {
    state: CircuitState;
    errorsThisHour: number;
    threshold: number;
    cooldownRemainingMs: number | null;
    lastStateChange: Date;
    successCountInHalfOpen: number;
  } {
    this.checkStateTransition();
    
    let cooldownRemainingMs: number | null = null;
    if (this.state === CircuitState.OPEN && this.openedAt) {
      const elapsed = Date.now() - this.openedAt.getTime();
      cooldownRemainingMs = Math.max(0, this.config.cooldownPeriodMs - elapsed);
    }
    
    return {
      state: this.state,
      errorsThisHour: this.getErrorCountInWindow(),
      threshold: this.config.errorThresholdPerHour,
      cooldownRemainingMs,
      lastStateChange: this.lastStateChangeTime,
      successCountInHalfOpen: this.successCountInHalfOpen,
    };
  }

  /**
   * Get error breakdown by type
   */
  getErrorBreakdown(): Map<string, number> {
    this.pruneOldErrors();
    const breakdown = new Map<string, number>();
    
    for (const error of this.errors) {
      const count = breakdown.get(error.type) || 0;
      breakdown.set(error.type, count + 1);
    }
    
    return breakdown;
  }

  /**
   * Force circuit to a specific state (for testing/admin purposes)
   */
  forceState(state: CircuitState): void {
    this.logger.warn(`⚠️ Circuit state forced to ${state}`);
    this.transitionTo(state);
  }

  /**
   * Reset the circuit breaker (clear all errors and set to CLOSED)
   */
  reset(): void {
    this.errors = [];
    this.successCountInHalfOpen = 0;
    this.openedAt = null;
    this.transitionTo(CircuitState.CLOSED);
    this.logger.log('🔄 Circuit breaker reset');
  }

  /**
   * Check if state should transition (e.g., OPEN -> HALF_OPEN after cooldown)
   */
  private checkStateTransition(): void {
    if (this.state === CircuitState.OPEN && this.openedAt) {
      const elapsed = Date.now() - this.openedAt.getTime();
      if (elapsed >= this.config.cooldownPeriodMs) {
        this.transitionTo(CircuitState.HALF_OPEN);
        this.logger.log(
          `🟡 Circuit HALF_OPEN: Cooldown period expired, testing recovery...`
        );
      }
    }
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChangeTime = new Date();
    
    if (newState === CircuitState.OPEN) {
      this.openedAt = new Date();
      this.successCountInHalfOpen = 0;
    } else if (newState === CircuitState.HALF_OPEN) {
      this.successCountInHalfOpen = 0;
    } else if (newState === CircuitState.CLOSED) {
      this.openedAt = null;
      this.successCountInHalfOpen = 0;
    }
    
    if (oldState !== newState) {
      this.logger.log(`Circuit state: ${oldState} -> ${newState}`);
    }
  }

  /**
   * Remove errors outside the time window
   */
  private pruneOldErrors(): void {
    const cutoff = Date.now() - this.config.errorWindowMs;
    this.errors = this.errors.filter(e => e.timestamp.getTime() > cutoff);
  }
}


