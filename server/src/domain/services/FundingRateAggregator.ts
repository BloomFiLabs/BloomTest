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
  longExchange: ExchangeType; // Exchange to go long on (receives funding)
  shortExchange: ExchangeType; // Exchange to go short on (receives funding)
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

            // CORRECT LOGIC FOR FUNDING RATE ARBITRAGE (handles ALL cases):
            // - LONG position: negative funding rate = we RECEIVE funding (profit)
            // - SHORT position: positive funding rate = we RECEIVE funding (profit)
            // 
            // Cases we capture:
            // 1. Both negative: LONG on lowest (most negative), SHORT on highest negative (least negative)
            //    Example: -0.02% (LONG) vs -0.01% (SHORT) → spread = -0.01% - (-0.02%) = 0.01%
            // 2. Both positive: LONG on lowest positive (least positive), SHORT on highest (most positive)
            //    Example: 0.01% (LONG) vs 0.02% (SHORT) → spread = 0.02% - 0.01% = 0.01%
            // 3. Mixed signs: LONG on lowest (negative), SHORT on highest (positive)
            //    Example: -0.02% (LONG) vs 0.01% (SHORT) → spread = 0.01% - (-0.02%) = 0.03%
            //
            // Always: LONG on LOWEST rate, SHORT on HIGHEST rate
            // Spread = shortRate - longRate (always positive when there's a difference)

            // Find best long opportunity (LOWEST rate overall - most negative = we receive funding)
            const bestLong = comparison.rates.reduce((best, current) => 
              current.currentRate < (best?.currentRate ?? Infinity) ? current : best
            , null as ExchangeFundingRate | null);

            // Find best short opportunity (HIGHEST rate overall - most positive = we receive funding)
            const bestShort = comparison.rates.reduce((best, current) => 
              current.currentRate > (best?.currentRate ?? -Infinity) ? current : best
            , null as ExchangeFundingRate | null);

            // If we have both long and short opportunities on different exchanges, create arbitrage
            // This works for ALL cases: both negative, both positive, or mixed signs
            if (bestLong && bestShort && bestLong.exchange !== bestShort.exchange) {
              // Validate that both exchanges actually support this symbol for trading
              const mapping = this.getSymbolMapping(symbol);
              const longSymbolSupported = mapping && (
                (bestLong.exchange === ExchangeType.ASTER && mapping.asterSymbol) ||
                (bestLong.exchange === ExchangeType.LIGHTER && mapping.lighterMarketIndex !== undefined) ||
                (bestLong.exchange === ExchangeType.HYPERLIQUID && mapping.hyperliquidSymbol)
              );
              const shortSymbolSupported = mapping && (
                (bestShort.exchange === ExchangeType.ASTER && mapping.asterSymbol) ||
                (bestShort.exchange === ExchangeType.LIGHTER && mapping.lighterMarketIndex !== undefined) ||
                (bestShort.exchange === ExchangeType.HYPERLIQUID && mapping.hyperliquidSymbol)
              );

              if (!longSymbolSupported || !shortSymbolSupported) {
                // Skip this opportunity - one or both exchanges don't support trading this symbol
                // (even though they may have funding rate data)
                this.logger.debug(
                  `Skipping ${symbol} opportunity: ${bestLong.exchange} supported=${!!longSymbolSupported}, ${bestShort.exchange} supported=${!!shortSymbolSupported}`
                );
                return [];
              }

              const longRate = Percentage.fromDecimal(bestLong.currentRate);
              const shortRate = Percentage.fromDecimal(bestShort.currentRate);
              // Spread = shortRate - longRate (positive when profitable)
              // Examples:
              //   Both negative: -0.01% - (-0.02%) = 0.01% ✓
              //   Both positive: 0.02% - 0.01% = 0.01% ✓
              //   Mixed: 0.01% - (-0.02%) = 0.03% ✓
              const spread = shortRate.subtract(longRate);
              
              // Only create opportunity if spread is positive and meets minimum threshold
              if (spread.toDecimal() >= minSpread) {
                // Calculate expected annualized return
                // Funding rates are typically hourly (e.g., 0.0013% per hour ≈ 10% annualized)
                const periodsPerDay = 24; // Hourly funding periods
                const periodsPerYear = periodsPerDay * 365;
                const expectedReturn = Percentage.fromDecimal(spread.toDecimal() * periodsPerYear);

                symbolOpportunities.push({
                  symbol,
                  longExchange: bestLong.exchange, // Exchange with LOWEST rate (most negative)
                  shortExchange: bestShort.exchange, // Exchange with HIGHEST rate (most positive)
                  longRate,
                  shortRate,
                  spread: Percentage.fromDecimal(spread.toDecimal()), // Already positive when profitable
                  expectedReturn,
                  longMarkPrice: bestLong.markPrice > 0 ? bestLong.markPrice : undefined,
                  shortMarkPrice: bestShort.markPrice > 0 ? bestShort.markPrice : undefined,
                  longOpenInterest: bestLong.openInterest !== undefined && bestLong.openInterest > 0 ? bestLong.openInterest : undefined,
                  shortOpenInterest: bestShort.openInterest !== undefined && bestShort.openInterest > 0 ? bestShort.openInterest : undefined,
                  long24hVolume: bestLong.volume24h !== undefined && bestLong.volume24h > 0 ? bestLong.volume24h : undefined,
                  short24hVolume: bestShort.volume24h !== undefined && bestShort.volume24h > 0 ? bestShort.volume24h : undefined,
                  timestamp: new Date(),
                });
              }
            }

            // Also check for simple spread arbitrage (long on highest, short on lowest)
            if (comparison.highestRate && comparison.lowestRate && 
                comparison.highestRate.exchange !== comparison.lowestRate.exchange) {
              // Validate that both exchanges actually support this symbol for trading
              const mapping = this.getSymbolMapping(symbol);
              const highestSymbolSupported = mapping && (
                (comparison.highestRate.exchange === ExchangeType.ASTER && mapping.asterSymbol) ||
                (comparison.highestRate.exchange === ExchangeType.LIGHTER && mapping.lighterMarketIndex !== undefined) ||
                (comparison.highestRate.exchange === ExchangeType.HYPERLIQUID && mapping.hyperliquidSymbol)
              );
              const lowestSymbolSupported = mapping && (
                (comparison.lowestRate.exchange === ExchangeType.ASTER && mapping.asterSymbol) ||
                (comparison.lowestRate.exchange === ExchangeType.LIGHTER && mapping.lighterMarketIndex !== undefined) ||
                (comparison.lowestRate.exchange === ExchangeType.HYPERLIQUID && mapping.hyperliquidSymbol)
              );

              if (!highestSymbolSupported || !lowestSymbolSupported) {
                // Skip this opportunity - one or both exchanges don't support trading this symbol
                this.logger.debug(
                  `Skipping ${symbol} spread opportunity: ${comparison.highestRate.exchange} supported=${!!highestSymbolSupported}, ${comparison.lowestRate.exchange} supported=${!!lowestSymbolSupported}`
                );
                return [];
              }

              const longRate = Percentage.fromDecimal(comparison.highestRate.currentRate);
              const shortRate = Percentage.fromDecimal(comparison.lowestRate.currentRate);
              const spread = longRate.subtract(shortRate);
              
              if (spread.toDecimal() >= minSpread) {
                // Funding rates are typically hourly
                const periodsPerDay = 24; // Hourly funding periods
                const periodsPerYear = periodsPerDay * 365;
                const expectedReturn = Percentage.fromDecimal(spread.toDecimal() * periodsPerYear);

                const highestRate = comparison.highestRate;
                const lowestRate = comparison.lowestRate;
                const highestMarkPrice = highestRate.markPrice > 0 ? highestRate.markPrice : undefined;
                const lowestMarkPrice = lowestRate.markPrice > 0 ? lowestRate.markPrice : undefined;

                symbolOpportunities.push({
                  symbol,
                  longExchange: highestRate.exchange,
                  shortExchange: lowestRate.exchange,
                  longRate,
                  shortRate,
                  spread: Percentage.fromDecimal(Math.abs(spread.toDecimal())),
                  expectedReturn,
                  longMarkPrice: highestMarkPrice,
                  shortMarkPrice: lowestMarkPrice,
                  longOpenInterest: highestRate.openInterest !== undefined && highestRate.openInterest > 0 ? highestRate.openInterest : undefined,
                  shortOpenInterest: lowestRate.openInterest !== undefined && lowestRate.openInterest > 0 ? lowestRate.openInterest : undefined,
                  long24hVolume: highestRate.volume24h !== undefined && highestRate.volume24h > 0 ? highestRate.volume24h : undefined,
                  short24hVolume: lowestRate.volume24h !== undefined && lowestRate.volume24h > 0 ? lowestRate.volume24h : undefined,
                  timestamp: new Date(),
                });
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

    // Sort by expected return (highest first)
    return opportunities.sort((a, b) => 
      b.expectedReturn.toAPY() - a.expectedReturn.toAPY()
    );
  }
}
