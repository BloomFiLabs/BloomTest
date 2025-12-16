import { ExchangeType } from '../value-objects/ExchangeConfig';
import { OrderSide } from '../value-objects/PerpOrder';

/**
 * SpotPosition entity - represents a spot holding (not leveraged)
 */
export class SpotPosition {
  constructor(
    public readonly exchangeType: ExchangeType,
    public readonly symbol: string,
    public readonly side: OrderSide, // LONG = holding asset, SHORT = borrowed/sold (if supported)
    public readonly size: number, // Position size in base asset
    public readonly entryPrice: number, // Average entry price
    public readonly currentPrice: number, // Current spot price
    public readonly unrealizedPnl: number, // Unrealized profit/loss in USD
    public readonly timestamp?: Date, // Position opened timestamp
    public readonly lastUpdated?: Date, // Last update timestamp
  ) {
    // Validation
    if (size <= 0) {
      throw new Error('Position size must be greater than 0');
    }

    if (entryPrice <= 0) {
      throw new Error('Entry price must be greater than 0');
    }

    if (currentPrice <= 0) {
      throw new Error('Current price must be greater than 0');
    }
  }

  /**
   * Returns true if this is a long position (holding the asset)
   */
  isLong(): boolean {
    return this.side === OrderSide.LONG;
  }

  /**
   * Returns true if this is a short position (borrowed/sold, if supported)
   */
  isShort(): boolean {
    return this.side === OrderSide.SHORT;
  }

  /**
   * Returns the position value in USD (size * currentPrice)
   */
  getPositionValue(): number {
    return this.size * this.currentPrice;
  }

  /**
   * Returns the unrealized PnL as a percentage
   */
  getUnrealizedPnlPercent(): number {
    const entryValue = this.size * this.entryPrice;
    if (entryValue === 0) return 0;
    return (this.unrealizedPnl / entryValue) * 100;
  }

  /**
   * Returns true if the position is profitable
   */
  isProfitable(): boolean {
    return this.unrealizedPnl > 0;
  }

  /**
   * Returns true if the position is at a loss
   */
  isAtLoss(): boolean {
    return this.unrealizedPnl < 0;
  }

  /**
   * Creates a new position with updated current price and PnL
   */
  updateCurrentPrice(newCurrentPrice: number, newUnrealizedPnl: number): SpotPosition {
    return new SpotPosition(
      this.exchangeType,
      this.symbol,
      this.side,
      this.size,
      this.entryPrice,
      newCurrentPrice,
      newUnrealizedPnl,
      this.timestamp,
      new Date(),
    );
  }
}





