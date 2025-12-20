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

  // Timeout for stale locks (5 minutes)
  private readonly LOCK_TIMEOUT_MS = 5 * 60 * 1000;

  // Timeout for stale orders (10 minutes)
  private readonly ORDER_TIMEOUT_MS = 10 * 60 * 1000;

  // Counter for generating unique thread IDs
  private threadCounter = 0;

  /**
   * Generate a unique thread ID for tracking
   */
  generateThreadId(): string {
    return `thread-${++this.threadCounter}-${Date.now()}`;
  }

  /**
   * Get all active orders currently being tracked
   */
  getAllActiveOrders(): ActiveOrder[] {
    return Array.from(this.activeOrders.values());
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
   */
  registerOrderPlacing(
    orderId: string,
    symbol: string,
    exchange: string,
    side: 'LONG' | 'SHORT',
    threadId: string,
    size?: number,
    price?: number,
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
    };

    this.activeOrders.set(key, order);
    this.logger.log(
      `📝 Order registered: ${orderId} for ${normalizedSymbol} (${side}) on ${exchange} by ${threadId}`,
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
    };
    symbolLocks: Array<{
      symbol: string;
      threadId: string;
      operation: string;
      durationMs: number;
    }>;
    activeOrders: ActiveOrder[];
    recentOrderHistory: ActiveOrder[];
  } {
    return {
      ...this.getDiagnostics(),
      activeOrders: this.getAllActiveOrders(),
      recentOrderHistory: this.getOrderHistory(20),
    };
  }
}
