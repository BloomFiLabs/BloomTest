/**
 * HyperLiquid Signature Generator - Manual EIP-712 Implementation
 * 
 * This script manually implements EIP-712 signing for HyperLiquid orders
 * without relying on the SDK's signL1Action function.
 * 
 * CRITICAL: The action MUST be parsed using the SDK's parser before hashing!
 * The parser ensures the action is in the exact format HyperLiquid expects for msgpack encoding.
 * 
 * Based on HyperLiquid's actual signing implementation:
 * - Domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000..." }
 * - Types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] }
 * - Message: { source: "a" (mainnet) or "b" (testnet), connectionId: actionHash }
 * 
 * Usage:
 *   1. Set PRIVATE_KEY in .env file
 *   2. Modify the order parameters below
 *   3. Run: npx tsx generate-signature-manual.ts
 *   4. Copy the request body to Postman and send immediately (signature expires in ~10 seconds)
 */

import * as dotenv from 'dotenv';
import { ethers } from 'ethers';
import { createL1ActionHash } from '@nktkas/hyperliquid/signing';
import { OrderRequest, parser } from '@nktkas/hyperliquid/api/exchange';

// Load environment variables
dotenv.config();

// ═══════════════════════════════════════════════════════════
// ORDER CONFIGURATION - Modify these values
// ═══════════════════════════════════════════════════════════

const ORDER_CONFIG = {
  coin: 'HYPE', // Asset name (will be converted to asset ID)
  isBuy: true, // true = BUY/LONG, false = SELL/SHORT
  size: '0.4', // Order size as string
  limitPrice: '34.618', // Limit price as string
  reduceOnly: false, // true = only close positions
  timeInForce: 'Gtc' as const, // 'Ioc' | 'Gtc'
  vaultAddress: null as string | null, // Sub-account address (null for main account)
};

// ═══════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════

/**
 * Get asset ID from coin name
 */
async function getAssetId(coin: string): Promise<number> {
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
  });
  const data = await response.json();
  const asset = data.universe.find((a: any) => a.name === coin);
  if (!asset) {
    throw new Error(`Asset ${coin} not found`);
  }
  return data.universe.indexOf(asset);
}

// Using SDK's createL1ActionHash for correct msgpack encoding
// This ensures we use the exact same implementation HyperLiquid expects

/**
 * Sign typed data using EIP-712
 */
async function signTypedData(
  wallet: ethers.Wallet,
  domain: { name: string; version: string; chainId: number; verifyingContract: string },
  types: Record<string, Array<{ name: string; type: string }>>,
  primaryType: string,
  message: Record<string, any>
): Promise<{ r: string; s: string; v: number }> {
  // Use ethers.js _signTypedData method
  const signature = await wallet.signTypedData(domain, types, message);
  
  // Parse signature
  const sig = ethers.Signature.from(signature);
  
  return {
    r: sig.r,
    s: sig.s,
    v: sig.v,
  };
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   HYPERLIQUID SIGNATURE GENERATOR (MANUAL EIP-712)      ║');
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

  // Get asset ID
  console.log('🔍 Getting Asset ID...');
  const assetId = await getAssetId(ORDER_CONFIG.coin);
  console.log(`   Asset: ${ORDER_CONFIG.coin} (Asset ID: ${assetId})`);
  console.log('');

  // Build action input (raw format)
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

  // CRITICAL: Parse action to ensure correct format for signing
  // The parser ensures the action matches HyperLiquid's exact expected format
  // This is essential - without parsing, the hash will be wrong!
  const action = parser(OrderRequest.entries.action)(actionInput);
  
  console.log('📋 Action Details:');
  console.log(`   Raw Input: ${JSON.stringify(actionInput, null, 2)}`);
  console.log(`   Parsed Action: ${JSON.stringify(action, null, 2)}`);
  console.log('');

  // Generate nonce
  const nonce = Date.now();
  const expiresAfter = Date.now() + 10000; // 10 seconds in the future

  console.log('🔐 Creating Action Hash...');
  console.log(`   Using PARSED action for hashing (this is critical!)`);
  console.log(`   Action JSON: ${JSON.stringify(action)}`);
  
  const actionHash = createL1ActionHash({
    action, // Use the PARSED action
    nonce,
    vaultAddress: ORDER_CONFIG.vaultAddress,
    expiresAfter,
  });
  console.log(`   Action Hash: ${actionHash}`);
  console.log(`   Nonce: ${nonce}`);
  console.log(`   Vault Address: ${ORDER_CONFIG.vaultAddress || 'null'}`);
  console.log(`   Expires After: ${expiresAfter}`);
  console.log('');

  // EIP-712 Domain (HyperLiquid's exact domain)
  const domain = {
    name: 'Exchange',
    version: '1',
    chainId: 1337, // HyperLiquid requires chainId to be 1337
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };

  // EIP-712 Types
  const types = {
    Agent: [
      { name: 'source', type: 'string' },
      { name: 'connectionId', type: 'bytes32' },
    ],
  };

  // EIP-712 Message
  const message = {
    source: 'a', // 'a' for mainnet, 'b' for testnet
    connectionId: actionHash,
  };

  console.log('🔐 Signing with EIP-712...');
  console.log(`   Domain: ${JSON.stringify(domain, null, 2)}`);
  console.log(`   Message: ${JSON.stringify(message, null, 2)}`);
  console.log('');

  // Sign
  const signature = await signTypedData(wallet, domain, types, 'Agent', message);

  // Build request body
  // CRITICAL: Use the EXACT SAME PARSED action that was used for hashing
  // Any difference will cause HyperLiquid to recover a different address!
  const requestBody: any = {
    action, // MUST be the same parsed action object used for createL1ActionHash
    nonce, // MUST match the nonce used for hashing
    signature: {
      r: signature.r,
      s: signature.s,
      v: signature.v,
    },
    expiresAfter, // MUST match the expiresAfter used for hashing
    vaultAddress: ORDER_CONFIG.vaultAddress || null, // MUST match the vaultAddress used for hashing
  };
  
  console.log('⚠️  CRITICAL: Ensure the action in the request body matches EXACTLY what was hashed!');
  console.log(`   Request action JSON: ${JSON.stringify(requestBody.action)}`);
  console.log(`   Hashed action JSON: ${JSON.stringify(action)}`);
  console.log(`   Match: ${JSON.stringify(requestBody.action) === JSON.stringify(action) ? '✅ YES' : '❌ NO - THIS WILL FAIL!'}`);
  console.log('');

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
  console.log(`curl -X POST https://api.hyperliquid.xyz/exchange \\`);
  console.log(`  -H "Content-Type: application/json" \\`);
  console.log(`  -d '${JSON.stringify(requestBody)}'`);
  console.log('');

  // Verify signature by recovering address
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🔍 SIGNATURE VERIFICATION:');
  console.log('═══════════════════════════════════════════════════════════');
  try {
    // Recover address from signature
    const recoveredAddress = ethers.verifyTypedData(domain, types, message, signature);
    
    console.log(`   Wallet Address: ${walletAddress}`);
    console.log(`   Recovered Address: ${recoveredAddress}`);
    console.log(`   Action Hash: ${actionHash}`);
    console.log(`   Nonce: ${nonce}`);
    console.log('');
    
    if (recoveredAddress.toLowerCase() === walletAddress.toLowerCase()) {
      console.log('✅ Signature verification: PASSED');
      console.log(`   ✅ The signature will recover to the correct wallet address`);
      console.log(`   ✅ HyperLiquid should accept this signature`);
    } else {
      console.log('❌ Signature verification: FAILED');
      console.log(`   ❌ Expected: ${walletAddress}`);
      console.log(`   ❌ Recovered: ${recoveredAddress}`);
      console.log(`   ⚠️  This signature will NOT work - HyperLiquid will reject it!`);
      console.log(`   ⚠️  Check: EIP-712 domain, types, message format`);
    }
  } catch (error: any) {
    console.log(`❌ Could not verify signature: ${error.message}`);
    console.log(`   Error details: ${error.stack || 'N/A'}`);
  }
}

main().catch(console.error);

