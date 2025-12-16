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

  // ==================== SPOT ADAPTER TESTS ====================
  log('\n=== Spot Adapter Integration Tests ===');

  // Hyperliquid Spot Adapter
  if (process.env.HYPERLIQUID_PRIVATE_KEY || process.env.PRIVATE_KEY) {
    await describe('Hyperliquid Spot Adapter', async () => {
      const { HyperliquidSpotAdapter } = await import('../../infrastructure/adapters/hyperliquid/HyperliquidSpotAdapter.js');
      const adapter = new HyperliquidSpotAdapter(configService);

      await test('should connect', async () => {
        await adapter.testConnection();
      });

      await test('should get ETH spot price', async () => {
        const price = await adapter.getSpotPrice('ETH');
        if (price <= 0) throw new Error(`Invalid spot price: ${price}`);
        log(`    ETH spot price: $${price.toFixed(2)}`);
      });

      await test('should get spot balance', async () => {
        const balance = await adapter.getSpotBalance('ETH');
        log(`    ETH spot balance: ${balance}`);
      });

      await test('should get spot positions', async () => {
        const positions = await adapter.getSpotPositions();
        log(`    Spot positions: ${positions.length}`);
        for (const p of positions) {
          log(`    - ${p.symbol} ${p.size} @ $${p.currentPrice}`);
        }
      });
    });
  } else {
    log('\n⚠️ Skipping Hyperliquid Spot tests (no credentials)');
  }

  // Aster Spot Adapter
  if (process.env.ASTER_API_KEY || process.env.ASTER_PRIVATE_KEY) {
    await describe('Aster Spot Adapter', async () => {
      const { AsterSpotAdapter } = await import('../../infrastructure/adapters/aster/AsterSpotAdapter.js');
      const adapter = new AsterSpotAdapter(configService);

      await test('should connect', async () => {
        await adapter.testConnection();
      });

      await test('should get ETH spot price', async () => {
        const price = await adapter.getSpotPrice('ETH');
        if (price <= 0) throw new Error(`Invalid spot price: ${price}`);
        log(`    ETH spot price: $${price.toFixed(2)}`);
      });

      await test('should get spot balance', async () => {
        const balance = await adapter.getSpotBalance('ETH');
        log(`    ETH spot balance: ${balance}`);
      });

      await test('should get spot positions', async () => {
        const positions = await adapter.getSpotPositions();
        log(`    Spot positions: ${positions.length}`);
        for (const p of positions) {
          log(`    - ${p.symbol} ${p.size} @ $${p.currentPrice}`);
        }
      });
    });
  } else {
    log('\n⚠️ Skipping Aster Spot tests (no credentials)');
  }

  // Extended Spot Adapter
  if (process.env.EXTENDED_API_KEY) {
    await describe('Extended Spot Adapter', async () => {
      const { ExtendedSpotAdapter } = await import('../../infrastructure/adapters/extended/ExtendedSpotAdapter.js');
      const adapter = new ExtendedSpotAdapter(configService);

      await test('should connect', async () => {
        await adapter.testConnection();
      });

      await test('should get ETH spot price', async () => {
        const price = await adapter.getSpotPrice('ETH');
        if (price <= 0) throw new Error(`Invalid spot price: ${price}`);
        log(`    ETH spot price: $${price.toFixed(2)}`);
      });

      await test('should get spot balance', async () => {
        const balance = await adapter.getSpotBalance('ETH');
        log(`    ETH spot balance: ${balance}`);
      });
    });
  } else {
    log('\n⚠️ Skipping Extended Spot tests (no credentials)');
  }

  // ==================== PERP-SPOT ARBITRAGE FLOW TESTS ====================
  log('\n=== Perp-Spot Arbitrage Flow Tests ===');

  if ((process.env.HYPERLIQUID_PRIVATE_KEY || process.env.PRIVATE_KEY) && process.env.HYPERLIQUID_TESTNET === 'true') {
    await describe('Perp-Spot Arbitrage Flow (Hyperliquid Testnet)', async () => {
      const { HyperliquidExchangeAdapter } = await import('../../infrastructure/adapters/hyperliquid/HyperliquidExchangeAdapter.js');
      const { HyperliquidSpotAdapter } = await import('../../infrastructure/adapters/hyperliquid/HyperliquidSpotAdapter.js');
      const { HyperLiquidDataProvider } = await import('../../infrastructure/adapters/hyperliquid/HyperLiquidDataProvider.js');
      const { HyperLiquidWebSocketProvider } = await import('../../infrastructure/adapters/hyperliquid/HyperLiquidWebSocketProvider.js');
      const { FundingRateAggregator } = await import('../../domain/services/FundingRateAggregator.js');
      const { PerpSpotBalanceManager } = await import('../../domain/services/strategy-rules/PerpSpotBalanceManager.js');
      const { PerpSpotExecutionPlanBuilder } = await import('../../domain/services/strategy-rules/PerpSpotExecutionPlanBuilder.js');

      const wsProvider = new HyperLiquidWebSocketProvider();
      const dataProvider = new HyperLiquidDataProvider(configService, wsProvider);
      const perpAdapter = new HyperliquidExchangeAdapter(configService, dataProvider);
      const spotAdapter = new HyperliquidSpotAdapter(configService);
      const balanceManager = new PerpSpotBalanceManager(perpAdapter, spotAdapter);
      const planBuilder = new PerpSpotExecutionPlanBuilder(balanceManager);

      await test('should detect perp-spot opportunities', async () => {
        const aggregator = new FundingRateAggregator(
          null as any, // asterProvider
          null as any, // lighterProvider
          dataProvider,
          wsProvider,
          null as any, // lighterWsProvider
          null as any, // extendedProvider
        );

        const opportunities = await aggregator.findPerpSpotOpportunities(['ETH'], 0.0001, false);
        log(`    Found ${opportunities.length} perp-spot opportunities`);
        for (const opp of opportunities) {
          log(`    - ${opp.symbol}: ${opp.strategyType} on ${opp.longExchange}, spread: ${opp.spread.value}%`);
        }
      });

      await test('should calculate optimal balance distribution', async () => {
        const perpBalance = await perpAdapter.getBalance();
        const spotBalance = await spotAdapter.getSpotBalance('USDC');
        log(`    Perp balance: $${perpBalance.toFixed(2)}`);
        log(`    Spot balance: $${spotBalance.toFixed(2)}`);

        const optimal = balanceManager.calculateOptimalDistribution(
          perpAdapter,
          'ETH',
          5, // leverage
        );
        log(`    Optimal perp balance: $${optimal.perpBalance.toFixed(2)}`);
        log(`    Optimal spot balance: $${optimal.spotBalance.toFixed(2)}`);
      });

      await test('should build perp-spot execution plan', async () => {
        const perpBalance = await perpAdapter.getBalance();
        const spotBalance = await spotAdapter.getSpotBalance('USDC');
        
        if (perpBalance > 10 && spotBalance > 10) {
          const plan = await planBuilder.buildPlan(
            {
              symbol: 'ETH',
              strategyType: 'perp-spot',
              longExchange: 'HYPERLIQUID',
              spotExchange: 'HYPERLIQUID',
              longRate: { value: 0.0001 } as any,
              spread: { value: 0.0001 } as any,
              expectedReturn: { value: 0.05 } as any,
              timestamp: new Date(),
            },
            perpAdapter,
            spotAdapter,
            5, // leverage
            1000, // maxPositionSize
          );

          if (plan) {
            log(`    Plan created: perp size=${plan.perpOrder.size}, spot size=${plan.spotOrder.size}`);
            log(`    Expected return: ${plan.expectedReturn.value}%`);
          } else {
            log(`    No plan created (insufficient balance or unprofitable)`);
          }
        } else {
          log(`    Skipping (insufficient balance: perp=$${perpBalance}, spot=$${spotBalance})`);
        }
      });
    });
  } else {
    log('\n⚠️ Skipping Perp-Spot Arbitrage Flow tests (requires Hyperliquid testnet credentials)');
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

