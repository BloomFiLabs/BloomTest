import { Injectable, Logger, Optional } from '@nestjs/common';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { Percentage } from '../value-objects/Percentage';
import { AsterFundingDataProvider } from '../../infrastructure/adapters/aster/AsterFundingDataProvider';
import { LighterFundingDataProvider } from '../../infrastructure/adapters/lighter/LighterFundingDataProvider';
import { HyperLiquidDataProvider } from '../../infrastructure/adapters/hyperliquid/HyperLiquidDataProvider';
import { ExtendedFundingDataProvider } from '../../infrastructure/adapters/extended/ExtendedFundingDataProvider';
import { HyperLiquidWebSocketProvider } from '../../infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider';
import {
  IFundingDataProvider,
  FundingDataRequest,
} from '../ports/IFundingDataProvider';
import * as cliProgress from 'cli-progress';

/**
 * Funding rate data for a specific exchange and symbol
 */
export interface ExchangeFundingRate {
  exchange: ExchangeType;
  symbol: string;
  currentRate: number;
  predictedRate: number;
  markPrice: number;
  openInterest: number | undefined; // undefined when OI is unavailable
  volume24h: number | undefined; // undefined when volume is unavailable
  timestamp: Date;
}

/**
 * Funding rate comparison for a symbol across exchanges
 */
export interface FundingRateComparison {
  symbol: string;
  rates: ExchangeFundingRate[];
  highestRate: ExchangeFundingRate | null;
  lowestRate: ExchangeFundingRate | null;
  spread: number; // Difference between highest and lowest
  timestamp: Date;
}

/**
 * Strategy type for arbitrage
 */
export type ArbitrageStrategyType = 'perp-perp' | 'perp-spot';

/**
 * Arbitrage opportunity
 */
export interface ArbitrageOpportunity {
  symbol: string;
  strategyType: ArbitrageStrategyType; // Type of arbitrage strategy
  longExchange: ExchangeType; // Exchange to go long on (receives funding)
  shortExchange?: ExchangeType; // Exchange to go short on (perp-perp only, undefined for perp-spot)
  spotExchange?: ExchangeType; // Exchange for spot leg (perp-spot strategy only)
  longRate: Percentage;
  shortRate: Percentage;
  spread: Percentage; // Absolute difference
  expectedReturn: Percentage; // Annualized return estimate
  longMarkPrice?: number; // Mark price for long exchange (from funding rate data)
  shortMarkPrice?: number; // Mark price for short exchange (from funding rate data)
  longOpenInterest?: number; // Open interest for long exchange (USD)
  shortOpenInterest?: number; // Open interest for short exchange (USD)
  long24hVolume?: number; // 24h trading volume for long exchange (USD)
  short24hVolume?: number; // 24h trading volume for short exchange (USD)
  timestamp: Date;

  // Prediction-based fields (populated when prediction service is available)
  predictedSpread?: Percentage; // Predicted funding rate spread
  predictionConfidence?: number; // Confidence in prediction (0-1)
  predictedBreakEvenHours?: number; // Break-even using predicted spread
  reliableHorizonHours?: number; // How many hours prediction is reliable
  predictionScore?: number; // Overall opportunity score (0-1)
  predictionRecommendation?: 'strong_buy' | 'buy' | 'hold' | 'skip'; // Recommendation
}

/**
 * Exchange-specific symbol mapping
 */
export interface ExchangeSymbolMapping {
  normalizedSymbol: string; // Common symbol (e.g., "ETH")
  asterSymbol?: string; // Aster format (e.g., "ETHUSDT")
  lighterMarketIndex?: number; // Lighter market index (e.g., 0)
  lighterSymbol?: string; // Lighter symbol name (e.g., "ETH")
  hyperliquidSymbol?: string; // Hyperliquid format (e.g., "ETH")
  extendedSymbol?: string; // Extended format (e.g., "ETH")
  extendedMarketId?: string; // Extended market ID
}

/**
 * FundingRateAggregator - Aggregates funding rates from all exchanges
 */
@Injectable()
export class FundingRateAggregator {
  private readonly logger = new Logger(FundingRateAggregator.name);
  private symbolMappings: Map<string, ExchangeSymbolMapping> = new Map(); // normalizedSymbol -> mapping
  private useCachedSymbols: boolean = true; // Use cached symbols by default for faster startup

  // List of all funding data providers for parallel fetching
  private readonly fundingProviders: IFundingDataProvider[];

  constructor(
    private readonly asterProvider: AsterFundingDataProvider,
    private readonly lighterProvider: LighterFundingDataProvider,
    private readonly hyperliquidProvider: HyperLiquidDataProvider,
    private readonly hyperliquidWsProvider: HyperLiquidWebSocketProvider,
    @Optional() private readonly lighterWsProvider?: any, // LighterWebSocketProvider (optional to avoid circular dependency)
    @Optional() private readonly extendedProvider?: ExtendedFundingDataProvider,
  ) {
    // Initialize funding providers list (all implement IFundingDataProvider)
    this.fundingProviders = [
      this.asterProvider,
      this.lighterProvider,
      this.hyperliquidProvider,
    ];

    // Try to load cached symbols on construction
    this.loadCachedSymbols();
  }

  /**
   * Load cached symbols from the generated file
   * This avoids slow API calls on every startup
   */
  private loadCachedSymbols(): void {
    try {
      // Import cached symbols (generated by scripts/discover-common-symbols.ts)
      const { CACHED_SYMBOLS } = require('../../config/cached-symbols');

      if (
        CACHED_SYMBOLS &&
        Array.isArray(CACHED_SYMBOLS) &&
        CACHED_SYMBOLS.length > 0
      ) {
        this.symbolMappings.clear();

        for (const mapping of CACHED_SYMBOLS) {
          this.symbolMappings.set(mapping.normalizedSymbol, {
            normalizedSymbol: mapping.normalizedSymbol,
            asterSymbol: mapping.asterSymbol,
            lighterMarketIndex: mapping.lighterMarketIndex,
            lighterSymbol: mapping.lighterSymbol,
            hyperliquidSymbol: mapping.hyperliquidSymbol,
          });
        }

        this.logger.log(
          `✅ Loaded ${CACHED_SYMBOLS.length} cached symbol mappings (fast startup)`,
        );
        this.useCachedSymbols = true;
      }
    } catch (error: any) {
      this.logger.warn(
        `Could not load cached symbols: ${error.message}. Will discover dynamically.`,
      );
      this.useCachedSymbols = false;
    }
  }

  /**
   * Subscribe to WebSocket feeds for real-time data
   * Called after symbol mappings are loaded (cached or discovered)
   */
  private subscribeToWebSocketFeeds(): void {
    // Get Hyperliquid symbols from mappings
    const hyperliquidAssets: string[] = [];
    const lighterMarketIndexes: number[] = [];

    for (const mapping of this.symbolMappings.values()) {
      if (mapping.hyperliquidSymbol) {
        hyperliquidAssets.push(mapping.hyperliquidSymbol);
      }
      if (mapping.lighterMarketIndex !== undefined) {
        lighterMarketIndexes.push(mapping.lighterMarketIndex);
      }
    }

    // Subscribe to Hyperliquid assets via WebSocket
    if (
      this.hyperliquidWsProvider.isWsConnected() &&
      hyperliquidAssets.length > 0
    ) {
      this.hyperliquidWsProvider.subscribeToAssets(hyperliquidAssets);
      this.logger.log(
        `📡 Subscribed to ${hyperliquidAssets.length} Hyperliquid assets via WebSocket`,
      );
    }

    // Subscribe to Lighter markets via WebSocket
    if (lighterMarketIndexes.length > 0 && this.lighterWsProvider) {
      this.lighterWsProvider.subscribeToMarkets(lighterMarketIndexes);

      if (this.lighterWsProvider.isWsConnected()) {
        this.logger.log(
          `📡 Subscribed to ${lighterMarketIndexes.length} Lighter markets via WebSocket`,
        );
        setTimeout(
          () => this.lighterWsProvider?.ensureAllMarketsSubscribed(),
          200,
        );
      } else {
        this.logger.log(
          `📡 Queued ${lighterMarketIndexes.length} Lighter markets for WebSocket subscription`,
        );
        setTimeout(() => {
          if (this.lighterWsProvider?.isWsConnected()) {
            this.lighterWsProvider.ensureAllMarketsSubscribed();
          }
        }, 2000);
      }
    }
  }

  /**
   * Normalize symbol name across exchanges
   * Aster: ETHUSDT -> ETH
   * Hyperliquid: ETH -> ETH
   * Lighter: ETH -> ETH
   */
  private normalizeSymbol(symbol: string): string {
    return symbol
      .replace('USDT', '')
      .replace('USDC', '')
      .replace('-PERP', '')
      .replace('PERP', '')
      .toUpperCase();
  }

  /**
   * Discover all common assets across all exchanges
   * Returns array of normalized symbol names that are available on at least 2 exchanges
   * Also builds symbol mappings for exchange-specific formats
   *
   * Uses cached symbols by default for fast startup. Set useCachedSymbols=false to force refresh.
   */
  async discoverCommonAssets(forceRefresh: boolean = false): Promise<string[]> {
    // Use cached symbols if available and not forcing refresh
    if (
      this.useCachedSymbols &&
      !forceRefresh &&
      this.symbolMappings.size > 0
    ) {
      const cachedSymbols = Array.from(this.symbolMappings.keys()).sort();
      this.logger.log(
        `Using ${cachedSymbols.length} cached common symbols (use forceRefresh=true to update)`,
      );

      // Still subscribe to WebSocket feeds for real-time data
      this.subscribeToWebSocketFeeds();

      return cachedSymbols;
    }

    this.logger.log(
      'Discovering all available assets across exchanges (live API calls)...',
    );

    try {
      // Get all assets from each exchange
      const [asterSymbols, lighterMarkets, hyperliquidAssets, extendedMarkets] =
        await Promise.all([
          this.asterProvider.getAvailableSymbols().catch(() => []),
          this.lighterProvider.getAvailableMarkets().catch(() => []),
          this.hyperliquidProvider.getAvailableAssets().catch(() => []),
          Promise.resolve([]), // Extended provider will be discovered via getCurrentFundingRate calls
        ]);

      // Build symbol mappings
      this.symbolMappings.clear();

      // Process Aster symbols (format: "ETHUSDT", "BTCUSDT")
      for (const asterSymbol of asterSymbols) {
        const normalized = this.normalizeSymbol(asterSymbol);
        if (!this.symbolMappings.has(normalized)) {
          this.symbolMappings.set(normalized, { normalizedSymbol: normalized });
        }
        this.symbolMappings.get(normalized)!.asterSymbol = asterSymbol;
      }

      // Process Lighter markets (format: {marketIndex: 0, symbol: "ETH"})
      for (const market of lighterMarkets) {
        const normalized = this.normalizeSymbol(market.symbol);
        if (!this.symbolMappings.has(normalized)) {
          this.symbolMappings.set(normalized, { normalizedSymbol: normalized });
        }
        const mapping = this.symbolMappings.get(normalized)!;
        mapping.lighterMarketIndex = market.marketIndex;
        mapping.lighterSymbol = market.symbol;
      }

      // Process Hyperliquid assets (format: "ETH", "BTC")
      for (const hlAsset of hyperliquidAssets) {
        const normalized = this.normalizeSymbol(hlAsset);
        if (!this.symbolMappings.has(normalized)) {
          this.symbolMappings.set(normalized, { normalizedSymbol: normalized });
        }
        this.symbolMappings.get(normalized)!.hyperliquidSymbol = hlAsset;
      }

      // Subscribe to all Hyperliquid assets via WebSocket (reduces rate limits)
      if (
        this.hyperliquidWsProvider.isWsConnected() &&
        hyperliquidAssets.length > 0
      ) {
        this.hyperliquidWsProvider.subscribeToAssets(hyperliquidAssets);
        this.logger.log(
          `Subscribed to ${hyperliquidAssets.length} Hyperliquid assets via WebSocket`,
        );
      }

      // Subscribe to all Lighter markets via WebSocket (for real-time OI data)
      // Always subscribe (even if not connected yet - will subscribe on reconnect)
      if (lighterMarkets.length > 0) {
        const marketIndexes = lighterMarkets.map((m) => m.marketIndex);

        // Always call subscribeToMarkets - it handles connection state internally
        this.lighterWsProvider?.subscribeToMarkets(marketIndexes);

        // Always ensure subscriptions, even if check fails (handles race conditions)
        if (this.lighterWsProvider?.isWsConnected()) {
          this.logger.log(
            `📡 LIGHTER: Subscribed to ${marketIndexes.length} markets via WebSocket`,
          );
          // Force ensure all markets are subscribed (in case some were skipped)
          setTimeout(() => {
            this.lighterWsProvider?.ensureAllMarketsSubscribed();
          }, 200);
        } else {
          this.logger.log(
            `📡 LIGHTER: Queued ${marketIndexes.length} markets for WebSocket subscription (will subscribe when connected)`,
          );
          // Also set up a delayed check in case websocket connects shortly after
          setTimeout(() => {
            if (this.lighterWsProvider?.isWsConnected()) {
              this.logger.log(
                `📡 LIGHTER: WebSocket now connected - ensuring ${marketIndexes.length} markets are subscribed`,
              );
              this.lighterWsProvider?.ensureAllMarketsSubscribed();
            } else {
              // Even if check fails, try to ensure subscriptions (handles race conditions)
              this.logger.debug(
                `📡 LIGHTER: WebSocket check failed but attempting to ensure subscriptions anyway`,
              );
              this.lighterWsProvider?.ensureAllMarketsSubscribed();
            }
          }, 2000);
        }
      }

      // Find common assets (available on at least 2 exchanges)
      const commonAssets: string[] = [];
      for (const [normalized, mapping] of this.symbolMappings.entries()) {
        let exchangeCount = 0;
        if (mapping.asterSymbol) exchangeCount++;
        if (mapping.lighterMarketIndex !== undefined) exchangeCount++;
        if (mapping.hyperliquidSymbol) exchangeCount++;
        if (mapping.extendedSymbol) exchangeCount++;

        // Only include if available on at least 2 exchanges (required for arbitrage)
        if (exchangeCount >= 2) {
          commonAssets.push(normalized);
          // Silenced mapping logs - too verbose
        }
      }

      this.logger.log(
        `Discovered ${commonAssets.length} common assets available on 2+ exchanges: ${commonAssets.join(', ')}`,
      );

      return commonAssets.sort();
    } catch (error: any) {
      this.logger.error(`Failed to discover common assets: ${error.message}`);
      // Fallback to default symbols if discovery fails
      return ['ETH', 'BTC'];
    }
  }

  /**
   * Get exchange-specific symbol for a normalized symbol
   */
  getExchangeSymbol(
    normalizedSymbol: string,
    exchange: ExchangeType,
  ): string | number | undefined {
    const mapping = this.symbolMappings.get(normalizedSymbol);
    if (!mapping) return undefined;

    switch (exchange) {
      case ExchangeType.ASTER:
        return mapping.asterSymbol;
      case ExchangeType.LIGHTER:
        return mapping.lighterMarketIndex;
      case ExchangeType.HYPERLIQUID:
        return mapping.hyperliquidSymbol;
      default:
        return undefined;
    }
  }

  /**
   * Get full symbol mapping for a normalized symbol
   */
  getSymbolMapping(
    normalizedSymbol: string,
  ): ExchangeSymbolMapping | undefined {
    return this.symbolMappings.get(normalizedSymbol);
  }

  /**
   * Build a FundingDataRequest for a provider based on symbol mapping
   * Returns null if the provider doesn't support this symbol
   */
  private buildFundingRequest(
    provider: IFundingDataProvider,
    symbol: string,
    mapping: ExchangeSymbolMapping | undefined,
  ): FundingDataRequest | null {
    if (!mapping) return null;

    const exchangeType = provider.getExchangeType();

    switch (exchangeType) {
      case ExchangeType.ASTER:
        return mapping.asterSymbol
          ? { normalizedSymbol: symbol, exchangeSymbol: mapping.asterSymbol }
          : null;
      case ExchangeType.LIGHTER:
        return mapping.lighterMarketIndex !== undefined
          ? {
              normalizedSymbol: symbol,
              exchangeSymbol: mapping.lighterSymbol || symbol,
              marketIndex: mapping.lighterMarketIndex,
            }
          : null;
      case ExchangeType.HYPERLIQUID:
        return mapping.hyperliquidSymbol
          ? {
              normalizedSymbol: symbol,
              exchangeSymbol: mapping.hyperliquidSymbol,
            }
          : null;
      default:
        return null;
    }
  }

  /**
   * Get funding rates for a symbol across all exchanges
   * Uses PARALLEL calls to all exchanges for maximum efficiency
   * @param symbol Normalized symbol (e.g., 'ETH', 'BTC')
   */
  async getFundingRates(symbol: string): Promise<ExchangeFundingRate[]> {
    const mapping = this.getSymbolMapping(symbol);

    // Build parallel fetch promises for all providers that support this symbol
    const fetchPromises = this.fundingProviders
      .map((provider) => {
        const request = this.buildFundingRequest(provider, symbol, mapping);
        if (!request) return null;

        return provider.getFundingData(request).catch((error: any) => {
          this.logger.debug(
            `Failed to get ${provider.getExchangeType()} funding data for ${symbol}: ${error.message}`,
          );
          return null;
        });
      })
      .filter((p): p is Promise<ExchangeFundingRate | null> => p !== null);

    // Execute all fetches in parallel and filter out nulls
    const results = await Promise.all(fetchPromises);
    return results.filter((rate): rate is ExchangeFundingRate => rate !== null);
  }

  /**
   * Compare funding rates across exchanges for a symbol
   */
  async compareFundingRates(symbol: string): Promise<FundingRateComparison> {
    const rates = await this.getFundingRates(symbol);

    if (rates.length === 0) {
      throw new Error(`No funding rates available for ${symbol}`);
    }

    const sortedRates = [...rates].sort(
      (a, b) => b.currentRate - a.currentRate,
    );
    const highestRate = sortedRates[0];
    const lowestRate = sortedRates[sortedRates.length - 1];
    const spread = highestRate.currentRate - lowestRate.currentRate;

    return {
      symbol,
      rates,
      highestRate,
      lowestRate,
      spread,
      timestamp: new Date(),
    };
  }

  /**
   * Find arbitrage opportunities across all exchanges
   *
   * Strategy: Find exchanges where we can:
   * - Go LONG on exchange with highest positive funding rate (receive funding)
   * - Go SHORT on exchange with lowest (most negative) funding rate (receive funding)
   */
  async findArbitrageOpportunities(
    symbols: string[],
    minSpread: number = 0.0001, // Minimum spread to consider (0.01%)
    showProgress: boolean = true,
  ): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    // Create progress bar if requested
    let progressBar: cliProgress.SingleBar | null = null;
    if (showProgress) {
      progressBar = new cliProgress.SingleBar({
        format:
          '🔍 Searching opportunities |{bar}| {percentage}% | {value}/{total} symbols | {opportunities} opportunities found',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      });
      progressBar.start(symbols.length, 0, { opportunities: 0 });
    }

    // Process symbols in parallel batches to avoid rate limits
    // Process 3 symbols at a time with a delay between batches
    // Reduced from 5 to 3 due to Lighter API rate limiting (429 errors)
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 1500; // 1.5 seconds between batches

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.allSettled(
        batch.map(async (symbol) => {
          try {
            const comparison = await this.compareFundingRates(symbol);

            if (comparison.rates.length < 2) {
              return []; // Need at least 2 exchanges to arbitrage
            }

            const symbolOpportunities: ArbitrageOpportunity[] = [];
            const mapping = this.getSymbolMapping(symbol);

            // GENERATE ALL PROFITABLE EXCHANGE PAIRS
            // Instead of just the single "best" pair, generate opportunities for ALL exchange combinations
            // that have a positive spread. This allows the portfolio optimizer to choose based on
            // available capital across exchanges, not just theoretical best returns.
            //
            // FUNDING RATE ARBITRAGE LOGIC:
            // - LONG position: negative funding rate = we RECEIVE funding (profit)
            // - SHORT position: positive funding rate = we RECEIVE funding (profit)
            // - We want: LONG on lower rate, SHORT on higher rate
            // - Spread = shortRate - longRate (positive when profitable)

            // Check which exchanges support this symbol for trading
            const supportedExchanges = comparison.rates.filter((rate) => {
              if (!mapping) return false;
              switch (rate.exchange) {
                case ExchangeType.ASTER:
                  return !!mapping.asterSymbol;
                case ExchangeType.LIGHTER:
                  return mapping.lighterMarketIndex !== undefined;
                case ExchangeType.HYPERLIQUID:
                  return !!mapping.hyperliquidSymbol;
                default:
                  return false;
              }
            });

            // Generate ALL profitable exchange pair combinations
            // For n exchanges, this creates up to n*(n-1) opportunities (all pairs where long ≠ short)
            for (const longExchangeRate of supportedExchanges) {
              for (const shortExchangeRate of supportedExchanges) {
                // Skip same exchange pairs
                if (longExchangeRate.exchange === shortExchangeRate.exchange)
                  continue;

                // Calculate spread: shortRate - longRate
                // Positive spread = profitable (we receive more on short than we pay on long)
                const spreadDecimal =
                  shortExchangeRate.currentRate - longExchangeRate.currentRate;

                // Only create opportunity if spread meets minimum threshold
                if (spreadDecimal >= minSpread) {
                  const longRate = Percentage.fromDecimal(
                    longExchangeRate.currentRate,
                  );
                  const shortRate = Percentage.fromDecimal(
                    shortExchangeRate.currentRate,
                  );
                  const spread = Percentage.fromDecimal(spreadDecimal);

                  // Calculate expected annualized return
                  // Funding rates are typically hourly (e.g., 0.0013% per hour ≈ 10% annualized)
                  const periodsPerDay = 24; // Hourly funding periods
                  const periodsPerYear = periodsPerDay * 365;
                  const expectedReturn = Percentage.fromDecimal(
                    spreadDecimal * periodsPerYear,
                  );

                  symbolOpportunities.push({
                    symbol,
                    strategyType: 'perp-perp',
                    longExchange: longExchangeRate.exchange,
                    shortExchange: shortExchangeRate.exchange,
                    longRate,
                    shortRate,
                    spread,
                    expectedReturn,
                    longMarkPrice:
                      longExchangeRate.markPrice > 0
                        ? longExchangeRate.markPrice
                        : undefined,
                    shortMarkPrice:
                      shortExchangeRate.markPrice > 0
                        ? shortExchangeRate.markPrice
                        : undefined,
                    longOpenInterest:
                      longExchangeRate.openInterest !== undefined &&
                      longExchangeRate.openInterest > 0
                        ? longExchangeRate.openInterest
                        : undefined,
                    shortOpenInterest:
                      shortExchangeRate.openInterest !== undefined &&
                      shortExchangeRate.openInterest > 0
                        ? shortExchangeRate.openInterest
                        : undefined,
                    long24hVolume:
                      longExchangeRate.volume24h !== undefined &&
                      longExchangeRate.volume24h > 0
                        ? longExchangeRate.volume24h
                        : undefined,
                    short24hVolume:
                      shortExchangeRate.volume24h !== undefined &&
                      shortExchangeRate.volume24h > 0
                        ? shortExchangeRate.volume24h
                        : undefined,
                    timestamp: new Date(),
                  });
                }
              }
            }

            return symbolOpportunities;
          } catch (error: any) {
            // Only log actual errors (not expected failures like missing data)
            if (error.message && !error.message.includes('No funding rates')) {
              this.logger.error(
                `Failed to find opportunities for ${symbol}: ${error.message}`,
              );
            }
            return [];
          }
        }),
      );

      // Collect results from batch
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          opportunities.push(...result.value);
        }
      }

      // Update progress bar
      if (progressBar) {
        const processed = Math.min(i + BATCH_SIZE, symbols.length);
        progressBar.update(processed, { opportunities: opportunities.length });
      }

      // Add delay between batches to avoid rate limits (except for last batch)
      if (i + BATCH_SIZE < symbols.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    // Complete progress bar
    if (progressBar) {
      progressBar.update(symbols.length, {
        opportunities: opportunities.length,
      });
      progressBar.stop();
    }

    // Sort by expected return (highest first)
    return opportunities.sort(
      (a, b) => b.expectedReturn.toAPY() - a.expectedReturn.toAPY(),
    );
  }

  /**
   * Find perp-spot arbitrage opportunities
   *
   * Perp-Spot Strategy (delta-neutral):
   * - If funding rate is POSITIVE (longs pay shorts): SHORT perp + LONG spot
   *   → Receive funding from perp while holding equivalent spot
   * - If funding rate is NEGATIVE (shorts pay longs): LONG perp + SHORT spot
   *   → Receive funding from perp while shorting equivalent spot (requires borrowing)
   *
   * The "spread" is the absolute funding rate since spot has no funding cost.
   * Note: Shorting spot requires borrowing the asset, which has its own costs.
   *
   * @param symbols List of symbols to check
   * @param minSpread Minimum funding rate to consider (absolute value)
   * @param showProgress Whether to show progress bar
   * @param spotBorrowCost Estimated cost of borrowing spot for shorting (default 0.01% per hour)
   */
  async findPerpSpotOpportunities(
    symbols: string[],
    minSpread: number = 0.0001,
    showProgress: boolean = true,
    spotBorrowCost: number = 0.0001, // Default 0.01% per hour borrow cost
  ): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    // Create progress bar if requested
    let progressBar: cliProgress.SingleBar | null = null;
    if (showProgress) {
      progressBar = new cliProgress.SingleBar({
        format:
          '🔍 Searching perp-spot |{bar}| {percentage}% | {value}/{total} symbols | {opportunities} opportunities found',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      });
      progressBar.start(symbols.length, 0, { opportunities: 0 });
    }

    // Process symbols in parallel batches
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 1500;

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.allSettled(
        batch.map(async (symbol) => {
          try {
            const fundingRates = await this.getFundingRates(symbol);
            const symbolOpportunities: ArbitrageOpportunity[] = [];

            // For each exchange with funding data, check if perp-spot is viable
            for (const rate of fundingRates) {
              const absRate = Math.abs(rate.currentRate);

              // For positive funding (longs pay shorts): SHORT perp + LONG spot
              // Net spread = funding rate received (no borrow cost for going long spot)
              if (rate.currentRate > 0 && absRate >= minSpread) {
                const spread = Percentage.fromDecimal(absRate);
                const periodsPerYear = 24 * 365;
                const expectedReturn = Percentage.fromDecimal(
                  absRate * periodsPerYear,
                );

                symbolOpportunities.push({
                  symbol,
                  strategyType: 'perp-spot',
                  longExchange: rate.exchange, // Spot is on same exchange
                  shortExchange: undefined, // No short perp exchange (we short on longExchange)
                  spotExchange: rate.exchange,
                  longRate: Percentage.fromDecimal(0), // Spot has no funding
                  shortRate: Percentage.fromDecimal(rate.currentRate), // Perp funding rate
                  spread,
                  expectedReturn,
                  longMarkPrice:
                    rate.markPrice > 0 ? rate.markPrice : undefined,
                  shortMarkPrice:
                    rate.markPrice > 0 ? rate.markPrice : undefined,
                  longOpenInterest: rate.openInterest,
                  shortOpenInterest: rate.openInterest,
                  long24hVolume: rate.volume24h,
                  short24hVolume: rate.volume24h,
                  timestamp: new Date(),
                });
              }

              // For negative funding (shorts pay longs): LONG perp + SHORT spot
              // Net spread = |funding rate| - borrow cost
              if (rate.currentRate < 0) {
                const netSpread = absRate - spotBorrowCost;
                if (netSpread >= minSpread) {
                  const spread = Percentage.fromDecimal(netSpread);
                  const periodsPerYear = 24 * 365;
                  const expectedReturn = Percentage.fromDecimal(
                    netSpread * periodsPerYear,
                  );

                  symbolOpportunities.push({
                    symbol,
                    strategyType: 'perp-spot',
                    longExchange: rate.exchange, // Long perp on this exchange
                    shortExchange: undefined,
                    spotExchange: rate.exchange, // Short spot on same exchange
                    longRate: Percentage.fromDecimal(rate.currentRate), // Negative = we receive
                    shortRate: Percentage.fromDecimal(spotBorrowCost), // Borrow cost for shorting spot
                    spread,
                    expectedReturn,
                    longMarkPrice:
                      rate.markPrice > 0 ? rate.markPrice : undefined,
                    shortMarkPrice:
                      rate.markPrice > 0 ? rate.markPrice : undefined,
                    longOpenInterest: rate.openInterest,
                    shortOpenInterest: rate.openInterest,
                    long24hVolume: rate.volume24h,
                    short24hVolume: rate.volume24h,
                    timestamp: new Date(),
                  });
                }
              }
            }

            return symbolOpportunities;
          } catch (error: any) {
            if (error.message && !error.message.includes('No funding rates')) {
              this.logger.error(
                `Failed to find perp-spot opportunities for ${symbol}: ${error.message}`,
              );
            }
            return [];
          }
        }),
      );

      // Collect results from batch
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          opportunities.push(...result.value);
        }
      }

      // Update progress bar
      if (progressBar) {
        const processed = Math.min(i + BATCH_SIZE, symbols.length);
        progressBar.update(processed, { opportunities: opportunities.length });
      }

      // Add delay between batches
      if (i + BATCH_SIZE < symbols.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    // Complete progress bar
    if (progressBar) {
      progressBar.update(symbols.length, {
        opportunities: opportunities.length,
      });
      progressBar.stop();
    }

    // Sort by expected return (highest first)
    return opportunities.sort(
      (a, b) => b.expectedReturn.toAPY() - a.expectedReturn.toAPY(),
    );
  }

  /**
   * Find all arbitrage opportunities (both perp-perp and perp-spot)
   *
   * @param symbols List of symbols to check
   * @param minSpread Minimum spread threshold
   * @param showProgress Whether to show progress bar
   * @param includePerpSpot Whether to include perp-spot opportunities
   */
  async findAllOpportunities(
    symbols: string[],
    minSpread: number = 0.0001,
    showProgress: boolean = true,
    includePerpSpot: boolean = false,
  ): Promise<ArbitrageOpportunity[]> {
    // Get perp-perp opportunities
    const perpPerpOpps = await this.findArbitrageOpportunities(
      symbols,
      minSpread,
      showProgress,
    );

    if (!includePerpSpot) {
      return perpPerpOpps;
    }

    // Get perp-spot opportunities (don't show progress again)
    const perpSpotOpps = await this.findPerpSpotOpportunities(
      symbols,
      minSpread,
      false,
    );

    // Combine and sort by expected return
    const allOpportunities = [...perpPerpOpps, ...perpSpotOpps];
    return allOpportunities.sort(
      (a, b) => b.expectedReturn.toAPY() - a.expectedReturn.toAPY(),
    );
  }
}
