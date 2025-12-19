import { ExchangeType } from '../value-objects/ExchangeConfig';
import { OrderSide } from '../value-objects/PerpOrder';

/**
 * PerpPosition entity - represents an open perpetual position
 */
export class PerpPosition {
  constructor(
    public readonly exchangeType: ExchangeType,
    public readonly symbol: string,
    public readonly side: OrderSide, // LONG or SHORT
    public readonly size: number, // Position size in base asset
    public readonly entryPrice: number, // Average entry price
    public readonly markPrice: number, // Current mark price
    public readonly unrealizedPnl: number, // Unrealized profit/loss in USD
    public readonly leverage?: number, // Leverage used
    public readonly liquidationPrice?: number, // Estimated liquidation price
    public readonly marginUsed?: number, // Margin used in USD
    public readonly timestamp?: Date, // Position opened timestamp
    public readonly lastUpdated?: Date, // Last update timestamp
    public readonly metadata?: Record<string, any>, // Additional metadata
  ) {
    // Validation
    if (size <= 0) {
      throw new Error('Position size must be greater than 0');
    }

    if (entryPrice <= 0) {
      throw new Error('Entry price must be greater than 0');
    }

    if (markPrice <= 0) {
      throw new Error('Mark price must be greater than 0');
    }

    if (leverage !== undefined && leverage < 1) {
      throw new Error('Leverage must be at least 1');
    }
  }

  /**
   * Returns true if this is a long position
   */
  isLong(): boolean {
    return this.side === OrderSide.LONG;
  }

  /**
   * Returns true if this is a short position
   */
  isShort(): boolean {
    return this.side === OrderSide.SHORT;
  }

  /**
   * Returns the position value in USD (size * markPrice)
   */
  getPositionValue(): number {
    return this.size * this.markPrice;
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
   * Returns the notional value of the position
   */
  getNotionalValue(): number {
    return this.getPositionValue();
  }

  /**
   * Creates a new position with updated mark price and PnL
   */
  updateMarkPrice(
    newMarkPrice: number,
    newUnrealizedPnl: number,
  ): PerpPosition {
    return new PerpPosition(
      this.exchangeType,
      this.symbol,
      this.side,
      this.size,
      this.entryPrice,
      newMarkPrice,
      newUnrealizedPnl,
      this.leverage,
      this.liquidationPrice,
      this.marginUsed,
      this.timestamp,
      new Date(),
    );
  }
}
