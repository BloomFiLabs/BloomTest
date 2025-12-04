import * as dotenv from 'dotenv';
import axios from 'axios';
import * as crypto from 'crypto';

dotenv.config();

/**
 * Test script to query positions from Aster exchange
 * Tests multiple endpoints and authentication methods to identify working approach
 */

async function testAsterPositions() {
  console.log('🚀 Testing Aster Positions Endpoints\n');
  console.log('='.repeat(60));

  const baseUrl = (process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com').replace(/\/$/, '');
  const apiKey = process.env.ASTER_API_KEY;
  const apiSecret = process.env.ASTER_API_SECRET;
  const user = process.env.ASTER_USER;
  const signer = process.env.ASTER_SIGNER;
  const privateKey = process.env.ASTER_PRIVATE_KEY;

  console.log(`\n📡 Base URL: ${baseUrl}`);
  console.log(`🔑 API Key: ${apiKey ? '✅ Set' : '❌ Missing'}`);
  console.log(`🔐 API Secret: ${apiSecret ? '✅ Set' : '❌ Missing'}`);
  console.log(`👤 User: ${user ? '✅ Set' : '❌ Missing'}`);
  console.log(`✍️  Signer: ${signer ? '✅ Set' : '❌ Missing'}`);
  console.log(`🔐 Private Key: ${privateKey ? '✅ Set' : '❌ Missing'}\n`);

  // Test endpoints
  const endpoints = [
    '/fapi/v4/account',
    '/fapi/v2/account',
    '/fapi/v2/positionRisk',
    '/fapi/v1/positionRisk',
    '/fapi/v1/account',
  ];

  // Test each endpoint with different authentication methods
  for (const endpoint of endpoints) {
    console.log('\n' + '='.repeat(60));
    console.log(`🔍 Testing: ${endpoint}`);
    console.log('='.repeat(60));

    // Method 1: HMAC with API Key/Secret
    if (apiKey && apiSecret) {
      console.log('\n📤 Method 1: HMAC SHA256 with API Key/Secret');
      try {
        const params: Record<string, any> = {
          timestamp: Date.now(), // Milliseconds
          recvWindow: 50000,
        };

        // Create query string for HMAC signing (sorted alphabetically, no URL encoding)
        const queryString = Object.keys(params)
          .sort()
          .map((key) => `${key}=${params[key]}`)
          .join('&');

        // Create HMAC SHA256 signature
        const signature = crypto
          .createHmac('sha256', apiSecret)
          .update(queryString)
          .digest('hex');

        // Add signature to params (as last parameter)
        params.signature = signature;

        // Build query string with signature (sorted, signature last)
        const sortedKeys = Object.keys(params).sort();
        const finalQueryString = sortedKeys
          .map((key) => `${key}=${params[key]}`)
          .join('&');

        const url = `${baseUrl}${endpoint}?${finalQueryString}`;

        console.log(`   URL: ${baseUrl}${endpoint}?timestamp=${params.timestamp}&recvWindow=${params.recvWindow}&signature=***`);
        console.log(`   Headers: X-MBX-APIKEY: ${apiKey.substring(0, 10)}...`);

        const response = await axios.get(url, {
          timeout: 10000,
          headers: {
            'X-MBX-APIKEY': apiKey,
            'Content-Type': 'application/json',
          },
        });

        console.log(`   ✅ Status: ${response.status}`);
        console.log(`   📦 Response keys: ${Object.keys(response.data || {}).join(', ')}`);

        // Check for positions
        if (response.data?.positions) {
          const positions = Array.isArray(response.data.positions) 
            ? response.data.positions 
            : Object.values(response.data.positions || {});
          console.log(`   📈 Found ${positions.length} position(s)`);
          
          const openPositions = positions.filter((pos: any) => {
            const size = parseFloat(pos.positionAmt || pos.size || '0');
            return size !== 0;
          });
          console.log(`   📊 Open positions: ${openPositions.length}`);
          
          if (openPositions.length > 0) {
            console.log('\n   Position Details:');
            openPositions.forEach((pos: any, i: number) => {
              console.log(`     ${i + 1}. ${pos.symbol || 'N/A'}: ${pos.positionAmt || pos.size || '0'}`);
            });
          }
        } else {
          console.log('   ℹ️  No positions field in response');
        }

        // Show full response structure (truncated)
        console.log('\n   Full Response (first 500 chars):');
        console.log('   ' + JSON.stringify(response.data, null, 2).substring(0, 500) + '...');

        console.log('\n   ✅ SUCCESS - This method works!');
        return; // Exit on first success
      } catch (error: any) {
        console.log(`   ❌ Error: ${error.message}`);
        if (error.response) {
          console.log(`   Status: ${error.response.status}`);
          console.log(`   Response: ${JSON.stringify(error.response.data, null, 2)}`);
        }
      }
    }

    // Method 2: Try with different header name
    if (apiKey && apiSecret) {
      console.log('\n📤 Method 2: HMAC with different header name');
      try {
        const params: Record<string, any> = {
          timestamp: Date.now(),
          recvWindow: 50000,
        };

        const queryString = Object.keys(params)
          .sort()
          .map((key) => `${key}=${params[key]}`)
          .join('&');

        const signature = crypto
          .createHmac('sha256', apiSecret)
          .update(queryString)
          .digest('hex');

        params.signature = signature;

        const sortedKeys = Object.keys(params).sort();
        const finalQueryString = sortedKeys
          .map((key) => `${key}=${params[key]}`)
          .join('&');

        const url = `${baseUrl}${endpoint}?${finalQueryString}`;

        const response = await axios.get(url, {
          timeout: 10000,
          headers: {
            'X-API-KEY': apiKey, // Different header name
            'Content-Type': 'application/json',
          },
        });

        console.log(`   ✅ Status: ${response.status}`);
        console.log('   ✅ SUCCESS with X-API-KEY header!');
        return;
      } catch (error: any) {
        console.log(`   ❌ Error: ${error.message}`);
        if (error.response) {
          console.log(`   Status: ${error.response.status}`);
          console.log(`   Response: ${JSON.stringify(error.response.data, null, 2)}`);
        }
      }
    }

    // Method 3: Try with signature in body instead of query
    if (apiKey && apiSecret) {
      console.log('\n📤 Method 3: HMAC with signature in request body');
      try {
        const params: Record<string, any> = {
          timestamp: Date.now(),
          recvWindow: 50000,
        };

        const queryString = Object.keys(params)
          .sort()
          .map((key) => `${key}=${params[key]}`)
          .join('&');

        const signature = crypto
          .createHmac('sha256', apiSecret)
          .update(queryString)
          .digest('hex');

        params.signature = signature;

        const response = await axios.post(
          `${baseUrl}${endpoint}`,
          params,
          {
            timeout: 10000,
            headers: {
              'X-MBX-APIKEY': apiKey,
              'Content-Type': 'application/json',
            },
          }
        );

        console.log(`   ✅ Status: ${response.status}`);
        console.log('   ✅ SUCCESS with POST body!');
        return;
      } catch (error: any) {
        console.log(`   ❌ Error: ${error.message}`);
        if (error.response) {
          console.log(`   Status: ${error.response.status}`);
          console.log(`   Response: ${JSON.stringify(error.response.data, null, 2)}`);
        }
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('❌ All methods failed');
  console.log('='.repeat(60));
  console.log('\nPossible issues:');
  console.log('1. API keys may be invalid or expired');
  console.log('2. Signature calculation may be incorrect');
  console.log('3. Endpoint may require different authentication method');
  console.log('4. API may require IP whitelisting');
  console.log('5. Endpoint URL or version may be incorrect');
  console.log('\n');
}

testAsterPositions().catch(console.error);









