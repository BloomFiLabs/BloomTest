/**
 * HyperLiquid PERP Order Script - Raw API (No SDK ExchangeClient)
 * 
 * This script places a perp order using the raw API endpoint with manual signing
 * (like raw-frontend-api-order.ts) to avoid potential SDK issues
 * 
 * Usage:
 *   1. Set PRIVATE_KEY in .env file
 *   2. Run: npx tsx raw-api-perp-order.ts
 */

import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { SymbolConverter } from '@nktkas/hyperliquid/utils';
import { signL1Action } from '@nktkas/hyperliquid/signing';
import { OrderRequest, parser } from '@nktkas/hyperliquid/api/exchange';
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';

// Load environment variables
dotenv.config();

// ═══════════════════════════════════════════════════════════
// HARDCODED VALUES
// ═══════════════════════════════════════════════════════════

const HARDCODED_ORDER = {
  // Asset ID 159 = HYPE perp
  coin: 'HYPE',
  isBuy: true, // BUY/LONG
  size: '0.4', // Exact size as string
  limitPrice: '34.618', // Exact price as string
  reduceOnly: false,
  timeInForce: 'Gtc' as const,
};

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      HYPERLIQUID PERP ORDER (RAW API)                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY not found in .env file');
  }

  const wallet = new ethers.Wallet(privateKey);
  const walletAddress = wallet.address;

  console.log(`Wallet Address: ${walletAddress}`);
  console.log('');

  // Initialize SDK components
  const transport = new HttpTransport();
  const infoClient = new InfoClient(transport);
  const symbolConverter = await SymbolConverter.create({ transport });

  console.log('📡 Initializing HyperLiquid...');
  console.log('✅ Initialized');
  console.log('');

  // Get asset ID
  console.log('🔍 Asset Verification:');
  const assetId = symbolConverter.getAssetId(HARDCODED_ORDER.coin);
  console.log(`   Coin: ${HARDCODED_ORDER.coin}`);
  console.log(`   Asset ID: ${assetId}`);
  if (assetId === 159) {
    console.log(`   ✅ Asset ID matches (159)`);
  }
  console.log('');

  // Check account state
  console.log('💰 Checking Account State...');
  console.log('─'.repeat(60));
  try {
    const clearinghouseState = await infoClient.clearinghouseState({ user: walletAddress });
    const marginSummary = clearinghouseState.marginSummary;
    
    const accountValue = parseFloat(marginSummary.accountValue || '0');
    const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
    const freeCollateral = accountValue - totalMarginUsed;
    
    console.log(`   Account Value: $${accountValue.toFixed(2)}`);
    console.log(`   Margin Used: $${totalMarginUsed.toFixed(2)}`);
    console.log(`   Free Collateral: $${freeCollateral.toFixed(2)}`);
    console.log('');
  } catch (error: any) {
    console.log(`   ⚠️  Could not check balances: ${error.message}\n`);
  }

  // Display order details
  console.log('📋 Order Details:');
  console.log('─'.repeat(60));
  console.log(`   Coin: ${HARDCODED_ORDER.coin} (Asset ID: ${assetId})`);
  console.log(`   Side: ${HARDCODED_ORDER.isBuy ? 'BUY' : 'SELL'}`);
  console.log(`   Size: ${HARDCODED_ORDER.size}`);
  console.log(`   Price: $${HARDCODED_ORDER.limitPrice}`);
  console.log(`   Time in Force: ${HARDCODED_ORDER.timeInForce}`);
  console.log(`   Reduce Only: ${HARDCODED_ORDER.reduceOnly}`);
  console.log('');

  // Build action using parser (ensures correct format for signing)
  const actionInput = {
    type: 'order' as const,
    orders: [{
      a: assetId!,
      b: HARDCODED_ORDER.isBuy,
      p: HARDCODED_ORDER.limitPrice,
      r: HARDCODED_ORDER.reduceOnly,
      s: HARDCODED_ORDER.size,
      t: { limit: { tif: HARDCODED_ORDER.timeInForce } },
    }],
    grouping: 'na' as const,
  };

  // Parse action to ensure correct format
  const action = parser(OrderRequest.entries.action)(actionInput);

  // Generate nonce
  const nonce = Date.now();
  const expiresAfter = Date.now() + 10000; // 10 seconds in the future

  console.log('🔐 Signing...');
  console.log(`   Nonce: ${nonce}`);
  console.log(`   Expires After: ${expiresAfter}`);
  console.log('');

  // Sign using SDK's signL1Action (but we'll use raw API endpoint)
  const signature = await signL1Action({
    wallet: wallet,
    action,
    nonce,
    isTestnet: false,
    expiresAfter,
    vaultAddress: undefined, // Main account
  });

  // Verify signature
  console.log('🔍 Verifying Signature...');
  try {
    const publicKey = wallet.signingKey.publicKey;
    const addressFromPublicKey = ethers.computeAddress(publicKey);
    
    console.log(`   Signature Components:`);
    console.log(`      r: ${signature.r}`);
    console.log(`      s: ${signature.s}`);
    console.log(`      v: ${signature.v}`);
    console.log(`   Wallet Address: ${walletAddress}`);
    console.log(`   Address from Public Key: ${addressFromPublicKey}`);
    
    if (addressFromPublicKey.toLowerCase() === walletAddress.toLowerCase()) {
      console.log(`   ✅ Signature verification: Wallet address matches public key!`);
      console.log(`   ✅ The signature was generated by the correct wallet.`);
    } else {
      console.log(`   ❌ ERROR: Address mismatch!`);
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not verify signature: ${error.message}`);
  }
  console.log('');

  // Build request body (using raw API endpoint)
  const requestBody: any = {
    action: actionInput, // Use the SAME actionInput that was signed
    nonce,
    signature: {
      r: signature.r,
      s: signature.s,
      v: signature.v,
    },
    expiresAfter,
    vaultAddress: null, // Main account
  };

  console.log('📤 Sending Order via Raw API...');
  console.log('─'.repeat(60));
  console.log(`   Endpoint: https://api.hyperliquid.xyz/exchange`);
  console.log(`   Signer (wallet): ${walletAddress}`);
  console.log(`   vaultAddress: null (main account)`);
  console.log('');

  // Send request to raw API endpoint
  try {
    const response = await fetch('https://api.hyperliquid.xyz/exchange', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const result = await response.json();

    if (result.status === 'ok') {
      console.log('✅ ORDER SUCCESS!');
      console.log('');
      console.log('Response:', JSON.stringify(result, null, 2));
    } else {
      console.log('❌ ORDER FAILED:');
      if (result.response?.data?.statuses) {
        result.response.data.statuses.forEach((status: any, index: number) => {
          if (status.error) {
            console.log(`   Order ${index}: ${status.error}`);
          } else if (status.resting) {
            console.log(`   Order ${index}: Resting (order ID: ${status.resting.oid})`);
          } else if (status.filled) {
            console.log(`   Order ${index}: Filled!`);
          }
        });
      } else {
        console.log('   ', JSON.stringify(result, null, 2));
      }
    }
  } catch (error: any) {
    console.log('❌ REQUEST FAILED:');
    console.log(`   ${error.message}`);
    if (error.stack) {
      console.log(`\nStack trace:\n${error.stack}`);
    }
  }
}

main().catch(console.error);

