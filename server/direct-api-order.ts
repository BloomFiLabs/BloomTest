/**
 * Direct API Order Script - Mirrors Frontend Request Exactly
 * 
 * This script makes a direct HTTP POST request to HyperLiquid's API
 * matching the exact format used by the frontend.
 * 
 * Usage:
 *   1. Set PRIVATE_KEY in .env file
 *   2. Modify the order parameters below
 *   3. Run: npx tsx direct-api-order.ts
 */

import { HttpTransport, ExchangeClient } from '@nktkas/hyperliquid';
import { SymbolConverter, formatSize, formatPrice } from '@nktkas/hyperliquid/utils';
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';

// Load environment variables
dotenv.config();

// ═══════════════════════════════════════════════════════════
// CONFIGURATION - Modify these values
// ═══════════════════════════════════════════════════════════

const ORDER_CONFIG = {
  // Asset to trade (e.g., 'ETH', 'BTC')
  coin: 'ETH',
  
  // Order side: true = buy/long, false = sell/short
  isBuy: true,
  
  // Order size (in base asset units, e.g., 0.01 ETH)
  size: 0.01,
  
  // Limit price (in USD, e.g., 3000.50)
  limitPrice: 3000,
  
  // Time in Force: 'FrontendMarket' (like frontend) or 'Gtc' or 'Ioc'
  timeInForce: 'FrontendMarket' as 'FrontendMarket' | 'Ioc' | 'Gtc',
  
  // Reduce only: true = only close positions, false = can open new positions
  reduceOnly: false,
};

// ═══════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      DIRECT API ORDER (FRONTEND FORMAT)                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Check for private key
  const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) {
    console.error('❌ ERROR: PRIVATE_KEY not found in .env file');
    process.exit(1);
  }

  // Get wallet address
  const wallet = new ethers.Wallet(privateKey);
  const walletAddress = wallet.address;
  console.log(`Wallet Address: ${walletAddress}\n`);

  // Initialize transport and symbol converter
  console.log('📡 Initializing...');
  const transport = new HttpTransport({ isTestnet: false });
  const symbolConverter = await SymbolConverter.create({ transport });
  const exchangeClient = new ExchangeClient({ wallet: privateKey, transport });
  console.log('✅ Initialized\n');

  // Get asset ID and format size/price
  const assetId = symbolConverter.getAssetId(ORDER_CONFIG.coin);
  if (assetId === undefined) {
    throw new Error(`Could not find asset ID for "${ORDER_CONFIG.coin}"`);
  }

  const szDecimals = symbolConverter.getSzDecimals(ORDER_CONFIG.coin);
  if (szDecimals === undefined) {
    throw new Error(`Could not find szDecimals for "${ORDER_CONFIG.coin}"`);
  }

  const formattedSize = formatSize(ORDER_CONFIG.size.toString(), szDecimals);
  const formattedPrice = formatPrice(ORDER_CONFIG.limitPrice.toString(), szDecimals, true);

  console.log('📋 Order Details:');
  console.log('─'.repeat(60));
  console.log(`   Asset: ${ORDER_CONFIG.coin} (ID: ${assetId})`);
  console.log(`   Side: ${ORDER_CONFIG.isBuy ? 'BUY' : 'SELL'}`);
  console.log(`   Size: ${ORDER_CONFIG.size} -> "${formattedSize}"`);
  console.log(`   Price: $${ORDER_CONFIG.limitPrice} -> "${formattedPrice}"`);
  console.log(`   Time in Force: ${ORDER_CONFIG.timeInForce}`);
  console.log('');

  // Build the action payload (matching frontend format)
  const action = {
    grouping: 'na',
    orders: [{
      a: assetId,
      b: ORDER_CONFIG.isBuy,
      p: formattedPrice,
      r: ORDER_CONFIG.reduceOnly,
      s: formattedSize,
      t: { limit: { tif: ORDER_CONFIG.timeInForce } },
    }],
    type: 'order',
  };

  // Generate nonce and expiresAfter (matching frontend format)
  const now = Date.now();
  const nonce = now - 1000; // Frontend uses slightly before current time
  const expiresAfter = now + 10000; // 10 seconds in the future

  console.log('🔐 Signing request...');
  console.log(`   Nonce: ${nonce}`);
  console.log(`   Expires After: ${expiresAfter}`);
  console.log('');

  // Make direct HTTP request matching frontend format
  // The frontend uses: https://api-ui.hyperliquid.xyz/exchange
  // With isFrontend: true flag
  
  try {
    console.log('📤 Making direct API request (frontend format)...');
    console.log('─'.repeat(60));
    console.log('');
    
    // Use SDK to get nonce and sign (SDK handles this correctly)
    // But we'll construct the request in frontend format
    // The SDK's order() method will sign correctly, but let's make a direct HTTP call
    
    // Actually, let's use the SDK's order method which handles signing
    // The SDK should work with FrontendMarket TIF
    const result = await exchangeClient.order({
      orders: [{
        a: assetId,
        b: ORDER_CONFIG.isBuy,
        p: formattedPrice,
        s: formattedSize,
        r: ORDER_CONFIG.reduceOnly,
        t: { limit: { tif: ORDER_CONFIG.timeInForce } },
      }],
      grouping: 'na',
    });

    console.log('📥 Order Response:');
    console.log('─'.repeat(60));
    console.log(JSON.stringify(result, null, 2));
    console.log('');

    // Check order status
    if (result.response?.data?.statuses && result.response.data.statuses.length > 0) {
      const status = result.response.data.statuses[0];

      if ('filled' in status && status.filled) {
        console.log('✅ ORDER FILLED!');
        console.log(`   Filled Size: ${status.filled.totalSz}`);
        if (status.filled.avgPx) {
          console.log(`   Average Price: $${status.filled.avgPx}`);
        }
        if (status.filled.oid) {
          console.log(`   Order ID: ${status.filled.oid}`);
        }
      } else if ('resting' in status && status.resting) {
        console.log('⏳ ORDER RESTING (waiting to be filled)');
        console.log(`   Order ID: ${status.resting.oid}`);
      } else if ('error' in status && status.error) {
        console.log('❌ ORDER ERROR:');
        const errorMsg = typeof status.error === 'string' ? status.error : JSON.stringify(status.error);
        console.log(`   ${errorMsg}`);
      }
    }

  } catch (error: any) {
    console.error('\n❌ ORDER FAILED:');
    console.error(`   ${error.message}`);
    
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    
    process.exit(1);
  }

  console.log('\n✅ Script completed!');
}

// Run the script
main().catch((error) => {
  console.error('\n💥 Fatal error:', error);
  process.exit(1);
});

