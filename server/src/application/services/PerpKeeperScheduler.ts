import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { PerpKeeperOrchestrator } from '../../domain/services/PerpKeeperOrchestrator';
import { ConfigService } from '@nestjs/config';
import { PerpKeeperPerformanceLogger } from '../../infrastructure/logging/PerpKeeperPerformanceLogger';
import { PerpKeeperService } from './PerpKeeperService';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import {
  PerpOrderRequest,
  PerpOrderResponse,
  OrderSide,
  OrderType,
  TimeInForce,
  OrderStatus,
} from '../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../domain/entities/PerpPosition';
import { ArbitrageOpportunity } from '../../domain/services/FundingRateAggregator';
import { Contract, JsonRpcProvider, Wallet, formatUnits } from 'ethers';
import * as cliProgress from 'cli-progress';
import type {
  IOptimalLeverageService,
  LeverageAlert,
} from '../../domain/ports/IOptimalLeverageService';
import { DiagnosticsService } from '../../infrastructure/services/DiagnosticsService';
import { WithdrawalFulfiller } from '../../infrastructure/adapters/blockchain/WithdrawalFulfiller';
import { NAVReporter } from '../../infrastructure/adapters/blockchain/NAVReporter';
import { RealFundingPaymentsService } from '../../infrastructure/services/RealFundingPaymentsService';
import {
  PositionStateRepository,
  PersistedPositionState,
} from '../../infrastructure/repositories/PositionStateRepository';
import { ExecutionLockService } from '../../infrastructure/services/ExecutionLockService';
import { MarketQualityFilter } from '../../domain/services/MarketQualityFilter';
import {
  createMutex,
  AsyncMutex,
} from '../../infrastructure/services/AsyncMutex';
import { LiquidationMonitorService } from '../../domain/services/LiquidationMonitorService';
import { MarketStateService } from '../../infrastructure/services/MarketStateService';
import { OrderBookCollector } from '../../domain/services/twap/OrderBookCollector';
import { BalanceManager } from '../../domain/services/strategy-rules/BalanceManager';
import { OpportunityEvaluator } from '../../domain/services/strategy-rules/OpportunityEvaluator';
import { ExecutionPlanBuilder } from '../../domain/services/strategy-rules/ExecutionPlanBuilder';
import { IPerpExchangeAdapter } from '../../domain/ports/IPerpExchangeAdapter';

import { StrategyConfig } from '../../domain/value-objects/StrategyConfig';

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

  // Mutex to protect singleLegRetries and filteredOpportunities from concurrent access
  private readonly retryStateMutex: AsyncMutex = createMutex(
    'retryState',
    10000,
  );

  // Mutex to serialize @Interval tasks that aren't protected by global lock
  private readonly intervalMutex: AsyncMutex = createMutex(
    'intervalTasks',
    60000,
  );

  // Pending opportunity search trigger (set when positions are closed)
  private pendingOpportunitySearch: string | null = null;

  // Profit-taking cooldown: prevents re-entry until price reverts
  // Key: normalized symbol, Value: exit info for cooldown check
  private readonly profitTakeCooldowns: Map<
    string,
    {
      exitTime: Date;
      exitPriceLong: number;   // Mark price on long exchange at exit
      exitPriceShort: number;  // Mark price on short exchange at exit
      profitPercent: number;   // How much profit we took (to calculate reversion threshold)
      longExchange: ExchangeType;
      shortExchange: ExchangeType;
    }
  > = new Map();

  constructor(
    private readonly orchestrator: PerpKeeperOrchestrator,
    private readonly configService: ConfigService,
    private readonly performanceLogger: PerpKeeperPerformanceLogger,
    private readonly keeperService: PerpKeeperService,
    private readonly strategyConfig: StrategyConfig,
    @Optional()
    @Inject('IOptimalLeverageService')
    private readonly optimalLeverageService?: IOptimalLeverageService,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
    @Optional() private readonly withdrawalFulfiller?: WithdrawalFulfiller,
    @Optional() private readonly navReporter?: NAVReporter,
    @Optional()
    private readonly fundingPaymentsService?: RealFundingPaymentsService,
    @Optional()
    private readonly positionStateRepository?: PositionStateRepository,
    @Optional() private readonly executionLockService?: ExecutionLockService,
    @Optional() private readonly marketQualityFilter?: MarketQualityFilter,
    @Optional()
    private readonly liquidationMonitor?: LiquidationMonitorService,
    @Optional() private readonly marketStateService?: MarketStateService,
    @Optional() private readonly orderBookCollector?: OrderBookCollector,
    @Optional() private readonly balanceManager?: BalanceManager,
    @Optional()
    @Inject('IFundingRatePredictionService')
    private readonly predictionService?: any, // IFundingRatePredictionService
    @Optional() private readonly opportunityEvaluator?: OpportunityEvaluator,
    @Optional() private readonly executionPlanBuilder?: ExecutionPlanBuilder,
  ) {
    // Initialize orchestrator with exchange adapters
    const adapters = this.keeperService.getExchangeAdapters();
    const spotAdapters = this.keeperService.getSpotAdapters();
    this.orchestrator.initialize(adapters, spotAdapters);
    // Removed initialization log - only execution logs shown

    // Initialize liquidation monitor with adapters
    if (this.liquidationMonitor) {
      this.liquidationMonitor.initialize(adapters);
      // Configure based on environment
      const emergencyThreshold = parseFloat(
        this.configService.get<string>('LIQUIDATION_EMERGENCY_THRESHOLD') ||
          '0.9',
      );
      const enableEmergencyClose =
        this.configService.get<string>('LIQUIDATION_EMERGENCY_CLOSE_ENABLED') !==
        'false';
      this.liquidationMonitor.updateConfig({
        emergencyCloseThreshold: emergencyThreshold,
        enableEmergencyClose,
        checkIntervalMs: 30000, // 30 seconds
      });
      this.logger.log(
        `🛡️ LiquidationMonitor configured: threshold=${emergencyThreshold * 100}%, ` +
          `emergency close=${enableEmergencyClose ? 'ENABLED' : 'DISABLED'}`,
      );
    }

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

    const blacklistEnv = this.configService.get<string>(
      'KEEPER_BLACKLISTED_SYMBOLS',
    );
    if (blacklistEnv) {
      // Split by comma and filter out empty strings, then normalize
      const blacklistArray = blacklistEnv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => normalizeSymbol(s));

      this.blacklistedSymbols = new Set(blacklistArray);
      // Removed blacklist loading logs - only execution logs shown
    } else {
      // Default blacklist: NVDA (experimental market)
      this.blacklistedSymbols = new Set(['NVDA']);
      // Removed default blacklist log - only execution logs shown
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
      this.symbols = symbolsEnv
        .split(',')
        .map((s) => s.trim())
        .filter((s) => {
          const normalized = normalizeSymbol(s);
          return !this.blacklistedSymbols.has(normalized);
        });
      this.logger.log(
        `Scheduler initialized with configured symbols: ${this.symbols.join(',')}`,
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
        const filtered = symbolsEnv
          .split(',')
          .map((s) => s.trim())
          .filter((s) => {
            const normalized = normalizeSymbol(s);
            return this.blacklistedSymbols.has(normalized);
          });
        this.logger.warn(
          `Filtered out blacklisted symbols from KEEPER_SYMBOLS: ${filtered.join(', ')}`,
        );
      }
    } else {
      this.logger.log(
        `Scheduler initialized - will auto-discover all assets on first run (excluding blacklisted symbols)`,
      );
    }

    this.minSpread = parseFloat(
      this.configService.get<string>('KEEPER_MIN_SPREAD') || '0.0001',
    );
    this.maxPositionSizeUsd = parseFloat(
      this.configService.get<string>('KEEPER_MAX_POSITION_SIZE_USD') || '10000',
    );

    // Removed configuration log - only execution logs shown
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

    // Group positions by NORMALIZED symbol to handle different formats across exchanges
    // e.g., "MEGA" (Hyperliquid) vs "MEGA-USD" (Lighter) should be grouped together
    const positionsBySymbol = new Map<string, PerpPosition[]>();
    for (const position of positions) {
      const normalizedSymbol = this.normalizeSymbol(position.symbol);
      if (!positionsBySymbol.has(normalizedSymbol)) {
        positionsBySymbol.set(normalizedSymbol, []);
      }
      positionsBySymbol.get(normalizedSymbol)!.push(position);
    }

    const singleLegPositions: PerpPosition[] = [];

    // Log all positions for debugging
    this.logger.debug(
      `🔍 Analyzing ${positions.length} positions for single-leg detection: ` +
      `${Array.from(positionsBySymbol.entries()).map(([sym, pos]) => 
        `${sym}: ${pos.map(p => `${p.side} on ${p.exchangeType}`).join(', ')}`
      ).join(' | ')}`
    );

    for (const [symbol, symbolPositions] of positionsBySymbol) {
      // For arbitrage, we need both LONG and SHORT positions on DIFFERENT exchanges
      const longPositions = symbolPositions.filter(
        (p) => p.side === OrderSide.LONG,
      );
      const shortPositions = symbolPositions.filter(
        (p) => p.side === OrderSide.SHORT,
      );

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

      // Log the analysis for this symbol
      this.logger.debug(
        `📊 ${symbol}: LONGs=${longPositions.length} (${longPositions.map(p => p.exchangeType).join(',')}), ` +
        `SHORTs=${shortPositions.length} (${shortPositions.map(p => p.exchangeType).join(',')}), ` +
        `hasLongOnDiffExch=${hasLongOnDifferentExchange}, hasShortOnDiffExch=${hasShortOnDifferentExchange}`
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
      // Reconcile persisted position state with actual exchange positions
      await this.reconcilePositions();

      // Update performance metrics immediately on startup so APY is available
      // This populates fundingSnapshots for estimated APY AND syncs real funding payments
      try {
        // Link prediction service to diagnostics
        if (this.diagnosticsService && this.predictionService) {
          this.diagnosticsService.setPredictionService(this.predictionService);
        }

        await this.syncFundingPayments(); // Fetch actual funding payments for Realized APY
        await this.updatePerformanceMetrics(); // Update position metrics for Estimated APY
        this.logger.log('📊 Initial performance metrics loaded (estimated + realized APY)');
      } catch (error: any) {
        this.logger.warn(`Failed to load initial metrics: ${error.message}`);
      }

      // Removed startup log - execution logs will show when it runs
      await this.executeHourly();
    }, 2000); // 2 second delay to ensure all services are ready
  }

  /**
   * Reconcile persisted position states with actual exchange positions
   * This runs on startup to detect:
   * - Orphaned single-leg positions that need attention
   * - Positions that were completed while service was down
   * - Stale position states that should be cleaned up
   */
  private async reconcilePositions(): Promise<void> {
    if (!this.positionStateRepository) {
      this.logger.debug(
        'Position state repository not available, skipping reconciliation',
      );
      return;
    }

    this.logger.log('🔄 Starting position state reconciliation...');

    try {
      // Get all persisted active positions
      const persistedPositions = this.positionStateRepository.getActive();
      if (persistedPositions.length === 0) {
        this.logger.log('No active persisted positions to reconcile');
        return;
      }

      this.logger.log(
        `Found ${persistedPositions.length} active persisted positions to reconcile`,
      );

      // Get actual positions from all exchanges
      const actualPositions = await this.getAllExchangePositions();
      this.logger.log(
        `Found ${actualPositions.length} actual positions across exchanges`,
      );

      // Build a map of actual positions by symbol and exchange
      const actualPositionMap = new Map<string, PerpPosition[]>();
      for (const position of actualPositions) {
        const key = position.symbol;
        if (!actualPositionMap.has(key)) {
          actualPositionMap.set(key, []);
        }
        actualPositionMap.get(key)!.push(position);
      }

      // Reconcile each persisted position
      let reconciled = 0;
      let singleLegFound = 0;
      let closed = 0;

      for (const persisted of persistedPositions) {
        const symbolPositions = actualPositionMap.get(persisted.symbol) || [];

        // Find matching positions on long and short exchanges
        const longPosition = symbolPositions.find(
          (p) =>
            p.exchangeType === persisted.longExchange &&
            p.side === OrderSide.LONG,
        );
        const shortPosition = symbolPositions.find(
          (p) =>
            p.exchangeType === persisted.shortExchange &&
            p.side === OrderSide.SHORT,
        );

        const hasLong = !!longPosition && Math.abs(longPosition.size) > 0.0001;
        const hasShort =
          !!shortPosition && Math.abs(shortPosition.size) > 0.0001;

        if (hasLong && hasShort) {
          // Both legs exist - position is complete
          if (persisted.status !== 'COMPLETE') {
            await this.positionStateRepository.markComplete(persisted.id);
            this.logger.log(
              `✅ Reconciled ${persisted.symbol}: marked as COMPLETE (both legs found)`,
            );
            reconciled++;
          }
        } else if (hasLong || hasShort) {
          // Only one leg exists - single-leg position
          if (persisted.status !== 'SINGLE_LEG') {
            await this.positionStateRepository.markSingleLeg(
              persisted.id,
              hasLong,
              hasShort,
            );
            this.logger.warn(
              `⚠️ Reconciled ${persisted.symbol}: marked as SINGLE_LEG ` +
                `(long: ${hasLong ? 'YES' : 'NO'}, short: ${hasShort ? 'YES' : 'NO'})`,
            );
            singleLegFound++;
          }
        } else {
          // Neither leg exists - position was closed
          if (persisted.status !== 'CLOSED') {
            await this.positionStateRepository.markClosed(persisted.id);
            this.logger.log(
              `🔒 Reconciled ${persisted.symbol}: marked as CLOSED (no positions found)`,
            );
            closed++;
          }
        }
      }

      // Clean up old closed positions
      const cleanedUp =
        await this.positionStateRepository.cleanupOldPositions(7);

      this.logger.log(
        `✅ Position reconciliation complete: ` +
          `${reconciled} reconciled, ${singleLegFound} single-leg found, ` +
          `${closed} marked closed, ${cleanedUp} cleaned up`,
      );

      // Report single-leg positions to diagnostics
      if (singleLegFound > 0 && this.diagnosticsService) {
        const singleLegPositions =
          this.positionStateRepository.getSingleLegPositions();
        for (const pos of singleLegPositions) {
          this.diagnosticsService.recordSingleLegStart({
            id: pos.id,
            symbol: pos.symbol,
            exchange: pos.longFilled ? pos.longExchange : pos.shortExchange,
            side: pos.longFilled ? 'LONG' : 'SHORT',
            startedAt: pos.createdAt,
            retryCount: pos.retryCount || 0,
          });
        }
      }
    } catch (error: any) {
      this.logger.error(`Position reconciliation failed: ${error.message}`);
      if (error.stack) {
        this.logger.debug(`Reconciliation error stack: ${error.stack}`);
      }
    }
  }

  /**
   * Get all positions from all configured exchanges
   */
  private async getAllExchangePositions(): Promise<PerpPosition[]> {
    const adapters = this.keeperService.getExchangeAdapters();
    const allPositions: PerpPosition[] = [];

    for (const [exchangeType, adapter] of adapters) {
      try {
        const positions = await adapter.getPositions();
        // Positions should already have exchangeType set by the adapter
        // If not, we need to create new positions with the correct exchange type
        for (const pos of positions) {
          if (pos.exchangeType !== exchangeType) {
            // Create a new position with the correct exchange type
            const taggedPosition = new PerpPosition(
              exchangeType,
              pos.symbol,
              pos.side,
              pos.size,
              pos.entryPrice,
              pos.markPrice,
              pos.unrealizedPnl,
              pos.leverage,
              pos.liquidationPrice,
              pos.marginUsed,
              pos.timestamp,
              pos.lastUpdated,
            );
            allPositions.push(taggedPosition);
          } else {
            allPositions.push(pos);
          }
        }
      } catch (error: any) {
        this.logger.warn(
          `Failed to get positions from ${exchangeType}: ${error.message}`,
        );
      }
    }

    return allPositions;
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
   * Normalize symbol for consistent cache keys
   */
  private normalizeSymbol(symbol: string): string {
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
   * Schedule an opportunity search after positions are closed.
   * This allows capital to be quickly redeployed to new opportunities.
   * 
   * @param reason The reason for the search (for logging)
   */
  private scheduleOpportunitySearch(reason: string): void {
    this.pendingOpportunitySearch = reason;
    this.logger.log(
      `🔄 Opportunity search scheduled (reason: ${reason}) - will execute shortly`
    );
    
    // Execute after a short delay to allow positions to settle
    setTimeout(() => this.executePendingOpportunitySearch(), 5000);
  }

  /**
   * Execute a pending opportunity search if one is scheduled.
   * This is called after positions are closed to quickly redeploy capital.
   */
  private async executePendingOpportunitySearch(): Promise<void> {
    const reason = this.pendingOpportunitySearch;
    if (!reason) {
      return; // No pending search
    }
    
    // Clear the pending search
    this.pendingOpportunitySearch = null;
    
    // Skip if main execution is already running
    if (this.isRunning) {
      this.logger.debug(
        `Skipping opportunity search (${reason}) - main execution is running`
      );
      return;
    }
    
    // Acquire global lock
    const threadId = this.executionLockService?.generateThreadId() || `opp-search-${Date.now()}`;
    if (
      this.executionLockService &&
      !this.executionLockService.tryAcquireGlobalLock(threadId, `opportunity-search-${reason}`)
    ) {
      this.logger.debug(
        `Skipping opportunity search (${reason}) - could not acquire global lock`
      );
      return;
    }
    
    try {
      this.logger.log(
        `🔍 Searching for new opportunities after ${reason}...`
      );
      
      // Refresh market state
      if (this.marketStateService) {
        await this.marketStateService.refreshAll();
      }
      
      // Discover symbols
      const symbols = await this.discoverAssetsIfNeeded();
      if (symbols.length === 0) {
        this.logger.log('No symbols available for opportunity search');
        return;
      }
      
      // Filter out blacklisted symbols
      const filteredSymbols = symbols.filter((s) => !this.isBlacklisted(s));
      
      // Don't filter out existing positions - the opportunity evaluation and 
      // position sizing logic already handles whether to add to existing positions
      // based on volume limits, liquidity bounds, etc.
      
      // Execute arbitrage strategy for all available symbols
      const result = await this.orchestrator.executeArbitrageStrategy(
        filteredSymbols,
        this.minSpread,
        this.maxPositionSizeUsd,
      );
      
      if (result.opportunitiesExecuted > 0) {
        this.logger.log(
          `✅ Found and executed ${result.opportunitiesExecuted} new opportunity/opportunities ` +
          `after ${reason} (expected return: $${result.totalExpectedReturn.toFixed(4)}/period)`
        );
        
        // Update performance metrics
        await this.syncFundingPayments();
        await this.updatePerformanceMetrics();
      } else {
        this.logger.log(
          `No profitable opportunities found after ${reason} ` +
          `(evaluated ${result.opportunitiesEvaluated} opportunities)`
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Opportunity search after ${reason} failed: ${error.message}`
      );
    } finally {
      // Release global lock
      if (this.executionLockService) {
        this.executionLockService.releaseGlobalLock(threadId);
      }
    }
  }

  /**
   * Discover all common assets across exchanges (with caching)
   */
  private async discoverAssetsIfNeeded(): Promise<string[]> {
    const now = Date.now();

    // Use cache if available and fresh
    if (
      this.symbols.length > 0 &&
      now - this.lastDiscoveryTime < this.DISCOVERY_CACHE_TTL
    ) {
      // Still filter blacklisted symbols from cache (defensive)
      const filtered = this.symbols.filter((s) => !this.isBlacklisted(s));
      if (filtered.length !== this.symbols.length) {
        const removed = this.symbols.filter((s) => this.isBlacklisted(s));
        // Removed cache filtering log - only execution logs shown
        this.symbols = filtered;
      }
      return this.symbols;
    }

    // Auto-discover all assets
    try {
      const discoveredSymbols = await this.orchestrator.discoverCommonAssets();

      // Filter out blacklisted symbols using normalized comparison
      this.symbols = discoveredSymbols.filter((s) => !this.isBlacklisted(s));
      this.lastDiscoveryTime = now;

      /* DISABLED BACKGROUND COLLECTION TO STOP LOOPING
      // Start order book collection for discovered symbols (after a delay to give WS time to warm up)
      if (this.orderBookCollector && this.symbols.length > 0 && !this.orderBookCollector.isCollectingStatus()) {
        setTimeout(() => {
          if (this.orderBookCollector && this.symbols.length > 0) {
            this.logger.log(`📊 Starting background order book collection for ${this.symbols.length} symbols`);
            this.orderBookCollector.startCollection(this.symbols);
          }
        }, 30000); // 30 second delay
      } else if (this.orderBookCollector && this.symbols.length > 0) {
        this.orderBookCollector.addSymbols(this.symbols);
      }
      */

      // Removed discovery logs - only execution logs shown
      return this.symbols;
    } catch (error: any) {
      // Removed discovery error log - only execution logs shown
      // Fallback to defaults if discovery fails
      if (this.symbols.length === 0) {
        this.symbols = ['ETH', 'BTC'];
        // Removed fallback log - only execution logs shown
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
    if (this.isRunning) {
      // Removed "still running" log - only execution logs shown
      return;
    }

    // Acquire global lock to prevent concurrent executions
    const threadId =
      this.executionLockService?.generateThreadId() || `hourly-${Date.now()}`;
    if (
      this.executionLockService &&
      !this.executionLockService.tryAcquireGlobalLock(threadId, 'executeHourly')
    ) {
      this.logger.warn(
        '⏳ Another execution is in progress - skipping hourly execution',
      );
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      this.logger.log('🚀 Starting execution cycle...');

      // Refresh market state cache (positions and prices) at the start of every cycle
      // This allows all subsequent checks to use the same snapshot of positions
      if (this.marketStateService) {
        await this.marketStateService.refreshAll();
      }

      // Auto-discover all assets if not configured
      const symbols = await this.discoverAssetsIfNeeded();

      if (symbols.length === 0) {
        // Removed "no assets" log - only execution logs shown
        return;
      }

      // Check balances before proceeding (silent unless error)
      try {
        await this.checkBalances();
      } catch (error: any) {
        this.logger.error(`Balance check failed: ${error.message}`);
      }

      // Health check (silent unless error)
      try {
        const healthCheck = await this.orchestrator.healthCheck();
        if (!healthCheck.healthy) {
          // Removed health check log - only execution logs shown
          return;
        }
      } catch (error: any) {
        this.logger.error(`Health check failed: ${error.message}`);
        return;
      }

      // Filter out blacklisted symbols before finding opportunities (defensive check)
      const filteredSymbols = symbols.filter((s) => !this.isBlacklisted(s));

      // Find and filter opportunities
      const filteredOpportunities =
        await this.findAndFilterOpportunities(filteredSymbols);

      // 2. Manage active positions (LP-style recentering and rebalancing)
      await this.manageActivePositions();

      // Rebalance exchange balances based on opportunities
      await this.rebalanceIfNeeded(filteredOpportunities);

      // Skip execution if no opportunities
      if (filteredOpportunities.length === 0) {
        this.logger.log(
          'No opportunities found (after blacklist filter), skipping execution',
        );
        return;
      }

      // Execute strategy and track results
      const result = await this.executeStrategyAndTrack(
        filteredSymbols,
        startTime,
      );
    } catch (error: any) {
      this.logger.error(
        `Hourly execution failed: ${error.message}`,
        error.stack,
      );
    } finally {
      this.isRunning = false;
      // Release global lock
      if (this.executionLockService) {
        this.executionLockService.releaseGlobalLock(threadId);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXECUTION HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find arbitrage opportunities and filter out blacklisted symbols
   * Includes both perp-perp and perp-spot opportunities (enabled by default)
   */
  private async findAndFilterOpportunities(
    symbols: string[],
  ): Promise<ArbitrageOpportunity[]> {
    // Enable perp-spot by default (set PERP_SPOT_ENABLED=false to disable)
    const includePerpSpot =
      this.configService.get<string>('PERP_SPOT_ENABLED') !== 'false';

    const opportunities = await this.orchestrator.findArbitrageOpportunities(
      symbols,
      this.minSpread,
      false, // Hide progress bar
      includePerpSpot,
    );

    // Filter out any opportunities for blacklisted symbols (static blacklist)
    let filtered = opportunities.filter(
      (opp) => !this.isBlacklisted(opp.symbol),
    );

    // Filter out symbols that already have positions
    if (this.marketStateService) {
      const existingPositions = this.marketStateService.getAllPositions();
      const symbolsWithPositions = new Set(
        existingPositions.map((p) => this.normalizeSymbol(p.symbol))
      );

      if (symbolsWithPositions.size > 0) {
        const beforeCount = filtered.length;
        filtered = filtered.filter(
          (opp) => !symbolsWithPositions.has(this.normalizeSymbol(opp.symbol))
        );
        const filteredCount = beforeCount - filtered.length;
        if (filteredCount > 0) {
          this.logger.debug(
            `🔍 Filtered out ${filteredCount} opportunity(ies) for symbols with existing positions: ` +
            Array.from(symbolsWithPositions).join(', ')
          );
        }
      }
    }

    // Apply dynamic market quality filter (automatic blacklisting based on execution failures)
    if (this.marketQualityFilter) {
      const {
        passed,
        filtered: qualityFiltered,
        reasons,
      } = this.marketQualityFilter.filterOpportunities(filtered);

      if (qualityFiltered.length > 0) {
        this.logger.warn(
          `🚫 Market quality filter removed ${qualityFiltered.length} opportunity(ies): ` +
            qualityFiltered
              .map(
                (o) =>
                  `${o.symbol} (${reasons.get(`${o.symbol}-${o.longExchange}`) || reasons.get(o.symbol) || 'quality'})`,
              )
              .join(', '),
        );
      }

      filtered = passed;
    }

    // Apply profit-taking cooldown filter (prevents re-entry at same price after taking profit)
    const beforeCooldownCount = filtered.length;
    filtered = filtered.filter((opp) => {
      const normalizedSymbol = this.normalizeSymbol(opp.symbol);
      const cooldownCheck = this.isInProfitTakeCooldown(
        normalizedSymbol,
        opp.longMarkPrice || 0,
        opp.shortMarkPrice || 0,
      );
      
      if (cooldownCheck.inCooldown) {
        this.logger.debug(
          `🔒 Skipping ${opp.symbol}: ${cooldownCheck.reason}`
        );
        return false;
      }
      return true;
    });
    
    const cooldownFilteredCount = beforeCooldownCount - filtered.length;
    if (cooldownFilteredCount > 0) {
      this.logger.log(
        `🔒 Profit-take cooldown filtered ${cooldownFilteredCount} opportunity(ies) - ` +
        `waiting for price reversion before re-entry`
      );
    }

    return filtered;
  }

  /**
   * Manage active positions using an LP-style approach (Recentering vs Closing)
   */
  private async manageActivePositions(): Promise<void> {
    try {
      this.logger.log('📈 Managing active positions (LP-style check)...');
      
      const positionsResult = await this.orchestrator.getAllPositionsWithMetrics();
      const allPositions = positionsResult.positions.filter(p => Math.abs(p.size) > 0.0001);

      if (allPositions.length === 0) return;

      // Group positions by symbol
      const positionsBySymbol = new Map<string, PerpPosition[]>();
      for (const pos of allPositions) {
        const sym = this.normalizeSymbol(pos.symbol);
        if (!positionsBySymbol.has(sym)) positionsBySymbol.set(sym, []);
        positionsBySymbol.get(sym)!.push(pos);
      }

      // 1. Handle single-leg positions (Emergency Fix)
      const remainingPositions = await this.handleSingleLegPositions(allPositions);

      // 2. Recenter healthy positions (LP-Style)
      // Map back to grouped structure
      const remainingBySymbol = new Map<string, PerpPosition[]>();
      for (const pos of remainingPositions) {
        const sym = this.normalizeSymbol(pos.symbol);
        if (!remainingBySymbol.has(sym)) remainingBySymbol.set(sym, []);
        remainingBySymbol.get(sym)!.push(pos);
      }

      for (const [symbol, symbolPositions] of remainingBySymbol.entries()) {
        const longPos = symbolPositions.find(p => p.side === OrderSide.LONG);
        const shortPos = symbolPositions.find(p => p.side === OrderSide.SHORT);

        if (longPos && shortPos) {
          // Hedged pair - check and recenter simultaneously
          await this.checkAndRecenterHedgedPosition(longPos, shortPos);
        } else {
          // Single position (should have been handled by single-leg handler, but just in case)
          for (const pos of symbolPositions) {
            await this.checkAndRecenterPosition(pos);
          }
        }
      }

    } catch (error: any) {
      this.logger.warn(`Failed during position management: ${error.message}`);
    }
  }

  /**
   * Check and recenter a hedged pair simultaneously
   */
  private async checkAndRecenterHedgedPosition(longPos: PerpPosition, shortPos: PerpPosition): Promise<void> {
    try {
      if (!this.optimalLeverageService) return;

      // Use the logic from checkAndRecenterPosition but for both sides
      // We'll calculate reduction based on the leg that is CLOSER to liquidation (the "riskier" leg)
      
      const riskResults = await Promise.all([
        this.calculatePositionRecentering(longPos),
        this.calculatePositionRecentering(shortPos)
      ]);

      const maxReduction = Math.max(riskResults[0].reductionPercent, riskResults[1].reductionPercent);
      const tier = riskResults[0].reductionPercent >= riskResults[1].reductionPercent ? riskResults[0].tier : riskResults[1].tier;

      if (maxReduction > 0) {
        await this.orchestrator.executeHedgedPartialClose(longPos, shortPos, maxReduction, `Recentering (${tier})`);
      }
    } catch (error: any) {
      this.logger.debug(`Could not recenter hedged ${longPos.symbol}: ${error.message}`);
    }
  }

  /**
   * Calculate required recentering for a single position
   */
  private async calculatePositionRecentering(position: PerpPosition): Promise<{ reductionPercent: number, tier: string }> {
    try {
      if (!this.optimalLeverageService) return { reductionPercent: 0, tier: '' };

      const currentPrice = position.markPrice;
      const liqPrice = position.liquidationPrice;
      if (!liqPrice || liqPrice === 0) return { reductionPercent: 0, tier: '' };

      const distanceToLiq = Math.abs(currentPrice - liqPrice) / currentPrice;
      
      const recommendation = await this.optimalLeverageService.calculateOptimalLeverage(
        position.symbol,
        position.exchangeType,
        Math.abs(position.getPositionValue())
      );
      const targetDistance = 1 / recommendation.optimalLeverage;

      if (distanceToLiq < targetDistance * 0.15) return { reductionPercent: 0.20, tier: 'EMERGENCY (85%)' };
      if (distanceToLiq < targetDistance * 0.40) return { reductionPercent: 0.10, tier: 'MAINTAINING (60%)' };
      if (distanceToLiq < targetDistance * 0.70) return { reductionPercent: 0.05, tier: 'PROACTIVE (30%)' };

      return { reductionPercent: 0, tier: '' };
    } catch {
      return { reductionPercent: 0, tier: '' };
    }
  }

  /**
   * Check if a position needs "Recentering" (Laddered LP-style adjustment)
   */
  private async checkAndRecenterPosition(position: PerpPosition): Promise<void> {
    const { reductionPercent, tier } = await this.calculatePositionRecentering(position);
    
    if (reductionPercent > 0) {
      this.logger.warn(`⚖️ ${tier} Recentering ${position.symbol}: Reducing size by ${(reductionPercent * 100).toFixed(0)}%.`);
      const reductionSize = Math.abs(position.size) * reductionPercent;
      await this.orchestrator.executePartialClose(position, reductionSize, `Recentering (${tier})`);
    }
  }

  /**
   * Handle existing positions: detect single-leg, attempt recovery, close if needed
   */
  private async handleExistingPositions(): Promise<void> {
    try {
      const positionsResult =
        await this.orchestrator.getAllPositionsWithMetrics();
      // Filter out positions with very small sizes (likely rounding errors or stale data)
      let allPositions = positionsResult.positions.filter(
        (p) => Math.abs(p.size) > 0.0001,
      );

      if (allPositions.length === 0) return;

      // Handle single-leg positions first
      allPositions = await this.handleSingleLegPositions(allPositions);

      // Close remaining positions (non-single-leg)
      if (allPositions.length > 0) {
        this.logger.log(
          `🔄 Closing ${allPositions.length} existing position(s)...`,
        );
        for (const position of allPositions) {
          await this.closePositionWithRetry(position);
        }
        // Wait for positions to settle and margin to be freed
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (error: any) {
      this.logger.warn(`Failed to close existing positions: ${error.message}`);
      // Continue anyway - rebalancing might still work
    }
  }

  /**
   * Handle single-leg positions: attempt to open missing side, close if recovery fails
   * Returns remaining positions that are NOT single-leg
   */
  private async handleSingleLegPositions(
    allPositions: PerpPosition[],
  ): Promise<PerpPosition[]> {
    const singleLegPositions = this.detectSingleLegPositions(allPositions);

    if (singleLegPositions.length === 0) {
      return allPositions;
    }

    this.logger.warn(
      `⚠️ Detected ${singleLegPositions.length} single-leg position(s). Attempting to open missing side...`,
    );

    // Try to open missing side for each single-leg position
    for (const position of singleLegPositions) {
      const retrySuccess = await this.tryOpenMissingSide(position);

      if (!retrySuccess) {
        this.logger.error(
          `🚨 Closing single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType} after retries failed`,
        );
        await this.closeSingleLegPosition(position);
      }
    }

    // Wait for positions to settle
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify single-leg positions are resolved
    await this.verifySingleLegResolution();

    // Remove single-leg positions from allPositions to avoid double-closing
    const singleLegSet = new Set(
      singleLegPositions.map((p) => `${p.symbol}-${p.exchangeType}-${p.side}`),
    );
    return allPositions.filter(
      (p) => !singleLegSet.has(`${p.symbol}-${p.exchangeType}-${p.side}`),
    );
  }

  /**
   * Verify that single-leg positions have been resolved, with retry if needed
   */
  private async verifySingleLegResolution(): Promise<void> {
    const updatedPositionsResult =
      await this.orchestrator.getAllPositionsWithMetrics();
    const updatedPositions = updatedPositionsResult.positions.filter(
      (p) => Math.abs(p.size) > 0.0001,
    );
    const stillSingleLeg = this.detectSingleLegPositions(updatedPositions);

    if (stillSingleLeg.length === 0) {
      this.logger.log(
        `✅ All single-leg positions resolved. Triggering new opportunity search...`,
      );
      await this.triggerNewOpportunitySearch();
      return;
    }

    // Second attempt to close remaining single-leg positions
    this.logger.warn(
      `⚠️ Still detecting ${stillSingleLeg.length} single-leg position(s). Closing them...`,
    );

    for (const position of stillSingleLeg) {
      await this.closeSingleLegPosition(position);
    }

    // Wait and verify again
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const finalPositionsResult =
      await this.orchestrator.getAllPositionsWithMetrics();
    const finalPositions = finalPositionsResult.positions.filter(
      (p) => Math.abs(p.size) > 0.0001,
    );
    const finalSingleLeg = this.detectSingleLegPositions(finalPositions);

    if (finalSingleLeg.length === 0) {
      this.logger.log(
        `✅ All single-leg positions closed. Triggering new opportunity search...`,
      );
      await this.triggerNewOpportunitySearch();
    } else {
      this.logger.warn(
        `⚠️ Still detecting ${finalSingleLeg.length} single-leg position(s) after second close attempt. ` +
          `This may be stale data - will retry next cycle.`,
      );
    }
  }

  /**
   * Rebalance exchange balances if needed based on opportunities
   */
  private async rebalanceIfNeeded(
    _opportunities: ArbitrageOpportunity[],
  ): Promise<void> {
    // REBALANCING DISABLED FOR PRODUCTION SAFETY
    this.logger.warn('🚫 Exchange rebalancing is currently DISABLED');
    return;
    /* ORIGINAL CODE - uncomment to re-enable:
    try {
      const rebalanceResult =
        await this.keeperService.rebalanceExchangeBalances(_opportunities);
      if (rebalanceResult.transfersExecuted > 0) {
        this.logger.log(
          `✅ Rebalanced ${rebalanceResult.transfersExecuted} transfers, $${rebalanceResult.totalTransferred.toFixed(2)} total`,
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } catch (error: any) {
      this.logger.warn(
        `Failed to rebalance exchange balances: ${error.message}`,
      );
      // Don't fail the entire execution if rebalancing fails
    }
    */
  }

  /**
   * Execute strategy and track results
   */
  private async executeStrategyAndTrack(
    symbols: string[],
    startTime: number,
  ): Promise<void> {
    const symbolsToExecute = symbols.filter((s) => !this.isBlacklisted(s));

    const result = await this.orchestrator.executeArbitrageStrategy(
      symbolsToExecute,
      this.minSpread,
      this.maxPositionSizeUsd,
    );

    // Track arbitrage opportunities
    this.performanceLogger.recordArbitrageOpportunity(
      true,
      result.opportunitiesExecuted > 0,
    );
    if (result.opportunitiesExecuted > 0) {
      this.performanceLogger.recordArbitrageOpportunity(false, true);
    }

    // Sync funding payments and update position metrics
    await this.syncFundingPayments();
    await this.updatePerformanceMetrics();

    const duration = Date.now() - startTime;

    this.logger.log(
      `Execution completed in ${duration}ms: ` +
        `${result.opportunitiesExecuted}/${result.opportunitiesEvaluated} opportunities executed, ` +
        `Expected return: $${result.totalExpectedReturn.toFixed(2)}, ` +
        `Orders placed: ${result.ordersPlaced}`,
    );

    // Log portfolio summary
    await this.logPortfolioSummary();

    if (result.errors.length > 0) {
      this.logger.warn(
        `Execution had ${result.errors.length} errors:`,
        result.errors,
      );
    }
  }

  /**
   * Log portfolio summary at end of execution cycle
   */
  private async logPortfolioSummary(): Promise<void> {
    try {
      const totalCapital = await this.getTotalCapitalAcrossExchanges();
      this.performanceLogger.logCompactSummary(totalCapital);
    } catch (error: any) {
      // Silently fail portfolio logging
    }
  }

  /**
   * Get total capital across all exchanges
   */
  private async getTotalCapitalAcrossExchanges(): Promise<number> {
    let totalCapital = 0;
    for (const exchangeType of [
      ExchangeType.LIGHTER,
      ExchangeType.HYPERLIQUID,
    ]) {
      try {
        const balance = await this.keeperService.getBalance(exchangeType);
        totalCapital += balance;
      } catch (error) {
        // Skip if we can't get balance
      }
    }
    return totalCapital;
  }

  /**
   * Sync funding payments from all exchanges
   * This ensures Real APY and Net Funding are up-to-date
   */
  private async syncFundingPayments(): Promise<void> {
    if (!this.fundingPaymentsService) {
      return; // Service not available
    }

    try {
      // Fetch funding payments from all exchanges (cached, won't spam APIs)
      const payments =
        await this.fundingPaymentsService.fetchAllFundingPayments(30);

      // Record each payment in the performance logger
      for (const payment of payments) {
        this.performanceLogger.recordFundingPayment(
          payment.exchange,
          payment.amount,
        );
      }

      this.logger.debug(
        `Synced ${payments.length} funding payments for performance metrics`,
      );
    } catch (error: any) {
      this.logger.warn(`Failed to sync funding payments: ${error.message}`);
      // Don't fail execution if funding sync fails
    }
  }

  /**
   * Update performance metrics with current positions and funding rates
   */
  private async updatePerformanceMetrics(): Promise<void> {
    try {
      const allPositions = await this.keeperService.getAllPositions();

      // Filter out positions with very small sizes (likely rounding errors or stale data)
      const positions = allPositions.filter((p) => Math.abs(p.size) > 0.0001);

      // Only get funding rates for symbols that have positions (not all discovered symbols)
      // This prevents excessive API calls that cause rate limiting
      const symbolsWithPositions = new Set(positions.map((p) => p.symbol));
      const allFundingRates: Array<{
        symbol: string;
        exchange: ExchangeType;
        fundingRate: number;
      }> = [];

      // Only fetch funding rates for symbols with active positions
      for (const symbol of symbolsWithPositions) {
        try {
          const comparison =
            await this.orchestrator.compareFundingRates(symbol);
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
        const exchangePositions =
          positionsByExchange.get(position.exchangeType) || [];
        exchangePositions.push(position);
        positionsByExchange.set(position.exchangeType, exchangePositions);
      }

      // Update metrics for each exchange
      for (const [
        exchange,
        exchangePositions,
      ] of positionsByExchange.entries()) {
        // Filter funding rates for this exchange
        const exchangeFundingRates = allFundingRates.filter(
          (rate) => rate.exchange === exchange,
        );
        this.performanceLogger.updatePositionMetrics(
          exchange,
          exchangePositions,
          exchangeFundingRates,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to update performance metrics: ${error.message}`,
      );
    }
  }

  /**
   * Update performance metrics periodically (every 2 minutes)
   * This ensures APY calculations are always up-to-date, even between hourly executions.
   * Critical for diagnostics endpoint to show accurate estimated AND realized APY.
   */
  @Interval(120000) // Every 2 minutes (120000 ms)
  async updatePerformanceMetricsPeriodically(): Promise<void> {
    try {
      // Sync actual funding payments from exchanges (for Realized APY)
      await this.syncFundingPayments();
      // Update position metrics with current funding rates (for Estimated APY)
      await this.updatePerformanceMetrics();
    } catch (error: any) {
      // Silently fail - this is just for diagnostics
      this.logger.debug(`Periodic metrics update failed: ${error.message}`);
    }
  }

  /**
   * Check for single-leg positions and try to open missing side
   * Runs every 60 seconds for FAST detection - single legs are our TOP PRIORITY
   * Policy: After all retries fail, close the single leg and move to next opportunity
   */
  @Interval(60000) // Every 60 seconds (was 5 min - single legs are TOP PRIORITY!)
  async checkAndRetrySingleLegPositions(): Promise<void> {
    // Skip if main execution is running (prevents race conditions)
    if (this.isRunning) {
      this.logger.debug(
        'Skipping single-leg check - main execution is running',
      );
      return;
    }

    // Try to acquire global lock to prevent concurrent executions
    const threadId =
      this.executionLockService?.generateThreadId() ||
      `single-leg-${Date.now()}`;
    if (
      this.executionLockService &&
      !this.executionLockService.tryAcquireGlobalLock(
        threadId,
        'checkAndRetrySingleLegPositions',
      )
    ) {
      this.logger.debug(
        'Skipping single-leg check - another execution is in progress',
      );
      return;
    }

    try {
      const positionsResult =
        await this.orchestrator.getAllPositionsWithMetrics();
      // Filter out positions with very small sizes (likely rounding errors or stale data)
      const allPositions = positionsResult.positions.filter(
        (p) => Math.abs(p.size) > 0.0001,
      );

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
          // Identify missing exchange (for 2-exchange arbitrage)
          // Most trades are Hyperliquid vs {Lighter, Aster}
          let missingExchange: ExchangeType | undefined;
          if (position.exchangeType === ExchangeType.HYPERLIQUID) {
            // If HL exists, missing is likely Lighter or Aster
            // We can't know for sure without looking at history, but we can check what's available
            missingExchange = ExchangeType.LIGHTER; // Default guess
          } else {
            // If Lighter/Aster exists, missing is likely Hyperliquid
            missingExchange = ExchangeType.HYPERLIQUID;
          }

          // Track single-leg start in diagnostics
          const singleLegId = `${position.symbol}-${position.exchangeType}-${position.side}`;
          this.diagnosticsService?.recordSingleLegStart({
            id: singleLegId,
            symbol: position.symbol,
            exchange: position.exchangeType,
            side: position.side as 'LONG' | 'SHORT',
            startedAt: new Date(),
            retryCount: 0,
            missingExchange,
            reason: `Detected orphaned ${position.side} leg on ${position.exchangeType}`,
          });

          const retrySuccess = await this.tryOpenMissingSide(position);

          if (retrySuccess) {
            // Single-leg resolved via fill
            this.diagnosticsService?.recordSingleLegResolved(
              singleLegId,
              'FILLED',
            );
          } else {
            // Retries exhausted - close the single leg position
            const missingInfo = missingExchange ? ` (Other leg on ${missingExchange} failed to fill)` : '';
            this.logger.error(
              `🚨 Closing single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType}${missingInfo} ` +
                `after all retry attempts failed. Will open 2 legs on next best opportunity.`,
            );
            await this.closeSingleLegPosition(position);
            anyClosed = true;

            // Track single-leg resolved via close
            this.diagnosticsService?.recordSingleLegResolved(
              singleLegId,
              'CLOSED',
            );
          }
        }

        // If any positions were closed, refresh positions and look for new opportunities
        if (anyClosed) {
          // Wait for positions to settle
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Refresh positions to ensure we have latest state
          const refreshedPositionsResult =
            await this.orchestrator.getAllPositionsWithMetrics();
          const refreshedPositions = refreshedPositionsResult.positions;

          // Verify positions are actually closed
          const stillSingleLeg =
            this.detectSingleLegPositions(refreshedPositions);
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
      this.logger.debug(
        `Error in checkAndRetrySingleLegPositions: ${error.message}`,
      );
    } finally {
      // Release global lock
      if (this.executionLockService) {
        this.executionLockService.releaseGlobalLock(threadId);
      }
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
      const filteredSymbols = symbols.filter((s) => !this.isBlacklisted(s));
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
      this.logger.warn(
        '⚠️  No exchange adapters available - cannot check balances',
      );
      return;
    }

    // Removed balance check log - only execution logs shown

    // Get all positions to calculate margin used
    const positionsResult =
      await this.orchestrator.getAllPositionsWithMetrics();
    const positionsByExchange = positionsResult.positionsByExchange;

    // Calculate margin used per exchange (position value / leverage)
    const leverage = parseFloat(
      this.configService.get<string>('KEEPER_LEVERAGE') || '2.0',
    );
    const marginUsedPerExchange = new Map<ExchangeType, number>();

    for (const [exchangeType, positions] of positionsByExchange) {
      const totalMarginUsed = positions.reduce((sum, pos) => {
        // Use marginUsed if available, otherwise calculate as positionValue / leverage
        const margin = pos.marginUsed ?? pos.getPositionValue() / leverage;
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

        balances.push({
          exchange,
          balance: freeBalance,
          marginUsed,
          totalCapital,
          unallocated,
          canTrade,
        });

        const status = canTrade ? '✅' : '⚠️';
        this.logger.log(
          `   ${status} ${exchange}:\n` +
            `      Free Balance: $${freeBalance.toFixed(2)}\n` +
            `      Margin Used: $${marginUsed.toFixed(2)}\n` +
            `      Total Capital: $${totalCapital.toFixed(2)}\n` +
            `      Unallocated: $${unallocated.toFixed(2)} ${canTrade ? '(can trade)' : `(need $${minBalanceForTrading}+)`}`,
        );

        // For HyperLiquid, also log equity to see total account value
        if (exchange === ExchangeType.HYPERLIQUID) {
          try {
            const equity = await this.keeperService.getEquity(exchange);
            this.logger.log(
              `      Equity: $${equity.toFixed(2)} (account value)`,
            );
          } catch (e) {
            // Ignore equity fetch errors
          }
        }
      } catch (error: any) {
        this.logger.warn(
          `   ❌ ${exchange}: Failed to check balance - ${error.message}`,
        );
        balances.push({
          exchange,
          balance: 0,
          marginUsed: 0,
          totalCapital: 0,
          unallocated: 0,
          canTrade: false,
        });
      }
    }

    // Calculate totals
    const tradableExchanges = balances.filter((b) => b.canTrade).length;
    const totalFreeBalance = balances.reduce((sum, b) => sum + b.balance, 0);
    const totalMarginUsed = balances.reduce((sum, b) => sum + b.marginUsed, 0);
    const totalCapitalOnExchanges = balances.reduce(
      (sum, b) => sum + b.totalCapital,
      0,
    );
    const totalUnallocatedOnExchanges = totalFreeBalance;
    const minBalance = Math.min(
      ...balances.map((b) => b.balance).filter((b) => b > 0),
    );

    // Check wallet USDC balance on-chain
    let walletUsdcBalance = 0;
    let walletAddress: string | null = null;
    try {
      walletUsdcBalance = await this.getWalletUsdcBalance();
      if (walletUsdcBalance > 0) {
        // Get wallet address for logging
        const privateKey = this.configService.get<string>('PRIVATE_KEY');
        if (privateKey) {
          const normalizedKey = privateKey.startsWith('0x')
            ? privateKey
            : `0x${privateKey}`;
          const wallet = new Wallet(normalizedKey);
          walletAddress = wallet.address;
        }
      }
    } catch (error: any) {
      this.logger.debug(
        `Failed to check wallet USDC balance: ${error.message}`,
      );
    }

    // Calculate total capital (on exchanges + in wallet)
    const totalCapitalAll = totalCapitalOnExchanges + walletUsdcBalance;
    const totalDeployed = totalMarginUsed;
    const totalUnallocatedAll = totalFreeBalance + walletUsdcBalance;

    // Removed balance check logs - only execution logs shown
    // Balance check errors will still be logged
  }

  /**
   * Check for idle capital and try to deploy it to best opportunities
   * Runs every 2 minutes to ensure capital is always working
   * This is more aggressive than the hourly execution cycle
   */
  @Interval(120000) // Every 2 minutes (120000 ms)
  async checkAndDeployIdleCapital(): Promise<void> {
    // Skip if main execution is running
    if (this.isRunning) {
      return;
    }

    // Try to acquire global lock
    const threadId =
      this.executionLockService?.generateThreadId() ||
      `idle-capital-${Date.now()}`;
    if (
      this.executionLockService &&
      !this.executionLockService.tryAcquireGlobalLock(
        threadId,
        'checkAndDeployIdleCapital',
      )
    ) {
      return;
    }

    try {
      const adapters = this.keeperService.getExchangeAdapters();
      if (adapters.size === 0) {
        return;
      }

      // Get current positions
      const positionsResult =
        await this.orchestrator.getAllPositionsWithMetrics();
      const allPositions = positionsResult.positions.filter(
        (p) => Math.abs(p.size) > 0.0001,
      );

      // Calculate total margin used
      let totalMarginUsed = 0;
      for (const position of allPositions) {
        const positionValue =
          Math.abs(position.size) * (position.markPrice || position.entryPrice);
        const leverage = 2.0; // Default leverage
        totalMarginUsed += positionValue / leverage;
      }

      // Get total balance across all exchanges
      let totalBalance = 0;
      for (const [, adapter] of adapters) {
        try {
          const balance = await adapter.getBalance();
          totalBalance += balance;
        } catch {
          // Skip failed exchanges
        }
      }

      // Calculate idle capital (balance not used as margin)
      const idleCapital = totalBalance - totalMarginUsed;
      const idlePercentage =
        totalBalance > 0 ? (idleCapital / totalBalance) * 100 : 0;

      // Only deploy if we have significant idle capital (> 20% of total or > $50)
      const MIN_IDLE_PERCENTAGE = 20;
      const MIN_IDLE_AMOUNT = 50;

      if (
        idleCapital < MIN_IDLE_AMOUNT &&
        idlePercentage < MIN_IDLE_PERCENTAGE
      ) {
        return; // Capital is well deployed
      }

      this.logger.log(
        `💰 Idle capital detected: $${idleCapital.toFixed(2)} (${idlePercentage.toFixed(1)}% of total). ` +
          `Searching for opportunities...`,
      );

      // Execute strategy to deploy idle capital
      const symbolsToExecute = this.symbols.filter(
        (s) => !this.isBlacklisted(s),
      );

      if (symbolsToExecute.length === 0) {
        this.logger.warn('No symbols available for idle capital deployment');
        return;
      }

      const result = await this.orchestrator.executeArbitrageStrategy(
        symbolsToExecute,
        this.minSpread,
        this.maxPositionSizeUsd,
      );

      if (result.opportunitiesExecuted > 0) {
        this.logger.log(
          `✅ Deployed idle capital: ${result.opportunitiesExecuted} position(s) opened, ` +
            `expected return: $${result.totalExpectedReturn.toFixed(4)}/period`,
        );
      } else if (result.errors.length > 0) {
        this.logger.warn(
          `⚠️ Failed to deploy idle capital: ${result.errors.slice(0, 3).join(', ')}`,
        );
      }
    } catch (error: any) {
      this.logger.debug(`Error checking idle capital: ${error.message}`);
    } finally {
      if (this.executionLockService) {
        this.executionLockService.releaseGlobalLock(threadId);
      }
    }
  }

  /**
   * Periodic wallet balance check - runs every 10 minutes
   * Checks for new USDC in wallet and deposits to exchanges if needed
   */
  @Interval(300000) // Every 5 minutes
  async cleanupZombieExecutions() {
    if (!this.executionLockService) return;

    try {
      this.logger.log('🧹 Checking for zombie executions (orphaned legs)...');
      const activeOrders = this.executionLockService.getAllActiveOrders();
      
      // Group orders by threadId
      const threads = new Map<string, typeof activeOrders>();
      for (const order of activeOrders) {
        if (!threads.has(order.threadId)) {
          threads.set(order.threadId, []);
        }
        threads.get(order.threadId)!.push(order);
      }

      for (const [threadId, orders] of threads.entries()) {
        // If it's a dual-leg execution (likely from findArbitrageOpportunities)
        // we expect 2 orders. If one is FAILED/CANCELLED and the other is PLACED/WAITING_FILL,
        // it's a zombie.
        if (orders.length === 1 && threadId.startsWith('thread-')) {
          // Check if this thread had another leg that failed (not in activeOrders anymore but in registry)
          // Wait, ExecutionLockService registry is the source of activeOrders.
          // If there's only 1 leg left in the registry for a 'thread-' prefixed ID,
          // it might be an orphaned leg from a parallel execution that partially failed.
          
          const order = orders[0];
          this.logger.warn(`🚨 Found orphaned leg in thread ${threadId}: ${order.symbol} ${order.side} on ${order.exchange}`);
          
          // Cleanup: Cancel the orphaned order
          const adapter = this.keeperService.getExchangeAdapters().get(order.exchange as ExchangeType);
          if (adapter) {
            this.logger.log(`🗑️ Rolling back orphaned order ${order.orderId} for ${order.symbol}`);
            try {
              await adapter.cancelOrder(order.orderId, order.symbol);
              this.executionLockService.forceClearOrder(order.exchange, order.symbol, order.side);
              this.logger.log(`✅ Successfully rolled back zombie order ${order.orderId}`);
            } catch (err: any) {
              this.logger.error(`Failed to rollback zombie order: ${err.message}`);
            }
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Error during zombie cleanup: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POST-EXECUTION FILL VERIFICATION - Fast corrective action for unbalanced fills
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Verify recent order fills and take corrective action if one leg is unfilled
   * 
   * This is our FAST response to asymmetric fills - runs every 20 seconds to catch
   * orders that have had their grace period but still aren't filled.
   * 
   * Grace period logic:
   * - Orders < 30 seconds old: Leave alone (give maker time to fill)
   * - Orders 30-90 seconds old: Check status, try aggressive price improvement
   * - Orders > 90 seconds old: If paired leg filled, MARKET order to match
   * 
   * This prevents large position imbalances from building up.
   */
  @Interval(20000) // Every 20 seconds - FAST response to fill issues
  async verifyRecentExecutionFills(): Promise<void> {
    if (!this.executionLockService) return;
    if (this.isRunning) return; // Don't interfere with active execution

    // Grace periods (configurable via env)
    const MIN_AGE_SECONDS = parseFloat(process.env.FILL_CHECK_MIN_AGE_SECONDS || '30');
    const AGGRESSIVE_AGE_SECONDS = parseFloat(process.env.FILL_CHECK_AGGRESSIVE_AGE_SECONDS || '60');
    const MARKET_ORDER_AGE_SECONDS = parseFloat(process.env.FILL_CHECK_MARKET_AGE_SECONDS || '90');

    try {
      const allOrders = this.executionLockService.getAllActiveOrders();
      if (allOrders.length === 0) return;

      const now = Date.now();

      // Group orders by symbol to find paired legs
      const ordersBySymbol = new Map<string, typeof allOrders>();
      for (const order of allOrders) {
        const normalizedSymbol = this.normalizeSymbol(order.symbol);
        if (!ordersBySymbol.has(normalizedSymbol)) {
          ordersBySymbol.set(normalizedSymbol, []);
        }
        ordersBySymbol.get(normalizedSymbol)!.push(order);
      }

      for (const [symbol, orders] of ordersBySymbol) {
        // Look for asymmetric situations (one FILLED/position exists, one still PENDING)
        const longOrders = orders.filter(o => o.side === 'LONG');
        const shortOrders = orders.filter(o => o.side === 'SHORT');

        // If we only have one side in orders, check if the other side has a position
        // (which would indicate one filled and one didn't)
        if (longOrders.length === 1 && shortOrders.length === 0) {
          await this.checkAndFixUnfilledLeg(longOrders[0], 'SHORT', symbol, now, MIN_AGE_SECONDS, AGGRESSIVE_AGE_SECONDS, MARKET_ORDER_AGE_SECONDS);
        } else if (shortOrders.length === 1 && longOrders.length === 0) {
          await this.checkAndFixUnfilledLeg(shortOrders[0], 'LONG', symbol, now, MIN_AGE_SECONDS, AGGRESSIVE_AGE_SECONDS, MARKET_ORDER_AGE_SECONDS);
        } else if (longOrders.length === 1 && shortOrders.length === 1) {
          // Both orders exist - check if one is filled and one is stuck
          await this.checkPairedOrderStatus(longOrders[0], shortOrders[0], symbol, now, MIN_AGE_SECONDS, AGGRESSIVE_AGE_SECONDS, MARKET_ORDER_AGE_SECONDS);
        }
      }
    } catch (error: any) {
      this.logger.debug(`Error in verifyRecentExecutionFills: ${error.message}`);
    }
  }

  /**
   * Check paired orders and take action if one is filled but the other isn't
   */
  private async checkPairedOrderStatus(
    longOrder: any,
    shortOrder: any,
    symbol: string,
    now: number,
    minAgeSec: number,
    aggressiveAgeSec: number,
    marketAgeSec: number,
  ): Promise<void> {
    const longAgeMs = now - longOrder.placedAt.getTime();
    const shortAgeMs = now - shortOrder.placedAt.getTime();
    const longAgeSec = longAgeMs / 1000;
    const shortAgeSec = shortAgeMs / 1000;

    // Both orders too young - let them cook
    if (longAgeSec < minAgeSec && shortAgeSec < minAgeSec) {
      return;
    }

    // Check status of both orders on exchange
    const adapters = this.keeperService.getExchangeAdapters();
    const longAdapter = adapters.get(longOrder.exchange as ExchangeType);
    const shortAdapter = adapters.get(shortOrder.exchange as ExchangeType);

    if (!longAdapter || !shortAdapter) return;

    try {
      const [longStatus, shortStatus] = await Promise.all([
        longAdapter.getOrderStatus(longOrder.orderId, longOrder.symbol).catch(() => null),
        shortAdapter.getOrderStatus(shortOrder.orderId, shortOrder.symbol).catch(() => null),
      ]);

      const longFilled = longStatus?.status === OrderStatus.FILLED || !longStatus;
      const shortFilled = shortStatus?.status === OrderStatus.FILLED || !shortStatus;

      // Both filled - great, clear them
      if (longFilled && shortFilled) {
        this.executionLockService?.forceClearOrder(longOrder.exchange, longOrder.symbol, 'LONG');
        this.executionLockService?.forceClearOrder(shortOrder.exchange, shortOrder.symbol, 'SHORT');
        return;
      }

      // One filled, one not - take action
      if (longFilled && !shortFilled) {
        await this.takeCorrectiveAction(shortOrder, shortAdapter, shortAgeSec, aggressiveAgeSec, marketAgeSec, symbol, 'SHORT');
      } else if (shortFilled && !longFilled) {
        await this.takeCorrectiveAction(longOrder, longAdapter, longAgeSec, aggressiveAgeSec, marketAgeSec, symbol, 'LONG');
      }
    } catch (error: any) {
      this.logger.debug(`Error checking paired order status for ${symbol}: ${error.message}`);
    }
  }

  /**
   * Check if an unfilled leg should be fixed
   */
  private async checkAndFixUnfilledLeg(
    existingOrder: any,
    missingSide: 'LONG' | 'SHORT',
    symbol: string,
    now: number,
    minAgeSec: number,
    aggressiveAgeSec: number,
    marketAgeSec: number,
  ): Promise<void> {
    const orderAgeMs = now - existingOrder.placedAt.getTime();
    const orderAgeSec = orderAgeMs / 1000;

    // Order too young - let it cook
    if (orderAgeSec < minAgeSec) {
      return;
    }

    // Check if the existing order side has created a position (meaning it filled)
    const positions = this.marketStateService?.getAllPositions() || [];
    const existingPosition = positions.find(p => 
      this.normalizeSymbol(p.symbol) === symbol && 
      p.exchangeType === existingOrder.exchange
    );

    if (existingPosition && Math.abs(existingPosition.size) > 0.0001) {
      // Position exists on existing order's exchange, but we have no order for other side
      // This means one leg filled and the other might have failed to place or got lost
      this.logger.warn(
        `⚠️ Detected asymmetric fill for ${symbol}: ` +
        `${existingOrder.side} filled on ${existingOrder.exchange}, but missing ${missingSide} order/position. ` +
        `Age: ${orderAgeSec.toFixed(0)}s`
      );

      // Log to diagnostics
      this.diagnosticsService?.recordSingleLegFailure({
        id: `async-fill-${symbol}-${Date.now()}`,
        symbol,
        timestamp: new Date(),
        failedLeg: missingSide.toLowerCase() as 'long' | 'short',
        failedExchange: existingOrder.exchange === ExchangeType.HYPERLIQUID 
          ? ExchangeType.LIGHTER 
          : ExchangeType.HYPERLIQUID,
        successfulExchange: existingOrder.exchange,
        failureReason: 'timeout',
        failureMessage: `${missingSide} order missing after ${orderAgeSec.toFixed(0)}s`,
        timeBetweenLegsMs: orderAgeMs,
      });
    }
  }

  /**
   * Take corrective action on an unfilled order
   */
  private async takeCorrectiveAction(
    unfilledOrder: any,
    adapter: IPerpExchangeAdapter,
    orderAgeSec: number,
    aggressiveAgeSec: number,
    marketAgeSec: number,
    symbol: string,
    side: 'LONG' | 'SHORT',
  ): Promise<void> {
    try {
      if (orderAgeSec >= marketAgeSec) {
        // Order is old enough - use MARKET order to force fill
        this.logger.warn(
          `🚨 Forcing MARKET order for ${symbol} ${side} after ${orderAgeSec.toFixed(0)}s unfilled. ` +
          `Cancelling existing order ${unfilledOrder.orderId} and placing market order.`
        );

        // Cancel existing order
        try {
          await adapter.cancelOrder(unfilledOrder.orderId, unfilledOrder.symbol);
        } catch (cancelErr: any) {
          this.logger.debug(`Could not cancel order (may already be filled): ${cancelErr.message}`);
        }

        // Get current mark price and place MARKET order
        const markPrice = await adapter.getMarkPrice(unfilledOrder.symbol);
        const marketOrder = new PerpOrderRequest(
          unfilledOrder.symbol,
          side === 'LONG' ? OrderSide.LONG : OrderSide.SHORT,
          OrderType.MARKET,
          unfilledOrder.size,
          markPrice,
          TimeInForce.IOC,
          false,
        );

        const response = await adapter.placeOrder(marketOrder);
        if (response.isSuccess()) {
          this.logger.log(`✅ MARKET order placed to complete ${symbol} ${side}: ${response.orderId}`);
          this.executionLockService?.forceClearOrder(unfilledOrder.exchange, unfilledOrder.symbol, side);
        } else {
          this.logger.error(`❌ Failed to place corrective MARKET order: ${response.error}`);
        }

      } else if (orderAgeSec >= aggressiveAgeSec) {
        // Order is moderately old - try aggressive price improvement
        this.logger.warn(
          `⚠️ Attempting aggressive price improvement for ${symbol} ${side} after ${orderAgeSec.toFixed(0)}s unfilled`
        );

        const markPrice = await adapter.getMarkPrice(unfilledOrder.symbol);
        // Improve price by 0.5% for faster fill
        const improvedPrice = side === 'LONG' 
          ? markPrice * 1.005  // Pay more to buy
          : markPrice * 0.995; // Accept less to sell

        // Check if adapter supports modifyOrder
        if ('modifyOrder' in adapter && typeof adapter.modifyOrder === 'function') {
          try {
            await (adapter as any).modifyOrder(unfilledOrder.orderId, new PerpOrderRequest(
              unfilledOrder.symbol,
              side === 'LONG' ? OrderSide.LONG : OrderSide.SHORT,
              OrderType.LIMIT,
              unfilledOrder.size,
              improvedPrice,
              TimeInForce.GTC,
              false,
            ));
            this.logger.log(`📈 Improved price on ${symbol} ${side} order to ${improvedPrice.toFixed(6)}`);
          } catch (modifyErr: any) {
            this.logger.debug(`Could not modify order (may be filled): ${modifyErr.message}`);
          }
        } else {
          // Fallback: cancel and replace
          try {
            await adapter.cancelOrder(unfilledOrder.orderId, unfilledOrder.symbol);
            const replaceOrder = new PerpOrderRequest(
              unfilledOrder.symbol,
              side === 'LONG' ? OrderSide.LONG : OrderSide.SHORT,
              OrderType.LIMIT,
              unfilledOrder.size,
              improvedPrice,
              TimeInForce.GTC,
              false,
            );
            const response = await adapter.placeOrder(replaceOrder);
            if (response.isSuccess()) {
              this.logger.log(`📈 Replaced order for ${symbol} ${side} at improved price ${improvedPrice.toFixed(6)}`);
            }
          } catch (replaceErr: any) {
            this.logger.debug(`Could not replace order: ${replaceErr.message}`);
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Error taking corrective action for ${symbol} ${side}: ${error.message}`);
    }
  }

  /**
   * Verify and sync tracked orders with exchange state
   * 
   * This handles cases where:
   * 1. WebSocket fill detection failed
   * 2. Order was cancelled on exchange but not detected locally
   * 3. Network issues caused state divergence
   * 
   * For each tracked order older than STALE_ORDER_AGE_MINUTES, we:
   * 1. Check the order status on the exchange
   * 2. If filled/cancelled, clear from tracking
   * 3. If still open but very old, log warning for investigation
   * 
   * Runs every 60 seconds to catch missed fills quickly.
   */
  @Interval(60000) // Every 60 seconds (was 5 min - too slow!)
  async verifyTrackedOrders(): Promise<void> {
    if (!this.executionLockService) return;
    if (this.isRunning) return; // Don't interfere with active execution

    const STALE_ORDER_AGE_MINUTES = parseFloat(
      process.env.STALE_ORDER_AGE_MINUTES || '2'
    ); // Default to 2 minutes for faster cleanup
    const staleAgeMs = STALE_ORDER_AGE_MINUTES * 60 * 1000;

    try {
      const staleOrders = this.executionLockService.getOrdersOlderThan(staleAgeMs);
      
      if (staleOrders.length === 0) {
        return; // No stale orders to verify
      }

      this.logger.log(
        `🔍 Verifying ${staleOrders.length} tracked orders older than ${STALE_ORDER_AGE_MINUTES} minutes...`
      );

      for (const order of staleOrders) {
        try {
          const adapter = this.keeperService.getExchangeAdapters().get(order.exchange as ExchangeType);
          if (!adapter) {
            this.logger.warn(`No adapter found for ${order.exchange}, clearing tracked order ${order.orderId}`);
            this.executionLockService.forceClearOrder(order.exchange, order.symbol, order.side);
            continue;
          }

          // Check order status on exchange
          const status = await adapter.getOrderStatus(order.orderId, order.symbol);

          if (!status) {
            // Order not found on exchange - likely filled or expired
            this.logger.warn(
              `🗑️ Order ${order.orderId} not found on ${order.exchange}, clearing from tracking`
            );
            this.executionLockService.forceClearOrder(order.exchange, order.symbol, order.side);
            continue;
          }

          const orderStatus = status.status;
          if (
            orderStatus === OrderStatus.FILLED ||
            orderStatus === OrderStatus.CANCELLED ||
            orderStatus === OrderStatus.EXPIRED ||
            orderStatus === OrderStatus.REJECTED
          ) {
            this.logger.log(
              `🧹 Tracked order ${order.orderId} is ${orderStatus} on ${order.exchange}, clearing from tracking`
            );
            this.executionLockService.forceClearOrder(order.exchange, order.symbol, order.side);
          } else if (orderStatus === OrderStatus.SUBMITTED || orderStatus === OrderStatus.PENDING) {
            const ageMinutes = (Date.now() - order.placedAt.getTime()) / 60000;
            if (ageMinutes > 30) {
              // Order is still open after 30 minutes - something is wrong
              this.logger.error(
                `⚠️ Order ${order.orderId} still SUBMITTED after ${ageMinutes.toFixed(0)} minutes - ` +
                `consider manual investigation: ${order.exchange} ${order.symbol} ${order.side}`
              );
            }
          }
        } catch (error: any) {
          // If we can't verify, assume the order is stale and clear it
          // This is safer than leaving stale orders that block new executions
          if (
            error.message?.includes('not found') ||
            error.message?.includes('Order not found') ||
            error.message?.includes('already canceled') ||
            error.message?.includes('already cancelled')
          ) {
            this.logger.warn(
              `🗑️ Order ${order.orderId} verification failed (${error.message}), clearing from tracking`
            );
            this.executionLockService.forceClearOrder(order.exchange, order.symbol, order.side);
          } else {
            this.logger.debug(
              `Failed to verify tracked order ${order.orderId}: ${error.message}`
            );
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Error during tracked order verification: ${error.message}`);
    }
  }

  /**
   * Check wallet USDC balance and deposit to exchanges if available
   * This proactively deposits wallet funds to exchanges that need capital
   */
  private async checkAndDepositWalletFunds(): Promise<void> {
    if (!this.balanceManager) {
      return;
    }

    try {
      const adapters = this.keeperService.getExchangeAdapters();
      const uniqueExchanges = new Set(adapters.keys());
      await this.balanceManager.checkAndDepositWalletFunds(
        adapters,
        uniqueExchanges,
      );
    } catch (error: any) {
      this.logger.warn(`Failed to check/deposit wallet funds: ${error.message}`);
    }
  }

  /**
   * Get wallet USDC balance on-chain
   * Checks the wallet's USDC balance directly from the blockchain
   */
  private async getWalletUsdcBalance(): Promise<number> {
    try {
      // Get Arbitrum RPC URL (USDC deposits go through Arbitrum)
      const rpcUrl =
        this.configService.get<string>('ARBITRUM_RPC_URL') ||
        this.configService.get<string>('ARB_RPC_URL') ||
        'https://arb1.arbitrum.io/rpc'; // Public Arbitrum RPC fallback
      const privateKey = this.configService.get<string>('PRIVATE_KEY');
      const walletAddress =
        this.configService.get<string>('WALLET_ADDRESS') ||
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
        const normalizedKey = privateKey.startsWith('0x')
          ? privateKey
          : `0x${privateKey}`;
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
        this.logger.log(
          `💰 USDC balance on Arbitrum: $${balanceUsd.toFixed(2)}`,
        );
      }

      return balanceUsd;
    } catch (error: any) {
      return 0;
    }
  }

  /**
   * Periodic leverage health check - runs every 15 minutes
   * Checks if current positions have optimal leverage and generates alerts
   */
  @Interval(900000) // Every 15 minutes (900000 ms)
  async checkLeverageHealth() {
    if (!this.optimalLeverageService) {
      return;
    }

    try {
      // Get all current positions
      const positionsResult =
        await this.orchestrator.getAllPositionsWithMetrics();
      if (!positionsResult || positionsResult.positions.length === 0) {
        return;
      }

      const positions = positionsResult.positions;
      const alerts: LeverageAlert[] = [];

      // Check leverage for each unique symbol
      const checkedSymbols = new Set<string>();

      for (const position of positions) {
        const normalizedSymbol = position.symbol
          .replace('USDT', '')
          .replace('USDC', '')
          .replace('-PERP', '')
          .toUpperCase();

        if (checkedSymbols.has(normalizedSymbol)) {
          continue;
        }
        checkedSymbols.add(normalizedSymbol);

        try {
          const currentLeverage = position.leverage ?? 2; // Default assumption
          const result = await this.optimalLeverageService.shouldAdjustLeverage(
            normalizedSymbol,
            position.exchangeType,
            currentLeverage,
          );

          if (result.shouldAdjust) {
            const urgency =
              Math.abs(currentLeverage - result.recommendedLeverage) > 3
                ? 'HIGH'
                : Math.abs(currentLeverage - result.recommendedLeverage) > 1
                  ? 'MEDIUM'
                  : 'LOW';

            const alertType =
              result.recommendedLeverage > currentLeverage
                ? 'INCREASE'
                : 'DECREASE';

            alerts.push({
              symbol: normalizedSymbol,
              exchange: position.exchangeType,
              alertType,
              currentLeverage,
              recommendedLeverage: result.recommendedLeverage,
              reason: result.reason,
              urgency,
              timestamp: new Date(),
            });
          }
        } catch (error: any) {
          // Skip symbol on error
        }
      }

      // Log alerts if any
      if (alerts.length > 0) {
        this.logger.warn('');
        this.logger.warn('⚠️ LEVERAGE ADJUSTMENT RECOMMENDED');
        this.logger.warn('═'.repeat(60));

        for (const alert of alerts) {
          const emoji =
            alert.urgency === 'HIGH'
              ? '🔴'
              : alert.urgency === 'MEDIUM'
                ? '🟡'
                : '🟢';
          this.logger.warn(
            `${emoji} ${alert.symbol} (${alert.exchange}): ${alert.alertType} ` +
              `${alert.currentLeverage}x → ${alert.recommendedLeverage}x`,
          );
          this.logger.warn(`   Reason: ${alert.reason}`);
        }

        this.logger.warn('═'.repeat(60));
        this.logger.warn('');
      }
    } catch (error: any) {
      this.logger.debug(`Error in leverage health check: ${error.message}`);
    }
  }

  /**
   * Periodic stale order cleanup - runs every 2 minutes
   * Cancels limit orders that have been sitting unfilled for too long
   */
  @Interval(120000) // Every 2 minutes (was 10 min - too slow!)
  async cleanupStaleOrders() {
    const STALE_ORDER_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

    try {
      const adapters = this.keeperService.getExchangeAdapters();
      let totalCancelled = 0;

      for (const [exchangeType, adapter] of adapters) {
        try {
          // Check if adapter supports getOpenOrders
          if (typeof (adapter as any).getOpenOrders !== 'function') {
            continue;
          }

          const openOrders = await (adapter as any).getOpenOrders();
          const now = Date.now();

          for (const order of openOrders) {
            const orderAge = now - order.timestamp.getTime();

            if (orderAge > STALE_ORDER_THRESHOLD_MS) {
              const ageMinutes = Math.floor(orderAge / 60000);
              this.logger.warn(
                `🗑️ Cancelling stale order on ${exchangeType}: ${order.symbol} ${order.side} ` +
                  `${order.size} @ ${order.price} (${ageMinutes} minutes old)`,
              );

              try {
                await adapter.cancelOrder(order.orderId, order.symbol);
                totalCancelled++;
              } catch (cancelError: any) {
                this.logger.debug(
                  `Failed to cancel stale order ${order.orderId}: ${cancelError.message}`,
                );
              }
            }
          }
        } catch (error: any) {
          this.logger.debug(
            `Error checking stale orders on ${exchangeType}: ${error.message}`,
          );
        }
      }

      if (totalCancelled > 0) {
        this.logger.log(`✅ Cleaned up ${totalCancelled} stale order(s)`);
      }
    } catch (error: any) {
      this.logger.debug(`Error in stale order cleanup: ${error.message}`);
    }
  }

  /**
   * Cancel open orders for symbols that have valid paired positions
   * 
   * POLICY: When we have a complete cross-exchange position (LONG on one exchange,
   * SHORT on another), there should be NO open orders for that symbol.
   * Any lingering orders could accidentally fill and create imbalanced positions.
   * 
   * EXCEPTION: If we're actively executing orders (TWAP, position increase, etc.),
   * we should NOT cancel those orders as they're intentional.
   * 
   * Runs every 30 seconds to catch any orders that shouldn't exist.
   */
  @Interval(30000) // Every 30 seconds
  async cancelOrdersForPairedPositions() {
    try {
      // ================================================================================
      // CRITICAL: Check if we have any active executions in progress
      // If so, skip this cleanup to avoid race conditions with TWAP or position sizing
      // ================================================================================
      if (this.executionLockService) {
        const activeOrders = this.executionLockService.getAllActiveOrders();
        // Check for orders that are actively being placed or waiting to fill
        const activeExecutions = activeOrders.filter(
          o => o.status === 'PLACING' || o.status === 'WAITING_FILL'
        );

        if (activeExecutions.length > 0) {
          // Get unique symbols being actively executed
          const activeSymbols = new Set(
            activeExecutions.map(o => this.normalizeSymbol(o.symbol))
          );
          this.logger.debug(
            `⏳ Skipping paired position order cleanup - ${activeExecutions.length} active execution(s) ` +
            `in progress for: ${Array.from(activeSymbols).join(', ')}`
          );
          return;
        }
      }

      // Also check if global lock is held (another execution is in progress)
      if (this.executionLockService?.isGlobalLockHeld()) {
        this.logger.debug(
          `⏳ Skipping paired position order cleanup - global execution lock is held`
        );
        return;
      }
      // ================================================================================

      const positions = this.marketStateService?.getAllPositions() || [];
      if (positions.length === 0) return;

      // Group positions by normalized symbol
      const positionsBySymbol = new Map<string, PerpPosition[]>();
      for (const position of positions) {
        const normalizedSymbol = this.normalizeSymbol(position.symbol);
        if (!positionsBySymbol.has(normalizedSymbol)) {
          positionsBySymbol.set(normalizedSymbol, []);
        }
        positionsBySymbol.get(normalizedSymbol)!.push(position);
      }

      // Find symbols with valid cross-exchange pairs
      const validPairedSymbols = new Set<string>();
      for (const [symbol, symbolPositions] of positionsBySymbol) {
        const exchanges = new Set(symbolPositions.map(p => p.exchangeType));
        const sides = new Set(symbolPositions.map(p => p.side));

        // Valid pair: positions on different exchanges AND both LONG and SHORT exist
        if (exchanges.size >= 2 && sides.has(OrderSide.LONG) && sides.has(OrderSide.SHORT)) {
          // Verify LONG and SHORT are on DIFFERENT exchanges
          const longExchanges = new Set(
            symbolPositions.filter(p => p.side === OrderSide.LONG).map(p => p.exchangeType)
          );
          const shortExchanges = new Set(
            symbolPositions.filter(p => p.side === OrderSide.SHORT).map(p => p.exchangeType)
          );
          
          // Check if there's at least one LONG on a different exchange than at least one SHORT
          let hasCrossExchangePair = false;
          for (const longEx of longExchanges) {
            for (const shortEx of shortExchanges) {
              if (longEx !== shortEx) {
                hasCrossExchangePair = true;
                break;
              }
            }
            if (hasCrossExchangePair) break;
          }

          if (hasCrossExchangePair) {
            validPairedSymbols.add(symbol);
          }
        }
      }

      if (validPairedSymbols.size === 0) return;

      // Check for open orders on these symbols and cancel them
      const adapters = this.keeperService.getExchangeAdapters();
      let totalCancelled = 0;

      for (const [exchangeType, adapter] of adapters) {
        try {
          if (typeof (adapter as any).getOpenOrders !== 'function') continue;

          const openOrders = await (adapter as any).getOpenOrders();
          if (!openOrders || openOrders.length === 0) continue;

          for (const order of openOrders) {
            const normalizedOrderSymbol = this.normalizeSymbol(order.symbol);
            
            if (validPairedSymbols.has(normalizedOrderSymbol)) {
              // Double-check: Make sure this specific order is not being actively tracked
              // (it might have been placed after our initial check)
              if (this.executionLockService) {
                const isActiveOrder = this.executionLockService.hasActiveOrder(
                  exchangeType as string,
                  order.symbol,
                  order.side
                );
                if (isActiveOrder) {
                  this.logger.debug(
                    `⏳ Skipping order ${order.orderId} - actively tracked by ExecutionLockService`
                  );
                  continue;
                }
              }

              // This order is for a symbol that already has a valid paired position
              // AND is not being actively managed - cancel it
              this.logger.warn(
                `🗑️ Cancelling orphan order for paired position: ${order.symbol} ${order.side} on ${exchangeType} ` +
                `(Symbol already has valid cross-exchange pair)`,
              );

              try {
                await adapter.cancelOrder(order.orderId, order.symbol);
                totalCancelled++;
                this.logger.log(`✅ Cancelled orphan order ${order.orderId}`);
              } catch (cancelError: any) {
                this.logger.debug(`Failed to cancel order ${order.orderId}: ${cancelError.message}`);
              }
            }
          }
        } catch (error: any) {
          this.logger.debug(`Error checking orders on ${exchangeType}: ${error.message}`);
        }
      }

      if (totalCancelled > 0) {
        this.logger.log(`✅ Cancelled ${totalCancelled} orphan order(s) for paired positions`);
      }
    } catch (error: any) {
      this.logger.debug(`Error in paired position order cleanup: ${error.message}`);
    }
  }

  /**
   * Check for position size imbalances between paired legs
   * 
   * POLICY: For delta-neutral arbitrage, both legs should have the same size.
   * If sizes differ (e.g., LONG=100, SHORT=50), we have price exposure.
   * 
   * This check detects imbalances and reduces the larger position to match the smaller one.
   * 
   * Runs every 30 seconds for faster imbalance detection.
   */
  @Interval(30000) // Every 30 seconds (was 60s)
  async checkPositionSizeBalance() {
    try {
      // Skip if active executions in progress
      if (this.executionLockService) {
        const activeOrders = this.executionLockService.getAllActiveOrders();
        const activeExecutions = activeOrders.filter(
          o => o.status === 'PLACING' || o.status === 'WAITING_FILL'
        );
        if (activeExecutions.length > 0) {
          this.logger.debug(
            `⏳ Skipping position size balance check - ${activeExecutions.length} active execution(s) in progress`
          );
          return;
        }
      }

      if (this.executionLockService?.isGlobalLockHeld()) {
        return;
      }

      // Fetch FRESH positions directly from exchanges - don't rely on stale cache
      // This is critical for detecting real imbalances
      const adapters = this.keeperService.getExchangeAdapters();
      const freshPositions: PerpPosition[] = [];
      
      for (const [exchangeType, adapter] of adapters) {
        try {
          const exchangePositions = await adapter.getPositions();
          freshPositions.push(...exchangePositions);
        } catch (error: any) {
          this.logger.debug(`Could not fetch positions from ${exchangeType}: ${error.message}`);
        }
      }
      
      // Also update cache with fresh data
      if (this.marketStateService) {
        for (const pos of freshPositions) {
          this.marketStateService.updatePosition(pos);
        }
      }

      const positions = freshPositions;
      if (positions.length < 2) return;

      // Group positions by normalized symbol
      const positionsBySymbol = new Map<string, PerpPosition[]>();
      for (const position of positions) {
        const normalizedSymbol = this.normalizeSymbol(position.symbol);
        if (!positionsBySymbol.has(normalizedSymbol)) {
          positionsBySymbol.set(normalizedSymbol, []);
        }
        positionsBySymbol.get(normalizedSymbol)!.push(position);
      }

      // Check each symbol for size imbalances
      for (const [symbol, symbolPositions] of positionsBySymbol) {
        // Find LONG and SHORT positions on DIFFERENT exchanges
        const longPositions = symbolPositions.filter(p => p.side === OrderSide.LONG);
        const shortPositions = symbolPositions.filter(p => p.side === OrderSide.SHORT);

        if (longPositions.length === 0 || shortPositions.length === 0) continue;

        // Find cross-exchange pair
        let longPos: PerpPosition | undefined;
        let shortPos: PerpPosition | undefined;

        for (const lp of longPositions) {
          for (const sp of shortPositions) {
            if (lp.exchangeType !== sp.exchangeType) {
              longPos = lp;
              shortPos = sp;
              break;
            }
          }
          if (longPos && shortPos) break;
        }

        if (!longPos || !shortPos) continue;

        const longSize = Math.abs(longPos.size);
        const shortSize = Math.abs(shortPos.size);

        // Check for imbalance (allow 5% tolerance for rounding)
        const sizeDiff = Math.abs(longSize - shortSize);
        const avgSize = (longSize + shortSize) / 2;
        const imbalancePercent = avgSize > 0 ? (sizeDiff / avgSize) * 100 : 0;

        // Record drift in diagnostics regardless of threshold
        // This tracks drift trends over time
        if (imbalancePercent > 3 && this.diagnosticsService) {
          const markPrice = longPos.markPrice || shortPos.markPrice || 0;
          this.diagnosticsService.recordPositionDrift(
            symbol,
            longPos.exchangeType,
            shortPos.exchangeType,
            longSize,
            shortSize,
            markPrice,
          );
        }

        if (imbalancePercent > 5) {
          // Classify severity
          const severity = imbalancePercent > 30 ? '🚨 CRITICAL' : imbalancePercent > 15 ? '⚠️ SEVERE' : '⚠️';
          
          this.logger.warn(
            `${severity} Position size imbalance for ${symbol}: ` +
            `LONG=${longSize.toFixed(4)} on ${longPos.exchangeType}, ` +
            `SHORT=${shortSize.toFixed(4)} on ${shortPos.exchangeType} ` +
            `(${imbalancePercent.toFixed(1)}% difference)`
          );

          // Determine which position to reduce
          const largerPos = longSize > shortSize ? longPos : shortPos;
          const smallerSize = Math.min(longSize, shortSize);
          const excessSize = Math.abs(largerPos.size) - smallerSize;

          // Only fix if excess is significant (> 1% of position)
          if (excessSize / Math.abs(largerPos.size) < 0.01) {
            this.logger.debug(`Imbalance too small to fix (${excessSize.toFixed(4)})`);
            continue;
          }

          // Get adapter and place reduce-only order
          const adapter = this.keeperService.getExchangeAdapter(largerPos.exchangeType);
          if (!adapter) continue;

          try {
            const closeSide = largerPos.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
            const markPrice = await adapter.getMarkPrice(largerPos.symbol);

            // For severe imbalances (>20%), use MARKET order to guarantee fill
            // For smaller imbalances, use aggressive limit (0.5% worse than mark)
            const useMktOrder = imbalancePercent > 20;
            const orderType = useMktOrder ? OrderType.MARKET : OrderType.LIMIT;
            const limitPrice = closeSide === OrderSide.LONG 
              ? markPrice * 1.005  // Pay 0.5% more to buy
              : markPrice * 0.995; // Accept 0.5% less to sell

            this.logger.warn(
              `🔧 FIXING IMBALANCE: Reducing ${largerPos.side} on ${largerPos.exchangeType} ` +
              `by ${excessSize.toFixed(4)} (${orderType} order) to match ${smallerSize.toFixed(4)}`
            );

            const reduceOrder = new PerpOrderRequest(
              largerPos.symbol,
              closeSide,
              orderType,
              excessSize,
              useMktOrder ? markPrice : limitPrice, // Market orders still need a price for some exchanges
              useMktOrder ? TimeInForce.IOC : TimeInForce.GTC,
              true, // reduceOnly
            );

            const response = await adapter.placeOrder(reduceOrder);
            
            if (response.isSuccess()) {
              this.logger.log(
                `✅ Placed ${orderType} reduce order to fix ${imbalancePercent.toFixed(0)}% imbalance: ` +
                `${response.orderId} (${closeSide} ${excessSize.toFixed(4)} ${largerPos.symbol})`
              );
              // Mark drift as resolved in diagnostics
              this.diagnosticsService?.resolvePositionDrift(symbol, 'reduced');
              
              // Refresh market state after fixing
              await this.marketStateService?.refreshAll();
            } else {
              this.logger.error(
                `❌ Failed to fix imbalance with ${orderType} order: ${response.error}`
              );
            }
          } catch (error: any) {
            this.logger.error(
              `❌ Error fixing position imbalance for ${symbol}: ${error.message}`
            );
          }
        }
      }
    } catch (error: any) {
      this.logger.debug(`Error in position size balance check: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NUCLEAR OPTION - Close both sides if imbalance persists
  // ═══════════════════════════════════════════════════════════════════════════

  // Track persistent imbalances: symbol -> { firstDetectedAt, lastImbalancePercent, attemptCount }
  private readonly persistentImbalances: Map<string, {
    firstDetectedAt: Date;
    lastImbalancePercent: number;
    attemptCount: number;
    longExchange: ExchangeType;
    shortExchange: ExchangeType;
  }> = new Map();

  /**
   * NUCLEAR OPTION: If imbalance persists for too long, close BOTH sides
   * 
   * This is the last resort when:
   * 1. Position imbalance > 20% persists for > 3 minutes
   * 2. Multiple fix attempts have failed
   * 
   * Options:
   * A) Market order to complete the smaller leg (if missing leg scenario)
   * B) Close BOTH legs to eliminate exposure (if truly stuck)
   * 
   * Runs every 60 seconds.
   */
  @Interval(60000) // Every 60 seconds
  async checkPersistentImbalancesNuclearOption(): Promise<void> {
    if (this.isRunning) return;
    if (this.executionLockService?.isGlobalLockHeld()) return;

    // Configurable thresholds
    const NUCLEAR_THRESHOLD_PERCENT = parseFloat(process.env.NUCLEAR_IMBALANCE_PERCENT || '20');
    const NUCLEAR_TIMEOUT_MINUTES = parseFloat(process.env.NUCLEAR_TIMEOUT_MINUTES || '3');
    const MAX_ATTEMPTS_BEFORE_CLOSE = parseInt(process.env.NUCLEAR_MAX_ATTEMPTS || '3');

    try {
      const adapters = this.keeperService.getExchangeAdapters();
      const freshPositions: PerpPosition[] = [];
      
      for (const [exchangeType, adapter] of adapters) {
        try {
          const exchangePositions = await adapter.getPositions();
          freshPositions.push(...exchangePositions);
        } catch (error: any) {
          this.logger.debug(`Could not fetch positions from ${exchangeType}: ${error.message}`);
        }
      }

      const positions = freshPositions;
      if (positions.length < 1) {
        // Clear tracking if no positions
        this.persistentImbalances.clear();
        return;
      }

      // Group positions by normalized symbol
      const positionsBySymbol = new Map<string, PerpPosition[]>();
      for (const position of positions) {
        const normalizedSymbol = this.normalizeSymbol(position.symbol);
        if (!positionsBySymbol.has(normalizedSymbol)) {
          positionsBySymbol.set(normalizedSymbol, []);
        }
        positionsBySymbol.get(normalizedSymbol)!.push(position);
      }

      const now = new Date();

      for (const [symbol, symbolPositions] of positionsBySymbol) {
        const longPositions = symbolPositions.filter(p => p.side === OrderSide.LONG);
        const shortPositions = symbolPositions.filter(p => p.side === OrderSide.SHORT);

        // CASE 1: Single leg only (most critical)
        if ((longPositions.length > 0 && shortPositions.length === 0) ||
            (shortPositions.length > 0 && longPositions.length === 0)) {
          
          const singleLegPos = longPositions[0] || shortPositions[0];
          const tracking = this.persistentImbalances.get(symbol);
          
          if (!tracking) {
            // First detection - start tracking
            this.persistentImbalances.set(symbol, {
              firstDetectedAt: now,
              lastImbalancePercent: 100, // Single leg = 100% imbalance
              attemptCount: 0,
              longExchange: singleLegPos.exchangeType,
              shortExchange: singleLegPos.exchangeType === ExchangeType.HYPERLIQUID 
                ? ExchangeType.LIGHTER : ExchangeType.HYPERLIQUID,
            });
            continue;
          }

          const persistenceMinutes = (now.getTime() - tracking.firstDetectedAt.getTime()) / 60000;
          tracking.attemptCount++;

          if (persistenceMinutes >= NUCLEAR_TIMEOUT_MINUTES || tracking.attemptCount >= MAX_ATTEMPTS_BEFORE_CLOSE) {
            this.logger.error(
              `🚨☢️ NUCLEAR OPTION: Single leg ${symbol} (${singleLegPos.side}) persisted ${persistenceMinutes.toFixed(1)} min. ` +
              `Closing to eliminate exposure.`
            );

            await this.executeNuclearClose(symbol, [singleLegPos], adapters);
            this.persistentImbalances.delete(symbol);
          }
          continue;
        }

        // CASE 2: Both legs exist but severely imbalanced
        let longPos: PerpPosition | undefined;
        let shortPos: PerpPosition | undefined;

        for (const lp of longPositions) {
          for (const sp of shortPositions) {
            if (lp.exchangeType !== sp.exchangeType) {
              longPos = lp;
              shortPos = sp;
              break;
            }
          }
          if (longPos && shortPos) break;
        }

        if (!longPos || !shortPos) continue;

        const longSize = Math.abs(longPos.size);
        const shortSize = Math.abs(shortPos.size);
        const sizeDiff = Math.abs(longSize - shortSize);
        const avgSize = (longSize + shortSize) / 2;
        const imbalancePercent = avgSize > 0 ? (sizeDiff / avgSize) * 100 : 0;

        if (imbalancePercent < NUCLEAR_THRESHOLD_PERCENT) {
          // Imbalance resolved - clear tracking
          this.persistentImbalances.delete(symbol);
          continue;
        }

        const tracking = this.persistentImbalances.get(symbol);
        
        if (!tracking) {
          // First detection - start tracking
          this.persistentImbalances.set(symbol, {
            firstDetectedAt: now,
            lastImbalancePercent: imbalancePercent,
            attemptCount: 0,
            longExchange: longPos.exchangeType,
            shortExchange: shortPos.exchangeType,
          });
          continue;
        }

        const persistenceMinutes = (now.getTime() - tracking.firstDetectedAt.getTime()) / 60000;
        tracking.lastImbalancePercent = imbalancePercent;
        tracking.attemptCount++;

        if (persistenceMinutes >= NUCLEAR_TIMEOUT_MINUTES && imbalancePercent >= NUCLEAR_THRESHOLD_PERCENT) {
          this.logger.error(
            `🚨☢️ NUCLEAR OPTION: ${symbol} imbalance ${imbalancePercent.toFixed(1)}% persisted ${persistenceMinutes.toFixed(1)} min. ` +
            `Closing BOTH legs to eliminate exposure.`
          );

          await this.executeNuclearClose(symbol, [longPos, shortPos], adapters);
          this.persistentImbalances.delete(symbol);
        } else if (persistenceMinutes >= 1) {
          this.logger.warn(
            `⏳ Tracking persistent imbalance for ${symbol}: ${imbalancePercent.toFixed(1)}% for ${persistenceMinutes.toFixed(1)} min ` +
            `(Nuclear in ${(NUCLEAR_TIMEOUT_MINUTES - persistenceMinutes).toFixed(1)} min)`
          );
        }
      }

      // Clean up tracking for symbols that no longer have positions
      for (const trackedSymbol of this.persistentImbalances.keys()) {
        if (!positionsBySymbol.has(trackedSymbol)) {
          this.persistentImbalances.delete(trackedSymbol);
        }
      }

    } catch (error: any) {
      this.logger.error(`Error in nuclear option check: ${error.message}`);
    }
  }

  /**
   * Execute nuclear close - close all positions for a symbol
   */
  private async executeNuclearClose(
    symbol: string,
    positions: PerpPosition[],
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<void> {
    this.logger.error(`☢️ EXECUTING NUCLEAR CLOSE for ${symbol} - closing ${positions.length} position(s)`);

    for (const position of positions) {
      const adapter = adapters.get(position.exchangeType);
      if (!adapter) {
        this.logger.error(`No adapter for ${position.exchangeType}`);
        continue;
      }

      try {
        const closeSide = position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
        const markPrice = await adapter.getMarkPrice(position.symbol);
        const closeSize = Math.abs(position.size);

        // Use MARKET order - we NEED this to close NOW
        const closeOrder = new PerpOrderRequest(
          position.symbol,
          closeSide,
          OrderType.MARKET,
          closeSize,
          markPrice,
          TimeInForce.IOC,
          true, // reduceOnly
        );

        this.logger.warn(
          `☢️ Nuclear MARKET close: ${position.side} ${closeSize.toFixed(4)} ${position.symbol} on ${position.exchangeType}`
        );

        const response = await adapter.placeOrder(closeOrder);

        if (response.isSuccess()) {
          this.logger.log(
            `✅ Nuclear close successful: ${response.orderId} - ${position.side} ${closeSize.toFixed(4)} ${position.symbol}`
          );
        } else {
          this.logger.error(
            `❌ Nuclear close FAILED for ${position.symbol} on ${position.exchangeType}: ${response.error}`
          );
        }
      } catch (error: any) {
        this.logger.error(
          `❌ Nuclear close error for ${position.symbol} on ${position.exchangeType}: ${error.message}`
        );
      }
    }

    // Refresh market state after nuclear close
    await this.marketStateService?.refreshAll();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POSITION RECONCILIATION - Verify expected positions match actual on exchanges
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Verify cached position state matches actual exchange positions
   * 
   * CRITICAL: Detects phantom positions (we think we have them but don't) 
   * and orphan positions (exchange has them but we don't track them).
   * 
   * This catches:
   * 1. Positions we think exist but were closed/liquidated externally
   * 2. Positions that exist on exchange but aren't in our state
   * 3. Size mismatches between tracked and actual positions
   * 
   * Runs every 45 seconds for fast detection.
   */
  @Interval(45000) // Every 45 seconds
  async verifyPositionStateWithExchanges(): Promise<void> {
    if (this.isRunning) return;
    if (this.executionLockService?.isGlobalLockHeld()) return;

    try {
      const adapters = this.keeperService.getExchangeAdapters();
      const trackedPositions = this.marketStateService?.getAllPositions() || [];

      // Group tracked positions by exchange
      const trackedByExchange = new Map<ExchangeType, PerpPosition[]>();
      for (const pos of trackedPositions) {
        if (!trackedByExchange.has(pos.exchangeType)) {
          trackedByExchange.set(pos.exchangeType, []);
        }
        trackedByExchange.get(pos.exchangeType)!.push(pos);
      }

      let discrepanciesFound = 0;

      for (const [exchangeType, adapter] of adapters) {
        try {
          // Fetch actual positions from exchange
          const actualPositions = await adapter.getPositions();
          const trackedForExchange = trackedByExchange.get(exchangeType) || [];

          // Build lookup maps
          const actualBySymbol = new Map<string, PerpPosition>();
          for (const pos of actualPositions) {
            if (Math.abs(pos.size) > 0.0001) { // Ignore dust
              const normalizedSymbol = this.normalizeSymbol(pos.symbol);
              actualBySymbol.set(normalizedSymbol, pos);
            }
          }

          const trackedBySymbol = new Map<string, PerpPosition>();
          for (const pos of trackedForExchange) {
            if (Math.abs(pos.size) > 0.0001) {
              const normalizedSymbol = this.normalizeSymbol(pos.symbol);
              trackedBySymbol.set(normalizedSymbol, pos);
            }
          }

          // Check 1: Phantom positions (tracked but don't exist on exchange)
          for (const [symbol, trackedPos] of trackedBySymbol) {
            const actualPos = actualBySymbol.get(symbol);
            if (!actualPos) {
              discrepanciesFound++;
              this.logger.error(
                `🚨 PHANTOM POSITION: ${exchangeType} ${symbol} ` +
                `tracked as ${trackedPos.side} ${Math.abs(trackedPos.size).toFixed(4)} ` +
                `but NOT FOUND on exchange! Possible external close/liquidation.`
              );
              // Update our state to remove this position
              this.marketStateService?.removePosition(exchangeType, symbol);
            }
          }

          // Check 2: Orphan positions (exist on exchange but not tracked)
          for (const [symbol, actualPos] of actualBySymbol) {
            const trackedPos = trackedBySymbol.get(symbol);
            if (!trackedPos) {
              discrepanciesFound++;
              this.logger.error(
                `🚨 ORPHAN POSITION: ${exchangeType} ${symbol} ` +
                `found as ${actualPos.side} ${Math.abs(actualPos.size).toFixed(4)} ` +
                `on exchange but NOT TRACKED! Possible missed fill.`
              );
              // Add to our state
              this.marketStateService?.updatePosition(actualPos);
            }
          }

          // Check 3: Size mismatches (both exist but sizes differ significantly)
          for (const [symbol, trackedPos] of trackedBySymbol) {
            const actualPos = actualBySymbol.get(symbol);
            if (actualPos) {
              const trackedSize = Math.abs(trackedPos.size);
              const actualSize = Math.abs(actualPos.size);
              const sizeDiff = Math.abs(trackedSize - actualSize);
              const avgSize = (trackedSize + actualSize) / 2;
              const diffPercent = avgSize > 0 ? (sizeDiff / avgSize) * 100 : 0;

              if (diffPercent > 5) { // 5% tolerance
                discrepanciesFound++;
                this.logger.warn(
                  `⚠️ SIZE MISMATCH: ${exchangeType} ${symbol} ` +
                  `tracked=${trackedSize.toFixed(4)} vs actual=${actualSize.toFixed(4)} ` +
                  `(${diffPercent.toFixed(1)}% difference). Updating to actual.`
                );
                // Update our state to match exchange
                this.marketStateService?.updatePosition(actualPos);
              }
            }
          }
        } catch (error: any) {
          this.logger.debug(
            `Could not reconcile positions for ${exchangeType}: ${error.message}`
          );
        }
      }

      if (discrepanciesFound > 0) {
        this.logger.warn(
          `🔄 Position reconciliation found ${discrepanciesFound} discrepancies - state corrected`
        );
      }
    } catch (error: any) {
      this.logger.debug(`Error in position reconciliation: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PROFIT TAKING - Reversion-based partial profit taking
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check for profit-taking opportunities using reversion-based partial scaling
   * 
   * When price moves significantly in our favor (basis drift), we take profit
   * proportional to how close we are to expected funding rate reversion.
   * Uses the OU mean reversion model to estimate time until spread reverts.
   * 
   * Logic:
   * 1. Calculate expected funding income until reversion: currentSpread * reversionHours * positionValue
   * 2. Compare to current unrealized profit
   * 3. Close portion = min(100%, profit / expectedFundingIncome)
   * 
   * Example:
   * - Spread expected to revert in 48 hours
   * - Current spread = 0.01%/hour = 0.48% total expected income
   * - If unrealized profit = 1%, that's 2x expected income → close 100%
   * - If unrealized profit = 0.24%, that's 0.5x expected income → close 50%
   * 
   * Runs every 30 seconds for quick profit capture.
   */
  @Interval(30000) // Every 30 seconds
  async checkProfitTaking(): Promise<void> {
    // Skip if main execution is running or global lock held
    if (this.isRunning) return;
    if (this.executionLockService?.isGlobalLockHeld()) return;

    try {
      const positions = this.marketStateService?.getAllPositions() || [];
      if (positions.length < 2) return;

      // Minimum profit threshold (absolute) to avoid small position churn
      const MIN_PROFIT_USD = parseFloat(
        process.env.PROFIT_TAKE_MIN_USD || '10'
      );

      // Minimum close percentage threshold (don't close less than 25%)
      const MIN_CLOSE_PERCENT = parseFloat(
        process.env.PROFIT_TAKE_MIN_CLOSE_PERCENT || '0.25'
      );

      // Maximum hours until reversion to trigger profit-taking
      // If reversion is expected beyond this, don't take profit (spread is stable)
      const MAX_REVERSION_HOURS = parseFloat(
        process.env.PROFIT_TAKE_MAX_REVERSION_HOURS || '168'
      );

      // Group positions by normalized symbol
      const positionsBySymbol = new Map<string, PerpPosition[]>();
      for (const position of positions) {
        const normalizedSymbol = this.normalizeSymbol(position.symbol);
        if (!positionsBySymbol.has(normalizedSymbol)) {
          positionsBySymbol.set(normalizedSymbol, []);
        }
        positionsBySymbol.get(normalizedSymbol)!.push(position);
      }

      // Check each symbol for profit-taking opportunity
      for (const [symbol, symbolPositions] of positionsBySymbol) {
        // Find LONG and SHORT on DIFFERENT exchanges
        const longPos = symbolPositions.find(p => p.side === OrderSide.LONG);
        const shortPos = symbolPositions.find(
          p => p.side === OrderSide.SHORT && p.exchangeType !== longPos?.exchangeType
        );

        if (!longPos || !shortPos) continue;

        // Calculate combined unrealized PnL from PRICE movement
        const longPricePnl = longPos.unrealizedPnl;
        const shortPricePnl = shortPos.unrealizedPnl;
        const combinedPnl = longPricePnl + shortPricePnl;

        // Skip if combined PnL is negative or too small
        if (combinedPnl <= MIN_PROFIT_USD) continue;

        // Calculate position value for percentage calculation
        const longValue = Math.abs(longPos.size * (longPos.markPrice || 0));
        const shortValue = Math.abs(shortPos.size * (shortPos.markPrice || 0));
        const avgPositionValue = (longValue + shortValue) / 2;

        if (avgPositionValue <= 0) continue;

        // Calculate profit as percentage of position
        const profitPercent = (combinedPnl / avgPositionValue) * 100;

        // Get spread prediction with expected reversion time
        let expectedReversionHours: number | null = null;
        let currentSpreadHourly = 0;

        if (this.predictionService) {
          try {
            const spreadPrediction = await this.predictionService.getSpreadPrediction(
              symbol,
              longPos.exchangeType,
              shortPos.exchangeType,
            );
            expectedReversionHours = spreadPrediction.expectedReversionHours;
            // Current spread is hourly rate (e.g., 0.0001 = 0.01%/hour)
            currentSpreadHourly = Math.abs(spreadPrediction.currentSpread);
          } catch (predErr: any) {
            this.logger.debug(
              `Failed to get spread prediction for ${symbol}: ${predErr.message}`
            );
          }
        }

        // Use fallback if no reversion data
        if (expectedReversionHours === null) {
          // Fallback: use conservative fixed reversion time (7 days = 168 hours)
          expectedReversionHours = 168;
        }

        // Skip if reversion is expected too far in the future
        if (expectedReversionHours > MAX_REVERSION_HOURS) {
          this.logger.debug(
            `${symbol}: Skipping profit-take, reversion expected in ${expectedReversionHours.toFixed(0)}h (> ${MAX_REVERSION_HOURS}h max)`
          );
          continue;
        }

        // Calculate expected remaining funding income until reversion
        // expectedFundingPercent = currentSpreadHourly * reversionHours * 100 (to get %)
        // Fallback to 0.0001 (0.01%/hour) if no spread data
        const effectiveSpreadHourly = currentSpreadHourly > 0 ? currentSpreadHourly : 0.0001;
        const expectedFundingPercent = effectiveSpreadHourly * expectedReversionHours * 100;

        // Calculate close percentage: how much of our profit exceeds expected funding
        // If profit = 2x expected funding → close 100%
        // If profit = 0.5x expected funding → close 50%
        let closePercent = expectedFundingPercent > 0 
          ? Math.min(1.0, profitPercent / expectedFundingPercent)
          : 1.0; // If no expected funding, close everything

        // Don't take action if close percent is below minimum threshold
        if (closePercent < MIN_CLOSE_PERCENT) {
          this.logger.debug(
            `${symbol}: Profit ${profitPercent.toFixed(2)}% vs expected funding ${expectedFundingPercent.toFixed(2)}% ` +
            `→ close ${(closePercent * 100).toFixed(0)}% < ${(MIN_CLOSE_PERCENT * 100).toFixed(0)}% min threshold, skipping`
          );
          continue;
        }

        this.logger.warn(
          `💰 REVERSION-BASED PROFIT TAKING for ${symbol}:\n` +
          `   Combined PnL: $${combinedPnl.toFixed(2)} (${profitPercent.toFixed(2)}%)\n` +
          `   Expected reversion in: ${expectedReversionHours.toFixed(1)} hours\n` +
          `   Expected funding until reversion: ${expectedFundingPercent.toFixed(3)}%\n` +
          `   Close percentage: ${(closePercent * 100).toFixed(0)}%\n` +
          `   LONG PnL: $${longPricePnl.toFixed(2)} on ${longPos.exchangeType}\n` +
          `   SHORT PnL: $${shortPricePnl.toFixed(2)} on ${shortPos.exchangeType}`
        );

        // Execute hedged partial close
        try {
          await this.orchestrator.executeHedgedPartialClose(
            longPos,
            shortPos,
            closePercent,
            `Profit Taking: $${(combinedPnl * closePercent).toFixed(2)} (${(closePercent * 100).toFixed(0)}% of position, ` +
            `reversion in ${expectedReversionHours.toFixed(0)}h)`
          );

          // Record cooldown only if we closed a significant portion (> 50%)
          if (closePercent >= 0.5) {
            this.profitTakeCooldowns.set(symbol, {
              exitTime: new Date(),
              exitPriceLong: longPos.markPrice || 0,
              exitPriceShort: shortPos.markPrice || 0,
              profitPercent: profitPercent * closePercent,
              longExchange: longPos.exchangeType,
              shortExchange: shortPos.exchangeType,
            });
          }

          this.logger.log(
            `✅ Profit taken for ${symbol}: $${(combinedPnl * closePercent).toFixed(2)} ` +
            `(${(closePercent * 100).toFixed(0)}% of position)\n` +
            `   Expected reversion: ${expectedReversionHours.toFixed(1)}h | ` +
            `Remaining position: ${((1 - closePercent) * 100).toFixed(0)}%` +
            (closePercent >= 0.5 ? `\n   🔒 Cooldown active` : '')
          );
        } catch (closeError: any) {
          this.logger.error(
            `❌ Failed to take profit for ${symbol}: ${closeError.message}`
          );
        }
      }
    } catch (error: any) {
      this.logger.debug(`Error in profit taking check: ${error.message}`);
    }
  }

  /**
   * Check if a symbol is in profit-taking cooldown
   * 
   * Returns true if we should NOT enter this symbol because:
   * 1. We recently took profit, AND
   * 2. The price hasn't reverted enough yet (< 50% of profit taken), AND
   * 3. Less than 1 hour has passed
   * 
   * @param symbol Normalized symbol to check
   * @param currentPriceLong Current mark price on long exchange
   * @param currentPriceShort Current mark price on short exchange
   */
  isInProfitTakeCooldown(
    symbol: string,
    currentPriceLong: number,
    currentPriceShort: number,
  ): { inCooldown: boolean; reason?: string } {
    const cooldown = this.profitTakeCooldowns.get(symbol);
    if (!cooldown) {
      return { inCooldown: false };
    }

    const now = new Date();
    const hoursSinceExit = (now.getTime() - cooldown.exitTime.getTime()) / (1000 * 60 * 60);

    // Cooldown expires after 1 hour regardless of price
    const COOLDOWN_HOURS = parseFloat(process.env.PROFIT_TAKE_COOLDOWN_HOURS || '1');
    if (hoursSinceExit >= COOLDOWN_HOURS) {
      this.profitTakeCooldowns.delete(symbol);
      this.logger.debug(`Profit-take cooldown expired for ${symbol} (${hoursSinceExit.toFixed(1)}h)`);
      return { inCooldown: false };
    }

    // Calculate how much price has reverted
    // For the cooldown to lift, we want price to revert by at least 50% of the profit we took
    const reversionThreshold = cooldown.profitPercent * 0.5; // 50% of profit taken

    // Calculate basis change (short price - long price) relative to position value
    // At exit: we profited because basis moved in our favor
    // For re-entry: basis should move back (revert) by at least half
    const exitBasis = cooldown.exitPriceShort - cooldown.exitPriceLong;
    const currentBasis = currentPriceShort - currentPriceLong;
    const avgPrice = (currentPriceLong + currentPriceShort) / 2;
    
    const basisChangePercent = avgPrice > 0 
      ? Math.abs((currentBasis - exitBasis) / avgPrice) * 100 
      : 0;

    if (basisChangePercent >= reversionThreshold) {
      this.profitTakeCooldowns.delete(symbol);
      this.logger.log(
        `✅ Profit-take cooldown lifted for ${symbol}: ` +
        `Basis reverted ${basisChangePercent.toFixed(2)}% (threshold: ${reversionThreshold.toFixed(2)}%)`
      );
      return { inCooldown: false };
    }

    return {
      inCooldown: true,
      reason: `Profit-take cooldown: ${(COOLDOWN_HOURS - hoursSinceExit).toFixed(1)}h remaining, ` +
              `basis reverted ${basisChangePercent.toFixed(2)}%/${reversionThreshold.toFixed(2)}% needed`,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SPREAD FLIP MONITORING - Exit when funding spread turns against us
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Monitor funding rate spreads and close positions when spread flips against us.
   * 
   * The strategy is profitable when: shortRate - longRate > 0
   * - We LONG on the exchange with lower (more negative) funding rate
   * - We SHORT on the exchange with higher (less negative) funding rate
   * 
   * When the spread flips (becomes negative), we're LOSING money and should exit.
   * 
   * Runs every 60 seconds to catch spread flips quickly.
   */
  @Interval(60000) // Every 60 seconds
  async checkSpreadFlips(): Promise<void> {
    // Skip if main execution is running
    if (this.isRunning) {
      return;
    }

    try {
      const allPositions = await this.keeperService.getAllPositions();
      const positions = allPositions.filter((p) => Math.abs(p.size) > 0.0001);

      if (positions.length === 0) {
        return;
      }

      // Group positions by normalized symbol to find pairs
      const positionsBySymbol = new Map<string, PerpPosition[]>();
      for (const position of positions) {
        const normalizedSymbol = this.normalizeSymbol(position.symbol);
        if (!positionsBySymbol.has(normalizedSymbol)) {
          positionsBySymbol.set(normalizedSymbol, []);
        }
        positionsBySymbol.get(normalizedSymbol)!.push(position);
      }

      // Check each paired position for spread flip
      for (const [symbol, symbolPositions] of positionsBySymbol) {
        // Need exactly 2 positions (one long, one short) on different exchanges
        if (symbolPositions.length !== 2) {
          continue;
        }

        const longPosition = symbolPositions.find((p) => p.side === OrderSide.LONG);
        const shortPosition = symbolPositions.find((p) => p.side === OrderSide.SHORT);

        if (!longPosition || !shortPosition) {
          continue;
        }

        // Skip if both on same exchange (shouldn't happen but safety check)
        if (longPosition.exchangeType === shortPosition.exchangeType) {
          continue;
        }

        // Get current funding rates for both exchanges
        try {
          const comparison = await this.orchestrator.compareFundingRates(symbol);
          if (!comparison || !comparison.rates || comparison.rates.length < 2) {
            continue;
          }

          const longExchangeRate = comparison.rates.find(
            (r) => r.exchange === longPosition.exchangeType
          );
          const shortExchangeRate = comparison.rates.find(
            (r) => r.exchange === shortPosition.exchangeType
          );

          if (!longExchangeRate || !shortExchangeRate) {
            continue;
          }

          // Calculate current spread: shortRate - longRate
          // Positive = profitable, Negative = losing money
          const currentSpread = shortExchangeRate.currentRate - longExchangeRate.currentRate;
          const spreadPercent = currentSpread * 100;

          // SPREAD FLIP DETECTION:
          // If spread is negative, we're losing money on funding
          // We want to "nope out" if the loss exceeds the churn cost or if it's unlikely to flip back
          const SPREAD_FLIP_THRESHOLD = 0.0000; // 0.00% threshold
          
          if (currentSpread < SPREAD_FLIP_THRESHOLD) {
            // SPREAD HAS FLIPPED - Check prediction before closing
            let shouldExit = true;
            let predictionReason = 'No prediction available';

            if (this.predictionService) {
              try {
                const spreadPrediction = await this.predictionService.getSpreadPrediction(
                  symbol,
                  longPosition.exchangeType,
                  shortPosition.exchangeType
                );

                const predictedSpread = spreadPrediction.predictedSpread;
                const confidence = spreadPrediction.confidence;
                
                // Calculate churn cost (fees + slippage to close and potentially re-open)
                const longFee = this.strategyConfig.getExchangeFeeRate(longPosition.exchangeType);
                const shortFee = this.strategyConfig.getExchangeFeeRate(shortPosition.exchangeType);
                const churnCost = (longFee + shortFee) * 2; // Close both + re-open both
                
                // If prediction is strongly positive, we might stay
                // Benefit of staying = predicted spread * confidence over next horizon
                const hourlyBenefit = predictedSpread * confidence;
                
                // Loss of staying = current spread (negative)
                const currentLoss = Math.abs(currentSpread);
                
                // We look at a 4-hour window for the "bounce back" to be conservative
                // This prevents "noping out" on minor fluctuations if a recovery is predicted
                const windowHours = 4;
                const totalFutureBenefit = hourlyBenefit * windowHours;
                const totalCostOfStayingAndChurning = (currentLoss * windowHours) + churnCost;
                
                if (predictedSpread > 0 && totalFutureBenefit > totalCostOfStayingAndChurning) {
                  shouldExit = false;
                  predictionReason = `Predicted to recover: ${(predictedSpread * 100).toFixed(4)}% spread ` +
                    `(confidence: ${(confidence * 100).toFixed(0)}%) → Benefit $${totalFutureBenefit.toFixed(4)} > Cost+Churn $${totalCostOfStayingAndChurning.toFixed(4)}`;
                } else {
                  predictionReason = `Prediction confirms negative trend or insufficient recovery: ` +
                    `${(predictedSpread * 100).toFixed(4)}% spread (confidence: ${(confidence * 100).toFixed(0)}%)`;
                }
              } catch (error: any) {
                this.logger.debug(`Prediction failed for ${symbol} spread flip check: ${error.message}`);
              }
            }

            if (shouldExit) {
              this.logger.error(
                `🚨 SPREAD FLIP DETECTED for ${symbol}! ` +
                `Current spread: ${spreadPercent.toFixed(4)}% ` +
                `(LONG on ${longPosition.exchangeType} @ ${(longExchangeRate.currentRate * 100).toFixed(4)}%, ` +
                `SHORT on ${shortPosition.exchangeType} @ ${(shortExchangeRate.currentRate * 100).toFixed(4)}%) ` +
                `- [${predictionReason}] - CLOSING BOTH POSITIONS`
              );

              // Record to diagnostics
              if (this.diagnosticsService) {
                this.diagnosticsService.recordError({
                  type: 'SPREAD_FLIP_EXIT',
                  exchange: longPosition.exchangeType,
                  message: `Spread flipped for ${symbol}: ${spreadPercent.toFixed(4)}%. ${predictionReason}. Closing positions.`,
                  timestamp: new Date(),
                });
              }

              // Close both positions using hedged close
              await this.closeSpreadFlipPosition(symbol, longPosition, shortPosition);
            } else {
              this.logger.log(
                `🔒 HOLDING flipped position ${symbol} due to prediction: ${predictionReason}`
              );
            }

          } else {
            // Spread is very thin - warn but don't close yet
            this.logger.warn(
              `⚠️ THIN SPREAD WARNING for ${symbol}: ${spreadPercent.toFixed(4)}% ` +
              `(LONG @ ${(longExchangeRate.currentRate * 100).toFixed(4)}%, ` +
              `SHORT @ ${(shortExchangeRate.currentRate * 100).toFixed(4)}%) ` +
              `- Consider closing if it continues`
            );
          }

        } catch (error: any) {
          this.logger.debug(
            `Could not check spread for ${symbol}: ${error.message}`
          );
        }
      }
    } catch (error: any) {
      this.logger.error(`Spread flip check failed: ${error.message}`);
    }
  }

  /**
   * Close both legs of a position due to spread flip
   */
  private async closeSpreadFlipPosition(
    symbol: string,
    longPosition: PerpPosition,
    shortPosition: PerpPosition,
  ): Promise<void> {
    const threadId = this.executionLockService?.generateThreadId() || `spread-flip-${Date.now()}`;

    // Acquire symbol lock
    if (this.executionLockService) {
      const lockAcquired = this.executionLockService.tryAcquireSymbolLock(
        symbol,
        threadId,
        'spread-flip-close'
      );
      if (!lockAcquired) {
        this.logger.warn(`Could not acquire lock for spread flip close of ${symbol}`);
        return;
      }
    }

    try {
      const longAdapter = this.keeperService.getExchangeAdapters().get(longPosition.exchangeType);
      const shortAdapter = this.keeperService.getExchangeAdapters().get(shortPosition.exchangeType);

      if (!longAdapter || !shortAdapter) {
        this.logger.error(`Missing adapter for spread flip close of ${symbol}`);
        return;
      }

      // Get current mark prices
      const longMarkPrice = await longAdapter.getMarkPrice(longPosition.symbol).catch(() => longPosition.entryPrice);
      const shortMarkPrice = await shortAdapter.getMarkPrice(shortPosition.symbol).catch(() => shortPosition.entryPrice);

      // Create close orders (reduceOnly)
      const closeLongOrder = new PerpOrderRequest(
        longPosition.symbol,
        OrderSide.SHORT, // Opposite side to close
        OrderType.MARKET,
        longPosition.size,
        longMarkPrice,
        TimeInForce.IOC,
        true, // reduceOnly
      );

      const closeShortOrder = new PerpOrderRequest(
        shortPosition.symbol,
        OrderSide.LONG, // Opposite side to close
        OrderType.MARKET,
        shortPosition.size,
        shortMarkPrice,
        TimeInForce.IOC,
        true, // reduceOnly
      );

      // Execute both closes simultaneously
      this.logger.log(
        `📤 Closing spread flip positions for ${symbol}: ` +
        `LONG ${longPosition.size} on ${longPosition.exchangeType}, ` +
        `SHORT ${shortPosition.size} on ${shortPosition.exchangeType}`
      );

      const [longResult, shortResult] = await Promise.allSettled([
        longAdapter.placeOrder(closeLongOrder),
        shortAdapter.placeOrder(closeShortOrder),
      ]);

      // Log results
      const longSuccess = longResult.status === 'fulfilled' && longResult.value.isSuccess();
      const shortSuccess = shortResult.status === 'fulfilled' && shortResult.value.isSuccess();

      if (longSuccess && shortSuccess) {
        this.logger.log(
          `✅ Successfully closed spread flip positions for ${symbol}`
        );

        // Record PnL for both sides
        if (this.performanceLogger) {
          const longRes = (longResult as any).value as PerpOrderResponse;
          const shortRes = (shortResult as any).value as PerpOrderResponse;
          
          const longExitPrice = longRes.averageFillPrice || longMarkPrice;
          const shortExitPrice = shortRes.averageFillPrice || shortMarkPrice;
          
          const longPnl = (longExitPrice - longPosition.entryPrice) * longPosition.size * 1; // LONG
          const shortPnl = (shortExitPrice - shortPosition.entryPrice) * shortPosition.size * -1; // SHORT
          
          this.performanceLogger.recordRealizedPnl(longPnl + shortPnl);
          this.logger.log(`📈 Recorded realized PnL from spread flip close: $${(longPnl + shortPnl).toFixed(4)} (Long: $${longPnl.toFixed(4)}, Short: $${shortPnl.toFixed(4)})`);
        }
      } else {
        this.logger.error(
          `⚠️ Partial close for ${symbol}: ` +
          `LONG=${longSuccess ? '✓' : '✗'}, SHORT=${shortSuccess ? '✓' : '✗'}`
        );
      }

    } finally {
      // Release lock
      if (this.executionLockService) {
        this.executionLockService.releaseSymbolLock(symbol, threadId);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SPREAD ROTATION - Rotate to better opportunities when spread thins out
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Periodic spread rotation check - runs every 5 minutes
   * 
   * When current position's spread is thinning out and there are better opportunities
   * available, this check evaluates if rotating to the new opportunity would reduce
   * the time to break-even, factoring in:
   * - Current position's remaining break-even time
   * - Carry-forward costs (sunk costs from current position)
   * - New position's entry/exit fees + slippage
   * 
   * Only rotates if the new opportunity reaches break-even faster than staying.
   */
  @Interval(180000) // Every 3 minutes (was 5 min)
  async checkSpreadRotation(): Promise<void> {
    // Skip if main execution is running or missing required services
    if (this.isRunning) return;
    if (!this.opportunityEvaluator || !this.executionPlanBuilder) {
      this.logger.debug('Spread rotation check skipped: missing OpportunityEvaluator or ExecutionPlanBuilder');
      return;
    }

    try {
      const allPositions = await this.keeperService.getAllPositions();
      const positions = allPositions.filter((p) => Math.abs(p.size) > 0.0001);

      if (positions.length === 0) return;

      // Group positions by normalized symbol to find hedged pairs
      const positionsBySymbol = new Map<string, PerpPosition[]>();
      for (const position of positions) {
        const normalizedSymbol = this.normalizeSymbol(position.symbol);
        if (!positionsBySymbol.has(normalizedSymbol)) {
          positionsBySymbol.set(normalizedSymbol, []);
        }
        positionsBySymbol.get(normalizedSymbol)!.push(position);
      }

      // Find all available opportunities
      const opportunities = await this.orchestrator.findArbitrageOpportunities(
        this.symbols.length > 0 ? this.symbols : Array.from(positionsBySymbol.keys()),
        this.minSpread * 0.5, // Look at opportunities with at least half the min spread
        false, // No progress bar
      );

      if (opportunities.length === 0) {
        this.logger.debug('No alternative opportunities found for spread rotation');
        return;
      }

      // Get exchange balances
      const adapters = this.keeperService.getExchangeAdapters();
      const exchangeBalances = new Map<ExchangeType, number>();
      for (const [exchange, adapter] of adapters) {
        try {
          const balance = await adapter.getBalance();
          exchangeBalances.set(exchange, balance);
        } catch {
          exchangeBalances.set(exchange, 0);
        }
      }

      // For each current position pair, check if there's a better opportunity
      for (const [currentSymbol, symbolPositions] of positionsBySymbol) {
        const longPos = symbolPositions.find(p => p.side === OrderSide.LONG);
        const shortPos = symbolPositions.find(p => p.side === OrderSide.SHORT);

        // Only evaluate hedged pairs
        if (!longPos || !shortPos) continue;

        // Skip if position is in profit-take cooldown
        const longMarkPrice = longPos.markPrice || longPos.entryPrice;
        const shortMarkPrice = shortPos.markPrice || shortPos.entryPrice;
        const cooldownCheck = this.isInProfitTakeCooldown(currentSymbol, longMarkPrice, shortMarkPrice);
        if (cooldownCheck.inCooldown) continue;

        // Find best alternative opportunity (different from current)
        const betterOpportunities = opportunities.filter(opp => {
          const oppSymbol = this.normalizeSymbol(opp.symbol);
          // Must be a different symbol
          if (oppSymbol === currentSymbol) return false;
          // Must be perp-perp (has short exchange)
          if (!opp.shortExchange) return false;
          return true;
        });

        // Sort by expected return
        betterOpportunities.sort((a, b) => 
          (b.expectedReturn?.toDecimal() || 0) - (a.expectedReturn?.toDecimal() || 0)
        );

        // Evaluate top 3 alternatives
        for (const newOpp of betterOpportunities.slice(0, 3)) {
          const rotationDecision = await this.evaluateSpreadRotation(
            longPos,
            shortPos,
            newOpp,
            adapters,
            exchangeBalances,
          );

          if (rotationDecision.shouldRotate) {
            this.logger.warn(
              `🔄 SPREAD ROTATION OPPORTUNITY: ${currentSymbol} → ${newOpp.symbol}\n` +
              `   Current remaining break-even: ${rotationDecision.currentBreakEvenHours?.toFixed(1) || '∞'}h\n` +
              `   New position break-even: ${rotationDecision.newBreakEvenHours?.toFixed(1) || '∞'}h\n` +
              `   Time saved: ${rotationDecision.hoursSaved?.toFixed(1) || 0}h\n` +
              `   Reason: ${rotationDecision.reason}`
            );

            // Execute rotation: close current, open new
            await this.executeSpreadRotation(
              longPos,
              shortPos,
              newOpp,
              rotationDecision.reason,
            );

            // Only rotate one position per check cycle
            return;
          }
        }
      }

      this.logger.debug('No profitable spread rotation opportunities found');
    } catch (error: any) {
      this.logger.warn(`Error during spread rotation check: ${error.message}`);
    }
  }

  /**
   * Evaluate if rotating from current position to a new opportunity is profitable
   */
  private async evaluateSpreadRotation(
    currentLongPos: PerpPosition,
    currentShortPos: PerpPosition,
    newOpportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    exchangeBalances: Map<ExchangeType, number>,
  ): Promise<{
    shouldRotate: boolean;
    reason: string;
    currentBreakEvenHours: number | null;
    newBreakEvenHours: number | null;
    hoursSaved: number | null;
  }> {
    try {
      if (!this.opportunityEvaluator || !this.executionPlanBuilder) {
        return { shouldRotate: false, reason: 'Missing services', currentBreakEvenHours: null, newBreakEvenHours: null, hoursSaved: null };
      }

      // Get leverage for new opportunity
      let leverage = 1;
      if (this.optimalLeverageService) {
        try {
          const leverageRec = await this.optimalLeverageService.calculateOptimalLeverage(
            newOpportunity.symbol,
            newOpportunity.longExchange,
          );
          leverage = leverageRec.optimalLeverage || 1;
        } catch {
          leverage = 1;
        }
      }

      // Get balances for the new opportunity's exchanges
      const longBalance = exchangeBalances.get(newOpportunity.longExchange) || 0;
      const shortBalance = exchangeBalances.get(newOpportunity.shortExchange!) || 0;

      // Create execution plan for the new opportunity
      const planResult = await this.executionPlanBuilder.buildPlan(
        newOpportunity,
        adapters,
        { longBalance, shortBalance },
        this.strategyConfig,
        newOpportunity.longMarkPrice,
        newOpportunity.shortMarkPrice,
        this.maxPositionSizeUsd,
        leverage,
      );

      if (planResult.isFailure) {
        return { shouldRotate: false, reason: `Failed to create plan: ${planResult.error.message}`, currentBreakEvenHours: null, newBreakEvenHours: null, hoursSaved: null };
      }

      const newPlan = planResult.value;

      // Use the shouldRebalance logic to evaluate
      const rebalanceResult = await this.opportunityEvaluator.shouldRebalance(
        currentLongPos, // Use long position as the "current position" for evaluation
        newOpportunity,
        newPlan,
        0, // cumulativeLoss - we'll use the break-even calculation instead
        adapters,
      );

      if (rebalanceResult.isFailure) {
        return { shouldRotate: false, reason: `Evaluation failed: ${rebalanceResult.error.message}`, currentBreakEvenHours: null, newBreakEvenHours: null, hoursSaved: null };
      }

      const { shouldRebalance, reason, currentBreakEvenHours, newBreakEvenHours } = rebalanceResult.value;

      // Calculate hours saved
      let hoursSaved: number | null = null;
      if (currentBreakEvenHours !== null && newBreakEvenHours !== null) {
        hoursSaved = currentBreakEvenHours - newBreakEvenHours;
      }

      // Add extra validation: only rotate if we save at least 2 hours
      const MIN_HOURS_SAVED = parseFloat(
        this.configService.get<string>('ROTATION_MIN_HOURS_SAVED') || '2'
      );

      if (shouldRebalance && (hoursSaved === null || hoursSaved < MIN_HOURS_SAVED)) {
        return {
          shouldRotate: false,
          reason: `Time saved (${hoursSaved?.toFixed(1) || 0}h) < minimum (${MIN_HOURS_SAVED}h)`,
          currentBreakEvenHours,
          newBreakEvenHours,
          hoursSaved,
        };
      }

      return {
        shouldRotate: shouldRebalance,
        reason,
        currentBreakEvenHours,
        newBreakEvenHours,
        hoursSaved,
      };
    } catch (error: any) {
      return { 
        shouldRotate: false, 
        reason: `Error: ${error.message}`, 
        currentBreakEvenHours: null, 
        newBreakEvenHours: null, 
        hoursSaved: null 
      };
    }
  }

  /**
   * Execute a spread rotation: close current position, open new position
   */
  private async executeSpreadRotation(
    currentLongPos: PerpPosition,
    currentShortPos: PerpPosition,
    newOpportunity: ArbitrageOpportunity,
    reason: string,
  ): Promise<void> {
    const currentSymbol = this.normalizeSymbol(currentLongPos.symbol);
    const newSymbol = this.normalizeSymbol(newOpportunity.symbol);
    
    // Acquire locks for both symbols
    const threadId = this.executionLockService?.generateThreadId() || `rotation-${Date.now()}`;
    
    if (this.executionLockService) {
      const currentLocked = this.executionLockService.tryAcquireSymbolLock(currentSymbol, threadId, 'spreadRotationClose');
      const newLocked = this.executionLockService.tryAcquireSymbolLock(newSymbol, threadId, 'spreadRotationOpen');
      
      if (!currentLocked || !newLocked) {
        this.logger.warn(`Could not acquire locks for spread rotation ${currentSymbol} → ${newSymbol}`);
        // Release any acquired lock
        if (currentLocked) this.executionLockService.releaseSymbolLock(currentSymbol, threadId);
        if (newLocked) this.executionLockService.releaseSymbolLock(newSymbol, threadId);
        return;
      }
    }

    try {
      this.logger.log(
        `🔄 Executing spread rotation: ${currentSymbol} → ${newSymbol}\n` +
        `   Reason: ${reason}`
      );

      // Step 1: Close current position
      this.logger.log(`📤 Step 1: Closing current position ${currentSymbol}...`);
      await this.orchestrator.executeHedgedPartialClose(
        currentLongPos,
        currentShortPos,
        1.0, // Close 100%
        `Spread Rotation to ${newSymbol}`,
      );

      // Small delay to let closes settle
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 2: Open new position by triggering normal execution
      this.logger.log(`📥 Step 2: Opening new position ${newSymbol}...`);
      
      // Execute strategy for just the new symbol
      const result = await this.orchestrator.executeArbitrageStrategy(
        [newOpportunity.symbol],
        this.minSpread,
        this.maxPositionSizeUsd,
      );

      if (result.opportunitiesExecuted > 0) {
        this.logger.log(
          `✅ Spread rotation complete: ${currentSymbol} → ${newSymbol}\n` +
          `   Executed ${result.opportunitiesExecuted} new position(s)`
        );
      } else {
        this.logger.warn(
          `⚠️ Spread rotation partial: Closed ${currentSymbol} but failed to open ${newSymbol}\n` +
          `   Errors: ${result.errors?.join(', ') || 'unknown'}`
        );
      }

    } catch (error: any) {
      this.logger.error(`❌ Spread rotation failed: ${error.message}`);
    } finally {
      // Release locks
      if (this.executionLockService) {
        this.executionLockService.releaseSymbolLock(currentSymbol, threadId);
        this.executionLockService.releaseSymbolLock(newSymbol, threadId);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LIQUIDATION MONITORING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Periodic liquidation risk check - runs every 30 seconds
   * Monitors all positions for liquidation proximity and triggers emergency close
   * if any leg reaches 70% proximity to liquidation price.
   *
   * CRITICAL: If either leg of a delta-neutral position approaches liquidation,
   * BOTH legs must be closed immediately to prevent unhedged exposure.
   */
  @Interval(30000) // Every 30 seconds (30000 ms)
  async checkLiquidationRisk(): Promise<void> {
    if (!this.liquidationMonitor) {
      return; // Not configured
    }

    // Skip if main execution is running (to avoid conflicts)
    if (this.isRunning) {
      return;
    }

    try {
      // Refresh market state before checking liquidation risk
      if (this.marketStateService) {
        await this.marketStateService.refreshAll();
      }

      const result = await this.liquidationMonitor.checkLiquidationRisk();

      // Log summary if there are positions at risk
      if (result.positionsAtRisk > 0) {
        this.logger.warn(
          `🚨 Liquidation check: ${result.positionsAtRisk}/${result.positionsChecked} positions at risk`,
        );
      }

      // Record to diagnostics if available
      if (this.diagnosticsService && result.positionsChecked > 0) {
        const riskSummary = result.positions.map((p) => ({
          symbol: p.symbol,
          longProximity: p.longRisk.proximityToLiquidation,
          shortProximity: p.shortRisk.proximityToLiquidation,
          longRiskLevel: p.longRisk.riskLevel,
          shortRiskLevel: p.shortRisk.riskLevel,
        }));

        // Record to diagnostics (using existing error recording for now)
        if (result.positionsAtRisk > 0) {
          this.diagnosticsService.recordError({
            type: 'LIQUIDATION_RISK_DETECTED',
            message: `${result.positionsAtRisk} position(s) at risk: ${riskSummary
              .filter(
                (r) =>
                  r.longRiskLevel !== 'SAFE' || r.shortRiskLevel !== 'SAFE',
              )
              .map(
                (r) =>
                  `${r.symbol} (L:${r.longRiskLevel}, S:${r.shortRiskLevel})`,
              )
              .join(', ')}`,
            timestamp: new Date(),
          });
        }
      }

      // Log emergency closes if any occurred
      if (result.emergencyClosesTriggered > 0) {
        this.logger.error(
          `🚨 EMERGENCY CLOSES EXECUTED: ${result.emergencyClosesTriggered} position(s) closed`,
        );
        for (const close of result.emergencyCloses) {
          this.logger.error(
            `   ${close.symbol}: ${close.triggerReason} - ` +
              `LONG=${close.longCloseSuccess ? '✓' : `✗ ${close.longCloseError}`}, ` +
              `SHORT=${close.shortCloseSuccess ? '✓' : `✗ ${close.shortCloseError}`}`,
          );
        }
        
        // Trigger opportunity search after emergency closes - capital is now free!
        this.scheduleOpportunitySearch('emergency-liquidation-exit');
      }
    } catch (error: any) {
      this.logger.error(`Liquidation check failed: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // KEEPER STRATEGY INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process pending withdrawal requests from KeeperStrategyManager
   * Runs every 5 minutes to ensure timely fulfillment (1 hour deadline)
   */
  @Interval(300000) // Every 5 minutes (300000 ms)
  async processKeeperWithdrawals(): Promise<void> {
    if (!this.withdrawalFulfiller) {
      return; // Not configured
    }

    try {
      const pendingList = this.withdrawalFulfiller.getPendingWithdrawalsList();

      if (pendingList.length === 0) {
        return; // Nothing to process
      }

      this.logger.log(
        `📤 Processing ${pendingList.length} pending withdrawal request(s)...`,
      );

      const results =
        await this.withdrawalFulfiller.processPendingWithdrawals();

      if (results.processed > 0) {
        this.logger.log(
          `Withdrawal processing complete: ${results.fulfilled}/${results.processed} fulfilled, ${results.failed} failed`,
        );
      }

      // If there are still pending withdrawals with deadlines approaching, log warning
      const urgentWithdrawals = pendingList.filter((w) => {
        const timeUntilDeadline = w.deadline.getTime() - Date.now();
        return timeUntilDeadline < 30 * 60 * 1000; // Less than 30 minutes
      });

      if (urgentWithdrawals.length > 0) {
        this.logger.warn(
          `⚠️ ${urgentWithdrawals.length} withdrawal(s) have deadlines in < 30 minutes!`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Error processing keeper withdrawals: ${error.message}`,
      );
    }
  }

  /**
   * Check if NAV needs to be reported (e.g., after significant changes)
   * NAVReporter has its own hourly interval, but we can trigger extra reports here
   */
  async checkAndReportNAV(): Promise<void> {
    if (!this.navReporter) {
      return; // Not configured
    }

    try {
      // Check if NAV is stale
      if (this.navReporter.isNAVStale()) {
        this.logger.warn('NAV is stale, forcing report...');
        await this.navReporter.forceReportNAV();
      }
    } catch (error: any) {
      this.logger.error(`Error checking NAV: ${error.message}`);
    }
  }

  /**
   * Get keeper strategy status for diagnostics
   */
  async getKeeperStrategyStatus(): Promise<{
    pendingWithdrawals: number;
    pendingAmount: string;
    lastNAV: string;
    lastNAVTime: Date | null;
    isNAVStale: boolean;
    emergencyMode: boolean;
  }> {
    return {
      pendingWithdrawals:
        this.withdrawalFulfiller?.getPendingWithdrawalsList().length || 0,
      pendingAmount: this.withdrawalFulfiller
        ? formatUnits(this.withdrawalFulfiller.getTotalPendingAmount(), 6)
        : '0',
      lastNAV: this.navReporter
        ? formatUnits(this.navReporter.getLastReportedNAV().nav, 6)
        : '0',
      lastNAVTime: this.navReporter?.getLastReportedNAV().timestamp || null,
      isNAVStale: this.navReporter?.isNAVStale() || false,
      emergencyMode: this.withdrawalFulfiller?.isEmergencyMode() || false,
    };
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
    // Note: This is a synchronous read-only operation, but we should still be careful
    // We don't use mutex here for performance, but access is read-only
    for (const [key, retryInfo] of this.singleLegRetries.entries()) {
      if (
        key.startsWith(`${symbol}-`) &&
        (retryInfo.longExchange === exchange1 ||
          retryInfo.shortExchange === exchange1)
      ) {
        return key;
      }
    }
    // Fallback: create key with just symbol and exchange
    return `${symbol}-${exchange1}`;
  }

  // ========== Protected retry state access methods ==========

  /**
   * Check if an opportunity is filtered out (protected by mutex)
   */
  private async isOpportunityFiltered(retryKey: string): Promise<boolean> {
    return this.retryStateMutex.runExclusive(async () => {
      return this.filteredOpportunities.has(retryKey);
    }, 'isOpportunityFiltered');
  }

  /**
   * Get retry info for a key (protected by mutex)
   */
  private async getRetryInfo(
    retryKey: string,
    longExchange: ExchangeType,
    shortExchange: ExchangeType,
  ): Promise<{
    retryCount: number;
    longExchange: ExchangeType;
    shortExchange: ExchangeType;
    lastRetryTime: Date;
  }> {
    return this.retryStateMutex.runExclusive(async () => {
      let retryInfo = this.singleLegRetries.get(retryKey);
      if (!retryInfo) {
        retryInfo = {
          retryCount: 0,
          longExchange,
          shortExchange,
          lastRetryTime: new Date(),
        };
        this.singleLegRetries.set(retryKey, retryInfo);
      }
      return { ...retryInfo }; // Return a copy to avoid external mutation
    }, 'getRetryInfo');
  }

  /**
   * Increment retry count and check if should be filtered (protected by mutex)
   * Returns true if opportunity should now be filtered out
   */
  private async incrementRetryAndCheckFilter(
    retryKey: string,
  ): Promise<boolean> {
    return this.retryStateMutex.runExclusive(async () => {
      const retryInfo = this.singleLegRetries.get(retryKey);
      if (!retryInfo) return false;

      retryInfo.retryCount++;
      retryInfo.lastRetryTime = new Date();

      if (retryInfo.retryCount >= 5) {
        this.filteredOpportunities.add(retryKey);
        return true;
      }
      return false;
    }, 'incrementRetryAndCheckFilter');
  }

  /**
   * Mark retry as successful and clear retry info (protected by mutex)
   */
  private async clearRetryOnSuccess(retryKey: string): Promise<void> {
    return this.retryStateMutex.runExclusive(async () => {
      this.singleLegRetries.delete(retryKey);
    }, 'clearRetryOnSuccess');
  }

  /**
   * Add opportunity to filtered set (protected by mutex)
   */
  private async addToFiltered(retryKey: string): Promise<void> {
    return this.retryStateMutex.runExclusive(async () => {
      this.filteredOpportunities.add(retryKey);
    }, 'addToFiltered');
  }

  // ========== End protected retry state access methods ==========

  /**
   * Try to open the missing side of a single-leg position
   * Returns true if successful, false if retries exhausted
   *
   * IMPORTANT: Checks for existing pending orders before placing new ones to prevent
   * duplicate orders (e.g., 4 Lighter orders for 1 Hyperliquid position)
   * 
   * CRITICAL FIX: Uses the ORIGINAL opportunity's exchange assignments, not current funding rates.
   * Funding rates change constantly - we must honor the original arbitrage plan.
   */
  private async tryOpenMissingSide(position: PerpPosition): Promise<boolean> {
    try {
      // First, check if we have stored retry info with the original exchange assignments
      // This is crucial - we must use the ORIGINAL opportunity's exchanges, not recalculate
      let expectedLongExchange: ExchangeType | undefined;
      let expectedShortExchange: ExchangeType | undefined;
      
      // Look for existing retry info that tells us the original exchange assignments
      for (const [, retryInfo] of this.singleLegRetries.entries()) {
        if (
          retryInfo.longExchange === position.exchangeType ||
          retryInfo.shortExchange === position.exchangeType
        ) {
          // Found the original opportunity info - use those exchanges
          expectedLongExchange = retryInfo.longExchange;
          expectedShortExchange = retryInfo.shortExchange;
          this.logger.debug(
            `📋 Using stored retry info for ${position.symbol}: ` +
            `LONG on ${expectedLongExchange}, SHORT on ${expectedShortExchange}`
          );
          break;
        }
      }
      
      // If no retry info, we need to determine exchanges based on current position
      // The existing position tells us ONE exchange - the missing side is on the OTHER exchange
      if (!expectedLongExchange || !expectedShortExchange) {
        // Find all available exchanges for this symbol
        const comparison = await this.orchestrator.compareFundingRates(
          position.symbol,
        );
        if (!comparison || comparison.rates.length < 2) {
          return false;
        }
        
        // Get all exchanges that support this symbol
        const availableExchanges = comparison.rates.map(r => r.exchange);
        
        // The position is on one exchange - find a DIFFERENT exchange for the missing side
        const otherExchanges = availableExchanges.filter(e => e !== position.exchangeType);
        if (otherExchanges.length === 0) {
          this.logger.warn(
            `No other exchanges available for ${position.symbol} to open missing side`
          );
          return false;
        }
        
        // Use the first other exchange (prefer Hyperliquid if available)
        const missingExchangeCandidate = otherExchanges.includes(ExchangeType.HYPERLIQUID)
          ? ExchangeType.HYPERLIQUID
          : otherExchanges[0];
        
        // Determine which side is missing based on position
        if (position.side === OrderSide.LONG) {
          // We have LONG, missing SHORT - SHORT should be on a different exchange
          expectedLongExchange = position.exchangeType;
          expectedShortExchange = missingExchangeCandidate;
        } else {
          // We have SHORT, missing LONG - LONG should be on a different exchange
          expectedShortExchange = position.exchangeType;
          expectedLongExchange = missingExchangeCandidate;
        }
        
        this.logger.log(
          `📋 Determined exchanges for ${position.symbol}: ` +
          `LONG on ${expectedLongExchange}, SHORT on ${expectedShortExchange} ` +
          `(existing position: ${position.side} on ${position.exchangeType})`
        );
      }

      // Determine missing exchange and side
      // CRITICAL: The missing side MUST be on a DIFFERENT exchange than the existing position
      const missingExchange =
        position.side === OrderSide.LONG
          ? expectedShortExchange
          : expectedLongExchange;
      const missingSide =
        position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;
      
      // SAFETY CHECK: Ensure we're not placing on the same exchange
      if (missingExchange === position.exchangeType) {
        this.logger.error(
          `🚨 BUG DETECTED: Attempted to place ${missingSide} on same exchange (${missingExchange}) ` +
          `as existing ${position.side} position. This would NOT be delta-neutral arbitrage!`
        );
        return false;
      }

      // Get retry key
      const retryKey = this.getRetryKey(
        position.symbol,
        expectedLongExchange,
        expectedShortExchange,
      );

      // Check if already filtered out (mutex protected)
      if (await this.isOpportunityFiltered(retryKey)) {
        return false;
      }

      const adapter = this.keeperService.getExchangeAdapter(missingExchange);
      if (!adapter) {
        return false;
      }

      // ========== CRITICAL: Check for existing pending orders BEFORE placing new ones ==========
      // This prevents duplicate orders when the single-leg check runs multiple times
      const PENDING_ORDER_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes - give orders time to fill

      this.logger.log(
        `🔍 Checking for existing pending orders on ${missingExchange} for ${position.symbol} ${missingSide}...`,
      );

      if (typeof (adapter as any).getOpenOrders === 'function') {
        try {
          const openOrders = await (adapter as any).getOpenOrders();
          this.logger.debug(
            `🔍 Retrieved ${openOrders.length} open order(s) from ${missingExchange}`,
          );
          const pendingOrdersForSymbol = openOrders.filter((order: any) => {
            // Match by symbol (handle different formats: YZY, YZY-USD, YZYUSD)
            const normalizedOrderSymbol = order.symbol
              ?.toUpperCase()
              ?.replace('-USD', '')
              ?.replace('USD', '');
            const normalizedPositionSymbol = position.symbol
              ?.toUpperCase()
              ?.replace('-USD', '')
              ?.replace('USD', '');

            // Normalize side - different exchanges use different formats:
            // Hyperliquid: 'buy'/'sell', Lighter: 'LONG'/'SHORT' or 'BUY'/'SELL'
            const orderSide = order.side?.toUpperCase();
            const isOrderLong =
              orderSide === 'LONG' || orderSide === 'BUY' || orderSide === 'B';
            const isOrderShort =
              orderSide === 'SHORT' ||
              orderSide === 'SELL' ||
              orderSide === 'S';
            const isMissingSideLong = missingSide === OrderSide.LONG;

            const sideMatches =
              (isMissingSideLong && isOrderLong) ||
              (!isMissingSideLong && isOrderShort);

            return (
              normalizedOrderSymbol === normalizedPositionSymbol && sideMatches
            );
          });

          if (pendingOrdersForSymbol.length > 0) {
            // Check age of oldest pending order
            const now = Date.now();
            const oldestOrder = pendingOrdersForSymbol.reduce(
              (oldest: any, order: any) => {
                const orderTime = order.timestamp
                  ? new Date(order.timestamp).getTime()
                  : now;
                const oldestTime = oldest.timestamp
                  ? new Date(oldest.timestamp).getTime()
                  : now;
                return orderTime < oldestTime ? order : oldest;
              },
              pendingOrdersForSymbol[0],
            );

            const orderAge =
              now -
              (oldestOrder.timestamp
                ? new Date(oldestOrder.timestamp).getTime()
                : now);

            if (orderAge < PENDING_ORDER_GRACE_PERIOD_MS) {
              // Orders are still fresh - wait for them to fill, don't place more
              this.logger.debug(
                `⏳ Waiting for ${pendingOrdersForSymbol.length} pending ${missingSide} order(s) for ${position.symbol} ` +
                  `on ${missingExchange} (${Math.round(orderAge / 1000)}s old, grace period: ${PENDING_ORDER_GRACE_PERIOD_MS / 1000}s)`,
              );
              return false; // Don't place new order, but also don't exhaust retries
            } else {
              // Orders are stale (> 5 min) - cancel them and retry
              this.logger.warn(
                `🗑️ Cancelling ${pendingOrdersForSymbol.length} stale pending order(s) for ${position.symbol} ` +
                  `on ${missingExchange} (${Math.round(orderAge / 60000)} minutes old)`,
              );
              for (const order of pendingOrdersForSymbol) {
                try {
                  await adapter.cancelOrder(order.orderId, position.symbol);
                } catch (cancelError: any) {
                  this.logger.debug(
                    `Failed to cancel stale order ${order.orderId}: ${cancelError.message}`,
                  );
                }
              }
              // Wait for cancellations to process
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        } catch (openOrdersError: any) {
          this.logger.debug(
            `Could not check open orders on ${missingExchange}: ${openOrdersError.message}`,
          );
          // Continue - we'll place the order anyway
        }
      }
      // ========================================================================================

      // Get or create retry info (mutex protected)
      const retryInfo = await this.getRetryInfo(
        retryKey,
        expectedLongExchange,
        expectedShortExchange,
      );

      // Check retry count
      if (retryInfo.retryCount >= 5) {
        await this.addToFiltered(retryKey);
        return false;
      }

      // Try to open missing side: use LIMIT at mark price to act as maker
      this.logger.log(
        `🔄 Retry ${retryInfo.retryCount + 1}/5: Opening missing ${missingSide} side for ${position.symbol} on ${missingExchange} (Maker order @ Mark Price)`,
      );

      // Get current mark price
      let markPrice: number | undefined;
      try {
        markPrice = await adapter.getMarkPrice(position.symbol);
      } catch (priceError: any) {
        this.logger.warn(
          `Could not get mark price for ${position.symbol} retry, using fallback: ${priceError.message}`,
        );
      }

      // Create limit order to open missing side at mark price
      const openOrder = new PerpOrderRequest(
        position.symbol,
        missingSide,
        OrderType.LIMIT,
        position.size,
        markPrice,
        TimeInForce.GTC,
        false, // not reduceOnly
      );

      const orderResult = await adapter.placeOrder(openOrder);

      if (orderResult && orderResult.orderId) {
        // ================================================================================
        // CRITICAL: Use the same order fill logic as initial order placement
        // 1. Register order with ExecutionLockService so MakerEfficiencyService can reprice it
        // 2. Use the same wait/poll logic with exponential backoff
        // 3. MakerEfficiencyService will automatically reprice to stay competitive
        // ================================================================================

        const orderSide = missingSide === OrderSide.LONG ? 'LONG' : 'SHORT';
        const threadId = this.executionLockService?.generateThreadId() || `single-leg-${Date.now()}`;

        // Register the order so MakerEfficiencyService can reprice it
        if (this.executionLockService) {
          this.executionLockService.registerOrderPlacing(
            orderResult.orderId,
            position.symbol,
            missingExchange,
            orderSide,
            threadId,
            position.size,
            markPrice,
          );
          this.executionLockService.updateOrderStatus(
            missingExchange,
            position.symbol,
            orderSide,
            'WAITING_FILL',
            orderResult.orderId,
            markPrice,
            false, // not reduceOnly
          );
        }

        this.logger.log(
          `⏳ Waiting for ${missingSide} order ${orderResult.orderId} to fill on ${missingExchange} ` +
          `(MakerEfficiencyService will reprice to stay competitive)...`,
        );

        // Use the same wait logic as OrderExecutor - exponential backoff with max retries
        // This matches the initial order placement behavior
        const MAX_RETRIES = 15; // Same as OrderExecutor default
        const BASE_POLL_INTERVAL_MS = 2000; // Same as OrderExecutor
        const MAX_BACKOFF_MS = this.strategyConfig.maxBackoffDelayOpening || 30000;
        const startTime = Date.now();
        let positionOpened = false;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          // Wait with exponential backoff (except first attempt)
          if (attempt > 0) {
            const exponentialDelay = BASE_POLL_INTERVAL_MS * Math.pow(2, attempt - 1);
            const backoffDelay = Math.min(exponentialDelay, MAX_BACKOFF_MS);
            this.logger.debug(
              `   Waiting ${(backoffDelay / 1000).toFixed(1)}s before attempt ${attempt + 1}/${MAX_RETRIES}...`,
            );
            await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          }

          // Check if position opened
          const updatedPositions = await adapter.getPositions();
          positionOpened = updatedPositions.some(
            (p) =>
              this.normalizeSymbol(p.symbol) === this.normalizeSymbol(position.symbol) &&
              p.exchangeType === missingExchange &&
              p.side === missingSide &&
              Math.abs(p.size) > 0.0001,
          );

          if (positionOpened) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            this.logger.log(
              `✅ Opened missing ${missingSide} side for ${position.symbol} on ${missingExchange} ` +
              `(filled after ${elapsed}s, ${attempt + 1} checks)`,
            );
            // Update registry to FILLED
            if (this.executionLockService) {
              this.executionLockService.updateOrderStatus(
                missingExchange,
                position.symbol,
                orderSide,
                'FILLED',
                orderResult.orderId,
              );
            }
            // Reset retry count on success (mutex protected)
            await this.clearRetryOnSuccess(retryKey);
            return true;
          }

          // Check order status
          try {
            const orderStatus = await adapter.getOrderStatus(orderResult.orderId, position.symbol);
            if (orderStatus.isFilled()) {
              this.logger.log(
                `✅ Order ${orderResult.orderId} filled - missing ${missingSide} side opened for ${position.symbol}`,
              );
              if (this.executionLockService) {
                this.executionLockService.updateOrderStatus(
                  missingExchange,
                  position.symbol,
                  orderSide,
                  'FILLED',
                  orderResult.orderId,
                );
              }
              await this.clearRetryOnSuccess(retryKey);
              return true;
            }
            if (orderStatus.isCancelled() || orderStatus.isRejected()) {
              this.logger.warn(
                `⚠️ Order ${orderResult.orderId} was ${orderStatus.status} - will retry on next cycle`,
              );
              if (this.executionLockService) {
                this.executionLockService.updateOrderStatus(
                  missingExchange,
                  position.symbol,
                  orderSide,
                  'CANCELLED',
                  orderResult.orderId,
                );
              }
              break;
            }
          } catch (statusError: any) {
            this.logger.debug(`Could not check order status: ${statusError.message}`);
          }

          const elapsed = Math.round((Date.now() - startTime) / 1000);
          this.logger.debug(
            `⏳ Order ${orderResult.orderId} still pending on ${missingExchange} ` +
            `(attempt ${attempt + 1}/${MAX_RETRIES}, ${elapsed}s elapsed)...`,
          );
        }

        // Order didn't fill after all retries - CANCEL IT
        const totalTime = Date.now() - startTime;
        if (!positionOpened) {
          this.logger.warn(
            `⏰ Order ${orderResult.orderId} did not fill after ${MAX_RETRIES} attempts ` +
            `(~${Math.round(totalTime / 1000)}s) - cancelling to prevent zombie order`,
          );
          try {
            await adapter.cancelOrder(orderResult.orderId, position.symbol);
            this.logger.log(`🗑️ Cancelled unfilled order ${orderResult.orderId}`);
          } catch (cancelError: any) {
            this.logger.warn(`Could not cancel order ${orderResult.orderId}: ${cancelError.message}`);
          }

          // Update registry to CANCELLED
          if (this.executionLockService) {
            this.executionLockService.updateOrderStatus(
              missingExchange,
              position.symbol,
              orderSide,
              'CANCELLED',
              orderResult.orderId,
            );
          }

          // Wait a moment for cancellation to process
          await new Promise((resolve) => setTimeout(resolve, 1000));

          // Final check - order might have filled just as we cancelled
          const finalPositions = await adapter.getPositions();
          const finalCheck = finalPositions.some(
            (p) =>
              this.normalizeSymbol(p.symbol) === this.normalizeSymbol(position.symbol) &&
              p.exchangeType === missingExchange &&
              p.side === missingSide &&
              Math.abs(p.size) > 0.0001,
          );

          if (finalCheck) {
            this.logger.log(
              `✅ Position opened just before cancellation - ${missingSide} side for ${position.symbol} is now open`,
            );
            if (this.executionLockService) {
              this.executionLockService.updateOrderStatus(
                missingExchange,
                position.symbol,
                orderSide,
                'FILLED',
                orderResult.orderId,
              );
            }
            await this.clearRetryOnSuccess(retryKey);
            return true;
          }
        }
      }

      // Increment retry count and check if should filter (mutex protected)
      const shouldFilter = await this.incrementRetryAndCheckFilter(retryKey);
      if (shouldFilter) {
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
   * CRITICAL: First cancels any pending orders on OTHER exchanges to prevent zombie orders
   */
  private async closeSingleLegPosition(position: PerpPosition): Promise<void> {
    try {
      const adapter = this.keeperService.getExchangeAdapter(
        position.exchangeType,
      );
      if (!adapter) {
        this.logger.warn(`No adapter found for ${position.exchangeType}`);
        return;
      }

      // ================================================================================
      // CRITICAL: Cancel any pending orders on OTHER exchanges for this symbol first!
      // This prevents zombie orders from being left behind when we close this position
      // ================================================================================
      const otherExchanges = [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER, ExchangeType.ASTER]
        .filter(e => e !== position.exchangeType);

      for (const otherExchange of otherExchanges) {
        const otherAdapter = this.keeperService.getExchangeAdapter(otherExchange);
        if (!otherAdapter || !otherAdapter.getOpenOrders) continue;

        try {
          const openOrders = await otherAdapter.getOpenOrders();
          if (!openOrders) continue;
          const matchingOrders = openOrders.filter(order => 
            this.normalizeSymbol(order.symbol) === this.normalizeSymbol(position.symbol)
          );

          for (const order of matchingOrders) {
            this.logger.warn(
              `🗑️ Cancelling pending order ${order.orderId} for ${order.symbol} on ${otherExchange} ` +
              `before closing single-leg on ${position.exchangeType}`,
            );
            try {
              await otherAdapter.cancelOrder(order.orderId, order.symbol);
              this.logger.log(`✅ Cancelled order ${order.orderId} on ${otherExchange}`);
            } catch (cancelError: any) {
              this.logger.warn(`Could not cancel order ${order.orderId}: ${cancelError.message}`);
            }
          }
        } catch (orderError: any) {
          this.logger.debug(`Could not check orders on ${otherExchange}: ${orderError.message}`);
        }
      }

      // Wait a moment for cancellations to process
      await new Promise((resolve) => setTimeout(resolve, 1000));
      // ================================================================================

      // CRITICAL: Verify position still exists before attempting to close
      const currentPositions = await adapter.getPositions();
      const normalizeSymbol = (s: string) =>
        s
          .replace('USDC', '')
          .replace('USDT', '')
          .replace('-PERP', '')
          .replace('PERP', '')
          .toUpperCase();
      const normalizedSymbol = normalizeSymbol(position.symbol);

      const positionStillExists = currentPositions.some((p) => {
        const normalizedPosSymbol = normalizeSymbol(p.symbol);
        return (
          normalizedPosSymbol === normalizedSymbol &&
          p.side === position.side &&
          Math.abs(p.size) > 0.0001
        );
      });

      if (!positionStillExists) {
        this.logger.log(
          `✅ Position ${position.symbol} (${position.side}) on ${position.exchangeType} ` +
            `no longer exists - already closed or was stale data`,
        );
        return;
      }

      const closeSide =
        position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG;

      this.logger.error(
        `🚨 Closing single-leg position ${position.symbol} (${position.side}) on ${position.exchangeType} (Maker order @ Mark Price)...`,
      );

      // Simple limit order at mark price to act as maker
      let markPrice: number | undefined;
      try {
        markPrice = await adapter.getMarkPrice(position.symbol);
            } catch (priceError: any) {
        this.logger.warn(
          `Could not get mark price for ${position.symbol} closure, using entry price: ${priceError.message}`,
        );
        markPrice = position.entryPrice;
          }

          const closeOrder = new PerpOrderRequest(
            position.symbol,
            closeSide,
        OrderType.LIMIT,
            position.size,
        markPrice,
        TimeInForce.GTC,
            true, // Reduce only
          );

          const closeResponse = await adapter.placeOrder(closeOrder);

          // Wait and check if order filled
          if (!closeResponse.isFilled() && closeResponse.orderId) {
        const maxPollRetries = 10;
        const pollIntervalMs = 3000;

        for (let pollAttempt = 0; pollAttempt < maxPollRetries; pollAttempt++) {
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

              try {
                const statusResponse = await adapter.getOrderStatus(
                  closeResponse.orderId,
                  position.symbol,
                );
                if (statusResponse.isFilled()) {
                  break;
                }
                if (
                  statusResponse.status === OrderStatus.CANCELLED ||
                  statusResponse.error
                ) {
                  break;
                }
              } catch (pollError: any) {
                // Continue polling
              }
            }
          }

          // Check if position is actually closed
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Clear any position caches
          if (
            'clearPositionCache' in adapter &&
            typeof (adapter as any).clearPositionCache === 'function'
          ) {
            (adapter as any).clearPositionCache();
          }

      const updatedPositions = await adapter.getPositions();
      const stillExists = updatedPositions.some(
            (p) =>
          normalizeSymbol(p.symbol) === normalizedSymbol &&
              p.exchangeType === position.exchangeType &&
          Math.abs(p.size) > 0.0001,
          );

      if (!stillExists) {
            this.logger.log(
          `✅ Successfully closed single-leg position for ${position.symbol}`,
        );
      } else {
        this.logger.warn(
          `⚠️ Position for ${position.symbol} still exists after limit order attempt. ` +
            `It may be resting on the book or the market moved away.`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `❌ Error closing single-leg position ${position.symbol} on ${position.exchangeType}: ${error.message}`,
      );
    }
  }

  /**
   * Close a position with retry logic (for non-single-leg positions)
   */
  private async closePositionWithRetry(position: PerpPosition): Promise<void> {
    try {
      const adapter = this.keeperService.getExchangeAdapter(
        position.exchangeType,
      );
      if (!adapter) {
        this.logger.warn(`No adapter found for ${position.exchangeType}`);
        return;
      }

      // Get current mark price to act as maker
      let markPrice: number | undefined;
      try {
        markPrice = await adapter.getMarkPrice(position.symbol);
      } catch (priceError: any) {
        this.logger.warn(
          `Could not get mark price for ${position.symbol} closure, using fallback: ${priceError.message}`,
        );
        markPrice = position.markPrice;
      }

      const closeOrder = new PerpOrderRequest(
        position.symbol,
        position.side === OrderSide.LONG ? OrderSide.SHORT : OrderSide.LONG,
        OrderType.LIMIT,
        position.size,
        markPrice,
        TimeInForce.GTC,
        true, // Reduce only
      );

      const closeResponse = await adapter.placeOrder(closeOrder);

      // Record closing costs (fees only for limit orders)
      if (closeResponse.isSuccess()) {
        const positionValue = position.size * (markPrice || position.markPrice || 0);
        // For limit orders, use maker fee rate (which is usually 0 or lower than taker)
        const exchangeType = position.exchangeType;
        const makerFeeRate = this.strategyConfig.exchangeFeeRates.get(exchangeType) || 0.0001;
        const estimatedFees = positionValue * makerFeeRate;
        
        // No slippage expected for maker limit order at mark price
        this.performanceLogger.recordTradingCosts(estimatedFees);
        this.logger.debug(
          `Recorded closing costs for maker order ${position.symbol} on ${exchangeType}: ` +
          `$${estimatedFees.toFixed(4)} (Fees: $${estimatedFees.toFixed(4)})`
        );
      }

      // Wait and retry if order didn't fill immediately
      if (!closeResponse.isFilled() && closeResponse.orderId) {
        const maxRetries = 5;
        const pollIntervalMs = 2000;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          }

          try {
            const statusResponse = await adapter.getOrderStatus(
              closeResponse.orderId,
              position.symbol,
            );
            if (statusResponse.isFilled()) {
              break;
            }
            if (
              statusResponse.status === OrderStatus.CANCELLED ||
              statusResponse.error
            ) {
              break;
            }
          } catch (pollError: any) {
            // Continue polling
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error: any) {
      this.logger.error(
        `Error closing position ${position.symbol} on ${position.exchangeType}: ${error.message}`,
      );
    }
  }
}
