import { PositionSize } from './PositionSize';

describe('PositionSize', () => {
  describe('fromBaseAsset', () => {
    it('should create from base asset size', () => {
      const size = PositionSize.fromBaseAsset(1.5);
      expect(size.toBaseAsset()).toBe(1.5);
    });

    it('should throw error for zero size', () => {
      expect(() => {
        PositionSize.fromBaseAsset(0);
      }).toThrow('Position size must be greater than 0');
    });

    it('should throw error for negative size', () => {
      expect(() => {
        PositionSize.fromBaseAsset(-1);
      }).toThrow('Position size must be greater than 0');
    });

    it('should apply leverage', () => {
      const size = PositionSize.fromBaseAsset(1.0, 2.0);
      expect(size.toBaseAsset()).toBe(1.0);
      expect(size.getLeverage()).toBe(2.0);
    });
  });

  describe('fromUsd', () => {
    it('should create from USD value', () => {
      const size = PositionSize.fromUsd(3000, 3000, 1);
      expect(size.toBaseAsset()).toBe(1.0);
    });

    it('should convert USD to base asset', () => {
      const size = PositionSize.fromUsd(6000, 3000, 1);
      expect(size.toBaseAsset()).toBe(2.0);
    });

    it('should apply leverage', () => {
      const size = PositionSize.fromUsd(3000, 3000, 2.0);
      expect(size.getLeverage()).toBe(2.0);
    });
  });

  describe('toUSD', () => {
    it('should convert base asset to USD', () => {
      const size = PositionSize.fromBaseAsset(1.0);
      const usd = size.toUSD(3000);
      expect(usd).toBe(3000);
    });

    it('should account for leverage', () => {
      const size = PositionSize.fromBaseAsset(1.0, 2.0);
      const usd = size.toUSD(3000);
      expect(usd).toBe(3000); // USD value doesn't change with leverage
    });
  });

  describe('applyLeverage', () => {
    it('should apply leverage', () => {
      const size = PositionSize.fromBaseAsset(1.0);
      const leveraged = size.applyLeverage(2.0);
      expect(leveraged.getLeverage()).toBe(2.0);
      expect(leveraged.toBaseAsset()).toBe(1.0); // Base asset size unchanged
    });

    it('should throw error for leverage < 1', () => {
      const size = PositionSize.fromBaseAsset(1.0);
      expect(() => {
        size.applyLeverage(0.5);
      }).toThrow('Leverage must be at least 1');
    });
  });

  describe('removeLeverage', () => {
    it('should remove leverage', () => {
      const size = PositionSize.fromBaseAsset(1.0, 2.0);
      const unleveraged = size.removeLeverage();
      expect(unleveraged.getLeverage()).toBe(1.0);
      expect(unleveraged.toBaseAsset()).toBe(1.0);
    });
  });

  describe('arithmetic operations', () => {
    it('should add position sizes', () => {
      const size1 = PositionSize.fromBaseAsset(1.0);
      const size2 = PositionSize.fromBaseAsset(2.0);
      const result = size1.add(size2);
      expect(result.toBaseAsset()).toBe(3.0);
    });

    it('should subtract position sizes', () => {
      const size1 = PositionSize.fromBaseAsset(3.0);
      const size2 = PositionSize.fromBaseAsset(1.0);
      const result = size1.subtract(size2);
      expect(result.toBaseAsset()).toBe(2.0);
    });

    it('should throw error when subtracting larger size', () => {
      const size1 = PositionSize.fromBaseAsset(1.0);
      const size2 = PositionSize.fromBaseAsset(2.0);
      expect(() => {
        size1.subtract(size2);
      }).toThrow('Resulting position size must be greater than 0');
    });
  });

  describe('comparison operations', () => {
    it('should check equality', () => {
      const size1 = PositionSize.fromBaseAsset(1.0);
      const size2 = PositionSize.fromBaseAsset(1.0);
      const size3 = PositionSize.fromBaseAsset(2.0);
      expect(size1.equals(size2)).toBe(true);
      expect(size1.equals(size3)).toBe(false);
    });

    it('should check greater than', () => {
      const size1 = PositionSize.fromBaseAsset(2.0);
      const size2 = PositionSize.fromBaseAsset(1.0);
      expect(size1.greaterThan(size2)).toBe(true);
      expect(size2.greaterThan(size1)).toBe(false);
    });

    it('should check less than', () => {
      const size1 = PositionSize.fromBaseAsset(1.0);
      const size2 = PositionSize.fromBaseAsset(2.0);
      expect(size1.lessThan(size2)).toBe(true);
      expect(size2.lessThan(size1)).toBe(false);
    });
  });

  describe('immutability', () => {
    it('should create new instances for arithmetic operations', () => {
      const size1 = PositionSize.fromBaseAsset(1.0);
      const size2 = PositionSize.fromBaseAsset(2.0);
      const result = size1.add(size2);
      expect(size1.toBaseAsset()).toBe(1.0); // Original unchanged
      expect(result.toBaseAsset()).toBe(3.0); // New instance
    });
  });
});
