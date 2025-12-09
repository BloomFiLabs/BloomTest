import { Percentage } from './Percentage';

describe('Percentage', () => {
  describe('fromDecimal', () => {
    it('should create from decimal value', () => {
      const pct = Percentage.fromDecimal(0.0001);
      expect(pct.toDecimal()).toBe(0.0001);
    });

    it('should handle negative values (for funding rates)', () => {
      const pct = Percentage.fromDecimal(-0.0001);
      expect(pct.toDecimal()).toBe(-0.0001);
    });

    it('should handle values greater than 1 (for APY > 100%)', () => {
      const pct = Percentage.fromDecimal(1.5);
      expect(pct.toDecimal()).toBe(1.5);
    });
  });

  describe('fromPercent', () => {
    it('should create from percent value', () => {
      const pct = Percentage.fromPercent(1);
      expect(pct.toDecimal()).toBe(0.01);
    });

    it('should convert percent to decimal', () => {
      const pct = Percentage.fromPercent(0.01);
      expect(pct.toDecimal()).toBe(0.0001);
    });

    it('should handle 100%', () => {
      const pct = Percentage.fromPercent(100);
      expect(pct.toDecimal()).toBe(1);
    });
  });

  describe('fromAPY', () => {
    it('should create from APY value', () => {
      const pct = Percentage.fromAPY(0.35);
      expect(pct.toAPY()).toBe(0.35);
    });

    it('should handle APY > 100%', () => {
      const pct = Percentage.fromAPY(1.5);
      expect(pct.toAPY()).toBe(1.5);
    });
  });

  describe('toDecimal', () => {
    it('should return decimal value', () => {
      const pct = Percentage.fromDecimal(0.0001);
      expect(pct.toDecimal()).toBe(0.0001);
    });
  });

  describe('toPercent', () => {
    it('should return percent value', () => {
      const pct = Percentage.fromDecimal(0.01);
      expect(pct.toPercent()).toBe(1);
    });

    it('should convert decimal to percent', () => {
      const pct = Percentage.fromDecimal(0.0001);
      expect(pct.toPercent()).toBe(0.01);
    });
  });

  describe('toAPY', () => {
    it('should return APY value', () => {
      const pct = Percentage.fromDecimal(0.35);
      expect(pct.toAPY()).toBe(0.35);
    });
  });

  describe('arithmetic operations', () => {
    it('should add percentages', () => {
      const pct1 = Percentage.fromDecimal(0.1);
      const pct2 = Percentage.fromDecimal(0.2);
      const result = pct1.add(pct2);
      expect(result.toDecimal()).toBeCloseTo(0.3, 10);
    });

    it('should subtract percentages', () => {
      const pct1 = Percentage.fromDecimal(0.3);
      const pct2 = Percentage.fromDecimal(0.1);
      const result = pct1.subtract(pct2);
      expect(result.toDecimal()).toBeCloseTo(0.2, 10);
    });

    it('should multiply by factor', () => {
      const pct = Percentage.fromDecimal(0.1);
      const result = pct.multiply(2);
      expect(result.toDecimal()).toBe(0.2);
    });

    it('should divide by divisor', () => {
      const pct = Percentage.fromDecimal(0.2);
      const result = pct.divide(2);
      expect(result.toDecimal()).toBe(0.1);
    });

    it('should handle negative results', () => {
      const pct1 = Percentage.fromDecimal(0.1);
      const pct2 = Percentage.fromDecimal(0.2);
      const result = pct1.subtract(pct2);
      expect(result.toDecimal()).toBe(-0.1);
    });
  });

  describe('comparison operations', () => {
    it('should check equality', () => {
      const pct1 = Percentage.fromDecimal(0.1);
      const pct2 = Percentage.fromDecimal(0.1);
      const pct3 = Percentage.fromDecimal(0.2);
      expect(pct1.equals(pct2)).toBe(true);
      expect(pct1.equals(pct3)).toBe(false);
    });

    it('should check greater than', () => {
      const pct1 = Percentage.fromDecimal(0.2);
      const pct2 = Percentage.fromDecimal(0.1);
      expect(pct1.greaterThan(pct2)).toBe(true);
      expect(pct2.greaterThan(pct1)).toBe(false);
    });

    it('should check less than', () => {
      const pct1 = Percentage.fromDecimal(0.1);
      const pct2 = Percentage.fromDecimal(0.2);
      expect(pct1.lessThan(pct2)).toBe(true);
      expect(pct2.lessThan(pct1)).toBe(false);
    });

    it('should handle equality edge cases', () => {
      const pct1 = Percentage.fromDecimal(0.1);
      const pct2 = Percentage.fromDecimal(0.1);
      expect(pct1.greaterThan(pct2)).toBe(false);
      expect(pct1.lessThan(pct2)).toBe(false);
    });
  });

  describe('immutability', () => {
    it('should create new instances for arithmetic operations', () => {
      const pct1 = Percentage.fromDecimal(0.1);
      const pct2 = Percentage.fromDecimal(0.2);
      const result = pct1.add(pct2);
      expect(pct1.toDecimal()).toBe(0.1); // Original unchanged
      expect(result.toDecimal()).toBeCloseTo(0.3, 10); // New instance
    });
  });
});
