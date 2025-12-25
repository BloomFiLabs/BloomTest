import { Injectable, Logger } from '@nestjs/common';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  TimeInForce,
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
 * SlicedExecutionResult - Result of full sliced execution
 */
export interface SlicedExecutionResult {
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
 * SlicedExecutionConfig - Configuration for sliced execution
 */
export interface SlicedExecutionConfig {
  /** Number of slices to divide the order into (ignored if dynamicSlicing is true) */
  numberOfSlices: number;
  /** Maximum time to wait for a slice to fill (ms) */
  sliceFillTimeoutMs: number;
  /** Time between fill checks (ms) */
  fillCheckIntervalMs: number;
  /** Maximum imbalance tolerance before aborting (percent of slice size) */
  maxImbalancePercent: number;
  /** Whether to use market orders for final slice if limit doesn't fill */
  useMarketForFinalSlice: boolean;
  /** Enable dynamic slicing based on time to funding */
  dynamicSlicing: boolean;
  /** Minimum time buffer before funding (ms) - ensure we're done this long before funding */
  fundingBufferMs: number;
  /** Minimum number of slices (even with time pressure) */
  minSlices: number;
  /** Maximum number of slices (even with lots of time) */
  maxSlices: number;
}

const DEFAULT_CONFIG: SlicedExecutionConfig = {
  numberOfSlices: 5,
  sliceFillTimeoutMs: 30000, // 30 seconds per slice
  fillCheckIntervalMs: 2000, // Check every 2 seconds
  maxImbalancePercent: 10, // Abort if imbalance > 10% of slice
  useMarketForFinalSlice: false,
  dynamicSlicing: true, // Enable by default
  fundingBufferMs: 2 * 60 * 1000, // 2 minute buffer before funding
  minSlices: 2, // At least 2 slices for safety
  maxSlices: 20, // Cap at 20 slices to avoid excessive API calls
};

/**
 * Funding period info for different exchanges
 */
const FUNDING_PERIODS: Record<ExchangeType, number> = {
  [ExchangeType.HYPERLIQUID]: 8 * 60 * 60 * 1000, // 8 hours
  [ExchangeType.LIGHTER]: 1 * 60 * 60 * 1000, // 1 hour
  [ExchangeType.ASTER]: 8 * 60 * 60 * 1000, // 8 hours (assumed)
  [ExchangeType.EXTENDED]: 8 * 60 * 60 * 1000, // 8 hours (assumed)
  [ExchangeType.MOCK]: 1 * 60 * 60 * 1000, // 1 hour (for testing)
};

/**
 * SlicedExecutionService - Executes hedged trades in smaller slices
 * 
 * Benefits:
 * 1. Limits single-leg exposure to slice size (not full position)
 * 2. Allows early abort if one side consistently fails to fill
 * 3. Provides reconciliation checkpoints between slices
 * 4. Adapts pricing between slices based on market conditions
 * 5. DYNAMIC SLICING: Maximizes slices while ensuring completion before funding
 */
@Injectable()
export class SlicedExecutionService {
  private readonly logger = new Logger(SlicedExecutionService.name);

  /**
   * Calculate milliseconds until next funding period
   * 
   * Hyperliquid: Every 8 hours at 00:00, 08:00, 16:00 UTC
   * Lighter: Every 1 hour at the top of the hour
   */
  calculateTimeToNextFunding(exchange: ExchangeType): number {
    const now = new Date();
    const nowMs = now.getTime();
    
    if (exchange === ExchangeType.LIGHTER) {
      // Lighter: Next hour boundary
      const nextHour = new Date(now);
      nextHour.setMinutes(0, 0, 0);
      nextHour.setHours(nextHour.getHours() + 1);
      return nextHour.getTime() - nowMs;
    }
    
    // Hyperliquid/Aster: Every 8 hours at 00:00, 08:00, 16:00 UTC
    const utcHour = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const utcSeconds = now.getUTCSeconds();
    
    // Find next 8-hour boundary (0, 8, or 16)
    const currentPeriod = Math.floor(utcHour / 8);
    const nextPeriodHour = (currentPeriod + 1) * 8;
    
    const nextFunding = new Date(now);
    nextFunding.setUTCHours(nextPeriodHour % 24, 0, 0, 0);
    
    // If next period is tomorrow (hour >= 24)
    if (nextPeriodHour >= 24) {
      nextFunding.setUTCDate(nextFunding.getUTCDate() + 1);
    }
    
    return nextFunding.getTime() - nowMs;
  }

  /**
   * Calculate the optimal number of slices based on time to funding
   * 
   * Logic:
   * - Each slice takes: sliceFillTimeoutMs + buffer time
   * - Available time: timeToFunding - fundingBuffer
   * - Max slices: availableTime / timePerSlice
   */
  calculateOptimalSlices(
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    config: SlicedExecutionConfig,
  ): { slices: number; timeToFundingMs: number; constrainingExchange: ExchangeType } {
    // Use the SHORTER funding period (more constrained exchange)
    const longFundingMs = this.calculateTimeToNextFunding(longExchange);
    const shortFundingMs = this.calculateTimeToNextFunding(shortExchange);
    
    const constrainingExchange = longFundingMs < shortFundingMs ? longExchange : shortExchange;
    const timeToFundingMs = Math.min(longFundingMs, shortFundingMs);
    
    // Available time = time to funding - safety buffer
    const availableTimeMs = timeToFundingMs - config.fundingBufferMs;
    
    if (availableTimeMs <= 0) {
      // No time! Use minimum slices with aggressive timing
      this.logger.warn(
        `⚠️ Only ${Math.round(timeToFundingMs / 1000)}s until ${constrainingExchange} funding! ` +
        `Using minimum slices (${config.minSlices})`
      );
      return { slices: config.minSlices, timeToFundingMs, constrainingExchange };
    }
    
    // Time per slice = fill timeout + inter-slice pause (500ms)
    const timePerSliceMs = config.sliceFillTimeoutMs + 500;
    
    // Calculate max slices that fit
    let optimalSlices = Math.floor(availableTimeMs / timePerSliceMs);
    
    // Clamp to min/max
    optimalSlices = Math.max(config.minSlices, Math.min(config.maxSlices, optimalSlices));
    
    this.logger.log(
      `📊 Dynamic slicing: ${Math.round(timeToFundingMs / 1000)}s to ${constrainingExchange} funding, ` +
      `${Math.round(availableTimeMs / 1000)}s available → ${optimalSlices} slices ` +
      `(${Math.round(timePerSliceMs / 1000)}s per slice)`
    );
    
    return { slices: optimalSlices, timeToFundingMs, constrainingExchange };
  }

  /**
   * Format time until funding for logging
   */
  formatTimeToFunding(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      return `${hours}h ${remainingMinutes}m`;
    }
    
    return `${minutes}m ${seconds}s`;
  }

  /**
   * Execute a hedged trade in slices
   * 
   * @param longAdapter Adapter for long exchange
   * @param shortAdapter Adapter for short exchange
   * @param symbol Trading symbol
   * @param totalSize Total position size in base asset
   * @param longPrice Initial limit price for long
   * @param shortPrice Initial limit price for short
   * @param longExchange Exchange type for long
   * @param shortExchange Exchange type for short
   * @param config Sliced execution configuration
   */
  async executeSlicedHedge(
    longAdapter: IPerpExchangeAdapter,
    shortAdapter: IPerpExchangeAdapter,
    symbol: string,
    totalSize: number,
    longPrice: number,
    shortPrice: number,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    config: Partial<SlicedExecutionConfig> = {},
  ): Promise<SlicedExecutionResult> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    
    // DYNAMIC SLICING: Calculate optimal slices based on time to funding
    let numberOfSlices = cfg.numberOfSlices;
    let timeToFundingMs: number | undefined;
    let constrainingExchange: ExchangeType | undefined;
    
    if (cfg.dynamicSlicing) {
      const sliceCalc = this.calculateOptimalSlices(longExchange, shortExchange, cfg);
      numberOfSlices = sliceCalc.slices;
      timeToFundingMs = sliceCalc.timeToFundingMs;
      constrainingExchange = sliceCalc.constrainingExchange;
      
      // If very close to funding, reduce fill timeout for faster execution
      if (timeToFundingMs < 5 * 60 * 1000) { // < 5 minutes
        cfg.sliceFillTimeoutMs = Math.min(cfg.sliceFillTimeoutMs, 15000); // Cap at 15s
        this.logger.warn(
          `⏰ URGENT: Only ${this.formatTimeToFunding(timeToFundingMs)} to funding! ` +
          `Reduced slice timeout to ${cfg.sliceFillTimeoutMs / 1000}s`
        );
      }
    }
    
    const sliceSize = totalSize / numberOfSlices;
    
    this.logger.log(
      `🍕 Starting sliced execution for ${symbol}: ` +
      `${totalSize.toFixed(4)} total in ${numberOfSlices} slices of ${sliceSize.toFixed(4)} each` +
      (timeToFundingMs ? ` (${this.formatTimeToFunding(timeToFundingMs)} to ${constrainingExchange} funding)` : '')
    );

    const result: SlicedExecutionResult = {
      success: false,
      totalSlices: numberOfSlices,
      completedSlices: 0,
      totalLongFilled: 0,
      totalShortFilled: 0,
      sliceResults: [],
      timeToFundingMs,
      actualSlicesUsed: numberOfSlices,
    };

    // Track cumulative fills
    let cumulativeLongFilled = 0;
    let cumulativeShortFilled = 0;

    for (let i = 0; i < numberOfSlices; i++) {
      const sliceNumber = i + 1;
      this.logger.debug(`📍 Executing slice ${sliceNumber}/${numberOfSlices}`);

      // Refresh prices for this slice (market may have moved)
      const [currentLongPrice, currentShortPrice] = await Promise.all([
        longAdapter.getMarkPrice(symbol).catch(() => longPrice),
        shortAdapter.getMarkPrice(symbol).catch(() => shortPrice),
      ]);

      // Determine which exchange to place first (Lighter first if involved)
      const lighterFirst = 
        longExchange === ExchangeType.LIGHTER || 
        shortExchange === ExchangeType.LIGHTER;
      
      const firstIsLong = longExchange === ExchangeType.LIGHTER || 
        (shortExchange !== ExchangeType.LIGHTER);

      const sliceResult = await this.executeSlice(
        longAdapter,
        shortAdapter,
        symbol,
        sliceSize,
        currentLongPrice,
        currentShortPrice,
        longExchange,
        shortExchange,
        sliceNumber,
        cfg,
        firstIsLong,
      );

      result.sliceResults.push(sliceResult);

      if (sliceResult.longFilled && sliceResult.shortFilled) {
        // Both sides filled - success!
        cumulativeLongFilled += sliceResult.longFilledSize;
        cumulativeShortFilled += sliceResult.shortFilledSize;
        result.completedSlices++;
        
        this.logger.log(
          `✅ Slice ${sliceNumber} complete: ` +
          `LONG ${sliceResult.longFilledSize.toFixed(4)}, SHORT ${sliceResult.shortFilledSize.toFixed(4)}`
        );
      } else {
        // Partial or no fill - check imbalance
        const sliceImbalance = Math.abs(sliceResult.longFilledSize - sliceResult.shortFilledSize);
        const imbalancePercent = (sliceImbalance / sliceSize) * 100;

        if (imbalancePercent > cfg.maxImbalancePercent) {
          result.abortReason = 
            `Slice ${sliceNumber} imbalance too high: ${imbalancePercent.toFixed(1)}% > ${cfg.maxImbalancePercent}%`;
          this.logger.warn(`🛑 Aborting sliced execution: ${result.abortReason}`);
          
          // Update totals with partial fills
          cumulativeLongFilled += sliceResult.longFilledSize;
          cumulativeShortFilled += sliceResult.shortFilledSize;
          break;
        }

        // Small imbalance - continue but log warning
        this.logger.warn(
          `⚠️ Slice ${sliceNumber} partial fill: ` +
          `LONG ${sliceResult.longFilledSize.toFixed(4)}, SHORT ${sliceResult.shortFilledSize.toFixed(4)} ` +
          `(imbalance: ${imbalancePercent.toFixed(1)}%)`
        );
        
        cumulativeLongFilled += sliceResult.longFilledSize;
        cumulativeShortFilled += sliceResult.shortFilledSize;
        
        // If one side completely failed, abort
        if (sliceResult.longFilledSize === 0 || sliceResult.shortFilledSize === 0) {
          result.abortReason = `Slice ${sliceNumber}: One side completely failed to fill`;
          this.logger.error(`🛑 Aborting: ${result.abortReason}`);
          break;
        }
      }

      // Brief pause between slices to let market settle
      if (i < numberOfSlices - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    result.totalLongFilled = cumulativeLongFilled;
    result.totalShortFilled = cumulativeShortFilled;
    result.success = 
      result.completedSlices === numberOfSlices &&
      Math.abs(cumulativeLongFilled - cumulativeShortFilled) / totalSize < 0.02; // < 2% total imbalance

    this.logger.log(
      `${result.success ? '✅' : '⚠️'} Sliced execution ${result.success ? 'complete' : 'partial'}: ` +
      `${result.completedSlices}/${numberOfSlices} slices, ` +
      `LONG: ${cumulativeLongFilled.toFixed(4)}, SHORT: ${cumulativeShortFilled.toFixed(4)}` +
      (result.abortReason ? ` (Aborted: ${result.abortReason})` : '') +
      (timeToFundingMs ? ` [${this.formatTimeToFunding(timeToFundingMs)} was available]` : '')
    );

    return result;
  }

  /**
   * Execute a single slice
   */
  private async executeSlice(
    longAdapter: IPerpExchangeAdapter,
    shortAdapter: IPerpExchangeAdapter,
    symbol: string,
    sliceSize: number,
    longPrice: number,
    shortPrice: number,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    sliceNumber: number,
    config: SlicedExecutionConfig,
    firstIsLong: boolean,
  ): Promise<SliceResult> {
    const result: SliceResult = {
      sliceNumber,
      longFilled: false,
      shortFilled: false,
      longFilledSize: 0,
      shortFilledSize: 0,
    };

    // Create orders
    const longOrder = new PerpOrderRequest(
      symbol,
      OrderSide.LONG,
      OrderType.LIMIT,
      sliceSize,
      longPrice,
      TimeInForce.GTC,
    );

    const shortOrder = new PerpOrderRequest(
      symbol,
      OrderSide.SHORT,
      OrderType.LIMIT,
      sliceSize,
      shortPrice,
      TimeInForce.GTC,
    );

    // Execute first leg (Lighter if involved)
    const firstAdapter = firstIsLong ? longAdapter : shortAdapter;
    const firstOrder = firstIsLong ? longOrder : shortOrder;
    const firstExchange = firstIsLong ? longExchange : shortExchange;

    try {
      const firstResponse = await firstAdapter.placeOrder(firstOrder);
      
      if (!firstResponse.isSuccess()) {
        result.error = `First leg (${firstIsLong ? 'LONG' : 'SHORT'}) failed: ${firstResponse.error}`;
        return result;
      }

      if (firstIsLong) {
        result.longOrderId = firstResponse.orderId;
      } else {
        result.shortOrderId = firstResponse.orderId;
      }

      // Wait for first leg to fill (with timeout)
      const firstFillResult = await this.waitForFill(
        firstAdapter,
        firstResponse.orderId!,
        symbol,
        sliceSize,
        config.sliceFillTimeoutMs,
        config.fillCheckIntervalMs,
      );

      if (firstIsLong) {
        result.longFilledSize = firstFillResult.filledSize;
        result.longFilled = firstFillResult.filled;
      } else {
        result.shortFilledSize = firstFillResult.filledSize;
        result.shortFilled = firstFillResult.filled;
      }

      // If first leg didn't fill well, don't proceed with second
      if (firstFillResult.filledSize < sliceSize * 0.5) {
        result.error = `First leg only ${((firstFillResult.filledSize / sliceSize) * 100).toFixed(0)}% filled`;
        // Cancel remaining first leg order
        if (firstResponse.orderId && !firstFillResult.filled) {
          await firstAdapter.cancelOrder(firstResponse.orderId, symbol).catch(() => {});
        }
        return result;
      }

      // Execute second leg with size matching first leg's fill
      const secondAdapter = firstIsLong ? shortAdapter : longAdapter;
      const matchedSize = firstFillResult.filledSize; // Match the actual fill
      const secondOrder = new PerpOrderRequest(
        symbol,
        firstIsLong ? OrderSide.SHORT : OrderSide.LONG,
        OrderType.LIMIT,
        matchedSize,
        firstIsLong ? shortPrice : longPrice,
        TimeInForce.GTC,
      );

      const secondResponse = await secondAdapter.placeOrder(secondOrder);

      if (!secondResponse.isSuccess()) {
        result.error = `Second leg failed: ${secondResponse.error}`;
        // Rollback first leg
        await this.rollbackLeg(
          firstAdapter,
          symbol,
          firstFillResult.filledSize,
          firstIsLong ? OrderSide.LONG : OrderSide.SHORT,
          firstIsLong ? longPrice : shortPrice,
        );
        if (firstIsLong) {
          result.longFilledSize = 0;
          result.longFilled = false;
        } else {
          result.shortFilledSize = 0;
          result.shortFilled = false;
        }
        return result;
      }

      if (firstIsLong) {
        result.shortOrderId = secondResponse.orderId;
      } else {
        result.longOrderId = secondResponse.orderId;
      }

      // Wait for second leg to fill
      const secondFillResult = await this.waitForFill(
        secondAdapter,
        secondResponse.orderId!,
        symbol,
        matchedSize,
        config.sliceFillTimeoutMs,
        config.fillCheckIntervalMs,
      );

      if (firstIsLong) {
        result.shortFilledSize = secondFillResult.filledSize;
        result.shortFilled = secondFillResult.filled;
      } else {
        result.longFilledSize = secondFillResult.filledSize;
        result.longFilled = secondFillResult.filled;
      }

      // If second leg partially filled, we have imbalance (handled by caller)
      if (!secondFillResult.filled && secondResponse.orderId) {
        // Cancel unfilled portion
        await secondAdapter.cancelOrder(secondResponse.orderId, symbol).catch(() => {});
      }

      return result;

    } catch (error: any) {
      result.error = error.message;
      this.logger.error(`Slice ${sliceNumber} error: ${error.message}`);
      return result;
    }
  }

  /**
   * Wait for an order to fill
   */
  private async waitForFill(
    adapter: IPerpExchangeAdapter,
    orderId: string,
    symbol: string,
    expectedSize: number,
    timeoutMs: number,
    checkIntervalMs: number,
  ): Promise<{ filled: boolean; filledSize: number }> {
    const startTime = Date.now();
    let lastFilledSize = 0;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const orderStatus = await adapter.getOrderStatus(orderId, symbol);
        
        if (orderStatus.status === 'FILLED') {
          return { filled: true, filledSize: orderStatus.filledSize || expectedSize };
        }

        if (orderStatus.status === 'PARTIALLY_FILLED') {
          lastFilledSize = orderStatus.filledSize || 0;
        }

        if (orderStatus.status === 'CANCELLED' || orderStatus.status === 'REJECTED') {
          return { filled: false, filledSize: lastFilledSize };
        }

        await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
      } catch (error: any) {
        // If we can't get status, check position instead
        try {
          const position = await adapter.getPosition(symbol);
          if (position && Math.abs(position.size) >= expectedSize * 0.95) {
            return { filled: true, filledSize: Math.abs(position.size) };
          }
        } catch {
          // Continue waiting
        }
        await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
      }
    }

    // Timeout - return what we have
    return { filled: false, filledSize: lastFilledSize };
  }

  /**
   * Rollback a filled leg by placing opposite order
   */
  private async rollbackLeg(
    adapter: IPerpExchangeAdapter,
    symbol: string,
    size: number,
    originalSide: OrderSide,
    price: number,
  ): Promise<void> {
    try {
      const rollbackOrder = new PerpOrderRequest(
        symbol,
        originalSide === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG,
        OrderType.LIMIT,
        size,
        price,
        TimeInForce.GTC,
        true, // reduceOnly
      );
      await adapter.placeOrder(rollbackOrder);
      this.logger.log(`✅ Rolled back ${originalSide} position of ${size.toFixed(4)} ${symbol}`);
    } catch (error: any) {
      this.logger.error(`🚨 Failed to rollback ${originalSide} leg: ${error.message}`);
    }
  }
}

