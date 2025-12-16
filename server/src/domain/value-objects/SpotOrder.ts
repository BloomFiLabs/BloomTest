import { OrderSide, OrderType, OrderStatus, TimeInForce } from './PerpOrder';

/**
 * SpotOrderRequest - Value object for spot order requests
 * Spot trading is 1:1 (no leverage)
 */
export class SpotOrderRequest {
  constructor(
    public readonly symbol: string,
    public readonly side: OrderSide,
    public readonly type: OrderType,
    public readonly size: number, // Base asset amount (1:1, no leverage)
    public readonly price?: number, // Required for LIMIT orders
    public readonly timeInForce?: TimeInForce, // Required for LIMIT orders
    public readonly clientOrderId?: string, // Optional client-provided order ID
  ) {
    // Validation
    if (size <= 0) {
      throw new Error('Order size must be greater than 0');
    }

    if (type === OrderType.LIMIT && !price) {
      throw new Error('Limit price is required for LIMIT orders');
    }
  }

  /**
   * Returns true if this is a market order
   */
  isMarketOrder(): boolean {
    return this.type === OrderType.MARKET;
  }

  /**
   * Returns true if this is a limit order
   */
  isLimitOrder(): boolean {
    return this.type === OrderType.LIMIT;
  }

  /**
   * Returns true if this is a buy order (LONG)
   */
  isBuy(): boolean {
    return this.side === OrderSide.LONG;
  }

  /**
   * Returns true if this is a sell order (SHORT)
   */
  isSell(): boolean {
    return this.side === OrderSide.SHORT;
  }
}

/**
 * SpotOrderResponse - Value object for spot order responses
 */
export class SpotOrderResponse {
  constructor(
    public readonly orderId: string,
    public readonly symbol: string,
    public readonly side: OrderSide,
    public readonly status: OrderStatus,
    public readonly filledSize: number, // Amount filled in base asset
    public readonly averagePrice?: number, // Average fill price
    public readonly timestamp: Date = new Date(),
    public readonly clientOrderId?: string,
  ) {
    // Validation
    if (filledSize < 0) {
      throw new Error('Filled size cannot be negative');
    }

    if (averagePrice !== undefined && averagePrice <= 0) {
      throw new Error('Average price must be greater than 0 if provided');
    }
  }

  /**
   * Returns true if the order is fully filled
   */
  isFilled(): boolean {
    return this.status === OrderStatus.FILLED;
  }

  /**
   * Returns true if the order is partially filled
   */
  isPartiallyFilled(): boolean {
    return this.status === OrderStatus.PARTIALLY_FILLED;
  }

  /**
   * Returns true if the order is still pending
   */
  isPending(): boolean {
    return this.status === OrderStatus.PENDING || this.status === OrderStatus.SUBMITTED;
  }

  /**
   * Returns true if the order is cancelled or rejected
   */
  isCancelledOrRejected(): boolean {
    return (
      this.status === OrderStatus.CANCELLED ||
      this.status === OrderStatus.REJECTED ||
      this.status === OrderStatus.EXPIRED
    );
  }
}





