import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { PerpKeeperOrchestrator } from '../../domain/services/PerpKeeperOrchestrator';
import { ConfigService } from '@nestjs/config';
import { PerpKeeperPerformanceLogger } from '../../infrastructure/logging/PerpKeeperPerformanceLogger';
import { PerpKeeperService } from './PerpKeeperService';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import {
  OrderSide,
} from '../../domain/value-objects/PerpOrder';
import { PerpPosition } from '../../domain/entities/PerpPosition';
import { ArbitrageOpportunity } from '../../domain/services/FundingRateAggregator';
import { Wallet } from 'ethers';
import { DiagnosticsService } from '../../infrastructure/services/DiagnosticsService';
import { WithdrawalFulfiller } from '../../infrastructure/adapters/blockchain/WithdrawalFulfiller';
import { NAVReporter } from '../../infrastructure/adapters/blockchain/NAVReporter';
import { ExecutionLockService } from '../../infrastructure/services/ExecutionLockService';
import { MarketQualityFilter } from '../../domain/services/MarketQualityFilter';
import { LiquidationMonitorService } from '../../domain/services/LiquidationMonitorService';
import { OpportunityEvaluator } from '../../domain/services/strategy-rules/OpportunityEvaluator';
import { ExecutionPlanBuilder } from '../../domain/services/strategy-rules/ExecutionPlanBuilder';
import { RateLimiterService } from '../../infrastructure/services/RateLimiterService';
import { StrategyConfig } from '../../domain/value-objects/StrategyConfig';
import { OrderGuardianService } from '../../domain/services/execution/OrderGuardianService';
import { ReconciliationService } from '../../domain/services/execution/ReconciliationService';
import { ProfitTakingService } from '../../domain/services/execution/ProfitTakingService';

import { UnifiedStateService } from '../../domain/services/execution/UnifiedStateService';

/**
 * PerpKeeperScheduler - Scheduled execution for funding rate arbitrage
 *
 * Refactored into a pure thin scheduler that delegates logic to intelligent beings:
 * - OrderGuardianService: Order safety and leg recovery
 * - ReconciliationService: Position health and imbalance monitoring
 * - ProfitTakingService: Profit-taking logic and cooldowns
 * - UnifiedStateService: Market and position state
 */
@Injectable()
export class PerpKeeperScheduler implements OnModuleInit {
  private readonly logger = new Logger(PerpKeeperScheduler.name);
  private symbols: string[] = [];
  private readonly blacklistedSymbols: Set<string>;
  private readonly minSpread: number;
  private readonly maxPositionSizeUsd: number;
  private isRunning = false;
  private lastDiscoveryTime: number = 0;
  private readonly DISCOVERY_CACHE_TTL = 3600000;

  constructor(
    private readonly orchestrator: PerpKeeperOrchestrator,
    private readonly configService: ConfigService,
    private readonly performanceLogger: PerpKeeperPerformanceLogger,
    private readonly keeperService: PerpKeeperService,
    private readonly strategyConfig: StrategyConfig,
    private readonly orderGuardian: OrderGuardianService,
    private readonly reconciliationService: ReconciliationService,
    private readonly profitTakingService: ProfitTakingService,
    private readonly unifiedStateService: UnifiedStateService,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
    @Optional() private readonly withdrawalFulfiller?: WithdrawalFulfiller,
    @Optional() private readonly navReporter?: NAVReporter,
    @Optional() private readonly executionLockService?: ExecutionLockService,
    @Optional() private readonly marketQualityFilter?: MarketQualityFilter,
    @Optional() private readonly liquidationMonitor?: LiquidationMonitorService,
    @Optional() private readonly opportunityEvaluator?: OpportunityEvaluator,
    @Optional() private readonly executionPlanBuilder?: ExecutionPlanBuilder,
    @Optional() private readonly rateLimiter?: RateLimiterService,
  ) {
    const adapters = this.keeperService.getExchangeAdapters();
    const spotAdapters = this.keeperService.getSpotAdapters();
    this.orchestrator.initialize(adapters, spotAdapters);

    if (this.liquidationMonitor) {
      this.liquidationMonitor.initialize(adapters);
      this.liquidationMonitor.updateConfig({
        emergencyCloseThreshold: parseFloat(this.configService.get('LIQUIDATION_EMERGENCY_THRESHOLD') || '0.9'),
        enableEmergencyClose: this.configService.get('LIQUIDATION_EMERGENCY_CLOSE_ENABLED') !== 'false',
        checkIntervalMs: 30000,
      });
    }

    const blacklistEnv = this.configService.get<string>('KEEPER_BLACKLISTED_SYMBOLS');
    this.blacklistedSymbols = new Set(blacklistEnv ? blacklistEnv.split(',').map(s => this.normalizeSymbol(s)) : ['NVDA']);

    const symbolsEnv = this.configService.get<string>('KEEPER_SYMBOLS');
    if (symbolsEnv) {
      this.symbols = symbolsEnv.split(',').map(s => s.trim()).filter(s => !this.blacklistedSymbols.has(this.normalizeSymbol(s)));
    }

    this.minSpread = parseFloat(this.configService.get('KEEPER_MIN_SPREAD') || '0.0001');
    this.maxPositionSizeUsd = parseFloat(this.configService.get('KEEPER_MAX_POSITION_SIZE_USD') || '10000');
  }

  async onModuleInit() {
    const STARTUP_DELAY_MS = 15000;
    this.logger.log(`🚀 PerpKeeperScheduler initializing - first run in ${STARTUP_DELAY_MS / 1000}s`);
    
    setTimeout(async () => {
      try {
        await this.performanceLogger.syncHistoricalFundingPayments();
        await this.updatePerformanceMetrics();
      await this.executeHourly();
    } catch (error: any) {
        this.logger.error(`Startup initialization failed: ${error.message}`);
      }
    }, STARTUP_DELAY_MS);
  }

  @Cron('0 * * * *')
  async executeHourly() {
    if (this.isRunning) return;

    const threadId = this.executionLockService?.generateThreadId() || `hourly-${Date.now()}`;
    if (this.executionLockService && !this.executionLockService.tryAcquireGlobalLock(threadId, 'executeHourly')) {
      this.logger.warn('⏳ Another execution is in progress - skipping hourly execution');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      this.logger.log('🚀 Starting execution cycle...');
      await this.unifiedStateService.refresh();

      // Capture performance snapshot before strategy execution
      const currentEquity = await this.getCurrentTotalEquity();
      const perfMetrics = this.performanceLogger.getPerformanceMetrics(currentEquity);
      
      // Update chart with projected 1h return and actual cumulative profit
      this.performanceLogger.captureHourlyEarnings(
        perfMetrics.expectedEarningsNextPeriod,
        perfMetrics.totalRealizedPnl + perfMetrics.netFundingCaptured - this.performanceLogger.getTotalTradingCosts()
      );

      const symbols = await this.discoverAssetsIfNeeded();
      if (symbols.length === 0) return;

      const filteredSymbols = symbols.filter(s => !this.isBlacklisted(s));
      const opportunities = await this.findAndFilterOpportunities(filteredSymbols);

      if (opportunities.length === 0) {
        this.logger.log('No opportunities found, skipping execution');
        return;
      }

      await this.orchestrator.executeArbitrageStrategy(filteredSymbols, this.minSpread, this.maxPositionSizeUsd);
      await this.performanceLogger.syncHistoricalFundingPayments();
      await this.updatePerformanceMetrics();
      await this.logPortfolioSummary();
    } catch (error: any) {
      this.logger.error(`Hourly execution failed: ${error.message}`, error.stack);
    } finally {
      this.isRunning = false;
      if (this.executionLockService) this.executionLockService.releaseGlobalLock(threadId);
    }
  }

  private async findAndFilterOpportunities(symbols: string[]): Promise<ArbitrageOpportunity[]> {
    const opportunities = await this.orchestrator.findArbitrageOpportunities(
      symbols,
      this.minSpread,
      false, 
      this.configService.get('PERP_SPOT_ENABLED') !== 'false'
    );

    return opportunities.filter(opp => {
      const normalized = this.normalizeSymbol(opp.symbol);
      if (this.isBlacklisted(normalized)) return false;
      
      const cooldown = this.profitTakingService.isInProfitTakeCooldown(normalized, opp.longMarkPrice || 0, opp.shortMarkPrice || 0);
      return !cooldown.inCooldown;
    });
  }

  private async discoverAssetsIfNeeded(): Promise<string[]> {
    const now = Date.now();
    if (this.symbols.length > 0 && now - this.lastDiscoveryTime < this.DISCOVERY_CACHE_TTL) {
      return this.symbols;
    }

    try {
      const discovered = await this.orchestrator.discoverCommonAssets();
      this.symbols = discovered.filter(s => !this.isBlacklisted(s));
      this.lastDiscoveryTime = now;
      return this.symbols;
      } catch (error) {
      if (this.symbols.length === 0) this.symbols = ['ETH', 'BTC'];
      return this.symbols;
    }
  }

  private async updatePerformanceMetrics(): Promise<void> {
    try {
      const allPositions = await this.keeperService.getAllPositions();
      const positions = allPositions.filter(p => Math.abs(p.size) > 0.0001);
      
      for (const exchange of [ExchangeType.HYPERLIQUID, ExchangeType.LIGHTER]) {
        const exchangePositions = positions.filter(p => p.exchangeType === exchange);
        this.performanceLogger.updatePositionMetrics(exchange, exchangePositions, []);
      }
    } catch (error: any) {
      this.logger.error(`Failed to update performance metrics: ${error.message}`);
    }
  }

  private async logPortfolioSummary(): Promise<void> {
    try {
      let total = 0;
      for (const ex of [ExchangeType.LIGHTER, ExchangeType.HYPERLIQUID]) {
        total += await this.keeperService.getBalance(ex).catch(() => 0);
      }
      this.performanceLogger.logCompactSummary(total);
    } catch (e) {}
  }

  private async getCurrentTotalEquity(): Promise<number> {
    let totalEquity = 0;
    for (const exchangeType of [ExchangeType.LIGHTER, ExchangeType.HYPERLIQUID]) {
      try {
        totalEquity += await this.keeperService.getEquity(exchangeType).catch(() => 0);
      } catch (e) {}
    }
    return totalEquity;
  }

  private isBlacklisted(symbol: string): boolean {
    return this.blacklistedSymbols.has(this.normalizeSymbol(symbol));
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.toUpperCase().replace(/USDT|USDC|-PERP|PERP/g, '');
  }

  @Interval(30000)
  async checkLiquidationRisk() {
    if (!this.liquidationMonitor || this.isRunning) return;
    await this.liquidationMonitor.checkLiquidationRisk();
  }

  @Interval(300000)
  async processKeeperWithdrawals() {
    if (this.withdrawalFulfiller) await this.withdrawalFulfiller.processPendingWithdrawals();
  }

  @Interval(3600000)
  async checkAndReportNAV() {
    if (this.navReporter && this.navReporter.isNAVStale()) await this.navReporter.forceReportNAV();
  }
}
