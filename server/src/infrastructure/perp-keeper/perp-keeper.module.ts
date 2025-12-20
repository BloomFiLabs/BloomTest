import {
  Module,
  forwardRef,
  Logger,
  OnModuleInit,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PerpKeeperService } from '../../application/services/PerpKeeperService';
import { PerpKeeperScheduler } from '../../application/services/PerpKeeperScheduler';
import { PerpKeeperPerformanceLogger } from '../logging/PerpKeeperPerformanceLogger';
import { AsterExchangeAdapter } from '../adapters/aster/AsterExchangeAdapter';
import { LighterExchangeAdapter } from '../adapters/lighter/LighterExchangeAdapter';
import { HyperliquidExchangeAdapter } from '../adapters/hyperliquid/HyperliquidExchangeAdapter';
import { ExtendedExchangeAdapter } from '../adapters/extended/ExtendedExchangeAdapter';
import { MockExchangeAdapter } from '../adapters/mock/MockExchangeAdapter';
import { HyperliquidSpotAdapter } from '../adapters/hyperliquid/HyperliquidSpotAdapter';
import { AsterSpotAdapter } from '../adapters/aster/AsterSpotAdapter';
import { LighterSpotAdapter } from '../adapters/lighter/LighterSpotAdapter';
import { ExtendedSpotAdapter } from '../adapters/extended/ExtendedSpotAdapter';
import { ISpotExchangeAdapter } from '../../domain/ports/ISpotExchangeAdapter';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../domain/ports/IPerpExchangeAdapter';
import { AsterFundingDataProvider } from '../adapters/aster/AsterFundingDataProvider';
import { LighterFundingDataProvider } from '../adapters/lighter/LighterFundingDataProvider';
import { HyperLiquidDataProvider } from '../adapters/hyperliquid/HyperLiquidDataProvider';
import { ExtendedFundingDataProvider } from '../adapters/extended/ExtendedFundingDataProvider';
import { HyperLiquidWebSocketProvider } from '../adapters/hyperliquid/HyperLiquidWebSocketProvider';
import { LighterWebSocketProvider } from '../adapters/lighter/LighterWebSocketProvider';
import { FundingRateAggregator } from '../../domain/services/FundingRateAggregator';
import { FundingArbitrageStrategy } from '../../domain/services/FundingArbitrageStrategy';
import { PerpKeeperOrchestrator } from '../../domain/services/PerpKeeperOrchestrator';
import { ExchangeBalanceRebalancer } from '../../domain/services/ExchangeBalanceRebalancer';
import { HistoricalFundingRateService } from '../services/HistoricalFundingRateService';
import { PositionLossTracker } from '../services/PositionLossTracker';
import { PortfolioRiskAnalyzer } from '../services/PortfolioRiskAnalyzer';
import { RealFundingPaymentsService } from '../services/RealFundingPaymentsService';
import { OptimalLeverageService } from '../services/OptimalLeverageService';
import { DiagnosticsService } from '../services/DiagnosticsService';
import { MarketQualityFilter } from '../../domain/services/MarketQualityFilter';
import { CircuitBreakerService } from '../services/CircuitBreakerService';
import { ExecutionLockService } from '../services/ExecutionLockService';
import { LiquidationMonitorService } from '../../domain/services/LiquidationMonitorService';
import { PositionStateRepository } from '../repositories/PositionStateRepository';
import { RateLimiterService } from '../services/RateLimiterService';
import { ProfitTracker } from '../services/ProfitTracker';
import { RewardHarvester } from '../services/RewardHarvester';
import { PerpKeeperController } from '../controllers/PerpKeeperController';
import { FundingRateController } from '../controllers/FundingRateController';
import { KeeperStrategyEventListener } from '../adapters/blockchain/KeeperStrategyEventListener';
import { WithdrawalFulfiller } from '../adapters/blockchain/WithdrawalFulfiller';
import { NAVReporter } from '../adapters/blockchain/NAVReporter';
import { PortfolioOptimizer } from '../../domain/services/strategy-rules/PortfolioOptimizer';
import { OrderExecutor } from '../../domain/services/strategy-rules/OrderExecutor';
import { PositionManager } from '../../domain/services/strategy-rules/PositionManager';
import { BalanceManager } from '../../domain/services/strategy-rules/BalanceManager';
import { OpportunityEvaluator } from '../../domain/services/strategy-rules/OpportunityEvaluator';
import { ExecutionPlanBuilder } from '../../domain/services/strategy-rules/ExecutionPlanBuilder';
import { CostCalculator } from '../../domain/services/strategy-rules/CostCalculator';
import { IdleFundsManager } from '../../domain/services/strategy-rules/IdleFundsManager';
import { PerpSpotBalanceManager } from '../../domain/services/strategy-rules/PerpSpotBalanceManager';
import { PerpSpotExecutionPlanBuilder } from '../../domain/services/strategy-rules/PerpSpotExecutionPlanBuilder';
import { PredictedBreakEvenCalculator } from '../../domain/services/strategy-rules/PredictedBreakEvenCalculator';
import { StrategyConfig } from '../../domain/value-objects/StrategyConfig';
import { MakerEfficiencyService } from '../../domain/services/strategy-rules/MakerEfficiencyService';
import { SimpleEventBus } from '../events/SimpleEventBus';
import { TWAPEngine } from '../../domain/services/TWAPEngine';
import {
  TWAPOptimizer,
  OrderBookCollector,
  ExecutionAnalyticsTracker,
  LiquidityProfileCalibrator,
  ReplenishmentRateAnalyzer,
  SlippageModelCalibrator,
} from '../../domain/services/twap';
import type { IEventBus } from '../../domain/events/DomainEvent';
import type { IHistoricalFundingRateService } from '../../domain/ports/IHistoricalFundingRateService';
import type { IPositionLossTracker } from '../../domain/ports/IPositionLossTracker';

// Prediction module imports
import { FundingRatePredictionService } from '../../domain/services/prediction/FundingRatePredictionService';
import { EnsemblePredictor } from '../../domain/services/prediction/EnsemblePredictor';
import { MeanReversionPredictor } from '../../domain/services/prediction/predictors/MeanReversionPredictor';
import { PremiumIndexPredictor } from '../../domain/services/prediction/predictors/PremiumIndexPredictor';
import { OpenInterestPredictor } from '../../domain/services/prediction/predictors/OpenInterestPredictor';
import { KalmanFilterEstimator } from '../../domain/services/prediction/filters/KalmanFilterEstimator';
import { RegimeDetector } from '../../domain/services/prediction/filters/RegimeDetector';
import { PredictionBacktester } from '../../domain/services/prediction/PredictionBacktester';

/**
 * PerpKeeperModule - Module for perpetual keeper functionality
 *
 * Provides:
 * - Exchange adapters (Aster, Lighter, Hyperliquid, Extended)
 * - Funding data providers
 * - Performance logging
 * - Orchestration services
 * - REST API controllers
 */
@Module({
  imports: [ConfigModule],
  controllers: [PerpKeeperController, FundingRateController],
  providers: [
    // Exchange adapters - conditionally use mock adapters in test mode
    // Note: Mock adapters are created in PerpKeeperService, not here
    // These factory providers are kept for backward compatibility but not used in test mode
    // Keep original adapters for backward compatibility (will be replaced in PerpKeeperService)
    {
      provide: AsterExchangeAdapter,
      useFactory: (
        configService: ConfigService,
        diagnosticsService: DiagnosticsService,
      ) => {
        try {
          return new AsterExchangeAdapter(configService, diagnosticsService);
        } catch (error: any) {
          const logger = new Logger('PerpKeeperModule');
          logger.warn(`Failed to create Aster adapter: ${error.message}`);
          logger.warn('Adapter will be created lazily when needed');
          return null;
        }
      },
      inject: [ConfigService, DiagnosticsService],
    },
    {
      provide: 'ASTER_ADAPTER',
      useFactory: (
        configService: ConfigService,
        diagnosticsService: DiagnosticsService,
      ) => {
        try {
          return new AsterExchangeAdapter(configService, diagnosticsService);
        } catch (error: any) {
          return null;
        }
      },
      inject: [ConfigService, DiagnosticsService],
    },
    {
      provide: LighterExchangeAdapter,
      useFactory: (
        configService: ConfigService,
        diagnosticsService: DiagnosticsService,
      ) => {
        try {
          return new LighterExchangeAdapter(configService, diagnosticsService);
        } catch (error: any) {
          const logger = new Logger('PerpKeeperModule');
          logger.warn(`Failed to create Lighter adapter: ${error.message}`);
          logger.warn('Adapter will be created lazily when needed');
          return null;
        }
      },
      inject: [ConfigService, DiagnosticsService],
    },
    {
      provide: 'LIGHTER_ADAPTER',
      useFactory: (
        configService: ConfigService,
        diagnosticsService: DiagnosticsService,
      ) => {
        try {
          return new LighterExchangeAdapter(configService, diagnosticsService);
        } catch (error: any) {
          return null;
        }
      },
      inject: [ConfigService, DiagnosticsService],
    },
    {
      provide: HyperliquidExchangeAdapter,
      useFactory: (
        configService: ConfigService,
        dataProvider: HyperLiquidDataProvider,
        diagnosticsService: DiagnosticsService,
      ) => {
        try {
          return new HyperliquidExchangeAdapter(
            configService,
            dataProvider,
            diagnosticsService,
          );
        } catch (error: any) {
          const logger = new Logger('PerpKeeperModule');
          logger.warn(`Failed to create Hyperliquid adapter: ${error.message}`);
          logger.warn('Adapter will be created lazily when needed');
          return null;
        }
      },
      inject: [ConfigService, HyperLiquidDataProvider, DiagnosticsService],
    },
    {
      provide: 'HYPERLIQUID_ADAPTER',
      useFactory: (
        configService: ConfigService,
        dataProvider: HyperLiquidDataProvider,
        diagnosticsService: DiagnosticsService,
      ) => {
        try {
          return new HyperliquidExchangeAdapter(
            configService,
            dataProvider,
            diagnosticsService,
          );
        } catch (error: any) {
          return null;
        }
      },
      inject: [ConfigService, HyperLiquidDataProvider, DiagnosticsService],
    },
    {
      provide: ExtendedExchangeAdapter,
      useFactory: (configService: ConfigService) => {
        try {
          return new ExtendedExchangeAdapter(configService);
        } catch (error: any) {
          const logger = new Logger('PerpKeeperModule');
          logger.warn(`Failed to create Extended adapter: ${error.message}`);
          logger.warn('Adapter will be created lazily when needed');
          return null;
        }
      },
      inject: [ConfigService],
    },
    {
      provide: 'EXTENDED_ADAPTER',
      useFactory: (configService: ConfigService) => {
        try {
          return new ExtendedExchangeAdapter(configService);
        } catch (error: any) {
          return null;
        }
      },
      inject: [ConfigService],
    },

    // Spot exchange adapters
    {
      provide: HyperliquidSpotAdapter,
      useFactory: (configService: ConfigService) => {
        try {
          return new HyperliquidSpotAdapter(configService);
        } catch (error: any) {
          const logger = new Logger('PerpKeeperModule');
          logger.warn(
            `Failed to create Hyperliquid spot adapter: ${error.message}`,
          );
          return null;
        }
      },
      inject: [ConfigService],
    },
    {
      provide: AsterSpotAdapter,
      useFactory: (configService: ConfigService) => {
        try {
          return new AsterSpotAdapter(configService);
        } catch (error: any) {
          const logger = new Logger('PerpKeeperModule');
          logger.warn(`Failed to create Aster spot adapter: ${error.message}`);
          return null;
        }
      },
      inject: [ConfigService],
    },
    {
      provide: LighterSpotAdapter,
      useFactory: (configService: ConfigService) => {
        try {
          return new LighterSpotAdapter(configService);
        } catch (error: any) {
          const logger = new Logger('PerpKeeperModule');
          logger.warn(
            `Failed to create Lighter spot adapter: ${error.message}`,
          );
          return null;
        }
      },
      inject: [ConfigService],
    },
    {
      provide: ExtendedSpotAdapter,
      useFactory: (configService: ConfigService) => {
        try {
          return new ExtendedSpotAdapter(configService);
        } catch (error: any) {
          const logger = new Logger('PerpKeeperModule');
          logger.warn(
            `Failed to create Extended spot adapter: ${error.message}`,
          );
          return null;
        }
      },
      inject: [ConfigService],
    },

    // Funding data providers
    AsterFundingDataProvider,
    LighterWebSocketProvider, // WebSocket provider for Lighter (real-time OI data)
    LighterFundingDataProvider,
    HyperLiquidWebSocketProvider, // WebSocket provider for Hyperliquid (reduces rate limits)
    HyperLiquidDataProvider,
    ExtendedFundingDataProvider,

    // Strategy configuration
    {
      provide: StrategyConfig,
      useFactory: (configService: ConfigService) => {
        return StrategyConfig.fromConfigService(configService);
      },
      inject: [ConfigService],
    },

    // Strategy rule modules (order matters due to dependencies)
    CostCalculator,
    {
      provide: ExecutionPlanBuilder,
      useFactory: (
        costCalculator: CostCalculator,
        aggregator: FundingRateAggregator,
        twapOptimizer?: TWAPOptimizer,
      ) => {
        return new ExecutionPlanBuilder(costCalculator, aggregator, twapOptimizer);
      },
      inject: [
        CostCalculator,
        FundingRateAggregator,
        { token: TWAPOptimizer, optional: true },
      ],
    },
    PerpSpotBalanceManager,
    PerpSpotExecutionPlanBuilder,
    {
      provide: PortfolioOptimizer,
      useFactory: (
        costCalculator: CostCalculator,
        historicalService: IHistoricalFundingRateService,
        config: StrategyConfig,
        twapOptimizer?: TWAPOptimizer,
      ) => {
        return new PortfolioOptimizer(
          costCalculator,
          historicalService,
          config,
          undefined,
          undefined,
          twapOptimizer,
        );
      },
      inject: [
        CostCalculator,
        'IHistoricalFundingRateService',
        StrategyConfig,
        { token: TWAPOptimizer, optional: true },
      ],
    },

    // Position and Order management (circular dependency handled via forwardRef)
    PositionManager,
    {
      provide: 'IPositionManager',
      useExisting: PositionManager,
    },
    OrderExecutor,
    {
      provide: 'IOrderExecutor',
      useExisting: OrderExecutor,
    },

    // Balance and opportunity evaluation
    BalanceManager,
    {
      provide: PredictedBreakEvenCalculator,
      useFactory: (
        costCalculator: CostCalculator,
        config: StrategyConfig,
        predictionService?: FundingRatePredictionService,
      ) => {
        return new PredictedBreakEvenCalculator(
          costCalculator,
          config,
          predictionService,
        );
      },
      inject: [
        CostCalculator,
        StrategyConfig,
        { token: 'IFundingRatePredictionService', optional: true },
      ],
    },
    {
      provide: OpportunityEvaluator,
      useFactory: (
        historicalService: IHistoricalFundingRateService,
        aggregator: FundingRateAggregator,
        lossTracker: IPositionLossTracker,
        costCalculator: CostCalculator,
        config: StrategyConfig,
        predictionService?: FundingRatePredictionService,
        breakEvenCalculator?: PredictedBreakEvenCalculator,
      ) => {
        return new OpportunityEvaluator(
          historicalService,
          aggregator,
          lossTracker,
          costCalculator,
          config,
          predictionService,
          breakEvenCalculator,
        );
      },
      inject: [
        'IHistoricalFundingRateService',
        FundingRateAggregator,
        'IPositionLossTracker',
        CostCalculator,
        StrategyConfig,
        { token: 'IFundingRatePredictionService', optional: true },
        { token: PredictedBreakEvenCalculator, optional: true },
      ],
    },

    // Idle funds manager - handles reallocation of unused capital
    {
      provide: IdleFundsManager,
      useFactory: (
        config: StrategyConfig,
        executionPlanBuilder: ExecutionPlanBuilder,
        costCalculator: CostCalculator,
      ) => {
        return new IdleFundsManager(
          config,
          executionPlanBuilder,
          costCalculator,
        );
      },
      inject: [StrategyConfig, ExecutionPlanBuilder, CostCalculator],
    },
    {
      provide: 'IIdleFundsManager',
      useExisting: IdleFundsManager,
    },

    // Event bus
    {
      provide: 'IEventBus',
      useClass: SimpleEventBus,
    },
    SimpleEventBus, // Keep for backward compatibility

    // TWAP Services
    OrderBookCollector,
    ExecutionAnalyticsTracker,
    LiquidityProfileCalibrator,
    ReplenishmentRateAnalyzer,
    SlippageModelCalibrator,
    TWAPOptimizer,
    TWAPEngine,

    // Domain services
    FundingRateAggregator,
    FundingArbitrageStrategy,
    PerpKeeperOrchestrator,
    ExchangeBalanceRebalancer,

    // Historical and loss tracking services - provide both interface and implementation
    {
      provide: 'IHistoricalFundingRateService',
      useClass: HistoricalFundingRateService,
    },
    HistoricalFundingRateService, // Keep for backward compatibility
    {
      provide: 'IPositionLossTracker',
      useClass: PositionLossTracker,
    },
    PositionLossTracker, // Keep for backward compatibility

    // Prediction services - Ensemble funding rate prediction system
    KalmanFilterEstimator,
    {
      provide: RegimeDetector,
      useFactory: (kalmanFilter: KalmanFilterEstimator) => {
        return new RegimeDetector(kalmanFilter);
      },
      inject: [KalmanFilterEstimator],
    },
    {
      provide: MeanReversionPredictor,
      useFactory: (kalmanFilter: KalmanFilterEstimator) => {
        return new MeanReversionPredictor(kalmanFilter);
      },
      inject: [KalmanFilterEstimator],
    },
    PremiumIndexPredictor,
    OpenInterestPredictor,
    {
      provide: EnsemblePredictor,
      useFactory: (
        meanReversionPredictor: MeanReversionPredictor,
        premiumIndexPredictor: PremiumIndexPredictor,
        openInterestPredictor: OpenInterestPredictor,
        regimeDetector: RegimeDetector,
      ) => {
        return new EnsemblePredictor(
          meanReversionPredictor,
          premiumIndexPredictor,
          openInterestPredictor,
          regimeDetector,
        );
      },
      inject: [
        MeanReversionPredictor,
        PremiumIndexPredictor,
        OpenInterestPredictor,
        RegimeDetector,
      ],
    },
    {
      provide: FundingRatePredictionService,
      useFactory: (
        ensemblePredictor: EnsemblePredictor,
        kalmanFilter: KalmanFilterEstimator,
        regimeDetector: RegimeDetector,
        historicalService: IHistoricalFundingRateService,
        aggregator: FundingRateAggregator,
      ) => {
        return new FundingRatePredictionService(
          ensemblePredictor,
          kalmanFilter,
          regimeDetector,
          historicalService,
          aggregator,
        );
      },
      inject: [
        EnsemblePredictor,
        KalmanFilterEstimator,
        RegimeDetector,
        'IHistoricalFundingRateService',
        FundingRateAggregator,
      ],
    },
    {
      provide: 'IFundingRatePredictionService',
      useExisting: FundingRatePredictionService,
    },
    {
      provide: PredictionBacktester,
      useFactory: (
        meanReversionPredictor: MeanReversionPredictor,
        premiumIndexPredictor: PremiumIndexPredictor,
        openInterestPredictor: OpenInterestPredictor,
        ensemblePredictor: EnsemblePredictor,
        kalmanFilter: KalmanFilterEstimator,
        regimeDetector: RegimeDetector,
        historicalService: IHistoricalFundingRateService,
      ) => {
        return new PredictionBacktester(
          meanReversionPredictor,
          premiumIndexPredictor,
          openInterestPredictor,
          ensemblePredictor,
          kalmanFilter,
          regimeDetector,
          historicalService,
        );
      },
      inject: [
        MeanReversionPredictor,
        PremiumIndexPredictor,
        OpenInterestPredictor,
        EnsemblePredictor,
        KalmanFilterEstimator,
        RegimeDetector,
        'IHistoricalFundingRateService',
      ],
    },

    {
      provide: 'IPortfolioRiskAnalyzer',
      useClass: PortfolioRiskAnalyzer,
    },
    PortfolioRiskAnalyzer, // Keep for backward compatibility

    // Application services
    PerpKeeperService,
    PerpKeeperScheduler,

    // Real funding payments service
    RealFundingPaymentsService,

    // Optimal leverage service
    {
      provide: OptimalLeverageService,
      useFactory: (
        configService: ConfigService,
        fundingPaymentsService: RealFundingPaymentsService,
        historicalService: IHistoricalFundingRateService,
      ) => {
        return new OptimalLeverageService(
          configService,
          fundingPaymentsService,
          historicalService,
        );
      },
      inject: [
        ConfigService,
        RealFundingPaymentsService,
        'IHistoricalFundingRateService',
      ],
    },
    {
      provide: 'IOptimalLeverageService',
      useExisting: OptimalLeverageService,
    },

    // Diagnostics service (must be before PerformanceLogger due to dependency)
    DiagnosticsService,

    // Market quality filter - tracks market execution quality and blacklists failing markets
    MarketQualityFilter,

    // Circuit breaker for error rate protection
    CircuitBreakerService,

    // Execution lock service for symbol-level locking
    ExecutionLockService,

    // Maker efficiency service - ensures we are best maker on book
    MakerEfficiencyService,

    // Liquidation monitoring service - monitors position risk and triggers emergency closes
    LiquidationMonitorService,

    // Position state persistence for recovery
    PositionStateRepository,

    // Global rate limiter for exchange API calls
    RateLimiterService,

    // Profit tracking and reward harvesting
    {
      provide: ProfitTracker,
      useFactory: (
        configService: ConfigService,
        keeperService: PerpKeeperService,
        realFundingService: RealFundingPaymentsService,
      ) => {
        return new ProfitTracker(
          configService,
          keeperService,
          realFundingService,
        );
      },
      inject: [ConfigService, PerpKeeperService, RealFundingPaymentsService],
    },
    {
      provide: RewardHarvester,
      useFactory: (
        configService: ConfigService,
        keeperService: PerpKeeperService,
        profitTracker: ProfitTracker,
        diagnosticsService: DiagnosticsService,
      ) => {
        return new RewardHarvester(
          configService,
          keeperService,
          profitTracker,
          diagnosticsService,
        );
      },
      inject: [
        ConfigService,
        PerpKeeperService,
        ProfitTracker,
        DiagnosticsService,
      ],
    },

    // Keeper Strategy Integration (on-chain vault/strategy interaction)
    KeeperStrategyEventListener,
    {
      provide: WithdrawalFulfiller,
      useFactory: (
        configService: ConfigService,
        eventListener: KeeperStrategyEventListener,
        hyperliquidAdapter: HyperliquidExchangeAdapter,
        perpKeeperService: PerpKeeperService,
      ) => {
        return new WithdrawalFulfiller(
          configService,
          eventListener,
          hyperliquidAdapter,
          perpKeeperService,
        );
      },
      inject: [
        ConfigService,
        KeeperStrategyEventListener,
        HyperliquidExchangeAdapter,
        PerpKeeperService,
      ],
    },
    {
      provide: NAVReporter,
      useFactory: (
        configService: ConfigService,
        keeperService: PerpKeeperService,
      ) => {
        return new NAVReporter(configService, keeperService);
      },
      inject: [ConfigService, PerpKeeperService],
    },

    // Performance logging
    {
      provide: PerpKeeperPerformanceLogger,
      useFactory: (
        realFundingService: RealFundingPaymentsService,
        diagnosticsService: DiagnosticsService,
      ) => {
        return new PerpKeeperPerformanceLogger(
          realFundingService,
          diagnosticsService,
        );
      },
      inject: [RealFundingPaymentsService, DiagnosticsService],
    },
    {
      provide: 'IPerpKeeperPerformanceLogger',
      useExisting: PerpKeeperPerformanceLogger,
    },
  ],
  exports: [
    PerpKeeperService,
    PerpKeeperScheduler,
    PerpKeeperPerformanceLogger,
    PerpKeeperOrchestrator,
    RealFundingPaymentsService,
    OptimalLeverageService,
    DiagnosticsService,
    MarketQualityFilter,
    CircuitBreakerService,
    PositionStateRepository,
    RateLimiterService,
    ProfitTracker,
    RewardHarvester,
    KeeperStrategyEventListener,
    WithdrawalFulfiller,
    NAVReporter,
    // Maker efficiency service
    MakerEfficiencyService,
    // Prediction services
    FundingRatePredictionService,
    'IFundingRatePredictionService',
    EnsemblePredictor,
    KalmanFilterEstimator,
    RegimeDetector,
    PredictionBacktester,
    // TWAP services
    TWAPEngine,
    TWAPOptimizer,
  ],
})
export class PerpKeeperModule implements OnModuleInit {
  private readonly logger = new Logger(PerpKeeperModule.name);

  constructor(
    @Optional() private readonly balanceManager?: BalanceManager,
    @Optional() private readonly profitTracker?: ProfitTracker,
    @Optional() private readonly diagnosticsService?: DiagnosticsService,
    @Optional() private readonly circuitBreaker?: CircuitBreakerService,
    @Optional() private readonly rateLimiter?: RateLimiterService,
    @Optional() private readonly positionStateRepo?: PositionStateRepository,
    @Optional() private readonly marketQualityFilter?: MarketQualityFilter,
    @Optional() private readonly orderBookCollector?: OrderBookCollector,
    @Optional() private readonly perpKeeperService?: PerpKeeperService,
  ) {}

  /**
   * Wire up services after module initialization to avoid circular dependencies
   */
  async onModuleInit() {
    // Wire ProfitTracker into BalanceManager for deployable capital calculations
    if (this.balanceManager && this.profitTracker) {
      this.balanceManager.setProfitTracker(this.profitTracker);
      this.logger.log(
        'Wired ProfitTracker into BalanceManager for profit-excluded position sizing',
      );
    }

    // Wire new services into DiagnosticsService for enhanced diagnostics
    if (this.diagnosticsService) {
      if (this.circuitBreaker) {
        this.diagnosticsService.setCircuitBreaker(this.circuitBreaker);
        this.logger.log('Wired CircuitBreaker into DiagnosticsService');
      }
      if (this.rateLimiter) {
        this.diagnosticsService.setRateLimiter(this.rateLimiter);
        this.logger.log('Wired RateLimiter into DiagnosticsService');
      }
      if (this.positionStateRepo) {
        this.diagnosticsService.setPositionStateRepository(
          this.positionStateRepo,
        );
        this.logger.log(
          'Wired PositionStateRepository into DiagnosticsService',
        );
      }
      if (this.marketQualityFilter) {
        this.diagnosticsService.setMarketQualityFilter(
          this.marketQualityFilter,
        );
        this.logger.log('Wired MarketQualityFilter into DiagnosticsService');
      }
    }

    // Initialize OrderBookCollector for TWAP data collection
    if (this.orderBookCollector && this.perpKeeperService) {
      const adapters = this.perpKeeperService.getExchangeAdapters();
      this.orderBookCollector.initialize(adapters);
      this.logger.log(`Initialized OrderBookCollector with ${adapters.size} adapters`);
    }
  }
}
