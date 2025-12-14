import * as dotenv from 'dotenv';
import axios from 'axios';
import * as crypto from 'crypto';
import { URLSearchParams } from 'url';

dotenv.config();

/**
 * Test script that EXACTLY matches the AsterExchangeAdapter implementation
 * to see if the adapter's approach works
 */

async function testAsterPositionsExact() {
  console.log('🚀 Testing Aster Positions (Exact Adapter Implementation)\n');
  console.log('='.repeat(60));

  const baseUrl = (process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com').replace(/\/$/, '');
  const apiKey = process.env.ASTER_API_KEY;
  const apiSecret = process.env.ASTER_API_SECRET;

  console.log(`\n📡 Base URL: ${baseUrl}`);
  console.log(`🔑 API Key: ${apiKey ? '✅ Set' : '❌ Missing'}`);
  console.log(`🔐 API Secret: ${apiSecret ? '✅ Set' : '❌ Missing'}\n`);

  if (!apiKey || !apiSecret) {
    console.error('❌ ASTER_API_KEY and ASTER_API_SECRET are required');
    return;
  }

  // EXACT implementation from AsterExchangeAdapter.signParamsWithApiKey()
  function signParamsWithApiKey(params: Record<string, any>): Record<string, any> {
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== null && value !== undefined),
    );

    // Aster API requires timestamp in milliseconds
    cleanParams.timestamp = Date.now(); // Milliseconds
    cleanParams.recvWindow = cleanParams.recvWindow ?? 50000;

    // Create query string for HMAC signing
    // IMPORTANT: 
    // 1. Signature must be calculated WITHOUT the signature parameter itself
    // 2. Parameters must be sorted alphabetically
    // 3. For GET requests, only query string is signed (no request body)
    // 4. Values should NOT be URL encoded in the signature string
    // 5. After calculating signature, it must be added as the LAST parameter
    const queryString = Object.keys(cleanParams)
      .sort()
      .map((key) => `${key}=${cleanParams[key]}`) // No URL encoding
      .join('&');

    console.log('   📝 Query string for signature:', queryString);

    // Create HMAC SHA256 signature
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');

    console.log('   🔐 Calculated signature:', signature);

    // Return params with signature added
    return {
      ...cleanParams,
      signature,
    };
  }

  // Test endpoints
  const endpoints = [
    { path: '/fapi/v2/positionRisk', name: 'Position Risk (used by adapter)' },
    { path: '/fapi/v2/account', name: 'Account Info' },
    { path: '/fapi/v4/account', name: 'Account Info V4' },
  ];

  for (const { path, name } of endpoints) {
    console.log('\n' + '='.repeat(60));
    console.log(`🔍 Testing: ${name} (${path})`);
    console.log('='.repeat(60));

    try {
      // EXACT implementation from AsterExchangeAdapter.getPositions()
      const params = signParamsWithApiKey({});
      const headers: Record<string, string> = {
        'X-MBX-APIKEY': apiKey,
      };

      // EXACT implementation: Use URLSearchParams then convert to object
      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        formData.append(key, String(value));
      }

      const requestParams = Object.fromEntries(formData);
      
      console.log('\n   📤 Request Details:');
      console.log('   URL:', `${baseUrl}${path}`);
      console.log('   Params:', JSON.stringify(requestParams, null, 2));
      console.log('   Headers:', JSON.stringify(headers, null, 2));

      // Build query string manually to see what axios will send
      const manualQueryString = Object.keys(requestParams)
        .sort()
        .map((key) => `${key}=${encodeURIComponent(requestParams[key])}`)
        .join('&');
      console.log('   Query string (URL-encoded):', manualQueryString);

      const response = await axios.get(path, {
        baseURL: baseUrl,
        params: requestParams,
        headers,
        timeout: 10000,
      });

      console.log(`\n   ✅ Status: ${response.status}`);
      console.log('   📦 Response keys:', Object.keys(response.data || {}).join(', '));

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
      } else if (Array.isArray(response.data)) {
        // positionRisk returns array directly
        const openPositions = response.data.filter((pos: any) => {
          const size = parseFloat(pos.positionAmt || pos.size || '0');
          return size !== 0;
        });
        console.log(`   📈 Found ${response.data.length} position(s) in array`);
        console.log(`   📊 Open positions: ${openPositions.length}`);
        
        if (openPositions.length > 0) {
          console.log('\n   Position Details:');
          openPositions.forEach((pos: any, i: number) => {
            console.log(`     ${i + 1}. ${pos.symbol || 'N/A'}: ${pos.positionAmt || pos.size || '0'} (${pos.positionAmt > 0 ? 'LONG' : 'SHORT'})`);
          });
        }
      }

      // Show response structure (truncated)
      console.log('\n   Full Response (first 800 chars):');
      const responseStr = JSON.stringify(response.data, null, 2);
      console.log('   ' + responseStr.substring(0, 800) + (responseStr.length > 800 ? '...' : ''));

      console.log('\n   ✅ SUCCESS!');
      return; // Exit on first success
    } catch (error: any) {
      console.log(`\n   ❌ Error: ${error.message}`);
      if (error.response) {
        console.log(`   Status: ${error.response.status}`);
        console.log(`   Response: ${JSON.stringify(error.response.data, null, 2)}`);
        
        // Show request details that were sent
        if (error.config) {
          console.log(`   Request URL: ${error.config.url}`);
          console.log(`   Request params: ${JSON.stringify(error.config.params)}`);
        }
      } else if (error.request) {
        console.log('   Request made but no response received');
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('❌ All endpoints failed');
  console.log('='.repeat(60));
}

testAsterPositionsExact().catch(console.error);
















