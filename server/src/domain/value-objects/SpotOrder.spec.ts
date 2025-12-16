import { SpotOrderRequest, SpotOrderResponse } from './SpotOrder';
import { OrderSide, OrderType, OrderStatus, TimeInForce } from './PerpOrder';

describe('SpotOrderRequest', () => {
  it('should create a valid market order request', () => {
    const request = new SpotOrderRequest(
      'ETH',
      OrderSide.LONG,
      OrderType.MARKET,
      1.5,
    );

    expect(request.symbol).toBe('ETH');
    expect(request.side).toBe(OrderSide.LONG);
    expect(request.type).toBe(OrderType.MARKET);
    expect(request.size).toBe(1.5);
    expect(request.isMarketOrder()).toBe(true);
    expect(request.isBuy()).toBe(true);
  });

  it('should create a valid limit order request', () => {
    const request = new SpotOrderRequest(
      'BTC',
      OrderSide.SHORT,
      OrderType.LIMIT,
      0.5,
      50000,
      TimeInForce.GTC,
    );

    expect(request.symbol).toBe('BTC');
    expect(request.side).toBe(OrderSide.SHORT);
    expect(request.type).toBe(OrderType.LIMIT);
    expect(request.size).toBe(0.5);
    expect(request.price).toBe(50000);
    expect(request.timeInForce).toBe(TimeInForce.GTC);
    expect(request.isLimitOrder()).toBe(true);
    expect(request.isSell()).toBe(true);
  });

  it('should throw error for invalid size', () => {
    expect(() => {
      new SpotOrderRequest('ETH', OrderSide.LONG, OrderType.MARKET, 0);
    }).toThrow('Order size must be greater than 0');
  });

  it('should throw error for limit order without price', () => {
    expect(() => {
      new SpotOrderRequest('ETH', OrderSide.LONG, OrderType.LIMIT, 1);
    }).toThrow('Limit price is required for LIMIT orders');
  });
});

describe('SpotOrderResponse', () => {
  it('should create a valid order response', () => {
    const response = new SpotOrderResponse(
      'order-123',
      'ETH',
      OrderSide.LONG,
      OrderStatus.FILLED,
      1.5,
      3000,
    );

    expect(response.orderId).toBe('order-123');
    expect(response.symbol).toBe('ETH');
    expect(response.side).toBe(OrderSide.LONG);
    expect(response.status).toBe(OrderStatus.FILLED);
    expect(response.filledSize).toBe(1.5);
    expect(response.averagePrice).toBe(3000);
    expect(response.isFilled()).toBe(true);
  });

  it('should handle partially filled order', () => {
    const response = new SpotOrderResponse(
      'order-456',
      'BTC',
      OrderSide.SHORT,
      OrderStatus.PARTIALLY_FILLED,
      0.3,
      50000,
    );

    expect(response.isPartiallyFilled()).toBe(true);
    expect(response.isPending()).toBe(false);
  });

  it('should handle pending order', () => {
    const response = new SpotOrderResponse(
      'order-789',
      'ETH',
      OrderSide.LONG,
      OrderStatus.SUBMITTED,
      0,
    );

    expect(response.isPending()).toBe(true);
    expect(response.isFilled()).toBe(false);
  });

  it('should throw error for negative filled size', () => {
    expect(() => {
      new SpotOrderResponse(
        'order-123',
        'ETH',
        OrderSide.LONG,
        OrderStatus.FILLED,
        -1,
      );
    }).toThrow('Filled size cannot be negative');
  });
});

