/**
 * HyperLiquid Signature Generator
 * 
 * This script generates the signature (r, s, v) for a HyperLiquid order
 * so you can manually call the API with Postman or curl
 * 
 * Usage:
 *   1. Set PRIVATE_KEY in .env file
 *   2. Modify the order parameters below
 *   3. Run: npx tsx generate-signature.ts
 *   4. Copy the signature and request body to Postman
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
// ORDER CONFIGURATION - Modify these values
// ═══════════════════════════════════════════════════════════

const ORDER_CONFIG = {
  coin: 'HYPE', // Asset name (e.g., 'HYPE', 'ETH', 'BTC')
  isBuy: true, // true = BUY/LONG, false = SELL/SHORT
  size: '0.4', // Order size as string
  limitPrice: '34.618', // Limit price as string
  reduceOnly: false, // true = only close positions
  timeInForce: 'Gtc' as const, // 'Ioc' | 'Gtc' | 'FrontendMarket'
  vaultAddress: null as string | null, // Sub-account address (null for main account)
};

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      HYPERLIQUID SIGNATURE GENERATOR                    ║');
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
  const symbolConverter = await SymbolConverter.create({ transport });

  // Get asset ID
  const assetId = symbolConverter.getAssetId(ORDER_CONFIG.coin);
  console.log(`Asset: ${ORDER_CONFIG.coin} (Asset ID: ${assetId})`);
  console.log('');

  // Build action
  const actionInput = {
    type: 'order' as const,
    orders: [{
      a: assetId,
      b: ORDER_CONFIG.isBuy,
      p: ORDER_CONFIG.limitPrice,
      r: ORDER_CONFIG.reduceOnly,
      s: ORDER_CONFIG.size,
      t: { limit: { tif: ORDER_CONFIG.timeInForce } },
    }],
    grouping: 'na' as const,
  };

  // Parse action to ensure correct format
  const action = parser(OrderRequest.entries.action)(actionInput);

  // Generate nonce
  const nonce = Date.now();
  const expiresAfter = Date.now() + 10000; // 10 seconds in the future

  console.log('🔐 Generating Signature...');
  console.log(`   Nonce: ${nonce}`);
  console.log(`   Expires After: ${expiresAfter}`);
  console.log('');

  // Sign
  const signature = await signL1Action({
    wallet: wallet,
    action,
    nonce,
    isTestnet: false,
    expiresAfter,
    vaultAddress: ORDER_CONFIG.vaultAddress || undefined,
  });

  // Build request body
  const requestBody: any = {
    action: actionInput,
    nonce,
    signature: {
      r: signature.r,
      s: signature.s,
      v: signature.v,
    },
    expiresAfter,
    vaultAddress: ORDER_CONFIG.vaultAddress || null,
  };

  // Output
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📋 SIGNATURE COMPONENTS:');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`r: ${signature.r}`);
  console.log(`s: ${signature.s}`);
  console.log(`v: ${signature.v}`);
  console.log('');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('📤 REQUEST BODY (JSON):');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(JSON.stringify(requestBody, null, 2));
  console.log('');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('🌐 API ENDPOINT:');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('POST https://api.hyperliquid.xyz/exchange');
  console.log('Content-Type: application/json');
  console.log('');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('📝 cURL COMMAND:');
  console.log('═══════════════════════════════════════════════════════════');
  const curlBody = JSON.stringify(requestBody).replace(/"/g, '\\"');
  console.log(`curl -X POST https://api.hyperliquid.xyz/exchange \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '${JSON.stringify(requestBody)}'`);
  console.log('');

  // Verify signature
  try {
    const publicKey = wallet.signingKey.publicKey;
    const addressFromPublicKey = ethers.computeAddress(publicKey);
    
    if (addressFromPublicKey.toLowerCase() === walletAddress.toLowerCase()) {
      console.log('✅ Signature verification: PASSED');
    } else {
      console.log('❌ Signature verification: FAILED');
    }
  } catch (error: any) {
    console.log(`⚠️  Could not verify signature: ${error.message}`);
  }
}

main().catch(console.error);

