import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { PerpKeeperOrchestrator } from '../../domain/services/PerpKeeperOrchestrator';
import { ConfigService } from '@nestjs/config';
import { PerpKeeperPerformanceLogger } from '../../infrastructure/logging/PerpKeeperPerformanceLogger';
import { PerpKeeperService } from './PerpKeeperService';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { PerpOrderRequest, OrderSide, OrderType, TimeInForce, OrderStatus } from '../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../domain/entities/PerpPosition';
import { Contract, JsonRpcProvider, Wallet, formatUnits } from 'ethers';
import { ArbitrageOpportunity } from '../../domain/services/FundingRateAggregator';
import * as cliProgress from 'cli-progress';

/**
 * PerpKeeperScheduler - Scheduled execution for funding rate arbitrage
 * 
 * Executes hourly at funding rate clock (typically :00 minutes)
 * Also runs immediately on startup
 */
@Injectable()
export class PerpKeeperScheduler implements OnModuleInit {
  private readonly logger = new Logger(PerpKeeperScheduler.name);
  private symbols: string[] = []; // Will be populated by auto-discovery or configuration
  private readonly blacklistedSymbols: Set<string>; // Symbols to exclude from trading
  private readonly minSpread: number;
  private readonly maxPositionSizeUsd: number;
  private isRunning = false;
  private lastDiscoveryTime: number = 0;
  private readonly DISCOVERY_CACHE_TTL = 3600000; // 1 hour cache

  // Single-leg retry tracking: track retry attempts for opening missing side
  private readonly singleLegRetries: Map<
    string, // key: `${symbol}-${longExchange}-${shortExchange}`
    {
      retryCount: number;
      longExchange: ExchangeType;
      shortExchange: ExchangeType;
      lastRetryTime: Date;
    }
  > = new Map();

  // Filtered opportunities: opportunities that failed after 5 retries
  private readonly filteredOpportunities: Set<string> = new Set(); // key: `${symbol}-${longExchange}-${shortExchange}`

  constructor(
    private readonly orchestrator: PerpKeeperOrchestrator,
    private readonly configService: ConfigService,
    private readonly performanceLogger: PerpKeeperPerformanceLogger,
    private readonly keeperService: PerpKeeperService,
  ) {
    // Initialize orchestrator with exchange adapters
    const adapters = this.keeperService.getExchangeAdapters();
    this.orchestrator.initialize(adapters);
    this.logger.log(`Orchestrator initialized with ${adapters.size} exchange adapters`);

    // Load blacklisted symbols from environment variable
    // Normalize symbols (remove USDT/USDC suffixes) to match how symbols are normalized elsewhere
    const normalizeSymbol = (symbol: string): string => {
      return symbol
        .trim()
        .toUpperCase()
        .replace('USDT', '')
        .replace('USDC', '')
        .replace('-PERP', '')
        .replace('PERP', '');
    };

    const blacklistEnv = this.configService.get<string>('KEEPER_BLACKLISTED_SYMBOLS');
    if (blacklistEnv) {
      // Split by comma and filter out empty strings, then normalize
      const blacklistArray = blacklistEnv
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(s => normalizeSymbol(s));
      
      this.blacklistedSymbols = new Set(blacklistArray);
      this.logger.log(
        `✅ Blacklisted symbols loaded: ${Array.from(this.blacklistedSymbols).join(', ')} (from env: "${blacklistEnv}")`
      );
      
      // Debug: Log if NVDA should be blacklisted
      if (this.blacklistedSymbols.has('NVDA')) {
        this.logger.log(`✅ NVDA is in blacklist - will be filtered`);
      } else {
        this.logger.warn(`⚠️ NVDA is NOT in blacklist! Current blacklist: ${Array.from(this.blacklistedSymbols).join(', ')}`);
      }
    } else {
      // Default blacklist: NVDA (experimental market)
      this.blacklistedSymbols = new Set(['NVDA']);
      this.logger.log(
        `Using default blacklist: ${Array.from(this.blacklistedSymbols).join(', ')}`
      );
    }

    // Load configuration
    const symbolsEnv = this.configService.get<string>('KEEPER_SYMBOLS');
    // If KEEPER_SYMBOLS is explicitly set, use it; otherwise auto-discover
    if (symbolsEnv) {
      // Normalize symbols helper (defined above)
      const normalizeSymbol = (symbol: string): string => {
        return symbol
          .trim()
          .toUpperCase()
          .replace('USDT', '')
          .replace('USDC', '')
          .replace('-PERP', '')
          .replace('PERP', '');
      };
      this.symbols = symbolsEnv.split(',').map(s => s.trim()).filter(s => {
        const normalized = normalizeSymbol(s);
        return !this.blacklistedSymbols.has(normalized);
      });
      this.logger.log(
        `Scheduler initialized with configured symbols: ${this.symbols.join(',')}`
      );
      if (symbolsEnv.split(',').length !== this.symbols.length) {
        const normalizeSymbol = (symbol: string): string => {
          return symbol
            .trim()
            .toUpperCase()
            .replace('USDT', '')
            .replace('USDC', '')
            .replace('-PERP', '')
            .replace('PERP', '');
        };
        const filtered = symbolsEnv.split(',').map(s => s.trim()).filter(s => {
          const normalized = normalizeSymbol(s);
          return this.blacklistedSymbols.has(normalized);
        });
        this.logger.warn(
          `Filtered out blacklisted symbols from KEEPER_SYMBOLS: ${filtered.join(', ')}`
        );
      }
    } else {
      this.logger.log(
        `Scheduler initialized - will auto-discover all assets on first run (excluding blacklisted symbols)`
      );
    }
    
    this.minSpread = parseFloat(this.configService.get<string>('KEEPER_MIN_SPREAD') || '0.0001');
    this.maxPositionSizeUsd = parseFloat(
      this.configService.get<string>('KEEPER_MAX_POSITION_SIZE_USD') || '10000',
    );

    this.logger.log(
      `Configuration: minSpread=${this.minSpread}, maxPositionSize=${this.maxPositionSizeUsd}`
    );
  }

  /**
   * Detect single-leg positions (positions without a matching pair on another exchange)
   * A single-leg position is one where we have LONG on one exchange but no SHORT on another,
   * or SHORT on one exchange but no LONG on another.
   */
  private detectSingleLegPositions(positions: PerpPosition[]): PerpPosition[] {
    if (positions.length === 0) {
      return [];
    }

    // Group positions by symbol
    const positionsBySymbol = new Map<string, PerpPosition[]>();
    for (const position of positions) {
      if (!positionsBySymbol.has(position.symbol)) {
        positionsBySymbol.set(position.symbol, []);
      }
      positionsBySymbol.get(position.symbol)!.push(position);
    }

    const singleLegPositions: PerpPosition[] = [];

    for (const [symbol, symbolPositions] of positionsBySymbol) {
      // For arbitrage, we need both LONG and SHORT positions on DIFFERENT exchanges
      const longPositions = symbolPositions.filter((p) => p.side === OrderSide.LONG);
      const shortPositions = symbolPositions.filter((p) => p.side === OrderSide.SHORT);

      // Check if we have both LONG and SHORT on different exchanges
      const hasLongOnDifferentExchange = longPositions.some(
        (longPos) =>
          !shortPositions.some(
            (shortPos) => shortPos.exchangeType === longPos.exchangeType,
          ),
      );
      const hasShortOnDifferentExchange = shortPositions.some(
        (shortPos) =>
          !longPositions.some(
            (longPos) => longPos.exchangeType === shortPos.exchangeType,
          ),
      );

      // If we have LONG but no SHORT on a different exchange, all LONG positions are single-leg
      if (longPositions.length > 0 && !hasShortOnDifferentExchange) {
        this.logger.warn(
          `⚠️ Single-leg LONG position(s) detected for ${symbol}: ` +
            `Found ${longPositions.length} LONG position(s) but no SHORT position on different exchange. ` +
            `These positions have price exposure and should be closed.`,
        );
        singleLegPositions.push(...longPositions);
      }

      // If we have SHORT but no LONG on a different exchange, all SHORT positions are single-leg
      if (shortPositions.length > 0 && !hasLongOnDifferentExchange) {
        this.logger.warn(
          `⚠️ Single-leg SHORT position(s) detected for ${symbol}: ` +
            `Found ${shortPositions.length} SHORT position(s) but no LONG position on different exchange. ` +
            `These positions have price exposure and should be closed.`,
        );
        singleLegPositions.push(...shortPositions);
      }

      // Edge case: If we have LONG and SHORT but they're on the SAME exchange, they're not arbitrage pairs
      // This is also a single-leg scenario (both legs on same exchange = no arbitrage)
      if (
        longPositions.length > 0 &&
        shortPositions.length > 0 &&
        longPositions.every((longPos) =>
          shortPositions.some(
            (shortPos) => shortPos.exchangeType === longPos.exchangeType,
          ),
        )
      ) {
        this.logger.warn(
          `⚠️ Positions for ${symbol} are on the same exchange(s) - not arbitrage pairs. ` +
            `Both LONG and SHORT positions are single-leg (no cross-exchange arbitrage).`,
        );
        singleLegPositions.push(...symbolPositions);
      }
    }

    return singleLegPositions;
  }

  /**
   * Run immediately on module initialization (startup)
   */
  async onModuleInit() {
    // Wait a bit for other services to initialize
    setTimeout(async () => {
      this.logger.log('🚀 Starting initial arbitrage opportunity check on startup...');
      await this.executeHourly();
    }, 2000); // 2 second delay to ensure all services are ready
  }

  /**
   * Normalize symbol for blacklist checking (matches FundingRateAggregator normalization)
   */
  private normalizeSymbolForBlacklist(symbol: string): string {
    return symbol
      .toUpperCase()
      .replace('USDT', '')
      .replace('USDC', '')
      .replace('-PERP', '')
      .replace('PERP', '');
  }

  /**
   * Check if a symbol is blacklisted
   */
  private isBlacklisted(symbol: string): boolean {
    const normalized = this.normalizeSymbolForBlacklist(symbol);
    return this.blacklistedSymbols.has(normalized);
  }

  /**
   * Discover all common assets across exchanges (with caching)
   */
  private async discoverAssetsIfNeeded(): Promise<string[]> {
    const now = Date.now();
    
    // Use cache if available and fresh
    if (this.symbols.length > 0 && (now - this.lastDiscoveryTime) < this.DISCOVERY_CACHE_TTL) {
      // Still filter blacklisted symbols from cache (defensive)
      const filtered = this.symbols.filter(s => !this.isBlacklisted(s));
      if (filtered.length !== this.symbols.length) {
        const removed = this.symbols.filter(s => this.isBlacklisted(s));
        this.logger.warn(`Filtered ${removed.length} blacklisted symbols from cache: ${removed.join(', ')}`);
        this.symbols = filtered;
      }
      return this.symbols;
    }

    // Auto-discover all assets
    try {
      this.logger.log('Auto-discovering all available assets across exchanges...');
      const discoveredSymbols = await this.orchestrator.discoverCommonAssets();
      
      // Filter out blacklisted symbols using normalized comparison
      this.symbols = discoveredSymbols.filter(s => !this.isBlacklisted(s));
      this.lastDiscoveryTime = now;
      
      const filteredCount = discoveredSymbols.length - this.symbols.length;
      if (filteredCount > 0) {
        const filtered = discoveredSymbols.filter(s => this.isBlacklisted(s));
        this.logger.log(
          `Auto-discovery complete: Found ${discoveredSymbols.length} common assets, ` +
          `filtered out ${filteredCount} blacklisted: ${filtered.join(', ')}`
        );
      } else {
        this.logger.log(
          `Auto-discovery complete: Found ${this.symbols.length} common assets: ${this.symbols.join(', ')}`
        );
      }
      return this.symbols;
    } catch (error: any) {
      this.logger.error(`Asset discovery failed: ${error.message}`);
      // Fallback to defaults if discovery fails
      if (this.symbols.length === 0) {
        this.symbols = ['ETH', 'BTC'];
        this.logger.warn(`Using fallback symbols: ${this.symbols.join(', ')}`);
      }
      return this.symbols;
    }
  }

  /**
   * Get next funding rate payment time
   * Hyperliquid (and most exchanges) pay funding every hour on the hour (14:00, 15:00, 16:00, etc.)
   * This computes the next payment time based on the global clock hour
   */
  private getNextFundingPaymentTime(): Date {
    const now = new Date();
    const nextPayment = new Date(now);
    
    // Set to next hour at :00:00
    nextPayment.setHours(now.getHours() + 1, 0, 0, 0);
    
    return nextPayment;
  }

  /**
   * Execute at funding rate payment times
   * Hyperliquid (and most exchanges) pay funding every hour on the hour (14:00, 15:00, 16:00, etc.)
   * This cron runs at :00 of every hour to align with actual funding payments
   * 
   * Cron format: '0 * * * *' = every hour at :00 minutes
   */
  @Cron('0 * * * *') // Every hour at :00 (e.g., 14:00, 15:00, 16:00)
  async executeHourly() {
    const nextPayment = this.getNextFundingPaymentTime();
    const msUntilPayment = nextPayment.getTime() - Date.now();
    const minutesUntil = Math.floor(msUntilPayment / 1000 / 60);
    const secondsUntil = Math.floor((msUntilPayment / 1000) % 60);
    
    this.logger.log(
      `⏰ Funding payment scheduled for ${nextPayment.toISOString()} ` +
      `(${minutesUntil}m ${secondsUntil}s from now)`
    );
    if (this.isRunning) {
      this.logger.warn('Previous execution still running, skipping this cycle');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      this.logger.log('Starting hourly funding rate arbitrage execution...');

      // Auto-discover all assets if not configured
      const symbols = await this.discoverAssetsIfNeeded();
      
      if (symbols.length === 0) {
        this.logger.warn('No assets found to compare, skipping execution');
        return;
      }

      // Check balances before proceeding
      await this.checkBalances();

      // Health check
      const healthCheck = await this.orchestrator.healthCheck();
      if (!healthCheck.healthy) {
        this.logger.warn('Exchanges not healthy, skipping execution');
        return;
      }

      // Filter out blacklisted symbols before finding opportunities (defensive check)
      const filteredSymbols = symbols.filter(s => !this.isBlacklisted(s));
      if (filteredSymbols.length !== symbols.length) {
        const filtered = symbols.filter(s => this.isBlacklisted(s));
        this.logger.warn(
          `⚠️ Filtered out ${filtered.length} blacklisted symbols before opportunity search: ${filtered.join(', ')}`
        );
      }

      // Find opportunities across ALL discovered assets (with progress bar)
      this.logger.log(`🔍 Searching for arbitrage opportunities across ${filteredSymbols.length} assets...`);
      const opportunities = await this.orchestrator.findArbitrageOpportunities(
        filteredSymbols,
        this.minSpread,
        true, // Show progress bar
      );

      // Filter out any opportunities for blacklisted symbols (defensive check)
      const filteredOpportunities = opportunities.filter(
        opp => !this.isBlacklisted(opp.symbol)
      );
      if (filteredOpportunities.length !== opportunities.length) {
        const filtered = opportunities.filter(opp => this.isBlacklisted(opp.symbol));
        const filteredSymbolsList = [...new Set(filtered.map(opp => opp.symbol))];
        this.logger.warn(
          `⚠️ Filtered out ${filtered.length} opportunities for blacklisted symbols: ${filteredSymbolsList.join(', ')}`
        );
        // Debug: Log blacklist status
        this.logger.log(
          `🔍 Blacklist check: Current blacklist contains: ${Array.from(this.blacklistedSymbols).join(', ')}`
        );
        filteredSymbolsList.forEach(symbol => {
          const normalized = this.normalizeSymbolForBlacklist(symbol);
          this.logger.log(
            `🔍 Symbol "${symbol}" normalized to "${normalized}", blacklisted: ${this.blacklistedSymbols.has(normalized)}`
          );
        });
      }

      this.logger.log(`Found ${filteredOpportunities.length} arbitrage opportunities (after blacklist filter)`);

      // STEP 1: Close all existing positions to free up margin for rebalancing
      // This ensures we can use locked margin when rebalancing funds
      try {
        this.logger.log('🔍 Checking for existing positions to close before rebalancing...');
        const positionsResult = await this.orchestrator.getAllPositionsWithMetrics();
        const allPositions = positionsResult.positions;
        if (allPositions.length > 0) {
          // CRITICAL: Detect single-leg positions first (positions without matching pair on another exchange)
          const singleLegPositions = this.detectSingleLegPositions(allPositions);
          if (singleLegPositions.length > 0) {
            this.logger.warn(
              `⚠️ Detected ${singleLegPositions.length} single-leg position(s). Attempting to open missing side...`,
            );
            
            // Try to open missing side for each single-leg position
            for (const position of singleLegPositions) {
              const retrySuccess = await this.tryOpenMissingSide(position);
              
              if (!retrySuccess) {
                // Retries failed - close the position
                this.logger.error(
                  `🚨 Closing single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType} ` +
                  `after retry attempts failed`,
                );
                await this.closeSingleLegPosition(position);
              }
            }
            
            // Refresh positions after retry attempts
            const updatedPositionsResult = await this.orchestrator.getAllPositionsWithMetrics();
            const updatedPositions = updatedPositionsResult.positions;
            const stillSingleLeg = this.detectSingleLegPositions(updatedPositions);
            
            if (stillSingleLeg.length > 0) {
              this.logger.error(
                `🚨 Still have ${stillSingleLeg.length} single-leg position(s) after retries. Closing them...`,
              );
              // Close remaining single-leg positions with progressive price improvement
              for (const position of stillSingleLeg) {
                await this.closeSingleLegPosition(position);
              }
            }
            
            // Remove single-leg positions from allPositions to avoid double-closing
            const singleLegSet = new Set(singleLegPositions.map(p => `${p.symbol}-${p.exchangeType}-${p.side}`));
            const remainingPositions = allPositions.filter(
              p => !singleLegSet.has(`${p.symbol}-${p.exchangeType}-${p.side}`)
            );
            allPositions.length = 0;
            allPositions.push(...remainingPositions);
          }
          
          // Close remaining positions (non-single-leg) with progressive price improvement
          if (allPositions.length > 0) {
            this.logger.log(`🔄 Closing ${allPositions.length} existing position(s) to free up margin...`);
            for (const position of allPositions) {
              await this.closePositionWithRetry(position);
            }
          }
          
          // Wait for positions to settle and margin to be freed
          this.logger.log('⏳ Waiting 2 seconds for positions to settle and margin to be freed...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          this.logger.log('✅ No existing positions to close');
        }
      } catch (error: any) {
        this.logger.warn(`Failed to close existing positions: ${error.message}`);
        // Continue anyway - rebalancing might still work
      }

      // STEP 2: Rebalance exchange balances based on opportunities
      // Move funds from exchanges without opportunities to exchanges with opportunities
      try {
        this.logger.log('🔄 Rebalancing exchange balances based on opportunities...');
        const rebalanceResult = await this.keeperService.rebalanceExchangeBalances(filteredOpportunities);
        if (rebalanceResult.transfersExecuted > 0) {
          this.logger.log(
            `✅ Rebalanced ${rebalanceResult.transfersExecuted} transfers, ` +
            `$${rebalanceResult.totalTransferred.toFixed(2)} total transferred ` +
            `(moved funds from inactive exchanges to active ones)`
          );
          if (rebalanceResult.errors.length > 0) {
            this.logger.warn(`⚠️ Rebalancing had ${rebalanceResult.errors.length} errors`);
          }
          
          // Wait a bit for transfers to settle before executing trades
          this.logger.log('⏳ Waiting 3 seconds for transfers to settle...');
          await new Promise(resolve => setTimeout(resolve, 3000));
        } else {
          this.logger.log('✅ Exchange balances are balanced, no rebalancing needed');
        }
      } catch (error: any) {
        this.logger.warn(`Failed to rebalance exchange balances: ${error.message}`);
        // Don't fail the entire execution if rebalancing fails
      }

      if (filteredOpportunities.length === 0) {
        this.logger.log('No opportunities found (after blacklist filter), skipping execution');
        return;
      }

      // Execute strategy across filtered assets (defensive: filter symbols again)
      const symbolsToExecute = filteredSymbols.filter(s => !this.isBlacklisted(s));
      this.logger.log(`Executing strategy with ${symbolsToExecute.length} symbols (blacklist applied)`);
      const result = await this.orchestrator.executeArbitrageStrategy(
        symbolsToExecute,
        this.minSpread,
        this.maxPositionSizeUsd,
      );

      // Track arbitrage opportunities
      this.performanceLogger.recordArbitrageOpportunity(true, result.opportunitiesExecuted > 0);
      if (result.opportunitiesExecuted > 0) {
        this.performanceLogger.recordArbitrageOpportunity(false, true);
      }

      // Update position metrics with current funding rates
      await this.updatePerformanceMetrics();

      const duration = Date.now() - startTime;

      this.logger.log(
        `Execution completed in ${duration}ms: ` +
        `${result.opportunitiesExecuted}/${result.opportunitiesEvaluated} opportunities executed, ` +
        `Expected return: $${result.totalExpectedReturn.toFixed(2)}, ` +
        `Orders placed: ${result.ordersPlaced}`,
      );

        const positionsResult = await this.orchestrator.getAllPositionsWithMetrics();

      if (result.errors.length > 0) {
        this.logger.warn(`Execution had ${result.errors.length} errors:`, result.errors);
      }
    } catch (error: any) {
      this.logger.error(`Hourly execution failed: ${error.message}`, error.stack);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Update performance metrics with current positions and funding rates
   */
  private async updatePerformanceMetrics(): Promise<void> {
    try {
      const positions = await this.keeperService.getAllPositions();
      
      // Only get funding rates for symbols that have positions (not all discovered symbols)
      // This prevents excessive API calls that cause rate limiting
      const symbolsWithPositions = new Set(positions.map(p => p.symbol));
      const allFundingRates: Array<{ symbol: string; exchange: ExchangeType; fundingRate: number }> = [];
      
      // Only fetch funding rates for symbols with active positions
      for (const symbol of symbolsWithPositions) {
        try {
          const comparison = await this.orchestrator.compareFundingRates(symbol);
          if (comparison && comparison.rates) {
            // Flatten funding rates from comparison
            for (const rate of comparison.rates) {
              allFundingRates.push({
                symbol: rate.symbol,
                exchange: rate.exchange,
                fundingRate: rate.currentRate, // Use currentRate from ExchangeFundingRate
              });
            }
          }
        } catch (error) {
          // Skip if we can't get funding rates for this symbol
        }
      }

      // Group positions by exchange
      const positionsByExchange = new Map();
      for (const position of positions) {
        const exchangePositions = positionsByExchange.get(position.exchangeType) || [];
        exchangePositions.push(position);
        positionsByExchange.set(position.exchangeType, exchangePositions);
      }

      // Update metrics for each exchange
      for (const [exchange, exchangePositions] of positionsByExchange.entries()) {
        // Filter funding rates for this exchange
        const exchangeFundingRates = allFundingRates.filter(
          (rate) => rate.exchange === exchange
        );
        this.performanceLogger.updatePositionMetrics(exchange, exchangePositions, exchangeFundingRates);
      }
    } catch (error: any) {
      this.logger.error(`Failed to update performance metrics: ${error.message}`);
    }
  }

  /**
   * Log comprehensive performance metrics every 5 minutes
   */
  @Interval(5 * 60 * 1000) // Every 5 minutes
  async logPerformanceMetrics() {
    try {
      await this.updatePerformanceMetrics();
      
      // Get total capital deployed (sum of all balances)
      let totalCapital = 0;
      for (const exchangeType of ['ASTER', 'LIGHTER', 'HYPERLIQUID'] as any[]) {
        try {
          const balance = await this.keeperService.getBalance(exchangeType);
          totalCapital += balance;
        } catch (error) {
          // Skip if we can't get balance
        }
      }

      this.performanceLogger.logPerformanceMetrics(totalCapital);
    } catch (error: any) {
      this.logger.error(`Failed to log performance metrics: ${error.message}`);
    }
  }

  /**
   * Log compact performance summary every minute
   */
  @Interval(60 * 1000) // Every minute
  async logCompactSummary() {
    try {
      // Update metrics first to ensure we have current data
      await this.updatePerformanceMetrics();
      
      // Check for single-leg positions and try to open missing side
      await this.checkAndRetrySingleLegPositions();
      
      // Get total capital deployed
      let totalCapital = 0;
      for (const exchangeType of ['ASTER', 'LIGHTER', 'HYPERLIQUID'] as any[]) {
        try {
          const balance = await this.keeperService.getBalance(exchangeType);
          totalCapital += balance;
        } catch (error) {
          // Skip if we can't get balance
        }
      }

      this.performanceLogger.logCompactSummary(totalCapital);
    } catch (error: any) {
      // Silently fail for compact summary to avoid spam
      this.logger.debug(`Failed to log compact summary: ${error.message}`);
    }
  }

  /**
   * Check for single-leg positions and try to open missing side
   * Called periodically to handle single-leg positions detected outside of execution cycle
   * Closes positions immediately if retries fail (instead of waiting for next execution cycle)
   */
  private async checkAndRetrySingleLegPositions(): Promise<void> {
    try {
      const positionsResult = await this.orchestrator.getAllPositionsWithMetrics();
      const allPositions = positionsResult.positions;
      
      if (allPositions.length === 0) {
        return;
      }

      const singleLegPositions = this.detectSingleLegPositions(allPositions);
      if (singleLegPositions.length > 0) {
        this.logger.warn(
          `⚠️ Detected ${singleLegPositions.length} single-leg position(s) during periodic check. Attempting to open missing side...`,
        );
        
        // Try to open missing side for each single-leg position
        for (const position of singleLegPositions) {
          const retrySuccess = await this.tryOpenMissingSide(position);
          
          if (!retrySuccess) {
            // Retries failed - close the position immediately (don't wait for next execution cycle)
            this.logger.error(
              `🚨 Single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType} ` +
              `still missing after retry attempts. Closing immediately to eliminate price exposure.`,
            );
            await this.closeSingleLegPosition(position);
          }
        }
        
        // Refresh positions after retry attempts to check if any still exist
        const updatedPositionsResult = await this.orchestrator.getAllPositionsWithMetrics();
        const updatedPositions = updatedPositionsResult.positions;
        const stillSingleLeg = this.detectSingleLegPositions(updatedPositions);
        
        if (stillSingleLeg.length > 0) {
          this.logger.error(
            `🚨 Still have ${stillSingleLeg.length} single-leg position(s) after retries. Closing them immediately...`,
          );
          // Close remaining single-leg positions with progressive price improvement
          for (const position of stillSingleLeg) {
            await this.closeSingleLegPosition(position);
          }
        }
      }
    } catch (error: any) {
      this.logger.debug(`Failed to check single-leg positions: ${error.message}`);
    }
  }

  /**
   * Manual trigger for testing
   */
  async executeManually(): Promise<void> {
    await this.executeHourly();
  }

  /**
   * Check balances across all exchanges and warn if insufficient
   * Also checks for unallocated USDC that could be deployed
   */
  private async checkBalances(): Promise<void> {
    const minBalanceForTrading = 10; // Minimum $10 needed per exchange to cover fees
    // Only check exchanges that have adapters available
    const adapters = this.keeperService.getExchangeAdapters();
    const exchanges = Array.from(adapters.keys());
    
    if (exchanges.length === 0) {
      this.logger.warn('⚠️  No exchange adapters available - cannot check balances');
      return;
    }
    
    this.logger.log('💰 Checking exchange balances and capital allocation...');
    
    // Get all positions to calculate margin used
    const positionsResult = await this.orchestrator.getAllPositionsWithMetrics();
    const positionsByExchange = positionsResult.positionsByExchange;
    
    // Calculate margin used per exchange (position value / leverage)
    const leverage = parseFloat(this.configService.get<string>('KEEPER_LEVERAGE') || '2.0');
    const marginUsedPerExchange = new Map<ExchangeType, number>();
    
    for (const [exchangeType, positions] of positionsByExchange) {
      const totalMarginUsed = positions.reduce((sum, pos) => {
        // Use marginUsed if available, otherwise calculate as positionValue / leverage
        const margin = pos.marginUsed ?? (pos.getPositionValue() / leverage);
        return sum + margin;
      }, 0);
      marginUsedPerExchange.set(exchangeType, totalMarginUsed);
    }
    
    const balances: Array<{ 
      exchange: ExchangeType; 
      balance: number; 
      marginUsed: number;
      totalCapital: number;
      unallocated: number;
      canTrade: boolean;
    }> = [];
    
    for (const exchange of exchanges) {
      try {
        const freeBalance = await this.keeperService.getBalance(exchange);
        const marginUsed = marginUsedPerExchange.get(exchange) ?? 0;
        const totalCapital = freeBalance + marginUsed;
        const unallocated = freeBalance;
        const canTrade = freeBalance >= minBalanceForTrading;
        
        balances.push({ exchange, balance: freeBalance, marginUsed, totalCapital, unallocated, canTrade });
        
        const status = canTrade ? '✅' : '⚠️';
        this.logger.log(
          `   ${status} ${exchange}:\n` +
          `      Free Balance: $${freeBalance.toFixed(2)}\n` +
          `      Margin Used: $${marginUsed.toFixed(2)}\n` +
          `      Total Capital: $${totalCapital.toFixed(2)}\n` +
          `      Unallocated: $${unallocated.toFixed(2)} ${canTrade ? '(can trade)' : `(need $${minBalanceForTrading}+)`}`
        );
        
        // For HyperLiquid, also log equity to see total account value
        if (exchange === ExchangeType.HYPERLIQUID) {
          try {
            const equity = await this.keeperService.getEquity(exchange);
            this.logger.log(`      Equity: $${equity.toFixed(2)} (account value)`);
          } catch (e) {
            // Ignore equity fetch errors
          }
        }
      } catch (error: any) {
        this.logger.warn(`   ❌ ${exchange}: Failed to check balance - ${error.message}`);
        balances.push({ exchange, balance: 0, marginUsed: 0, totalCapital: 0, unallocated: 0, canTrade: false });
      }
    }
    
    // Calculate totals
    const tradableExchanges = balances.filter(b => b.canTrade).length;
    const totalFreeBalance = balances.reduce((sum, b) => sum + b.balance, 0);
    const totalMarginUsed = balances.reduce((sum, b) => sum + b.marginUsed, 0);
    const totalCapitalOnExchanges = balances.reduce((sum, b) => sum + b.totalCapital, 0);
    const totalUnallocatedOnExchanges = totalFreeBalance;
    const minBalance = Math.min(...balances.map(b => b.balance).filter(b => b > 0));
    
    // Check wallet USDC balance on-chain
    let walletUsdcBalance = 0;
    let walletAddress: string | null = null;
    try {
      walletUsdcBalance = await this.getWalletUsdcBalance();
      if (walletUsdcBalance > 0) {
        // Get wallet address for logging
        const privateKey = this.configService.get<string>('PRIVATE_KEY');
        if (privateKey) {
          const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
          const wallet = new Wallet(normalizedKey);
          walletAddress = wallet.address;
        }
      }
    } catch (error: any) {
      this.logger.debug(`Failed to check wallet USDC balance: ${error.message}`);
    }
    
    // Calculate total capital (on exchanges + in wallet)
    const totalCapitalAll = totalCapitalOnExchanges + walletUsdcBalance;
    const totalDeployed = totalMarginUsed;
    const totalUnallocatedAll = totalFreeBalance + walletUsdcBalance;
    
    this.logger.log(`\n   📊 Capital Summary:`);
    this.logger.log(`      On Exchanges:`);
    this.logger.log(`         Free Balance: $${totalFreeBalance.toFixed(2)}`);
    this.logger.log(`         Margin Used: $${totalMarginUsed.toFixed(2)}`);
    this.logger.log(`         Total on Exchanges: $${totalCapitalOnExchanges.toFixed(2)}`);
    if (walletUsdcBalance > 0) {
      this.logger.log(`      In Wallet (${walletAddress ? walletAddress.slice(0, 10) + '...' : 'on-chain'}):`);
      this.logger.log(`         USDC Balance: $${walletUsdcBalance.toFixed(2)}`);
    }
    this.logger.log(`      Total Capital: $${totalCapitalAll.toFixed(2)}`);
    this.logger.log(`      Total Deployed: $${totalDeployed.toFixed(2)}`);
    this.logger.log(`      Total Unallocated: $${totalUnallocatedAll.toFixed(2)}`);
    
    if (minBalance > 0) {
      this.logger.log(`      Minimum balance (limits position size): $${minBalance.toFixed(2)}`);
    }
    
    // Check for significant unallocated capital (on exchanges + in wallet)
    const unallocatedThreshold = 50; // Warn if more than $50 unallocated
    if (totalUnallocatedAll > unallocatedThreshold) {
      const allocationPercent = totalCapitalAll > 0 ? (totalDeployed / totalCapitalAll) * 100 : 0;
      const walletPercent = totalCapitalAll > 0 ? (walletUsdcBalance / totalCapitalAll) * 100 : 0;
      
      this.logger.warn(
        `⚠️  UNALLOCATED CAPITAL DETECTED: $${totalUnallocatedAll.toFixed(2)} unallocated USDC ` +
        `(${allocationPercent.toFixed(1)}% deployed, ${(100 - allocationPercent).toFixed(1)}% idle)`
      );
      
      if (walletUsdcBalance > 10) {
        this.logger.warn(
          `   💰 Wallet has $${walletUsdcBalance.toFixed(2)} USDC (${walletPercent.toFixed(1)}% of total) - ` +
          `consider depositing to exchanges to deploy capital`
        );
      }
      
      if (totalUnallocatedOnExchanges > 10) {
        this.logger.warn(
          `   📊 Exchanges have $${totalUnallocatedOnExchanges.toFixed(2)} free balance - ` +
          `consider increasing position sizes or rebalancing`
        );
      }
    } else if (totalUnallocatedAll > 0) {
      const allocationPercent = totalCapitalAll > 0 ? (totalDeployed / totalCapitalAll) * 100 : 0;
      this.logger.log(
        `✅ Capital allocation: $${totalUnallocatedAll.toFixed(2)} unallocated ` +
        `(${allocationPercent.toFixed(1)}% deployed)`
      );
    }
    
    if (tradableExchanges < 2) {
      this.logger.warn(
        `⚠️  INSUFFICIENT BALANCE: Need at least $${minBalanceForTrading} on 2+ exchanges to execute arbitrage. ` +
        `Currently have tradable balance on ${tradableExchanges} exchange(s). ` +
        `The bot will use whatever balance is available (minimum $${minBalanceForTrading} per exchange).`
      );
    } else {
      this.logger.log(
        `✅ Ready for arbitrage: ${tradableExchanges} exchange(s) have sufficient balance. ` +
        `Position size will be limited by minimum balance: $${minBalance.toFixed(2)}`
      );
    }
    
    this.logger.log('');
  }

  /**
   * Periodic wallet balance check - runs every 10 minutes
   * Checks for new USDC in wallet and deposits to exchanges if needed
   */
  @Interval(600000) // Every 10 minutes (600000 ms)
  async checkWalletBalancePeriodically() {
    try {
      this.logger.debug('🔍 Periodic wallet balance check (every 10 minutes)...');
      await this.checkAndDepositWalletFunds();
    } catch (error: any) {
      this.logger.debug(`Periodic wallet balance check failed: ${error.message}`);
    }
  }

  /**
   * Check wallet USDC balance and deposit to exchanges if available
   * This proactively deposits wallet funds to exchanges that need capital
   */
  private async checkAndDepositWalletFunds(): Promise<void> {
    try {
      const walletBalance = await this.getWalletUsdcBalance();
      if (walletBalance <= 0) {
        this.logger.debug('No USDC in wallet, skipping deposit');
        return;
      }

      this.logger.log(
        `💰 Found $${walletBalance.toFixed(2)} USDC in wallet, checking if deposits are needed...`,
      );

      // Get all exchange adapters
      const adapters = this.keeperService.getExchangeAdapters();
      if (adapters.size === 0) {
        this.logger.debug('No exchange adapters available, skipping deposit');
        return;
      }

      // Get current balances on all exchanges for logging
      const exchangeBalances = new Map<ExchangeType, number>();
      for (const [exchange, adapter] of adapters) {
        try {
          const balance = await adapter.getBalance();
          exchangeBalances.set(exchange, balance);
        } catch (error: any) {
          this.logger.debug(
            `Failed to get balance for ${exchange}: ${error.message}`,
          );
          exchangeBalances.set(exchange, 0);
        }
      }

      // Log current balances
      this.logger.log('Current exchange balances:');
      for (const [exchange, balance] of exchangeBalances) {
        this.logger.log(`  ${exchange}: $${balance.toFixed(2)}`);
      }

      // Distribute wallet funds equally to all exchanges (scalable approach)
      const exchangesToDeposit = Array.from(adapters.keys());
      if (exchangesToDeposit.length === 0) {
        this.logger.debug('No exchanges available for deposit');
        return;
      }

      // Distribute wallet funds equally to all exchanges
      let remainingWalletBalance = walletBalance;
      const amountPerExchange = walletBalance / exchangesToDeposit.length;

      this.logger.log(
        `📊 Distributing $${walletBalance.toFixed(2)} equally to ${exchangesToDeposit.length} exchange(s): ` +
        `$${amountPerExchange.toFixed(2)} per exchange`,
      );

      for (const exchange of exchangesToDeposit) {
        if (remainingWalletBalance <= 0) {
          break;
        }

        const adapter = adapters.get(exchange);
        if (!adapter) continue;

        const depositAmount = Math.min(amountPerExchange, remainingWalletBalance);
        if (depositAmount < 5) {
          // Minimum deposit is usually $5
          this.logger.debug(
            `Skipping deposit to ${exchange}: amount too small ($${depositAmount.toFixed(2)})`,
          );
          continue;
        }

        try {
          this.logger.log(
            `📥 Depositing $${depositAmount.toFixed(2)} from wallet to ${exchange}...`,
          );
          await adapter.depositExternal(depositAmount, 'USDC');
          this.logger.log(
            `✅ Successfully deposited $${depositAmount.toFixed(2)} to ${exchange}`,
          );
          remainingWalletBalance -= depositAmount;
          // Wait a bit between deposits to avoid rate limits
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error: any) {
          // Check if it's a 404 error (endpoint doesn't exist) - Aster may require on-chain deposits
          if (error.message?.includes('404') || error.message?.includes('on-chain')) {
            this.logger.warn(
              `⚠️ ${exchange} deposits may require on-chain transactions. ` +
              `Skipping deposit to ${exchange}. Funds remain in wallet. ` +
              `Error: ${error.message}`,
            );
            // Don't subtract from remaining balance - funds stay in wallet
            continue;
          }
          this.logger.warn(
            `Failed to deposit $${depositAmount.toFixed(2)} to ${exchange}: ${error.message}`,
          );
          // Don't subtract on error - funds remain in wallet for retry
        }
      }

      if (remainingWalletBalance < walletBalance) {
        const deposited = walletBalance - remainingWalletBalance;
        this.logger.log(
          `✅ Wallet deposit cycle complete: Deposited $${deposited.toFixed(2)} of $${walletBalance.toFixed(2)} total`,
        );
      }
    } catch (error: any) {
      this.logger.debug(
        `Error checking/depositing wallet funds: ${error.message}`,
      );
    }
  }

  /**
   * Get wallet USDC balance on-chain
   * Checks the wallet's USDC balance directly from the blockchain
   */
  private async getWalletUsdcBalance(): Promise<number> {
    try {
      // Get Arbitrum RPC URL (USDC deposits go through Arbitrum)
      const rpcUrl = this.configService.get<string>('ARBITRUM_RPC_URL') || 
                     this.configService.get<string>('ARB_RPC_URL') ||
                     'https://arb1.arbitrum.io/rpc'; // Public Arbitrum RPC fallback
      const privateKey = this.configService.get<string>('PRIVATE_KEY');
      const walletAddress = this.configService.get<string>('WALLET_ADDRESS') || 
                           this.configService.get<string>('CENTRAL_WALLET_ADDRESS');
      
      if (!privateKey && !walletAddress) {
        this.logger.debug('No PRIVATE_KEY or WALLET_ADDRESS configured, skipping wallet balance check');
        return 0;
      }

      // USDC address on Arbitrum (matches deposit logic)
      const usdcAddress = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
      
      // ERC20 ABI (minimal)
      const erc20Abi = [
        'function balanceOf(address owner) view returns (uint256)',
        'function decimals() view returns (uint8)',
      ];

      // Initialize provider
      const provider = new JsonRpcProvider(rpcUrl);
      
      // Get wallet address
      let address: string;
      if (walletAddress) {
        address = walletAddress;
        this.logger.debug(`Using WALLET_ADDRESS from config: ${address}`);
      } else if (privateKey) {
        const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
        const wallet = new Wallet(normalizedKey);
        address = wallet.address;
        this.logger.debug(`Derived address from PRIVATE_KEY: ${address}`);
      } else {
        return 0;
      }

      this.logger.log(
        `🔍 Checking USDC balance on Arbitrum for address: ${address} ` +
        `(USDC contract: ${usdcAddress})`,
      );

      // Check USDC balance
      const usdcContract = new Contract(usdcAddress, erc20Abi, provider);
      const balance = await usdcContract.balanceOf(address);
      const decimals = await usdcContract.decimals();
      const balanceUsd = parseFloat(formatUnits(balance, decimals));

      this.logger.log(
        `💰 USDC balance on Arbitrum for ${address}: $${balanceUsd.toFixed(2)} USDC`,
      );

      return balanceUsd;
    } catch (error: any) {
      this.logger.debug(`Failed to get wallet USDC balance on Arbitrum: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get retry key for single-leg position tracking
   */
  private getRetryKey(
    symbol: string,
    exchange1: ExchangeType,
    exchange2?: ExchangeType,
  ): string {
    if (exchange2) {
      // For opportunity tracking: sort exchanges for consistent key
      const exchanges = [exchange1, exchange2].sort();
      return `${symbol}-${exchanges[0]}-${exchanges[1]}`;
    }
    // For position lookup: find matching retry info by symbol and exchange
    for (const [key, retryInfo] of this.singleLegRetries.entries()) {
      if (key.startsWith(`${symbol}-`) && 
          (retryInfo.longExchange === exchange1 || retryInfo.shortExchange === exchange1)) {
        return key;
      }
    }
    // Fallback: create key with just symbol and exchange
    return `${symbol}-${exchange1}`;
  }

  /**
   * Try to open the missing side of a single-leg position
   * Returns true if successful, false if retries exhausted
   */
  private async tryOpenMissingSide(position: PerpPosition): Promise<boolean> {
    try {
      // Find opportunity for this symbol to determine which exchange should have the missing side
      const comparison = await this.orchestrator.compareFundingRates(position.symbol);
      if (!comparison || comparison.rates.length < 2) {
        this.logger.warn(
          `No opportunity found for ${position.symbol} - cannot determine missing exchange`,
        );
        return false;
      }

      // Determine which exchange should have the missing side based on funding rates
      // LONG on exchange with lowest rate, SHORT on exchange with highest rate
      const sortedRates = [...comparison.rates].sort((a, b) => a.currentRate - b.currentRate);
      const expectedLongExchange = sortedRates[0].exchange;
      const expectedShortExchange = sortedRates[sortedRates.length - 1].exchange;

      // Determine missing exchange and side
      const missingExchange = position.side === OrderSide.LONG 
        ? expectedShortExchange 
        : expectedLongExchange;
      const missingSide = position.side === OrderSide.LONG 
        ? OrderSide.SHORT 
        : OrderSide.LONG;

      // Get retry key
      const retryKey = this.getRetryKey(position.symbol, expectedLongExchange, expectedShortExchange);
      
      // Check if already filtered out
      if (this.filteredOpportunities.has(retryKey)) {
        this.logger.debug(
          `Opportunity ${position.symbol} (${expectedLongExchange}/${expectedShortExchange}) already filtered out`,
        );
        return false;
      }

      // Get or create retry info
      let retryInfo = this.singleLegRetries.get(retryKey);
      if (!retryInfo) {
        retryInfo = {
          retryCount: 0,
          longExchange: expectedLongExchange,
          shortExchange: expectedShortExchange,
          lastRetryTime: new Date(),
        };
        this.singleLegRetries.set(retryKey, retryInfo);
      }

      // Check retry count
      if (retryInfo.retryCount >= 5) {
        this.logger.error(
          `❌ Filtering out ${position.symbol} (${expectedLongExchange}/${expectedShortExchange}) ` +
          `after 5 failed retry attempts`,
        );
        this.filteredOpportunities.add(retryKey);
        return false;
      }

      // Try to open missing side
      this.logger.log(
        `🔄 Retry ${retryInfo.retryCount + 1}/5: Attempting to open missing ${missingSide} side ` +
        `for ${position.symbol} on ${missingExchange}...`,
      );

      const adapter = this.keeperService.getExchangeAdapter(missingExchange);
      if (!adapter) {
        this.logger.warn(`No adapter found for ${missingExchange}`);
        retryInfo.retryCount++;
        retryInfo.lastRetryTime = new Date();
        return false;
      }

      // Create market order to open missing side (same size as existing position)
      const openOrder = new PerpOrderRequest(
        position.symbol,
        missingSide,
        OrderType.MARKET,
        position.size,
        undefined, // price
        TimeInForce.IOC,
        false, // not reduceOnly
      );

      const orderResult = await adapter.placeOrder(openOrder);
      
      if (orderResult && orderResult.orderId) {
        // Wait a bit and check if position opened
        await new Promise(resolve => setTimeout(resolve, 2000));
        const updatedPositions = await adapter.getPositions();
        const positionOpened = updatedPositions.some(
          (p) =>
            p.symbol === position.symbol &&
            p.exchangeType === missingExchange &&
            p.side === missingSide &&
            Math.abs(p.size) > 0.0001,
        );

        if (positionOpened) {
          this.logger.log(
            `✅ Successfully opened missing ${missingSide} side for ${position.symbol} on ${missingExchange}`,
          );
          // Reset retry count on success
          this.singleLegRetries.delete(retryKey);
          return true;
        } else {
          this.logger.warn(
            `⚠️ Order placed but position not detected for ${position.symbol} on ${missingExchange}`,
          );
        }
      }

      // Increment retry count
      retryInfo.retryCount++;
      retryInfo.lastRetryTime = new Date();
      this.logger.warn(
        `⚠️ Retry ${retryInfo.retryCount}/5 failed for ${position.symbol}. ` +
        `Will try again next cycle.`,
      );

      // After 5 retries, filter out this opportunity
      if (retryInfo.retryCount >= 5) {
        this.filteredOpportunities.add(retryKey);
        this.logger.error(
          `❌ Filtering out ${position.symbol} (${expectedLongExchange}/${expectedShortExchange}) ` +
          `after 5 failed retry attempts. Moving to next opportunity.`,
        );
        return false;
      }

      return false;
    } catch (error: any) {
      this.logger.warn(
        `Error retrying missing side for ${position.symbol}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Find and execute the best available arbitrage opportunity
   * Excludes the closed symbol, the specific failed opportunity, and filtered opportunities
   */
  private async findAndExecuteBestOpportunity(
    excludeSymbol?: string,
    excludeOpportunityKey?: string,
  ): Promise<boolean> {
    try {
      // Get all available symbols
      const symbols = await this.discoverAssetsIfNeeded();
      if (symbols.length === 0) {
        this.logger.debug('No symbols available for opportunity search');
        return false;
      }

      // Filter out blacklisted symbols and the excluded symbol
      const filteredSymbols = symbols.filter(s => {
        if (this.isBlacklisted(s)) return false;
        if (excludeSymbol && s === excludeSymbol) return false;
        return true;
      });

      if (filteredSymbols.length === 0) {
        this.logger.debug('No symbols available after filtering');
        return false;
      }

      // Find opportunities
      const excludeInfo = excludeOpportunityKey 
        ? `opportunity ${excludeOpportunityKey}` 
        : excludeSymbol 
          ? `symbol ${excludeSymbol}` 
          : 'none';
      this.logger.log(`🔍 Searching for best opportunity after closing position (excluding ${excludeInfo})...`);
      const opportunities = await this.orchestrator.findArbitrageOpportunities(
        filteredSymbols,
        this.minSpread,
        false, // Don't show progress bar for single opportunity search
      );

      if (opportunities.length === 0) {
        this.logger.debug('No opportunities found');
        return false;
      }

      // Filter out blacklisted, excluded, and filtered opportunities
      const availableOpportunities = opportunities.filter(opp => {
        if (this.isBlacklisted(opp.symbol)) return false;
        if (excludeSymbol && opp.symbol === excludeSymbol) return false;
        
        // Check if this opportunity is in the filtered set
        const retryKey = this.getRetryKey(opp.symbol, opp.longExchange, opp.shortExchange);
        if (this.filteredOpportunities.has(retryKey)) return false;
        
        // Exclude the specific opportunity that just failed
        if (excludeOpportunityKey && retryKey === excludeOpportunityKey) return false;
        
        return true;
      });

      if (availableOpportunities.length === 0) {
        this.logger.debug('No available opportunities after filtering');
        return false;
      }

      // Sort by net spread (most profitable first)
      const sortedOpportunities = [...availableOpportunities].sort((a, b) => b.netSpread - a.netSpread);
      const bestOpportunity = sortedOpportunities[0];

      this.logger.log(
        `💰 Found best opportunity: ${bestOpportunity.symbol} ` +
        `(${bestOpportunity.longExchange}/${bestOpportunity.shortExchange}) ` +
        `with ${(bestOpportunity.netSpread * 100).toFixed(4)}% net spread. Executing...`
      );

      // Execute the best opportunity
      const result = await this.orchestrator.executeArbitrageStrategy(
        [bestOpportunity.symbol],
        this.minSpread,
        this.maxPositionSizeUsd,
      );

      if (result.opportunitiesExecuted > 0) {
        this.logger.log(
          `✅ Successfully opened positions for ${bestOpportunity.symbol} ` +
          `(Expected return: $${result.totalExpectedReturn.toFixed(2)})`
        );
        return true;
      } else {
        this.logger.warn(
          `⚠️ Failed to execute opportunity for ${bestOpportunity.symbol}: ${result.errors.join(', ')}`
        );
        return false;
      }
    } catch (error: any) {
      this.logger.warn(`Error finding/executing best opportunity: ${error.message}`);
      return false;
    }
  }

  /**
   * Close a single-leg position with progressive price improvement
   * After closing, attempts to open positions in the next most profitable opportunity
   */
  private async closeSingleLegPosition(position: PerpPosition): Promise<void> {
    try {
      const adapter = this.keeperService.getExchangeAdapter(position.exchangeType);
      if (!adapter) {
        this.logger.warn(`No adapter found for ${position.exchangeType}`);
        return;
      }

      const closeSide = position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
      
      // Progressive price improvement: start with market, then try worse prices
      const priceImprovements = [0, 0.001, 0.005, 0.01, 0.02, 0.05]; // 0%, 0.1%, 0.5%, 1%, 2%, 5% worse
      let positionClosed = false;
      
      for (let attempt = 0; attempt < priceImprovements.length; attempt++) {
        const priceImprovement = priceImprovements[attempt];
        
        try {
          // Get current market price for limit orders (if not first attempt)
          let limitPrice: number | undefined = undefined;
          if (attempt > 0 && position.exchangeType === ExchangeType.LIGHTER) {
            // For Lighter, get order book price and apply price improvement
            try {
              const markPrice = await adapter.getMarkPrice(position.symbol);
              if (markPrice > 0) {
                // For closing LONG: we SELL, so use bid price (worse = lower)
                // For closing SHORT: we BUY, so use ask price (worse = higher)
                if (position.side === OrderSide.LONG) {
                  limitPrice = markPrice * (1 - priceImprovement);
                } else {
                  limitPrice = markPrice * (1 + priceImprovement);
                }
              }
            } catch (priceError: any) {
              // Fall back to market order
            }
          }
          
          const closeOrder = new PerpOrderRequest(
            position.symbol,
            closeSide,
            limitPrice ? OrderType.LIMIT : OrderType.MARKET,
            position.size,
            limitPrice,
            TimeInForce.IOC,
            true, // Reduce only
          );
          
          if (attempt === 0) {
            this.logger.error(`   🚨 CRITICAL: Closing single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType}...`);
          } else {
            this.logger.warn(
              `   🔄 Retry ${attempt}/${priceImprovements.length - 1}: Closing ${position.symbol} with ` +
              `${(priceImprovement * 100).toFixed(2)}% worse price`,
            );
          }
          
          const closeResponse = await adapter.placeOrder(closeOrder);
          
          // Wait and check if order filled
          if (!closeResponse.isFilled() && closeResponse.orderId) {
            const maxRetries = 5;
            const pollIntervalMs = 2000;
            
            for (let pollAttempt = 0; pollAttempt < maxRetries; pollAttempt++) {
              if (pollAttempt > 0) {
                await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
              }
              
              try {
                const statusResponse = await adapter.getOrderStatus(closeResponse.orderId, position.symbol);
                if (statusResponse.isFilled()) {
                  break;
                }
                if (statusResponse.status === OrderStatus.CANCELLED || statusResponse.error) {
                  break;
                }
              } catch (pollError: any) {
                // Continue polling
              }
            }
          }
          
          // Check if position is actually closed
          await new Promise(resolve => setTimeout(resolve, 500));
          const currentPositions = await adapter.getPositions();
          const positionStillExists = currentPositions.some(
            (p) =>
              p.symbol === position.symbol &&
              p.exchangeType === position.exchangeType &&
              Math.abs(p.size) > 0.0001,
          );
          
          if (closeResponse.isFilled() && !positionStillExists) {
            positionClosed = true;
            if (attempt > 0) {
              this.logger.log(
                `   ✅ Successfully closed single-leg position ${position.symbol} on attempt ${attempt + 1} ` +
                `with ${(priceImprovement * 100).toFixed(2)}% worse price`,
              );
            } else {
              this.logger.log(`   ✅ Successfully closed single-leg position: ${position.symbol} on ${position.exchangeType}`);
            }
            break; // Position closed successfully
          }
          
          if (attempt < priceImprovements.length - 1) {
            this.logger.warn(
              `   ⚠️ Close order for ${position.symbol} didn't fill on attempt ${attempt + 1}, ` +
              `trying with worse price...`,
            );
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before next attempt
          }
        } catch (attemptError: any) {
          this.logger.warn(
            `   Error on close attempt ${attempt + 1} for ${position.symbol}: ${attemptError.message}`,
          );
          if (attempt === priceImprovements.length - 1) {
            // Last attempt failed
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      if (!positionClosed) {
        this.logger.error(
          `   ❌ CRITICAL: Failed to close single-leg position ${position.symbol} on ${position.exchangeType} ` +
          `after ${priceImprovements.length} attempts with progressive price improvement`,
        );
        return; // Don't try to open new position if we couldn't close the old one
      }

      // Wait a bit for position to fully settle and margin to be freed
      this.logger.log(`   ⏳ Waiting 2 seconds for position to settle and margin to be freed...`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Determine which opportunity this position was part of (so we don't try the same one again)
      let failedOpportunityKey: string | undefined;
      try {
        const comparison = await this.orchestrator.compareFundingRates(position.symbol);
        if (comparison && comparison.rates.length >= 2) {
          const sortedRates = [...comparison.rates].sort((a, b) => a.currentRate - b.currentRate);
          const expectedLongExchange = sortedRates[0].exchange;
          const expectedShortExchange = sortedRates[sortedRates.length - 1].exchange;
          failedOpportunityKey = this.getRetryKey(position.symbol, expectedLongExchange, expectedShortExchange);
        }
      } catch (error: any) {
        // If we can't determine the opportunity, just exclude the symbol
        this.logger.debug(`Could not determine failed opportunity key for ${position.symbol}: ${error.message}`);
      }

      // After successfully closing, find and execute the best available opportunity
      // Exclude both the symbol and the specific failed opportunity
      this.logger.log(`   🔄 Capital freed from closing ${position.symbol}. Searching for best opportunity to redeploy...`);
      const opportunityExecuted = await this.findAndExecuteBestOpportunity(
        position.symbol,
        failedOpportunityKey,
      );
      
      if (!opportunityExecuted) {
        this.logger.debug(`   ℹ️ No suitable opportunity found to redeploy capital from ${position.symbol}`);
      }
    } catch (error: any) {
      this.logger.error(`   ❌ CRITICAL: Error closing single-leg position ${position.symbol} on ${position.exchangeType}: ${error.message}`);
    }
  }

  /**
   * Close a position with retry logic (for non-single-leg positions)
   */
  private async closePositionWithRetry(position: PerpPosition): Promise<void> {
    try {
      const adapter = this.keeperService.getExchangeAdapter(position.exchangeType);
      if (!adapter) {
        this.logger.warn(`No adapter found for ${position.exchangeType}`);
        return;
      }

      const closeOrder = new PerpOrderRequest(
        position.symbol,
        position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG,
        OrderType.MARKET,
        position.size,
        undefined, // price
        TimeInForce.IOC,
        true, // Reduce only
      );
      
      this.logger.log(`   Closing ${position.symbol} on ${position.exchangeType}...`);
      const closeResponse = await adapter.placeOrder(closeOrder);
      
      // Wait and retry if order didn't fill immediately
      if (!closeResponse.isFilled() && closeResponse.orderId) {
        const maxRetries = 5;
        const pollIntervalMs = 2000;
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
          }
          
          try {
            const statusResponse = await adapter.getOrderStatus(closeResponse.orderId, position.symbol);
            if (statusResponse.isFilled()) {
              this.logger.log(`   ✅ Order filled on attempt ${attempt + 1}/${maxRetries}`);
              break;
            }
            if (statusResponse.status === OrderStatus.CANCELLED || statusResponse.error) {
              break;
            }
          } catch (pollError: any) {
            // Continue polling
          }
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error: any) {
      this.logger.error(`   Error closing position ${position.symbol} on ${position.exchangeType}: ${error.message}`);
    }
  }
}

