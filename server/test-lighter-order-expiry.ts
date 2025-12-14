import { SignerClient, OrderType, ApiClient, OrderApi, MarketHelper } from '@reservoir0x/lighter-ts-sdk';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from server directory first, then parent
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const API_PRIVATE_KEY = process.env.LIGHTER_API_KEY || process.env.API_PRIVATE_KEY;
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || process.env.ACCOUNT_INDEX || '623336');
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || process.env.API_KEY_INDEX || '2');

// Test configuration - matching the failing order from logs
const ORDER_CONFIG = {
  symbol: 'CC', // Or use IP, ETH, etc.
  marketIndex: 0, // ETH market (change as needed)
  size: 0.01, // Small test size
  price: 3000, // Test price (adjust to current market)
  side: 'LONG', // LONG = BUY (isAsk: false)
  reduceOnly: false, // false for opening orders
};

// Test different orderExpiry values for GTC orders (timeInForce = 1)
// The issue is that orderExpiry might need specific values when timeInForce = 1 (GTC)
// Based on SDK code, expiredAt is typically Date.now() + 3600000 (1 hour)
// We need to find what orderExpiry should be relative to expiredAt
// Key finding: orderExpiry = 0 fails with "OrderExpiry is invalid"
const ORDER_EXPIRY_TESTS = [
  // Test 0 (current code uses this for opening orders - THIS IS FAILING - CONFIRMED)
  { name: 'orderExpiry = 0', orderExpiry: 0, expiredAt: () => Date.now() + 3600000 },
  
  // Test expiredAt + 1 hour (current code uses this for closing orders - likely correct)
  { name: 'orderExpiry = expiredAt + 1 hour', orderExpiry: () => Date.now() + 7200000, expiredAt: () => Date.now() + 3600000 },
  
  // Test expiredAt + 28 days (common expiry for GTC orders)
  { name: 'orderExpiry = expiredAt + 28 days', orderExpiry: () => Date.now() + 3600000 + (28 * 24 * 60 * 60 * 1000), expiredAt: () => Date.now() + 3600000 },
  
  // Test undefined (omit field) - maybe SDK uses default?
  { name: 'orderExpiry = undefined (omitted)', orderExpiry: undefined, expiredAt: () => Date.now() + 3600000 },
];

let clientOrderIndexCounter = Date.now();

function trimException(e: Error): string {
  const msg = e.message || String(e);
  // Remove stack trace, keep only first line
  return msg.split('\n')[0];
}

async function testOrderExpiry(
  signerClient: SignerClient,
  orderApi: OrderApi,
  marketIndex: number,
  test: typeof ORDER_EXPIRY_TESTS[0],
  testIndex: number
): Promise<{ success: boolean; error?: string; orderHash?: string }> {
  try {
    const market = new MarketHelper(marketIndex, orderApi);
    await market.initialize();

    // Calculate actual values (handle functions)
    const expiredAt = typeof test.expiredAt === 'function' ? test.expiredAt() : test.expiredAt;
    const orderExpiry = typeof test.orderExpiry === 'function' ? test.orderExpiry() : test.orderExpiry;

    // Use incrementing counter to ensure unique clientOrderIndex
    // Add delay to ensure nonces are properly managed
    await new Promise(resolve => setTimeout(resolve, 1000));
    clientOrderIndexCounter = Math.max(clientOrderIndexCounter + 1, Date.now());

    const isAsk = ORDER_CONFIG.side === 'SHORT';
    const baseAmount = market.amountToUnits(ORDER_CONFIG.size);
    const price = market.priceToUnits(ORDER_CONFIG.price);

    const orderParams: any = {
      marketIndex,
      clientOrderIndex: clientOrderIndexCounter,
      baseAmount,
      price,
      isAsk,
      orderType: OrderType.LIMIT,
      timeInForce: 1, // GTC/GTT (matching current code)
      reduceOnly: ORDER_CONFIG.reduceOnly ? 1 : 0,
      expiredAt,
    };

    // Set orderExpiry if not undefined
    if (orderExpiry !== undefined) {
      orderParams.orderExpiry = orderExpiry;
    }
    // If undefined, don't include the field at all

    console.log(`\n   📋 Order Parameters:`);
    console.log(`      marketIndex: ${marketIndex}`);
    console.log(`      clientOrderIndex: ${clientOrderIndexCounter}`);
    console.log(`      baseAmount: ${baseAmount}`);
    console.log(`      price: ${price}`);
    console.log(`      isAsk: ${isAsk} (${ORDER_CONFIG.side})`);
    console.log(`      orderType: LIMIT`);
    console.log(`      timeInForce: 1 (GTC/GTT)`);
    console.log(`      reduceOnly: ${ORDER_CONFIG.reduceOnly ? 1 : 0}`);
    console.log(`      expiredAt: ${expiredAt} (${new Date(expiredAt).toISOString()})`);
    console.log(`      orderExpiry: ${orderExpiry !== undefined ? `${orderExpiry} (${new Date(orderExpiry).toISOString()})` : 'undefined (not included)'}`);
    if (orderExpiry !== undefined && expiredAt) {
      const diff = orderExpiry - expiredAt;
      console.log(`      orderExpiry - expiredAt: ${diff}ms (${(diff / 1000 / 60).toFixed(2)} minutes)`);
    }

    console.log(`\n   📤 Placing order...`);
    
    // Use createUnifiedOrder which handles nonces internally
    const result = await signerClient.createUnifiedOrder(orderParams);

    if (result.success && result.mainOrder.hash) {
      console.log(`   ✅ SUCCESS! Order hash: ${result.mainOrder.hash}`);
      return { success: true, orderHash: result.mainOrder.hash };
    } else {
      const errorMsg = result.mainOrder.error || result.message || 'Unknown error';
      console.log(`   ❌ FAILED: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  } catch (error: any) {
    const errorMsg = trimException(error);
    console.log(`   ❌ EXCEPTION: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🧪 Testing Lighter Order Expiry Values for GTC Orders');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\nConfiguration:`);
  console.log(`   Symbol: ${ORDER_CONFIG.symbol}`);
  console.log(`   Market Index: ${ORDER_CONFIG.marketIndex}`);
  console.log(`   Size: ${ORDER_CONFIG.size}`);
  console.log(`   Price: $${ORDER_CONFIG.price}`);
  console.log(`   Side: ${ORDER_CONFIG.side}`);
  console.log(`   Reduce Only: ${ORDER_CONFIG.reduceOnly}`);
  console.log(`   Time In Force: 1 (GTC/GTT)`);
  console.log(`\nTesting ${ORDER_EXPIRY_TESTS.length} different orderExpiry values...\n`);

  if (!API_PRIVATE_KEY) {
    throw new Error('LIGHTER_API_KEY or API_PRIVATE_KEY environment variable is required');
  }

  // Normalize API key
  let normalizedKey = API_PRIVATE_KEY;
  if (normalizedKey.startsWith('0x')) {
    normalizedKey = normalizedKey.slice(2);
  }

  const signerClient = new SignerClient({
    url: BASE_URL,
    privateKey: normalizedKey,
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: API_KEY_INDEX,
  });

  await signerClient.initialize();
  await signerClient.ensureWasmClient();
  console.log('✅ SDK initialized\n');

  // Initialize API clients
  const apiClient = new ApiClient({ host: BASE_URL });
  const orderApi = new OrderApi(apiClient);

  const results: Array<{ test: string; success: boolean; error?: string; orderHash?: string }> = [];

  try {
    // Test each orderExpiry value
    for (let i = 0; i < ORDER_EXPIRY_TESTS.length; i++) {
      const test = ORDER_EXPIRY_TESTS[i];
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`🧪 Test ${i + 1}/${ORDER_EXPIRY_TESTS.length}: ${test.name}`);
      console.log('═══════════════════════════════════════════════════════════');

      const result = await testOrderExpiry(
        signerClient,
        orderApi,
        ORDER_CONFIG.marketIndex,
        test,
        i
      );

      results.push({
        test: test.name,
        success: result.success,
        error: result.error,
        orderHash: result.orderHash,
      });

      // Wait longer between tests to ensure nonces are properly managed
      if (i < ORDER_EXPIRY_TESTS.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    // Print summary
    console.log('\n\n═══════════════════════════════════════════════════════════');
    console.log('📊 Test Results Summary');
    console.log('═══════════════════════════════════════════════════════════\n');

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log(`✅ Successful: ${successful.length}/${results.length}`);
    successful.forEach(r => {
      console.log(`   ✓ ${r.test}${r.orderHash ? ` (Hash: ${r.orderHash})` : ''}`);
    });

    console.log(`\n❌ Failed: ${failed.length}/${results.length}`);
    failed.forEach(r => {
      console.log(`   ✗ ${r.test}`);
      console.log(`     Error: ${r.error}`);
    });

    if (successful.length > 0) {
      console.log(`\n💡 Recommended orderExpiry values:`);
      successful.forEach(r => {
        console.log(`   - ${r.test}`);
      });
    }

  } catch (error: any) {
    console.error('❌ Fatal error:', error.message);
    throw error;
  } finally {
    await signerClient.close();
  }
}

if (require.main === module) {
  main()
    .then(() => {
      console.log('\n✅ Test completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Test failed:', error);
      process.exit(1);
    });
}


