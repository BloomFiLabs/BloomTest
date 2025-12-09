import { ExchangeType } from '../value-objects/ExchangeConfig';
import { PerpPosition } from '../entities/PerpPosition';

/**
 * Interface for position loss tracking service
 * Domain port - infrastructure implements this
 */
export interface IPositionLossTracker {
  /**
   * Record a position entry (when opening a position)
   */
  recordPositionEntry(
    symbol: string,
    exchange: ExchangeType,
    entryCost: number,
    positionSizeUsd: number,
    timestamp?: Date,
  ): void;

  /**
   * Get remaining break-even hours for a position
   * @param position The position to analyze
   * @param currentFundingRate Current funding rate (per period, typically hourly)
   * @param positionValueUsd Optional position value, will use position.getPositionValue() if not provided
   * @returns Break-even data including remaining hours and required rate
   */
  getRemainingBreakEvenHours(
    position: PerpPosition,
    currentFundingRate: number,
    positionValueUsd?: number,
  ): {
    remainingBreakEvenHours: number;
    requiredFundingRate: number; // Required rate to break even
    currentRate: number;
    entryCost: number;
    positionValueUsd: number;
    feesEarnedSoFar: number;
    remainingCost: number;
    hoursHeld: number;
  };

  /**
   * Get cumulative loss across all positions
   * @returns Total cumulative loss (negative if loss, positive if profit)
   */
  getCumulativeLoss(): number;
}
