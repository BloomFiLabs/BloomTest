import { SpotPosition } from './SpotPosition';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { OrderSide } from '../value-objects/PerpOrder';

describe('SpotPosition', () => {
  it('should create a valid long position', () => {
    const position = new SpotPosition(
      ExchangeType.HYPERLIQUID,
      'ETH',
      OrderSide.LONG,
      2.5,
      3000,
      3100,
      250, // PnL = (3100 - 3000) * 2.5 = 250
    );

    expect(position.exchangeType).toBe(ExchangeType.HYPERLIQUID);
    expect(position.symbol).toBe('ETH');
    expect(position.side).toBe(OrderSide.LONG);
    expect(position.size).toBe(2.5);
    expect(position.entryPrice).toBe(3000);
    expect(position.currentPrice).toBe(3100);
    expect(position.unrealizedPnl).toBe(250);
    expect(position.isLong()).toBe(true);
    expect(position.isShort()).toBe(false);
    expect(position.isProfitable()).toBe(true);
  });

  it('should calculate position value correctly', () => {
    const position = new SpotPosition(
      ExchangeType.ASTER,
      'BTC',
      OrderSide.LONG,
      1.0,
      50000,
      51000,
      1000,
    );

    expect(position.getPositionValue()).toBe(51000); // 1.0 * 51000
  });

  it('should calculate unrealized PnL percentage', () => {
    const position = new SpotPosition(
      ExchangeType.HYPERLIQUID,
      'ETH',
      OrderSide.LONG,
      2.0,
      3000,
      3150,
      300, // (3150 - 3000) * 2.0 = 300
    );

    const pnlPercent = position.getUnrealizedPnlPercent();
    expect(pnlPercent).toBeCloseTo(5.0, 1); // 300 / (2.0 * 3000) * 100 = 5%
  });

  it('should update position with new price', () => {
    const position = new SpotPosition(
      ExchangeType.HYPERLIQUID,
      'ETH',
      OrderSide.LONG,
      2.0,
      3000,
      3100,
      200,
    );

    const updated = position.updateCurrentPrice(3200, 400);
    expect(updated.currentPrice).toBe(3200);
    expect(updated.unrealizedPnl).toBe(400);
    expect(updated.lastUpdated).toBeDefined();
  });

  it('should throw error for invalid size', () => {
    expect(() => {
      new SpotPosition(
        ExchangeType.HYPERLIQUID,
        'ETH',
        OrderSide.LONG,
        0,
        3000,
        3100,
        0,
      );
    }).toThrow('Position size must be greater than 0');
  });

  it('should throw error for invalid prices', () => {
    expect(() => {
      new SpotPosition(
        ExchangeType.HYPERLIQUID,
        'ETH',
        OrderSide.LONG,
        1.0,
        0,
        3100,
        0,
      );
    }).toThrow('Entry price must be greater than 0');
  });
});

