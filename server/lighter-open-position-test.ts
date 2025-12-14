/**
 * Lighter Open Position Test Script
 * 
 * Tests opening a position with different orderExpiry values to determine the correct format
 * Based on the failing order from logs:
 * - Market: IP (index 34)
 * - Size: 88.97002102397337 IP
 * - Price: 1.98
 * - Side: LONG (isAsk: false)
 * - Type: LIMIT
 * - TimeInForce: GTC (0)
 * - reduceOnly: false (0)
 * 
 * Usage:
 *   1. Set LIGHTER_API_KEY, ACCOUNT_INDEX, API_KEY_INDEX in .env
 *   2. Modify the order details below if needed
 *   3. Run: npx tsx lighter-open-position-test.ts
 */

import { SignerClient, OrderType, ApiClient, OrderApi, MarketHelper } from '@reservoir0x/lighter-ts-sdk';
import * as dotenv from 'dotenv';
import axios from 'axios';

// Load environment variables
dotenv.config();

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════

const BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
const API_PRIVATE_KEY = process.env.LIGHTER_API_KEY || process.env.API_PRIVATE_KEY;
const ACCOUNT_INDEX = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || process.env.ACCOUNT_INDEX || '1000');
const API_KEY_INDEX = parseInt(process.env.LIGHTER_API_KEY_INDEX || process.env.API_KEY_INDEX || '1');
const EXPLORER_API_URL = process.env.LIGHTER_EXPLORER_API_URL || 'https://explorer-api-mainnet.zklighter.elliot.ai';

// Order configuration - matching the failing order from logs
const ORDER_CONFIG = {
  symbol: 'IP',
  marketIndex: 34, // IP market index
  size: 88.97002102397337, // Order size in IP
  price: 1.98, // Limit price
  side: 'LONG', // LONG = BUY (isAsk: false)
  timeInForce: 0, // 0 = GTC, 1 = IOC
  reduceOnly: false, // false for opening orders
};

// Test different orderExpiry values
// Values are either:
// - A number representing offset in ms from expiredAt (e.g., 3600000 = +1 hour)
// - 0 for literal zero
// - undefined to omit the field
// - A function that returns a fresh timestamp
const ORDER_EXPIRY_TESTS = [
  { name: 'orderExpiry = 0', value: 0 },
  { name: 'orderExpiry = expiredAt (same as expiredAt)', value: 0, useExpiredAt: true },
  { name: 'orderExpiry = expiredAt + 1 hour', value: 3600000 },
  { name: 'orderExpiry = expiredAt + 2 hours', value: 7200000 },
  { name: 'orderExpiry = undefined (omitted)', value: undefined },
  { name: 'orderExpiry = expiredAt + 30 min', value: 1800000 },
  { name: 'orderExpiry = Date.now() + 2 hours (fresh absolute)', value: () => Date.now() + (2 * 60 * 60 * 1000) },
];

if (!API_PRIVATE_KEY) {
  throw new Error('LIGHTER_API_KEY not found in .env file');
}

// Normalize the private key
let normalizedKey = API_PRIVATE_KEY;
if (normalizedKey.startsWith('0x')) {
  normalizedKey = normalizedKey.slice(2);
}

const PRIVATE_KEY_FOR_SDK = normalizedKey;

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

function trimException(e: Error): string {
  return e.message.trim().split('\n').pop() || 'Unknown error';
}

async function getMarkPrice(marketIndex: number, orderApi: OrderApi): Promise<number> {
  try {
    const orderBook = await orderApi.getOrderBookDetails({ marketIndex } as any);
    if (orderBook.bestBid && orderBook.bestAsk) {
      return (parseFloat(orderBook.bestBid.price) + parseFloat(orderBook.bestAsk.price)) / 2;
    }
  } catch (error: any) {
    console.log(`⚠️  Could not fetch mark price: ${trimException(error)}`);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   LIGHTER OPEN POSITION TEST                           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Initialize SDK
  console.log('📡 Initializing Lighter SDK...');
  const signerClient = new SignerClient({
    url: BASE_URL,
    privateKey: PRIVATE_KEY_FOR_SDK,
    accountIndex: ACCOUNT_INDEX,
    apiKeyIndex: API_KEY_INDEX
  });

  const apiClient = new ApiClient({ host: BASE_URL });
  const orderApi = new OrderApi(apiClient);

  try {
    await signerClient.initialize();
    await signerClient.ensureWasmClient();
    console.log('✅ SDK initialized');
    console.log('');

    // Initialize market helper
    console.log('🔍 Initializing Market Helper...');
    const market = new MarketHelper(ORDER_CONFIG.marketIndex, orderApi);
    await market.initialize();
    console.log(`   Market Index: ${ORDER_CONFIG.marketIndex}`);
    console.log(`   Market: ${market.marketName || ORDER_CONFIG.symbol}`);
    console.log('✅ Market helper initialized');
    console.log('');

    // Get current market price
    console.log('💰 Getting current market price...');
    const markPrice = await getMarkPrice(ORDER_CONFIG.marketIndex, orderApi);
    if (markPrice > 0) {
      console.log(`   Mark Price: $${markPrice.toFixed(6)}`);
    }
    console.log('');

    // Determine order side
    const isAsk = ORDER_CONFIG.side === 'SHORT'; // false for LONG/BUY, true for SHORT/SELL
    const orderSize = ORDER_CONFIG.size;
    const limitPrice = ORDER_CONFIG.price;
    
    console.log('📋 Open Order Details:');
    console.log(`   Symbol: ${ORDER_CONFIG.symbol}`);
    console.log(`   Market Index: ${ORDER_CONFIG.marketIndex}`);
    console.log(`   Side: ${ORDER_CONFIG.side} (isAsk: ${isAsk})`);
    console.log(`   Size: ${orderSize} ${ORDER_CONFIG.symbol}`);
    console.log(`   Limit Price: $${limitPrice.toFixed(6)}`);
    console.log(`   TimeInForce: ${ORDER_CONFIG.timeInForce} (${ORDER_CONFIG.timeInForce === 0 ? 'GTC' : 'IOC'})`);
    console.log(`   Reduce Only: ${ORDER_CONFIG.reduceOnly}`);
    console.log('');

    // Use incrementing counter for clientOrderIndex to avoid nonce collisions
    let clientOrderIndexCounter = Date.now();
    
    // Test each orderExpiry value
    for (let i = 0; i < ORDER_EXPIRY_TESTS.length; i++) {
      const test = ORDER_EXPIRY_TESTS[i];
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`🧪 Test ${i + 1}/${ORDER_EXPIRY_TESTS.length}: ${test.name}`);
      console.log('═══════════════════════════════════════════════════════════');
      
      const timeInForce = ORDER_CONFIG.timeInForce; // 0 = GTC
      // For GTC orders: expiredAt = Date.now() + 3600000 (1 hour)
      const expiredAt = timeInForce === 1 
        ? Date.now() + 60000  // 1 minute for IOC orders
        : Date.now() + 3600000; // 1 hour for GTC orders
      
      // Use incrementing counter to ensure unique nonces
      clientOrderIndexCounter = Math.max(clientOrderIndexCounter + 1, Date.now());
      
      // Calculate orderExpiry value (handle function case)
      let orderExpiryValue: number | undefined;
      
      if (typeof test.value === 'function') {
        // Function returns absolute timestamp
        orderExpiryValue = test.value();
      } else if (test.value === undefined) {
        // Omit the field
        orderExpiryValue = undefined;
      } else if ((test as any).useExpiredAt) {
        // Use expiredAt as-is
        orderExpiryValue = expiredAt;
      } else if (test.value === 0) {
        // Literal zero
        orderExpiryValue = 0;
      } else {
        // Offset from expiredAt (in milliseconds)
        orderExpiryValue = expiredAt + test.value;
      }
      
      const orderParams: any = {
        marketIndex: ORDER_CONFIG.marketIndex,
        clientOrderIndex: clientOrderIndexCounter,
        baseAmount: market.amountToUnits(orderSize),
        price: market.priceToUnits(limitPrice),
        isAsk,
        orderType: OrderType.LIMIT,
        timeInForce, // 0 = GTC, 1 = IOC
        reduceOnly: ORDER_CONFIG.reduceOnly ? 1 : 0, // 0 for opening orders
        expiredAt,
      };

      // Set orderExpiry based on test
      if (orderExpiryValue !== undefined) {
        orderParams.orderExpiry = orderExpiryValue;
      }
      // If undefined, don't include the field at all

      console.log('   Order Parameters:');
      console.log(`     clientOrderIndex: ${clientOrderIndexCounter}`);
      console.log(`     orderExpiry: ${orderExpiryValue !== undefined ? orderExpiryValue : 'undefined (not included)'}`);
      console.log(`     expiredAt: ${expiredAt}`);
      console.log(`     orderExpiry > expiredAt: ${orderExpiryValue !== undefined ? orderExpiryValue > expiredAt : 'N/A'}`);
      if (orderExpiryValue !== undefined && orderExpiryValue > expiredAt) {
        const diffMs = orderExpiryValue - expiredAt;
        const diffHours = diffMs / (60 * 60 * 1000);
        console.log(`     orderExpiry - expiredAt: ${diffMs}ms (${diffHours.toFixed(2)} hours)`);
      }
      console.log(`     timeInForce: ${timeInForce} (${timeInForce === 0 ? 'GTC' : 'IOC'})`);
      console.log(`     reduceOnly: ${ORDER_CONFIG.reduceOnly ? 1 : 0}`);
      console.log(`     baseAmount: ${market.amountToUnits(orderSize)}`);
      console.log(`     price: ${market.priceToUnits(limitPrice)}`);
      console.log('');

      try {
        console.log('   📤 Attempting to place order...');
        const result = await signerClient.createUnifiedOrder(orderParams);
        
        if (result.success) {
          console.log('   ✅ SUCCESS! Order created successfully');
          console.log(`      Order Hash: ${result.mainOrder.hash.substring(0, 16)}...`);
          console.log('');
          console.log('   🎉 This orderExpiry value works!');
          console.log('');
          console.log('   Full result:');
          console.log(JSON.stringify(result, null, 2));
          console.log('');
          
          // Wait a bit to see if order processes
          try {
            console.log('   ⏳ Waiting for order processing...');
            await signerClient.waitForTransaction(result.mainOrder.hash, 30000, 2000);
            console.log('   ✅ Order processed successfully!');
          } catch (error) {
            console.log(`   ⚠️  Order processing: ${trimException(error as Error)}`);
          }
          
          console.log('');
          console.log('💡 RECOMMENDATION: Use this orderExpiry value in LighterExchangeAdapter.ts');
          console.log(`   For GTC orders: orderExpiry = ${orderExpiryValue !== undefined ? orderExpiryValue : 'undefined (omit)'}`);
          break; // Stop after first success
        } else {
          console.log('   ❌ FAILED');
          console.log(`      Error: ${result.mainOrder.error || 'Unknown error'}`);
          console.log('');
          
          // Check if it's the same error we're trying to fix
          if (result.mainOrder.error?.includes('OrderExpiry is invalid')) {
            console.log('      ⚠️  This confirms the orderExpiry validation issue');
          }
        }
      } catch (error: any) {
        console.log('   ❌ EXCEPTION');
        console.log(`      Error: ${trimException(error)}`);
        if (error.message?.includes('OrderExpiry is invalid')) {
          console.log('      ⚠️  This confirms the orderExpiry validation issue');
        }
        if (error.message?.includes('invalid expiry')) {
          console.log('      ⚠️  Expiry value is invalid (may be relationship issue with expiredAt)');
        }
        if (error.message?.includes('invalid nonce')) {
          console.log('      ⚠️  Nonce issue (clientOrderIndex collision or too fast)');
        }
        console.log('');
      }

      // Wait a bit between tests to avoid rate limits and nonce issues
      if (i < ORDER_EXPIRY_TESTS.length - 1) {
        console.log('   ⏳ Waiting 5 seconds before next test...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ Testing complete');
    console.log('═══════════════════════════════════════════════════════════');

  } catch (error) {
    console.log('[ERROR] Failed to run test');
    console.log(`   Error: ${trimException(error as Error)}`);
  } finally {
    try {
      await signerClient.cleanup();
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});



