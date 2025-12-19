import {
  FundingRateStrategy,
  FundingRateStrategyConfig,
} from './FundingRateStrategy';
import {
  IExecutableStrategy,
  StrategyExecutionResult,
} from './IExecutableStrategy';
import { createEmptyContext } from '../services/MarketDataContext';

// Mock interfaces for dependencies
interface MockFundingDataProvider {
  getCurrentFundingRate(asset: string): Promise<number>;
  getPredictedFundingRate(asset: string): Promise<number>;
  getOpenInterest(asset: string): Promise<number>;
}

interface MockHyperLiquidExecutor {
  getPosition(strategyAddress: string): Promise<{
    size: number;
    side: 'long' | 'short' | 'none';
    entryPrice: number;
  }>;
  placeOrder(
    strategyAddress: string,
    isLong: boolean,
    size: number,
    price: number,
  ): Promise<string>;
  closePosition(strategyAddress: string): Promise<string>;
  getEquity(strategyAddress: string): Promise<number>;
  getMarkPrice(asset: string): Promise<number>;
}

describe('FundingRateStrategy', () => {
  let strategy: FundingRateStrategy;
  let mockFundingProvider: jest.Mocked<MockFundingDataProvider>;
  let mockExecutor: jest.Mocked<MockHyperLiquidExecutor>;

  const defaultConfig: FundingRateStrategyConfig = {
    name: 'ETH Funding Rate',
    chainId: 999, // HyperEVM
    contractAddress: '0x247062659f997BDb5975b984c2bE2aDF87661314',
    enabled: true,
    asset: 'ETH',
    minFundingRateThreshold: 0.0001, // 0.01% per 8h = ~10% APY
    maxPositionSize: 10000, // $10k max position
    targetLeverage: 1, // 1x for now (delta neutral with spot)
  };

  beforeEach(() => {
    mockFundingProvider = {
      getCurrentFundingRate: jest.fn(),
      getPredictedFundingRate: jest.fn(),
      getOpenInterest: jest.fn(),
    };

    mockExecutor = {
      getPosition: jest.fn(),
      placeOrder: jest.fn(),
      closePosition: jest.fn(),
      getEquity: jest.fn(),
      getMarkPrice: jest.fn().mockResolvedValue(3000), // Default ETH price
    };

    strategy = new FundingRateStrategy(
      defaultConfig,
      mockFundingProvider as any,
      mockExecutor as any,
    );
  });

  describe('IExecutableStrategy interface', () => {
    it('should implement name property', () => {
      expect(strategy.name).toBe('ETH Funding Rate');
    });

    it('should implement chainId property', () => {
      expect(strategy.chainId).toBe(999);
    });

    it('should implement contractAddress property', () => {
      expect(strategy.contractAddress).toBe(
        '0x247062659f997BDb5975b984c2bE2aDF87661314',
      );
    });

    it('should implement isEnabled/setEnabled', () => {
      expect(strategy.isEnabled()).toBe(true);
      strategy.setEnabled(false);
      expect(strategy.isEnabled()).toBe(false);
    });
  });

  describe('execute() - Entry conditions', () => {
    it('should skip execution when disabled', async () => {
      strategy.setEnabled(false);

      const result = await strategy.execute(createEmptyContext());

      expect(result.executed).toBe(false);
      expect(result.reason).toContain('disabled');
    });

    it('should open SHORT when funding rate is positive (longs pay shorts)', async () => {
      mockFundingProvider.getCurrentFundingRate.mockResolvedValue(0.0005); // 0.05% per 8h
      mockFundingProvider.getPredictedFundingRate.mockResolvedValue(0.0004);
      mockFundingProvider.getOpenInterest.mockResolvedValue(100000000);
      mockExecutor.getPosition.mockResolvedValue({
        size: 0,
        side: 'none',
        entryPrice: 0,
      });
      mockExecutor.getEquity.mockResolvedValue(10000);
      mockExecutor.placeOrder.mockResolvedValue('0xabc123');

      const result = await strategy.execute(createEmptyContext());

      expect(result.executed).toBe(true);
      expect(result.action).toBe('OPEN_SHORT');
      expect(mockExecutor.placeOrder).toHaveBeenCalledWith(
        defaultConfig.contractAddress,
        false, // isLong = false (short)
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('should open LONG when funding rate is negative (shorts pay longs)', async () => {
      mockFundingProvider.getCurrentFundingRate.mockResolvedValue(-0.0005); // -0.05% per 8h
      mockFundingProvider.getPredictedFundingRate.mockResolvedValue(-0.0004);
      mockFundingProvider.getOpenInterest.mockResolvedValue(100000000);
      mockExecutor.getPosition.mockResolvedValue({
        size: 0,
        side: 'none',
        entryPrice: 0,
      });
      mockExecutor.getEquity.mockResolvedValue(10000);
      mockExecutor.placeOrder.mockResolvedValue('0xdef456');

      const result = await strategy.execute(createEmptyContext());

      expect(result.executed).toBe(true);
      expect(result.action).toBe('OPEN_LONG');
      expect(mockExecutor.placeOrder).toHaveBeenCalledWith(
        defaultConfig.contractAddress,
        true, // isLong = true
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('should NOT trade when funding rate is below threshold', async () => {
      mockFundingProvider.getCurrentFundingRate.mockResolvedValue(0.00005); // 0.005% - below threshold
      mockFundingProvider.getPredictedFundingRate.mockResolvedValue(0.00004);
      mockFundingProvider.getOpenInterest.mockResolvedValue(100000000);
      mockExecutor.getPosition.mockResolvedValue({
        size: 0,
        side: 'none',
        entryPrice: 0,
      });
      mockExecutor.getEquity.mockResolvedValue(10000);

      const result = await strategy.execute(createEmptyContext());

      expect(result.executed).toBe(false);
      expect(result.reason).toContain('below threshold');
      expect(mockExecutor.placeOrder).not.toHaveBeenCalled();
    });
  });

  describe('execute() - Position management', () => {
    it('should HOLD position when funding rate remains favorable', async () => {
      mockFundingProvider.getCurrentFundingRate.mockResolvedValue(0.0005); // Still positive
      mockFundingProvider.getPredictedFundingRate.mockResolvedValue(0.0004);
      mockFundingProvider.getOpenInterest.mockResolvedValue(100000000);
      mockExecutor.getPosition.mockResolvedValue({
        size: 1000,
        side: 'short',
        entryPrice: 3000,
      });
      mockExecutor.getEquity.mockResolvedValue(10000);

      const result = await strategy.execute(createEmptyContext());

      expect(result.executed).toBe(false);
      expect(result.action).toBe('HOLD');
      expect(result.reason).toContain('favorable');
    });

    it('should CLOSE position when funding rate flips against us (weak reversal)', async () => {
      // Weak reversal: rate flipped but not strong enough to flip position
      // Rate is -0.00008 which is below the flip threshold (0.0001 * 1.5 = 0.00015)
      mockFundingProvider.getCurrentFundingRate.mockResolvedValue(-0.00008); // Weak negative
      mockFundingProvider.getPredictedFundingRate.mockResolvedValue(-0.00006);
      mockFundingProvider.getOpenInterest.mockResolvedValue(100000000);
      mockExecutor.getPosition.mockResolvedValue({
        size: 1000,
        side: 'short',
        entryPrice: 3000,
      }); // We're short
      mockExecutor.getEquity.mockResolvedValue(10000);
      mockExecutor.closePosition.mockResolvedValue('0xclose123');

      const result = await strategy.execute(createEmptyContext());

      expect(result.executed).toBe(true);
      expect(result.action).toBe('CLOSE_POSITION');
      expect(mockExecutor.closePosition).toHaveBeenCalled();
    });

    it('should FLIP position when funding rate strongly reverses', async () => {
      mockFundingProvider.getCurrentFundingRate.mockResolvedValue(-0.0008); // Strong negative
      mockFundingProvider.getPredictedFundingRate.mockResolvedValue(-0.0007);
      mockFundingProvider.getOpenInterest.mockResolvedValue(100000000);
      mockExecutor.getPosition.mockResolvedValue({
        size: 1000,
        side: 'short',
        entryPrice: 3000,
      });
      mockExecutor.getEquity.mockResolvedValue(10000);
      mockExecutor.closePosition.mockResolvedValue('0xclose123');
      mockExecutor.placeOrder.mockResolvedValue('0xflip456');

      const result = await strategy.execute(createEmptyContext());

      expect(result.executed).toBe(true);
      expect(result.action).toBe('FLIP_TO_LONG');
    });
  });

  describe('getMetrics()', () => {
    it('should return current strategy metrics', async () => {
      mockFundingProvider.getCurrentFundingRate.mockResolvedValue(0.0005);
      mockFundingProvider.getPredictedFundingRate.mockResolvedValue(0.0004);
      mockFundingProvider.getOpenInterest.mockResolvedValue(100000000);
      mockExecutor.getPosition.mockResolvedValue({
        size: 1000,
        side: 'short',
        entryPrice: 3000,
      });
      mockExecutor.getEquity.mockResolvedValue(10500);

      const metrics = await strategy.getMetrics();

      expect(metrics).toHaveProperty('currentFundingRate');
      expect(metrics).toHaveProperty('predictedFundingRate');
      expect(metrics).toHaveProperty('positionSide');
      expect(metrics).toHaveProperty('positionSize');
      expect(metrics).toHaveProperty('equity');
      expect(metrics).toHaveProperty('estimatedAPY');
    });
  });

  describe('emergencyExit()', () => {
    it('should close all positions and return tx hash', async () => {
      mockExecutor.closePosition.mockResolvedValue('0xemergency789');

      const txHash = await strategy.emergencyExit();

      expect(txHash).toBe('0xemergency789');
      expect(mockExecutor.closePosition).toHaveBeenCalledWith(
        defaultConfig.contractAddress,
      );
    });
  });

  describe('APY calculation', () => {
    it('should calculate correct APY from funding rate', async () => {
      // 0.05% per 8h = 0.0005
      // 3 funding periods per day = 0.15% daily
      // 365 days = 54.75% APY (simple) or higher compounded
      mockFundingProvider.getCurrentFundingRate.mockResolvedValue(0.0005);
      mockFundingProvider.getPredictedFundingRate.mockResolvedValue(0.0005);
      mockFundingProvider.getOpenInterest.mockResolvedValue(100000000);
      mockExecutor.getPosition.mockResolvedValue({
        size: 0,
        side: 'none',
        entryPrice: 0,
      });
      mockExecutor.getEquity.mockResolvedValue(10000);

      const metrics = await strategy.getMetrics();
      const estimatedAPY = metrics.estimatedAPY as number;

      // 0.05% * 3 * 365 = 54.75% simple APY
      expect(estimatedAPY).toBeGreaterThan(50);
      expect(estimatedAPY).toBeLessThan(60);
    });
  });
});
