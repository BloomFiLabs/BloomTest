/**
 * Test script to find the correct Lighter order expiry configuration
 * 
 * This script tries various combinations of:
 * - orderExpiry (timestamp in ms)
 * - expiredAt (timestamp in ms)
 * - timeInForce (0 = IOC, 1 = GTC/GTT)
 * 
 * Lighter requires minimum 10 minutes expiry for GTT orders
 */

import {
  SignerClient,
  OrderType as LighterOrderType,
  ApiClient,
  OrderApi,
  MarketHelper,
} from '@reservoir0x/lighter-ts-sdk';
// Environment variables should be set in the environment or .env file
// If dotenv is available, try to load .env file
try {
  const dotenv = require('dotenv');
  const path = require('path');
  dotenv.config({ path: path.join(__dirname, '../.env') });
} catch (e) {
  // dotenv not available, use process.env directly (assumes env vars are already set)
}

const LIGHTER_API_BASE_URL =
  process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const LIGHTER_API_KEY = process.env.LIGHTER_API_KEY;
const LIGHTER_ACCOUNT_INDEX = parseInt(
  process.env.LIGHTER_ACCOUNT_INDEX || '1000',
);
const LIGHTER_API_KEY_INDEX = parseInt(
  process.env.LIGHTER_API_KEY_INDEX || '1',
);

if (!LIGHTER_API_KEY) {
  throw new Error('LIGHTER_API_KEY environment variable is required');
}

// Normalize API key (remove 0x if present)
let normalizedKey = LIGHTER_API_KEY;
if (normalizedKey.startsWith('0x')) {
  normalizedKey = normalizedKey.slice(2);
}

interface TestConfig {
  name: string;
  timeInForce: number; // 0 = IOC, 1 = GTC/GTT
  orderExpiry: number | null; // null means don't include
  expiredAt: number | null; // null means don't include
  description: string;
}

// Test configurations to try
const testConfigs: TestConfig[] = [
  // Test 1: Only orderExpiry, 15 minutes (current implementation)
  {
    name: 'Test 1: orderExpiry only (15min)',
    timeInForce: 1,
    orderExpiry: Date.now() + 15 * 60 * 1000,
    expiredAt: null,
    description: 'Current implementation - only orderExpiry set',
  },
  // Test 2: Only expiredAt, 15 minutes
  {
    name: 'Test 2: expiredAt only (15min)',
    timeInForce: 1,
    orderExpiry: null,
    expiredAt: Date.now() + 15 * 60 * 1000,
    description: 'Only expiredAt set',
  },
  // Test 3: Both orderExpiry and expiredAt, same value
  {
    name: 'Test 3: Both orderExpiry and expiredAt (15min, same)',
    timeInForce: 1,
    orderExpiry: Date.now() + 15 * 60 * 1000,
    expiredAt: Date.now() + 15 * 60 * 1000,
    description: 'Both set to same value (current implementation)',
  },
  // Test 4: Only orderExpiry, exactly 10 minutes (minimum)
  {
    name: 'Test 4: orderExpiry only (10min - minimum)',
    timeInForce: 1,
    orderExpiry: Date.now() + 10 * 60 * 1000,
    expiredAt: null,
    description: 'Minimum 10 minutes expiry',
  },
  // Test 5: Only expiredAt, exactly 10 minutes
  {
    name: 'Test 5: expiredAt only (10min - minimum)',
    timeInForce: 1,
    orderExpiry: null,
    expiredAt: Date.now() + 10 * 60 * 1000,
    description: 'Minimum 10 minutes expiry with expiredAt',
  },
  // Test 6: Both, exactly 10 minutes
  {
    name: 'Test 6: Both orderExpiry and expiredAt (10min, same)',
    timeInForce: 1,
    orderExpiry: Date.now() + 10 * 60 * 1000,
    expiredAt: Date.now() + 10 * 60 * 1000,
    description: 'Minimum 10 minutes, both set',
  },
  // Test 7: Only orderExpiry, 20 minutes
  {
    name: 'Test 7: orderExpiry only (20min)',
    timeInForce: 1,
    orderExpiry: Date.now() + 20 * 60 * 1000,
    expiredAt: null,
    description: '20 minutes expiry',
  },
  // Test 8: Only expiredAt, 20 minutes
  {
    name: 'Test 8: expiredAt only (20min)',
    timeInForce: 1,
    orderExpiry: null,
    expiredAt: Date.now() + 20 * 60 * 1000,
    description: '20 minutes expiry with expiredAt',
  },
  // Test 9: orderExpiry = 0 (like market orders)
  {
    name: 'Test 9: orderExpiry = 0 (like market orders)',
    timeInForce: 1,
    orderExpiry: 0,
    expiredAt: null,
    description: 'orderExpiry = 0',
  },
  // Test 10: expiredAt = 0
  {
    name: 'Test 10: expiredAt = 0',
    timeInForce: 1,
    orderExpiry: null,
    expiredAt: 0,
    description: 'expiredAt = 0',
  },
  // Test 11: Both = 0
  {
    name: 'Test 11: Both orderExpiry and expiredAt = 0',
    timeInForce: 1,
    orderExpiry: 0,
    expiredAt: 0,
    description: 'Both set to 0',
  },
  // Test 12: Neither set (undefined)
  {
    name: 'Test 12: Neither orderExpiry nor expiredAt',
    timeInForce: 1,
    orderExpiry: null,
    expiredAt: null,
    description: 'Neither expiry field set',
  },
  // Test 13: orderExpiry in seconds (wrong format)
  {
    name: 'Test 13: orderExpiry in seconds (wrong format)',
    timeInForce: 1,
    orderExpiry: Math.floor(Date.now() / 1000) + 15 * 60,
    expiredAt: null,
    description: 'orderExpiry in seconds instead of milliseconds',
  },
  // Test 14: expiredAt in seconds (wrong format)
  {
    name: 'Test 14: expiredAt in seconds (wrong format)',
    timeInForce: 1,
    orderExpiry: null,
    expiredAt: Math.floor(Date.now() / 1000) + 15 * 60,
    description: 'expiredAt in seconds instead of milliseconds',
  },
];

async function getMarketIndex(
  orderApi: OrderApi,
  symbol: string,
): Promise<number> {
  try {
    const response = await fetch(
      'https://explorer.elliot.ai/api/markets',
    );
    const markets = await response.json();
    const market = markets.find(
      (m: any) =>
        m.base_symbol?.toUpperCase() === symbol.toUpperCase() ||
        m.symbol?.toUpperCase() === symbol.toUpperCase(),
    );
    if (market) {
      return market.market_index;
    }
    throw new Error(`Market not found for symbol: ${symbol}`);
  } catch (error: any) {
    throw new Error(`Failed to get market index: ${error.message}`);
  }
}

async function getMarketHelper(
  marketIndex: number,
  orderApi: OrderApi,
): Promise<MarketHelper> {
  const marketHelper = new MarketHelper(marketIndex, orderApi);
  await marketHelper.initialize();
  return marketHelper;
}

async function testOrderCreation(
  signerClient: SignerClient,
  testConfig: TestConfig,
  marketIndex: number,
  marketHelper: MarketHelper,
): Promise<{ success: boolean; error?: string; orderId?: string }> {
  const now = Date.now();
  const expiry15min = now + 15 * 60 * 1000;

  // Build order params based on test config
  const orderParams: any = {
    marketIndex,
    clientOrderIndex: Date.now(),
    baseAmount: marketHelper.amountToUnits(0.001), // Very small size for testing
    price: marketHelper.priceToUnits(0.01), // Very low price (will likely not fill, but should validate)
    isAsk: true, // Sell order
    orderType: LighterOrderType.LIMIT,
    timeInForce: testConfig.timeInForce,
    reduceOnly: 0,
  };

  // Add expiry fields based on test config
  if (testConfig.orderExpiry !== null) {
    orderParams.orderExpiry = testConfig.orderExpiry;
  }
  if (testConfig.expiredAt !== null) {
    orderParams.expiredAt = testConfig.expiredAt;
  }

  try {
    console.log(`\n  📋 Order params:`, {
      ...orderParams,
      baseAmount: orderParams.baseAmount.toString(),
      price: orderParams.price.toString(),
      orderExpiry: orderParams.orderExpiry
        ? new Date(orderParams.orderExpiry).toISOString()
        : undefined,
      expiredAt: orderParams.expiredAt
        ? new Date(orderParams.expiredAt).toISOString()
        : undefined,
    });

    const result = await signerClient.createUnifiedOrder(orderParams);

    if (!result.success) {
      const errorMsg = result.mainOrder?.error || 'Order creation failed';
      return { success: false, error: errorMsg };
    }

    const orderId = result.mainOrder?.hash;
    return { success: true, orderId };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function main() {
  console.log('🚀 Starting Lighter expiry configuration tests...\n');
  console.log(`API URL: ${LIGHTER_API_BASE_URL}`);
  console.log(`Account Index: ${LIGHTER_ACCOUNT_INDEX}`);
  console.log(`API Key Index: ${LIGHTER_API_KEY_INDEX}\n`);

  // Initialize SignerClient
  const signerClient = new SignerClient({
    url: LIGHTER_API_BASE_URL,
    privateKey: normalizedKey,
    accountIndex: LIGHTER_ACCOUNT_INDEX,
    apiKeyIndex: LIGHTER_API_KEY_INDEX,
  });

  try {
    console.log('Initializing SignerClient...');
    await signerClient.initialize();
    await signerClient.ensureWasmClient();
    console.log('✅ SignerClient initialized\n');

    // Initialize API client
    const apiClient = new ApiClient({ host: LIGHTER_API_BASE_URL });
    const orderApi = new OrderApi(apiClient);

    // Get a test market (use a common one like ETH or BTC)
    console.log('Getting market index for test symbol...');
    const testSymbol = 'ETH'; // Try ETH first
    let marketIndex: number;
    let marketHelper: MarketHelper;

    try {
      marketIndex = await getMarketIndex(orderApi, testSymbol);
      console.log(`✅ Found market index ${marketIndex} for ${testSymbol}`);
    } catch (error: any) {
      console.log(`⚠️  Could not find ${testSymbol}, trying BTC...`);
      marketIndex = await getMarketIndex(orderApi, 'BTC');
      console.log(`✅ Found market index ${marketIndex} for BTC`);
    }

    marketHelper = await getMarketHelper(marketIndex, orderApi);
    console.log('✅ Market helper initialized\n');

    // Run tests
    console.log(`Running ${testConfigs.length} test configurations...\n`);
    console.log('='.repeat(80));

    const results: Array<{
      config: TestConfig;
      result: { success: boolean; error?: string; orderId?: string };
    }> = [];

    for (const config of testConfigs) {
      console.log(`\n${config.name}`);
      console.log(`  Description: ${config.description}`);
      console.log(
        `  timeInForce: ${config.timeInForce} (${config.timeInForce === 1 ? 'GTC/GTT' : 'IOC'})`,
      );
      if (config.orderExpiry !== null) {
        console.log(
          `  orderExpiry: ${config.orderExpiry} (${new Date(config.orderExpiry).toISOString()})`,
        );
      }
      if (config.expiredAt !== null) {
        console.log(
          `  expiredAt: ${config.expiredAt} (${new Date(config.expiredAt).toISOString()})`,
        );
      }

      const result = await testOrderCreation(
        signerClient,
        config,
        marketIndex,
        marketHelper,
      );

      results.push({ config, result });

      if (result.success) {
        console.log(`  ✅ SUCCESS - Order ID: ${result.orderId}`);
      } else {
        console.log(`  ❌ FAILED - Error: ${result.error}`);
      }

      // Small delay between tests
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('\n📊 TEST SUMMARY\n');

    const successful = results.filter((r) => r.result.success);
    const failed = results.filter((r) => !r.result.success);

    console.log(`✅ Successful: ${successful.length}`);
    successful.forEach((r) => {
      console.log(`   - ${r.config.name}`);
    });

    console.log(`\n❌ Failed: ${failed.length}`);
    failed.forEach((r) => {
      console.log(`   - ${r.config.name}: ${r.result.error}`);
    });

    // Find the first successful config
    if (successful.length > 0) {
      const firstSuccess = successful[0];
      console.log('\n🎯 RECOMMENDED CONFIGURATION:');
      console.log(`   ${firstSuccess.config.name}`);
      console.log(`   Description: ${firstSuccess.config.description}`);
      console.log(`   timeInForce: ${firstSuccess.config.timeInForce}`);
      if (firstSuccess.config.orderExpiry !== null) {
        console.log(`   orderExpiry: ${firstSuccess.config.orderExpiry}`);
      }
      if (firstSuccess.config.expiredAt !== null) {
        console.log(`   expiredAt: ${firstSuccess.config.expiredAt}`);
      }
    } else {
      console.log('\n⚠️  No successful configurations found!');
    }
  } catch (error: any) {
    console.error('❌ Fatal error:', error.message);
    console.error(error.stack);
  } finally {
    try {
      await signerClient.close();
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

main().catch(console.error);

