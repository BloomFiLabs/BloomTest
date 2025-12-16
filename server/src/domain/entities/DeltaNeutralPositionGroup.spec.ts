import { DeltaNeutralPositionGroup } from './DeltaNeutralPositionGroup';
import { PerpPosition } from './PerpPosition';
import { SpotPosition } from './SpotPosition';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { OrderSide } from '../value-objects/PerpOrder';
import { Percentage } from '../value-objects/Percentage';

describe('DeltaNeutralPositionGroup', () => {
  const createPerpPosition = (
    size: number,
    side: OrderSide,
    entryPrice: number = 3000,
    markPrice: number = 3000,
  ): PerpPosition => {
    return new PerpPosition(
      ExchangeType.HYPERLIQUID,
      'ETH',
      side,
      size,
      entryPrice,
      markPrice,
      0,
    );
  };

  const createSpotPosition = (
    size: number,
    side: OrderSide,
    entryPrice: number = 3000,
    currentPrice: number = 3000,
  ): SpotPosition => {
    return new SpotPosition(
      ExchangeType.HYPERLIQUID,
      'ETH',
      side,
      size,
      entryPrice,
      currentPrice,
      0,
    );
  };

  it('should create a valid delta-neutral position group', () => {
    const perpPosition = createPerpPosition(1.0, OrderSide.SHORT);
    const spotPosition = createSpotPosition(1.0, OrderSide.LONG);

    const group = new DeltaNeutralPositionGroup(
      'ETH',
      ExchangeType.HYPERLIQUID,
      perpPosition,
      spotPosition,
    );

    expect(group.symbol).toBe('ETH');
    expect(group.exchangeType).toBe(ExchangeType.HYPERLIQUID);
    expect(group.validateDeltaNeutrality()).toBe(true);
    expect(group.calculateNetDelta()).toBeCloseTo(0, 2);
  });

  it('should validate delta neutrality with tolerance', () => {
    const perpPosition = createPerpPosition(1.0, OrderSide.SHORT);
    const spotPosition = createSpotPosition(1.005, OrderSide.LONG); // 0.5% drift

    const group = new DeltaNeutralPositionGroup(
      'ETH',
      ExchangeType.HYPERLIQUID,
      perpPosition,
      spotPosition,
      Percentage.fromDecimal(0.01), // 1% tolerance
    );

    expect(group.validateDeltaNeutrality()).toBe(true);
    expect(group.getDeltaDriftPercent()).toBeCloseTo(0.5, 1);
  });

  it('should detect non-delta-neutral positions', () => {
    const perpPosition = createPerpPosition(1.0, OrderSide.SHORT);
    const spotPosition = createSpotPosition(1.5, OrderSide.LONG); // 50% drift

    const group = new DeltaNeutralPositionGroup(
      'ETH',
      ExchangeType.HYPERLIQUID,
      perpPosition,
      spotPosition,
    );

    expect(group.validateDeltaNeutrality()).toBe(false);
    expect(group.getDeltaDriftPercent()).toBeCloseTo(50, 1);
  });

  it('should calculate net delta correctly', () => {
    // Long perp + Short spot = positive delta
    const perpPosition = createPerpPosition(1.0, OrderSide.LONG);
    const spotPosition = createSpotPosition(1.0, OrderSide.SHORT);

    const group = new DeltaNeutralPositionGroup(
      'ETH',
      ExchangeType.HYPERLIQUID,
      perpPosition,
      spotPosition,
    );

    // Net delta = 1.0 (long) + (-1.0) (short) = 0
    expect(group.calculateNetDelta()).toBeCloseTo(0, 2);
  });

  it('should calculate total value correctly', () => {
    const perpPosition = createPerpPosition(1.0, OrderSide.SHORT, 3000, 3100);
    const spotPosition = createSpotPosition(1.0, OrderSide.LONG, 3000, 3100);

    const group = new DeltaNeutralPositionGroup(
      'ETH',
      ExchangeType.HYPERLIQUID,
      perpPosition,
      spotPosition,
    );

    expect(group.getTotalValue()).toBe(6200); // 3100 * 2
  });

  it('should calculate combined PnL', () => {
    const perpPosition = createPerpPosition(1.0, OrderSide.SHORT, 3000, 3100);
    // Short perp loses when price goes up
    const perpPnl = (3000 - 3100) * 1.0; // -100

    const spotPosition = createSpotPosition(1.0, OrderSide.LONG, 3000, 3100);
    // Long spot gains when price goes up
    const spotPnl = (3100 - 3000) * 1.0; // +100

    const updatedPerp = perpPosition.updateMarkPrice(3100, perpPnl);
    const updatedSpot = spotPosition.updateCurrentPrice(3100, spotPnl);

    const group = new DeltaNeutralPositionGroup(
      'ETH',
      ExchangeType.HYPERLIQUID,
      updatedPerp,
      updatedSpot,
    );

    expect(group.getCombinedPnl()).toBeCloseTo(0, 2); // Delta neutral = net PnL = 0
  });

  it('should throw error for different exchanges', () => {
    const perpPosition = new PerpPosition(
      ExchangeType.HYPERLIQUID,
      'ETH',
      OrderSide.SHORT,
      1.0,
      3000,
      3000,
      0,
    );
    const spotPosition = new SpotPosition(
      ExchangeType.ASTER,
      'ETH',
      OrderSide.LONG,
      1.0,
      3000,
      3000,
      0,
    );

    expect(() => {
      new DeltaNeutralPositionGroup('ETH', ExchangeType.HYPERLIQUID, perpPosition, spotPosition);
    }).toThrow('Perp and spot positions must be on the same exchange');
  });

  it('should throw error for different symbols', () => {
    const perpPosition = new PerpPosition(
      ExchangeType.HYPERLIQUID,
      'ETH',
      OrderSide.SHORT,
      1.0,
      3000,
      3000,
      0,
    );
    const spotPosition = new SpotPosition(
      ExchangeType.HYPERLIQUID,
      'BTC',
      OrderSide.LONG,
      1.0,
      50000,
      50000,
      0,
    );

    expect(() => {
      new DeltaNeutralPositionGroup('ETH', ExchangeType.HYPERLIQUID, perpPosition, spotPosition);
    }).toThrow('Perp and spot positions must be for the same symbol');
  });

  it('should update positions correctly', () => {
    const perpPosition = createPerpPosition(1.0, OrderSide.SHORT);
    const spotPosition = createSpotPosition(1.0, OrderSide.LONG);

    const group = new DeltaNeutralPositionGroup(
      'ETH',
      ExchangeType.HYPERLIQUID,
      perpPosition,
      spotPosition,
    );

    const updatedPerp = createPerpPosition(1.0, OrderSide.SHORT, 3000, 3100);
    const updatedSpot = createSpotPosition(1.0, OrderSide.LONG, 3000, 3100);

    const updatedGroup = group.updatePositions(updatedPerp, updatedSpot);

    expect(updatedGroup.perpPosition.markPrice).toBe(3100);
    expect(updatedGroup.spotPosition.currentPrice).toBe(3100);
  });
});

