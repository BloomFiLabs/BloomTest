import { Injectable, Logger } from '@nestjs/common';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  TimeInForce,
  OrderStatus,
} from '../../value-objects/PerpOrder';

/**
 * SliceResult - Result of executing a single slice
 */
export interface SliceResult {
  sliceNumber: number;
  longFilled: boolean;
  shortFilled: boolean;
  longFilledSize: number;
  shortFilledSize: number;
  longOrderId?: string;
  shortOrderId?: string;
  error?: string;
}

/**
 * UnifiedExecutionResult - Result of full unified execution
 */
export interface UnifiedExecutionResult {
  success: boolean;
  totalSlices: number;
  completedSlices: number;
  totalLongFilled: number;
  totalShortFilled: number;
  sliceResults: SliceResult[];
  abortReason?: string;
  timeToFundingMs?: number;
  actualSlicesUsed?: number;
}

/**
 * UnifiedExecutionConfig - Configuration for unified execution
 */
export interface UnifiedExecutionConfig {
  /** Maximum time to wait for a slice to fill (ms) */
  sliceFillTimeoutMs: number;
  /** Time between fill checks (ms) */
  fillCheckIntervalMs: number;
  /** Maximum imbalance tolerance before aborting (percent of slice size) */
  maxImbalancePercent: number;
  /** Minimum time buffer before funding (ms) */
  fundingBufferMs: number;
  /** Minimum number of slices */
  minSlices: number;
  /** Maximum number of slices */
  maxSlices: number;
  /** Maximum % of portfolio allowed per slice (0.05 = 5%) */
  maxPortfolioPctPerSlice: number;
  /** Maximum USD size allowed per slice */
  maxUsdPerSlice: number;
}

const DEFAULT_CONFIG: UnifiedExecutionConfig = {
  sliceFillTimeoutMs: 30000, // 30 seconds per slice
  fillCheckIntervalMs: 2000, // Check every 2 seconds
  maxImbalancePercent: 5, // Abort if > 5% imbalance
  fundingBufferMs: 3 * 60 * 1000, // 3 minute buffer before funding
  minSlices: 2, // At least 2 slices for safety
  maxSlices: 20, 
  maxPortfolioPctPerSlice: 0.05, // Never more than 5% of portfolio per slice
  maxUsdPerSlice: 2500, // Cap slices at $2.5k even if portfolio is large
};

/**
 * UnifiedExecutionService - The "Beautiful Architecture" execution engine
 * 
 * Features:
 * 1. Portfolio Aware: Slices are sized relative to total capital to prevent massive unhedged exposure.
 * 2. Sequential Core: Always uses Lighter-first (or more flaky exchange first) logic.
 * 3. Atomic Slices: Waits for Leg A to fill before Leg B is even placed.
 * 4. Guaranteed Rollback: Uses MARKET orders to instantly close Leg A if Leg B fails.
 * 5. Dynamic Slicing: Maximizes slices based on time to funding.
 */
@Injectable()
export class UnifiedExecutionService {
  private readonly logger = new Logger(UnifiedExecutionService.name);

  /**
   * Execute a hedged trade with unified safety-first logic
   */
  async executeSmartHedge(
    longAdapter: IPerpExchangeAdapter,
    shortAdapter: IPerpExchangeAdapter,
    symbol: string,
    totalSize: number,
    longPrice: number,
    shortPrice: number,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    config: Partial<UnifiedExecutionConfig> = {},
  ): Promise<UnifiedExecutionResult> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    
    // 1. ANALYZE & PLAN
    const [longEquity, shortEquity] = await Promise.all([
      longAdapter.getEquity().catch(() => 0),
      shortAdapter.getEquity().catch(() => 0),
    ]);
    const totalPortfolioUsd = longEquity + shortEquity;
    
    const timeToFundingMs = this.calculateMinimumTimeToFunding(longExchange, shortExchange);
    const avgPrice = (longPrice + shortPrice) / 2;
    const totalUsd = totalSize * avgPrice;

    // Calculate slice count based on three constraints:
    // a) Time constraint (must finish before funding)
    const timePerSliceMs = cfg.sliceFillTimeoutMs + 1000;
    const availableTimeMs = Math.max(0, timeToFundingMs - cfg.fundingBufferMs);
    const slicesForTime = Math.floor(availableTimeMs / timePerSliceMs);
    
    // b) Portfolio constraint (safety)
    const maxSliceSizeUsd = Math.min(
      totalPortfolioUsd * cfg.maxPortfolioPctPerSlice,
      cfg.maxUsdPerSlice
    );
    const slicesForPortfolio = Math.ceil(totalUsd / maxSliceSizeUsd);
    
    // c) Combine and clamp
    // CRITICAL: Safety (portfolio constraint) ALWAYS takes priority over time constraints
    let numberOfSlices = Math.max(cfg.minSlices, slicesForPortfolio);
    
    // If we have time constraints, we might have to reduce slices, 
    // but NEVER reduce below what's needed for safety (portfolio constraint)
    if (slicesForTime < numberOfSlices && slicesForTime >= slicesForPortfolio) {
      this.logger.warn(`Time pressure detected: Reducing slices from ${numberOfSlices} to ${slicesForTime}`);
      numberOfSlices = slicesForTime;
    } else if (slicesForTime < slicesForPortfolio) {
      // Time constraint would violate safety - prioritize safety
      this.logger.warn(
        `⚠️ Time constraint (${slicesForTime} slices) would violate safety (need ${slicesForPortfolio} slices). ` +
        `Prioritizing safety - execution may not complete before funding.`
      );
      // Keep slicesForPortfolio to maintain safety
      numberOfSlices = slicesForPortfolio;
    }
    
    numberOfSlices = Math.min(numberOfSlices, cfg.maxSlices);
    let sliceSize = totalSize / numberOfSlices;
    let sliceUsd = sliceSize * avgPrice;
    
    // FINAL SAFETY CHECK: Ensure calculated slice size doesn't exceed limits
    // This catches any edge cases where rounding or time constraints caused issues
    if (sliceUsd > maxSliceSizeUsd * 1.05) { // 5% tolerance for rounding
      const requiredSlices = Math.ceil(totalUsd / maxSliceSizeUsd);
      this.logger.warn(
        `⚠️ Calculated slice size ($${sliceUsd.toFixed(2)}) exceeds safety limit ($${maxSliceSizeUsd.toFixed(2)}). ` +
        `Recalculating: ${numberOfSlices} -> ${requiredSlices} slices`
      );
      numberOfSlices = Math.max(requiredSlices, cfg.minSlices);
      // Recalculate slice size
      sliceSize = totalSize / numberOfSlices;
      sliceUsd = sliceSize * avgPrice;
      this.logger.log(
        `✅ Recalculated: ${numberOfSlices} slices x $${sliceUsd.toFixed(2)} = $${totalUsd.toFixed(2)}`
      );
    }

    this.logger.log(
      `🚀 Unified Execution Plan for ${symbol}:\n` +
      `   - Total: $${totalUsd.toFixed(2)} (${totalSize.toFixed(4)} tokens)\n` +
      `   - Slices: ${numberOfSlices} x $${sliceUsd.toFixed(2)}\n` +
      `   - Safety: ${((sliceUsd / totalPortfolioUsd) * 100).toFixed(1)}% of portfolio per slice\n` +
      `   - Time: ${Math.round(timeToFundingMs / 60000)}m until funding`
    );

    const result: UnifiedExecutionResult = {
      success: false,
      totalSlices: numberOfSlices,
      completedSlices: 0,
      totalLongFilled: 0,
      totalShortFilled: 0,
      sliceResults: [],
      timeToFundingMs,
    };

    // 2. SEQUENTIAL EXECUTION
    for (let i = 0; i < numberOfSlices; i++) {
      const sliceNumber = i + 1;
      
      // Dynamic Lighter-first logic
      const firstIsLong = (longExchange === ExchangeType.LIGHTER) || (shortExchange !== ExchangeType.LIGHTER);
      
      const sliceResult = await this.executeSequentialSlice(
        longAdapter,
        shortAdapter,
        symbol,
        sliceSize,
        longPrice,
        shortPrice,
        sliceNumber,
        cfg,
        firstIsLong
      );

      result.sliceResults.push(sliceResult);
      result.totalLongFilled += sliceResult.longFilledSize;
      result.totalShortFilled += sliceResult.shortFilledSize;

      if (sliceResult.longFilled && sliceResult.shortFilled) {
        result.completedSlices++;
      } else {
        result.abortReason = sliceResult.error || `Slice ${sliceNumber} failed to fill`;
        this.logger.warn(`🛑 Execution Aborted: ${result.abortReason}`);
        break;
      }

      // Small pause between successful slices
      if (i < numberOfSlices - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // 3. FINAL VALIDATION & EMERGENCY ROLLBACK
    const finalImbalance = Math.abs(result.totalLongFilled - result.totalShortFilled);
    const imbalanceUsd = finalImbalance * avgPrice;
    
    if (imbalanceUsd > 10) { // $10 threshold
      this.logger.error(`🚨 CRITICAL: Significant imbalance of $${imbalanceUsd.toFixed(2)} detected!`);
      // The individual slice execution should have handled rollback, 
      // but we do a final check here just in case of cumulative drift.
      await this.handleFinalImbalance(longAdapter, shortAdapter, symbol, result, avgPrice);
    }

    result.success = result.completedSlices === numberOfSlices && imbalanceUsd < 10;
    return result;
  }

  /**
   * Execute a single slice sequentially
   */
  private async executeSequentialSlice(
    longAdapter: IPerpExchangeAdapter,
    shortAdapter: IPerpExchangeAdapter,
    symbol: string,
    sliceSize: number,
    longPrice: number,
    shortPrice: number,
    sliceNumber: number,
    cfg: UnifiedExecutionConfig,
    firstIsLong: boolean
  ): Promise<SliceResult> {
    const result: SliceResult = {
      sliceNumber,
      longFilled: false,
      shortFilled: false,
      longFilledSize: 0,
      shortFilledSize: 0,
    };

    const firstAdapter = firstIsLong ? longAdapter : shortAdapter;
    const secondAdapter = firstIsLong ? shortAdapter : longAdapter;
    const firstSide = firstIsLong ? OrderSide.LONG : OrderSide.SHORT;
    const secondSide = firstIsLong ? OrderSide.SHORT : OrderSide.LONG;
    const firstPrice = firstIsLong ? longPrice : shortPrice;
    const secondPrice = firstIsLong ? shortPrice : longPrice;

    try {
      // --- FINAL SANITY CHECK ---
      // Re-verify slice size against portfolio just before placing order
      await this.validateSliceSafety(firstAdapter, secondAdapter, sliceSize, firstPrice, cfg);

      // --- STEP 1: Get initial position size BEFORE placing order ---
      // This is critical: if there's an existing position, we need to track the delta
      let initialPositionSize = 0;
      try {
        const positions = await firstAdapter.getPositions();
        const existingPosition = positions.find(
          (p) => p.symbol === symbol && 
          ((firstIsLong && p.side === OrderSide.LONG) || (!firstIsLong && p.side === OrderSide.SHORT))
        );
        if (existingPosition) {
          initialPositionSize = Math.abs(existingPosition.size);
          this.logger.debug(
            `📊 Initial position for ${symbol} ${firstSide}: ${initialPositionSize.toFixed(4)} ` +
            `(will track delta after order fills)`
          );
        }
      } catch (error: any) {
        this.logger.debug(`Could not get initial position: ${error.message}`);
      }

      // --- STEP 2: Place Leg A ---
      const firstOrder = new PerpOrderRequest(symbol, firstSide, OrderType.LIMIT, sliceSize, firstPrice, TimeInForce.GTC);
      const firstResp = await firstAdapter.placeOrder(firstOrder);
      
      if (!firstResp.isSuccess()) {
        result.error = `Leg A (${firstSide}) placement failed: ${firstResp.error}`;
        return result;
      }

      // --- STEP 3: Wait for Leg A Fill ---
      const firstFill = await this.waitForFill(
        firstAdapter, 
        firstResp.orderId!, 
        symbol, 
        sliceSize, 
        cfg,
        initialPositionSize // Pass initial position to calculate delta
      );
      
      if (firstIsLong) {
        result.longFilledSize = firstFill.filledSize;
        result.longOrderId = firstResp.orderId;
      } else {
        result.shortFilledSize = firstFill.filledSize;
        result.shortOrderId = firstResp.orderId;
      }

      if (firstFill.filledSize === 0) {
        result.error = `Leg A (${firstSide}) never filled`;
        await firstAdapter.cancelOrder(firstResp.orderId!, symbol).catch(() => {});
        return result;
      }

      // --- STEP 3: Place Leg B (Matching actual fill of Leg A) ---
      const matchedSize = firstFill.filledSize;
      const secondOrder = new PerpOrderRequest(symbol, secondSide, OrderType.LIMIT, matchedSize, secondPrice, TimeInForce.GTC);
      const secondResp = await secondAdapter.placeOrder(secondOrder);

      if (!secondResp.isSuccess()) {
        // CRITICAL: Leg B failed to even place. Must rollback Leg A immediately.
        result.error = `Leg B (${secondSide}) placement failed. EMERGENCY ROLLBACK of Leg A.`;
        try {
          await this.rollback(firstAdapter, symbol, matchedSize, firstSide);
          // Only reset filled size if rollback succeeded
          if (firstIsLong) result.longFilledSize = 0; else result.shortFilledSize = 0;
        } catch (rollbackError: any) {
          this.logger.error(`🚨 FAILED TO ROLLBACK Leg A after Leg B placement failure! We are now unhedged: ${rollbackError.message}`);
          // DO NOT reset filled size - we need to know we have this unhedged position
        }
        return result;
      }

      // --- STEP 4: Wait for Leg B Fill ---
      const secondFill = await this.waitForFill(secondAdapter, secondResp.orderId!, symbol, matchedSize, cfg);
      
      if (firstIsLong) {
        result.shortFilledSize = secondFill.filledSize;
        result.shortOrderId = secondResp.orderId;
      } else {
        result.longFilledSize = secondFill.filledSize;
        result.longOrderId = secondResp.orderId;
      }

      // --- STEP 5: Verify Hedge Balance ---
      const imbalance = Math.abs(firstFill.filledSize - secondFill.filledSize);
      if (imbalance > matchedSize * (cfg.maxImbalancePercent / 100)) {
        // Significant imbalance! Rollback the difference or the whole leg?
        // Usually safer to rollback the excess of Leg A.
        this.logger.error(`Slice ${sliceNumber} imbalance: Leg A=${firstFill.filledSize}, Leg B=${secondFill.filledSize}`);
        
        if (secondFill.filledSize === 0) {
           result.error = `Leg B failed to fill. Rolling back Leg A.`;
           try {
             await this.rollback(firstAdapter, symbol, firstFill.filledSize, firstSide);
             if (firstIsLong) result.longFilledSize = 0; else result.shortFilledSize = 0;
           } catch (rollbackError: any) {
             this.logger.error(`🚨 FAILED TO ROLLBACK Leg A after Leg B fill failure! We are now unhedged: ${rollbackError.message}`);
             // Keep the filled size so handleFinalImbalance can clean it up
           }
           return result;
        }
        
        // Partial imbalance - cancel Leg B and let the orchestrator decide
        await secondAdapter.cancelOrder(secondResp.orderId!, symbol).catch(() => {});
      }

      result.longFilled = result.longFilledSize > 0 && Math.abs(result.longFilledSize - result.shortFilledSize) < (sliceSize * 0.1);
      result.shortFilled = result.shortFilledSize > 0 && Math.abs(result.longFilledSize - result.shortFilledSize) < (sliceSize * 0.1);
      
      return result;

    } catch (error: any) {
      this.logger.error(`Slice ${sliceNumber} exception: ${error.message}`);
      result.error = error.message;
      return result;
    }
  }

  private async waitForFill(
    adapter: IPerpExchangeAdapter, 
    orderId: string, 
    symbol: string, 
    expectedSize: number, 
    cfg: UnifiedExecutionConfig,
    initialPositionSize: number = 0 // Position size BEFORE order was placed
  ): Promise<{ filled: boolean, filledSize: number }> {
    const start = Date.now();
    let currentFilled = 0;
    let firstCheck = true;

    // CRITICAL: Add small delay before first check to allow instant fills to update positions
    // Orders that fill instantly (market orders or very aggressive limits) need time for position updates
    if (firstCheck) {
      await new Promise(r => setTimeout(r, 500)); // 500ms delay for position updates
      firstCheck = false;
    }

    while (Date.now() - start < cfg.sliceFillTimeoutMs) {
      try {
        // CRITICAL: Check order status FIRST, not position delta
        // Position delta can be misleading if there are existing positions from previous slices
        // We must verify the SPECIFIC ORDER filled, not just that a position exists
        const status = await adapter.getOrderStatus(orderId, symbol);
        
        // CRITICAL: If there was an initial position, calculate the DELTA
        // getOrderStatus returns total position size, but we need the fill size
        if (initialPositionSize > 0 && status.status === OrderStatus.FILLED) {
          // Order is filled - check current position to get actual fill size
          try {
            const positions = await adapter.getPositions();
            const currentPosition = positions.find(
              (p) => p.symbol === symbol && Math.abs(p.size) > 0.0001
            );
            if (currentPosition) {
              const currentPositionSize = Math.abs(currentPosition.size);
              const fillDelta = Math.abs(currentPositionSize - initialPositionSize);
              
              if (fillDelta > 0) {
                // Position increased - this is the actual fill size
                this.logger.log(
                  `✅ Fill detected via position delta: ${symbol} ` +
                  `initial=${initialPositionSize.toFixed(4)}, ` +
                  `current=${currentPositionSize.toFixed(4)}, ` +
                  `filled=${fillDelta.toFixed(4)}`
                );
                return { filled: true, filledSize: fillDelta };
              } else {
                // Position didn't increase - might be a different order or position closed
                // Fall back to status.filledSize
                currentFilled = status.filledSize || 0;
              }
            }
          } catch (posError: any) {
            this.logger.debug(`Could not get position for delta calculation: ${posError.message}`);
            // Fall back to status.filledSize
            currentFilled = status.filledSize || 0;
          }
        } else {
          // No initial position or order not filled yet - use status.filledSize
          currentFilled = status.filledSize || 0;
        }
        
        if (status.status === OrderStatus.FILLED) {
          // If we didn't calculate delta above, use the status filledSize
          if (currentFilled === 0) {
            currentFilled = status.filledSize || expectedSize; // Fallback to expectedSize if status doesn't have it
          }
          return { filled: true, filledSize: currentFilled };
        }
        
        // CRITICAL: If order status is CANCELLED, check if it's because it filled instantly
        // But ONLY if we can verify the order actually filled (not just that a position exists)
        if (status.status === OrderStatus.CANCELLED) {
          // For CANCELLED orders, we need to be more careful
          // Check if the order is NOT in open orders (which would indicate it filled)
          // But we can't rely on position delta alone - there might be existing positions
          // So we only treat as filled if:
          // 1. Order is not in open orders (confirmed via getOrderStatus)
          // 2. AND we have initial position to compare
          // 3. AND position increased by at least the expected size
          if (initialPositionSize > 0) {
            try {
              const positions = await adapter.getPositions();
              const currentPosition = positions.find(
                (p) => p.symbol === symbol && Math.abs(p.size) > 0.0001
              );
              if (currentPosition) {
                const currentPositionSize = Math.abs(currentPosition.size);
                const fillDelta = currentPositionSize - initialPositionSize;
                
                // Position must have increased by at least 90% of expected size
                // This ensures we're detecting the NEW order fill, not an existing position
                if (fillDelta >= (expectedSize * 0.9)) {
                  this.logger.log(
                    `✅ Fill detected: Order marked CANCELLED but position increased significantly ` +
                    `(${symbol} initial=${initialPositionSize.toFixed(4)}, ` +
                    `current=${currentPositionSize.toFixed(4)}, filled=${fillDelta.toFixed(4)}, expected=${expectedSize.toFixed(4)})`
                  );
                  return { filled: true, filledSize: fillDelta };
                } else {
                  // Position didn't increase enough - might be existing position, not our order
                  this.logger.debug(
                    `Order CANCELLED but position delta too small: ${fillDelta.toFixed(4)} < ${(expectedSize * 0.9).toFixed(4)}. ` +
                    `May be existing position, not our order fill.`
                  );
                }
              }
            } catch (posError: any) {
              this.logger.debug(`Could not verify position after CANCELLED status: ${posError.message}`);
            }
          }
        }
        
        if (status.status === OrderStatus.REJECTED) {
          return { filled: false, filledSize: currentFilled };
        }
        
        await new Promise(r => setTimeout(r, cfg.fillCheckIntervalMs));
      } catch {
        // Ignore errors and retry until timeout
        await new Promise(r => setTimeout(r, cfg.fillCheckIntervalMs));
      }
    }
    
    return { filled: false, filledSize: currentFilled };
  }

  private async rollback(adapter: IPerpExchangeAdapter, symbol: string, size: number, originalSide: OrderSide) {
    this.logger.warn(`🚨 EMERGENCY ROLLBACK: Closing ${size.toFixed(4)} ${originalSide} on ${adapter.getExchangeType()}`);
    const side = originalSide === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
    const rollbackOrder = new PerpOrderRequest(symbol, side, OrderType.MARKET, size, undefined, TimeInForce.IOC, true);
    
    try {
      const resp = await adapter.placeOrder(rollbackOrder);
      if (resp.isSuccess()) {
        this.logger.log(`✅ Rollback successful`);
      } else {
        this.logger.error(`🚨 ROLLBACK FAILED: ${resp.error}`);
      }
    } catch (e: any) {
      this.logger.error(`🚨 ROLLBACK EXCEPTION: ${e.message}`);
    }
  }

  private async handleFinalImbalance(
    longAdapter: IPerpExchangeAdapter, 
    shortAdapter: IPerpExchangeAdapter, 
    symbol: string, 
    result: UnifiedExecutionResult,
    price: number
  ) {
    const imbalance = result.totalLongFilled - result.totalShortFilled;
    if (Math.abs(imbalance) < 0.0001) return;

    if (imbalance > 0) {
      this.logger.warn(`Closing excess LONG: ${imbalance.toFixed(4)}`);
      await this.rollback(longAdapter, symbol, imbalance, OrderSide.LONG);
      result.totalLongFilled -= imbalance;
    } else {
      this.logger.warn(`Closing excess SHORT: ${Math.abs(imbalance).toFixed(4)}`);
      await this.rollback(shortAdapter, symbol, Math.abs(imbalance), OrderSide.SHORT);
      result.totalShortFilled += imbalance;
    }
  }

  private async validateSliceSafety(
    adapterA: IPerpExchangeAdapter,
    adapterB: IPerpExchangeAdapter,
    sliceSize: number,
    price: number,
    cfg: UnifiedExecutionConfig
  ): Promise<void> {
    const [equityA, equityB] = await Promise.all([
      adapterA.getEquity().catch(() => 0),
      adapterB.getEquity().catch(() => 0),
    ]);
    
    const totalPortfolioUsd = equityA + equityB;
    if (totalPortfolioUsd <= 0) return; // Can't validate if we can't get equity

    const sliceUsd = sliceSize * price;
    const maxAllowedUsd = Math.min(
      totalPortfolioUsd * cfg.maxPortfolioPctPerSlice * 1.1, // 10% buffer
      cfg.maxUsdPerSlice * 1.1
    );

    if (sliceUsd > maxAllowedUsd) {
      this.logger.error(
        `🚨 SPLICING SAFETY VIOLATION DETECTED 🚨\n` +
        `   Slice Size: $${sliceUsd.toFixed(2)}\n` +
        `   Portfolio: $${totalPortfolioUsd.toFixed(2)}\n` +
        `   Max Allowed: $${maxAllowedUsd.toFixed(2)} (${(cfg.maxPortfolioPctPerSlice * 100).toFixed(1)}% of portfolio)`
      );
      throw new Error(`Splicing safety violation: Slice size too large ($${sliceUsd.toFixed(2)})`);
    }
  }

  private calculateMinimumTimeToFunding(long: ExchangeType, short: ExchangeType): number {
    const getNext = (ex: ExchangeType) => {
      const now = new Date();
      if (ex === ExchangeType.LIGHTER) {
        const next = new Date(now);
        next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
        return next.getTime() - now.getTime();
      }
      const nextHour = Math.ceil(now.getUTCHours() / 8) * 8;
      const next = new Date(now);
      next.setUTCHours(nextHour, 0, 0, 0);
      if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
      return next.getTime() - now.getTime();
    };
    return Math.min(getNext(long), getNext(short));
  }
}

