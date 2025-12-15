/**
 * Integration test runner
 * 
 * Run with: npx ts-node src/test/integration/run-tests.ts
 * 
 * This uses ts-node directly instead of Jest to avoid ESM module issues
 * with the @nktkas/hyperliquid and @noble packages.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.testnet' });
dotenv.config();

import { ConfigService } from '@nestjs/config';

// Create a mock ConfigService for testing
class MockConfigService {
  private env: Record<string, string | undefined> = process.env as Record<string, string | undefined>;
  
  get<T = string>(key: string): T | undefined {
    return this.env[key] as T | undefined;
  }
}

const configService = new MockConfigService() as unknown as ConfigService;

// Test utilities
let passed = 0;
let failed = 0;
const failures: string[] = [];

function log(msg: string) {
  console.log(msg);
}

function test(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => {
      log(`  ✓ ${name}`);
      passed++;
    })
    .catch((err: any) => {
      log(`  ✗ ${name}: ${err.message}`);
      failures.push(`${name}: ${err.message}`);
      failed++;
    });
}

function describe(name: string, fn: () => Promise<void>) {
  log(`\n${name}`);
  return fn();
}

async function runTests() {
  log('='.repeat(60));
  log('Exchange Adapter Integration Tests');
  log('='.repeat(60));

  log('\n=== Environment ===');
  log(`Hyperliquid Testnet: ${process.env.HYPERLIQUID_TESTNET === 'true' ? 'YES' : 'NO'}`);
  log(`Extended Testnet: ${process.env.EXTENDED_TESTNET === 'true' ? 'YES' : 'NO'}`);
  log(`Lighter configured: ${process.env.LIGHTER_API_KEY ? 'YES' : 'NO'}`);
  log(`Aster configured: ${process.env.ASTER_API_KEY ? 'YES' : 'NO'}`);

  // ==================== HYPERLIQUID TESTS ====================
  if (process.env.HYPERLIQUID_PRIVATE_KEY || process.env.PRIVATE_KEY) {
    await describe('Hyperliquid Adapter', async () => {
      const { HyperliquidExchangeAdapter } = await import('../../infrastructure/adapters/hyperliquid/HyperliquidExchangeAdapter.js');
      const { HyperLiquidDataProvider } = await import('../../infrastructure/adapters/hyperliquid/HyperLiquidDataProvider.js');
      const { HyperLiquidWebSocketProvider } = await import('../../infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider.js');
      const wsProvider = new HyperLiquidWebSocketProvider();
      const dataProvider = new HyperLiquidDataProvider(configService, wsProvider);
      const adapter = new HyperliquidExchangeAdapter(configService, dataProvider);

      await test('should connect', async () => {
        await adapter.testConnection();
      });

      await test('should get ETH mark price', async () => {
        const price = await adapter.getMarkPrice('ETH');
        if (price <= 0) throw new Error(`Invalid price: ${price}`);
        log(`    ETH price: $${price.toFixed(2)}`);
      });

      await test('should get positions', async () => {
        const positions = await adapter.getPositions();
        log(`    Positions: ${positions.length}`);
        for (const p of positions) {
          log(`    - ${p.symbol} ${p.side} ${p.size}`);
        }
      });

      await test('should get balance', async () => {
        const balance = await adapter.getBalance();
        log(`    Balance: $${balance.toFixed(2)}`);
      });

      await test('should get open orders', async () => {
        const orders = await adapter.getOpenOrders();
        log(`    Open orders: ${orders.length}`);
      });
    });
  } else {
    log('\n⚠️ Skipping Hyperliquid tests (no credentials)');
  }

  // ==================== LIGHTER TESTS ====================
  if (process.env.LIGHTER_API_KEY) {
    await describe('Lighter Adapter', async () => {
      const { LighterExchangeAdapter } = await import('../../infrastructure/adapters/lighter/LighterExchangeAdapter.js');
      const adapter = new LighterExchangeAdapter(configService);

      await test('should connect', async () => {
        await adapter.testConnection();
      });

      await test('should get ETH mark price', async () => {
        const price = await adapter.getMarkPrice('ETH');
        if (price <= 0) throw new Error(`Invalid price: ${price}`);
        log(`    ETH price: $${price.toFixed(2)}`);
      });

      await test('should get balance', async () => {
        const balance = await adapter.getBalance();
        log(`    Balance: $${balance.toFixed(2)}`);
      });

      await test('should get open orders', async () => {
        const orders = await adapter.getOpenOrders();
        log(`    Open orders: ${orders.length}`);
        
        if (orders.length > 0) {
          // Check for duplicates
          const grouped: Record<string, number> = {};
          for (const o of orders) {
            const key = `${o.symbol}-${o.side}`;
            grouped[key] = (grouped[key] || 0) + 1;
          }
          
          for (const [key, count] of Object.entries(grouped)) {
            if (count > 1) {
              log(`    ⚠️ DUPLICATE: ${key} has ${count} orders`);
            }
          }
        }
      });

      await test('should get positions', async () => {
        const positions = await adapter.getPositions();
        log(`    Positions: ${positions.length}`);
        for (const p of positions) {
          log(`    - ${p.symbol} ${p.side} ${p.size} @ ${p.entryPrice}`);
        }
      });
    });
  } else {
    log('\n⚠️ Skipping Lighter tests (no credentials)');
  }

  // ==================== ASTER TESTS ====================
  if (process.env.ASTER_API_KEY) {
    await describe('Aster Adapter', async () => {
      const { AsterExchangeAdapter } = await import('../../infrastructure/adapters/aster/AsterExchangeAdapter.js');
      const adapter = new AsterExchangeAdapter(configService);

      await test('should connect', async () => {
        await adapter.testConnection();
      });

      await test('should get ETH mark price', async () => {
        const price = await adapter.getMarkPrice('ETHUSDT');
        if (price <= 0) throw new Error(`Invalid price: ${price}`);
        log(`    ETH price: $${price.toFixed(2)}`);
      });

      await test('should get balance', async () => {
        const balance = await adapter.getBalance();
        log(`    Balance: $${balance.toFixed(2)}`);
      });
    });
  } else {
    log('\n⚠️ Skipping Aster tests (no credentials)');
  }

  // ==================== SUMMARY ====================
  log('\n' + '='.repeat(60));
  log('SUMMARY');
  log('='.repeat(60));
  log(`Passed: ${passed}`);
  log(`Failed: ${failed}`);
  
  if (failures.length > 0) {
    log('\nFailures:');
    for (const f of failures) {
      log(`  - ${f}`);
    }
  }

  log('');
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});

