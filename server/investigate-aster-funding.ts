/**
 * Full-scale investigation into Aster funding payments API
 * 
 * Goals:
 * 1. Find working endpoints for funding payments
 * 2. Test different base URLs
 * 3. Test different authentication methods
 * 4. Identify why we're getting 403 errors
 */

import axios from 'axios';
import * as crypto from 'crypto';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

const BASE_URLS = [
  'https://fapi.asterdex.com',
  'https://api.asterdex.com',
  'https://www.asterdex.com',
  'https://asterdex.com',
];

const ENDPOINTS = [
  '/fapi/v1/income',
  '/fapi/v2/income',
  '/fapi/v3/income',
  '/fapi/v1/fundingRate',
  '/fapi/v1/userTrades',
  '/fapi/v1/ticker/price',
  '/fapi/v1/exchangeInfo',
  '/bapi/futures/v1/public/future/aster/estimate-withdraw-fee',
];

const USER_AGENTS = [
  undefined, // Default axios user agent
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'axios/1.6.0',
  'curl/8.0.0',
];

// ============================================================================
// Helper Functions
// ============================================================================

function signWithHMAC(params: Record<string, any>, apiSecret: string): string {
  const queryString = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');
  
  return crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');
}

async function signWithEthereum(
  params: Record<string, any>,
  userAddress: string,
  signerAddress: string,
  privateKey: string,
  nonce: number
): Promise<string> {
  const wallet = new ethers.Wallet(privateKey);
  
  const trimmedParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      trimmedParams[key] = String(value);
    }
  }

  const jsonStr = JSON.stringify(trimmedParams, Object.keys(trimmedParams).sort());

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ['string', 'address', 'address', 'uint256'],
    [jsonStr, userAddress, signerAddress, nonce],
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

  return ethers.Signature.from({
    r: signature.r,
    s: signature.s,
    v: signature.v,
  }).serialized;
}

// ============================================================================
// Test Functions
// ============================================================================

async function testPublicEndpoint(baseUrl: string, endpoint: string, userAgent?: string): Promise<{
  success: boolean;
  status?: number;
  error?: string;
  data?: any;
}> {
  try {
    const headers: Record<string, string> = {};
    if (userAgent) {
      headers['User-Agent'] = userAgent;
    }

    const response = await axios.get(`${baseUrl}${endpoint}`, {
      headers,
      timeout: 10000,
    });

    return {
      success: true,
      status: response.status,
      data: typeof response.data === 'object' 
        ? JSON.stringify(response.data).substring(0, 200) 
        : String(response.data).substring(0, 200),
    };
  } catch (error: any) {
    return {
      success: false,
      status: error.response?.status,
      error: error.message,
      data: error.response?.data 
        ? (typeof error.response.data === 'string' 
          ? error.response.data.substring(0, 200) 
          : JSON.stringify(error.response.data).substring(0, 200))
        : undefined,
    };
  }
}

async function testAuthenticatedEndpoint(
  baseUrl: string,
  endpoint: string,
  apiKey?: string,
  apiSecret?: string,
  userAddress?: string,
  signerAddress?: string,
  privateKey?: string,
  userAgent?: string,
): Promise<{
  success: boolean;
  authMethod: string;
  status?: number;
  error?: string;
  data?: any;
}> {
  const headers: Record<string, string> = {};
  if (userAgent) {
    headers['User-Agent'] = userAgent;
  }

  // Try HMAC authentication
  if (apiKey && apiSecret) {
    try {
      const params: Record<string, any> = {
        incomeType: 'FUNDING_FEE',
        timestamp: Date.now(),
        recvWindow: 60000,
        limit: 10,
      };

      const signature = signWithHMAC(params, apiSecret);
      const queryString = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');

      const response = await axios.get(`${baseUrl}${endpoint}?${queryString}&signature=${signature}`, {
        headers: {
          ...headers,
          'X-MBX-APIKEY': apiKey,
        },
        timeout: 10000,
      });

      return {
        success: true,
        authMethod: 'HMAC',
        status: response.status,
        data: typeof response.data === 'object' 
          ? JSON.stringify(response.data).substring(0, 200) 
          : String(response.data).substring(0, 200),
      };
    } catch (error: any) {
      // If HMAC fails, try Ethereum
      if (!userAddress || !signerAddress || !privateKey) {
        return {
          success: false,
          authMethod: 'HMAC',
          status: error.response?.status,
          error: error.message,
          data: error.response?.data 
            ? (typeof error.response.data === 'string' 
              ? error.response.data.substring(0, 200) 
              : JSON.stringify(error.response.data).substring(0, 200))
            : undefined,
        };
      }
    }
  }

  // Try Ethereum signature authentication
  if (userAddress && signerAddress && privateKey) {
    try {
      const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      const nonce = Math.floor(Date.now() * 1000);
      
      const params: Record<string, any> = {
        incomeType: 'FUNDING_FEE',
        timestamp: Date.now(),
        recvWindow: 60000,
        limit: 10,
      };

      const signature = await signWithEthereum(params, userAddress, signerAddress, normalizedKey, nonce);

      const signedParams = {
        ...params,
        nonce,
        user: userAddress,
        signer: signerAddress,
        signature,
      };

      const response = await axios.get(`${baseUrl}${endpoint}`, {
        params: signedParams,
        headers,
        timeout: 10000,
      });

      return {
        success: true,
        authMethod: 'Ethereum',
        status: response.status,
        data: typeof response.data === 'object' 
          ? JSON.stringify(response.data).substring(0, 200) 
          : String(response.data).substring(0, 200),
      };
    } catch (error: any) {
      return {
        success: false,
        authMethod: 'Ethereum',
        status: error.response?.status,
        error: error.message,
        data: error.response?.data 
          ? (typeof error.response.data === 'string' 
            ? error.response.data.substring(0, 200) 
            : JSON.stringify(error.response.data).substring(0, 200))
          : undefined,
      };
    }
  }

  return {
    success: false,
    authMethod: 'None',
    error: 'No authentication credentials provided',
  };
}

// ============================================================================
// Main Investigation
// ============================================================================

async function investigate() {
  console.log('\n' + '═'.repeat(70));
  console.log('  ASTER FUNDING API INVESTIGATION');
  console.log('═'.repeat(70));

  const apiKey = process.env.ASTER_API_KEY;
  const apiSecret = process.env.ASTER_API_SECRET;
  const userAddress = process.env.ASTER_USER;
  const signerAddress = process.env.ASTER_SIGNER;
  const privateKey = process.env.ASTER_PRIVATE_KEY;

  console.log('\n📋 Credentials:');
  console.log(`  API Key: ${apiKey ? '✓ Set' : '✗ Missing'}`);
  console.log(`  API Secret: ${apiSecret ? '✓ Set' : '✗ Missing'}`);
  console.log(`  User Address: ${userAddress ? '✓ Set' : '✗ Missing'}`);
  console.log(`  Signer Address: ${signerAddress ? '✓ Set' : '✗ Missing'}`);
  console.log(`  Private Key: ${privateKey ? '✓ Set' : '✗ Missing'}`);

  // Phase 1: Test public endpoints with different base URLs
  console.log('\n' + '-'.repeat(70));
  console.log('PHASE 1: Testing Public Endpoints');
  console.log('-'.repeat(70));

  const publicEndpoints = [
    '/fapi/v1/exchangeInfo',
    '/fapi/v1/ticker/price',
    '/fapi/v1/fundingRate',
  ];

  for (const baseUrl of BASE_URLS) {
    console.log(`\n🌐 Base URL: ${baseUrl}`);
    
    for (const endpoint of publicEndpoints) {
      const result = await testPublicEndpoint(baseUrl, endpoint);
      const status = result.success ? `✅ ${result.status}` : `❌ ${result.status || 'ERR'}`;
      console.log(`  ${endpoint.padEnd(30)} ${status}`);
      if (!result.success && result.status === 403) {
        console.log(`    → CloudFlare blocked (403): ${result.data?.substring(0, 80) || 'N/A'}`);
      }
    }
  }

  // Phase 2: Test with different User-Agents
  console.log('\n' + '-'.repeat(70));
  console.log('PHASE 2: Testing User-Agent Variations');
  console.log('-'.repeat(70));

  const testBaseUrl = 'https://fapi.asterdex.com';
  const testEndpoint = '/fapi/v1/exchangeInfo';

  for (const ua of USER_AGENTS) {
    const result = await testPublicEndpoint(testBaseUrl, testEndpoint, ua);
    const status = result.success ? `✅ ${result.status}` : `❌ ${result.status || 'ERR'}`;
    const uaName = ua ? ua.substring(0, 30) + '...' : 'Default';
    console.log(`  ${uaName.padEnd(35)} ${status}`);
  }

  // Phase 3: Test authenticated endpoints
  console.log('\n' + '-'.repeat(70));
  console.log('PHASE 3: Testing Authenticated Endpoints');
  console.log('-'.repeat(70));

  if (!apiKey && !userAddress) {
    console.log('\n⚠️  No authentication credentials available. Skipping...');
  } else {
    const authEndpoints = [
      '/fapi/v1/income',
      '/fapi/v2/income',
      '/fapi/v3/income',
    ];

    for (const baseUrl of BASE_URLS.slice(0, 2)) { // Just test first 2 base URLs
      console.log(`\n🌐 Base URL: ${baseUrl}`);
      
      for (const endpoint of authEndpoints) {
        const result = await testAuthenticatedEndpoint(
          baseUrl,
          endpoint,
          apiKey,
          apiSecret,
          userAddress,
          signerAddress,
          privateKey,
        );
        
        const status = result.success ? `✅ ${result.status}` : `❌ ${result.status || 'ERR'}`;
        console.log(`  ${endpoint.padEnd(20)} [${result.authMethod}] ${status}`);
        
        if (result.error) {
          console.log(`    → ${result.error.substring(0, 60)}`);
        }
        if (result.data && !result.data.includes('DOCTYPE')) {
          console.log(`    → ${result.data.substring(0, 80)}`);
        }
      }
    }
  }

  // Phase 4: Test via bapi (backend API) endpoints
  console.log('\n' + '-'.repeat(70));
  console.log('PHASE 4: Testing BAPI Endpoints (Backend API)');
  console.log('-'.repeat(70));

  const bapiUrls = [
    'https://www.asterdex.com/bapi/futures/v1/public/future/aster/estimate-withdraw-fee?chainId=42161&network=EVM&currency=USDC&accountType=spot',
    'https://www.asterdex.com/bapi/futures/v1/public/future/aster/chainList',
    'https://www.asterdex.com/bapi/futures/v1/public/future/assets',
  ];

  for (const url of bapiUrls) {
    try {
      const response = await axios.get(url, { timeout: 10000 });
      console.log(`✅ ${url.substring(30, 70)}...`);
      console.log(`   → ${JSON.stringify(response.data).substring(0, 100)}`);
    } catch (error: any) {
      console.log(`❌ ${url.substring(30, 70)}... ${error.response?.status || error.message}`);
    }
  }

  // Phase 5: Check for geo-blocking
  console.log('\n' + '-'.repeat(70));
  console.log('PHASE 5: Checking IP/Region Information');
  console.log('-'.repeat(70));

  try {
    const ipResponse = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    console.log(`Public IP: ${ipResponse.data.ip}`);

    try {
      const geoResponse = await axios.get(`https://ipapi.co/${ipResponse.data.ip}/json/`, { timeout: 5000 });
      console.log(`Country: ${geoResponse.data.country_name} (${geoResponse.data.country_code})`);
      console.log(`Region: ${geoResponse.data.region}`);
      console.log(`City: ${geoResponse.data.city}`);
    } catch {
      console.log('Could not fetch geo info');
    }
  } catch {
    console.log('Could not fetch IP info');
  }

  // Summary
  console.log('\n' + '═'.repeat(70));
  console.log('  SUMMARY');
  console.log('═'.repeat(70));
  console.log(`
If all fapi.asterdex.com endpoints return 403:
  1. CloudFlare is blocking the requests
  2. Possible causes:
     - Geo-blocking (region not allowed)
     - IP reputation (VPS/data center IP blocked)
     - Bot detection (User-Agent or request patterns)
  3. Solutions:
     - Use a VPN/proxy in allowed region
     - Try residential IP instead of data center
     - Check Aster's API documentation for regional restrictions
     - Contact Aster support about API access

If some endpoints work but not /income:
  - The endpoint may require different authentication
  - Check if funding payments are available via another endpoint
`);
}

// Run investigation
investigate().catch(console.error);


