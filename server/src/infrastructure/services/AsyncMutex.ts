import { Injectable, Logger } from '@nestjs/common';

/**
 * AsyncMutex - Simple async mutex for protecting critical sections
 *
 * Prevents race conditions by ensuring only one async operation
 * can execute a critical section at a time.
 */
@Injectable()
export class AsyncMutex {
  private readonly logger = new Logger(AsyncMutex.name);
  private locked = false;
  private readonly queue: Array<() => void> = [];
  private readonly name: string;
  private lockHolder: string | null = null;
  private lockAcquiredAt: Date | null = null;

  // Timeout to prevent deadlocks (default 30 seconds)
  private readonly timeoutMs: number;

  constructor(name: string = 'default', timeoutMs: number = 30000) {
    this.name = name;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Acquire the mutex lock
   * @param holder Optional identifier for debugging
   */
  async acquire(holder: string = 'unknown'): Promise<void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          this.lockHolder = holder;
          this.lockAcquiredAt = new Date();
          resolve();
        } else {
          // Check for stale lock (deadlock prevention)
          if (this.lockAcquiredAt) {
            const lockAge = Date.now() - this.lockAcquiredAt.getTime();
            if (lockAge > this.timeoutMs) {
              this.logger.warn(
                `[${this.name}] Force releasing stale lock held by ${this.lockHolder} for ${lockAge}ms`,
              );
              this.forceRelease();
              this.locked = true;
              this.lockHolder = holder;
              this.lockAcquiredAt = new Date();
              resolve();
              return;
            }
          }
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  /**
   * Release the mutex lock
   * @param holder Optional identifier to verify correct release
   */
  release(holder?: string): void {
    if (holder && this.lockHolder !== holder) {
      this.logger.warn(
        `[${this.name}] ${holder} tried to release lock held by ${this.lockHolder}`,
      );
      return;
    }

    this.locked = false;
    this.lockHolder = null;
    this.lockAcquiredAt = null;

    // Process next waiter
    const next = this.queue.shift();
    if (next) {
      // Use setImmediate to prevent stack overflow with many waiters
      setImmediate(next);
    }
  }

  /**
   * Force release (for emergency/testing)
   */
  forceRelease(): void {
    this.locked = false;
    this.lockHolder = null;
    this.lockAcquiredAt = null;
    // Clear queue - all waiters will need to retry
    this.queue.length = 0;
  }

  /**
   * Execute a function with the mutex held
   * Automatically acquires and releases the lock
   */
  async runExclusive<T>(
    fn: () => Promise<T>,
    holder: string = 'unknown',
  ): Promise<T> {
    await this.acquire(holder);
    try {
      return await fn();
    } finally {
      this.release(holder);
    }
  }

  /**
   * Check if mutex is currently locked
   */
  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Get current lock holder
   */
  getLockHolder(): string | null {
    return this.lockHolder;
  }

  /**
   * Get lock duration in ms
   */
  getLockDuration(): number | null {
    if (!this.lockAcquiredAt) return null;
    return Date.now() - this.lockAcquiredAt.getTime();
  }

  /**
   * Get queue length
   */
  getQueueLength(): number {
    return this.queue.length;
  }
}

/**
 * Create a simple mutex (non-injectable version)
 */
export function createMutex(
  name: string = 'default',
  timeoutMs: number = 30000,
): AsyncMutex {
  return new AsyncMutex(name, timeoutMs);
}

/**
 * ReadWriteLock - Allows multiple readers but exclusive writers
 */
export class ReadWriteLock {
  private readonly logger = new Logger(ReadWriteLock.name);
  private readers = 0;
  private writer = false;
  private readonly writeQueue: Array<() => void> = [];
  private readonly readQueue: Array<() => void> = [];
  private readonly name: string;

  constructor(name: string = 'default') {
    this.name = name;
  }

  /**
   * Acquire read lock
   */
  async acquireRead(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.writer && this.writeQueue.length === 0) {
        this.readers++;
        resolve();
      } else {
        this.readQueue.push(() => {
          this.readers++;
          resolve();
        });
      }
    });
  }

  /**
   * Release read lock
   */
  releaseRead(): void {
    this.readers--;
    if (this.readers === 0 && this.writeQueue.length > 0) {
      const next = this.writeQueue.shift();
      if (next) setImmediate(next);
    }
  }

  /**
   * Acquire write lock
   */
  async acquireWrite(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.writer && this.readers === 0) {
        this.writer = true;
        resolve();
      } else {
        this.writeQueue.push(() => {
          this.writer = true;
          resolve();
        });
      }
    });
  }

  /**
   * Release write lock
   */
  releaseWrite(): void {
    this.writer = false;
    // Prefer writers over readers to prevent writer starvation
    if (this.writeQueue.length > 0) {
      const next = this.writeQueue.shift();
      if (next) setImmediate(next);
    } else {
      // Release all waiting readers
      while (this.readQueue.length > 0) {
        const next = this.readQueue.shift();
        if (next) setImmediate(next);
      }
    }
  }

  /**
   * Execute a read operation with lock
   */
  async runRead<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireRead();
    try {
      return await fn();
    } finally {
      this.releaseRead();
    }
  }

  /**
   * Execute a write operation with lock
   */
  async runWrite<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireWrite();
    try {
      return await fn();
    } finally {
      this.releaseWrite();
    }
  }
}










