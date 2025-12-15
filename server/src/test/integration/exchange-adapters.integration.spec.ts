/**
 * Integration tests for exchange adapters
 * 
 * These tests run against REAL APIs (testnets where available)
 * to validate adapter functionality with actual network conditions.
 * 
 * Run: pnpm run test:integration
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HyperliquidExchangeAdapter } from '../../infrastructure/adapters/hyperliquid/HyperliquidExchangeAdapter';
import { LighterExchangeAdapter } from '../../infrastructure/adapters/lighter/LighterExchangeAdapter';
import { ExtendedExchangeAdapter } from '../../infrastructure/adapters/extended/ExtendedExchangeAdapter';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { OrderSide, OrderType, TimeInForce } from '../../domain/value-objects/PerpOrder';
import { PerpOrderRequest } from '../../domain/value-objects/PerpOrder';

// Skip tests if credentials are not configured
const skipIfNoCredentials = (envVar: string) => {
  return !process.env[envVar] ? describe.skip : describe;
};

// Test configuration
const TEST_SYMBOL = 'ETH';
const MIN_ORDER_SIZE = 0.001; // Minimum position size for testing

describe('Exchange Adapter Integration Tests', () => {
  let module: TestingModule;
  let configService: ConfigService;

  beforeAll(async () => {
    // Load test environment
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          envFilePath: ['.env.testnet', '.env'],
          isGlobal: true,
        }),
      ],
    }).compile();

    configService = module.get<ConfigService>(ConfigService);
  });

  afterAll(async () => {
    await module?.close();
  });

  // ==================== HYPERLIQUID TESTS ====================
  skipIfNoCredentials('HYPERLIQUID_PRIVATE_KEY')('Hyperliquid Adapter', () => {
    let adapter: HyperliquidExchangeAdapter;
    const isTestnet = process.env.HYPERLIQUID_TESTNET === 'true';

    beforeAll(() => {
      adapter = new HyperliquidExchangeAdapter(configService);
    });

    describe('Connection', () => {
      it('should connect successfully', async () => {
        await expect(adapter.testConnection()).resolves.not.toThrow();
      });

      it('should report ready state', async () => {
        const ready = await adapter.isReady();
        expect(ready).toBe(true);
      });
    });

    describe('Market Data', () => {
      it('should fetch mark price for ETH', async () => {
        const price = await adapter.getMarkPrice('ETH');
        expect(price).toBeGreaterThan(0);
        console.log(`Hyperliquid ETH mark price: $${price}`);
      });

      it('should fetch funding rate for ETH', async () => {
        const rate = await adapter.getFundingRate('ETH');
        expect(typeof rate).toBe('number');
        console.log(`Hyperliquid ETH funding rate: ${(rate * 100).toFixed(4)}%`);
      });

      it('should get balance', async () => {
        const balance = await adapter.getBalance();
        expect(balance).toBeGreaterThanOrEqual(0);
        console.log(`Hyperliquid balance: $${balance.toFixed(2)}`);
      });
    });

    describe('Open Orders', () => {
      it('should fetch open orders', async () => {
        const orders = await adapter.getOpenOrders();
        expect(Array.isArray(orders)).toBe(true);
        console.log(`Hyperliquid open orders: ${orders.length}`);
      });
    });

    // Only run order tests on testnet
    (isTestnet ? describe : describe.skip)('Order Flow (Testnet)', () => {
      let orderId: string | null = null;

      afterEach(async () => {
        // Cleanup: cancel any orders placed
        if (orderId) {
          try {
            await adapter.cancelOrder(orderId, TEST_SYMBOL);
          } catch (e) {
            // Order may have filled or already cancelled
          }
          orderId = null;
        }
      });

      it('should place and cancel a limit order', async () => {
        const markPrice = await adapter.getMarkPrice(TEST_SYMBOL);
        // Place order far from market to avoid fill
        const orderPrice = markPrice * 0.8; // 20% below market

        const request = new PerpOrderRequest(
          TEST_SYMBOL,
          OrderSide.LONG,
          OrderType.LIMIT,
          MIN_ORDER_SIZE,
          orderPrice,
          TimeInForce.GTC,
          false,
        );

        const response = await adapter.placeOrder(request);
        orderId = response.orderId;

        expect(response.orderId).toBeDefined();
        expect(response.orderId.length).toBeGreaterThan(0);
        console.log(`Placed order: ${response.orderId}`);

        // Verify it appears in open orders
        const openOrders = await adapter.getOpenOrders();
        const ourOrder = openOrders.find(o => o.orderId === orderId);
        expect(ourOrder).toBeDefined();

        // Cancel it
        const cancelled = await adapter.cancelOrder(orderId!, TEST_SYMBOL);
        expect(cancelled).toBe(true);
        orderId = null;
      });
    });
  });

  // ==================== LIGHTER TESTS ====================
  skipIfNoCredentials('LIGHTER_API_KEY')('Lighter Adapter', () => {
    let adapter: LighterExchangeAdapter;

    beforeAll(() => {
      adapter = new LighterExchangeAdapter(configService);
    });

    describe('Connection', () => {
      it('should connect successfully', async () => {
        await expect(adapter.testConnection()).resolves.not.toThrow();
      });

      it('should report ready state', async () => {
        const ready = await adapter.isReady();
        expect(ready).toBe(true);
      });
    });

    describe('Market Data', () => {
      it('should fetch mark price for ETH', async () => {
        const price = await adapter.getMarkPrice('ETH');
        expect(price).toBeGreaterThan(0);
        console.log(`Lighter ETH mark price: $${price}`);
      });

      it('should get balance', async () => {
        const balance = await adapter.getBalance();
        expect(balance).toBeGreaterThanOrEqual(0);
        console.log(`Lighter balance: $${balance.toFixed(2)}`);
      });
    });

    describe('Open Orders', () => {
      it('should fetch open orders', async () => {
        const orders = await adapter.getOpenOrders();
        expect(Array.isArray(orders)).toBe(true);
        console.log(`Lighter open orders: ${orders.length}`);
        
        if (orders.length > 0) {
          console.log('Order details:', orders.map(o => 
            `${o.symbol} ${o.side} ${o.size}@${o.price}`
          ).join(', '));
        }
      });
    });

    describe('Positions', () => {
      it('should fetch positions', async () => {
        const positions = await adapter.getPositions();
        expect(Array.isArray(positions)).toBe(true);
        console.log(`Lighter positions: ${positions.length}`);
      });
    });
  });

  // ==================== EXTENDED TESTS ====================
  skipIfNoCredentials('EXTENDED_API_KEY')('Extended Adapter', () => {
    let adapter: ExtendedExchangeAdapter;
    const isTestnet = process.env.EXTENDED_TESTNET === 'true';

    beforeAll(() => {
      adapter = new ExtendedExchangeAdapter(configService);
    });

    describe('Connection', () => {
      it('should connect successfully', async () => {
        await expect(adapter.testConnection()).resolves.not.toThrow();
      });

      it('should report ready state', async () => {
        const ready = await adapter.isReady();
        expect(ready).toBe(true);
      });
    });

    describe('Market Data', () => {
      it('should fetch mark price for BTC', async () => {
        const price = await adapter.getMarkPrice('BTC');
        expect(price).toBeGreaterThan(0);
        console.log(`Extended BTC mark price: $${price}`);
      });
    });

    describe('Balance', () => {
      it('should get balance', async () => {
        const balance = await adapter.getBalance();
        expect(balance).toBeGreaterThanOrEqual(0);
        console.log(`Extended balance: $${balance.toFixed(2)}`);
      });

      it('should get equity', async () => {
        const equity = await adapter.getEquity();
        expect(equity).toBeGreaterThanOrEqual(0);
        console.log(`Extended equity: $${equity.toFixed(2)}`);
      });
    });
  });
});

// ==================== DEDUPLICATION TESTS ====================
describe('Order Deduplication Tests', () => {
  let lighterAdapter: LighterExchangeAdapter;
  let configService: ConfigService;
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          envFilePath: ['.env.testnet', '.env'],
          isGlobal: true,
        }),
      ],
    }).compile();

    configService = module.get<ConfigService>(ConfigService);
    
    if (process.env.LIGHTER_API_KEY) {
      lighterAdapter = new LighterExchangeAdapter(configService);
    }
  });

  afterAll(async () => {
    await module?.close();
  });

  skipIfNoCredentials('LIGHTER_API_KEY')('Lighter Open Orders Detection', () => {
    it('should detect existing open orders', async () => {
      const orders = await lighterAdapter.getOpenOrders();
      
      console.log(`\n=== Lighter Open Orders ===`);
      console.log(`Total: ${orders.length}`);
      
      if (orders.length > 0) {
        // Group by symbol and side
        const grouped: Record<string, typeof orders> = {};
        for (const o of orders) {
          const key = `${o.symbol}-${o.side}`;
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(o);
        }

        for (const [key, group] of Object.entries(grouped)) {
          if (group.length > 1) {
            console.log(`⚠️ DUPLICATE: ${key} has ${group.length} orders`);
            for (const o of group) {
              console.log(`   - ${o.size}@${o.price} (ID: ${o.orderId})`);
            }
          } else {
            console.log(`✓ ${key}: 1 order`);
          }
        }
      }

      expect(Array.isArray(orders)).toBe(true);
    });

    it('should correctly parse order details', async () => {
      const orders = await lighterAdapter.getOpenOrders();
      
      for (const order of orders) {
        expect(order.orderId).toBeDefined();
        expect(order.symbol).toBeDefined();
        expect(['buy', 'sell']).toContain(order.side);
        expect(order.price).toBeGreaterThan(0);
        expect(order.size).toBeGreaterThan(0);
        expect(order.filledSize).toBeGreaterThanOrEqual(0);
        expect(order.timestamp).toBeInstanceOf(Date);
      }
    });
  });
});

