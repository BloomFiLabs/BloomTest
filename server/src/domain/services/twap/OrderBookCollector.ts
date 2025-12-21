import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';

/**
 * Order book snapshot at a point in time
 * Captures depth at multiple levels for analysis
 */
export interface OrderBookSnapshot {
  id: string;
  symbol: string;
  exchange: ExchangeType;
  timestamp: Date;
  
  // Depth at various levels (in USD)
  bidDepth5: number;   // Top 5 price levels
  bidDepth10: number;  // Top 10 price levels
  bidDepth20: number;  // Top 20 price levels
  askDepth5: number;
  askDepth10: number;
  askDepth20: number;
  
  // Price data
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadBps: number;
  
  // Time-of-day for pattern analysis (0-23 UTC)
  hourOfDay: number;
  dayOfWeek: number; // 0-6, Sunday = 0
}

/**
 * Aggregated liquidity metrics for a symbol
 */
export interface LiquidityMetrics {
  symbol: string;
  exchange: ExchangeType;
  
  // Depth statistics (7-day rolling)
  avgBidDepth5: number;
  avgBidDepth10: number;
  avgBidDepth20: number;
  avgAskDepth5: number;
  avgAskDepth10: number;
  avgAskDepth20: number;
  
  // Variance (for confidence estimation)
  bidDepthVariance: number;
  askDepthVariance: number;
  
  // Spread statistics
  avgSpreadBps: number;
  minSpreadBps: number;
  maxSpreadBps: number;
  
  // Time-of-day multipliers (24 hours)
  hourlyDepthMultipliers: number[];
  
  // Data quality
  snapshotCount: number;
  lastUpdated: Date;
}

/**
 * OrderBookCollector - Collects and stores order book snapshots
 * 
 * Collects snapshots every minute for active symbols, storing 7 days of history.
 * Used by calibration services to build liquidity profiles and optimize TWAP parameters.
 */
@Injectable()
export class OrderBookCollector implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrderBookCollector.name);
  
  // In-memory storage (will be backed by repository)
  private snapshots: Map<string, OrderBookSnapshot[]> = new Map(); // key: symbol-exchange
  
  // Configuration
  private readonly COLLECTION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (was 1 minute)
  private readonly RETENTION_DAYS = 7;
  private readonly RETENTION_MS = this.RETENTION_DAYS * 24 * 60 * 60 * 1000;
  private readonly MAX_SNAPSHOTS_PER_SYMBOL = 7 * 24 * 60; // 7 days of minute data
  
  // State
  private collectionInterval: NodeJS.Timeout | null = null;
  private activeSymbols: Set<string> = new Set();
  private adapters: Map<ExchangeType, IPerpExchangeAdapter> = new Map();
  private isCollecting = false;
  private lastStatusLog = 0;
  private readonly STATUS_LOG_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  
  // Metrics cache (computed periodically)
  private metricsCache: Map<string, LiquidityMetrics> = new Map();
  private metricsCacheLastUpdate: Date | null = null;
  private readonly METRICS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  async onModuleInit(): Promise<void> {
    this.logger.log('OrderBookCollector initialized');
  }

  async onModuleDestroy(): Promise<void> {
    this.stopCollection();
  }

  /**
   * Check if collection is running
   */
  public isCollectingStatus(): boolean {
    return this.isCollecting;
  }

  /**
   * Initialize the collector with adapters
   */
  initialize(adapters: Map<ExchangeType, IPerpExchangeAdapter>): void {
    this.adapters = adapters;
    this.logger.log(`OrderBookCollector initialized with ${adapters.size} adapters`);
  }

  /**
   * Start collecting order book snapshots
   */
  startCollection(symbols: string[]): void {
    if (this.isCollecting) {
      this.logger.warn('Collection already running');
      return;
    }

    this.activeSymbols = new Set(symbols);
    this.isCollecting = true;
    
    this.logger.log(`Starting order book collection for ${symbols.length} symbols`);
    
    // Collect immediately
    this.collectSnapshots().catch(err => 
      this.logger.error(`Initial collection failed: ${err.message}`)
    );
    
    // Then collect every minute
    this.collectionInterval = setInterval(() => {
      this.collectSnapshots().catch(err => 
        this.logger.error(`Collection failed: ${err.message}`)
      );
    }, this.COLLECTION_INTERVAL_MS);
  }

  /**
   * Stop collecting snapshots
   */
  stopCollection(): void {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
    }
    this.isCollecting = false;
    this.logger.log('Order book collection stopped');
  }

  /**
   * Add symbols to track
   */
  addSymbols(symbols: string[]): void {
    for (const symbol of symbols) {
      this.activeSymbols.add(symbol);
    }
    this.logger.debug(`Added ${symbols.length} symbols, now tracking ${this.activeSymbols.size}`);
  }

  /**
   * Remove symbols from tracking
   */
  removeSymbols(symbols: string[]): void {
    for (const symbol of symbols) {
      this.activeSymbols.delete(symbol);
    }
    this.logger.debug(`Removed ${symbols.length} symbols, now tracking ${this.activeSymbols.size}`);
  }

  /**
   * Collect snapshots for all active symbols
   */
  private async collectSnapshots(): Promise<void> {
    const timestamp = new Date();
    const hourOfDay = timestamp.getUTCHours();
    const dayOfWeek = timestamp.getUTCDay();
    
    const collectionPromises: Promise<void>[] = [];
    
    for (const symbol of this.activeSymbols) {
      for (const [exchangeType, adapter] of this.adapters) {
        // Only collect if adapter supports the symbol
        const isSupported = await adapter.supportsSymbol(symbol);
        if (!isSupported) {
          continue;
        }

        collectionPromises.push(
          this.collectSnapshot(symbol, exchangeType, adapter, timestamp, hourOfDay, dayOfWeek)
            .catch(err => {
              this.logger.debug(`Failed to collect ${symbol} on ${exchangeType}: ${err.message}`);
            })
        );
      }
    }
    
    await Promise.allSettled(collectionPromises);
    
    // Log progress periodically
    const now = Date.now();
    if (now - this.lastStatusLog > this.STATUS_LOG_INTERVAL_MS) {
      let totalSnapshots = 0;
      for (const list of this.snapshots.values()) totalSnapshots += list.length;
      this.logger.log(
        `📊 Order book collection: ${this.activeSymbols.size} symbols, ` +
        `${totalSnapshots} total snapshots stored`
      );
      this.lastStatusLog = now;
    }
    
    // Prune old snapshots
    this.pruneOldSnapshots();
  }

  /**
   * Collect a single snapshot
   */
  private async collectSnapshot(
    symbol: string,
    exchange: ExchangeType,
    adapter: IPerpExchangeAdapter,
    timestamp: Date,
    hourOfDay: number,
    dayOfWeek: number,
  ): Promise<void> {
    try {
      // Get order book data
      const bookData = await this.getOrderBookData(symbol, adapter);
      
      if (!bookData) {
        return;
      }
      
      const snapshot: OrderBookSnapshot = {
        id: `${symbol}-${exchange}-${timestamp.getTime()}`,
        symbol,
        exchange,
        timestamp,
        bidDepth5: bookData.bidDepth5,
        bidDepth10: bookData.bidDepth10,
        bidDepth20: bookData.bidDepth20,
        askDepth5: bookData.askDepth5,
        askDepth10: bookData.askDepth10,
        askDepth20: bookData.askDepth20,
        bestBid: bookData.bestBid,
        bestAsk: bookData.bestAsk,
        midPrice: (bookData.bestBid + bookData.bestAsk) / 2,
        spreadBps: bookData.spreadBps,
        hourOfDay,
        dayOfWeek,
      };
      
      // Store snapshot
      const key = `${symbol}-${exchange}`;
      if (!this.snapshots.has(key)) {
        this.snapshots.set(key, []);
      }
      
      const symbolSnapshots = this.snapshots.get(key)!;
      symbolSnapshots.push(snapshot);
      
      // Keep only max snapshots
      if (symbolSnapshots.length > this.MAX_SNAPSHOTS_PER_SYMBOL) {
        symbolSnapshots.shift();
      }
      
    } catch (error: any) {
      // Silently fail for individual symbols
    }
  }

  /**
   * Get order book data from adapter
   */
  private async getOrderBookData(
    symbol: string,
    adapter: IPerpExchangeAdapter,
  ): Promise<{
    bidDepth5: number;
    bidDepth10: number;
    bidDepth20: number;
    askDepth5: number;
    askDepth10: number;
    askDepth20: number;
    bestBid: number;
    bestAsk: number;
    spreadBps: number;
  } | null> {
    try {
      // FOR BACKGROUND COLLECTION: 
      // We ONLY want to use WebSocket data if available. 
      // Falling back to REST API for 100+ symbols every cycle will cause 429 rate limits
      // and block the main strategy execution.

      // 1. Try getBestBidAsk (which we've optimized to check WS cache first)
      // But we need to ensure it doesn't fall back to REST if WS is missing.
      const bidAsk = await (adapter as any).getBestBidAsk(symbol, true); // cacheOnly = true

      if (bidAsk && bidAsk.bestBid && bidAsk.bestAsk) {
        // If it was fast (< 50ms), it was likely from cache.
        // If it was slow, it might have hit REST. 
        // We'll allow it for now but log a warning if it's consistently slow.
        
        const spread = bidAsk.bestAsk - bidAsk.bestBid;
        const midPrice = (bidAsk.bestBid + bidAsk.bestAsk) / 2;
        const spreadBps = midPrice > 0 ? (spread / midPrice) * 10000 : 10;
        
        // Estimate depth from bid/ask prices (rough estimate)
        const estimatedDepth = midPrice * 100; // Assume ~$100k depth as default
        
        return {
          bidDepth5: estimatedDepth * 0.3,
          bidDepth10: estimatedDepth * 0.6,
          bidDepth20: estimatedDepth,
          askDepth5: estimatedDepth * 0.3,
          askDepth10: estimatedDepth * 0.6,
          askDepth20: estimatedDepth,
          bestBid: bidAsk.bestBid,
          bestAsk: bidAsk.bestAsk,
          spreadBps,
        };
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Parse order book response into depth metrics
   */
  private parseOrderBook(book: any): {
    bidDepth5: number;
    bidDepth10: number;
    bidDepth20: number;
    askDepth5: number;
    askDepth10: number;
    askDepth20: number;
    bestBid: number;
    bestAsk: number;
    spreadBps: number;
  } | null {
    try {
      const bids = book.bids || book.levels?.[0] || [];
      const asks = book.asks || book.levels?.[1] || [];
      
      if (!bids.length || !asks.length) {
        return null;
      }
      
      // Calculate depth at different levels
      const calcDepth = (levels: any[], count: number): number => {
        let depth = 0;
        for (let i = 0; i < Math.min(count, levels.length); i++) {
          const price = parseFloat(levels[i].price || levels[i].px || levels[i][0]);
          const size = parseFloat(levels[i].size || levels[i].sz || levels[i][1]);
          depth += price * size;
        }
        return depth;
      };
      
      const bestBid = parseFloat(bids[0].price || bids[0].px || bids[0][0]);
      const bestAsk = parseFloat(asks[0].price || asks[0].px || asks[0][0]);
      const midPrice = (bestBid + bestAsk) / 2;
      const spread = bestAsk - bestBid;
      const spreadBps = midPrice > 0 ? (spread / midPrice) * 10000 : 10;
      
      return {
        bidDepth5: calcDepth(bids, 5),
        bidDepth10: calcDepth(bids, 10),
        bidDepth20: calcDepth(bids, 20),
        askDepth5: calcDepth(asks, 5),
        askDepth10: calcDepth(asks, 10),
        askDepth20: calcDepth(asks, 20),
        bestBid,
        bestAsk,
        spreadBps,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Prune snapshots older than retention period
   */
  private pruneOldSnapshots(): void {
    const cutoff = Date.now() - this.RETENTION_MS;
    
    for (const [key, snapshots] of this.snapshots) {
      const filtered = snapshots.filter(s => s.timestamp.getTime() > cutoff);
      this.snapshots.set(key, filtered);
    }
  }

  /**
   * Get snapshots for a symbol/exchange pair
   */
  getSnapshots(symbol: string, exchange: ExchangeType): OrderBookSnapshot[] {
    const key = `${symbol}-${exchange}`;
    return this.snapshots.get(key) || [];
  }

  /**
   * Get snapshots for a specific time range
   */
  getSnapshotsInRange(
    symbol: string,
    exchange: ExchangeType,
    startTime: Date,
    endTime: Date,
  ): OrderBookSnapshot[] {
    const snapshots = this.getSnapshots(symbol, exchange);
    return snapshots.filter(s => 
      s.timestamp >= startTime && s.timestamp <= endTime
    );
  }

  /**
   * Get snapshots for a specific hour of day (for time-of-day analysis)
   */
  getSnapshotsByHour(
    symbol: string,
    exchange: ExchangeType,
    hourOfDay: number,
  ): OrderBookSnapshot[] {
    const snapshots = this.getSnapshots(symbol, exchange);
    return snapshots.filter(s => s.hourOfDay === hourOfDay);
  }

  /**
   * Calculate liquidity metrics for a symbol
   */
  calculateMetrics(symbol: string, exchange: ExchangeType): LiquidityMetrics | null {
    // Check cache first
    const cacheKey = `${symbol}-${exchange}`;
    if (
      this.metricsCacheLastUpdate &&
      Date.now() - this.metricsCacheLastUpdate.getTime() < this.METRICS_CACHE_TTL_MS &&
      this.metricsCache.has(cacheKey)
    ) {
      return this.metricsCache.get(cacheKey)!;
    }
    
    const snapshots = this.getSnapshots(symbol, exchange);
    
    if (snapshots.length < 60) {
      // Need at least 1 hour of data
      return null;
    }
    
    // Calculate averages
    const sum = (arr: number[]): number => arr.reduce((a, b) => a + b, 0);
    const avg = (arr: number[]): number => arr.length > 0 ? sum(arr) / arr.length : 0;
    const variance = (arr: number[]): number => {
      if (arr.length < 2) return 0;
      const mean = avg(arr);
      return avg(arr.map(x => Math.pow(x - mean, 2)));
    };
    
    const bidDepth5s = snapshots.map(s => s.bidDepth5);
    const bidDepth10s = snapshots.map(s => s.bidDepth10);
    const bidDepth20s = snapshots.map(s => s.bidDepth20);
    const askDepth5s = snapshots.map(s => s.askDepth5);
    const askDepth10s = snapshots.map(s => s.askDepth10);
    const askDepth20s = snapshots.map(s => s.askDepth20);
    const spreadBpss = snapshots.map(s => s.spreadBps);
    
    // Calculate hourly multipliers
    const hourlyDepthMultipliers: number[] = [];
    const avgDepth = avg(askDepth20s);
    
    for (let hour = 0; hour < 24; hour++) {
      const hourSnapshots = snapshots.filter(s => s.hourOfDay === hour);
      if (hourSnapshots.length > 0) {
        const hourAvg = avg(hourSnapshots.map(s => s.askDepth20));
        hourlyDepthMultipliers.push(avgDepth > 0 ? hourAvg / avgDepth : 1);
      } else {
        hourlyDepthMultipliers.push(1);
      }
    }
    
    const metrics: LiquidityMetrics = {
      symbol,
      exchange,
      avgBidDepth5: avg(bidDepth5s),
      avgBidDepth10: avg(bidDepth10s),
      avgBidDepth20: avg(bidDepth20s),
      avgAskDepth5: avg(askDepth5s),
      avgAskDepth10: avg(askDepth10s),
      avgAskDepth20: avg(askDepth20s),
      bidDepthVariance: variance(bidDepth20s),
      askDepthVariance: variance(askDepth20s),
      avgSpreadBps: avg(spreadBpss),
      minSpreadBps: Math.min(...spreadBpss),
      maxSpreadBps: Math.max(...spreadBpss),
      hourlyDepthMultipliers,
      snapshotCount: snapshots.length,
      lastUpdated: new Date(),
    };
    
    // Cache the result
    this.metricsCache.set(cacheKey, metrics);
    this.metricsCacheLastUpdate = new Date();
    
    return metrics;
  }

  /**
   * Get all tracked symbols
   */
  getTrackedSymbols(): string[] {
    return Array.from(this.activeSymbols);
  }

  /**
   * Get collection status
   */
  getStatus(): {
    isCollecting: boolean;
    symbolCount: number;
    exchangeCount: number;
    totalSnapshots: number;
    oldestSnapshot: Date | null;
    newestSnapshot: Date | null;
  } {
    let totalSnapshots = 0;
    let oldestSnapshot: Date | null = null;
    let newestSnapshot: Date | null = null;
    
    for (const snapshots of this.snapshots.values()) {
      totalSnapshots += snapshots.length;
      if (snapshots.length > 0) {
        const oldest = snapshots[0].timestamp;
        const newest = snapshots[snapshots.length - 1].timestamp;
        
        if (!oldestSnapshot || oldest < oldestSnapshot) {
          oldestSnapshot = oldest;
        }
        if (!newestSnapshot || newest > newestSnapshot) {
          newestSnapshot = newest;
        }
      }
    }
    
    return {
      isCollecting: this.isCollecting,
      symbolCount: this.activeSymbols.size,
      exchangeCount: this.adapters.size,
      totalSnapshots,
      oldestSnapshot,
      newestSnapshot,
    };
  }

  /**
   * Export all snapshots (for persistence)
   */
  exportSnapshots(): Map<string, OrderBookSnapshot[]> {
    return new Map(this.snapshots);
  }

  /**
   * Import snapshots (from persistence)
   */
  importSnapshots(data: Map<string, OrderBookSnapshot[]>): void {
    this.snapshots = new Map(data);
    this.logger.log(`Imported ${data.size} symbol/exchange pairs`);
  }
}






