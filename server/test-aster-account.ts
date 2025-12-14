/**
 * Test script to query Aster account information and check max withdrawal
 */

import * as dotenv from 'dotenv';
import axios from 'axios';
import * as crypto from 'crypto';

dotenv.config();

const FAPI_BASE_URL = 'https://fapi.asterdex.com';
const API_KEY = process.env.ASTER_API_KEY;
const API_SECRET = process.env.ASTER_API_SECRET || process.env.ASTER_API_SECRET_KEY;
const USER_ADDRESS = process.env.ASTER_USER;
const SIGNER_ADDRESS = process.env.ASTER_SIGNER;
const PRIVATE_KEY = process.env.ASTER_PRIVATE_KEY || process.env.PRIVATE_KEY;

// Aster v3/account endpoint can use either API key auth OR Ethereum signature auth
// Let's try API key first, then fall back to Ethereum signature if needed
if (!API_KEY || !API_SECRET) {
  if (!USER_ADDRESS || !SIGNER_ADDRESS || !PRIVATE_KEY) {
    console.error('❌ ERROR: Need either (ASTER_API_KEY + ASTER_API_SECRET) OR (ASTER_USER + ASTER_SIGNER + ASTER_PRIVATE_KEY)');
    process.exit(1);
  }
}

async function getAccountInfo() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         ASTER ACCOUNT INFORMATION QUERY                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  try {
    let params: Record<string, any>;
    let headers: Record<string, string> = {};
    let queryString: string;

    // Try API key authentication first (if available)
    if (API_KEY && API_SECRET) {
      console.log('🔐 Using API Key authentication...\n');
      
      const timestamp = Date.now();
      const recvWindow = 50000;
      
      params = {
        timestamp,
        recvWindow,
      };
      
      // Build query string for HMAC signing (sorted alphabetically)
      const queryStringForHmac = Object.keys(params)
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join('&');
      
      // Create HMAC SHA256 signature
      const signature = crypto
        .createHmac('sha256', API_SECRET!)
        .update(queryStringForHmac)
        .digest('hex');
      
      // Build final query string with signature last
      const finalParams = { ...params, signature };
      const queryParams: string[] = [];
      const signatureParam: string[] = [];
      for (const [key, value] of Object.entries(finalParams)) {
        if (key === 'signature') {
          signatureParam.push(`${key}=${value}`);
        } else {
          queryParams.push(`${key}=${value}`);
        }
      }
      queryParams.sort();
      queryString = queryParams.join('&') + (signatureParam.length > 0 ? `&${signatureParam[0]}` : '');
      headers['X-MBX-APIKEY'] = API_KEY;
    } else if (USER_ADDRESS && SIGNER_ADDRESS && PRIVATE_KEY) {
      // Fall back to Ethereum signature authentication
      console.log('🔐 Using Ethereum signature authentication...\n');
      
      const { ethers } = await import('ethers');
      const normalizedPrivateKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
      const wallet = new ethers.Wallet(normalizedPrivateKey);
      
      const nonce = Math.floor(Date.now() * 1000);
      const recvWindow = 50000;
      const timestamp = Math.floor(Date.now());
      
      const cleanParams: Record<string, any> = {
        recvWindow,
        timestamp,
      };
      
      // Trim and sort params
      const trimmedParams: Record<string, any> = {};
      for (const [key, value] of Object.entries(cleanParams)) {
        if (value !== null && value !== undefined) {
          trimmedParams[key] = String(value);
        }
      }
      
      const jsonStr = JSON.stringify(trimmedParams, Object.keys(trimmedParams).sort());
      
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const encoded = abiCoder.encode(
        ['string', 'address', 'address', 'uint256'],
        [jsonStr, USER_ADDRESS, SIGNER_ADDRESS, nonce],
      );
      
      const keccakHash = ethers.keccak256(encoded);
      const hashBytes = ethers.getBytes(keccakHash);
      
      const prefix = '\x19Ethereum Signed Message:\n';
      const lengthStr = hashBytes.length.toString();
      const message = ethers.concat([
        ethers.toUtf8Bytes(prefix),
        ethers.toUtf8Bytes(lengthStr),
        hashBytes,
      ]);
      
      const messageHash = ethers.keccak256(message);
      const signature = wallet.signingKey.sign(ethers.getBytes(messageHash));
      
      const signatureHex = ethers.Signature.from({
        r: signature.r,
        s: signature.s,
        v: signature.v,
      }).serialized;
      
      params = {
        ...cleanParams,
        nonce,
        user: USER_ADDRESS,
        signer: SIGNER_ADDRESS,
        signature: signatureHex,
      };
      
      // Build query string
      const queryParams: string[] = [];
      for (const [key, value] of Object.entries(params)) {
        if (value !== null && value !== undefined) {
          queryParams.push(`${key}=${encodeURIComponent(String(value))}`);
        }
      }
      queryString = queryParams.join('&');
    } else {
      throw new Error('No authentication method available');
    }

    console.log('📤 Request Details:');
    console.log(`   Method: GET`);
    console.log(`   URL: ${FAPI_BASE_URL}/fapi/v3/account`);
    console.log(`   Query String: ${queryString.substring(0, 200)}...`);
    if (headers['X-MBX-APIKEY']) {
      console.log(`   Headers: X-MBX-APIKEY: ${headers['X-MBX-APIKEY']?.substring(0, 10)}...`);
    }
    console.log('');

    // Try v4 endpoint first (as shown in user's example), then fall back to v3
    let response;
    try {
      response = await axios.get(
        `${FAPI_BASE_URL}/fapi/v4/account?${queryString}`,
        {
          headers,
          timeout: 10000,
        }
      );
    } catch (v4Error: any) {
      if (v4Error.response?.status === 404 || v4Error.response?.data?.code === -1102) {
        // Try v3 endpoint
        console.log('⚠️  v4 endpoint failed, trying v3...\n');
        response = await axios.get(
          `${FAPI_BASE_URL}/fapi/v3/account?${queryString}`,
          {
            headers,
            timeout: 10000,
          }
        );
      } else {
        throw v4Error;
      }
    }

    console.log('✅ Response received:\n');
    console.log('📊 Account Summary:');
    console.log(`   Fee Tier: ${response.data.feeTier}`);
    console.log(`   Can Trade: ${response.data.canTrade}`);
    console.log(`   Can Deposit: ${response.data.canDeposit}`);
    console.log(`   Can Withdraw: ${response.data.canWithdraw}`);
    console.log(`   Update Time: ${response.data.updateTime ? new Date(response.data.updateTime).toISOString() : 'N/A'}\n`);

    console.log('💰 Total Balances:');
    console.log(`   Total Wallet Balance: $${response.data.totalWalletBalance || '0.00'}`);
    console.log(`   Total Margin Balance: $${response.data.totalMarginBalance || '0.00'}`);
    console.log(`   Total Unrealized P&L: $${response.data.totalUnrealizedProfit || '0.00'}`);
    console.log(`   Available Balance: $${response.data.availableBalance || '0.00'}`);
    console.log(`   ⭐ MAX WITHDRAW AMOUNT: $${response.data.maxWithdrawAmount || '0.00'} ⭐\n`);

    if (response.data.assets && response.data.assets.length > 0) {
      console.log('💵 Asset Details:');
      response.data.assets.forEach((asset: any) => {
        console.log(`\n   ${asset.asset}:`);
        console.log(`      Wallet Balance: ${asset.walletBalance || '0.00'}`);
        console.log(`      Available Balance: ${asset.availableBalance || '0.00'}`);
        console.log(`      Max Withdraw: ${asset.maxWithdrawAmount || '0.00'}`);
        console.log(`      Margin Balance: ${asset.marginBalance || '0.00'}`);
        console.log(`      Unrealized P&L: ${asset.unrealizedProfit || '0.00'}`);
        console.log(`      Margin Available: ${asset.marginAvailable ? 'Yes' : 'No'}`);
      });
      console.log('');
    }

    if (response.data.positions && response.data.positions.length > 0) {
      console.log('📈 Open Positions:');
      response.data.positions.forEach((pos: any) => {
        if (parseFloat(pos.positionAmt || '0') !== 0) {
          console.log(`\n   ${pos.symbol}:`);
          console.log(`      Side: ${pos.positionSide}`);
          console.log(`      Size: ${pos.positionAmt || '0'}`);
          console.log(`      Entry Price: ${pos.entryPrice || '0.00'}`);
          console.log(`      Leverage: ${pos.leverage}x`);
          console.log(`      Isolated: ${pos.isolated ? 'Yes' : 'No'}`);
          console.log(`      Unrealized P&L: $${pos.unrealizedProfit || '0.00'}`);
          console.log(`      Initial Margin: $${pos.initialMargin || '0.00'}`);
        }
      });
      console.log('');
    } else {
      console.log('📈 Open Positions: None\n');
    }

    // Summary
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`🎯 MAXIMUM WITHDRAWAL AMOUNT: $${response.data.maxWithdrawAmount || '0.00'}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    return response.data;
  } catch (error: any) {
    console.error('\n❌ Failed to get account information:');
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

// Run the query
getAccountInfo()
  .then(() => {
    console.log('✅ Query completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Query failed:', error.message);
    process.exit(1);
  });

