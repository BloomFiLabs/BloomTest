import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PredictionAutoCalibrator } from '../domain/services/prediction/PredictionAutoCalibrator';
import { PredictionBacktester } from '../domain/services/prediction/PredictionBacktester';
import { EnsemblePredictor } from '../domain/services/prediction/EnsemblePredictor';
import { FundingRateAggregator } from '../domain/services/FundingRateAggregator';
import { ExchangeType } from '../domain/value-objects/ExchangeConfig';
import { MeanReversionPredictor } from '../domain/services/prediction/predictors/MeanReversionPredictor';
import { PremiumIndexPredictor } from '../domain/services/prediction/predictors/PremiumIndexPredictor';
import { OpenInterestPredictor } from '../domain/services/prediction/predictors/OpenInterestPredictor';
import { KalmanFilterEstimator } from '../domain/services/prediction/filters/KalmanFilterEstimator';
import { RegimeDetector } from '../domain/services/prediction/filters/RegimeDetector';
import { HistoricalFundingRateService } from '../infrastructure/services/HistoricalFundingRateService';
import { HyperLiquidDataProvider } from '../infrastructure/adapters/hyperliquid/HyperLiquidDataProvider';
import { LighterFundingDataProvider } from '../infrastructure/adapters/lighter/LighterFundingDataProvider';
import { RateLimiterService } from '../infrastructure/services/RateLimiterService';
import { HyperLiquidWebSocketProvider } from '../infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider';
import { LighterWebSocketProvider } from '../infrastructure/adapters/lighter/LighterWebSocketProvider';

describe('Prediction Auto-Calibrator', () => {
  let calibrator: PredictionAutoCalibrator;
  let historicalService: HistoricalFundingRateService;
  let ensemblePredictor: EnsemblePredictor;
  let app: any;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: any) => {
              if (key === 'HISTORICAL_DATA_DIR') return 'data';
              return defaultValue;
            },
          },
        },
        {
          provide: RateLimiterService,
          useValue: {
            acquire: jest.fn().mockResolvedValue(undefined),
            getStatistics: jest.fn().mockReturnValue({}),
          },
        },
        { provide: HyperLiquidWebSocketProvider, useValue: { getOpenInterest: () => 0, getMarkPrice: () => 0 } },
        { provide: LighterWebSocketProvider, useValue: { getOpenInterest: () => 0, getMarkPrice: () => 0 } },
        {
          provide: HyperLiquidDataProvider,
          useValue: { getFundingData: jest.fn() },
        },
        {
          provide: LighterFundingDataProvider,
          useValue: { getFundingData: jest.fn() },
        },
        {
          provide: FundingRateAggregator,
          useValue: {
            discoverCommonAssets: jest.fn().mockResolvedValue(['BTC', 'ETH']),
            getSymbolMapping: jest.fn().mockImplementation((s) => ({ hyperliquidSymbol: s })),
          },
        },
        HistoricalFundingRateService,
        {
          provide: 'IHistoricalFundingRateService',
          useExisting: HistoricalFundingRateService,
        },
        RegimeDetector,
        KalmanFilterEstimator,
        MeanReversionPredictor,
        PremiumIndexPredictor,
        OpenInterestPredictor,
        EnsemblePredictor,
        PredictionBacktester,
        PredictionAutoCalibrator,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    calibrator = moduleRef.get(PredictionAutoCalibrator);
    historicalService = moduleRef.get(HistoricalFundingRateService);
    ensemblePredictor = moduleRef.get(EnsemblePredictor);

    // Load historical data
    await historicalService.onModuleInit();
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('should run calibration cycle and update parameters', async () => {
    console.log('\nRunning manual calibration cycle...');
    await calibrator.runCalibrationCycle();

    console.log('\n--- Calibration Results ---');
    const symbols = ['BTC', 'ETH'];
    for (const symbol of symbols) {
      const lookback = ensemblePredictor.getLookbackHours(symbol, ExchangeType.HYPERLIQUID);
      console.log(`${symbol}/HYPERLIQUID: Optimal lookback = ${lookback}h`);
      expect(lookback).toBeDefined();
    }
  }, 120000);
});





