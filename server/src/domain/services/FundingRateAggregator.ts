import { Injectable, Logger, Optional } from '@nestjs/common';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { Percentage } from '../value-objects/Percentage';
import { AsterFundingDataProvider } from '../../infrastructure/adapters/aster/AsterFundingDataProvider';
import { LighterFundingDataProvider } from '../../infrastructure/adapters/lighter/LighterFundingDataProvider';
import { HyperLiquidDataProvider } from '../../infrastructure/adapters/hyperliquid/HyperLiquidDataProvider';
import { ExtendedFundingDataProvider } from '../../infrastructure/adapters/extended/ExtendedFundingDataProvider';
import { HyperLiquidWebSocketProvider } from '../../infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider';
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
 * Arbitrage opportunity
 */
export interface ArbitrageOpportunity {
  symbol: string;
  strategyType: 'perp-perp' | 'perp-spot'; // Strategy type
  longExchange: ExchangeType; // Exchange to go long on (receives funding)
  shortExchange?: ExchangeType; // Exchange to go short on (optional for perp-spot)
  spotExchange?: ExchangeType; // Exchange for spot position (same as longExchange for perp-spot)
  longRate: Percentage;
  shortRate?: Percentage; // Optional for perp-spot (spot rate is 0%)
  spread: Percentage; // Absolute difference
  expectedReturn: Percentage; // Annualized return estimate
  longMarkPrice?: number; // Mark price for long exchange (from funding rate data)
  shortMarkPrice?: number; // Mark price for short exchange (from funding rate data)
  longOpenInterest?: number; // Open interest for long exchange (USD)
  shortOpenInterest?: number; // Open interest for short exchange (USD)
  long24hVolume?: number; // 24h trading volume for long exchange (USD)
  short24hVolume?: number; // 24h trading volume for short exchange (USD)
  timestamp: Date;
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

  constructor(
    private readonly asterProvider: AsterFundingDataProvider,
    private readonly lighterProvider: LighterFundingDataProvider,
    private readonly hyperliquidProvider: HyperLiquidDataProvider,
    private readonly hyperliquidWsProvider: HyperLiquidWebSocketProvider,
    @Optional() private readonly lighterWsProvider?: any, // LighterWebSocketProvider (optional to avoid circular dependency)
    @Optional() private readonly extendedProvider?: ExtendedFundingDataProvider,
  ) {}

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
   */
  async discoverCommonAssets(): Promise<string[]> {
    this.logger.log('Discovering all available assets across exchanges...');

    try {
      // Get all assets from each exchange
      const [asterSymbols, lighterMarkets, hyperliquidAssets, extendedMarkets] = await Promise.all([
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
      if (this.hyperliquidWsProvider.isWsConnected() && hyperliquidAssets.length > 0) {
        this.hyperliquidWsProvider.subscribeToAssets(hyperliquidAssets);
        this.logger.log(`Subscribed to ${hyperliquidAssets.length} Hyperliquid assets via WebSocket`);
      }

      // Subscribe to all Lighter markets via WebSocket (for real-time OI data)
      // Always subscribe (even if not connected yet - will subscribe on reconnect)
      if (lighterMarkets.length > 0) {
        const marketIndexes = lighterMarkets.map(m => m.marketIndex);
        
        // Always call subscribeToMarkets - it handles connection state internally
        this.lighterWsProvider?.subscribeToMarkets(marketIndexes);
        
        // Always ensure subscriptions, even if check fails (handles race conditions)
        if (this.lighterWsProvider?.isWsConnected()) {
          this.logger.log(`📡 LIGHTER: Subscribed to ${marketIndexes.length} markets via WebSocket`);
          // Force ensure all markets are subscribed (in case some were skipped)
          setTimeout(() => {
            this.lighterWsProvider?.ensureAllMarketsSubscribed();
          }, 200);
        } else {
          this.logger.log(`📡 LIGHTER: Queued ${marketIndexes.length} markets for WebSocket subscription (will subscribe when connected)`);
          // Also set up a delayed check in case websocket connects shortly after
          setTimeout(() => {
            if (this.lighterWsProvider?.isWsConnected()) {
              this.logger.log(`📡 LIGHTER: WebSocket now connected - ensuring ${marketIndexes.length} markets are subscribed`);
              this.lighterWsProvider?.ensureAllMarketsSubscribed();
            } else {
              // Even if check fails, try to ensure subscriptions (handles race conditions)
              this.logger.debug(`📡 LIGHTER: WebSocket check failed but attempting to ensure subscriptions anyway`);
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
        `Discovered ${commonAssets.length} common assets available on 2+ exchanges: ${commonAssets.join(', ')}`
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
  getExchangeSymbol(normalizedSymbol: string, exchange: ExchangeType): string | number | undefined {
    const mapping = this.symbolMappings.get(normalizedSymbol);
    if (!mapping) return undefined;

    switch (exchange) {
      case ExchangeType.ASTER:
        return mapping.asterSymbol;
      case ExchangeType.LIGHTER:
        return mapping.lighterMarketIndex;
      case ExchangeType.HYPERLIQUID:
        return mapping.hyperliquidSymbol;
      case ExchangeType.EXTENDED:
        return mapping.extendedSymbol;
      default:
        return undefined;
    }
  }

  /**
   * Get full symbol mapping for a normalized symbol
   */
  getSymbolMapping(normalizedSymbol: string): ExchangeSymbolMapping | undefined {
    return this.symbolMappings.get(normalizedSymbol);
  }

  /**
   * Get funding rates for a symbol across all exchanges
   * @param symbol Normalized symbol (e.g., 'ETH', 'BTC')
   */
  async getFundingRates(symbol: string): Promise<ExchangeFundingRate[]> {
    const rates: ExchangeFundingRate[] = [];

    // Get Aster funding rate
    // Use exchange-specific symbol format from mapping
    try {
      const mapping = this.getSymbolMapping(symbol);
      const asterSymbol = mapping?.asterSymbol;
      
      if (!asterSymbol) {
        // No mapping - skip silently
      } else {
        const asterRate = await this.asterProvider.getCurrentFundingRate(asterSymbol);
        const asterPredicted = await this.asterProvider.getPredictedFundingRate(asterSymbol);
        const asterMarkPrice = await this.asterProvider.getMarkPrice(asterSymbol);
        
        // OI is critical - if it fails, log error and skip
        try {
        const asterOI = await this.asterProvider.getOpenInterest(asterSymbol);

        rates.push({
          exchange: ExchangeType.ASTER,
          symbol, // Use normalized symbol
          currentRate: asterRate,
          predictedRate: asterPredicted,
          markPrice: asterMarkPrice,
          openInterest: asterOI,
          volume24h: undefined, // Aster volume not yet implemented
          timestamp: new Date(),
        });
        } catch (oiError: any) {
          const errorMsg = oiError.message || String(oiError);
          this.logger.error(`Failed to get Aster OI for ${symbol} (${asterSymbol}): ${errorMsg}`);
          this.logger.error(`  ⚠️  Skipping Aster for ${symbol} - OI is required but unavailable`);
          // Don't add rate entry if OI is unavailable - it will show as N/A
        }
      }
    } catch (error: any) {
      // Only log actual errors (not missing mappings or OI errors which are handled above)
      if (error.message && !error.message.includes('not found') && !error.message.includes('No funding rates') && !error.message.includes('OI')) {
        this.logger.error(`Failed to get Aster funding rate for ${symbol}: ${error.message}`);
      }
    }

    // Get Lighter funding rate
    // Use exchange-specific market index from mapping
    try {
      const mapping = this.getSymbolMapping(symbol);
      const marketIndex = mapping?.lighterMarketIndex;
      
      if (marketIndex === undefined) {
        // No mapping - skip silently
      } else {
          const lighterRate = await this.lighterProvider.getCurrentFundingRate(marketIndex);
          
          // Try to get additional data
          // OI is critical - if it fails, we should log the error and skip this exchange
          try {
            const lighterPredicted = await this.lighterProvider.getPredictedFundingRate(marketIndex);
            
            // Get OI and mark price together (more efficient - single API call)
            const { openInterest: lighterOI, markPrice: lighterMarkPrice } = 
              await this.lighterProvider.getOpenInterestAndMarkPrice(marketIndex);

            // Try to get 24h volume
            let lighterVolume: number | undefined;
            try {
              lighterVolume = await this.lighterProvider.get24hVolume(marketIndex);
            } catch (volumeError) {
              lighterVolume = undefined; // Volume is optional, don't fail on error
            }

            rates.push({
              exchange: ExchangeType.LIGHTER,
              symbol,
              currentRate: lighterRate,
              predictedRate: lighterPredicted,
              markPrice: lighterMarkPrice,
              openInterest: lighterOI,
              volume24h: lighterVolume,
              timestamp: new Date(),
            });
        } catch (dataError: any) {
          // Log the error with full context
          const errorMsg = dataError.message || String(dataError);
          this.logger.debug(`Failed to get Lighter data for ${symbol} (market ${marketIndex}): ${errorMsg}`);
          
          // If it's an OI error, we can't proceed - OI is required for liquidity checks
          if (errorMsg.includes('OI') || errorMsg.includes('open interest') || errorMsg.includes('openInterest')) {
            this.logger.debug(`  ⚠️  Skipping Lighter for ${symbol} - OI is required but unavailable`);
            // Don't add rate entry if OI is unavailable - it will show as N/A
          } else {
            // For other errors (mark price, predicted rate), we can still add with defaults
          // Only add if funding rate is non-zero (indicates active market)
          if (lighterRate !== 0) {
              this.logger.debug(`  ⚠️  Adding Lighter rate for ${symbol} with default values (mark price/OI unavailable)`);
            rates.push({
              exchange: ExchangeType.LIGHTER,
              symbol,
              currentRate: lighterRate,
              predictedRate: lighterRate, // Use current as predicted if we can't get predicted
              markPrice: 0, // Will be skipped in execution if needed
                openInterest: undefined, // Explicitly undefined so it shows as N/A
              volume24h: undefined, // Volume unavailable in fallback mode
              timestamp: new Date(),
            });
            }
          }
        }
      }
    } catch (error: any) {
      // Only log actual errors (not missing mappings)
      if (error.message && !error.message.includes('not found') && !error.message.includes('No funding rates')) {
        this.logger.error(`Failed to get Lighter funding rate for ${symbol}: ${error.message}`);
      }
    }

    // Get Hyperliquid funding rate
    // Use exchange-specific symbol format from mapping
    try {
      const mapping = this.getSymbolMapping(symbol);
      const hlSymbol = mapping?.hyperliquidSymbol;
      
      if (!hlSymbol) {
        // No mapping - skip silently
      } else {
        const hlRate = await this.hyperliquidProvider.getCurrentFundingRate(hlSymbol);
        const hlPredicted = await this.hyperliquidProvider.getPredictedFundingRate(hlSymbol);
        const hlMarkPrice = await this.hyperliquidProvider.getMarkPrice(hlSymbol);
        
        // OI is critical - if it fails, log error and skip
        try {
        const hlOI = await this.hyperliquidProvider.getOpenInterest(hlSymbol);

        // Try to get 24h volume
        let hlVolume: number | undefined;
        try {
          hlVolume = await this.hyperliquidProvider.get24hVolume(hlSymbol);
        } catch (volumeError) {
          hlVolume = undefined; // Volume is optional, don't fail on error
        }

        rates.push({
          exchange: ExchangeType.HYPERLIQUID,
          symbol,
          currentRate: hlRate,
          predictedRate: hlPredicted,
          markPrice: hlMarkPrice,
          openInterest: hlOI,
          volume24h: hlVolume,
          timestamp: new Date(),
        });
        } catch (oiError: any) {
          const errorMsg = oiError.message || String(oiError);
          this.logger.error(`Failed to get Hyperliquid OI for ${symbol} (${hlSymbol}): ${errorMsg}`);
          this.logger.error(`  ⚠️  Skipping Hyperliquid for ${symbol} - OI is required but unavailable`);
          // Don't add rate entry if OI is unavailable - it will show as N/A
        }
      }
    } catch (error: any) {
      // Only log actual errors (not missing mappings or OI errors which are handled above)
      if (error.message && !error.message.includes('not found') && !error.message.includes('No funding rates') && !error.message.includes('OI')) {
        this.logger.error(`Failed to get Hyperliquid funding rate for ${symbol}: ${error.message}`);
      }
    }

    // Get Extended funding rate
    if (this.extendedProvider) {
      try {
        const mapping = this.getSymbolMapping(symbol);
        const extendedSymbol = mapping?.extendedSymbol || symbol; // Fallback to normalized symbol
        
        // Try to get funding rate (Extended provider will handle symbol lookup internally)
        const extendedRate = await this.extendedProvider.getCurrentFundingRate(extendedSymbol);
        const extendedPredicted = await this.extendedProvider.getPredictedFundingRate(extendedSymbol);
        const extendedMarkPrice = await this.extendedProvider.getMarkPrice(extendedSymbol);
        
        // OI is critical - if it fails, log error and skip
        try {
          const extendedOI = await this.extendedProvider.getOpenInterest(extendedSymbol);

          rates.push({
            exchange: ExchangeType.EXTENDED,
            symbol,
            currentRate: extendedRate,
            predictedRate: extendedPredicted,
            markPrice: extendedMarkPrice,
            openInterest: extendedOI,
            volume24h: undefined, // Extended volume not yet implemented
            timestamp: new Date(),
          });
        } catch (oiError: any) {
          const errorMsg = oiError.message || String(oiError);
          this.logger.error(`Failed to get Extended OI for ${symbol}: ${errorMsg}`);
          this.logger.error(`  ⚠️  Skipping Extended for ${symbol} - OI is required but unavailable`);
          // Don't add rate entry if OI is unavailable
        }
      } catch (error: any) {
        // Only log actual errors (not missing mappings or OI errors which are handled above)
        if (error.message && !error.message.includes('not found') && !error.message.includes('No funding rates') && !error.message.includes('OI')) {
          this.logger.error(`Failed to get Extended funding rate for ${symbol}: ${error.message}`);
        }
      }
    }

    return rates;
  }

  /**
   * Compare funding rates across exchanges for a symbol
   */
  async compareFundingRates(symbol: string): Promise<FundingRateComparison> {
    const rates = await this.getFundingRates(symbol);

    if (rates.length === 0) {
      throw new Error(`No funding rates available for ${symbol}`);
    }

    const sortedRates = [...rates].sort((a, b) => b.currentRate - a.currentRate);
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
    includePerpSpot: boolean = false, // Enable perp-spot opportunity discovery
  ): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    // Create progress bar if requested
    let progressBar: cliProgress.SingleBar | null = null;
    if (showProgress) {
      progressBar = new cliProgress.SingleBar({
        format: '🔍 Searching opportunities |{bar}| {percentage}% | {value}/{total} symbols | {opportunities} opportunities found',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      });
      progressBar.start(symbols.length, 0, { opportunities: 0 });
    }

    // Process symbols in parallel batches to avoid rate limits
    // Process 5 symbols at a time with a small delay between batches
    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 1000; // 1 second between batches

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
            const supportedExchanges = comparison.rates.filter(rate => {
              if (!mapping) return false;
              switch (rate.exchange) {
                case ExchangeType.ASTER:
                  return !!mapping.asterSymbol;
                case ExchangeType.LIGHTER:
                  return mapping.lighterMarketIndex !== undefined;
                case ExchangeType.HYPERLIQUID:
                  return !!mapping.hyperliquidSymbol;
                case ExchangeType.EXTENDED:
                  return !!mapping.extendedSymbol;
                default:
                  return false;
              }
            });

            // Generate ALL profitable exchange pair combinations
            // For n exchanges, this creates up to n*(n-1) opportunities (all pairs where long ≠ short)
            for (const longExchangeRate of supportedExchanges) {
              for (const shortExchangeRate of supportedExchanges) {
                // Skip same exchange pairs
                if (longExchangeRate.exchange === shortExchangeRate.exchange) continue;

                // Calculate spread: shortRate - longRate
                // Positive spread = profitable (we receive more on short than we pay on long)
                const spreadDecimal = shortExchangeRate.currentRate - longExchangeRate.currentRate;

                // Only create opportunity if spread meets minimum threshold
                if (spreadDecimal >= minSpread) {
                  const longRate = Percentage.fromDecimal(longExchangeRate.currentRate);
                  const shortRate = Percentage.fromDecimal(shortExchangeRate.currentRate);
                  const spread = Percentage.fromDecimal(spreadDecimal);

                  // Calculate expected annualized return
                  // Funding rates are typically hourly (e.g., 0.0013% per hour ≈ 10% annualized)
                  const periodsPerDay = 24; // Hourly funding periods
                  const periodsPerYear = periodsPerDay * 365;
                  const expectedReturn = Percentage.fromDecimal(spreadDecimal * periodsPerYear);

                  symbolOpportunities.push({
                    symbol,
                    strategyType: 'perp-perp',
                    longExchange: longExchangeRate.exchange,
                    shortExchange: shortExchangeRate.exchange,
                    longRate,
                    shortRate,
                    spread,
                    expectedReturn,
                    longMarkPrice: longExchangeRate.markPrice > 0 ? longExchangeRate.markPrice : undefined,
                    shortMarkPrice: shortExchangeRate.markPrice > 0 ? shortExchangeRate.markPrice : undefined,
                    longOpenInterest: longExchangeRate.openInterest !== undefined && longExchangeRate.openInterest > 0 ? longExchangeRate.openInterest : undefined,
                    shortOpenInterest: shortExchangeRate.openInterest !== undefined && shortExchangeRate.openInterest > 0 ? shortExchangeRate.openInterest : undefined,
                    long24hVolume: longExchangeRate.volume24h !== undefined && longExchangeRate.volume24h > 0 ? longExchangeRate.volume24h : undefined,
                    short24hVolume: shortExchangeRate.volume24h !== undefined && shortExchangeRate.volume24h > 0 ? shortExchangeRate.volume24h : undefined,
                    timestamp: new Date(),
                  });
                }
              }
            }


            return symbolOpportunities;
          } catch (error: any) {
            // Only log actual errors (not expected failures like missing data)
            if (error.message && !error.message.includes('No funding rates')) {
              this.logger.error(`Failed to find opportunities for ${symbol}: ${error.message}`);
            }
            return [];
          }
        })
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
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    // Complete progress bar
    if (progressBar) {
      progressBar.update(symbols.length, { opportunities: opportunities.length });
      progressBar.stop();
    }

    // Add perp-spot opportunities if enabled
    if (includePerpSpot) {
      try {
        const perpSpotOpportunities = await this.findPerpSpotOpportunities(symbols, minSpread, showProgress);
        opportunities.push(...perpSpotOpportunities);
      } catch (error: any) {
        this.logger.error(`Failed to find perp-spot opportunities: ${error.message}`);
        // Continue with perp-perp opportunities only
      }
    }

    // Sort by expected return (highest first)
    return opportunities.sort((a, b) => 
      b.expectedReturn.toAPY() - a.expectedReturn.toAPY()
    );
  }

  /**
   * Find perp-spot delta-neutral arbitrage opportunities
   * For each exchange that supports both perp and spot:
   * - If funding is positive: Long spot + Short perp (receive funding)
   * - If funding is negative: Short spot + Long perp (receive funding)
   */
  async findPerpSpotOpportunities(
    symbols: string[],
    minSpread: number = 0.0001,
    showProgress: boolean = true,
  ): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    // Create progress bar if requested
    let progressBar: cliProgress.SingleBar | null = null;
    if (showProgress) {
      progressBar = new cliProgress.SingleBar({
        format: '🔍 Searching perp-spot opportunities |{bar}| {percentage}% | {value}/{total} symbols | {opportunities} opportunities found',
        barCompleteChar: '\u2588',
        barIncompleteChar: '\u2591',
        hideCursor: true,
      });
      progressBar.start(symbols.length, 0, { opportunities: 0 });
    }

    // Process symbols in batches
    const BATCH_SIZE = 5;
    const BATCH_DELAY_MS = 1000;

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);
      
      const batchResults = await Promise.allSettled(
        batch.map(async (symbol) => {
          try {
            const comparison = await this.compareFundingRates(symbol);
            const symbolOpportunities: ArbitrageOpportunity[] = [];

            // For each exchange, check if it supports both perp and spot
            // Exchanges that support spot: Hyperliquid, Aster (verify others)
            const exchangesWithSpot = [
              ExchangeType.HYPERLIQUID,
              ExchangeType.ASTER,
              // Lighter and Extended may not support spot - verify
            ];

            for (const rate of comparison.rates) {
              // Check if this exchange supports spot trading
              if (!exchangesWithSpot.includes(rate.exchange)) {
                continue; // Skip exchanges without spot support
              }

              const perpRate = rate.currentRate;
              const spotRate = 0; // Spot doesn't pay funding

              // Calculate spread = |perpRate - spotRate| = |perpRate|
              const spreadDecimal = Math.abs(perpRate);

              // Only create opportunity if spread meets minimum threshold
              if (spreadDecimal >= minSpread) {
                const perpRatePercent = Percentage.fromDecimal(perpRate);
                const spotRatePercent = Percentage.fromDecimal(spotRate);
                const spread = Percentage.fromDecimal(spreadDecimal);

                // Calculate expected annualized return
                const periodsPerDay = 24; // Hourly funding periods
                const periodsPerYear = periodsPerDay * 365;
                const expectedReturn = Percentage.fromDecimal(spreadDecimal * periodsPerYear);

                symbolOpportunities.push({
                  symbol,
                  strategyType: 'perp-spot',
                  longExchange: rate.exchange, // Perp exchange
                  spotExchange: rate.exchange, // Same exchange for spot
                  longRate: perpRatePercent,
                  shortRate: spotRatePercent, // Spot rate is 0%
                  spread,
                  expectedReturn,
                  longMarkPrice: rate.markPrice > 0 ? rate.markPrice : undefined,
                  longOpenInterest: rate.openInterest !== undefined && rate.openInterest > 0 ? rate.openInterest : undefined,
                  long24hVolume: rate.volume24h !== undefined && rate.volume24h > 0 ? rate.volume24h : undefined,
                  timestamp: new Date(),
                });
              }
            }

            return symbolOpportunities;
          } catch (error: any) {
            if (error.message && !error.message.includes('No funding rates')) {
              this.logger.error(`Failed to find perp-spot opportunities for ${symbol}: ${error.message}`);
            }
            return [];
          }
        })
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
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    // Complete progress bar
    if (progressBar) {
      progressBar.update(symbols.length, { opportunities: opportunities.length });
      progressBar.stop();
    }

    return opportunities;
  }
}
