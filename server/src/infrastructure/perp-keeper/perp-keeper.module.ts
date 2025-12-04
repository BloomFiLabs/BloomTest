import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PerpKeeperService } from '../../application/services/PerpKeeperService';
import { PerpKeeperScheduler } from '../../application/services/PerpKeeperScheduler';
import { PerpKeeperPerformanceLogger } from '../logging/PerpKeeperPerformanceLogger';
import { AsterExchangeAdapter } from '../adapters/aster/AsterExchangeAdapter';
import { LighterExchangeAdapter } from '../adapters/lighter/LighterExchangeAdapter';
import { HyperliquidExchangeAdapter } from '../adapters/hyperliquid/HyperliquidExchangeAdapter';
import { MockExchangeAdapter } from '../adapters/mock/MockExchangeAdapter';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../domain/ports/IPerpExchangeAdapter';
import { AsterFundingDataProvider } from '../adapters/aster/AsterFundingDataProvider';
import { LighterFundingDataProvider } from '../adapters/lighter/LighterFundingDataProvider';
import { HyperLiquidDataProvider } from '../adapters/hyperliquid/HyperLiquidDataProvider';
import { HyperLiquidWebSocketProvider } from '../adapters/hyperliquid/HyperLiquidWebSocketProvider';
import { LighterWebSocketProvider } from '../adapters/lighter/LighterWebSocketProvider';
import { FundingRateAggregator } from '../../domain/services/FundingRateAggregator';
import { FundingArbitrageStrategy } from '../../domain/services/FundingArbitrageStrategy';
import { PerpKeeperOrchestrator } from '../../domain/services/PerpKeeperOrchestrator';
import { ExchangeBalanceRebalancer } from '../../domain/services/ExchangeBalanceRebalancer';
import { HistoricalFundingRateService } from '../services/HistoricalFundingRateService';
import { PositionLossTracker } from '../services/PositionLossTracker';
import { PortfolioRiskAnalyzer } from '../services/PortfolioRiskAnalyzer';
import { PerpKeeperController } from '../controllers/PerpKeeperController';
import { FundingRateController } from '../controllers/FundingRateController';

/**
 * PerpKeeperModule - Module for perpetual keeper functionality
 * 
 * Provides:
 * - Exchange adapters (Aster, Lighter, Hyperliquid)
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
    {
      provide: 'ASTER_ADAPTER',
      useFactory: (configService: ConfigService) => {
        return new AsterExchangeAdapter(configService);
      },
      inject: [ConfigService],
    },
    {
      provide: 'LIGHTER_ADAPTER',
      useFactory: (configService: ConfigService) => {
        return new LighterExchangeAdapter(configService);
      },
      inject: [ConfigService],
    },
    {
      provide: 'HYPERLIQUID_ADAPTER',
      useFactory: (configService: ConfigService, dataProvider: HyperLiquidDataProvider) => {
        return new HyperliquidExchangeAdapter(configService, dataProvider);
      },
      inject: [ConfigService, HyperLiquidDataProvider],
    },
    // Keep original adapters for backward compatibility (will be replaced in PerpKeeperService)
    AsterExchangeAdapter,
    LighterExchangeAdapter,
    HyperliquidExchangeAdapter,
    
    // Funding data providers
    AsterFundingDataProvider,
    LighterWebSocketProvider, // WebSocket provider for Lighter (real-time OI data)
    LighterFundingDataProvider,
    HyperLiquidWebSocketProvider, // WebSocket provider for Hyperliquid (reduces rate limits)
    HyperLiquidDataProvider,
    
    // Domain services
    FundingRateAggregator,
    FundingArbitrageStrategy,
    PerpKeeperOrchestrator,
    ExchangeBalanceRebalancer,
    
    // Historical and loss tracking services
    HistoricalFundingRateService,
    PositionLossTracker,
    PortfolioRiskAnalyzer,
    
    // Application services
    PerpKeeperService,
    PerpKeeperScheduler,
    
    // Performance logging
    PerpKeeperPerformanceLogger,
  ],
  exports: [
    PerpKeeperService,
    PerpKeeperScheduler,
    PerpKeeperPerformanceLogger,
    PerpKeeperOrchestrator,
  ],
})
export class PerpKeeperModule {}

