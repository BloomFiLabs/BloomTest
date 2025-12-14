/**
 * Test script to generate EIP712 signature for Aster withdrawals
 * Follows the exact specification from Aster API documentation
 */

import * as dotenv from 'dotenv';
import axios from 'axios';
import { ethers } from 'ethers';
import * as crypto from 'crypto';

dotenv.config();

const FAPI_BASE_URL = 'https://fapi.asterdex.com';
const BAPI_BASE_URL = 'https://www.asterdex.com';
const API_KEY = process.env.ASTER_API_KEY;
const API_SECRET = process.env.ASTER_API_SECRET || process.env.ASTER_API_SECRET_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.ASTER_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('❌ ERROR: PRIVATE_KEY or ASTER_PRIVATE_KEY must be set in .env');
  process.exit(1);
}

if (!API_KEY || !API_SECRET) {
  console.error('❌ ERROR: ASTER_API_KEY and ASTER_API_SECRET must be set in .env');
  process.exit(1);
}

/**
 * Chain name mapping (per Aster documentation)
 */
const CHAIN_NAME_MAP: Record<number, string> = {
  56: 'BSC',
  42161: 'Arbitrum',
  1: 'ETH',
};

/**
 * Generate EIP712 signature for Aster withdrawal
 */
async function generateEIP712Signature(params: {
  destination: string;
  chainId: number;
  token: string;
  amount: string;
  fee: string;
}): Promise<{
  signature: string;
  nonce: string;
  nonceValue: number;
  message: any;
  domain: any;
  types: any;
}> {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      ASTER EIP712 WITHDRAWAL SIGNATURE GENERATOR         ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Initialize wallet
  if (!PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY is required');
  }
  const normalizedPrivateKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const wallet = new ethers.Wallet(normalizedPrivateKey);
  console.log(`🔐 Wallet Address: ${wallet.address}\n`);

  // Step 1: Generate nonce (current timestamp in milliseconds * 1000)
  const nonceMs = Date.now();
  const nonceValue = nonceMs * 1000; // Convert to microseconds
  const nonceString = nonceValue.toString();

  console.log('📋 Withdrawal Parameters:');
  console.log(`   Destination: ${params.destination}`);
  console.log(`   Chain ID: ${params.chainId} (${CHAIN_NAME_MAP[params.chainId] || 'Unknown'})`);
  console.log(`   Token: ${params.token}`);
  console.log(`   Amount: ${params.amount}`);
  console.log(`   Fee: ${params.fee}`);
  console.log(`   Nonce: ${nonceString} (${nonceMs}ms * 1000)\n`);

  // Step 2: Build EIP712 Domain (per Aster documentation)
  const domain = {
    name: 'Aster',
    version: '1',
    chainId: params.chainId, // The chainId of withdraw chain
    verifyingContract: '0x0000000000000000000000000000000000000000', // Fixed zero address
  };

  console.log('📝 EIP712 Domain:');
  console.log(`   name: "${domain.name}"`);
  console.log(`   version: "${domain.version}"`);
  console.log(`   chainId: ${domain.chainId}`);
  console.log(`   verifyingContract: ${domain.verifyingContract}\n`);

  // Step 3: Build EIP712 Types (per Aster documentation)
  const types = {
    Action: [
      { name: 'type', type: 'string' },
      { name: 'destination', type: 'address' },
      { name: 'destination Chain', type: 'string' },
      { name: 'token', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'fee', type: 'string' },
      { name: 'nonce', type: 'uint256' },
      { name: 'aster chain', type: 'string' },
    ],
  };

  console.log('📝 EIP712 Types:');
  console.log(`   Primary type: Action`);
  types.Action.forEach((field) => {
    console.log(`   - ${field.name}: ${field.type}`);
  });
  console.log('');

  // Step 4: Build EIP712 Message (per Aster documentation)
  const destinationChain = CHAIN_NAME_MAP[params.chainId] || 'Arbitrum';
  const message = {
    type: 'Withdraw', // Fixed string 'Withdraw'
    destination: params.destination.toLowerCase(), // Receipt address
    'destination Chain': destinationChain, // Chain name (BSC, Arbitrum, ETH)
    token: params.token.toUpperCase(), // Currency name (e.g., USDT, USDC)
    amount: params.amount, // Amount in token unit (e.g., '1.23')
    fee: params.fee, // Fee in token unit (e.g., '0.01')
    nonce: nonceValue, // Number (ethers.js converts to uint256)
    'aster chain': 'Mainnet', // Fixed string 'Mainnet'
  };

  console.log('📝 EIP712 Message:');
  console.log(`   type: "${message.type}"`);
  console.log(`   destination: ${message.destination}`);
  console.log(`   destination Chain: "${message['destination Chain']}"`);
  console.log(`   token: "${message.token}"`);
  console.log(`   amount: "${message.amount}"`);
  console.log(`   fee: "${message.fee}"`);
  console.log(`   nonce: ${message.nonce}`);
  console.log(`   aster chain: "${message['aster chain']}"\n`);

  // Step 5: Sign using EIP712 typed data
  console.log('✍️  Signing with wallet (EIP712)...');
  const userSignature = await wallet.signTypedData(domain, types, message);
  console.log(`   ✅ EIP712 Signature: ${userSignature}\n`);

  return {
    signature: userSignature,
    nonce: nonceString,
    nonceValue,
    message,
    domain,
    types,
  };
}

/**
 * Get withdrawal fee estimate from Aster API
 */
async function getWithdrawalFee(
  chainId: number,
  currency: string,
  accountType: string = 'spot'
): Promise<string> {
  try {
    const response = await axios.get(
      `${BAPI_BASE_URL}/bapi/futures/v1/public/future/aster/estimate-withdraw-fee`,
      {
        params: {
          chainId,
          network: 'EVM',
          currency: currency.toUpperCase(),
          accountType,
        },
        timeout: 10000,
      }
    );

    if (response.data?.success && response.data?.data?.gasCost !== undefined) {
      return response.data.data.gasCost.toString();
    } else {
      throw new Error('Unexpected response format');
    }
  } catch (error: any) {
    console.log(`   ⚠️  Failed to query fee from API: ${error.message}`);
    console.log(`   Using default fee: 0.5\n`);
    return '0.5'; // Fallback
  }
}

/**
 * Test withdrawal using the generated signature
 */
async function testWithdrawal(params: {
  destination: string;
  chainId: number;
  token: string;
  amount: string;
  fee?: string;
  testMode?: boolean;
}) {
  console.log('═══════════════════════════════════════════════════════════\n');

  // Get fee if not provided
  let fee = params.fee;
  if (!fee) {
    console.log('💰 Querying withdrawal fee from API...');
    fee = await getWithdrawalFee(params.chainId, params.token);
    console.log(`   ✅ Fee: ${fee} ${params.token}\n`);
  }

  // Generate EIP712 signature
  const { signature: userSignature, nonce } = await generateEIP712Signature({
    destination: params.destination,
    chainId: params.chainId,
    token: params.token,
    amount: params.amount,
    fee: fee!,
  });

  // Build HMAC parameters for /fapi/aster/user-withdraw endpoint
  // Parameters: chainId, asset, amount, fee, receiver, nonce, userSignature, recvWindow, timestamp
  const timestamp = Date.now();
  const recvWindow = 60000;

  const hmacParams: Record<string, any> = {
    chainId: params.chainId.toString(),
    asset: params.token.toUpperCase(),
    amount: params.amount,
    fee: fee,
    receiver: params.destination.toLowerCase(),
    nonce: nonce,
    userSignature: userSignature, // EIP712 signature - included in HMAC
    recvWindow: recvWindow,
    timestamp: timestamp,
  };

  // Remove null/undefined values
  const cleanParams = Object.fromEntries(
    Object.entries(hmacParams).filter(([, value]) => value !== null && value !== undefined)
  );

  // Build query string for HMAC signing (sorted alphabetically)
  const queryString = Object.keys(cleanParams)
    .sort()
    .map((key) => `${key}=${cleanParams[key]}`) // No URL encoding
    .join('&');

  // Create HMAC SHA256 signature using PRIVATE_KEY
  if (!PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY is required for HMAC signing');
  }
  const privateKeyForHmac = PRIVATE_KEY.replace(/^0x/, '');
  const hmacSignature = crypto.createHmac('sha256', privateKeyForHmac)
    .update(queryString)
    .digest('hex');

  // Build final query string with signature last
  const finalQueryString = `${queryString}&signature=${hmacSignature}`;

  console.log('📤 Withdrawal Request Details:');
  console.log(`   Method: POST`);
  console.log(`   URL: ${FAPI_BASE_URL}/fapi/aster/user-withdraw`);
  console.log(`   Query String (first 300 chars): ${finalQueryString.substring(0, 300)}...`);
  console.log(`   Headers: X-MBX-APIKEY: ${API_KEY?.substring(0, 10)}...\n`);

  if (params.testMode !== false) {
    console.log('⚠️  WARNING: This will attempt a REAL withdrawal!\n');
    console.log('Press Ctrl+C within 5 seconds to cancel...\n');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  try {
    const response = await axios.post(
      `${FAPI_BASE_URL}/fapi/aster/user-withdraw?${finalQueryString}`,
      {}, // Empty body
      {
        headers: {
          'Content-Type': 'application/json',
          'X-MBX-APIKEY': API_KEY!,
        },
        timeout: 30000,
      }
    );

    console.log('✅ Withdrawal Response:');
    console.log(`   Status: ${response.status} ${response.statusText}`);
    console.log(`   Data: ${JSON.stringify(response.data, null, 2)}\n`);

    if (response.data && response.data.withdrawId) {
      const withdrawId = response.data.withdrawId;
      const hash = response.data.hash || 'unknown';
      console.log(`✅✅✅ WITHDRAWAL SUCCESSFUL! ✅✅✅`);
      console.log(`   Withdrawal ID: ${withdrawId}`);
      console.log(`   Hash: ${hash}`);
      console.log(`   Amount: ${params.amount} ${params.token}`);
      console.log(`   To: ${params.destination}`);
      console.log(`\n   Check your wallet on ${CHAIN_NAME_MAP[params.chainId] || 'the destination chain'} to confirm receipt!\n`);
    } else {
      console.log('⚠️  Response received but format unexpected');
      console.log(`   Full response: ${JSON.stringify(response.data, null, 2)}\n`);
    }

    return response.data;
  } catch (error: any) {
    console.error('\n❌ Withdrawal failed:');
    if (error.response) {
      console.error(`   Status: ${error.response.status} ${error.response.statusText}`);
      console.error(`   Error Code: ${error.response.data?.code || 'N/A'}`);
      console.error(`   Error Message: ${error.response.data?.msg || error.response.data?.message || 'N/A'}`);
      console.error(`   Full Response: ${JSON.stringify(error.response.data, null, 2)}`);
    } else if (error.request) {
      console.error(`   No response received: ${error.message}`);
    } else {
      console.error(`   Request setup error: ${error.message}`);
    }
    throw error;
  }
}

// Main execution
async function main() {
  // Example parameters - modify as needed
  // Testing with exact same values from adapter failure
  const testParams = {
    destination: '0xa90714a15d6e5c0eb3096462De8dc4B22E01589A', // Your wallet address
    chainId: 42161, // Arbitrum (change to 56 for BSC, 1 for ETH)
    token: 'USDC', // Currency to withdraw
    amount: '6.83', // Amount to withdraw (exact same as adapter failure)
    fee: '0.51', // Exact same fee as adapter
    testMode: false, // Set to true to skip the 5-second countdown
  };

  try {
    await testWithdrawal(testParams);
  } catch (error: any) {
    console.error('\n❌ Script failed:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main()
    .then(() => {
      console.log('✅ Script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Script failed:', error.message);
      process.exit(1);
    });
}

export { generateEIP712Signature, testWithdrawal, getWithdrawalFee };

