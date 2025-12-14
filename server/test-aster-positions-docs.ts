import * as dotenv from 'dotenv';
import axios from 'axios';
import * as crypto from 'crypto';

dotenv.config();

/**
 * Test script following EXACT Aster API documentation format
 * Based on: https://github.com/asterdex/api-docs/blob/master/aster-finance-futures-api.md
 */

async function testAsterPositionsDocs() {
  console.log('🚀 Testing Aster Positions (Following Official Docs)\n');
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

  // According to Aster docs, signature should be calculated on sorted query string
  // Then signature is added as LAST parameter
  function createSignedQueryString(params: Record<string, any>): string {
    // Filter out null/undefined
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== null && value !== undefined),
    );

    // Add required params
    cleanParams.timestamp = Date.now();
    cleanParams.recvWindow = cleanParams.recvWindow || 50000;

    // Create query string for signing (sorted alphabetically, NO signature param)
    const queryStringForSigning = Object.keys(cleanParams)
      .sort()
      .map((key) => `${key}=${cleanParams[key]}`)
      .join('&');

    console.log('   📝 Query string for signing:', queryStringForSigning);

    // Create HMAC SHA256 signature
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryStringForSigning)
      .digest('hex');

    console.log('   🔐 Calculated signature:', signature);

    // Build final query string with signature as LAST parameter
    // Important: signature must be last, but we still sort other params
    const finalParams = { ...cleanParams, signature };
    const finalQueryString = Object.keys(finalParams)
      .sort()
      .map((key) => {
        // Ensure signature is always last
        if (key === 'signature') return null;
        return `${key}=${finalParams[key]}`;
      })
      .filter((x) => x !== null)
      .join('&') + `&signature=${signature}`;

    console.log('   📤 Final query string:', finalQueryString);
    return finalQueryString;
  }

  // Test endpoints
  const endpoints = [
    { path: '/fapi/v2/positionRisk', name: 'Position Risk V2' },
    { path: '/fapi/v2/account', name: 'Account Info V2' },
  ];

  for (const { path, name } of endpoints) {
    console.log('\n' + '='.repeat(60));
    console.log(`🔍 Testing: ${name} (${path})`);
    console.log('='.repeat(60));

    try {
      // Build query string with signature
      const queryString = createSignedQueryString({});

      // Make request with query string directly (not as params object)
      // This ensures the exact order is preserved
      const url = `${baseUrl}${path}?${queryString}`;

      console.log(`\n   📤 Full URL: ${baseUrl}${path}?${queryString.split('&signature=')[0]}&signature=***`);

      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/json',
        },
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
        
        if (openPositions.length > 0) {
          console.log('\n   Position Details:');
          openPositions.forEach((pos: any, i: number) => {
            console.log(`     ${i + 1}. ${pos.symbol || 'N/A'}: ${pos.positionAmt || pos.size || '0'}`);
          });
        }
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
        const errorData = error.response.data;
        if (typeof errorData === 'object') {
          console.log(`   Code: ${errorData.code}`);
          console.log(`   Message: ${errorData.msg}`);
          console.log(`   Full Response: ${JSON.stringify(errorData, null, 2)}`);
        } else {
          console.log(`   Response: ${errorData}`);
        }
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('❌ All endpoints failed');
  console.log('='.repeat(60));
  console.log('\nNote: If signature is still invalid, the API keys may need to be regenerated');
  console.log('or there may be IP whitelisting requirements.');
}

testAsterPositionsDocs().catch(console.error);
















