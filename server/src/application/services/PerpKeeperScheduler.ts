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
      const discoveredSymbols = await this.orchestrator.discoverCommonAssets();
      
      // Filter out blacklisted symbols using normalized comparison
      this.symbols = discoveredSymbols.filter(s => !this.isBlacklisted(s));
      this.lastDiscoveryTime = now;
      
      const filteredCount = discoveredSymbols.length - this.symbols.length;
      if (filteredCount > 0) {
        const filtered = discoveredSymbols.filter(s => this.isBlacklisted(s));
        this.logger.log(
          `Auto-discovery: ${discoveredSymbols.length} assets, filtered ${filteredCount} blacklisted`
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

      // Find opportunities across ALL discovered assets
      const opportunities = await this.orchestrator.findArbitrageOpportunities(
        filteredSymbols,
        this.minSpread,
        false, // Hide progress bar
      );

      // Filter out any opportunities for blacklisted symbols (defensive check)
      const filteredOpportunities = opportunities.filter(
        opp => !this.isBlacklisted(opp.symbol)
      );

      this.logger.log(`Found ${filteredOpportunities.length} arbitrage opportunities`);

      // STEP 1: Close all existing positions to free up margin for rebalancing
      try {
        const positionsResult = await this.orchestrator.getAllPositionsWithMetrics();
        // Filter out positions with very small sizes (likely rounding errors or stale data)
        const allPositions = positionsResult.positions.filter(p => Math.abs(p.size) > 0.0001);
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
                // Retries exhausted - close the position
                this.logger.error(
                  `🚨 Closing single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType} after retries failed`,
                );
                await this.closeSingleLegPosition(position);
              }
            }
            
            // Wait for positions to settle after closing
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Refresh positions after retry attempts and verify they're closed
            const updatedPositionsResult = await this.orchestrator.getAllPositionsWithMetrics();
            // Filter out very small positions (stale data)
            const updatedPositions = updatedPositionsResult.positions.filter(p => Math.abs(p.size) > 0.0001);
            const stillSingleLeg = this.detectSingleLegPositions(updatedPositions);
            
            if (stillSingleLeg.length > 0) {
              // Close remaining single-leg positions
              this.logger.warn(
                `⚠️ Still detecting ${stillSingleLeg.length} single-leg position(s) after closing. Closing them...`,
              );
              for (const position of stillSingleLeg) {
                await this.closeSingleLegPosition(position);
              }
              
              // Wait again and verify
              await new Promise(resolve => setTimeout(resolve, 3000));
              const finalPositionsResult = await this.orchestrator.getAllPositionsWithMetrics();
              const finalPositions = finalPositionsResult.positions.filter(p => Math.abs(p.size) > 0.0001);
              const finalSingleLeg = this.detectSingleLegPositions(finalPositions);
              
              if (finalSingleLeg.length === 0) {
                this.logger.log(
                  `✅ All single-leg positions closed. Triggering new opportunity search and idle funds management...`,
                );
                // Trigger new opportunity search after closing single-leg positions
                await this.triggerNewOpportunitySearch();
              } else {
                this.logger.warn(
                  `⚠️ Still detecting ${finalSingleLeg.length} single-leg position(s) after second close attempt. ` +
                  `This may be stale data - will retry next cycle.`,
                );
              }
            } else {
              // All positions closed successfully
              this.logger.log(
                `✅ All single-leg positions closed. Triggering new opportunity search and idle funds management...`,
              );
              // Trigger new opportunity search after closing single-leg positions
              await this.triggerNewOpportunitySearch();
            }
            
            // Remove single-leg positions from allPositions to avoid double-closing
            const singleLegSet = new Set(singleLegPositions.map(p => `${p.symbol}-${p.exchangeType}-${p.side}`));
            const remainingPositions = allPositions.filter(
              p => !singleLegSet.has(`${p.symbol}-${p.exchangeType}-${p.side}`)
            );
            allPositions.length = 0;
            allPositions.push(...remainingPositions);
          }
          
          // Close remaining positions (non-single-leg)
          if (allPositions.length > 0) {
            this.logger.log(`🔄 Closing ${allPositions.length} existing position(s)...`);
            for (const position of allPositions) {
              await this.closePositionWithRetry(position);
            }
          }
          
          // Wait for positions to settle and margin to be freed
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error: any) {
        this.logger.warn(`Failed to close existing positions: ${error.message}`);
        // Continue anyway - rebalancing might still work
      }

      // STEP 2: Rebalance exchange balances based on opportunities
      try {
        const rebalanceResult = await this.keeperService.rebalanceExchangeBalances(filteredOpportunities);
        if (rebalanceResult.transfersExecuted > 0) {
          this.logger.log(
            `✅ Rebalanced ${rebalanceResult.transfersExecuted} transfers, $${rebalanceResult.totalTransferred.toFixed(2)} total`
          );
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      } catch (error: any) {
        this.logger.warn(`Failed to rebalance exchange balances: ${error.message}`);
        // Don't fail the entire execution if rebalancing fails
      }

      if (filteredOpportunities.length === 0) {
        this.logger.log('No opportunities found (after blacklist filter), skipping execution');
        return;
      }

      // Execute strategy across filtered assets
      const symbolsToExecute = filteredSymbols.filter(s => !this.isBlacklisted(s));
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
      const allPositions = await this.keeperService.getAllPositions();
      
      // Filter out positions with very small sizes (likely rounding errors or stale data)
      const positions = allPositions.filter(p => Math.abs(p.size) > 0.0001);
      
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
   * Policy: After all retries fail, close the single leg and move to next opportunity
   */
  private async checkAndRetrySingleLegPositions(): Promise<void> {
    try {
      const positionsResult = await this.orchestrator.getAllPositionsWithMetrics();
      // Filter out positions with very small sizes (likely rounding errors or stale data)
      const allPositions = positionsResult.positions.filter(p => Math.abs(p.size) > 0.0001);
      
      if (allPositions.length === 0) {
        return;
      }

      const singleLegPositions = this.detectSingleLegPositions(allPositions);
      if (singleLegPositions.length > 0) {
        this.logger.warn(
          `⚠️ Detected ${singleLegPositions.length} single-leg position(s). Attempting to open missing side...`,
        );
        
        let anyClosed = false;
        
        // Try to open missing side for each single-leg position
        for (const position of singleLegPositions) {
          const retrySuccess = await this.tryOpenMissingSide(position);
          
          if (!retrySuccess) {
            // Retries exhausted - close the single leg position
            this.logger.error(
              `🚨 Closing single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType} ` +
              `after all retry attempts failed. Will open 2 legs on next best opportunity.`,
            );
            await this.closeSingleLegPosition(position);
            anyClosed = true;
          }
        }
        
        // If any positions were closed, refresh positions and look for new opportunities
        if (anyClosed) {
          // Wait for positions to settle
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Refresh positions to ensure we have latest state
          const refreshedPositionsResult = await this.orchestrator.getAllPositionsWithMetrics();
          const refreshedPositions = refreshedPositionsResult.positions;
          
          // Verify positions are actually closed
          const stillSingleLeg = this.detectSingleLegPositions(refreshedPositions);
          if (stillSingleLeg.length === 0) {
            this.logger.log(
              `✅ All single-leg positions closed. Looking for new opportunities...`,
            );
            
            // Trigger new opportunity search and idle funds management
            await this.triggerNewOpportunitySearch();
          } else {
            this.logger.warn(
              `⚠️ Still detecting ${stillSingleLeg.length} single-leg position(s) after closing. ` +
              `This may be stale data - will retry next cycle.`,
            );
          }
        }
      }
    } catch (error: any) {
      // Silently fail to avoid spam
      this.logger.debug(`Error in checkAndRetrySingleLegPositions: ${error.message}`);
    }
  }
  
  /**
   * Trigger new opportunity search and idle funds management after closing positions
   */
  private async triggerNewOpportunitySearch(): Promise<void> {
    try {
      // Get available symbols
      const symbols = await this.discoverAssetsIfNeeded();
      if (symbols.length === 0) {
        this.logger.debug('No symbols available for new opportunity search');
        return;
      }
      
      // Execute strategy to find and execute new opportunities
      // This will also trigger idle funds management (integrated in FundingArbitrageStrategy)
      const filteredSymbols = symbols.filter(s => !this.isBlacklisted(s));
      if (filteredSymbols.length === 0) {
        this.logger.debug('No non-blacklisted symbols available');
        return;
      }
      
      this.logger.log(
        `🔍 Searching for new opportunities after closing single-leg positions...`,
      );
      
      const result = await this.orchestrator.executeArbitrageStrategy(
        filteredSymbols,
        this.minSpread,
        this.maxPositionSizeUsd,
      );
      
      if (result.opportunitiesExecuted > 0) {
        this.logger.log(
          `✅ Found and executed ${result.opportunitiesExecuted} new opportunity/opportunities after closing single-leg positions`,
        );
      } else {
        this.logger.debug(
          `No new opportunities found after closing single-leg positions`,
        );
      }
    } catch (error: any) {
      this.logger.warn(
        `Failed to trigger new opportunity search: ${error.message}`,
      );
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
      await this.checkAndDepositWalletFunds();
    } catch (error: any) {
      // Silently fail
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
        return;
      }

      this.logger.log(`💰 Found $${walletBalance.toFixed(2)} USDC in wallet, depositing to exchanges...`);

      // Get all exchange adapters
      const adapters = this.keeperService.getExchangeAdapters();
      if (adapters.size === 0) {
        return;
      }

      // Distribute wallet funds equally to all exchanges
      const exchangesToDeposit = Array.from(adapters.keys());
      if (exchangesToDeposit.length === 0) {
        return;
      }

      let remainingWalletBalance = walletBalance;
      const amountPerExchange = walletBalance / exchangesToDeposit.length;

      for (const exchange of exchangesToDeposit) {
        if (remainingWalletBalance <= 0) {
          break;
        }

        const adapter = adapters.get(exchange);
        if (!adapter) continue;

        const depositAmount = Math.min(amountPerExchange, remainingWalletBalance);
        if (depositAmount < 5) {
          // Minimum deposit is usually $5
          continue;
        }

        try {
          await adapter.depositExternal(depositAmount, 'USDC');
          this.logger.log(`✅ Deposited $${depositAmount.toFixed(2)} to ${exchange}`);
          remainingWalletBalance -= depositAmount;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error: any) {
          // Check if it's a 404 error (endpoint doesn't exist) - Aster may require on-chain deposits
          if (error.message?.includes('404') || error.message?.includes('on-chain')) {
            continue;
          }
          // Silently fail - will retry next cycle
        }
      }
    } catch (error: any) {
      // Silently fail
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
      } else if (privateKey) {
        const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
        const wallet = new Wallet(normalizedKey);
        address = wallet.address;
      } else {
        return 0;
      }

      // Check USDC balance
      const usdcContract = new Contract(usdcAddress, erc20Abi, provider);
      const balance = await usdcContract.balanceOf(address);
      const decimals = await usdcContract.decimals();
      const balanceUsd = parseFloat(formatUnits(balance, decimals));

      if (balanceUsd > 0) {
        this.logger.log(`💰 USDC balance on Arbitrum: $${balanceUsd.toFixed(2)}`);
      }

      return balanceUsd;
    } catch (error: any) {
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
        this.filteredOpportunities.add(retryKey);
        return false;
      }

      // Try to open missing side
      this.logger.log(
        `🔄 Retry ${retryInfo.retryCount + 1}/5: Opening missing ${missingSide} side for ${position.symbol} on ${missingExchange}`,
      );

      const adapter = this.keeperService.getExchangeAdapter(missingExchange);
      if (!adapter) {
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
          this.logger.log(`✅ Opened missing ${missingSide} side for ${position.symbol} on ${missingExchange}`);
          // Reset retry count on success
          this.singleLegRetries.delete(retryKey);
          return true;
        }
      }

      // Increment retry count
      retryInfo.retryCount++;
      retryInfo.lastRetryTime = new Date();

      // After 5 retries, filter out this opportunity
      if (retryInfo.retryCount >= 5) {
        this.filteredOpportunities.add(retryKey);
        return false;
      }

      return false;
    } catch (error: any) {
      // Silently handle errors - retry count will be incremented
      return false;
    }
  }

  /**
   * Close a single-leg position with progressive price improvement
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
            this.logger.error(`🚨 Closing single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType}...`);
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
          // Wait longer to ensure position updates propagate
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Clear any position caches before checking
          if ('clearPositionCache' in adapter && typeof (adapter as any).clearPositionCache === 'function') {
            (adapter as any).clearPositionCache();
          }
          
          const currentPositions = await adapter.getPositions();
          const positionStillExists = currentPositions.some(
            (p) =>
              p.symbol === position.symbol &&
              p.exchangeType === position.exchangeType &&
              Math.abs(p.size) > 0.0001, // Filter out very small positions (rounding errors)
          );
          
          if (closeResponse.isFilled() && !positionStillExists) {
            positionClosed = true;
            this.logger.log(`✅ Closed single-leg position: ${position.symbol} on ${position.exchangeType}`);
            break; // Position closed successfully
          }
          
          if (attempt < priceImprovements.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before next attempt
          }
        } catch (attemptError: any) {
          if (attempt === priceImprovements.length - 1) {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      if (!positionClosed) {
        this.logger.error(
          `❌ Failed to close single-leg position ${position.symbol} on ${position.exchangeType} after ${priceImprovements.length} attempts`,
        );
      }
    } catch (error: any) {
      this.logger.error(`❌ Error closing single-leg position ${position.symbol} on ${position.exchangeType}: ${error.message}`);
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
      this.logger.error(`Error closing position ${position.symbol} on ${position.exchangeType}: ${error.message}`);
    }
  }
}

