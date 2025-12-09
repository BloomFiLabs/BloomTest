/**
 * PositionSize value object
 * Represents position size in base asset with optional leverage
 */
export class PositionSize {
  private constructor(
    private readonly baseAssetSize: number,
    private readonly leverage: number = 1,
  ) {
    if (baseAssetSize <= 0) {
      throw new Error('Position size must be greater than 0');
    }
    if (leverage < 1) {
      throw new Error('Leverage must be at least 1');
    }
  }

  /**
   * Create from base asset size
   */
  static fromBaseAsset(size: number, leverage: number = 1): PositionSize {
    return new PositionSize(size, leverage);
  }

  /**
   * Create from USD value
   */
  static fromUsd(
    usdValue: number,
    markPrice: number,
    leverage: number = 1,
  ): PositionSize {
    const baseAssetSize = usdValue / markPrice;
    return new PositionSize(baseAssetSize, leverage);
  }

  /**
   * Convert to USD value
   */
  toUSD(markPrice: number): number {
    return this.baseAssetSize * markPrice;
  }

  /**
   * Get base asset size
   */
  toBaseAsset(): number {
    return this.baseAssetSize;
  }

  /**
   * Get leverage
   */
  getLeverage(): number {
    return this.leverage;
  }

  /**
   * Apply leverage
   */
  applyLeverage(leverage: number): PositionSize {
    if (leverage < 1) {
      throw new Error('Leverage must be at least 1');
    }
    return new PositionSize(this.baseAssetSize, leverage);
  }

  /**
   * Remove leverage (set to 1)
   */
  removeLeverage(): PositionSize {
    return new PositionSize(this.baseAssetSize, 1);
  }

  /**
   * Add another position size
   */
  add(other: PositionSize): PositionSize {
    return new PositionSize(
      this.baseAssetSize + other.baseAssetSize,
      Math.max(this.leverage, other.leverage), // Use max leverage
    );
  }

  /**
   * Subtract another position size
   */
  subtract(other: PositionSize): PositionSize {
    const result = this.baseAssetSize - other.baseAssetSize;
    if (result <= 0) {
      throw new Error('Resulting position size must be greater than 0');
    }
    return new PositionSize(result, this.leverage);
  }

  /**
   * Check if equal to another position size
   */
  equals(other: PositionSize): boolean {
    return (
      Math.abs(this.baseAssetSize - other.baseAssetSize) < 1e-10 &&
      this.leverage === other.leverage
    );
  }

  /**
   * Check if greater than another position size
   */
  greaterThan(other: PositionSize): boolean {
    return this.baseAssetSize > other.baseAssetSize;
  }

  /**
   * Check if less than another position size
   */
  lessThan(other: PositionSize): boolean {
    return this.baseAssetSize < other.baseAssetSize;
  }
}
