import { SimulationMarketDataProvider } from './SimulationMarketDataProvider';
import { Candle } from '../../domain/entities/Candle';

describe('SimulationMarketDataProvider', () => {
  let provider: SimulationMarketDataProvider;

  beforeEach(() => {
    provider = new SimulationMarketDataProvider();
  });

  describe('getPoolFeeTier', () => {
    it('should return 0.05% fee tier as default', async () => {
      const feeTier = await provider.getPoolFeeTier('0xTestPool');
      expect(feeTier).toBe(0.0005);
    });

    it('should return same value for any pool address', async () => {
      const feeTier1 = await provider.getPoolFeeTier('0xPool1');
      const feeTier2 = await provider.getPoolFeeTier('0xPool2');
      
      expect(feeTier1).toBe(feeTier2);
      expect(feeTier1).toBe(0.0005);
    });
  });

  describe('getPoolFeeApr', () => {
    it('should return mock APR of 30%', async () => {
      const apr = await provider.getPoolFeeApr('0xTestPool');
      expect(apr).toBe(30.0);
    });
  });

  describe('getHistory', () => {
    it('should return candles based on current index', async () => {
      const candles: Candle[] = [
        new Candle(new Date('2025-01-01'), 100, 110, 90, 105, 1000),
        new Candle(new Date('2025-01-02'), 105, 115, 95, 110, 1100),
        new Candle(new Date('2025-01-03'), 110, 120, 100, 115, 1200),
      ];

      provider.loadData(candles);
      provider.setCurrentIndex(2);

      const history = await provider.getHistory('0xTestPool', 2);
      expect(history).toHaveLength(3); // Current index + 2 hours back
      expect(history[0]).toBe(candles[0]);
      expect(history[2]).toBe(candles[2]);
    });
  });

  describe('getLatestCandle', () => {
    it('should return candle at current index', async () => {
      const candles: Candle[] = [
        new Candle(new Date('2025-01-01'), 100, 110, 90, 105, 1000),
        new Candle(new Date('2025-01-02'), 105, 115, 95, 110, 1100),
      ];

      provider.loadData(candles);
      provider.setCurrentIndex(1);

      const latest = await provider.getLatestCandle('0xTestPool');
      expect(latest).toBe(candles[1]);
    });
  });
});










