import { Injectable, Logger, OnModuleInit, Optional, Inject, forwardRef } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { PerpPosition } from '../../entities/PerpPosition';
import { OrderSide, OrderType, TimeInForce, PerpOrderRequest, OrderStatus } from '../../value-objects/PerpOrder';
import { DiagnosticsService } from '../../../infrastructure/services/DiagnosticsService';
import { ExecutionLockService } from '../../../infrastructure/services/ExecutionLockService';
import { PerpKeeperService } from '../../../application/services/PerpKeeperService';
import { OrderGuardianService } from './OrderGuardianService';

/**
 * PositionExpectation - What we expect a position to be
 */
export interface PositionExpectation {
  symbol: string;
  exchange: ExchangeType;
  side: 'LONG' | 'SHORT';
  expectedSize: number;
  orderId?: string;
  placedAt: Date;
  lastChecked?: Date;
  verified: boolean;
}

/**
 * ReconciliationResult - Result of a reconciliation check
 */
export interface ReconciliationResult {
  symbol: string;
  exchange: ExchangeType;
  status: 'MATCHED' | 'PARTIAL_FILL' | 'NO_FILL' | 'OVERFILL' | 'ORPHAN' | 'ERROR';
  expectedSize: number;
  actualSize: number;
  discrepancy: number;
  discrepancyPercent: number;
  action?: 'NONE' | 'CANCEL_ORDER' | 'CLOSE_POSITION' | 'ALERT';
  message?: string;
}

/**
 * HedgePairStatus - Status of a hedged position pair
 */
export interface HedgePairStatus {
  symbol: string;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  longSize: number;
  shortSize: number;
  imbalance: number;
  imbalancePercent: number;
  isBalanced: boolean;
  lastReconciled: Date;
  firstImbalanceAt?: Date;
  imbalanceCount: number;
}

/**
 * ReconciliationService - The "intelligent being" for position health and reconciliation
 */
@Injectable()
export class ReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationService.name);

  private readonly expectations: Map<string, PositionExpectation> = new Map();
  private readonly actualPositions: Map<string, PerpPosition> = new Map();
  private readonly hedgePairs: Map<string, HedgePairStatus> = new Map();
  private adapters: Map<ExchangeType, IPerpExchangeAdapter> = new Map();
  
  private readonly MAX_RECENT_RESULTS = 50;
  private readonly recentResults: ReconciliationResult[] = [];

  // Configuration
  private readonly IMBALANCE_THRESHOLD_PERCENT = 5;
  private readonly NUCLEAR_THRESHOLD_PERCENT = 20;
  private readonly NUCLEAR_TIMEOUT_MINUTES = 1; // Reduced to 1 minute for faster recovery
  private readonly MAX_RECOVERY_ATTEMPTS = 3;

  constructor(
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
    @Optional() private readonly executionLockService?: ExecutionLockService,
    @Optional() private readonly keeperService?: PerpKeeperService,
    @Optional() @Inject(forwardRef(() => OrderGuardianService)) private readonly orderGuardian?: OrderGuardianService,
  ) {}

  onModuleInit() {
    this.logger.log('⚖️ ReconciliationService initialized - Position monitoring active');
  }

  setAdapters(adapters: Map<ExchangeType, IPerpExchangeAdapter>): void {
    this.adapters = adapters;
  }

  /**
   * Main reconciliation loop - runs every 60 seconds (for position checks)
   */
  @Interval(60000)
  async reconcile(): Promise<void> {
    if (this.adapters.size === 0 && this.keeperService) {
      this.adapters = this.keeperService.getExchangeAdapters();
    }
    if (this.adapters.size === 0) return;

    try {
      await this.fetchActualPositions();
      await this.checkExpectations();
      await this.checkHedgePairHealth();
      this.cleanupStaleExpectations();
    } catch (error: any) {
      this.logger.error(`Reconciliation error: ${error.message}`);
    }
  }

  private async fetchActualPositions() {
    this.actualPositions.clear();
    const promises = Array.from(this.adapters.entries()).map(async ([exchange, adapter]) => {
      try {
        const positions = await adapter.getPositions();
        for (const pos of positions) {
          if (Math.abs(pos.size) > 0.0001) {
            this.actualPositions.set(`${exchange}-${pos.symbol}-${pos.side}`, pos);
          }
        }
      } catch (e) {
        this.logger.warn(`Failed fetch positions from ${exchange}`);
      }
    });
    await Promise.all(promises);
  }

  private async checkExpectations() {
    for (const [key, expectation] of this.expectations) {
      const actual = this.actualPositions.get(key);
      const actualSize = actual ? Math.abs(actual.size) : 0;
      
      if (Math.abs(actualSize - expectation.expectedSize) < 0.0001) {
        expectation.verified = true;
      }
    }
  }

  /**
   * Unified hedge pair health check
   * Coalesces balance checking, drift recording, and nuclear recovery
   */
  private async checkHedgePairHealth() {
    const symbols = new Set<string>();
    for (const pos of this.actualPositions.values()) {
      symbols.add(this.normalizeSymbol(pos.symbol));
    }

    for (const symbol of symbols) {
      await this.reconcileSymbolPositions(symbol);
    }
  }

  private async reconcileSymbolPositions(symbol: string) {
    const symbolPositions = Array.from(this.actualPositions.values()).filter(
      p => this.normalizeSymbol(p.symbol) === symbol
    );

    const longPos = symbolPositions.find(p => p.side === OrderSide.LONG);
    const shortPos = symbolPositions.find(p => p.side === OrderSide.SHORT);

    if (!longPos || !shortPos) {
      // Handle Single-Leg Position (The most dangerous state)
      if (longPos || shortPos) {
        await this.handleSingleLeg(symbol, longPos || shortPos!);
      }
      return;
    }

    // Both legs exist - check balance
    const longSize = Math.abs(longPos.size);
    const shortSize = Math.abs(shortPos.size);
    const imbalance = Math.abs(longSize - shortSize);
    const avgSize = (longSize + shortSize) / 2;
    const imbalancePercent = (imbalance / avgSize) * 100;

    if (imbalancePercent > this.IMBALANCE_THRESHOLD_PERCENT) {
      await this.handleImbalance(symbol, longPos, shortPos, imbalancePercent);
    } else {
      this.hedgePairs.delete(symbol); // Balanced
    }
  }

  private async handleSingleLeg(symbol: string, pos: PerpPosition) {
    this.logger.error(`🚨 SINGLE LEG DETECTED: ${symbol} ${pos.side} on ${pos.exchangeType}`);
    
    // Record in diagnostics for visibility
    if (this.diagnosticsService) {
      this.diagnosticsService.recordSingleLegStart({
        id: `single-leg-${pos.exchangeType}-${symbol}-${pos.side}-${Date.now()}`,
        symbol,
        exchange: pos.exchangeType,
        side: pos.side as any,
        startedAt: new Date(),
        retryCount: 0,
        reason: 'Orphan position detected during reconciliation'
      });
    }

    let status = this.hedgePairs.get(symbol);
    if (!status) {
      status = { symbol, longExchange: pos.exchangeType, shortExchange: pos.exchangeType, longSize: 0, shortSize: 0, imbalance: 100, imbalancePercent: 100, isBalanced: false, lastReconciled: new Date(), firstImbalanceAt: new Date(), imbalanceCount: 1 };
      this.hedgePairs.set(symbol, status);
      
      // Try to open missing side immediately when first detected
      if (this.orderGuardian) {
        this.logger.log(`🛠️ Attempting to open missing side for ${symbol} ${pos.side} on ${pos.exchangeType}...`);
        const opened = await this.orderGuardian.tryOpenMissingSide(pos);
        if (opened) {
          this.logger.log(`✅ Successfully initiated opening missing side for ${symbol}`);
          return; // Give it time to fill before checking again
        } else {
          this.logger.warn(`⚠️ Failed to open missing side for ${symbol}, will retry next cycle`);
        }
      }
      return;
    }

    status.imbalanceCount++;
    const durationMin = (Date.now() - status.firstImbalanceAt!.getTime()) / 60000;

    // Try to open missing side again if we haven't exceeded retries
    if (this.orderGuardian && durationMin < this.NUCLEAR_TIMEOUT_MINUTES) {
      const opened = await this.orderGuardian.tryOpenMissingSide(pos);
      if (opened) {
        this.logger.log(`✅ Retry: Successfully initiated opening missing side for ${symbol}`);
        return; // Give it time to fill
      }
    }

    if (durationMin >= this.NUCLEAR_TIMEOUT_MINUTES) {
      this.logger.error(`☢️ NUCLEAR OPTION: Single leg ${symbol} persisted ${durationMin.toFixed(1)}m. Closing...`);
      await this.executeNuclearClose(pos);
      this.hedgePairs.delete(symbol);
    }
  }

  private async handleImbalance(symbol: string, long: PerpPosition, short: PerpPosition, percent: number) {
    this.logger.warn(`⚠️ Imbalance for ${symbol}: ${percent.toFixed(1)}%`);
    
    if (this.diagnosticsService) {
      this.diagnosticsService.recordPositionDrift(symbol, long.exchangeType, short.exchangeType, Math.abs(long.size), Math.abs(short.size), long.markPrice || 0);
    }

    if (percent > this.NUCLEAR_THRESHOLD_PERCENT) {
      let status = this.hedgePairs.get(symbol);
      if (!status) {
        status = { symbol, longExchange: long.exchangeType, shortExchange: short.exchangeType, longSize: Math.abs(long.size), shortSize: Math.abs(short.size), imbalance: Math.abs(long.size - short.size), imbalancePercent: percent, isBalanced: false, lastReconciled: new Date(), firstImbalanceAt: new Date(), imbalanceCount: 1 };
        this.hedgePairs.set(symbol, status);
      } else {
        status.imbalanceCount++;
        const durationMin = (Date.now() - status.firstImbalanceAt!.getTime()) / 60000;
        if (durationMin >= this.NUCLEAR_TIMEOUT_MINUTES) {
          this.logger.error(`☢️ NUCLEAR OPTION: Severe imbalance for ${symbol} persisted. Closing BOTH legs.`);
          await Promise.all([this.executeNuclearClose(long), this.executeNuclearClose(short)]);
          this.hedgePairs.delete(symbol);
        }
      }
    }
  }

  private async executeNuclearClose(pos: PerpPosition) {
    const adapter = this.adapters.get(pos.exchangeType);
    if (!adapter) return;

    const closeSide = pos.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
    const closeOrder = new PerpOrderRequest(pos.symbol, closeSide, OrderType.MARKET, Math.abs(pos.size), undefined, TimeInForce.IOC, true);
    
    this.logger.warn(`☢️ Market closing ${pos.exchangeType} ${pos.symbol} ${pos.side} ${Math.abs(pos.size)}`);
    await adapter.placeOrder(closeOrder);
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.toUpperCase().replace(/USDT|USDC|-PERP|PERP/g, '');
  }

  private cleanupStaleExpectations(): void {
    const now = Date.now();
    for (const [key, expectation] of this.expectations) {
      if (expectation.verified && (now - expectation.placedAt.getTime() > 60000)) {
        this.expectations.delete(key);
      }
    }
  }

  registerExpectation(symbol: string, exchange: ExchangeType, side: 'LONG' | 'SHORT', expectedSize: number, orderId?: string) {
    const key = `${exchange}-${symbol}-${side}`;
    this.expectations.set(key, { symbol, exchange, side, expectedSize, orderId, placedAt: new Date(), verified: false });
  }
}
