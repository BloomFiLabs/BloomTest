/**
 * Percentage value object
 * Represents percentage values with conversions and arithmetic operations
 */
export class Percentage {
  private constructor(private readonly value: number) {}

  /**
   * Create from decimal value (e.g., 0.0001 = 0.01%)
   */
  static fromDecimal(decimal: number): Percentage {
    return new Percentage(decimal);
  }

  /**
   * Create from percent value (e.g., 1 = 1%)
   */
  static fromPercent(percent: number): Percentage {
    return new Percentage(percent / 100);
  }

  /**
   * Create from APY value (e.g., 0.35 = 35% APY)
   */
  static fromAPY(apy: number): Percentage {
    return new Percentage(apy);
  }

  /**
   * Convert to decimal (e.g., 0.01 = 0.01)
   */
  toDecimal(): number {
    return this.value;
  }

  /**
   * Convert to percent (e.g., 0.01 = 1%)
   */
  toPercent(): number {
    return this.value * 100;
  }

  /**
   * Convert to APY (e.g., 0.35 = 35% APY)
   */
  toAPY(): number {
    return this.value;
  }

  /**
   * Add another percentage
   */
  add(other: Percentage): Percentage {
    return new Percentage(this.value + other.value);
  }

  /**
   * Subtract another percentage
   */
  subtract(other: Percentage): Percentage {
    return new Percentage(this.value - other.value);
  }

  /**
   * Multiply by a factor
   */
  multiply(factor: number): Percentage {
    return new Percentage(this.value * factor);
  }

  /**
   * Divide by a divisor
   */
  divide(divisor: number): Percentage {
    if (divisor === 0) {
      throw new Error('Cannot divide by zero');
    }
    return new Percentage(this.value / divisor);
  }

  /**
   * Check equality
   */
  equals(other: Percentage): boolean {
    return this.value === other.value;
  }

  /**
   * Check if greater than
   */
  greaterThan(other: Percentage): boolean {
    return this.value > other.value;
  }

  /**
   * Check if less than
   */
  lessThan(other: Percentage): boolean {
    return this.value < other.value;
  }
}
