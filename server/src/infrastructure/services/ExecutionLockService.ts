import { Injectable, Logger } from '@nestjs/common';

/**
 * ActiveOrder - Represents an order currently being tracked
 */
export interface ActiveOrder {
  orderId: string;
  symbol: string;
  exchange: string;
  side: 'LONG' | 'SHORT';
  threadId: string;
  placedAt: Date;
  status:
    | 'PLACING'
    | 'PLACED'
    | 'WAITING_FILL'
    | 'FILLED'
    | 'FAILED'
    | 'CANCELLED';
  size?: number;
  price?: number;
  reduceOnly?: boolean;
  isForceFilling?: boolean; // New flag: tells MakerEfficiencyService to stop managing this order
  initialPositionSize?: number; // Position size when order was placed (for fill detection)
}

/**
 * ExecutionLockService - Prevents concurrent execution on the same symbol
 *
 * This service prevents race conditions where multiple threads/intervals
 * try to execute trades on the same symbol simultaneously, which can cause:
 * - Duplicate orders being placed
 * - Pre-flight cancellation of another thread's orders
 * - Orphaned orders on order books
 * - Nonce conflicts on blockchain-based exchanges
 *
 * Also provides:
 * - Global order registry for tracking all active orders across threads
 * - Symbol-level locking to prevent concurrent execution on the same symbol
 * - Global execution lock for strategy-level coordination
 */
@Injectable()
export class ExecutionLockService {
  private readonly logger = new Logger(ExecutionLockService.name);

  // Symbol-level locks: tracks which symbols are currently being executed
  private readonly executingSymbols: Map<
    string,
    {
      startedAt: Date;
      threadId: string;
      operation: string;
    }
  > = new Map();

  // Global execution lock: prevents multiple strategy executions from running concurrently
  private globalExecutionLock = false;
  private globalLockHolder: string | null = null;
  private globalLockStartedAt: Date | null = null;

  // Active orders registry: tracks all orders currently being placed or waiting for fill
  // Key format: "EXCHANGE:SYMBOL:SIDE" (e.g., "LIGHTER:ETH:LONG")
  private readonly activeOrders: Map<string, ActiveOrder> = new Map();

  // Order history for debugging (last 100 orders)
  private readonly orderHistory: ActiveOrder[] = [];
  private readonly MAX_ORDER_HISTORY = 100;
  
  // Track when execution last completed for each symbol (for reconciliation cooldown)
  private readonly executionCompletedAt: Map<string, number> = new Map();

  // Active execution progress tracking for TUI
  private currentExecution: {
    symbol: string;
    operation: string; // 'SLICING', 'FILLING_LEG_A', 'FILLING_LEG_B', 'ROLLBACK', 'COMPLETE'
    currentSlice: number;
    totalSlices: number;
    legAExchange: string;
    legBExchange: string;
    legAStatus: string;
    legBStatus: string;
    startedAt: Date;
    lastUpdate: Date;
  } | null = null;

  // Timeout for stale locks (2 minutes - reduced from 5 to prevent long blocking)
  private readonly LOCK_TIMEOUT_MS = 2 * 60 * 1000;

  // Shorter timeout for symbol locks (30 seconds - individual trades should be fast)
  private readonly SYMBOL_LOCK_TIMEOUT_MS = 30 * 1000;

  // Timeout for stale orders (10 minutes)
  private readonly ORDER_TIMEOUT_MS = 10 * 60 * 1000;

  // Counter for generating unique thread IDs
  private threadCounter = 0;

  // Priority levels for operations (higher = more important)
  private readonly PRIORITY_SAFETY = 100;
  private readonly PRIORITY_REBALANCE = 50;
  private readonly PRIORITY_NORMAL = 10;
  
  // Queue for operations waiting for global lock (priority queue)
  private readonly lockQueue: Array<{
    threadId: string;
    priority: number;
    operation: string;
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  /**
   * Generate a unique thread ID for tracking
   */
  generateThreadId(): string {
    return `thread-${++this.threadCounter}-${Date.now()}`;
  }


  /**
   * Try to acquire global execution lock
   */
  tryAcquireGlobalLock(threadId: string, operation: string): boolean {
    // Check for stale lock
    if (this.globalExecutionLock && this.globalLockStartedAt) {
      const lockAge = Date.now() - this.globalLockStartedAt.getTime();
      if (lockAge > this.LOCK_TIMEOUT_MS) {
        this.logger.warn(
          `🔓 Releasing stale global lock held by ${this.globalLockHolder} for ${Math.round(lockAge / 1000)}s`,
        );
        this.releaseGlobalLock(this.globalLockHolder!);
      }
    }

    if (this.globalExecutionLock) {
      this.logger.debug(
        `⏳ Global lock already held by ${this.globalLockHolder} - ${operation} must wait`,
      );
      return false;
    }

    this.globalExecutionLock = true;
    this.globalLockHolder = threadId;
    this.globalLockStartedAt = new Date();
    this.logger.debug(
      `🔒 Global lock acquired by ${threadId} for ${operation}`,
    );
    return true;
  }

  /**
   * Release global execution lock
   */
  releaseGlobalLock(threadId: string): void {
    if (this.globalLockHolder !== threadId) {
      this.logger.warn(
        `⚠️ Thread ${threadId} tried to release global lock held by ${this.globalLockHolder}`,
      );
      return;
    }

    this.globalExecutionLock = false;
    this.globalLockHolder = null;
    this.globalLockStartedAt = null;
    this.logger.debug(`🔓 Global lock released by ${threadId}`);
  }

  /**
   * Check if global lock is held
   */
  isGlobalLockHeld(): boolean {
    return this.globalExecutionLock;
  }

  /**
   * Get global lock info for diagnostics
   */
  getGlobalLockInfo(): {
    held: boolean;
    holder: string | null;
    durationMs: number | null;
    queueLength: number;
  } {
    return {
      held: this.globalExecutionLock,
      holder: this.globalLockHolder,
      durationMs: this.globalLockStartedAt 
        ? Date.now() - this.globalLockStartedAt.getTime() 
        : null,
      queueLength: this.lockQueue.length,
    };
  }

  /**
   * Acquire global lock with priority queue and timeout
   * Use this for operations that MUST have global exclusivity (e.g., portfolio rebalancing)
   * 
   * @param threadId Unique thread identifier
   * @param operation Description of operation
   * @param priority Priority level (higher = more important, gets lock first)
   * @param timeoutMs Maximum time to wait for lock
   * @returns Promise that resolves when lock is acquired, or rejects on timeout
   */
  async acquireGlobalLockWithPriority(
    threadId: string,
    operation: string,
    priority: number = this.PRIORITY_NORMAL,
    timeoutMs: number = 30000,
  ): Promise<void> {
    // Check for stale lock first
    this.checkAndReleaseStaleGlobalLock();

    // Try immediate acquisition
    if (!this.globalExecutionLock) {
      this.globalExecutionLock = true;
      this.globalLockHolder = threadId;
      this.globalLockStartedAt = new Date();
      this.logger.debug(
        `🔒 Global lock acquired immediately by ${threadId} for ${operation} (priority: ${priority})`
      );
      return;
    }

    // Queue the request
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove from queue on timeout
        const idx = this.lockQueue.findIndex(q => q.threadId === threadId);
        if (idx !== -1) {
          this.lockQueue.splice(idx, 1);
        }
        reject(new Error(`Timeout waiting for global lock (${timeoutMs}ms) for ${operation}`));
      }, timeoutMs);

      this.lockQueue.push({
        threadId,
        priority,
        operation,
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      });

      // Sort by priority (highest first)
      this.lockQueue.sort((a, b) => b.priority - a.priority);

      this.logger.debug(
        `⏳ ${threadId} queued for global lock (priority: ${priority}, position: ${
          this.lockQueue.findIndex(q => q.threadId === threadId) + 1
        }/${this.lockQueue.length})`
      );
    });
  }

  /**
   * Release global lock and grant to next in queue
   */
  releaseGlobalLockAndGrantNext(threadId: string): void {
    if (this.globalLockHolder !== threadId) {
      this.logger.warn(
        `⚠️ Thread ${threadId} tried to release global lock held by ${this.globalLockHolder}`
      );
      return;
    }

    // Release current lock
    this.globalExecutionLock = false;
    this.globalLockHolder = null;
    this.globalLockStartedAt = null;

    // Grant to next in queue
    if (this.lockQueue.length > 0) {
      const next = this.lockQueue.shift()!;
      this.globalExecutionLock = true;
      this.globalLockHolder = next.threadId;
      this.globalLockStartedAt = new Date();
      
      this.logger.debug(
        `🔒 Global lock transferred to ${next.threadId} for ${next.operation} ` +
        `(priority: ${next.priority}, ${this.lockQueue.length} still waiting)`
      );
      
      next.resolve();
    } else {
      this.logger.debug(`🔓 Global lock released by ${threadId} (no queue)`);
    }
  }

  /**
   * Check and release stale global lock
   */
  private checkAndReleaseStaleGlobalLock(): void {
    if (this.globalExecutionLock && this.globalLockStartedAt) {
      const lockAge = Date.now() - this.globalLockStartedAt.getTime();
      if (lockAge > this.LOCK_TIMEOUT_MS) {
        this.logger.warn(
          `🔓 Force-releasing stale global lock held by ${this.globalLockHolder} for ${Math.round(lockAge / 1000)}s`
        );
        this.releaseGlobalLockAndGrantNext(this.globalLockHolder!);
      }
    }
  }

  /**
   * Try to acquire ONLY symbol-level lock (no global lock required)
   * Use this for individual trades that don't need global exclusivity
   * 
   * @param symbol Trading symbol
   * @param threadId Thread identifier
   * @param operation Operation description
   * @returns true if acquired, false if symbol already locked
   */
  tryAcquireSymbolOnlyLock(
    symbol: string,
    threadId: string,
    operation: string,
  ): boolean {
    const normalizedSymbol = this.normalizeSymbol(symbol);

    // Check for stale symbol lock (using shorter timeout)
    const existingLock = this.executingSymbols.get(normalizedSymbol);
    if (existingLock) {
      const lockAge = Date.now() - existingLock.startedAt.getTime();
      if (lockAge > this.SYMBOL_LOCK_TIMEOUT_MS) {
        this.logger.warn(
          `🔓 Releasing stale symbol lock for ${normalizedSymbol} held by ${existingLock.threadId} ` +
          `for ${Math.round(lockAge / 1000)}s (> ${this.SYMBOL_LOCK_TIMEOUT_MS / 1000}s threshold)`
        );
        this.executingSymbols.delete(normalizedSymbol);
      } else {
        return false; // Symbol is locked
      }
    }

    // Acquire symbol lock
    this.executingSymbols.set(normalizedSymbol, {
      startedAt: new Date(),
      threadId,
      operation,
    });

    this.logger.debug(
      `🔒 Symbol-only lock acquired for ${normalizedSymbol} by ${threadId} (${operation})`
    );
    return true;
  }

  /**
   * Execute a function with automatic symbol lock management
   * This is the RECOMMENDED way to execute symbol-specific operations
   */
  async withSymbolLock<T>(
    symbol: string,
    operation: string,
    fn: () => Promise<T>,
    timeoutMs: number = 30000,
  ): Promise<T> {
    const threadId = this.generateThreadId();
    const normalizedSymbol = this.normalizeSymbol(symbol);

    // Try to acquire lock with retry
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (this.tryAcquireSymbolOnlyLock(normalizedSymbol, threadId, operation)) {
        try {
          return await fn();
        } finally {
          this.releaseSymbolLock(normalizedSymbol, threadId);
        }
      }
      // Wait a bit before retry
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout acquiring symbol lock for ${normalizedSymbol} (${timeoutMs}ms)`);
  }

  /**
   * Try to acquire a symbol-level lock
   * @param symbol The trading symbol to lock
   * @param threadId Unique identifier for the thread/operation
   * @param operation Description of the operation (for logging)
   * @returns true if lock acquired, false if symbol is already being executed
   */
  tryAcquireSymbolLock(
    symbol: string,
    threadId: string,
    operation: string,
  ): boolean {
    const normalizedSymbol = this.normalizeSymbol(symbol);

    // Check for stale lock
    const existingLock = this.executingSymbols.get(normalizedSymbol);
    if (existingLock) {
      const lockAge = Date.now() - existingLock.startedAt.getTime();
      if (lockAge > this.LOCK_TIMEOUT_MS) {
        this.logger.warn(
          `🔓 Releasing stale lock for ${normalizedSymbol} held by ${existingLock.threadId} for ${Math.round(lockAge / 1000)}s`,
        );
        this.executingSymbols.delete(normalizedSymbol);
      } else {
        this.logger.debug(
          `⏳ Symbol ${normalizedSymbol} already being executed by ${existingLock.threadId} (${existingLock.operation}) - skipping ${operation}`,
        );
        return false;
      }
    }

    // Acquire lock
    this.executingSymbols.set(normalizedSymbol, {
      startedAt: new Date(),
      threadId,
      operation,
    });

    this.logger.debug(
      `🔒 Lock acquired for ${normalizedSymbol} by ${threadId} (${operation})`,
    );
    return true;
  }

  /**
   * Release a symbol-level lock
   * @param symbol The trading symbol to unlock
   * @param threadId The thread ID that holds the lock
   */
  releaseSymbolLock(symbol: string, threadId: string): void {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const existingLock = this.executingSymbols.get(normalizedSymbol);

    if (!existingLock) {
      this.logger.debug(`⚠️ No lock found for ${normalizedSymbol} to release`);
      return;
    }

    if (existingLock.threadId !== threadId) {
      this.logger.warn(
        `⚠️ Thread ${threadId} tried to release lock for ${normalizedSymbol} held by ${existingLock.threadId}`,
      );
      return;
    }

    this.executingSymbols.delete(normalizedSymbol);
    
    // Track when execution completed for this symbol (for reconciliation cooldown)
    this.executionCompletedAt.set(normalizedSymbol, Date.now());
    
    this.logger.debug(
      `🔓 Lock released for ${normalizedSymbol} by ${threadId}`,
    );
  }

  /**
   * Check if a symbol is currently locked
   */
  isSymbolLocked(symbol: string): boolean {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const lock = this.executingSymbols.get(normalizedSymbol);

    if (!lock) return false;

    // Check for stale lock
    const lockAge = Date.now() - lock.startedAt.getTime();
    if (lockAge > this.LOCK_TIMEOUT_MS) {
      this.executingSymbols.delete(normalizedSymbol);
      return false;
    }

    return true;
  }
  
  /**
   * Get the timestamp when execution last completed for a symbol
   * Returns undefined if no execution has completed or it was too long ago
   */
  getExecutionCompletedAt(symbol: string): number | undefined {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const completedAt = this.executionCompletedAt.get(normalizedSymbol);
    
    // Only return if it was within the last hour (for memory cleanup)
    if (completedAt && (Date.now() - completedAt) < 3600000) {
      return completedAt;
    }
    
    // Clean up old entries
    if (completedAt) {
      this.executionCompletedAt.delete(normalizedSymbol);
    }
    
    return undefined;
  }
  
  /**
   * Check if a symbol is in cooldown period after execution completed
   * @param symbol The symbol to check
   * @param cooldownMs The cooldown period in milliseconds
   */
  isInExecutionCooldown(symbol: string, cooldownMs: number): boolean {
    const completedAt = this.getExecutionCompletedAt(symbol);
    if (!completedAt) return false;
    return (Date.now() - completedAt) < cooldownMs;
  }

  /**
   * Get list of currently locked symbols
   */
  getLockedSymbols(): string[] {
    const now = Date.now();
    const locked: string[] = [];

    for (const [symbol, lock] of this.executingSymbols.entries()) {
      const lockAge = now - lock.startedAt.getTime();
      if (lockAge <= this.LOCK_TIMEOUT_MS) {
        locked.push(symbol);
      } else {
        // Clean up stale lock
        this.executingSymbols.delete(symbol);
      }
    }

    return locked;
  }

  /**
   * Get diagnostics information about current locks
   */
  getDiagnostics(): {
    globalLock: {
      held: boolean;
      holder: string | null;
      durationMs: number | null;
    };
    symbolLocks: Array<{
      symbol: string;
      threadId: string;
      operation: string;
      durationMs: number;
    }>;
  } {
    const now = Date.now();
    const symbolLocks: Array<{
      symbol: string;
      threadId: string;
      operation: string;
      durationMs: number;
    }> = [];

    for (const [symbol, lock] of this.executingSymbols.entries()) {
      const durationMs = now - lock.startedAt.getTime();
      if (durationMs <= this.LOCK_TIMEOUT_MS) {
        symbolLocks.push({
          symbol,
          threadId: lock.threadId,
          operation: lock.operation,
          durationMs,
        });
      }
    }

    return {
      globalLock: {
        held: this.globalExecutionLock,
        holder: this.globalLockHolder,
        durationMs: this.globalLockStartedAt
          ? now - this.globalLockStartedAt.getTime()
          : null,
      },
      symbolLocks,
    };
  }

  /**
   * Force release all locks (for emergency/testing)
   */
  releaseAllLocks(): void {
    this.logger.warn('🔓 Force releasing all execution locks');
    this.executingSymbols.clear();
    this.globalExecutionLock = false;
    this.globalLockHolder = null;
    this.globalLockStartedAt = null;
  }

  /**
   * Normalize symbol for consistent locking
   */
  private normalizeSymbol(symbol: string): string {
    return symbol
      .toUpperCase()
      .replace('USDT', '')
      .replace('USDC', '')
      .replace('-PERP', '')
      .replace('PERP', '');
  }

  // ============================================
  // ORDER REGISTRY METHODS
  // ============================================

  /**
   * Generate a unique key for order tracking
   */
  private getOrderKey(
    exchange: string,
    symbol: string,
    side: 'LONG' | 'SHORT',
  ): string {
    return `${exchange}:${this.normalizeSymbol(symbol)}:${side}`;
  }

  /**
   * Register an order being placed
   * Returns false if there's already an active order for this symbol/side/exchange
   * @param initialPositionSize - Current position size BEFORE order is placed (for fill detection)
   */
  registerOrderPlacing(
    orderId: string,
    symbol: string,
    exchange: string,
    side: 'LONG' | 'SHORT',
    threadId: string,
    size?: number,
    price?: number,
    initialPositionSize?: number,
  ): boolean {
    const key = this.getOrderKey(exchange, symbol, side);
    const normalizedSymbol = this.normalizeSymbol(symbol);

    // Check for existing active order
    const existing = this.activeOrders.get(key);
    if (existing) {
      const orderAge = Date.now() - existing.placedAt.getTime();

      // If order is stale, clean it up
      if (orderAge > this.ORDER_TIMEOUT_MS) {
        this.logger.warn(
          `🧹 Cleaning up stale order ${existing.orderId} for ${normalizedSymbol} ` +
            `(${existing.side}) on ${exchange} - age: ${Math.round(orderAge / 1000)}s`,
        );
        this.activeOrders.delete(key);
      } else {
        // Active order exists - prevent duplicate
        this.logger.warn(
          `⚠️ RACE CONDITION PREVENTED: Thread ${threadId} tried to place ${side} order for ` +
            `${normalizedSymbol} on ${exchange}, but order ${existing.orderId} is already active ` +
            `(status: ${existing.status}, age: ${Math.round(orderAge / 1000)}s, thread: ${existing.threadId})`,
        );
        return false;
      }
    }

    // Register the new order
    const order: ActiveOrder = {
      orderId,
      symbol: normalizedSymbol,
      exchange,
      side,
      threadId,
      placedAt: new Date(),
      status: 'PLACING',
      size,
      price,
      initialPositionSize,
    };

    this.activeOrders.set(key, order);
    this.logger.log(
      `📝 Order registered: ${orderId} for ${normalizedSymbol} (${side}) on ${exchange} by ${threadId}` +
      (initialPositionSize !== undefined ? ` (initial pos: ${initialPositionSize.toFixed(4)})` : ''),
    );

    return true;
  }

  /**
   * Update order status
   */
  updateOrderStatus(
    exchange: string,
    symbol: string,
    side: 'LONG' | 'SHORT',
    status: ActiveOrder['status'],
    orderId?: string,
    price?: number,
    reduceOnly?: boolean,
  ): void {
    const key = this.getOrderKey(exchange, symbol, side);
    const order = this.activeOrders.get(key);

    if (!order) {
      this.logger.debug(`No active order found for ${key} to update`);
      return;
    }

    // Update order ID if provided
    if (orderId && order.orderId !== orderId) {
      order.orderId = orderId;
    }

    // Update price if provided
    if (price !== undefined) {
      order.price = price;
    }

    // Update reduceOnly if provided
    if (reduceOnly !== undefined) {
      order.reduceOnly = reduceOnly;
    }

    const previousStatus = order.status;
    order.status = status;

    this.logger.debug(
      `📊 Order ${order.orderId} status: ${previousStatus} -> ${status}`,
    );

    // If order is terminal (filled, failed, cancelled), move to history
    if (status === 'FILLED' || status === 'FAILED' || status === 'CANCELLED') {
      this.activeOrders.delete(key);
      this.orderHistory.unshift({ ...order });

      // Trim history
      while (this.orderHistory.length > this.MAX_ORDER_HISTORY) {
        this.orderHistory.pop();
      }

      this.logger.log(
        `✅ Order ${order.orderId} completed with status: ${status}`,
      );
    }
  }

  /**
   * Check if there's an active order for a symbol/side/exchange
   */
  hasActiveOrder(
    exchange: string,
    symbol: string,
    side: 'LONG' | 'SHORT',
  ): boolean {
    const key = this.getOrderKey(exchange, symbol, side);
    const order = this.activeOrders.get(key);

    if (!order) return false;

    // Check for stale order
    const orderAge = Date.now() - order.placedAt.getTime();
    if (orderAge > this.ORDER_TIMEOUT_MS) {
      this.activeOrders.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Get active order for a symbol/side/exchange
   */
  getActiveOrder(
    exchange: string,
    symbol: string,
    side: 'LONG' | 'SHORT',
  ): ActiveOrder | null {
    const key = this.getOrderKey(exchange, symbol, side);
    const order = this.activeOrders.get(key);

    if (!order) return null;

    // Check for stale order
    const orderAge = Date.now() - order.placedAt.getTime();
    if (orderAge > this.ORDER_TIMEOUT_MS) {
      this.activeOrders.delete(key);
      return null;
    }

    return order;
  }

  /**
   * Update an existing active order
   */
  updateActiveOrder(order: ActiveOrder): void {
    const key = `${order.exchange}-${order.symbol}-${order.side}`;
    if (this.activeOrders.has(key)) {
      this.activeOrders.set(key, { ...order });
      this.logger.debug(`Updated active order for ${order.symbol} on ${order.exchange}`);
    }
  }

  /**
   * Get all active orders
   */
  getAllActiveOrders(): ActiveOrder[] {
    const now = Date.now();
    const active: ActiveOrder[] = [];

    for (const [key, order] of this.activeOrders.entries()) {
      const orderAge = now - order.placedAt.getTime();
      if (orderAge <= this.ORDER_TIMEOUT_MS) {
        active.push(order);
      } else {
        // Clean up stale order
        this.activeOrders.delete(key);
      }
    }

    return active;
  }

  /**
   * Alias for getAllActiveOrders for compatibility
   */
  getActiveOrders(): ActiveOrder[] {
    return this.getAllActiveOrders();
  }

  /**
   * Get orders older than a specified age in milliseconds
   * Used for stale order cleanup
   */
  getOrdersOlderThan(ageMs: number): ActiveOrder[] {
    const now = Date.now();
    const staleOrders: ActiveOrder[] = [];

    for (const order of this.activeOrders.values()) {
      const orderAge = now - order.placedAt.getTime();
      if (orderAge >= ageMs) {
        staleOrders.push({ ...order });
      }
    }

    return staleOrders;
  }

  /**
   * Get order history
   */
  getOrderHistory(limit: number = 50): ActiveOrder[] {
    return this.orderHistory.slice(0, limit);
  }

  /**
   * Check if any orders are active for a symbol (either side)
   */
  hasAnyActiveOrderForSymbol(symbol: string): boolean {
    const normalizedSymbol = this.normalizeSymbol(symbol);

    for (const order of this.activeOrders.values()) {
      if (order.symbol === normalizedSymbol) {
        const orderAge = Date.now() - order.placedAt.getTime();
        if (orderAge <= this.ORDER_TIMEOUT_MS) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Force clear an order (for emergency/cleanup)
   */
  forceClearOrder(
    exchange: string,
    symbol: string,
    side: 'LONG' | 'SHORT',
  ): void {
    const key = this.getOrderKey(exchange, symbol, side);
    const order = this.activeOrders.get(key);

    if (order) {
      this.logger.warn(`🗑️ Force clearing order ${order.orderId} for ${key}`);
      this.activeOrders.delete(key);
      this.orderHistory.unshift({ ...order, status: 'CANCELLED' });
    }
  }

  /**
   * Get comprehensive diagnostics including order registry
   */
  getFullDiagnostics(): {
    globalLock: {
      held: boolean;
      holder: string | null;
      durationMs: number | null;
      queueLength: number;
    };
    symbolLocks: Array<{
      symbol: string;
      threadId: string;
      operation: string;
      durationMs: number;
    }>;
    activeOrders: ActiveOrder[];
    recentOrderHistory: ActiveOrder[];
    currentExecution: typeof this.currentExecution;
  } {
    const baseDiagnostics = this.getDiagnostics();
    return {
      globalLock: {
        ...baseDiagnostics.globalLock,
        queueLength: this.lockQueue.length,
      },
      symbolLocks: baseDiagnostics.symbolLocks,
      activeOrders: this.getAllActiveOrders(),
      recentOrderHistory: this.getOrderHistory(20),
      currentExecution: this.currentExecution,
    };
  }

  /**
   * Set current execution progress (for TUI display)
   */
  setExecutionProgress(progress: {
    symbol: string;
    operation: string;
    currentSlice: number;
    totalSlices: number;
    legAExchange: string;
    legBExchange: string;
    legAStatus: string;
    legBStatus: string;
  } | null): void {
    if (progress === null) {
      this.currentExecution = null;
    } else {
      this.currentExecution = {
        ...progress,
        startedAt: this.currentExecution?.symbol === progress.symbol 
          ? this.currentExecution.startedAt 
          : new Date(),
        lastUpdate: new Date(),
      };
    }
  }

  /**
   * Get current execution progress
   */
  getExecutionProgress() {
    return this.currentExecution;
  }
}
