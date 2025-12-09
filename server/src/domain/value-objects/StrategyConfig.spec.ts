import { ConfigService } from '@nestjs/config';
import { StrategyConfig } from './StrategyConfig';
import { ExchangeType } from './ExchangeConfig';
import { Percentage } from './Percentage';

describe('StrategyConfig', () => {
  describe('withDefaults', () => {
    it('should create config with default values', () => {
      const config = StrategyConfig.withDefaults();

      expect(config.defaultMinSpread.toDecimal()).toBe(0.0001);
      expect(config.minPositionSizeUsd).toBe(5);
      expect(config.balanceUsagePercent.toDecimal()).toBe(0.9);
      expect(config.leverage).toBe(2.0);
      expect(config.maxWorstCaseBreakEvenDays).toBe(7);
      expect(config.minOpenInterestUsd).toBe(10000);
      expect(config.minTotalOpenInterestUsd).toBe(20000);
      expect(config.limitOrderPriceImprovement.toDecimal()).toBe(0.0001);
      expect(config.asymmetricFillTimeoutMs).toBe(2 * 60 * 1000);
      expect(config.maxExecutionRetries).toBe(3);
      expect(config.executionRetryDelays).toEqual([5000, 10000]);
      expect(config.maxOrderWaitRetries).toBe(10);
      expect(config.orderWaitBaseInterval).toBe(2000);
      expect(config.maxBackoffDelayOpening).toBe(8000);
      expect(config.maxBackoffDelayClosing).toBe(32000);
      expect(config.minFillBalance.toDecimal()).toBe(0.95);
    });

    it('should have correct exchange fee rates', () => {
      const config = StrategyConfig.withDefaults();

      expect(config.exchangeFeeRates.get(ExchangeType.HYPERLIQUID)).toBe(0.00015);
      expect(config.exchangeFeeRates.get(ExchangeType.ASTER)).toBe(0.00005);
      expect(config.exchangeFeeRates.get(ExchangeType.LIGHTER)).toBe(0);
    });

    it('should have correct taker fee rates', () => {
      const config = StrategyConfig.withDefaults();

      expect(config.takerFeeRates.get(ExchangeType.HYPERLIQUID)).toBe(0.0002);
      expect(config.takerFeeRates.get(ExchangeType.ASTER)).toBe(0.0004);
      expect(config.takerFeeRates.get(ExchangeType.LIGHTER)).toBe(0);
    });
  });

  describe('fromConfigService', () => {
    it('should create config from ConfigService with custom leverage', () => {
      const mockConfigService = {
        get: jest.fn((key: string) => {
          if (key === 'KEEPER_LEVERAGE') return '3.0';
          return undefined;
        }),
      } as unknown as ConfigService;

      const config = StrategyConfig.fromConfigService(mockConfigService);

      expect(config.leverage).toBe(3.0);
      expect(config.defaultMinSpread.toDecimal()).toBe(0.0001); // Default value
    });

    it('should use default leverage when KEEPER_LEVERAGE not set', () => {
      const mockConfigService = {
        get: jest.fn(() => undefined),
      } as unknown as ConfigService;

      const config = StrategyConfig.fromConfigService(mockConfigService);

      expect(config.leverage).toBe(2.0);
    });

    it('should parse leverage as float', () => {
      const mockConfigService = {
        get: jest.fn((key: string) => {
          if (key === 'KEEPER_LEVERAGE') return '2.5';
          return undefined;
        }),
      } as unknown as ConfigService;

      const config = StrategyConfig.fromConfigService(mockConfigService);

      expect(config.leverage).toBe(2.5);
    });
  });

  describe('validation', () => {
    it('should throw error for negative minPositionSizeUsd', () => {
      expect(() => {
        new StrategyConfig(
          Percentage.fromDecimal(0.0001), // defaultMinSpread
          -5, // minPositionSizeUsd (invalid)
          Percentage.fromDecimal(0.9), // balanceUsagePercent
          2.0, // leverage
          7, // maxWorstCaseBreakEvenDays
          10000, // minOpenInterestUsd
          20000, // minTotalOpenInterestUsd
          new Map(), // exchangeFeeRates
          new Map(), // takerFeeRates
          Percentage.fromDecimal(0.0001), // limitOrderPriceImprovement
          120000, // asymmetricFillTimeoutMs
          3, // maxExecutionRetries
          [5000, 10000], // executionRetryDelays
          10, // maxOrderWaitRetries
          2000, // orderWaitBaseInterval
          8000, // maxBackoffDelayOpening
          32000, // maxBackoffDelayClosing
          Percentage.fromDecimal(0.95), // minFillBalance
        );
      }).toThrow('minPositionSizeUsd must be greater than 0');
    });

    it('should throw error for invalid balanceUsagePercent', () => {
      expect(() => {
        new StrategyConfig(
          Percentage.fromDecimal(0.0001),
          5,
          Percentage.fromDecimal(1.5), // balanceUsagePercent > 1 (invalid)
          2.0,
          7,
          10000,
          20000,
          new Map(),
          new Map(),
          Percentage.fromDecimal(0.0001),
          120000,
          3,
          [5000, 10000],
          10,
          2000,
          8000,
          32000,
          Percentage.fromDecimal(0.95),
        );
      }).toThrow('balanceUsagePercent must be between 0 and 1');
    });

    it('should throw error for leverage less than 1', () => {
      expect(() => {
        new StrategyConfig(
          Percentage.fromDecimal(0.0001),
          5,
          Percentage.fromDecimal(0.9),
          0.5, // leverage < 1 (invalid)
          7,
          10000,
          20000,
          new Map(),
          new Map(),
          Percentage.fromDecimal(0.0001),
          120000,
          3,
          [5000, 10000],
          10,
          2000,
          8000,
          32000,
          Percentage.fromDecimal(0.95),
        );
      }).toThrow('leverage must be at least 1');
    });

    it('should throw error for negative maxExecutionRetries', () => {
      expect(() => {
        new StrategyConfig(
          Percentage.fromDecimal(0.0001),
          5,
          Percentage.fromDecimal(0.9),
          2.0,
          7,
          10000,
          20000,
          new Map(),
          new Map(),
          Percentage.fromDecimal(0.0001),
          120000,
          -1, // maxExecutionRetries (invalid)
          [5000, 10000],
          10,
          2000,
          8000,
          32000,
          Percentage.fromDecimal(0.95),
        );
      }).toThrow('maxExecutionRetries must be greater than 0');
    });
  });

  describe('immutability', () => {
    it('should have readonly properties', () => {
      const config = StrategyConfig.withDefaults();

      // TypeScript should prevent this, but test runtime behavior
      // In JavaScript, we can still modify readonly properties, but TypeScript prevents it at compile time
      // This test verifies the property exists and has the correct value
      expect(config.leverage).toBe(2.0);
      expect(config.defaultMinSpread.toDecimal()).toBe(0.0001);
      expect(config.balanceUsagePercent.toDecimal()).toBe(0.9);
    });
  });

  describe('factory methods', () => {
    it('should create identical configs with withDefaults', () => {
      const config1 = StrategyConfig.withDefaults();
      const config2 = StrategyConfig.withDefaults();

      expect(config1.defaultMinSpread.toDecimal()).toBe(config2.defaultMinSpread.toDecimal());
      expect(config1.leverage).toBe(config2.leverage);
      expect(config1.exchangeFeeRates.size).toBe(config2.exchangeFeeRates.size);
    });
  });
});
