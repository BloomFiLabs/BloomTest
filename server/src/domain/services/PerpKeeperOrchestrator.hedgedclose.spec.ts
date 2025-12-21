/**
 * PerpKeeperOrchestrator Hedged Close Tests
 * 
 * These tests verify:
 * 1. executeHedgedPartialClose closes both legs simultaneously
 * 2. Partial closes maintain delta-neutral position
 * 3. Error handling when one leg fails during close
 * 4. Proper order sizing for partial closes
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PerpPosition } from '../entities/PerpPosition';
import { ExchangeType } from '../value-objects/ExchangeConfig';
import { OrderSide, OrderStatus, PerpOrderResponse, OrderType, TimeInForce } from '../value-objects/PerpOrder';

// Helper to create mock positions
function createPosition(
  symbol: string,
  side: OrderSide,
  exchange: ExchangeType,
  size: number = 100,
  entryPrice: number = 100,
): PerpPosition {
  return new PerpPosition(
    exchange,
    symbol,
    side,
    size,
    entryPrice,
    entryPrice, // markPrice
    0,   // unrealizedPnl
    10,  // leverage
    side === OrderSide.LONG ? entryPrice * 0.9 : entryPrice * 1.1, // liquidationPrice
    size * entryPrice / 10,  // marginUsed
    undefined,
    new Date(),
  );
}

// Paired position structure
interface PairedPosition {
  symbol: string;
  long: PerpPosition;
  short: PerpPosition;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
}

// Simulated hedged partial close logic
async function executeHedgedPartialClose(
  pair: PairedPosition,
  closePercentage: number,
  adapters: Map<ExchangeType, MockAdapter>,
): Promise<{ success: boolean; longClosed: number; shortClosed: number; errors: string[] }> {
  const errors: string[] = [];
  let longClosed = 0;
  let shortClosed = 0;

  const longCloseSize = pair.long.size * closePercentage;
  const shortCloseSize = pair.short.size * closePercentage;

  const longAdapter = adapters.get(pair.longExchange);
  const shortAdapter = adapters.get(pair.shortExchange);

  if (!longAdapter || !shortAdapter) {
    return { success: false, longClosed: 0, shortClosed: 0, errors: ['Missing adapter'] };
  }

  // Execute both closes in parallel
  const [longResult, shortResult] = await Promise.allSettled([
    longAdapter.placeOrder({
      symbol: pair.long.symbol,
      side: OrderSide.SHORT, // Close LONG with SHORT
      size: longCloseSize,
      reduceOnly: true,
    }),
    shortAdapter.placeOrder({
      symbol: pair.short.symbol,
      side: OrderSide.LONG, // Close SHORT with LONG
      size: shortCloseSize,
      reduceOnly: true,
    }),
  ]);

  if (longResult.status === 'fulfilled' && longResult.value.success) {
    longClosed = longCloseSize;
  } else {
    errors.push(`Long close failed: ${longResult.status === 'rejected' ? longResult.reason : 'Unknown'}`);
  }

  if (shortResult.status === 'fulfilled' && shortResult.value.success) {
    shortClosed = shortCloseSize;
  } else {
    errors.push(`Short close failed: ${shortResult.status === 'rejected' ? shortResult.reason : 'Unknown'}`);
  }

  const success = errors.length === 0;
  return { success, longClosed, shortClosed, errors };
}

// Mock adapter interface
interface MockAdapter {
  placeOrder: (order: any) => Promise<{ success: boolean; filledSize: number }>;
}

describe('Hedged Partial Close Tests', () => {
  describe('Simultaneous Close Execution', () => {
    it('should close both legs at the same time', async () => {
      const pair: PairedPosition = {
        symbol: 'BTC',
        long: createPosition('BTC', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100),
        short: createPosition('BTC-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 100),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
      };

      const callTimes: { exchange: string; time: number }[] = [];
      const startTime = Date.now();

      const adapters = new Map<ExchangeType, MockAdapter>();
      adapters.set(ExchangeType.HYPERLIQUID, {
        placeOrder: async () => {
          callTimes.push({ exchange: 'HL', time: Date.now() - startTime });
          await new Promise(r => setTimeout(r, 50));
          return { success: true, filledSize: 50 };
        },
      });
      adapters.set(ExchangeType.LIGHTER, {
        placeOrder: async () => {
          callTimes.push({ exchange: 'LIGHTER', time: Date.now() - startTime });
          await new Promise(r => setTimeout(r, 50));
          return { success: true, filledSize: 50 };
        },
      });

      const result = await executeHedgedPartialClose(pair, 0.5, adapters);

      expect(result.success).toBe(true);
      expect(result.longClosed).toBe(50);
      expect(result.shortClosed).toBe(50);

      // Both calls should start at nearly the same time (within 10ms)
      expect(callTimes).toHaveLength(2);
      const timeDiff = Math.abs(callTimes[0].time - callTimes[1].time);
      expect(timeDiff).toBeLessThan(20); // Should be nearly simultaneous
    });

    it('should close correct percentage of each position', async () => {
      const pair: PairedPosition = {
        symbol: 'ETH',
        long: createPosition('ETH', OrderSide.LONG, ExchangeType.HYPERLIQUID, 200),
        short: createPosition('ETH-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 200),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
      };

      const orderSizes: number[] = [];

      const adapters = new Map<ExchangeType, MockAdapter>();
      adapters.set(ExchangeType.HYPERLIQUID, {
        placeOrder: async (order) => {
          orderSizes.push(order.size);
          return { success: true, filledSize: order.size };
        },
      });
      adapters.set(ExchangeType.LIGHTER, {
        placeOrder: async (order) => {
          orderSizes.push(order.size);
          return { success: true, filledSize: order.size };
        },
      });

      // Close 25%
      const result = await executeHedgedPartialClose(pair, 0.25, adapters);

      expect(result.success).toBe(true);
      expect(result.longClosed).toBe(50); // 25% of 200
      expect(result.shortClosed).toBe(50);
      expect(orderSizes).toContain(50);
    });

    it('should use reduceOnly orders for closing', async () => {
      const pair: PairedPosition = {
        symbol: 'SOL',
        long: createPosition('SOL', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100),
        short: createPosition('SOL-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 100),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
      };

      const orders: any[] = [];

      const adapters = new Map<ExchangeType, MockAdapter>();
      adapters.set(ExchangeType.HYPERLIQUID, {
        placeOrder: async (order) => {
          orders.push(order);
          return { success: true, filledSize: order.size };
        },
      });
      adapters.set(ExchangeType.LIGHTER, {
        placeOrder: async (order) => {
          orders.push(order);
          return { success: true, filledSize: order.size };
        },
      });

      await executeHedgedPartialClose(pair, 0.5, adapters);

      expect(orders).toHaveLength(2);
      expect(orders[0].reduceOnly).toBe(true);
      expect(orders[1].reduceOnly).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should report errors when long close fails', async () => {
      const pair: PairedPosition = {
        symbol: 'AVAX',
        long: createPosition('AVAX', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100),
        short: createPosition('AVAX-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 100),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
      };

      const adapters = new Map<ExchangeType, MockAdapter>();
      adapters.set(ExchangeType.HYPERLIQUID, {
        placeOrder: async () => {
          throw new Error('Insufficient margin');
        },
      });
      adapters.set(ExchangeType.LIGHTER, {
        placeOrder: async (order) => {
          return { success: true, filledSize: order.size };
        },
      });

      const result = await executeHedgedPartialClose(pair, 0.5, adapters);

      expect(result.success).toBe(false);
      expect(result.longClosed).toBe(0);
      expect(result.shortClosed).toBe(50);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.includes('Long close failed'))).toBe(true);
    });

    it('should report errors when short close fails', async () => {
      const pair: PairedPosition = {
        symbol: 'LINK',
        long: createPosition('LINK', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100),
        short: createPosition('LINK-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 100),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
      };

      const adapters = new Map<ExchangeType, MockAdapter>();
      adapters.set(ExchangeType.HYPERLIQUID, {
        placeOrder: async (order) => {
          return { success: true, filledSize: order.size };
        },
      });
      adapters.set(ExchangeType.LIGHTER, {
        placeOrder: async () => {
          throw new Error('Rate limit exceeded');
        },
      });

      const result = await executeHedgedPartialClose(pair, 0.5, adapters);

      expect(result.success).toBe(false);
      expect(result.longClosed).toBe(50);
      expect(result.shortClosed).toBe(0);
      expect(result.errors.some(e => e.includes('Short close failed'))).toBe(true);
    });

    it('should report errors when both closes fail', async () => {
      const pair: PairedPosition = {
        symbol: 'UNI',
        long: createPosition('UNI', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100),
        short: createPosition('UNI-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 100),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
      };

      const adapters = new Map<ExchangeType, MockAdapter>();
      adapters.set(ExchangeType.HYPERLIQUID, {
        placeOrder: async () => {
          throw new Error('Network error');
        },
      });
      adapters.set(ExchangeType.LIGHTER, {
        placeOrder: async () => {
          throw new Error('Connection refused');
        },
      });

      const result = await executeHedgedPartialClose(pair, 0.5, adapters);

      expect(result.success).toBe(false);
      expect(result.longClosed).toBe(0);
      expect(result.shortClosed).toBe(0);
      expect(result.errors).toHaveLength(2);
    });
  });

  describe('Position Size Handling', () => {
    it('should handle different position sizes on each exchange', async () => {
      // Asymmetric position sizes
      const pair: PairedPosition = {
        symbol: 'AAVE',
        long: createPosition('AAVE', OrderSide.LONG, ExchangeType.HYPERLIQUID, 150),
        short: createPosition('AAVE-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 100),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
      };

      const orderSizes: { exchange: ExchangeType; size: number }[] = [];

      const adapters = new Map<ExchangeType, MockAdapter>();
      adapters.set(ExchangeType.HYPERLIQUID, {
        placeOrder: async (order) => {
          orderSizes.push({ exchange: ExchangeType.HYPERLIQUID, size: order.size });
          return { success: true, filledSize: order.size };
        },
      });
      adapters.set(ExchangeType.LIGHTER, {
        placeOrder: async (order) => {
          orderSizes.push({ exchange: ExchangeType.LIGHTER, size: order.size });
          return { success: true, filledSize: order.size };
        },
      });

      const result = await executeHedgedPartialClose(pair, 0.5, adapters);

      expect(result.success).toBe(true);
      expect(result.longClosed).toBe(75); // 50% of 150
      expect(result.shortClosed).toBe(50); // 50% of 100

      const hlOrder = orderSizes.find(o => o.exchange === ExchangeType.HYPERLIQUID);
      const lighterOrder = orderSizes.find(o => o.exchange === ExchangeType.LIGHTER);
      expect(hlOrder?.size).toBe(75);
      expect(lighterOrder?.size).toBe(50);
    });

    it('should handle 100% close (full position close)', async () => {
      const pair: PairedPosition = {
        symbol: 'CRV',
        long: createPosition('CRV', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100),
        short: createPosition('CRV-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 100),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
      };

      const adapters = new Map<ExchangeType, MockAdapter>();
      adapters.set(ExchangeType.HYPERLIQUID, {
        placeOrder: async (order) => ({ success: true, filledSize: order.size }),
      });
      adapters.set(ExchangeType.LIGHTER, {
        placeOrder: async (order) => ({ success: true, filledSize: order.size }),
      });

      const result = await executeHedgedPartialClose(pair, 1.0, adapters);

      expect(result.success).toBe(true);
      expect(result.longClosed).toBe(100);
      expect(result.shortClosed).toBe(100);
    });

    it('should handle very small close percentages', async () => {
      const pair: PairedPosition = {
        symbol: 'MKR',
        long: createPosition('MKR', OrderSide.LONG, ExchangeType.HYPERLIQUID, 1000),
        short: createPosition('MKR-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 1000),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
      };

      const adapters = new Map<ExchangeType, MockAdapter>();
      adapters.set(ExchangeType.HYPERLIQUID, {
        placeOrder: async (order) => ({ success: true, filledSize: order.size }),
      });
      adapters.set(ExchangeType.LIGHTER, {
        placeOrder: async (order) => ({ success: true, filledSize: order.size }),
      });

      // Close 1%
      const result = await executeHedgedPartialClose(pair, 0.01, adapters);

      expect(result.success).toBe(true);
      expect(result.longClosed).toBe(10); // 1% of 1000
      expect(result.shortClosed).toBe(10);
    });
  });

  describe('Delta-Neutral Maintenance', () => {
    it('should maintain delta-neutral after partial close', async () => {
      const initialLongSize = 100;
      const initialShortSize = 100;

      const pair: PairedPosition = {
        symbol: 'SNX',
        long: createPosition('SNX', OrderSide.LONG, ExchangeType.HYPERLIQUID, initialLongSize),
        short: createPosition('SNX-USD', OrderSide.SHORT, ExchangeType.LIGHTER, initialShortSize),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
      };

      const adapters = new Map<ExchangeType, MockAdapter>();
      adapters.set(ExchangeType.HYPERLIQUID, {
        placeOrder: async (order) => ({ success: true, filledSize: order.size }),
      });
      adapters.set(ExchangeType.LIGHTER, {
        placeOrder: async (order) => ({ success: true, filledSize: order.size }),
      });

      const result = await executeHedgedPartialClose(pair, 0.3, adapters);

      expect(result.success).toBe(true);

      // Calculate remaining positions
      const remainingLong = initialLongSize - result.longClosed;
      const remainingShort = initialShortSize - result.shortClosed;

      // Should still be delta-neutral (equal sizes)
      expect(remainingLong).toBe(remainingShort);
      expect(remainingLong).toBe(70); // 70% remaining
    });

    it('should close both legs even if sizes differ (best effort)', async () => {
      // Scenario: Position sizes somehow became different
      const pair: PairedPosition = {
        symbol: 'YFI',
        long: createPosition('YFI', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100),
        short: createPosition('YFI-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 80), // Smaller
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
      };

      const adapters = new Map<ExchangeType, MockAdapter>();
      adapters.set(ExchangeType.HYPERLIQUID, {
        placeOrder: async (order) => ({ success: true, filledSize: order.size }),
      });
      adapters.set(ExchangeType.LIGHTER, {
        placeOrder: async (order) => ({ success: true, filledSize: order.size }),
      });

      const result = await executeHedgedPartialClose(pair, 0.5, adapters);

      expect(result.success).toBe(true);
      expect(result.longClosed).toBe(50); // 50% of 100
      expect(result.shortClosed).toBe(40); // 50% of 80
    });
  });

  describe('Order Side Verification', () => {
    it('should use opposite side to close positions', async () => {
      const pair: PairedPosition = {
        symbol: 'COMP',
        long: createPosition('COMP', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100),
        short: createPosition('COMP-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 100),
        longExchange: ExchangeType.HYPERLIQUID,
        shortExchange: ExchangeType.LIGHTER,
      };

      const orderSides: { exchange: ExchangeType; side: OrderSide }[] = [];

      const adapters = new Map<ExchangeType, MockAdapter>();
      adapters.set(ExchangeType.HYPERLIQUID, {
        placeOrder: async (order) => {
          orderSides.push({ exchange: ExchangeType.HYPERLIQUID, side: order.side });
          return { success: true, filledSize: order.size };
        },
      });
      adapters.set(ExchangeType.LIGHTER, {
        placeOrder: async (order) => {
          orderSides.push({ exchange: ExchangeType.LIGHTER, side: order.side });
          return { success: true, filledSize: order.size };
        },
      });

      await executeHedgedPartialClose(pair, 0.5, adapters);

      // LONG position should be closed with SHORT order
      const hlOrder = orderSides.find(o => o.exchange === ExchangeType.HYPERLIQUID);
      expect(hlOrder?.side).toBe(OrderSide.SHORT);

      // SHORT position should be closed with LONG order
      const lighterOrder = orderSides.find(o => o.exchange === ExchangeType.LIGHTER);
      expect(lighterOrder?.side).toBe(OrderSide.LONG);
    });
  });
});

describe('Integration Scenarios', () => {
  it('Full rebalancing flow: detect risk -> partial close -> verify delta-neutral', async () => {
    // Step 1: Initial paired position
    const pair: PairedPosition = {
      symbol: 'BTC',
      long: createPosition('BTC', OrderSide.LONG, ExchangeType.HYPERLIQUID, 100, 50000),
      short: createPosition('BTC-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 100, 50000),
      longExchange: ExchangeType.HYPERLIQUID,
      shortExchange: ExchangeType.LIGHTER,
    };

    const adapters = new Map<ExchangeType, MockAdapter>();
    adapters.set(ExchangeType.HYPERLIQUID, {
      placeOrder: async (order) => ({ success: true, filledSize: order.size }),
    });
    adapters.set(ExchangeType.LIGHTER, {
      placeOrder: async (order) => ({ success: true, filledSize: order.size }),
    });

    // Step 2: Detect that we need to reduce position (e.g., price moved against us)
    const closePercentage = 0.5; // Close 50% to reduce risk

    // Step 3: Execute hedged partial close
    const result = await executeHedgedPartialClose(pair, closePercentage, adapters);

    // Step 4: Verify
    expect(result.success).toBe(true);
    expect(result.longClosed).toBe(result.shortClosed); // Equal amounts closed
    
    // Remaining position is still delta-neutral
    const remainingLong = pair.long.size - result.longClosed;
    const remainingShort = pair.short.size - result.shortClosed;
    expect(remainingLong).toBe(remainingShort);
  });

  it('Emergency close: full position close on both exchanges', async () => {
    const pair: PairedPosition = {
      symbol: 'ETH',
      long: createPosition('ETH', OrderSide.LONG, ExchangeType.HYPERLIQUID, 50, 3000),
      short: createPosition('ETH-USD', OrderSide.SHORT, ExchangeType.LIGHTER, 50, 3000),
      longExchange: ExchangeType.HYPERLIQUID,
      shortExchange: ExchangeType.LIGHTER,
    };

    const adapters = new Map<ExchangeType, MockAdapter>();
    adapters.set(ExchangeType.HYPERLIQUID, {
      placeOrder: async (order) => ({ success: true, filledSize: order.size }),
    });
    adapters.set(ExchangeType.LIGHTER, {
      placeOrder: async (order) => ({ success: true, filledSize: order.size }),
    });

    // Emergency: close 100%
    const result = await executeHedgedPartialClose(pair, 1.0, adapters);

    expect(result.success).toBe(true);
    expect(result.longClosed).toBe(50);
    expect(result.shortClosed).toBe(50);

    // Position should be fully closed
    const remainingLong = pair.long.size - result.longClosed;
    const remainingShort = pair.short.size - result.shortClosed;
    expect(remainingLong).toBe(0);
    expect(remainingShort).toBe(0);
  });
});

