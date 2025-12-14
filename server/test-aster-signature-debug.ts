/**
 * Debug script to test Aster withdrawal signature generation
 * Uses exact values from adapter logs to reproduce and debug signature mismatch
 */

import * as dotenv from 'dotenv';
import axios from 'axios';
import { ethers } from 'ethers';
import * as crypto from 'crypto';

dotenv.config();

const FAPI_BASE_URL = 'https://fapi.asterdex.com';
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

const CHAIN_NAME_MAP: Record<number, string> = {
  56: 'BSC',
  42161: 'Arbitrum',
  1: 'ETH',
};

/**
 * Test signature generation with exact values from adapter logs
 */
async function testSignatureGeneration() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      ASTER SIGNATURE DEBUG - EXACT ADAPTER VALUES       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Exact values from adapter logs (line 399, 404, 407)
  const testParams = {
    destination: '0xa90714a15d6e5c0eb3096462de8dc4b22e01589a',
    chainId: 42161,
    token: 'USDC',
    amount: '7.76', // Exact from adapter log line 404
    fee: '0.51', // Exact from adapter log
    nonce: 1764642521314000, // Exact from adapter log line 404
    timestamp: 1764642521316, // Exact from adapter log line 404
    expectedUserSignature: '0x252f2fd8df1c3577fb', // Partial from adapter log line 400
    expectedHmacSignature: '0ac13fdb1824ac92f7800991d84ab35af9865f7350c5a22a75064595b8143e26', // From adapter log line 406
    expectedWallet: '0x215A3380a178681183761Ed1BF541aA56F034d32', // From adapter log line 400
  };

  console.log('📋 Test Parameters (from adapter logs):');
  console.log(`   Destination: ${testParams.destination}`);
  console.log(`   Chain ID: ${testParams.chainId}`);
  console.log(`   Token: ${testParams.token}`);
  console.log(`   Amount: ${testParams.amount}`);
  console.log(`   Fee: ${testParams.fee}`);
  console.log(`   Nonce: ${testParams.nonce}`);
  console.log(`   Timestamp: ${testParams.timestamp}`);
  console.log(`   Expected User Signature (partial): ${testParams.expectedUserSignature}...`);
  console.log(`   Expected HMAC Signature: ${testParams.expectedHmacSignature}\n`);

  // Initialize wallet
  if (!PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY is required');
  }
  const normalizedPrivateKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
  const wallet = new ethers.Wallet(normalizedPrivateKey);
  console.log(`🔐 Wallet Address: ${wallet.address}`);
  console.log(`   Expected Wallet: ${testParams.expectedWallet}`);
  console.log(`   Match: ${wallet.address.toLowerCase() === testParams.expectedWallet.toLowerCase() ? '✅ YES' : '❌ NO - USING DIFFERENT WALLET!'}\n`);

  // Step 1: Build EIP712 domain
  const domain = {
    name: 'Aster',
    version: '1',
    chainId: testParams.chainId,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };

  // Step 2: Build EIP712 types
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

  // Step 3: Build EIP712 message (using exact values from adapter)
  const destinationChain = CHAIN_NAME_MAP[testParams.chainId] || 'Arbitrum';
  const message = {
    type: 'Withdraw',
    destination: testParams.destination.toLowerCase(),
    'destination Chain': destinationChain,
    token: testParams.token.toUpperCase(),
    amount: testParams.amount, // Exact string from adapter
    fee: testParams.fee, // Exact string from adapter
    nonce: testParams.nonce, // Exact number from adapter
    'aster chain': 'Mainnet',
  };

  console.log('📝 EIP712 Message:');
  console.log(JSON.stringify(message, null, 2));
  console.log('');

  // Step 4: Generate EIP712 signature
  console.log('✍️  Generating EIP712 signature...');
  const userSignature = await wallet.signTypedData(domain, types, message);
  console.log(`   Generated: ${userSignature}`);
  console.log(`   Expected (partial): ${testParams.expectedUserSignature}...`);
  console.log(`   Match: ${userSignature.startsWith(testParams.expectedUserSignature) ? '✅ YES' : '❌ NO'}\n`);

  // Step 5: Build HMAC parameters (exact same as adapter)
  const hmacParams: Record<string, any> = {
    chainId: testParams.chainId.toString(),
    asset: testParams.token.toUpperCase(),
    amount: testParams.amount, // Same string as EIP712 message
    fee: testParams.fee,
    receiver: testParams.destination.toLowerCase(),
    nonce: testParams.nonce.toString(), // Convert to string
    userSignature: userSignature, // EIP712 signature
    recvWindow: 60000,
    timestamp: testParams.timestamp, // Exact timestamp from adapter
  };

  console.log('📝 HMAC Parameters:');
  console.log(JSON.stringify(hmacParams, null, 2));
  console.log('');

  // Step 6: Remove null/undefined values
  const cleanParams = Object.fromEntries(
    Object.entries(hmacParams).filter(([, value]) => value !== null && value !== undefined)
  );

  // Step 7: Build query string for HMAC signing
  const queryString = Object.keys(cleanParams)
    .sort()
    .map((key) => `${key}=${cleanParams[key]}`) // No URL encoding
    .join('&');

  console.log('📝 Query String for HMAC:');
  console.log(`   ${queryString}`);
  console.log(`   Length: ${queryString.length}`);
  console.log('');

  // Step 8: Generate HMAC signature
  if (!PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY is required for HMAC');
  }
  const privateKeyForHmac = PRIVATE_KEY.replace(/^0x/, '');
  const hmacSignature = crypto.createHmac('sha256', privateKeyForHmac)
    .update(queryString)
    .digest('hex');

  console.log('🔐 HMAC Signature:');
  console.log(`   Generated: ${hmacSignature}`);
  console.log(`   Expected: ${testParams.expectedHmacSignature}`);
  console.log(`   Match: ${hmacSignature === testParams.expectedHmacSignature ? '✅ YES' : '❌ NO'}\n`);

  // Step 9: Build final query string
  const finalQueryString = `${queryString}&signature=${hmacSignature}`;

  console.log('📤 Final Request:');
  console.log(`   URL: ${FAPI_BASE_URL}/fapi/aster/user-withdraw`);
  console.log(`   Query String (first 300 chars): ${finalQueryString.substring(0, 300)}...`);
  console.log('');

  // Step 10: Test the actual request
  console.log('🚀 Testing actual withdrawal request...\n');
  try {
    const response = await axios.post(
      `${FAPI_BASE_URL}/fapi/aster/user-withdraw?${finalQueryString}`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          'X-MBX-APIKEY': API_KEY!,
        },
        timeout: 30000,
      }
    );

    console.log('✅ Withdrawal Response:');
    console.log(`   Status: ${response.status}`);
    console.log(`   Data: ${JSON.stringify(response.data, null, 2)}\n`);

    if (response.data && response.data.withdrawId) {
      console.log(`✅✅✅ SUCCESS! ✅✅✅`);
      console.log(`   Withdrawal ID: ${response.data.withdrawId}`);
      console.log(`   Hash: ${response.data.hash || 'unknown'}\n`);
    }
  } catch (error: any) {
    console.error('❌ Request failed:');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Code: ${error.response.data?.code}`);
      console.error(`   Message: ${error.response.data?.msg}`);
      console.error(`   Full Response: ${JSON.stringify(error.response.data, null, 2)}`);
    } else {
      console.error(`   Error: ${error.message}`);
    }
  }
}

// Run the test
testSignatureGeneration()
  .then(() => {
    console.log('✅ Debug test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Debug test failed:', error.message);
    process.exit(1);
  });

