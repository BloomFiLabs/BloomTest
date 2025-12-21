import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { HyperLiquidDataProvider } from '../adapters/hyperliquid/HyperLiquidDataProvider';
import { AsterFundingDataProvider } from '../adapters/aster/AsterFundingDataProvider';
import { LighterFundingDataProvider } from '../adapters/lighter/LighterFundingDataProvider';
import { FundingRateAggregator } from '../../domain/services/FundingRateAggregator';
import {
  IHistoricalFundingRateService,
  HistoricalFundingRate,
  HistoricalMetrics,
  SpreadVolatilityMetrics,
} from '../../domain/ports/IHistoricalFundingRateService';
import { IFundingDataProvider } from '../../domain/ports/IFundingDataProvider';
import axios from 'axios';

// Re-export types for backward compatibility
export type {
  HistoricalFundingRate,
  HistoricalMetrics,
} from '../../domain/ports/IHistoricalFundingRateService';

/**
 * HistoricalFundingRateService - Tracks and analyzes historical funding rates
 *
 * Uses native APIs when available (Hyperliquid, Aster) and collected data as backup.
 * - Hyperliquid: Uses `fundingHistory` endpoint (up to 500 entries per request)
 * - Aster: Uses `/fapi/v1/fundingRate` endpoint (8-hour intervals, up to 1000 entries)
 * - Lighter: Uses collected data (no native historical API available)
 */
@Injectable()
export class HistoricalFundingRateService
  implements IHistoricalFundingRateService, OnModuleInit
{
  private readonly logger = new Logger(HistoricalFundingRateService.name);

  // In-memory cache: key = `${symbol}_${exchange}`, value = array of HistoricalFundingRate
  private historicalData: Map<string, HistoricalFundingRate[]> = new Map();

  // Retention period: 30 days of hourly data (matches fetch period)
  private readonly RETENTION_DAYS = 30;
  private readonly RETENTION_MS = this.RETENTION_DAYS * 24 * 60 * 60 * 1000;

  // Refresh interval: every hour (aligned with funding rate payments)
  private refreshInterval: NodeJS.Timeout | null = null;

  // List of funding data providers for parallel fetching
  private readonly fundingProviders: IFundingDataProvider[];

  // Disk persistence
  private readonly dataFilePath: string;
  private saveInProgress = false;
  private pendingSave = false;
  private readonly SAVE_DEBOUNCE_MS = 5000; // Save to disk every 5 seconds after changes

  constructor(
    private readonly configService: ConfigService,
    private readonly hyperliquidProvider: HyperLiquidDataProvider,
    @Optional() private readonly asterProvider: AsterFundingDataProvider,
    private readonly lighterProvider: LighterFundingDataProvider,
    private readonly aggregator: FundingRateAggregator,
  ) {
    // Initialize providers array for parallel operations
    this.fundingProviders = [
      this.hyperliquidProvider,
      // this.asterProvider, // DISABLED
      this.lighterProvider,
    ];

    // Setup disk persistence path
    const dataDir = this.configService.get<string>(
      'HISTORICAL_DATA_DIR',
      'data',
    );
    this.dataFilePath = path.join(
      process.cwd(),
      dataDir,
      'historical-funding-rates.json',
    );
  }

  async onModuleInit() {
    // Load cached data from disk first
    await this.loadFromDisk();

    // Backfill only missing historical data from native APIs on startup
    // This runs in background - don't await to avoid blocking startup
    this.backfillHistoricalData().catch((err) => {
      this.logger.error(
        `Failed to backfill historical data on startup: ${err.message}`,
      );
    });

    // Start periodic data collection (every hour)
    this.startPeriodicCollection();
    this.logger.log('Historical funding rate service initialized');
  }

  /**
   * Start periodic collection of funding rates
   */
  private startPeriodicCollection() {
    // Collect after a delay to avoid blocking strategy startup
    setTimeout(() => {
      this.collectCurrentRates().catch((err) => {
        this.logger.error(
          `Failed to collect initial funding rates: ${err.message}`,
        );
      });
    }, 120000); // 2 minute delay

    // Then collect every hour
    this.refreshInterval = setInterval(
      () => {
        this.collectCurrentRates().catch((err) => {
          this.logger.error(`Failed to collect funding rates: ${err.message}`);
        });
      },
      60 * 60 * 1000,
    ); // 1 hour
  }

  /**
   * Collect current funding rates from all exchanges and store them
   */
  private async collectCurrentRates(): Promise<void> {
    try {
      // Get all discovered symbols from aggregator
      // Note: This will use cached symbols if available, or discover if needed
      const symbols = await this.aggregator.discoverCommonAssets();
      const timestamp = new Date();

      if (symbols.length === 0) {
        this.logger.debug(
          'No symbols available for historical data collection',
        );
        return;
      }

      // Collect rates for each symbol - fetch all exchanges in parallel per symbol
      for (const symbol of symbols) {
        try {
          const mapping = this.aggregator.getSymbolMapping(symbol);
          if (!mapping) continue;

          // Fetch from all providers in parallel
          const fetchPromises = this.fundingProviders.map(async (provider) => {
            const exchangeType = provider.getExchangeType();
            const exchangeSymbol = this.getExchangeSymbolFromMapping(
              mapping,
              exchangeType,
            );

            if (exchangeSymbol === undefined) return;

            try {
              const request = {
                normalizedSymbol: symbol,
                exchangeSymbol: String(exchangeSymbol),
                marketIndex:
                  typeof exchangeSymbol === 'number'
                    ? exchangeSymbol
                    : undefined,
              };
              const data = await provider.getFundingData(request);
              if (data) {
                this.addHistoricalDataPoint(
                  symbol,
                  exchangeType,
                  data.currentRate,
                  timestamp,
                );
              }
            } catch (err: any) {
              this.logger.debug(
                `Failed to get ${exchangeType} rate for ${symbol}: ${err.message}`,
              );
            }
          });

          await Promise.all(fetchPromises);

          // Small delay to avoid rate limits
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (err: any) {
          this.logger.debug(
            `Failed to collect rates for ${symbol}: ${err.message}`,
          );
        }
      }

      // Clean up old data
      this.cleanupOldData();

      // Save to disk after collection (will be debounced by scheduleSaveToDisk)
      this.scheduleSaveToDisk();

      this.logger.debug(
        `Collected historical funding rates for ${symbols.length} symbols`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to collect current funding rates: ${error.message}`,
      );
    }
  }

  /**
   * Add a historical data point
   */
  private addHistoricalDataPoint(
    symbol: string,
    exchange: ExchangeType,
    rate: number,
    timestamp: Date,
  ): void {
    const key = `${symbol}_${exchange}`;
    const dataPoints = this.historicalData.get(key) || [];

    // Check if this data point already exists (avoid duplicates)
    const exists = dataPoints.some(
      (dp) =>
        dp.symbol === symbol &&
        dp.exchange === exchange &&
        Math.abs(dp.timestamp.getTime() - timestamp.getTime()) < 60000, // Within 1 minute
    );

    if (exists) {
      return; // Skip duplicate
    }

    dataPoints.push({
      symbol,
      exchange,
      rate,
      timestamp,
    });

    // Sort by timestamp (oldest first)
    dataPoints.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    this.historicalData.set(key, dataPoints);

    // Schedule save to disk (debounced)
    this.scheduleSaveToDisk();
  }

  /**
   * Get exchange symbol from mapping based on exchange type
   */
  private getExchangeSymbolFromMapping(
    mapping: ReturnType<typeof this.aggregator.getSymbolMapping>,
    exchangeType: ExchangeType,
  ): string | number | undefined {
    if (!mapping) return undefined;

    switch (exchangeType) {
      case ExchangeType.HYPERLIQUID:
        return mapping.hyperliquidSymbol;
      case ExchangeType.ASTER:
        return mapping.asterSymbol;
      case ExchangeType.LIGHTER:
        return mapping.lighterMarketIndex;
      default:
        return undefined;
    }
  }

  /**
   * Clean up data older than retention period
   */
  private cleanupOldData(): void {
    const cutoffTime = Date.now() - this.RETENTION_MS;
    let cleanedCount = 0;

    for (const [key, dataPoints] of this.historicalData.entries()) {
      const filtered = dataPoints.filter(
        (dp) => dp.timestamp.getTime() > cutoffTime,
      );

      if (filtered.length !== dataPoints.length) {
        cleanedCount += dataPoints.length - filtered.length;
        if (filtered.length === 0) {
          this.historicalData.delete(key);
        } else {
          this.historicalData.set(key, filtered);
        }
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(
        `Cleaned up ${cleanedCount} old historical data points`,
      );
      this.scheduleSaveToDisk();
    }
  }

  /**
   * Load historical data from disk
   */
  private async loadFromDisk(): Promise<void> {
    try {
      if (!fs.existsSync(this.dataFilePath)) {
        this.logger.debug('No cached historical data found on disk');
        return;
      }

      const data = fs.readFileSync(this.dataFilePath, 'utf-8');
      const parsed = JSON.parse(data);

      // Validate structure
      if (!parsed || typeof parsed !== 'object') {
        this.logger.warn('Invalid cached historical data format, starting fresh');
        return;
      }

      let loadedCount = 0;
      for (const [key, dataPoints] of Object.entries(parsed)) {
        if (Array.isArray(dataPoints)) {
          // Convert timestamp strings back to Date objects
          const converted = (dataPoints as any[]).map((dp) => ({
            ...dp,
            timestamp: new Date(dp.timestamp),
          }));

          // Filter out data older than retention period
          const cutoffTime = Date.now() - this.RETENTION_MS;
          const filtered = converted.filter(
            (dp) => dp.timestamp.getTime() > cutoffTime,
          );

          if (filtered.length > 0) {
            this.historicalData.set(key, filtered);
            loadedCount += filtered.length;
          }
        }
      }

      this.logger.log(
        `📂 Loaded ${loadedCount} historical data points from disk cache`,
      );
    } catch (error: any) {
      this.logger.warn(
        `Failed to load historical data from disk: ${error.message}. Starting fresh.`,
      );
    }
  }

  /**
   * Save historical data to disk (debounced)
   */
  private saveToDiskTimeout: NodeJS.Timeout | null = null;

  private scheduleSaveToDisk(): void {
    // Clear existing timeout
    if (this.saveToDiskTimeout) {
      clearTimeout(this.saveToDiskTimeout);
    }

    // Schedule save after debounce period
    this.saveToDiskTimeout = setTimeout(() => {
      this.persistToDisk();
    }, this.SAVE_DEBOUNCE_MS);
  }

  /**
   * Persist historical data to disk
   */
  private async persistToDisk(): Promise<void> {
    if (this.saveInProgress) {
      this.pendingSave = true;
      return;
    }

    this.saveInProgress = true;

    try {
      // Ensure directory exists
      const dir = path.dirname(this.dataFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Convert Map to serializable object
      const serialized: Record<string, any[]> = {};
      for (const [key, dataPoints] of this.historicalData.entries()) {
        serialized[key] = dataPoints.map((dp) => ({
          ...dp,
          timestamp: dp.timestamp.toISOString(),
        }));
      }

      // Write to temp file first, then rename (atomic operation)
      const tempPath = `${this.dataFilePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(serialized, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.dataFilePath);

      this.logger.debug(
        `💾 Saved ${this.historicalData.size} historical data series to disk`,
      );
    } catch (error: any) {
      this.logger.error(`Failed to persist historical data: ${error.message}`);
    } finally {
      this.saveInProgress = false;

      // Handle any pending saves
      if (this.pendingSave) {
        this.pendingSave = false;
        await this.persistToDisk();
      }
    }
  }

  /**
   * Get the oldest timestamp for a symbol/exchange pair
   * Used to determine what data needs to be fetched
   */
  private getOldestTimestamp(
    symbol: string,
    exchange: ExchangeType,
  ): Date | null {
    const key = `${symbol}_${exchange}`;
    const dataPoints = this.historicalData.get(key) || [];

    if (dataPoints.length === 0) {
      return null;
    }

    // Data is sorted oldest first
    return dataPoints[0].timestamp;
  }

  /**
   * Get historical metrics for a symbol/exchange pair
   * @param symbol Normalized symbol (e.g., 'ETH')
   * @param exchange Exchange type
   * @param days Number of days to analyze (default: 7)
   * @returns Historical metrics or null if insufficient data
   */
  getHistoricalMetrics(
    symbol: string,
    exchange: ExchangeType,
    days: number = 7,
  ): HistoricalMetrics | null {
    const key = `${symbol}_${exchange}`;
    const dataPoints = this.historicalData.get(key) || [];

    if (dataPoints.length === 0) {
      return null;
    }

    // Filter by time window
    const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000;
    const filtered = dataPoints.filter(
      (dp) => dp.timestamp.getTime() > cutoffTime,
    );

    if (filtered.length === 0) {
      return null;
    }

    // Calculate metrics
    const rates = filtered.map((dp) => dp.rate);
    const averageRate = rates.reduce((sum, r) => sum + r, 0) / rates.length;

    // Standard deviation
    const variance =
      rates.reduce((sum, r) => sum + Math.pow(r - averageRate, 2), 0) /
      rates.length;
    const stdDev = Math.sqrt(variance);

    const minRate = Math.min(...rates);
    const maxRate = Math.max(...rates);

    // Count positive days (group by day)
    const positiveDaysSet = new Set<string>();
    filtered.forEach((dp) => {
      if (dp.rate > 0) {
        const dayKey = dp.timestamp.toISOString().split('T')[0];
        positiveDaysSet.add(dayKey);
      }
    });
    const positiveDays = positiveDaysSet.size;

    // Consistency score: combines low stdDev (more consistent) and high average rate
    // Normalize stdDev: lower is better, so invert it
    // Score = (1 / (1 + stdDev)) * (1 + averageRate) / 2
    // Clamp to 0-1 range
    const normalizedStdDev = 1 / (1 + Math.abs(stdDev) * 1000); // Scale stdDev
    const normalizedAvgRate = Math.max(
      0,
      Math.min(1, (averageRate + 0.001) / 0.002),
    ); // Normalize to 0-1 assuming rates are typically -0.001 to 0.001
    const consistencyScore = normalizedStdDev * 0.6 + normalizedAvgRate * 0.4; // Weight consistency more

    return {
      averageRate,
      stdDev,
      minRate,
      maxRate,
      positiveDays,
      consistencyScore: Math.max(0, Math.min(1, consistencyScore)),
      dataPoints: filtered.length,
    };
  }

  /**
   * Get consistency score for a symbol/exchange pair
   * Higher score = more consistent and higher average rate
   * @param symbol Normalized symbol
   * @param exchange Exchange type
   * @returns Consistency score (0-1) or 0 if no data
   */
  getConsistencyScore(symbol: string, exchange: ExchangeType): number {
    const metrics = this.getHistoricalMetrics(symbol, exchange);
    return metrics?.consistencyScore ?? 0;
  }

  /**
   * Fetch historical funding rates from Hyperliquid native API
   * Implements pagination to handle API limit of 500 entries per request
   * @param symbol Hyperliquid symbol (e.g., 'ETH')
   * @param days Number of days to fetch
   * @returns Array of historical funding rates
   */
  private async fetchHyperliquidHistory(
    symbol: string,
    days: number,
  ): Promise<HistoricalFundingRate[]> {
    const API_URL = 'https://api.hyperliquid.xyz/info';
    const MAX_ENTRIES_PER_REQUEST = 500; // API limit
    const HOURS_PER_REQUEST = 21; // ~500 hours = ~21 days

    const allEntries: HistoricalFundingRate[] = [];
    const endTime = Date.now();

    // Split into multiple requests if needed
    let remainingDays = days;
    let currentEndTime = endTime;
    let requestCount = 0;
    const maxRequests = Math.ceil(days / (HOURS_PER_REQUEST / 24)) + 1; // Safety limit

    while (remainingDays > 0 && requestCount < maxRequests) {
      const requestDays = Math.min(remainingDays, HOURS_PER_REQUEST / 24);
      const startTime = currentEndTime - requestDays * 24 * 60 * 60 * 1000;

      try {
        const response = await axios.post(
          API_URL,
          {
            type: 'fundingHistory',
            coin: symbol,
            startTime: startTime,
            endTime: currentEndTime,
          },
          {
            timeout: 30000,
          },
        );

        if (Array.isArray(response.data) && response.data.length > 0) {
          const entries = response.data.map((entry: any) => ({
            symbol: symbol, // Will be normalized by caller
            exchange: ExchangeType.HYPERLIQUID,
            rate: parseFloat(entry.fundingRate),
            timestamp: new Date(entry.time),
          }));
          allEntries.push(...entries);

          // If we got less than 500, we've reached the end of available data
          if (response.data.length < MAX_ENTRIES_PER_REQUEST) {
            break;
          }
        } else {
          this.logger.warn(
            `⚠️ Hyperliquid: No data returned for ${symbol} in request ${requestCount + 1}`,
          );
          break;
        }

        // Move to next time window
        currentEndTime = startTime;
        remainingDays -= requestDays;
        requestCount++;

        // Rate limit protection - small delay between requests
        if (remainingDays > 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error: any) {
        // Retry logic with exponential backoff for rate limits
        if (error.response?.status === 429) {
          const retryDelay = Math.min(10000 * Math.pow(2, requestCount), 60000); // Max 60s
          this.logger.warn(
            `⚠️ Hyperliquid rate limit (429) for ${symbol}, retrying in ${retryDelay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue; // Retry this request
        }
        this.logger.error(
          `❌ Failed to fetch Hyperliquid historical data for ${symbol} (request ${requestCount + 1}): ${error.message}${error.response ? ` (HTTP ${error.response.status})` : ''}`,
        );
        break; // Stop on other errors
      }
    }

    // Deduplicate and sort by timestamp
    const deduplicated = this.deduplicateEntries(allEntries);

    return deduplicated;
  }

  /**
   * Remove duplicate entries based on timestamp (keep most recent if duplicates found)
   */
  private deduplicateEntries(
    entries: HistoricalFundingRate[],
  ): HistoricalFundingRate[] {
    const seen = new Map<number, HistoricalFundingRate>();

    for (const entry of entries) {
      const timestamp = entry.timestamp.getTime();
      const existing = seen.get(timestamp);

      // Keep entry with most recent timestamp if exact duplicate, or keep first seen
      if (!existing || entry.timestamp > existing.timestamp) {
        seen.set(timestamp, entry);
      }
    }

    return Array.from(seen.values()).sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
  }

  /**
   * Fetch historical funding rates from Lighter explorer API
   * Extracts funding rates from transaction logs using funding_rate_prefix_sum
   * @param symbol Normalized symbol (e.g., 'ETH')
   * @param marketIndex Lighter market index
   * @param days Number of days to fetch
   * @returns Array of historical funding rates
   */
  private async fetchLighterHistory(
    symbol: string,
    marketIndex: number,
    days: number,
  ): Promise<HistoricalFundingRate[]> {
    try {
      const baseUrl = `https://explorer.elliot.ai/api/markets/${symbol}/logs`;
      const allTransactions: any[] = [];
      let page = 1;
      const limit = 100;
      const endTime = Date.now();
      const startTime = endTime - days * 24 * 60 * 60 * 1000;

      // Fetch all transactions with pagination
      while (page <= 50) {
        const url = `${baseUrl}?page=${page}&limit=${limit}&start_time=${startTime}&end_time=${endTime}`;

        try {
          const response = await axios.get(url, {
            headers: { accept: 'application/json' },
            timeout: 60000,
          });

          if (!Array.isArray(response.data) || response.data.length === 0) {
            break;
          }

          allTransactions.push(...response.data);
          if (response.data.length < limit) break;

          page++;
          await new Promise((resolve) => setTimeout(resolve, 200)); // Rate limit protection
        } catch (error: any) {
          // If date params don't work on first page, try without them
          if (page === 1) {
            try {
              const response2 = await axios.get(
                `${baseUrl}?page=${page}&limit=${limit}`,
                {
                  headers: { accept: 'application/json' },
                  timeout: 60000,
                },
              );
              if (Array.isArray(response2.data)) {
                allTransactions.push(...response2.data);
              }
            } catch (err2: any) {
              this.logger.debug(
                `Failed to fetch Lighter transactions for ${symbol}: ${err2.message}`,
              );
            }
          }
          break;
        }
      }

      if (allTransactions.length === 0) {
        return [];
      }

      // Filter for TradeWithFunding transactions
      const fundingTransactions = allTransactions.filter(
        (tx: any) =>
          tx.pubdata_type === 'TradeWithFunding' &&
          tx.pubdata?.trade_pubdata_with_funding?.funding_rate_prefix_sum !==
            undefined &&
          tx.pubdata?.trade_pubdata_with_funding?.funding_rate_prefix_sum !==
            null &&
          tx.pubdata?.trade_pubdata_with_funding?.funding_rate_prefix_sum !== 0,
      );

      if (fundingTransactions.length === 0) {
        return [];
      }

      // Sort by timestamp
      fundingTransactions.sort(
        (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
      );

      // Group by prefix sum to identify funding periods
      const prefixSumGroups = new Map<number, any[]>();
      fundingTransactions.forEach((tx) => {
        const ps =
          typeof tx.pubdata.trade_pubdata_with_funding
            .funding_rate_prefix_sum === 'string'
            ? parseFloat(
                tx.pubdata.trade_pubdata_with_funding.funding_rate_prefix_sum,
              )
            : tx.pubdata.trade_pubdata_with_funding.funding_rate_prefix_sum;

        if (!prefixSumGroups.has(ps)) {
          prefixSumGroups.set(ps, []);
        }
        prefixSumGroups.get(ps)!.push(tx);
      });

      const sortedGroups = Array.from(prefixSumGroups.entries()).sort(
        (a, b) => {
          const aTime = Math.min(
            ...a[1].map((tx: any) => new Date(tx.time).getTime()),
          );
          const bTime = Math.min(
            ...b[1].map((tx: any) => new Date(tx.time).getTime()),
          );
          return aTime - bTime;
        },
      );

      if (sortedGroups.length < 2) {
        // Need at least 2 periods to calculate rates
        return [];
      }

      const SCALE_FACTOR = 1e8; // Lighter uses 1e8 scale for funding rates
      const rates: HistoricalFundingRate[] = [];

      // Calculate funding rates from prefix sum differences
      for (let i = 1; i < sortedGroups.length; i++) {
        const [prevPs, prevTxs] = sortedGroups[i - 1];
        const [currPs, currTxs] = sortedGroups[i];

        const earliestTx = currTxs.reduce((earliest: any, tx: any) =>
          new Date(tx.time) < new Date(earliest.time) ? tx : earliest,
        );
        const latestPrevTx = prevTxs.reduce((latest: any, tx: any) =>
          new Date(tx.time) > new Date(latest.time) ? tx : latest,
        );

        const timeDiffHours =
          (new Date(earliestTx.time).getTime() -
            new Date(latestPrevTx.time).getTime()) /
          (1000 * 60 * 60);
        const prefixSumDiff = currPs - prevPs;
        const cumulativeRate = prefixSumDiff / SCALE_FACTOR;
        const hourlyRate =
          timeDiffHours > 0 ? cumulativeRate / timeDiffHours : cumulativeRate;

        rates.push({
          symbol,
          exchange: ExchangeType.LIGHTER,
          rate: hourlyRate,
          timestamp: new Date(earliestTx.time),
        });
      }

      return rates.sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
      );
    } catch (error: any) {
      this.logger.error(
        `❌ Failed to fetch Lighter historical data for ${symbol}: ${error.message}${error.response ? ` (HTTP ${error.response.status})` : ''}`,
      );
      return [];
    }
  }

  /**
   * Fetch historical funding rates from Aster native API
   * @param symbol Aster symbol (e.g., 'ETHUSDT')
   * @param days Number of days to fetch
   * @returns Array of historical funding rates
   */
  private async fetchAsterHistory(
    symbol: string,
    days: number,
  ): Promise<HistoricalFundingRate[]> {
    try {
      const baseUrl = 'https://fapi.asterdex.com';
      const endTime = Date.now();
      const startTime = endTime - days * 24 * 60 * 60 * 1000;

      const response = await axios.get(`${baseUrl}/fapi/v1/fundingRate`, {
        params: {
          symbol,
          startTime,
          endTime,
          limit: 1000,
        },
        timeout: 30000,
      });

      if (Array.isArray(response.data) && response.data.length > 0) {
        return response.data.map((entry: any) => ({
          symbol: symbol, // Exchange-specific symbol (will be normalized by caller)
          exchange: ExchangeType.ASTER,
          rate: parseFloat(entry.fundingRate),
          timestamp: new Date(entry.fundingTime),
        }));
      }

      this.logger.warn(
        `⚠️ Aster: No data returned for ${symbol} (response: ${JSON.stringify(response.data).substring(0, 100)})`,
      );
      return [];
    } catch (error: any) {
      this.logger.error(
        `❌ Failed to fetch Aster historical data for ${symbol}: ${error.message}${error.response ? ` (HTTP ${error.response.status})` : ''}`,
      );
      return [];
    }
  }

  /**
   * Backfill historical data from native APIs on startup
   * Only fetches missing data (data older than what's already cached)
   */
  async backfillHistoricalData(): Promise<void> {
    try {
      this.logger.log(
        '🔄 Backfilling missing historical funding rate data from native APIs...',
      );

      const symbols = await this.aggregator.discoverCommonAssets();
      if (symbols.length === 0) {
        this.logger.debug('No symbols available for historical data backfill');
        return;
      }

      let totalFetched = 0;
      let totalSkipped = 0;
      let hyperliquidCount = 0;
      let asterCount = 0;
      let lighterCount = 0;
      let hyperliquidSymbols = 0;
      let asterSymbols = 0;
      let lighterSymbols = 0;
      let hyperliquidFailed = 0;
      let asterFailed = 0;
      let lighterFailed = 0;
      let hyperliquidSkipped = 0;
      let asterSkipped = 0;
      let lighterSkipped = 0;

      for (const symbol of symbols) {
        try {
          const mapping = this.aggregator.getSymbolMapping(symbol);

          // Fetch Hyperliquid historical data (only missing data)
          if (mapping?.hyperliquidSymbol) {
            hyperliquidSymbols++;
            const oldestCached = this.getOldestTimestamp(
              symbol,
              ExchangeType.HYPERLIQUID,
            );
            
            // Only fetch if we don't have data or need to go back further
            if (oldestCached === null || oldestCached.getTime() > Date.now() - this.RETENTION_MS) {
              const hyperliquidData = await this.fetchHyperliquidHistory(
                mapping.hyperliquidSymbol,
                30,
              );
              if (hyperliquidData.length > 0) {
                // Filter out data we already have
                const existingTimestamps = new Set(
                  (this.historicalData.get(`${symbol}_${ExchangeType.HYPERLIQUID}`) || []).map(
                    (dp) => dp.timestamp.getTime(),
                  ),
                );
                
                let newEntries = 0;
                for (const entry of hyperliquidData) {
                  // Only add if we don't already have this timestamp
                  if (!existingTimestamps.has(entry.timestamp.getTime())) {
                    this.addHistoricalDataPoint(
                      symbol,
                      ExchangeType.HYPERLIQUID,
                      entry.rate,
                      entry.timestamp,
                    );
                    totalFetched++;
                    hyperliquidCount++;
                    newEntries++;
                  }
                }
                
                if (newEntries === 0) {
                  hyperliquidSkipped++;
                }
              } else {
                hyperliquidFailed++;
              }
            } else {
              hyperliquidSkipped++;
              totalSkipped++;
            }
          }

          // Small delay to avoid rate limits
          await new Promise((resolve) => setTimeout(resolve, 200));

          // Fetch Aster historical data (only missing data)
          if (mapping?.asterSymbol) {
            asterSymbols++;
            const oldestCached = this.getOldestTimestamp(
              symbol,
              ExchangeType.ASTER,
            );
            
            // Only fetch if we don't have data or need to go back further
            if (oldestCached === null || oldestCached.getTime() > Date.now() - this.RETENTION_MS) {
              const asterData = await this.fetchAsterHistory(
                mapping.asterSymbol,
                30,
              );
              if (asterData.length > 0) {
                // Filter out data we already have
                const existingTimestamps = new Set(
                  (this.historicalData.get(`${symbol}_${ExchangeType.ASTER}`) || []).map(
                    (dp) => dp.timestamp.getTime(),
                  ),
                );
                
                let newEntries = 0;
                for (const entry of asterData) {
                  // Only add if we don't already have this timestamp
                  if (!existingTimestamps.has(entry.timestamp.getTime())) {
                    this.addHistoricalDataPoint(
                      symbol,
                      ExchangeType.ASTER,
                      entry.rate,
                      entry.timestamp,
                    );
                    totalFetched++;
                    asterCount++;
                    newEntries++;
                  }
                }
                
                if (newEntries === 0) {
                  asterSkipped++;
                }
              } else {
                asterFailed++;
              }
            } else {
              asterSkipped++;
              totalSkipped++;
            }
          }

          // Small delay to avoid rate limits
          await new Promise((resolve) => setTimeout(resolve, 200));

          // Fetch Lighter historical data from explorer API (only missing data)
          if (mapping?.lighterMarketIndex !== undefined) {
            lighterSymbols++;
            const oldestCached = this.getOldestTimestamp(
              symbol,
              ExchangeType.LIGHTER,
            );
            
            // Only fetch if we don't have data or need to go back further
            if (oldestCached === null || oldestCached.getTime() > Date.now() - this.RETENTION_MS) {
              const lighterData = await this.fetchLighterHistory(
                symbol,
                mapping.lighterMarketIndex,
                30,
              );
              if (lighterData.length > 0) {
                // Filter out data we already have
                const existingTimestamps = new Set(
                  (this.historicalData.get(`${symbol}_${ExchangeType.LIGHTER}`) || []).map(
                    (dp) => dp.timestamp.getTime(),
                  ),
                );
                
                let newEntries = 0;
                for (const entry of lighterData) {
                  // Only add if we don't already have this timestamp
                  if (!existingTimestamps.has(entry.timestamp.getTime())) {
                    this.addHistoricalDataPoint(
                      symbol,
                      ExchangeType.LIGHTER,
                      entry.rate,
                      entry.timestamp,
                    );
                    totalFetched++;
                    lighterCount++;
                    newEntries++;
                  }
                }
                
                if (newEntries === 0) {
                  lighterSkipped++;
                }
              } else {
                lighterFailed++;
              }
            } else {
              lighterSkipped++;
              totalSkipped++;
            }
          }
        } catch (err: any) {
          this.logger.error(
            `Failed to backfill historical data for ${symbol}: ${err.message}`,
          );
        }
      }

      this.logger.log(`✅ Backfill Summary: ${totalFetched} new entries fetched${totalSkipped > 0 ? `, ${totalSkipped} skipped (already cached)` : ''}`);
      this.logger.log(
        `   Hyperliquid: ${hyperliquidCount} new entries from ${hyperliquidSymbols} symbols${hyperliquidSkipped > 0 ? ` (${hyperliquidSkipped} already cached)` : ''}${hyperliquidFailed > 0 ? ` (${hyperliquidFailed} failed)` : ''}`,
      );
      this.logger.log(
        `   Aster: ${asterCount} new entries from ${asterSymbols} symbols${asterSkipped > 0 ? ` (${asterSkipped} already cached)` : ''}${asterFailed > 0 ? ` (${asterFailed} failed)` : ''}`,
      );
      this.logger.log(
        `   Lighter: ${lighterCount} new entries from ${lighterSymbols} symbols${lighterSkipped > 0 ? ` (${lighterSkipped} already cached)` : ''}${lighterFailed > 0 ? ` (${lighterFailed} failed)` : ''}`,
      );

      // Clean up old data after backfill
      this.cleanupOldData();
      
      // Save to disk after backfill
      await this.persistToDisk();
    } catch (error: any) {
      this.logger.error(`Failed to backfill historical data: ${error.message}`);
    }
  }

  /**
   * Refresh historical data manually (useful for testing or immediate updates)
   */
  async refreshHistoricalData(): Promise<void> {
    await this.collectCurrentRates();
  }

  /**
   * Get all available historical data for a symbol/exchange pair
   */
  getHistoricalData(
    symbol: string,
    exchange: ExchangeType,
  ): HistoricalFundingRate[] {
    const key = `${symbol}_${exchange}`;
    return this.historicalData.get(key) || [];
  }

  /**
   * Get average rate for a specific time period
   * @param symbol Normalized symbol
   * @param exchange Exchange type
   * @param days Number of days to look back
   * @returns Average rate or null if insufficient data (< 50% of expected data points)
   */
  getAverageRateForPeriod(
    symbol: string,
    exchange: ExchangeType,
    days: number,
  ): number | null {
    const key = `${symbol}_${exchange}`;
    const dataPoints = this.historicalData.get(key) || [];

    if (dataPoints.length === 0) {
      return null;
    }

    // Filter by time window
    const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000;
    const filtered = dataPoints.filter(
      (dp) => dp.timestamp.getTime() > cutoffTime,
    );

    if (filtered.length === 0) {
      return null;
    }

    // Require at least 50% of expected hourly data points
    const expectedDataPoints = days * 24; // Hourly data
    const minRequiredDataPoints = Math.ceil(expectedDataPoints * 0.5);

    if (filtered.length < minRequiredDataPoints) {
      return null; // Insufficient data
    }

    // Calculate average
    const rates = filtered.map((dp) => dp.rate);
    const averageRate = rates.reduce((sum, r) => sum + r, 0) / rates.length;

    return averageRate;
  }

  /**
   * Get weighted average rate using multiple time periods
   * Weighting: Monthly (40%) + Weekly (30%) + Daily (20%) + Current (10%)
   * @param symbol Normalized symbol
   * @param exchange Exchange type
   * @param currentRate Current funding rate (fallback)
   * @returns Weighted average rate
   */
  getWeightedAverageRate(
    symbol: string,
    exchange: ExchangeType,
    currentRate: number,
  ): number {
    // Get averages for each period, falling back to next shorter period or current rate
    const monthlyAvg = this.getAverageRateForPeriod(symbol, exchange, 30);
    const weeklyAvg = this.getAverageRateForPeriod(symbol, exchange, 7);
    const dailyAvg = this.getAverageRateForPeriod(symbol, exchange, 1);

    // Use fallback chain: monthly -> weekly -> daily -> current
    const effectiveMonthly = monthlyAvg ?? weeklyAvg ?? dailyAvg ?? currentRate;
    const effectiveWeekly = weeklyAvg ?? dailyAvg ?? currentRate;
    const effectiveDaily = dailyAvg ?? currentRate;

    // Calculate weighted average: Monthly (40%) + Weekly (30%) + Daily (20%) + Current (10%)
    const weightedAvg =
      effectiveMonthly * 0.4 +
      effectiveWeekly * 0.3 +
      effectiveDaily * 0.2 +
      currentRate * 0.1;

    return weightedAvg;
  }

  /**
   * Get weighted average spread between two exchanges
   * Calculates spread for each matching timestamp pair, then applies weighted averaging
   * @param longSymbol Normalized symbol for long position
   * @param longExchange Exchange for long position
   * @param shortSymbol Normalized symbol for short position
   * @param shortExchange Exchange for short position
   * @param currentLongRate Current long funding rate
   * @param currentShortRate Current short funding rate
   * @returns Weighted average spread
   */
  getAverageSpread(
    longSymbol: string,
    longExchange: ExchangeType,
    shortSymbol: string,
    shortExchange: ExchangeType,
    currentLongRate: number,
    currentShortRate: number,
  ): number {
    const currentSpread = currentLongRate - currentShortRate;

    // Get historical data for both exchanges
    const longData = this.getHistoricalData(longSymbol, longExchange);
    const shortData = this.getHistoricalData(shortSymbol, shortExchange);

    if (longData.length === 0 || shortData.length === 0) {
      return currentSpread; // Fallback to current spread
    }

    // Match data points using improved algorithm with wider windows for Aster
    const matchedSpreads = this.matchHistoricalDataPoints(
      longData,
      shortData,
      longExchange,
      shortExchange,
    );

    if (matchedSpreads.length === 0) {
      return currentSpread; // No matched pairs, use current spread
    }

    // Calculate weighted averages for different periods
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const sevenDaysMs = 7 * oneDayMs;
    const thirtyDaysMs = 30 * oneDayMs;

    const monthlySpreads = matchedSpreads.filter(
      (s) => now - s.timestamp.getTime() <= thirtyDaysMs,
    );
    const weeklySpreads = matchedSpreads.filter(
      (s) => now - s.timestamp.getTime() <= sevenDaysMs,
    );
    const dailySpreads = matchedSpreads.filter(
      (s) => now - s.timestamp.getTime() <= oneDayMs,
    );

    // Calculate averages for each period
    const monthlyAvg =
      monthlySpreads.length > 0
        ? monthlySpreads.reduce((sum, s) => sum + s.spread, 0) /
          monthlySpreads.length
        : null;
    const weeklyAvg =
      weeklySpreads.length > 0
        ? weeklySpreads.reduce((sum, s) => sum + s.spread, 0) /
          weeklySpreads.length
        : null;
    const dailyAvg =
      dailySpreads.length > 0
        ? dailySpreads.reduce((sum, s) => sum + s.spread, 0) /
          dailySpreads.length
        : null;

    // Use fallback chain: monthly -> weekly -> daily -> current
    const effectiveMonthly =
      monthlyAvg ?? weeklyAvg ?? dailyAvg ?? currentSpread;
    const effectiveWeekly = weeklyAvg ?? dailyAvg ?? currentSpread;
    const effectiveDaily = dailyAvg ?? currentSpread;

    // Calculate weighted average: Monthly (40%) + Weekly (30%) + Daily (20%) + Current (10%)
    const weightedAvgSpread =
      effectiveMonthly * 0.4 +
      effectiveWeekly * 0.3 +
      effectiveDaily * 0.2 +
      currentSpread * 0.1;

    return weightedAvgSpread;
  }

  /**
   * Get spread volatility metrics for risk assessment
   * Returns metrics including std dev, reversals, and stability score
   */
  getSpreadVolatilityMetrics(
    longSymbol: string,
    longExchange: ExchangeType,
    shortSymbol: string,
    shortExchange: ExchangeType,
    days: number = 30,
  ): SpreadVolatilityMetrics | null {
    const longData = this.getHistoricalData(longSymbol, longExchange);
    const shortData = this.getHistoricalData(shortSymbol, shortExchange);

    if (longData.length === 0 || shortData.length === 0) {
      return null;
    }

    // Filter by time window
    const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000;
    const filteredLong = longData.filter(
      (dp) => dp.timestamp.getTime() > cutoffTime,
    );
    const filteredShort = shortData.filter(
      (dp) => dp.timestamp.getTime() > cutoffTime,
    );

    if (filteredLong.length === 0 || filteredShort.length === 0) {
      return null;
    }

    // Match spreads using improved algorithm with wider windows for Aster
    const matchedSpreads = this.matchHistoricalDataPoints(
      filteredLong,
      filteredShort,
      longExchange,
      shortExchange,
    );

    if (matchedSpreads.length === 0) {
      return null;
    }

    // Sort by timestamp
    matchedSpreads.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    const spreadValues = matchedSpreads.map((s) => s.spread);
    const averageSpread =
      spreadValues.reduce((sum, s) => sum + s, 0) / spreadValues.length;

    // Standard deviation
    const variance =
      spreadValues.reduce((sum, s) => sum + Math.pow(s - averageSpread, 2), 0) /
      spreadValues.length;
    const stdDevSpread = Math.sqrt(variance);

    const minSpread = Math.min(...spreadValues);
    const maxSpread = Math.max(...spreadValues);

    // Count spread drops to near-zero (< 0.0001% = 0.000001)
    const spreadDropsToZero = spreadValues.filter(
      (s) => Math.abs(s) < 0.000001,
    ).length;

    // Count spread reversals (positive to negative or vice versa)
    let spreadReversals = 0;
    let lastSign = Math.sign(matchedSpreads[0].spread);
    for (let i = 1; i < matchedSpreads.length; i++) {
      const currentSign = Math.sign(matchedSpreads[i].spread);
      if (lastSign !== 0 && currentSign !== 0 && lastSign !== currentSign) {
        spreadReversals++;
      }
      lastSign = currentSign;
    }

    // Max hourly spread change
    let maxHourlySpreadChange = 0;
    for (let i = 1; i < matchedSpreads.length; i++) {
      const change = Math.abs(
        matchedSpreads[i].spread - matchedSpreads[i - 1].spread,
      );
      if (change > maxHourlySpreadChange) {
        maxHourlySpreadChange = change;
      }
    }

    // Stability score: higher = more stable
    // Lower stdDev, fewer drops to zero, fewer reversals = more stable
    const normalizedStdDev = Math.min(1, stdDevSpread * 10000);
    const normalizedDrops = Math.min(
      1,
      spreadDropsToZero / matchedSpreads.length,
    );
    const normalizedReversals = Math.min(
      1,
      spreadReversals / matchedSpreads.length,
    );
    const stabilityScore =
      1 -
      (normalizedStdDev * 0.5 +
        normalizedDrops * 0.3 +
        normalizedReversals * 0.2);

    return {
      averageSpread,
      stdDevSpread,
      minSpread,
      maxSpread,
      spreadDropsToZero,
      spreadReversals,
      maxHourlySpreadChange,
      stabilityScore: Math.max(0, Math.min(1, stabilityScore)),
    };
  }

  /**
   * Match historical data points from two exchanges with improved algorithm
   * Uses wider matching windows for exchanges with lower granularity (e.g., Aster 8-hour intervals)
   */
  private matchHistoricalDataPoints(
    longData: HistoricalFundingRate[],
    shortData: HistoricalFundingRate[],
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): Array<{ spread: number; timestamp: Date }> {
    const matchedSpreads: Array<{ spread: number; timestamp: Date }> = [];
    const matchedTimestamps = new Set<string>();

    // Determine matching window based on exchange granularity
    const getMatchingWindow = (exchange: ExchangeType): number => {
      if (exchange === ExchangeType.ASTER) return 4 * 60 * 60 * 1000; // 4 hours for 8-hour intervals
      return 60 * 60 * 1000; // 1 hour for hourly data
    };

    const windowMs = Math.max(
      getMatchingWindow(longExchange),
      getMatchingWindow(shortExchange),
    );

    // Sort both datasets by timestamp
    const sortedLong = [...longData].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
    const sortedShort = [...shortData].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    // Use two-pointer approach for better matching
    let shortIdx = 0;
    for (const longPoint of sortedLong) {
      // Find closest short point within window
      while (
        shortIdx < sortedShort.length &&
        sortedShort[shortIdx].timestamp.getTime() <
          longPoint.timestamp.getTime() - windowMs
      ) {
        shortIdx++;
      }

      if (shortIdx >= sortedShort.length) break;

      // Check all short points within window
      for (let i = shortIdx; i < sortedShort.length; i++) {
        const shortPoint = sortedShort[i];
        const timeDiff = Math.abs(
          longPoint.timestamp.getTime() - shortPoint.timestamp.getTime(),
        );

        if (timeDiff > windowMs) break; // Beyond window

        const midTimestamp = new Date(
          (longPoint.timestamp.getTime() + shortPoint.timestamp.getTime()) / 2,
        );
        const timestampKey = midTimestamp.toISOString();

        if (!matchedTimestamps.has(timestampKey)) {
          matchedTimestamps.add(timestampKey);
          matchedSpreads.push({
            spread: longPoint.rate - shortPoint.rate,
            timestamp: midTimestamp,
          });
          break; // Use first match within window
        }
      }
    }

    return matchedSpreads.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
  }

  /**
   * Cleanup on module destroy
   */
  onModuleDestroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }
}
