/**
 * Simple Aster withdrawal test script
 * Tests if withdrawals actually work by attempting a small withdrawal
 */

import * as dotenv from 'dotenv';
import axios from 'axios';
import * as crypto from 'crypto';

dotenv.config();

const ASTER_BASE_URL = 'https://fapi.asterdex.com';
const API_KEY = process.env.ASTER_API_KEY;
const API_SECRET = process.env.ASTER_API_SECRET || process.env.ASTER_API_SECRET_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.ASTER_PRIVATE_KEY;

if (!API_KEY || !API_SECRET) {
  console.error('❌ ERROR: ASTER_API_KEY and ASTER_API_SECRET must be set in .env');
  process.exit(1);
}

if (!PRIVATE_KEY) {
  console.error('❌ ERROR: PRIVATE_KEY or ASTER_PRIVATE_KEY must be set in .env for withdrawal signing');
  process.exit(1);
}

/**
 * Sign parameters with HMAC SHA256 (matches adapter implementation exactly)
 */
function signParams(params: Record<string, any>): Record<string, any> {
  const cleanParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== null && value !== undefined),
  );

  cleanParams.timestamp = Date.now();
  cleanParams.recvWindow = cleanParams.recvWindow ?? 50000;

  const queryString = Object.keys(cleanParams)
    .sort()
    .map((key) => `${key}=${cleanParams[key]}`)
    .join('&');

  // Use PRIVATE_KEY for HMAC signing (matches adapter - user requirement)
  // Remove 0x prefix if present
  const privateKeyHex = PRIVATE_KEY!.replace(/^0x/, '');

  const signature = crypto
    .createHmac('sha256', privateKeyHex)
    .update(queryString)
    .digest('hex');

  return {
    ...cleanParams,
    signature,
  };
}

async function checkBalance() {
  console.log('💰 Checking account balance...\n');
  
  try {
    // Use API_SECRET for account info (not PRIVATE_KEY)
    const cleanParams: Record<string, any> = {
      timestamp: Date.now(),
      recvWindow: 50000,
    };
    
    const queryString = Object.keys(cleanParams)
      .sort()
      .map((key) => `${key}=${cleanParams[key]}`)
      .join('&');
    
    const signature = crypto
      .createHmac('sha256', API_SECRET!)
      .update(queryString)
      .digest('hex');
    
    const params = { ...cleanParams, signature };
    const queryParams: string[] = [];
    const signatureParam: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (key === 'signature') {
        signatureParam.push(`${key}=${value}`);
      } else {
        queryParams.push(`${key}=${value}`);
      }
    }
    queryParams.sort();
    const finalQueryString = queryParams.join('&') + (signatureParam.length > 0 ? `&${signatureParam[0]}` : '');

    const response = await axios.get(
      `${ASTER_BASE_URL}/fapi/v4/account?${finalQueryString}`,
      {
        headers: {
          'X-MBX-APIKEY': API_KEY!,
        },
        timeout: 10000,
      }
    );

    const assets = response.data?.assets || [];
    const usdtAsset = assets.find((a: any) => a.asset === 'USDT');
    
    if (usdtAsset) {
      console.log(`✅ USDT Balance: ${usdtAsset.walletBalance}`);
      console.log(`   Available: ${usdtAsset.availableBalance}`);
      console.log(`   Max Withdraw: ${usdtAsset.maxWithdrawAmount}\n`);
      return parseFloat(usdtAsset.availableBalance || '0');
    } else {
      console.log('⚠️  USDT asset not found in account\n');
      return 0;
    }
  } catch (error: any) {
    console.log(`❌ Balance check failed: ${error.response?.data?.msg || error.message}\n`);
    return 0;
  }
}

async function testWithdrawal() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      ASTER WITHDRAWAL TEST (LIVE)                       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Check balance first
  const balance = await checkBalance();
  
  if (balance < 2) {
    console.log('⚠️  Insufficient balance for withdrawal test (need at least $2 USDT)');
    console.log('   Skipping withdrawal test\n');
    return;
  }

  // Test parameters - use small amount
  const testParams = {
    asset: 'USDT',
    amount: '1.0', // Small test amount
    address: '0xa90714a15d6e5c0eb3096462de8dc4b22e01589a', // Your wallet
    chainId: '42161', // Arbitrum
  };

  console.log('📋 Withdrawal Parameters:');
  console.log(`   Asset: ${testParams.asset}`);
  console.log(`   Amount: ${testParams.amount} USDT`);
  console.log(`   Address: ${testParams.address}`);
  console.log(`   Chain ID: ${testParams.chainId} (Arbitrum)\n`);

  console.log('⚠️  WARNING: This will attempt a REAL withdrawal!\n');
  console.log('Press Ctrl+C within 5 seconds to cancel...\n');
  
  await new Promise(resolve => setTimeout(resolve, 5000));

  try {
    // Sign the parameters
    console.log('🔐 Signing parameters...');
    const signedParams = signParams({
      asset: testParams.asset,
      amount: testParams.amount,
      address: testParams.address,
      chainId: testParams.chainId,
    });

    // Build query string with signature last
    const queryParams: string[] = [];
    const signatureParam: string[] = [];
    for (const [key, value] of Object.entries(signedParams)) {
      if (key === 'signature') {
        signatureParam.push(`${key}=${value}`);
      } else {
        queryParams.push(`${key}=${value}`);
      }
    }
    queryParams.sort();
    const finalQueryString = queryParams.join('&') + (signatureParam.length > 0 ? `&${signatureParam[0]}` : '');

    console.log('📤 Sending withdrawal request...\n');

    const response = await axios.post(
      `${ASTER_BASE_URL}/fapi/v1/withdraw?${finalQueryString}`,
      {}, // Empty body
      {
        headers: {
          'X-MBX-APIKEY': API_KEY!,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    console.log('✅ Response received:');
    console.log(`   Status: ${response.status} ${response.statusText}`);
    console.log(`   Data: ${JSON.stringify(response.data, null, 2)}\n`);

    if (response.data && (response.data.id || response.data.tranId || response.data.withdrawId)) {
      const withdrawId = response.data.id || response.data.tranId || response.data.withdrawId;
      console.log(`✅✅✅ WITHDRAWAL SUCCESSFUL! ✅✅✅`);
      console.log(`   Withdrawal ID: ${withdrawId}`);
      console.log(`   Amount: ${testParams.amount} ${testParams.asset}`);
      console.log(`   To: ${testParams.address}`);
      console.log(`\n   Check your wallet on Arbitrum to confirm receipt!\n`);
    } else {
      console.log('⚠️  Response received but no withdrawal ID found');
      console.log(`   Full response: ${JSON.stringify(response.data, null, 2)}\n`);
    }
  } catch (error: any) {
    console.error('\n❌ Withdrawal failed:');
    if (error.response) {
      console.error(`   Status: ${error.response.status} ${error.response.statusText}`);
      console.error(`   Error Code: ${error.response.data?.code || 'N/A'}`);
      console.error(`   Error Message: ${error.response.data?.msg || error.response.data?.message || 'N/A'}`);
      
      if (error.response.data?.code === -1000 && error.response.data?.msg?.includes('Multi chain limit')) {
        console.error('\n   ⚠️  Multi-chain limit error:');
        console.error('      Aster limits withdrawals across different chains.');
        console.error('      You may need to wait before trying again.\n');
      }
      
      console.error(`   Full Response: ${JSON.stringify(error.response.data, null, 2)}`);
    } else if (error.request) {
      console.error(`   No response received: ${error.message}`);
    } else {
      console.error(`   Request setup error: ${error.message}`);
    }
    throw error;
  }
}

// Run the test
testWithdrawal()
  .then(() => {
    console.log('✅ Test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  });

