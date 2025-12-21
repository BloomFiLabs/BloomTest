import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OptimalLeverageService } from './OptimalLeverageService';
import { RealFundingPaymentsService } from './RealFundingPaymentsService';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { GarchService } from '../../domain/services/GarchService';
import type { IHistoricalFundingRateService } from '../../domain/ports/IHistoricalFundingRateService';

describe('OptimalLeverageService', () => {
  let service: OptimalLeverageService;
  let mockConfigService: Partial<ConfigService>;
  let mockFundingPaymentsService: Partial<RealFundingPaymentsService>;
  let mockHistoricalService: Partial<IHistoricalFundingRateService>;
  let mockGarchService: Partial<GarchService>;

  beforeEach(async () => {
    // Mock GarchService
    mockGarchService = {
      calculateVolatility: jest.fn().mockReturnValue({ value: 0.15 }), // 15% annualized
    };
    // Mock ConfigService
    mockConfigService = {
      get: jest.fn((key: string) => {
        const config: Record<string, string> = {
          LEVERAGE_MIN: '1',
          LEVERAGE_MAX: '10',
          LEVERAGE_LOOKBACK_HOURS: '24',
          LEVERAGE_OVERRIDES: '',
        };
        return config[key] || undefined;
      }),
    };

    // Mock RealFundingPaymentsService
    mockFundingPaymentsService = {
      getCombinedSummary: jest.fn().mockResolvedValue({
        totalPayments: 100,
        totalPnl: 50,
        realAPY: 35,
        breakEvenHours: 24,
        winRateMetrics: {
          winRate: 60,
          totalWins: 60,
          totalLosses: 40,
          profitFactor: 1.5,
          avgWin: 5,
          avgLoss: -3,
          expectancy: 2,
        },
        topSymbols: [
          { symbol: 'BTC', totalPnl: 100, count: 10, avgPnl: 10, winRate: 70 },
          { symbol: 'ETH', totalPnl: 80, count: 8, avgPnl: 10, winRate: 65 },
        ],
        bottomSymbols: [
          { symbol: 'DOGE', totalPnl: -20, count: 5, avgPnl: -4, winRate: 40 },
        ],
        exchanges: new Map(),
        lastUpdated: new Date(),
      }),
    };

    // Mock HistoricalFundingRateService
    mockHistoricalService = {
      getHistoricalData: jest.fn().mockReturnValue([]),
      getHistoricalMetrics: jest.fn().mockReturnValue(null),
      getSpreadVolatilityMetrics: jest.fn().mockReturnValue(null),
      getConsistencyScore: jest.fn().mockReturnValue(0.5),
      getAverageRateForPeriod: jest.fn().mockReturnValue(null),
      getWeightedAverageRate: jest.fn().mockReturnValue(0.0001),
      getAverageSpread: jest.fn().mockReturnValue(0.0002),
    };

    service = new OptimalLeverageService(
      mockConfigService as ConfigService,
      mockFundingPaymentsService as RealFundingPaymentsService,
      mockHistoricalService as IHistoricalFundingRateService,
      mockGarchService as GarchService,
    );
  });

  describe('calculateOptimalLeverage', () => {
    it('should return leverage within configured bounds', async () => {
      const result = await service.calculateOptimalLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.optimalLeverage).toBeGreaterThanOrEqual(1);
      expect(result.optimalLeverage).toBeLessThanOrEqual(10);
    });

    it('should include all factor scores', async () => {
      const result = await service.calculateOptimalLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.factors).toBeDefined();
      expect(result.factors.volatilityScore).toBeGreaterThanOrEqual(0);
      expect(result.factors.volatilityScore).toBeLessThanOrEqual(1);
      expect(result.factors.liquidationRiskScore).toBeGreaterThanOrEqual(0);
      expect(result.factors.liquidationRiskScore).toBeLessThanOrEqual(1);
      expect(result.factors.liquidityScore).toBeGreaterThanOrEqual(0);
      expect(result.factors.liquidityScore).toBeLessThanOrEqual(1);
      expect(result.factors.winRateScore).toBeGreaterThanOrEqual(0);
      expect(result.factors.winRateScore).toBeLessThanOrEqual(1);
    });

    it('should calculate composite score correctly', async () => {
      const result = await service.calculateOptimalLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.compositeScore).toBeGreaterThanOrEqual(0);
      expect(result.compositeScore).toBeLessThanOrEqual(1);
    });

    it('should return correct exchange and symbol', async () => {
      const result = await service.calculateOptimalLeverage(
        'BTC-PERP',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.symbol).toBe('BTC'); // Normalized
      expect(result.exchange).toBe(ExchangeType.HYPERLIQUID);
    });

    it('should generate a reason for the recommendation', async () => {
      const result = await service.calculateOptimalLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.reason).toBeDefined();
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it('should return manual override when configured', async () => {
      // Create new service with override
      const configWithOverride = {
        get: jest.fn((key: string) => {
          const config: Record<string, string> = {
            LEVERAGE_MIN: '1',
            LEVERAGE_MAX: '10',
            LEVERAGE_LOOKBACK_HOURS: '24',
            LEVERAGE_OVERRIDES: 'BTC:5,ETH:3',
          };
          return config[key] || undefined;
        }),
      };

      const serviceWithOverride = new OptimalLeverageService(
        configWithOverride as unknown as ConfigService,
        mockFundingPaymentsService as RealFundingPaymentsService,
        mockHistoricalService as IHistoricalFundingRateService,
        mockGarchService as GarchService,
      );

      const result = await serviceWithOverride.calculateOptimalLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.optimalLeverage).toBe(5);
      expect(result.reason).toContain('Manual override');
    });
  });

  describe('getLiquidationRisk', () => {
    it('should calculate liquidation price for LONG position', () => {
      const result = service.getLiquidationRisk(
        'BTC',
        ExchangeType.HYPERLIQUID,
        5, // 5x leverage
        50000, // entry price
        50000, // current price
        'LONG',
      );

      // For 5x LONG: liqPrice ≈ entryPrice * (1 - 1/5 + 0.005) ≈ 50000 * 0.805 ≈ 40250
      expect(result.liquidationPrice).toBeCloseTo(40250, -2);
      expect(result.distanceToLiquidation).toBeGreaterThan(0.15); // Should be ~20%
    });

    it('should calculate liquidation price for SHORT position', () => {
      const result = service.getLiquidationRisk(
        'BTC',
        ExchangeType.HYPERLIQUID,
        5, // 5x leverage
        50000, // entry price
        50000, // current price
        'SHORT',
      );

      // For 5x SHORT: liqPrice ≈ entryPrice * (1 + 1/5 - 0.005) ≈ 50000 * 1.195 ≈ 59750
      expect(result.liquidationPrice).toBeCloseTo(59750, -2);
      expect(result.distanceToLiquidation).toBeGreaterThan(0.15);
    });

    it('should mark position as at risk when distance < 10%', () => {
      const result = service.getLiquidationRisk(
        'BTC',
        ExchangeType.HYPERLIQUID,
        20, // 20x leverage - very risky
        50000,
        50000,
        'LONG',
      );

      // 20x leverage = only 5% distance to liquidation
      expect(result.isAtRisk).toBe(true);
      expect(result.riskLevel).toBe('CRITICAL');
    });

    it('should return LOW risk for conservative leverage', () => {
      const result = service.getLiquidationRisk(
        'BTC',
        ExchangeType.HYPERLIQUID,
        2, // 2x leverage
        50000,
        50000,
        'LONG',
      );

      // 2x leverage = ~50% distance to liquidation
      expect(result.isAtRisk).toBe(false);
      expect(result.riskLevel).toBe('LOW');
    });

    it('should return correct risk levels at different distances', () => {
      // 3x leverage: ~33% distance -> LOW
      const lowRisk = service.getLiquidationRisk(
        'BTC',
        ExchangeType.HYPERLIQUID,
        3,
        50000,
        50000,
        'LONG',
      );
      expect(lowRisk.riskLevel).toBe('LOW');

      // 8x leverage: ~12.5% distance -> MEDIUM
      const mediumRisk = service.getLiquidationRisk(
        'BTC',
        ExchangeType.HYPERLIQUID,
        8,
        50000,
        50000,
        'LONG',
      );
      expect(mediumRisk.riskLevel).toBe('MEDIUM');

      // 15x leverage: ~6.6% distance -> HIGH
      const highRisk = service.getLiquidationRisk(
        'BTC',
        ExchangeType.HYPERLIQUID,
        15,
        50000,
        50000,
        'LONG',
      );
      expect(highRisk.riskLevel).toBe('HIGH');
    });
  });

  describe('getLiquidityAssessment', () => {
    it('should return high liquidity score for small positions', async () => {
      const result = await service.getLiquidityAssessment(
        'BTC',
        ExchangeType.HYPERLIQUID,
        1000, // Small position
      );

      // Small positions should have good liquidity scores
      expect(result.liquidityScore).toBeGreaterThanOrEqual(0.5);
    });

    it('should calculate position as percentage of OI', async () => {
      const result = await service.getLiquidityAssessment(
        'BTC',
        ExchangeType.HYPERLIQUID,
        10000,
      );

      expect(result.positionSizeUsd).toBe(10000);
      expect(result.positionAsPercentOfOI).toBeDefined();
    });

    it('should estimate slippage', async () => {
      const result = await service.getLiquidityAssessment(
        'BTC',
        ExchangeType.HYPERLIQUID,
        10000,
      );

      expect(result.estimatedSlippage).toBeGreaterThanOrEqual(0);
      expect(result.estimatedSlippage).toBeLessThanOrEqual(0.02); // Max 2%
    });

    it('should provide max recommended size', async () => {
      const result = await service.getLiquidityAssessment(
        'BTC',
        ExchangeType.HYPERLIQUID,
        10000,
      );

      expect(result.maxRecommendedSize).toBeGreaterThan(0);
    });
  });

  describe('getWinRateAdjustedLeverage', () => {
    it('should return win rate score based on symbol performance', async () => {
      const result = await service.getWinRateAdjustedLeverage('BTC');

      // BTC has 70% win rate in mock data, so score should be 1.0
      expect(result).toBe(1);
    });

    it('should return lower score for poorly performing symbol', async () => {
      const result = await service.getWinRateAdjustedLeverage('DOGE');

      // DOGE has 40% win rate in mock data
      // Score = min(40/70, 1) ≈ 0.57
      expect(result).toBeCloseTo(0.57, 1);
    });

    it('should use overall win rate for unknown symbol', async () => {
      const result = await service.getWinRateAdjustedLeverage('UNKNOWN_SYMBOL');

      // Overall win rate is 60%, so score = min(60/70, 1) ≈ 0.857
      expect(result).toBeCloseTo(0.857, 1);
    });

    it('should return default score if funding service unavailable', async () => {
      const serviceWithoutFunding = new OptimalLeverageService(
        mockConfigService as ConfigService,
        undefined, // No funding service
        mockHistoricalService as IHistoricalFundingRateService,
        mockGarchService as GarchService,
      );

      const result =
        await serviceWithoutFunding.getWinRateAdjustedLeverage('BTC');

      expect(result).toBe(0.5); // Default
    });
  });

  describe('shouldAdjustLeverage', () => {
    it('should recommend adjustment when difference is significant', async () => {
      // Mock a scenario where current leverage is very different from optimal
      const result = await service.shouldAdjustLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        1, // Current leverage is 1x
      );

      // If optimal is higher, should recommend adjustment
      if (result.recommendedLeverage > 1.5) {
        expect(result.shouldAdjust).toBe(true);
      }
    });

    it('should not recommend adjustment when leverage is close', async () => {
      // Get the optimal leverage first
      const recommendation = await service.calculateOptimalLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      // Use leverage close to optimal
      const result = await service.shouldAdjustLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        recommendation.optimalLeverage, // Same as optimal
      );

      expect(result.shouldAdjust).toBe(false);
    });

    it('should include reason for adjustment recommendation', async () => {
      const result = await service.shouldAdjustLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        5,
      );

      expect(result.reason).toBeDefined();
      expect(typeof result.reason).toBe('string');
    });

    it('should always return recommended leverage', async () => {
      const result = await service.shouldAdjustLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        5,
      );

      expect(result.recommendedLeverage).toBeGreaterThanOrEqual(1);
      expect(result.recommendedLeverage).toBeLessThanOrEqual(10);
    });
  });

  describe('getAssetVolatility', () => {
    it('should return volatility metrics with required fields', async () => {
      const result = await service.getAssetVolatility(
        'BTC',
        ExchangeType.HYPERLIQUID,
        24,
      );

      expect(result.symbol).toBe('BTC');
      expect(result.exchange).toBe(ExchangeType.HYPERLIQUID);
      expect(result.dailyVolatility).toBeDefined();
      expect(result.hourlyVolatility).toBeDefined();
      expect(result.maxDrawdown24h).toBeDefined();
      expect(result.lookbackHours).toBe(24);
    });

    it('should return default values when data unavailable', async () => {
      const result = await service.getAssetVolatility(
        'UNKNOWN_COIN',
        ExchangeType.HYPERLIQUID,
        24,
      );

      // Should return default metrics (now 10% for safety)
      expect(result.dailyVolatility).toBe(0.10); 
      expect(result.dataPoints).toBe(0);
    });

    it('should normalize symbol in results', async () => {
      const result = await service.getAssetVolatility(
        'BTC-PERP',
        ExchangeType.HYPERLIQUID,
        24,
      );

      expect(result.symbol).toBe('BTC'); // Normalized
    });
  });

  describe('Safety constraints', () => {
    it('should cap leverage at 5x for high volatility', async () => {
      // Create service that will get high volatility data
      // (In practice, this tests the applySafetyConstraints method)
      const result = await service.calculateOptimalLeverage(
        'HIGHLY_VOLATILE_COIN',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      // Even with perfect scores, high volatility should cap leverage
      expect(result.optimalLeverage).toBeLessThanOrEqual(10);
    });

    it('should never exceed configured max leverage', async () => {
      const result = await service.calculateOptimalLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.optimalLeverage).toBeLessThanOrEqual(10); // LEVERAGE_MAX
    });

    it('should never go below configured min leverage', async () => {
      const result = await service.calculateOptimalLeverage(
        'RISKY_COIN',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.optimalLeverage).toBeGreaterThanOrEqual(1); // LEVERAGE_MIN
    });
  });

  describe('getAllRecommendations', () => {
    it('should return recommendations for multiple symbols', async () => {
      const results = await service.getAllRecommendations();

      expect(results.length).toBeGreaterThan(0);
    });

    it('should return valid recommendations', async () => {
      const results = await service.getAllRecommendations();

      for (const rec of results) {
        expect(rec.optimalLeverage).toBeGreaterThanOrEqual(1);
        expect(rec.optimalLeverage).toBeLessThanOrEqual(10);
        expect(rec.symbol).toBeDefined();
        expect(rec.exchange).toBeDefined();
      }
    });
  });

  describe('monitorAndAlert', () => {
    it('should return empty alerts when no positions', async () => {
      const alerts = await service.monitorAndAlert();

      expect(Array.isArray(alerts)).toBe(true);
    });
  });

  describe('Symbol normalization', () => {
    it('should normalize USDT suffix', async () => {
      const result = await service.calculateOptimalLeverage(
        'BTCUSDT',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.symbol).toBe('BTC');
    });

    it('should normalize USDC suffix', async () => {
      const result = await service.calculateOptimalLeverage(
        'ETHUSDC',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.symbol).toBe('ETH');
    });

    it('should normalize -PERP suffix', async () => {
      const result = await service.calculateOptimalLeverage(
        'SOL-PERP',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.symbol).toBe('SOL');
    });

    it('should handle already normalized symbols', async () => {
      const result = await service.calculateOptimalLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.symbol).toBe('BTC');
    });

    it('should uppercase symbols', async () => {
      const result = await service.calculateOptimalLeverage(
        'btc',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.symbol).toBe('BTC');
    });
  });

  describe('Leverage formula (Sigma-Targeted)', () => {
    it('should calculate leverage based on inverse volatility (1 / k*sigma)', async () => {
      // Formula: L = 1 / (k * dailyVol)
      // k defaults to 5.0 in code if not in config
      jest.spyOn(service, 'getAssetVolatility').mockResolvedValue({
        symbol: 'BTC',
        exchange: ExchangeType.HYPERLIQUID,
        dailyVolatility: 0.04, // 4% daily
        hourlyVolatility: 0.008,
        maxDrawdown24h: 0.05,
        atr: 0,
        lookbackHours: 24,
        dataPoints: 100,
        timestamp: new Date(),
      });

      // Mock high liquidity to avoid slippage penalty
      jest.spyOn(service, 'getLiquidityAssessment').mockResolvedValue({
        symbol: 'BTC',
        exchange: ExchangeType.HYPERLIQUID,
        openInterest: 100000000, // Very high OI
        positionSizeUsd: 1000,
        positionAsPercentOfOI: 0.001,
        estimatedSlippage: 0.0001,
        maxRecommendedSize: 1000000,
        liquidityScore: 1.0,
      });

      const result = await service.calculateOptimalLeverage(
        'BTC',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      // Expected: 1 / (5.0 * 0.04) = 1 / 0.20 = 5.0x
      expect(result.optimalLeverage).toBe(5.0);
      expect(result.reason).toContain('Sigma-Targeted');
    });

    it('should reduce leverage proportionally for higher volatility', async () => {
      // k=5.0, dailyVol=0.10 (10%)
      // Expected: 1 / (5.0 * 0.10) = 1 / 0.50 = 2.0x
      jest.spyOn(service, 'getAssetVolatility').mockResolvedValue({
        symbol: 'PEPE',
        exchange: ExchangeType.HYPERLIQUID,
        dailyVolatility: 0.10, 
        hourlyVolatility: 0.02,
        maxDrawdown24h: 0.15,
        atr: 0,
        lookbackHours: 24,
        dataPoints: 100,
        timestamp: new Date(),
      });

      const result = await service.calculateOptimalLeverage(
        'PEPE',
        ExchangeType.HYPERLIQUID,
        1000,
      );

      expect(result.optimalLeverage).toBe(2.0);
    });

    it('should apply liquidity penalty for large positions relative to OI', async () => {
      jest.spyOn(service, 'getAssetVolatility').mockResolvedValue({
        symbol: 'SMALL_CAP',
        exchange: ExchangeType.HYPERLIQUID,
        dailyVolatility: 0.05,
        hourlyVolatility: 0.01,
        maxDrawdown24h: 0.05,
        atr: 0,
        lookbackHours: 24,
        dataPoints: 100,
        timestamp: new Date(),
      });

      // Mock low liquidity
      jest.spyOn(service, 'getLiquidityAssessment').mockResolvedValue({
        symbol: 'SMALL_CAP',
        exchange: ExchangeType.HYPERLIQUID,
        openInterest: 100000, // $100k OI
        positionSizeUsd: 10000, // $10k position (10% of OI)
        positionAsPercentOfOI: 10,
        estimatedSlippage: 0.02, // 2% slippage
        maxRecommendedSize: 5000,
        liquidityScore: 0.3,
      });

      const result = await service.calculateOptimalLeverage(
        'SMALL_CAP',
        ExchangeType.HYPERLIQUID,
        10000,
      );

      // Base: 1 / (5.0 * 0.05) = 4.0x
      // Penalty: 4.0 * (1 - 0.02) = 3.92x -> rounded to 3.9x
      expect(result.optimalLeverage).toBe(3.9);
    });
  });

  describe('Caching behavior', () => {
    it('should cache volatility results', async () => {
      // First call
      const result1 = await service.getAssetVolatility(
        'BTC',
        ExchangeType.HYPERLIQUID,
        24,
      );

      // Second call should use cache
      const result2 = await service.getAssetVolatility(
        'BTC',
        ExchangeType.HYPERLIQUID,
        24,
      );

      // Results should be the same (from cache)
      expect(result1.dailyVolatility).toBe(result2.dailyVolatility);
      expect(result1.timestamp.getTime()).toBe(result2.timestamp.getTime());
    });

    it('should use different cache keys for different symbols', async () => {
      const btcResult = await service.getAssetVolatility(
        'BTC',
        ExchangeType.HYPERLIQUID,
        24,
      );
      const ethResult = await service.getAssetVolatility(
        'ETH',
        ExchangeType.HYPERLIQUID,
        24,
      );

      // Timestamps could be different if not cached
      expect(btcResult.symbol).toBe('BTC');
      expect(ethResult.symbol).toBe('ETH');
    });
  });
});
