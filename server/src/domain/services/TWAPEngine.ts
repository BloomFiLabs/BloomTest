import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../ports/IPerpExchangeAdapter';
import {
  OrderSide,
  OrderType,
  PerpOrderRequest,
  TimeInForce,
} from '../value-objects/PerpOrder';
import { Result } from '../common/Result';
import { DomainException } from '../exceptions/DomainException';

/**
 * TWAP (Time-Weighted Average Price) Engine
 *
 * Executes large orders by splitting them into smaller chunks over time,
 * allowing order books to replenish and minimizing market impact.
 *
 * Key features:
 * - Analyzes order book depth and replenishment rate
 * - Calculates optimal slice count and timing
 * - Ensures both legs of delta-neutral positions stay balanced
 * - Handles partial fills gracefully
 */

export interface OrderBookSnapshot {
  symbol: string;
  exchange: ExchangeType;
  bidDepth: number; // Total USD on bid side
  askDepth: number; // Total USD on ask side
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadBps: number;
  timestamp: number;
}

export interface TWAPStrategy {
  symbol: string;
  totalPositionUsd: number;
  sliceCount: number;
  sliceSizeUsd: number;
  intervalMinutes: number;
  totalDurationMinutes: number;
  estimatedSlippageBps: number;
  estimatedTotalCostUsd: number;
  maxSlippagePerSliceBps: number;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reasoning: string;
}

export interface TWAPExecutionState {
  id: string;
  strategy: TWAPStrategy;
  status: 'PENDING' | 'EXECUTING' | 'COMPLETED' | 'FAILED' | 'PAUSED' | 'ABORTED';
  slicesExecuted: number;
  totalFilledLong: number;
  totalFilledShort: number;
  averageFillPriceLong: number;
  averageFillPriceShort: number;
  actualSlippageBps: number;
  startTime: number;
  lastSliceTime: number | null;
  nextSliceTime: number | null;
  errors: string[];
}

export interface TWAPSliceResult {
  sliceNumber: number;
  longFilled: number;
  shortFilled: number;
  longPrice: number;
  shortPrice: number;
  slippageBps: number;
  success: boolean;
  error?: string;
}

@Injectable()
export class TWAPEngine {
  private readonly logger = new Logger(TWAPEngine.name);

  // Configuration
  private readonly MIN_SLICE_SIZE_USD = 1000; // Don't go below $1k per slice
  private readonly MAX_SLICE_SIZE_USD = 50000; // Cap each slice at $50k
  private readonly MIN_SLICES = 2;
  private readonly MAX_SLICES = 24; // Max 24 slices (3 hours at 7.5min intervals)
  private readonly MAX_BOOK_USAGE_PER_SLICE = 0.05; // 5% of book per slice
  private readonly FUNDING_EPOCH_HOURS = 8;
  private readonly SAFETY_BUFFER_MINUTES = 30; // Complete 30min before epoch

  // Active executions
  private activeExecutions: Map<string, TWAPExecutionState> = new Map();

  /**
   * Analyze order books and calculate optimal TWAP strategy
   */
  async calculateOptimalStrategy(
    symbol: string,
    targetPositionUsd: number,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
    longAdapter: IPerpExchangeAdapter,
    shortAdapter: IPerpExchangeAdapter,
    maxDurationMinutes: number = 240, // Default 4 hours max
  ): Promise<Result<TWAPStrategy, DomainException>> {
    try {
      this.logger.log(
        `📊 Calculating TWAP strategy for ${symbol}: $${targetPositionUsd.toLocaleString()} across ${longExchange}/${shortExchange}`,
      );

      // Step 1: Get current order book snapshots
      const [longBook, shortBook] = await Promise.all([
        this.getOrderBookSnapshot(symbol, longExchange, longAdapter),
        this.getOrderBookSnapshot(symbol, shortExchange, shortAdapter),
      ]);

      if (!longBook || !shortBook) {
        return Result.failure(
          new DomainException(`Failed to get order book data for ${symbol}`),
        );
      }

      // Step 2: Calculate effective depth (use more conservative side)
      // For long: we need ASK depth, for short: we need BID depth
      const longEffectiveDepth = longBook.askDepth;
      const shortEffectiveDepth = shortBook.bidDepth;
      const minEffectiveDepth = Math.min(longEffectiveDepth, shortEffectiveDepth);

      this.logger.debug(
        `${symbol} effective depth: Long(ask)=$${(longEffectiveDepth / 1000).toFixed(1)}k, ` +
          `Short(bid)=$${(shortEffectiveDepth / 1000).toFixed(1)}k, ` +
          `Min=$${(minEffectiveDepth / 1000).toFixed(1)}k`,
      );

      // Step 3: Calculate max safe size per slice (5% of min depth)
      const maxSafePerSlice = Math.min(
        minEffectiveDepth * this.MAX_BOOK_USAGE_PER_SLICE,
        this.MAX_SLICE_SIZE_USD,
      );

      if (maxSafePerSlice < this.MIN_SLICE_SIZE_USD) {
        return Result.failure(
          new DomainException(
            `Order book too thin for ${symbol}: max safe slice $${maxSafePerSlice.toFixed(0)} < min $${this.MIN_SLICE_SIZE_USD}`,
          ),
        );
      }

      // Step 4: Calculate optimal slice count
      const rawSliceCount = Math.ceil(targetPositionUsd / maxSafePerSlice);
      const sliceCount = Math.max(
        this.MIN_SLICES,
        Math.min(rawSliceCount, this.MAX_SLICES),
      );
      const sliceSizeUsd = targetPositionUsd / sliceCount;

      // Step 5: Calculate optimal interval
      // Rule: More slices = longer intervals (allow book to replenish)
      // Constraint: Must complete before funding epoch
      const maxTotalMinutes = Math.min(
        maxDurationMinutes,
        this.FUNDING_EPOCH_HOURS * 60 - this.SAFETY_BUFFER_MINUTES,
      );
      const idealIntervalMinutes = Math.floor(maxTotalMinutes / sliceCount);
      const intervalMinutes = Math.max(5, Math.min(idealIntervalMinutes, 30)); // 5-30 min range
      const totalDurationMinutes = intervalMinutes * (sliceCount - 1); // First slice immediate

      // Step 6: Estimate slippage
      const avgSpreadBps = (longBook.spreadBps + shortBook.spreadBps) / 2;
      const bookUsageRatio = sliceSizeUsd / minEffectiveDepth;
      const marketImpactBps = Math.sqrt(bookUsageRatio) * 10; // sqrt model
      const slippagePerSliceBps = avgSpreadBps / 2 + marketImpactBps;
      const totalSlippageBps = slippagePerSliceBps * 2; // Entry + exit estimate
      const estimatedTotalCostUsd = (totalSlippageBps / 10000) * targetPositionUsd;

      // Step 7: Determine confidence
      let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
      let reasoning: string;

      if (bookUsageRatio < 0.03 && sliceCount <= 8) {
        confidence = 'HIGH';
        reasoning = `Small position relative to book depth (${(bookUsageRatio * 100).toFixed(1)}%), minimal market impact expected`;
      } else if (bookUsageRatio < 0.08 && sliceCount <= 16) {
        confidence = 'MEDIUM';
        reasoning = `Moderate position size (${(bookUsageRatio * 100).toFixed(1)}% per slice), TWAP essential to minimize impact`;
      } else {
        confidence = 'LOW';
        reasoning = `Large position (${(bookUsageRatio * 100).toFixed(1)}% per slice), significant market impact likely even with TWAP`;
      }

      const strategy: TWAPStrategy = {
        symbol,
        totalPositionUsd: targetPositionUsd,
        sliceCount,
        sliceSizeUsd,
        intervalMinutes,
        totalDurationMinutes,
        estimatedSlippageBps: totalSlippageBps,
        estimatedTotalCostUsd,
        maxSlippagePerSliceBps: slippagePerSliceBps * 2, // Allow 2x estimate per slice
        longExchange,
        shortExchange,
        confidence,
        reasoning,
      };

      this.logger.log(
        `✅ TWAP Strategy for ${symbol}:\n` +
          `   Total: $${targetPositionUsd.toLocaleString()}\n` +
          `   Slices: ${sliceCount} × $${sliceSizeUsd.toLocaleString()}\n` +
          `   Interval: ${intervalMinutes} minutes\n` +
          `   Duration: ${totalDurationMinutes} minutes\n` +
          `   Est. Slippage: ${totalSlippageBps.toFixed(1)} bps ($${estimatedTotalCostUsd.toFixed(2)})\n` +
          `   Confidence: ${confidence} - ${reasoning}`,
      );

      return Result.success(strategy);
    } catch (error: any) {
      this.logger.error(`Failed to calculate TWAP strategy: ${error.message}`);
      return Result.failure(new DomainException(`TWAP calculation failed: ${error.message}`));
    }
  }

  /**
   * Get order book snapshot from an exchange
   */
  private async getOrderBookSnapshot(
    symbol: string,
    exchange: ExchangeType,
    adapter: IPerpExchangeAdapter,
  ): Promise<OrderBookSnapshot | null> {
    try {
      // Most adapters have getBestBidAsk or similar
      const bidAsk = await (adapter as any).getBestBidAsk?.(symbol);

      if (!bidAsk || !bidAsk.bestBid || !bidAsk.bestAsk) {
        // Fallback to mark price with estimated spread
        const markPrice = await adapter.getMarkPrice(symbol);
        const estimatedSpread = markPrice * 0.001; // 0.1% spread estimate
        return {
          symbol,
          exchange,
          bidDepth: 50000, // Conservative estimate
          askDepth: 50000,
          bestBid: markPrice - estimatedSpread / 2,
          bestAsk: markPrice + estimatedSpread / 2,
          spread: estimatedSpread,
          spreadBps: 10,
          timestamp: Date.now(),
        };
      }

      // Try to get actual depth if available
      let bidDepth = 50000; // Default
      let askDepth = 50000;

      if ((adapter as any).getOrderBookDepth) {
        const depth = await (adapter as any).getOrderBookDepth(symbol);
        bidDepth = depth?.bidDepth || 50000;
        askDepth = depth?.askDepth || 50000;
      }

      const spread = bidAsk.bestAsk - bidAsk.bestBid;
      const midPrice = (bidAsk.bestBid + bidAsk.bestAsk) / 2;
      const spreadBps = midPrice > 0 ? (spread / midPrice) * 10000 : 10;

      return {
        symbol,
        exchange,
        bidDepth,
        askDepth,
        bestBid: bidAsk.bestBid,
        bestAsk: bidAsk.bestAsk,
        spread,
        spreadBps,
        timestamp: Date.now(),
      };
    } catch (error: any) {
      this.logger.warn(`Failed to get order book for ${symbol} on ${exchange}: ${error.message}`);
      return null;
    }
  }

  /**
   * Start TWAP execution
   */
  async startExecution(
    strategy: TWAPStrategy,
    longAdapter: IPerpExchangeAdapter,
    shortAdapter: IPerpExchangeAdapter,
    leverage: number = 3,
  ): Promise<Result<TWAPExecutionState, DomainException>> {
    const executionId = `twap-${strategy.symbol}-${Date.now()}`;

    const state: TWAPExecutionState = {
      id: executionId,
      strategy,
      status: 'EXECUTING',
      slicesExecuted: 0,
      totalFilledLong: 0,
      totalFilledShort: 0,
      averageFillPriceLong: 0,
      averageFillPriceShort: 0,
      actualSlippageBps: 0,
      startTime: Date.now(),
      lastSliceTime: null,
      nextSliceTime: Date.now(), // First slice immediate
      errors: [],
    };

    this.activeExecutions.set(executionId, state);

    this.logger.log(
      `🚀 Starting TWAP execution ${executionId} for ${strategy.symbol}: ` +
        `${strategy.sliceCount} slices over ${strategy.totalDurationMinutes} minutes`,
    );

    // Execute first slice immediately
    const firstSlice = await this.executeSlice(
      state,
      longAdapter,
      shortAdapter,
      leverage,
    );

    if (!firstSlice.success) {
      state.status = 'FAILED';
      state.errors.push(firstSlice.error || 'First slice failed');
      return Result.failure(new DomainException(`TWAP first slice failed: ${firstSlice.error}`));
    }

    // Schedule remaining slices
    this.scheduleRemainingSlices(state, longAdapter, shortAdapter, leverage);

    return Result.success(state);
  }

  /**
   * Execute a single slice of the TWAP order
   */
  private async executeSlice(
    state: TWAPExecutionState,
    longAdapter: IPerpExchangeAdapter,
    shortAdapter: IPerpExchangeAdapter,
    leverage: number,
  ): Promise<TWAPSliceResult> {
    const sliceNumber = state.slicesExecuted + 1;
    const sliceSizeUsd = state.strategy.sliceSizeUsd;

    this.logger.debug(
      `📦 Executing slice ${sliceNumber}/${state.strategy.sliceCount} for ${state.strategy.symbol}: $${sliceSizeUsd.toFixed(0)}`,
    );

    try {
      // Get current prices
      const [longPrice, shortPrice] = await Promise.all([
        longAdapter.getMarkPrice(state.strategy.symbol),
        shortAdapter.getMarkPrice(state.strategy.symbol),
      ]);

      const sliceSizeBase = sliceSizeUsd / ((longPrice + shortPrice) / 2);

      // Create orders for both legs as LIMIT at mark price to act as maker
      const longOrder = new PerpOrderRequest(
        state.strategy.symbol,
        OrderSide.LONG,
        OrderType.LIMIT,
        sliceSizeBase,
        longPrice, // Use mark price
        TimeInForce.GTC,
        false,
      );

      const shortOrder = new PerpOrderRequest(
        state.strategy.symbol,
        OrderSide.SHORT,
        OrderType.LIMIT,
        sliceSizeBase,
        shortPrice, // Use mark price
        TimeInForce.GTC,
        false,
      );

      // Execute both legs simultaneously
      const [longResult, shortResult] = await Promise.all([
        longAdapter.placeOrder(longOrder),
        shortAdapter.placeOrder(shortOrder),
      ]);

      // Analyze results
      const longFilled = longResult.filledSize || 0;
      const shortFilled = shortResult.filledSize || 0;
      const longExecPrice = longResult.averageFillPrice || longPrice;
      const shortExecPrice = shortResult.averageFillPrice || shortPrice;

      // Check for imbalance
      const fillRatio = Math.min(longFilled, shortFilled) / Math.max(longFilled, shortFilled);
      if (fillRatio < 0.9) {
        this.logger.warn(
          `⚠️ Slice ${sliceNumber} imbalance: Long ${longFilled.toFixed(4)} vs Short ${shortFilled.toFixed(4)} (${(fillRatio * 100).toFixed(0)}% ratio)`,
        );
      }

      // Calculate slippage
      const expectedMid = (longPrice + shortPrice) / 2;
      const actualMid = (longExecPrice + shortExecPrice) / 2;
      const slippageBps = Math.abs((actualMid - expectedMid) / expectedMid) * 10000;

      // Update state
      const prevFilledLong = state.totalFilledLong;
      const prevFilledShort = state.totalFilledShort;

      state.totalFilledLong += longFilled;
      state.totalFilledShort += shortFilled;
      state.slicesExecuted = sliceNumber;
      state.lastSliceTime = Date.now();

      // Update weighted average prices
      state.averageFillPriceLong =
        (state.averageFillPriceLong * prevFilledLong + longExecPrice * longFilled) /
        (prevFilledLong + longFilled || 1);
      state.averageFillPriceShort =
        (state.averageFillPriceShort * prevFilledShort + shortExecPrice * shortFilled) /
        (prevFilledShort + shortFilled || 1);

      // Update actual slippage (weighted by filled amount)
      state.actualSlippageBps =
        (state.actualSlippageBps * prevFilledLong + slippageBps * longFilled) /
        (prevFilledLong + longFilled || 1);

      this.logger.log(
        `✅ Slice ${sliceNumber}/${state.strategy.sliceCount} complete: ` +
          `Long ${longFilled.toFixed(4)} @ $${longExecPrice.toFixed(4)}, ` +
          `Short ${shortFilled.toFixed(4)} @ $${shortExecPrice.toFixed(4)}, ` +
          `Slippage: ${slippageBps.toFixed(1)} bps`,
      );

      return {
        sliceNumber,
        longFilled,
        shortFilled,
        longPrice: longExecPrice,
        shortPrice: shortExecPrice,
        slippageBps,
        success: true,
      };
    } catch (error: any) {
      this.logger.error(`❌ Slice ${sliceNumber} failed: ${error.message}`);
      state.errors.push(`Slice ${sliceNumber}: ${error.message}`);

      return {
        sliceNumber,
        longFilled: 0,
        shortFilled: 0,
        longPrice: 0,
        shortPrice: 0,
        slippageBps: 0,
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Schedule remaining slices using setTimeout
   */
  private scheduleRemainingSlices(
    state: TWAPExecutionState,
    longAdapter: IPerpExchangeAdapter,
    shortAdapter: IPerpExchangeAdapter,
    leverage: number,
  ): void {
    const remainingSlices = state.strategy.sliceCount - state.slicesExecuted;
    const intervalMs = state.strategy.intervalMinutes * 60 * 1000;

    for (let i = 0; i < remainingSlices; i++) {
      const delay = intervalMs * (i + 1);
      const sliceNum = state.slicesExecuted + i + 2;

      setTimeout(async () => {
        // Check if execution is still active
        const currentState = this.activeExecutions.get(state.id);
        if (!currentState || currentState.status !== 'EXECUTING') {
          this.logger.warn(`TWAP ${state.id} not active, skipping slice ${sliceNum}`);
          return;
        }

        const result = await this.executeSlice(currentState, longAdapter, shortAdapter, leverage);

        // Check if complete
        if (currentState.slicesExecuted >= state.strategy.sliceCount) {
          currentState.status = 'COMPLETED';
          this.logger.log(
            `🎉 TWAP ${state.id} COMPLETE!\n` +
              `   Total Long: ${currentState.totalFilledLong.toFixed(4)} @ avg $${currentState.averageFillPriceLong.toFixed(4)}\n` +
              `   Total Short: ${currentState.totalFilledShort.toFixed(4)} @ avg $${currentState.averageFillPriceShort.toFixed(4)}\n` +
              `   Actual Slippage: ${currentState.actualSlippageBps.toFixed(1)} bps\n` +
              `   Duration: ${((Date.now() - currentState.startTime) / 60000).toFixed(1)} minutes`,
          );
        }

        // Check for too many failures
        if (currentState.errors.length > state.strategy.sliceCount / 2) {
          currentState.status = 'FAILED';
          this.logger.error(`TWAP ${state.id} FAILED: Too many slice errors`);
        }
      }, delay);

      this.logger.debug(`Scheduled slice ${sliceNum} in ${delay / 60000} minutes`);
    }
  }

  /**
   * Pause an active TWAP execution
   */
  pauseExecution(executionId: string): boolean {
    const state = this.activeExecutions.get(executionId);
    if (!state || state.status !== 'EXECUTING') {
      return false;
    }
    state.status = 'PAUSED';
    this.logger.warn(`⏸️ TWAP ${executionId} PAUSED at slice ${state.slicesExecuted}`);
    return true;
  }

  /**
   * Abort an active TWAP execution
   */
  abortExecution(executionId: string): boolean {
    const state = this.activeExecutions.get(executionId);
    if (!state) {
      return false;
    }
    state.status = 'ABORTED';
    this.logger.warn(`🛑 TWAP ${executionId} ABORTED at slice ${state.slicesExecuted}`);
    return true;
  }

  /**
   * Get current state of an execution
   */
  getExecutionState(executionId: string): TWAPExecutionState | undefined {
    return this.activeExecutions.get(executionId);
  }

  /**
   * Get all active executions
   */
  getAllExecutions(): TWAPExecutionState[] {
    return Array.from(this.activeExecutions.values());
  }

  /**
   * Calculate optimal strategy for multiple symbols and return portfolio plan
   */
  async calculatePortfolioTWAP(
    opportunities: Array<{
      symbol: string;
      targetPositionUsd: number;
      longExchange: ExchangeType;
      shortExchange: ExchangeType;
    }>,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<Map<string, TWAPStrategy>> {
    const strategies = new Map<string, TWAPStrategy>();

    for (const opp of opportunities) {
      const longAdapter = adapters.get(opp.longExchange);
      const shortAdapter = adapters.get(opp.shortExchange);

      if (!longAdapter || !shortAdapter) {
        this.logger.warn(`Missing adapter for ${opp.symbol}, skipping`);
        continue;
      }

      const result = await this.calculateOptimalStrategy(
        opp.symbol,
        opp.targetPositionUsd,
        opp.longExchange,
        opp.shortExchange,
        longAdapter,
        shortAdapter,
      );

      if (result.isSuccess) {
        strategies.set(opp.symbol, result.value);
      }
    }

    return strategies;
  }
}



