import { Injectable, Logger } from '@nestjs/common';
import { ExchangeType } from '../value-objects/ExchangeConfig';

/**
 * Failure types that indicate market quality issues
 */
export type MarketFailureType = 
  | 'NO_LIQUIDITY'      // "couldn't match", IOC rejected
  | 'FILL_TIMEOUT'      // Order sat unfilled too long
  | 'INSUFFICIENT_DEPTH' // Order book too thin
  | 'HIGH_SLIPPAGE'     // Execution price far from expected
  | 'REJECTED'          // Exchange rejected order
  | 'NONCE_ERROR'       // Exchange-specific errors
  | 'OTHER';

/**
 * Market failure event
 */
export interface MarketFailureEvent {
  symbol: string;
  exchange: ExchangeType;
  failureType: MarketFailureType;
  message: string;
  timestamp: Date;
  orderSize?: number;
  context?: Record<string, any>;
}

/**
 * Market quality stats
 */
interface MarketQualityStats {
  symbol: string;
  exchange: ExchangeType;
  failures: {
    total: number;
    byType: Record<MarketFailureType, number>;
    last24h: number;
    last1h: number;
  };
  successes: {
    total: number;
    last24h: number;
    last1h: number;
  };
  lastFailure?: Date;
  lastSuccess?: Date;
  blacklistedAt?: Date;
  blacklistReason?: string;
  // Calculated metrics
  failureRate24h: number;
  avgFillTimeMs?: number;
}

/**
 * Blacklist entry
 */
interface BlacklistEntry {
  symbol: string;
  exchange?: ExchangeType; // undefined = blacklisted on all exchanges
  reason: string;
  blacklistedAt: Date;
  expiresAt?: Date; // undefined = permanent until manual removal
  failureCount: number;
}

/**
 * Filter configuration
 */
const FILTER_CONFIG = {
  // Thresholds for automatic blacklisting
  FAILURE_THRESHOLD_1H: 5,        // 5 failures in 1 hour = temporary blacklist
  FAILURE_THRESHOLD_24H: 15,      // 15 failures in 24 hours = longer blacklist
  FAILURE_RATE_THRESHOLD: 0.7,    // 70% failure rate = blacklist
  
  // Timeouts
  TEMP_BLACKLIST_DURATION_MS: 30 * 60 * 1000,  // 30 minutes
  LONG_BLACKLIST_DURATION_MS: 6 * 60 * 60 * 1000, // 6 hours
  
  // Minimum samples before calculating failure rate
  MIN_SAMPLES_FOR_RATE: 5,
  
  // How long to keep failure history
  HISTORY_RETENTION_MS: 24 * 60 * 60 * 1000, // 24 hours
} as const;

/**
 * MarketQualityFilter - Tracks market execution quality and blacklists problematic markets
 * 
 * Key features:
 * - Tracks failures by type (no liquidity, timeouts, etc.)
 * - Automatically blacklists markets that consistently fail
 * - Time-based expiration of blacklists
 * - Integration with opportunity filtering
 */
@Injectable()
export class MarketQualityFilter {
  private readonly logger = new Logger(MarketQualityFilter.name);

  // Failure history: key = `${symbol}-${exchange}`
  private readonly failureHistory: Map<string, MarketFailureEvent[]> = new Map();
  
  // Success history: key = `${symbol}-${exchange}`
  private readonly successHistory: Map<string, Date[]> = new Map();

  // Active blacklist
  private readonly blacklist: Map<string, BlacklistEntry> = new Map();

  // Permanent blacklist (manually configured or persistent failures)
  private readonly permanentBlacklist: Set<string> = new Set();

  constructor() {
    // Start cleanup interval
    setInterval(() => this.cleanupOldHistory(), 60 * 60 * 1000); // Every hour
  }

  /**
   * Record a market failure
   */
  recordFailure(event: MarketFailureEvent): void {
    const key = this.getKey(event.symbol, event.exchange);
    
    // Add to history
    if (!this.failureHistory.has(key)) {
      this.failureHistory.set(key, []);
    }
    this.failureHistory.get(key)!.push(event);

    // Log the failure
    this.logger.warn(
      `Market failure: ${event.symbol} on ${event.exchange} - ${event.failureType}: ${event.message}`
    );

    // Check if should blacklist
    this.evaluateForBlacklist(event.symbol, event.exchange);
  }

  /**
   * Record a successful execution
   */
  recordSuccess(symbol: string, exchange: ExchangeType): void {
    const key = this.getKey(symbol, exchange);
    
    if (!this.successHistory.has(key)) {
      this.successHistory.set(key, []);
    }
    this.successHistory.get(key)!.push(new Date());
  }

  /**
   * Check if a market is blacklisted
   */
  isBlacklisted(symbol: string, exchange?: ExchangeType): boolean {
    // Check permanent blacklist (symbol-level)
    if (this.permanentBlacklist.has(symbol)) {
      return true;
    }

    // Check exchange-specific blacklist
    if (exchange) {
      const key = this.getKey(symbol, exchange);
      const entry = this.blacklist.get(key);
      if (entry) {
        // Check if expired
        if (entry.expiresAt && entry.expiresAt < new Date()) {
          this.blacklist.delete(key);
          this.logger.log(`Blacklist expired for ${symbol} on ${exchange}`);
          return false;
        }
        return true;
      }
    }

    // Check symbol-level blacklist (all exchanges)
    const symbolEntry = this.blacklist.get(symbol);
    if (symbolEntry) {
      if (symbolEntry.expiresAt && symbolEntry.expiresAt < new Date()) {
        this.blacklist.delete(symbol);
        this.logger.log(`Blacklist expired for ${symbol} (all exchanges)`);
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Get blacklist reason for a market
   */
  getBlacklistReason(symbol: string, exchange?: ExchangeType): string | null {
    if (this.permanentBlacklist.has(symbol)) {
      return 'Permanently blacklisted';
    }

    if (exchange) {
      const key = this.getKey(symbol, exchange);
      const entry = this.blacklist.get(key);
      if (entry) return entry.reason;
    }

    const symbolEntry = this.blacklist.get(symbol);
    if (symbolEntry) return symbolEntry.reason;

    return null;
  }

  /**
   * Manually blacklist a market
   */
  addToBlacklist(
    symbol: string,
    reason: string,
    exchange?: ExchangeType,
    durationMs?: number,
  ): void {
    const key = exchange ? this.getKey(symbol, exchange) : symbol;
    
    this.blacklist.set(key, {
      symbol,
      exchange,
      reason,
      blacklistedAt: new Date(),
      expiresAt: durationMs ? new Date(Date.now() + durationMs) : undefined,
      failureCount: 0,
    });

    this.logger.warn(
      `Manually blacklisted ${symbol}${exchange ? ` on ${exchange}` : ''}: ${reason}` +
      (durationMs ? ` (expires in ${Math.round(durationMs / 60000)}min)` : ' (permanent)')
    );
  }

  /**
   * Remove from blacklist
   */
  removeFromBlacklist(symbol: string, exchange?: ExchangeType): boolean {
    const key = exchange ? this.getKey(symbol, exchange) : symbol;
    
    if (this.permanentBlacklist.has(symbol)) {
      this.permanentBlacklist.delete(symbol);
      this.logger.log(`Removed ${symbol} from permanent blacklist`);
      return true;
    }

    if (this.blacklist.has(key)) {
      this.blacklist.delete(key);
      this.logger.log(`Removed ${symbol}${exchange ? ` on ${exchange}` : ''} from blacklist`);
      return true;
    }

    return false;
  }

  /**
   * Add to permanent blacklist
   */
  addToPermanentBlacklist(symbol: string, reason: string): void {
    this.permanentBlacklist.add(symbol);
    this.logger.warn(`Permanently blacklisted ${symbol}: ${reason}`);
  }

  /**
   * Get market quality stats
   */
  getMarketStats(symbol: string, exchange: ExchangeType): MarketQualityStats {
    const key = this.getKey(symbol, exchange);
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const failures = this.failureHistory.get(key) || [];
    const successes = this.successHistory.get(key) || [];

    // Count failures by type
    const byType: Record<MarketFailureType, number> = {
      NO_LIQUIDITY: 0,
      FILL_TIMEOUT: 0,
      INSUFFICIENT_DEPTH: 0,
      HIGH_SLIPPAGE: 0,
      REJECTED: 0,
      NONCE_ERROR: 0,
      OTHER: 0,
    };

    let failures1h = 0;
    let failures24h = 0;
    let lastFailure: Date | undefined;

    for (const f of failures) {
      byType[f.failureType]++;
      const ts = f.timestamp.getTime();
      if (ts > oneHourAgo) failures1h++;
      if (ts > oneDayAgo) failures24h++;
      if (!lastFailure || f.timestamp > lastFailure) {
        lastFailure = f.timestamp;
      }
    }

    let successes1h = 0;
    let successes24h = 0;
    let lastSuccess: Date | undefined;

    for (const s of successes) {
      const ts = s.getTime();
      if (ts > oneHourAgo) successes1h++;
      if (ts > oneDayAgo) successes24h++;
      if (!lastSuccess || s > lastSuccess) {
        lastSuccess = s;
      }
    }

    // Calculate failure rate
    const total24h = failures24h + successes24h;
    const failureRate24h = total24h >= FILTER_CONFIG.MIN_SAMPLES_FOR_RATE
      ? failures24h / total24h
      : 0;

    // Get blacklist info
    const blacklistEntry = this.blacklist.get(key) || this.blacklist.get(symbol);

    return {
      symbol,
      exchange,
      failures: {
        total: failures.length,
        byType,
        last24h: failures24h,
        last1h: failures1h,
      },
      successes: {
        total: successes.length,
        last24h: successes24h,
        last1h: successes1h,
      },
      lastFailure,
      lastSuccess,
      blacklistedAt: blacklistEntry?.blacklistedAt,
      blacklistReason: blacklistEntry?.reason,
      failureRate24h,
    };
  }

  /**
   * Get all blacklisted markets
   */
  getBlacklistedMarkets(): BlacklistEntry[] {
    const result: BlacklistEntry[] = [];
    
    // Add permanent blacklist
    for (const symbol of this.permanentBlacklist) {
      result.push({
        symbol,
        reason: 'Permanently blacklisted',
        blacklistedAt: new Date(0), // Unknown
        failureCount: 0,
      });
    }

    // Add temporary blacklist
    for (const entry of this.blacklist.values()) {
      // Skip expired entries
      if (entry.expiresAt && entry.expiresAt < new Date()) {
        continue;
      }
      result.push(entry);
    }

    return result;
  }

  /**
   * Get diagnostics summary
   */
  getDiagnostics(): {
    blacklistedCount: number;
    blacklistedMarkets: Array<{
      symbol: string;
      exchange?: string;
      reason: string;
      expiresIn?: string;
    }>;
    recentFailures: Array<{
      symbol: string;
      exchange: string;
      type: string;
      message: string;
      timeAgo: string;
    }>;
    marketStats: Array<{
      symbol: string;
      exchange: string;
      failures1h: number;
      failures24h: number;
      failureRate: string;
      status: 'healthy' | 'degraded' | 'blacklisted';
    }>;
  } {
    const now = Date.now();
    const blacklisted = this.getBlacklistedMarkets();

    // Get recent failures (last 10)
    const allFailures: MarketFailureEvent[] = [];
    for (const failures of this.failureHistory.values()) {
      allFailures.push(...failures);
    }
    allFailures.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const recentFailures = allFailures.slice(0, 10).map(f => ({
      symbol: f.symbol,
      exchange: f.exchange,
      type: f.failureType,
      message: f.message.substring(0, 100),
      timeAgo: this.formatTimeAgo(f.timestamp),
    }));

    // Get market stats for markets with activity
    const marketStats: Array<{
      symbol: string;
      exchange: string;
      failures1h: number;
      failures24h: number;
      failureRate: string;
      status: 'healthy' | 'degraded' | 'blacklisted';
    }> = [];

    const seenMarkets = new Set<string>();
    for (const [key] of this.failureHistory) {
      seenMarkets.add(key);
    }
    for (const [key] of this.successHistory) {
      seenMarkets.add(key);
    }

    for (const key of seenMarkets) {
      const [symbol, exchange] = key.split('-');
      const stats = this.getMarketStats(symbol, exchange as ExchangeType);
      
      let status: 'healthy' | 'degraded' | 'blacklisted' = 'healthy';
      if (this.isBlacklisted(symbol, exchange as ExchangeType)) {
        status = 'blacklisted';
      } else if (stats.failureRate24h > 0.3) {
        status = 'degraded';
      }

      marketStats.push({
        symbol,
        exchange,
        failures1h: stats.failures.last1h,
        failures24h: stats.failures.last24h,
        failureRate: `${(stats.failureRate24h * 100).toFixed(0)}%`,
        status,
      });
    }

    // Sort by failure count
    marketStats.sort((a, b) => b.failures24h - a.failures24h);

    return {
      blacklistedCount: blacklisted.length,
      blacklistedMarkets: blacklisted.map(b => ({
        symbol: b.symbol,
        exchange: b.exchange,
        reason: b.reason,
        expiresIn: b.expiresAt
          ? this.formatDuration(b.expiresAt.getTime() - now)
          : undefined,
      })),
      recentFailures,
      marketStats: marketStats.slice(0, 20), // Top 20
    };
  }

  /**
   * Filter opportunities by market quality
   */
  filterOpportunities<T extends { symbol: string; longExchange: ExchangeType; shortExchange?: ExchangeType }>(
    opportunities: T[],
  ): { passed: T[]; filtered: T[]; reasons: Map<string, string> } {
    const passed: T[] = [];
    const filtered: T[] = [];
    const reasons = new Map<string, string>();

    for (const opp of opportunities) {
      // Check if blacklisted on long exchange
      if (this.isBlacklisted(opp.symbol, opp.longExchange)) {
        filtered.push(opp);
        reasons.set(
          `${opp.symbol}-${opp.longExchange}`,
          this.getBlacklistReason(opp.symbol, opp.longExchange) || 'Blacklisted',
        );
        continue;
      }

      // Check if blacklisted on short exchange
      if (opp.shortExchange && this.isBlacklisted(opp.symbol, opp.shortExchange)) {
        filtered.push(opp);
        reasons.set(
          `${opp.symbol}-${opp.shortExchange}`,
          this.getBlacklistReason(opp.symbol, opp.shortExchange) || 'Blacklisted',
        );
        continue;
      }

      // Check if blacklisted globally (all exchanges)
      if (this.isBlacklisted(opp.symbol)) {
        filtered.push(opp);
        reasons.set(
          opp.symbol,
          this.getBlacklistReason(opp.symbol) || 'Blacklisted',
        );
        continue;
      }

      passed.push(opp);
    }

    if (filtered.length > 0) {
      this.logger.debug(
        `Market quality filter: ${passed.length} passed, ${filtered.length} filtered`,
      );
    }

    return { passed, filtered, reasons };
  }

  /**
   * Parse failure type from error message
   */
  static parseFailureType(errorMessage: string): MarketFailureType {
    const msg = errorMessage.toLowerCase();
    
    if (msg.includes('could not immediately match') || 
        msg.includes('no liquidity') ||
        msg.includes('no resting orders')) {
      return 'NO_LIQUIDITY';
    }
    
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('fill timeout')) {
      return 'FILL_TIMEOUT';
    }
    
    if (msg.includes('slippage') || msg.includes('price moved')) {
      return 'HIGH_SLIPPAGE';
    }
    
    if (msg.includes('insufficient') || msg.includes('depth')) {
      return 'INSUFFICIENT_DEPTH';
    }
    
    if (msg.includes('nonce')) {
      return 'NONCE_ERROR';
    }
    
    if (msg.includes('rejected') || msg.includes('invalid')) {
      return 'REJECTED';
    }
    
    return 'OTHER';
  }

  // ==================== Private Methods ====================

  private getKey(symbol: string, exchange: ExchangeType): string {
    return `${symbol}-${exchange}`;
  }

  private evaluateForBlacklist(symbol: string, exchange: ExchangeType): void {
    const key = this.getKey(symbol, exchange);
    const stats = this.getMarketStats(symbol, exchange);

    // Check 1-hour threshold
    if (stats.failures.last1h >= FILTER_CONFIG.FAILURE_THRESHOLD_1H) {
      const reason = `${stats.failures.last1h} failures in last hour (threshold: ${FILTER_CONFIG.FAILURE_THRESHOLD_1H})`;
      this.addToBlacklist(symbol, reason, exchange, FILTER_CONFIG.TEMP_BLACKLIST_DURATION_MS);
      return;
    }

    // Check 24-hour threshold
    if (stats.failures.last24h >= FILTER_CONFIG.FAILURE_THRESHOLD_24H) {
      const reason = `${stats.failures.last24h} failures in last 24h (threshold: ${FILTER_CONFIG.FAILURE_THRESHOLD_24H})`;
      this.addToBlacklist(symbol, reason, exchange, FILTER_CONFIG.LONG_BLACKLIST_DURATION_MS);
      return;
    }

    // Check failure rate
    const total = stats.failures.last24h + stats.successes.last24h;
    if (total >= FILTER_CONFIG.MIN_SAMPLES_FOR_RATE && 
        stats.failureRate24h >= FILTER_CONFIG.FAILURE_RATE_THRESHOLD) {
      const reason = `${(stats.failureRate24h * 100).toFixed(0)}% failure rate (threshold: ${FILTER_CONFIG.FAILURE_RATE_THRESHOLD * 100}%)`;
      this.addToBlacklist(symbol, reason, exchange, FILTER_CONFIG.LONG_BLACKLIST_DURATION_MS);
    }
  }

  private cleanupOldHistory(): void {
    const cutoff = Date.now() - FILTER_CONFIG.HISTORY_RETENTION_MS;

    for (const [key, failures] of this.failureHistory) {
      const filtered = failures.filter(f => f.timestamp.getTime() > cutoff);
      if (filtered.length === 0) {
        this.failureHistory.delete(key);
      } else {
        this.failureHistory.set(key, filtered);
      }
    }

    for (const [key, successes] of this.successHistory) {
      const filtered = successes.filter(s => s.getTime() > cutoff);
      if (filtered.length === 0) {
        this.successHistory.delete(key);
      } else {
        this.successHistory.set(key, filtered);
      }
    }

    // Cleanup expired blacklist entries
    for (const [key, entry] of this.blacklist) {
      if (entry.expiresAt && entry.expiresAt < new Date()) {
        this.blacklist.delete(key);
        this.logger.log(`Blacklist expired: ${key}`);
      }
    }
  }

  private formatTimeAgo(date: Date): string {
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 60) return `${minutes}min ago`;
    if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
    return `${Math.round(minutes / 1440)}d ago`;
  }

  private formatDuration(ms: number): string {
    if (ms < 0) return 'expired';
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes}min`;
    return `${Math.round(minutes / 60)}h`;
  }
}

