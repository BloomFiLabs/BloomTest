import { Module, forwardRef, Logger, OnModuleInit, Inject, Optional } from '@nestjs/common';
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
import { StrategyConfig } from '../../domain/value-objects/StrategyConfig';
import { SimpleEventBus } from '../events/SimpleEventBus';
import type { IEventBus } from '../../domain/events/DomainEvent';
import type { IHistoricalFundingRateService } from '../../domain/ports/IHistoricalFundingRateService';
import type { IPositionLossTracker } from '../../domain/ports/IPositionLossTracker';

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
      useFactory: (configService: ConfigService) => {
        try {
          return new AsterExchangeAdapter(configService);
        } catch (error: any) {
          const logger = new Logger('PerpKeeperModule');
          logger.warn(`Failed to create Aster adapter: ${error.message}`);
          logger.warn('Adapter will be created lazily when needed');
          return null;
        }
      },
      inject: [ConfigService],
    },
    {
      provide: 'ASTER_ADAPTER',
      useFactory: (configService: ConfigService) => {
        try {
          return new AsterExchangeAdapter(configService);
        } catch (error: any) {
          return null;
        }
      },
      inject: [ConfigService],
    },
    {
      provide: LighterExchangeAdapter,
      useFactory: (configService: ConfigService) => {
        try {
          return new LighterExchangeAdapter(configService);
        } catch (error: any) {
          const logger = new Logger('PerpKeeperModule');
          logger.warn(`Failed to create Lighter adapter: ${error.message}`);
          logger.warn('Adapter will be created lazily when needed');
          return null;
        }
      },
      inject: [ConfigService],
    },
    {
      provide: 'LIGHTER_ADAPTER',
      useFactory: (configService: ConfigService) => {
        try {
          return new LighterExchangeAdapter(configService);
        } catch (error: any) {
          return null;
        }
      },
      inject: [ConfigService],
    },
    {
      provide: HyperliquidExchangeAdapter,
      useFactory: (configService: ConfigService, dataProvider: HyperLiquidDataProvider) => {
        try {
          return new HyperliquidExchangeAdapter(configService, dataProvider);
        } catch (error: any) {
          const logger = new Logger('PerpKeeperModule');
          logger.warn(`Failed to create Hyperliquid adapter: ${error.message}`);
          logger.warn('Adapter will be created lazily when needed');
          return null;
        }
      },
      inject: [ConfigService, HyperLiquidDataProvider],
    },
    {
      provide: 'HYPERLIQUID_ADAPTER',
      useFactory: (configService: ConfigService, dataProvider: HyperLiquidDataProvider) => {
        try {
          return new HyperliquidExchangeAdapter(configService, dataProvider);
        } catch (error: any) {
          return null;
        }
      },
      inject: [ConfigService, HyperLiquidDataProvider],
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
    ExecutionPlanBuilder,
    {
      provide: PortfolioOptimizer,
      useFactory: (
        costCalculator: CostCalculator,
        historicalService: IHistoricalFundingRateService,
        config: StrategyConfig,
      ) => {
        return new PortfolioOptimizer(costCalculator, historicalService, config);
      },
      inject: [CostCalculator, 'IHistoricalFundingRateService', StrategyConfig],
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
      provide: OpportunityEvaluator,
      useFactory: (
        historicalService: IHistoricalFundingRateService,
        aggregator: FundingRateAggregator,
        lossTracker: IPositionLossTracker,
        costCalculator: CostCalculator,
        config: StrategyConfig,
      ) => {
        return new OpportunityEvaluator(
          historicalService,
          aggregator,
          lossTracker,
          costCalculator,
          config,
        );
      },
      inject: [
        'IHistoricalFundingRateService',
        FundingRateAggregator,
        'IPositionLossTracker',
        CostCalculator,
        StrategyConfig,
      ],
    },
    
    // Event bus
    {
      provide: 'IEventBus',
      useClass: SimpleEventBus,
    },
    SimpleEventBus, // Keep for backward compatibility
    
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
      inject: [ConfigService, RealFundingPaymentsService, 'IHistoricalFundingRateService'],
    },
    {
      provide: 'IOptimalLeverageService',
      useExisting: OptimalLeverageService,
    },
    
    // Diagnostics service (must be before PerformanceLogger due to dependency)
    DiagnosticsService,
    
    // Profit tracking and reward harvesting
    {
      provide: ProfitTracker,
      useFactory: (configService: ConfigService, keeperService: PerpKeeperService) => {
        return new ProfitTracker(configService, keeperService);
      },
      inject: [ConfigService, PerpKeeperService],
    },
    {
      provide: RewardHarvester,
      useFactory: (
        configService: ConfigService,
        keeperService: PerpKeeperService,
        profitTracker: ProfitTracker,
        diagnosticsService: DiagnosticsService,
      ) => {
        return new RewardHarvester(configService, keeperService, profitTracker, diagnosticsService);
      },
      inject: [ConfigService, PerpKeeperService, ProfitTracker, DiagnosticsService],
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
        return new WithdrawalFulfiller(configService, eventListener, hyperliquidAdapter, perpKeeperService);
      },
      inject: [ConfigService, KeeperStrategyEventListener, HyperliquidExchangeAdapter, PerpKeeperService],
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
      useFactory: (realFundingService: RealFundingPaymentsService, diagnosticsService: DiagnosticsService) => {
        return new PerpKeeperPerformanceLogger(realFundingService, diagnosticsService);
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
    ProfitTracker,
    RewardHarvester,
    KeeperStrategyEventListener,
    WithdrawalFulfiller,
    NAVReporter,
  ],
})
export class PerpKeeperModule implements OnModuleInit {
  private readonly logger = new Logger(PerpKeeperModule.name);

  constructor(
    @Optional() private readonly balanceManager?: BalanceManager,
    @Optional() private readonly profitTracker?: ProfitTracker,
  ) {}

  /**
   * Wire up services after module initialization to avoid circular dependencies
   */
  async onModuleInit() {
    // Wire ProfitTracker into BalanceManager for deployable capital calculations
    if (this.balanceManager && this.profitTracker) {
      this.balanceManager.setProfitTracker(this.profitTracker);
      this.logger.log('Wired ProfitTracker into BalanceManager for profit-excluded position sizing');
    }
  }
}
