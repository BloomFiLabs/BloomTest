/**
 * LiquidationMonitorService
 *
 * Domain service responsible for monitoring position liquidation risk
 * and triggering emergency closes when positions approach liquidation.
 *
 * Design principles:
 * - Single responsibility: Only monitors and triggers emergency closes
 * - Dependency injection: Receives adapters and position manager as dependencies
 * - Immutable state: Uses value objects for risk calculations
 * - Fail-safe: Defaults to closing positions if risk cannot be determined
 */

import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { LiquidationRisk } from '../value-objects/LiquidationRisk';
import { ILiquidationMonitor, LiquidationCheckResult, LiquidationMonitorConfig, PairedPosition, EmergencyCloseResult, DEFAULT_LIQUIDATION_MONITOR_CONFIG } from '../ports/ILiquidationMonitor';
import { IPerpExchangeAdapter } from '../ports/IPerpExchangeAdapter';
import { PerpPosition } from '../entities/PerpPosition';
import { PerpOrderRequest, OrderSide, OrderType, TimeInForce } from '../value-objects/PerpOrder';
import { ExecutionLockService } from '../../infrastructure/services/ExecutionLockService';
import { RateLimiterService, RateLimitPriority } from '../../infrastructure/services/RateLimiterService';
import { MarketStateService } from '../../infrastructure/services/MarketStateService';
import type { IOptimalLeverageService } from '../ports/IOptimalLeverageService';

/**
 * Internal type for tracking paired positions.
 */
interface PositionPair {
  symbol: string;
  long?: PerpPosition;
  short?: PerpPosition;
  longExchange?: ExchangeType;
  shortExchange?: ExchangeType;
}

@Injectable()
export class LiquidationMonitorService implements ILiquidationMonitor {
  private readonly logger = new Logger(LiquidationMonitorService.name);
  private config: LiquidationMonitorConfig;
  private adapters: Map<ExchangeType, IPerpExchangeAdapter> = new Map();
  private monitoringInterval: NodeJS.Timeout | null = null;
  private running = false;

  // Cache of last check results for diagnostics
  private lastCheckResult: LiquidationCheckResult | null = null;
  private lastCheckTime: Date | null = null;

  constructor(
    @Optional() private readonly executionLockService?: ExecutionLockService,
    @Optional() private readonly rateLimiter?: RateLimiterService,
    @Optional() private readonly marketStateService?: MarketStateService,
    @Optional() @Inject('IOptimalLeverageService') private readonly optimalLeverageService?: IOptimalLeverageService,
  ) {
    this.config = { ...DEFAULT_LIQUIDATION_MONITOR_CONFIG };
  }

  /**
   * Initialize the monitor with exchange adapters.
   * Must be called before starting monitoring.
   */
  initialize(adapters: Map<ExchangeType, IPerpExchangeAdapter>): void {
    this.adapters = adapters;
    this.logger.log(
      `LiquidationMonitor initialized with ${adapters.size} exchange adapter(s): ` +
        `${Array.from(adapters.keys()).join(', ')}`,
    );
  }

  /**
   * Run a single liquidation check across all positions.
   */
  async checkLiquidationRisk(): Promise<LiquidationCheckResult> {
    const startTime = Date.now();
    const result: LiquidationCheckResult = {
      timestamp: new Date(),
      positionsChecked: 0,
      positionsAtRisk: 0,
      emergencyClosesTriggered: 0,
      positions: [],
      emergencyCloses: [],
    };

    try {
      // Step 1: Fetch all positions from all exchanges
      // Use MarketStateService if available to reduce API calls and ensure consistent snapshot
      let allPositions: PerpPosition[] = [];
      if (this.marketStateService) {
        allPositions = this.marketStateService.getAllPositions();
      } else {
        allPositions = await this.fetchAllPositions();
      }
      
      result.positionsChecked = allPositions.length;

      if (allPositions.length === 0) {
        this.logger.debug('No positions found to monitor for liquidation risk');
        this.lastCheckResult = result;
        this.lastCheckTime = new Date();
        return result;
      }

      // Step 2: Pair positions by symbol
      const pairedPositions = this.pairPositions(allPositions);

      // Step 3: Calculate liquidation risk for each pair
      for (const pair of pairedPositions.values()) {
        const pairedPosition = await this.calculatePairRisk(pair);
        if (pairedPosition) {
          result.positions.push(pairedPosition);

          // Use the buffer consumption logic from the LiquidationRisk object
          // This measures how much of the ACTUAL buffer (based on the position's own leverage)
          // has been eaten by price movement.
          const longConsumed = pairedPosition.longRisk.proximityToLiquidation;
          const shortConsumed = pairedPosition.shortRisk.proximityToLiquidation;
          
          const longAtRisk = pairedPosition.longRisk.shouldEmergencyClose(this.config.emergencyCloseThreshold);
          const shortAtRisk = pairedPosition.shortRisk.shouldEmergencyClose(this.config.emergencyCloseThreshold);

          if (longAtRisk || shortAtRisk) {
            result.positionsAtRisk++;

            const triggerLeg = longAtRisk ? 'LONG' : 'SHORT';
            const triggerRisk = longAtRisk ? pairedPosition.longRisk : pairedPosition.shortRisk;
            const consumed = longAtRisk ? longConsumed : shortConsumed;
            
            // Calculate components for clearer logging
            const initialBuffer = triggerRisk.leverage > 0 ? 1 / triggerRisk.leverage : 0.1;
            const currentDistance = triggerRisk.distanceToLiquidation;

            this.logger.warn(
              `🚨 LIQUIDATION RISK: ${pairedPosition.symbol} ${triggerLeg} leg ` +
                `has consumed ${(consumed * 100).toFixed(1)}% of its safety buffer! ` +
                `(Buffer: ${(initialBuffer * 100).toFixed(1)}%, Dist: ${(currentDistance * 100).toFixed(2)}%, Lev: ${triggerRisk.leverage.toFixed(1)}x) ` +
                `Mark: $${triggerRisk.markPrice.toFixed(4)}, Liq: $${triggerRisk.liquidationPrice.toFixed(4)}`
            );

            // Trigger emergency close if enabled
            if (this.config.enableEmergencyClose) {
              const closeResult = await this.executeEmergencyClose(
                pairedPosition,
                longAtRisk,
                shortAtRisk,
              );
              result.emergencyCloses.push(closeResult);
              result.emergencyClosesTriggered++;
            }
          } else if (longConsumed >= this.config.warningThreshold || shortConsumed >= this.config.warningThreshold) {
            // Log warning for positions approaching risk
            this.logger.warn(
              `⚠️ Liquidation warning: ${pairedPosition.symbol} buffer consumption: ` +
                `LONG: ${(longConsumed * 100).toFixed(1)}%, ` +
                `SHORT: ${(shortConsumed * 100).toFixed(1)}%`,
            );
          }
        }
      }

      const elapsed = Date.now() - startTime;
      this.logger.debug(
        `Liquidation check completed in ${elapsed}ms: ` +
          `${result.positionsChecked} checked, ${result.positionsAtRisk} at risk, ` +
          `${result.emergencyClosesTriggered} emergency closes`,
      );

      this.lastCheckResult = result;
      this.lastCheckTime = new Date();
      return result;
    } catch (error: any) {
      this.logger.error(`Liquidation check failed: ${error.message}`);
      this.lastCheckResult = result;
      this.lastCheckTime = new Date();
      return result;
    }
  }

  /**
   * Get current liquidation risk for a specific symbol.
   */
  async getPositionRisk(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): Promise<PairedPosition | null> {
    try {
      const longAdapter = this.adapters.get(longExchange);
      const shortAdapter = this.adapters.get(shortExchange);

      if (!longAdapter || !shortAdapter) {
        return null;
      }

      const [longPositions, shortPositions] = await Promise.all([
        longAdapter.getPositions(),
        shortAdapter.getPositions(),
      ]);

      const longPosition = longPositions.find(
        (p) => p.symbol === symbol && p.side === OrderSide.LONG,
      );
      const shortPosition = shortPositions.find(
        (p) => p.symbol === symbol && p.side === OrderSide.SHORT,
      );

      if (!longPosition && !shortPosition) {
        return null;
      }

      const pair: PositionPair = {
        symbol,
        long: longPosition,
        short: shortPosition,
        longExchange,
        shortExchange,
      };

      return this.calculatePairRisk(pair);
    } catch (error: any) {
      this.logger.warn(
        `Failed to get position risk for ${symbol}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get all positions currently at risk (above warning threshold).
   */
  async getPositionsAtRisk(): Promise<PairedPosition[]> {
    const checkResult = await this.checkLiquidationRisk();
    return checkResult.positions.filter(
      (p) =>
        p.longRisk.proximityToLiquidation >= this.config.warningThreshold ||
        p.shortRisk.proximityToLiquidation >= this.config.warningThreshold,
    );
  }

  /**
   * Manually trigger emergency close for a position.
   */
  async emergencyClosePosition(
    symbol: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    reason: string,
  ): Promise<EmergencyCloseResult> {
    this.logger.warn(
      `🚨 Manual emergency close triggered for ${symbol}: ${reason}`,
    );

    const position = await this.getPositionRisk(
      symbol,
      longExchange,
      shortExchange,
    );

    if (!position) {
      return {
        symbol,
        longExchange,
        shortExchange,
        triggerReason: 'BOTH_AT_RISK',
        triggerRisk: LiquidationRisk.safe(symbol, longExchange, 'LONG'),
        longCloseSuccess: false,
        shortCloseSuccess: false,
        longCloseError: 'Position not found',
        shortCloseError: 'Position not found',
        closedAt: new Date(),
      };
    }

    return this.executeEmergencyClose(position, true, true);
  }

  getConfig(): LiquidationMonitorConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<LiquidationMonitorConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.log(
      `LiquidationMonitor config updated: threshold=${this.config.emergencyCloseThreshold}, ` +
        `interval=${this.config.checkIntervalMs}ms, enabled=${this.config.enableEmergencyClose}`,
    );
  }

  start(): void {
    if (this.running) {
      this.logger.warn('LiquidationMonitor is already running');
      return;
    }

    if (this.adapters.size === 0) {
      this.logger.error(
        'Cannot start LiquidationMonitor: no adapters initialized',
      );
      return;
    }

    this.running = true;
    this.logger.log(
      `🛡️ LiquidationMonitor started: checking every ${this.config.checkIntervalMs / 1000}s, ` +
        `emergency close threshold: ${this.config.emergencyCloseThreshold * 100}%`,
    );

    // Run immediately on start
    this.checkLiquidationRisk().catch((err) =>
      this.logger.error(`Initial liquidation check failed: ${err.message}`),
    );

    // Schedule periodic checks
    this.monitoringInterval = setInterval(() => {
      this.checkLiquidationRisk().catch((err) =>
        this.logger.error(`Periodic liquidation check failed: ${err.message}`),
      );
    }, this.config.checkIntervalMs);
  }

  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    this.logger.log('🛑 LiquidationMonitor stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the last check result for diagnostics.
   */
  getLastCheckResult(): {
    result: LiquidationCheckResult | null;
    timestamp: Date | null;
  } {
    return {
      result: this.lastCheckResult,
      timestamp: this.lastCheckTime,
    };
  }

  // ==================== Private Methods ====================

  /**
   * Fetch all positions from all adapters.
   */
  private async fetchAllPositions(): Promise<PerpPosition[]> {
    const allPositions: PerpPosition[] = [];

    const fetchPromises = Array.from(this.adapters.entries()).map(
      async ([exchange, adapter]) => {
        try {
          const positions = await adapter.getPositions();
          return positions;
        } catch (error: any) {
          this.logger.warn(
            `Failed to fetch positions from ${exchange}: ${error.message}`,
          );
          return [];
        }
      },
    );

    const results = await Promise.all(fetchPromises);
    results.forEach((positions) => allPositions.push(...positions));

    return allPositions;
  }

  /**
   * Pair positions by symbol (long + short on same symbol).
   */
  private pairPositions(
    positions: PerpPosition[],
  ): Map<string, PositionPair> {
    const pairs = new Map<string, PositionPair>();

    for (const position of positions) {
      if (!pairs.has(position.symbol)) {
        pairs.set(position.symbol, { symbol: position.symbol });
      }

      const pair = pairs.get(position.symbol)!;
      if (position.side === OrderSide.LONG) {
        pair.long = position;
        pair.longExchange = position.exchangeType;
      } else if (position.side === OrderSide.SHORT) {
        pair.short = position;
        pair.shortExchange = position.exchangeType;
      }
    }

    return pairs;
  }

  /**
   * Calculate liquidation risk for a position pair.
   */
  private async calculatePairRisk(
    pair: PositionPair,
  ): Promise<PairedPosition | null> {
    // Need at least one position
    if (!pair.long && !pair.short) {
      return null;
    }

    const longRisk = this.calculatePositionRisk(pair.long, 'LONG');
    const shortRisk = this.calculatePositionRisk(pair.short, 'SHORT');

    return {
      symbol: pair.symbol,
      longExchange: pair.longExchange || ExchangeType.HYPERLIQUID,
      shortExchange: pair.shortExchange || ExchangeType.LIGHTER,
      longRisk,
      shortRisk,
      openedAt: pair.long?.timestamp || pair.short?.timestamp || new Date(),
    };
  }

  /**
   * Calculate liquidation risk for a single position.
   */
  private calculatePositionRisk(
    position: PerpPosition | undefined,
    side: 'LONG' | 'SHORT',
  ): LiquidationRisk {
    if (!position) {
      return LiquidationRisk.safe('UNKNOWN', 'UNKNOWN', side);
    }

    // If no liquidation price, estimate it based on leverage and maintenance margin
    let liquidationPrice = position.liquidationPrice || 0;
    if (liquidationPrice <= 0 && position.leverage && position.leverage > 0) {
      // Theoretical liq price: for 10x leverage (10% margin), liq is when margin hits maintenance
      // Maintenance margin is usually 0.5% - 2.0%. We'll use 1.5% as a safe default.
      const maintenanceMargin = 0.015;
      const initialMargin = 1 / position.leverage;
      
      // Distance to liquidation = InitialMargin - MaintenanceMargin
      const liqDistance = Math.max(0.01, initialMargin - maintenanceMargin);
      
      if (side === 'LONG') {
        liquidationPrice = position.entryPrice * (1 - liqDistance);
      } else {
        liquidationPrice = position.entryPrice * (1 + liqDistance);
      }
    }

    // If still no liq price, use a very conservative estimate (5% from mark)
    if (liquidationPrice <= 0) {
      if (side === 'LONG') {
        liquidationPrice = position.markPrice * 0.95;
      } else {
        liquidationPrice = position.markPrice * 1.05;
      }
      this.logger.debug(
        `Estimated liquidation price for ${position.symbol} ${side}: $${liquidationPrice.toFixed(4)} ` +
          `(no liq price from exchange)`,
      );
    }

    return LiquidationRisk.create({
      symbol: position.symbol,
      exchange: position.exchangeType,
      side,
      markPrice: position.markPrice,
      liquidationPrice,
      entryPrice: position.entryPrice,
      positionSize: position.size,
      positionValueUsd: position.getPositionValue(),
      margin: position.marginUsed || position.getPositionValue() / (position.leverage || 1),
      leverage: position.leverage || 1,
    });
  }

  /**
   * Execute emergency close for both legs of a position.
   */
  private async executeEmergencyClose(
    position: PairedPosition,
    longAtRisk: boolean,
    shortAtRisk: boolean,
  ): Promise<EmergencyCloseResult> {
    const threadId = this.executionLockService?.generateThreadId() || `liq-pair-${Date.now()}`;
    const result: EmergencyCloseResult = {
      symbol: position.symbol,
      longExchange: position.longExchange,
      shortExchange: position.shortExchange,
      triggerReason:
        longAtRisk && shortAtRisk
          ? 'BOTH_AT_RISK'
          : longAtRisk
            ? 'LONG_AT_RISK'
            : 'SHORT_AT_RISK',
      triggerRisk: longAtRisk ? position.longRisk : position.shortRisk,
      longCloseSuccess: false,
      shortCloseSuccess: false,
      closedAt: new Date(),
    };

    this.logger.warn(
      `🚨 EMERGENCY CLOSE: ${position.symbol} - closing BOTH legs ` +
        `(triggered by ${result.triggerReason})`,
    );

    // SYMBOL-LEVEL LOCK: Acquire once for the entire pair close operation
    if (this.executionLockService) {
      const lockAcquired = this.executionLockService.tryAcquireSymbolLock(
        position.symbol,
        threadId,
        'emergency-close-pair'
      );
      
      if (!lockAcquired) {
        this.logger.warn(`⏳ Symbol ${position.symbol} is already being executed - skipping emergency close pair`);
        return result;
      }
    }

    // Set entry prices
    result.longEntryPrice = position.longRisk.entryPrice;
    result.shortEntryPrice = position.shortRisk.entryPrice;

    try {
      // Close both legs in parallel for speed
      const [longResult, shortResult] = await Promise.allSettled([
        this.closePosition(position, 'LONG', threadId, true), // Skip internal locking
        this.closePosition(position, 'SHORT', threadId, true), // Skip internal locking
      ]);

      // Process long result
      if (longResult.status === 'fulfilled') {
        result.longCloseSuccess = longResult.value.success;
        result.longCloseError = longResult.value.error;
        result.longClosePrice = longResult.value.fillPrice;
      } else {
        result.longCloseError = longResult.reason?.message || 'Unknown error';
      }

      // Process short result
      if (shortResult.status === 'fulfilled') {
        result.shortCloseSuccess = shortResult.value.success;
        result.shortCloseError = shortResult.value.error;
        result.shortClosePrice = shortResult.value.fillPrice;
      } else {
        result.shortCloseError = shortResult.reason?.message || 'Unknown error';
      }

      // Log result with prices
      const longMsg = result.longCloseSuccess 
        ? `LONG closed @ $${result.longClosePrice?.toFixed(4)} (entry $${result.longEntryPrice?.toFixed(4)})`
        : `LONG failed: ${result.longCloseError}`;
      
      const shortMsg = result.shortCloseSuccess
        ? `SHORT closed @ $${result.shortClosePrice?.toFixed(4)} (entry $${result.shortEntryPrice?.toFixed(4)})`
        : `SHORT failed: ${result.shortCloseError}`;

      if (result.longCloseSuccess && result.shortCloseSuccess) {
        this.logger.log(`✅ Emergency close successful for ${position.symbol}: ${longMsg}, ${shortMsg}`);
      } else {
        this.logger.error(`❌ Emergency close PARTIAL for ${position.symbol}: ${longMsg}, ${shortMsg}`);
      }

      return result;
    } finally {
      // Always release symbol lock when done
      if (this.executionLockService) {
        this.executionLockService.releaseSymbolLock(position.symbol, threadId);
      }
    }
  }

  /**
   * Close a single leg of a position.
   * @param position Position pair data
   * @param side Leg to close
   * @param threadId Thread ID for locking
   * @param skipLocking Whether to skip acquiring the symbol lock (if already held by caller)
   */
  private async closePosition(
    position: PairedPosition,
    side: 'LONG' | 'SHORT',
    threadId?: string,
    skipLocking: boolean = false,
  ): Promise<{ success: boolean; error?: string; fillPrice?: number }> {
    const risk = side === 'LONG' ? position.longRisk : position.shortRisk;
    const exchange =
      side === 'LONG' ? position.longExchange : position.shortExchange;

    if (risk.positionSize <= 0) {
      return { success: true }; // No position to close
    }

    const adapter = this.adapters.get(exchange);
    if (!adapter) {
      return { success: false, error: `No adapter for ${exchange}` };
    }

    const effectiveThreadId = threadId || this.executionLockService?.generateThreadId() || `liq-${Date.now()}`;

    // SYMBOL-LEVEL LOCK: Prevent concurrent execution on the same symbol
    if (this.executionLockService && !skipLocking) {
      const lockAcquired = this.executionLockService.tryAcquireSymbolLock(
        position.symbol,
        effectiveThreadId,
        `emergency-close-${side}`
      );
      
      if (!lockAcquired) {
        this.logger.warn(`⏳ Symbol ${position.symbol} is already being executed - skipping emergency close for ${side}`);
        return { success: true };
      }
    }

    try {
      // Check if an order is already pending for this symbol/side/exchange
      if (this.executionLockService) {
        const isLocked = this.executionLockService.hasActiveOrder(exchange, position.symbol, side);
        if (isLocked) {
          this.logger.debug(`⚠️ Skipping emergency close for ${position.symbol} ${side} on ${exchange}: order already active`);
          // Don't release lock here if we are skipping locking (caller owns it)
          if (!skipLocking) this.executionLockService.releaseSymbolLock(position.symbol, effectiveThreadId);
          return { success: true };
        }
      }

      // Retry logic for emergency closes
      for (let attempt = 1; attempt <= this.config.maxCloseRetries; attempt++) {
        try {
          // Get current mark price to act as maker
          let markPrice: number | undefined;
          try {
            markPrice = await adapter.getMarkPrice(position.symbol);
          } catch (priceError: any) {
            this.logger.warn(
              `Could not get mark price for ${position.symbol} emergency close, using risk price: ${priceError.message}`,
            );
            markPrice = risk.markPrice;
          }

          const closeSide = side === 'LONG' ? OrderSide.SHORT : OrderSide.LONG;

          // Register order in execution lock service BEFORE placing
          if (this.executionLockService) {
            const registered = this.executionLockService.registerOrderPlacing(
              `liq-${position.symbol}-${side}-${attempt}`,
              position.symbol,
              exchange,
              side === 'LONG' ? 'SHORT' : 'LONG', // Side we are placing
              effectiveThreadId,
              risk.positionSize,
              markPrice
            );

            if (!registered) {
              this.logger.warn(`⚠️ Could not register emergency order for ${position.symbol} ${side}: already active`);
              return { success: true };
            }
          }

          // Create market order to close position immediately (opposite side, reduceOnly)
          // For emergency closes, we use MARKET to ensure execution in fast-moving markets
          const closeOrder = new PerpOrderRequest(
            position.symbol,
            closeSide,
            OrderType.MARKET,
            risk.positionSize,
            undefined, // Price determined by adapter for MARKET orders
            undefined, // TIF determined by adapter for MARKET orders
            true, // reduceOnly
          );

        this.logger.log(
          `📤 Emergency close ${side} ${position.symbol} on ${exchange}: ` +
            `size=${risk.positionSize.toFixed(4)} @ $${markPrice.toFixed(4)} (attempt ${attempt}/${this.config.maxCloseRetries})`,
        );

        // Acquire rate limit with EMERGENCY priority
        if (this.rateLimiter) {
          await this.rateLimiter.acquire(exchange, 1, RateLimitPriority.EMERGENCY);
        }

        const response = await adapter.placeOrder(closeOrder);

          if (response.isSuccess() || response.isFilled()) {
            if (this.executionLockService) {
              this.executionLockService.updateOrderStatus(
                exchange,
                position.symbol,
                closeSide === OrderSide.LONG ? 'LONG' : 'SHORT',
                response.isFilled() ? 'FILLED' : 'WAITING_FILL',
                response.orderId,
                markPrice,
                true
              );
            }
            return { 
              success: true, 
              fillPrice: response.averageFillPrice || markPrice 
            };
          } else {
            if (this.executionLockService) {
              this.executionLockService.updateOrderStatus(
                exchange,
                position.symbol,
                closeSide === OrderSide.LONG ? 'LONG' : 'SHORT',
                'FAILED'
              );
            }
            this.logger.warn(
              `Emergency close attempt ${attempt} failed: ${response.error || 'Unknown'}`,
            );
          }
        } catch (error: any) {
          const closeSide = side === 'LONG' ? OrderSide.SHORT : OrderSide.LONG;
          if (this.executionLockService) {
            this.executionLockService.updateOrderStatus(
              exchange,
              position.symbol,
              closeSide === OrderSide.LONG ? 'LONG' : 'SHORT',
              'FAILED'
            );
          }
          this.logger.warn(
            `Emergency close attempt ${attempt} error: ${error.message}`,
          );

          if (attempt < this.config.maxCloseRetries) {
            // Wait before retry with exponential backoff
            await new Promise((resolve) =>
              setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)),
            );
          }
        }
      }

      return {
        success: false,
        error: `Failed after ${this.config.maxCloseRetries} attempts`,
      };
    } finally {
      // Always release symbol lock when done
      if (this.executionLockService && !skipLocking) {
        this.executionLockService.releaseSymbolLock(position.symbol, effectiveThreadId);
      }
    }
  }
}

