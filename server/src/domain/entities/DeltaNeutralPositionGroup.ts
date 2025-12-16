import { PerpPosition } from './PerpPosition';
import { SpotPosition } from './SpotPosition';
import { Percentage } from '../value-objects/Percentage';
import { OrderSide } from '../value-objects/PerpOrder';

/**
 * DeltaNeutralPositionGroup - Entity to track paired perp+spot positions
 *
 * Tracks a delta-neutral position pair where:
 * - Perp and spot positions are on the same exchange
 * - Perp size ≈ Spot size (for delta neutrality)
 * - Opposite sides: Long perp + Short spot OR Short perp + Long spot
 */
export class DeltaNeutralPositionGroup {
  constructor(
    public readonly symbol: string,
    public readonly exchangeType: string,
    public readonly perpPosition: PerpPosition,
    public readonly spotPosition: SpotPosition,
    public readonly tolerance: Percentage = Percentage.fromDecimal(0.01), // 1% tolerance
  ) {
    // Validation: positions must be on the same exchange
    if (perpPosition.exchangeType !== spotPosition.exchangeType) {
      throw new Error(
        `Perp and spot positions must be on the same exchange. ` +
          `Got: perp=${perpPosition.exchangeType}, spot=${spotPosition.exchangeType}`,
      );
    }

    // Validation: positions must be for the same symbol
    if (perpPosition.symbol !== spotPosition.symbol) {
      throw new Error(
        `Perp and spot positions must be for the same symbol. ` +
          `Got: perp=${perpPosition.symbol}, spot=${spotPosition.symbol}`,
      );
    }
  }

  /**
   * Validates delta neutrality
   * Returns true if |perpSize - spotSize| / spotSize < tolerance
   */
  validateDeltaNeutrality(): boolean {
    const perpSize = Math.abs(this.perpPosition.size);
    const spotSize = Math.abs(this.spotPosition.size);

    if (spotSize === 0) {
      return false; // Cannot be delta neutral with zero spot size
    }

    const deltaDrift = Math.abs(perpSize - spotSize) / spotSize;
    const toleranceDecimal = this.tolerance.toDecimal();

    return deltaDrift < toleranceDecimal;
  }

  /**
   * Calculates net delta
   * Returns the difference between perp size and spot size
   * Should be close to 0 for delta neutrality
   */
  calculateNetDelta(): number {
    const perpSize =
      this.perpPosition.side === OrderSide.LONG
        ? this.perpPosition.size
        : -this.perpPosition.size;
    const spotSize =
      this.spotPosition.side === OrderSide.LONG
        ? this.spotPosition.size
        : -this.spotPosition.size;
    return perpSize + spotSize; // Should be ~0 for delta neutral
  }

  /**
   * Gets the total value of both positions in USD
   */
  getTotalValue(): number {
    return (
      this.perpPosition.getPositionValue() +
      this.spotPosition.getPositionValue()
    );
  }

  /**
   * Gets the combined unrealized PnL from both positions
   */
  getCombinedPnl(): number {
    return this.perpPosition.unrealizedPnl + this.spotPosition.unrealizedPnl;
  }

  /**
   * Gets the delta drift percentage
   * Returns the percentage difference between perp and spot sizes
   */
  getDeltaDriftPercent(): number {
    const perpSize = Math.abs(this.perpPosition.size);
    const spotSize = Math.abs(this.spotPosition.size);

    if (spotSize === 0) {
      return Infinity; // Invalid state
    }

    return (Math.abs(perpSize - spotSize) / spotSize) * 100;
  }

  /**
   * Returns true if the position group is profitable
   */
  isProfitable(): boolean {
    return this.getCombinedPnl() > 0;
  }

  /**
   * Returns true if the position group is at a loss
   */
  isAtLoss(): boolean {
    return this.getCombinedPnl() < 0;
  }

  /**
   * Creates a new group with updated positions
   */
  updatePositions(
    newPerpPosition: PerpPosition,
    newSpotPosition: SpotPosition,
  ): DeltaNeutralPositionGroup {
    return new DeltaNeutralPositionGroup(
      this.symbol,
      this.exchangeType,
      newPerpPosition,
      newSpotPosition,
      this.tolerance,
    );
  }
}
