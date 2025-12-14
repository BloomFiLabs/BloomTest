/**
 * Diagnose Aster API access issues
 * Tests if CloudFlare is blocking vs signature issue
 * 
 * Usage: npx ts-node diagnose-aster-access.ts
 */

import axios from 'axios';

const USER_AGENTS = [
  // Browser user agents
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  // Default axios
  undefined,
];

const ENDPOINTS = [
  // Public endpoints (no auth required)
  { url: '/fapi/v1/ping', name: 'Ping' },
  { url: '/fapi/v1/time', name: 'Server Time' },
  { url: '/fapi/v1/exchangeInfo', name: 'Exchange Info' },
  { url: '/fapi/v1/ticker/price?symbol=ETHUSDT', name: 'ETH Price' },
  { url: '/fapi/v1/fundingRate?symbol=ETHUSDT&limit=1', name: 'Funding Rate' },
];

const BASE_URLS = [
  'https://fapi.asterdex.com',
  'https://www.asterdex.com',
];

async function testEndpoint(baseUrl: string, endpoint: { url: string; name: string }, userAgent?: string): Promise<{
  success: boolean;
  status?: number;
  error?: string;
  data?: string;
  isCloudFlare?: boolean;
}> {
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (userAgent) {
      headers['User-Agent'] = userAgent;
    }

    const response = await axios.get(`${baseUrl}${endpoint.url}`, {
      headers,
      timeout: 10000,
    });

    return {
      success: true,
      status: response.status,
      data: JSON.stringify(response.data).substring(0, 100),
    };
  } catch (error: any) {
    const isCloudFlare = error.response?.data?.includes?.('<!DOCTYPE') || 
                         error.response?.data?.includes?.('cloudflare') ||
                         error.response?.data?.includes?.('ERROR: The request could not be satisfied');
    
    return {
      success: false,
      status: error.response?.status,
      error: error.message,
      data: typeof error.response?.data === 'string' 
        ? error.response.data.substring(0, 100) 
        : JSON.stringify(error.response?.data || {}).substring(0, 100),
      isCloudFlare,
    };
  }
}

async function checkIP(): Promise<{ ip: string; country?: string; org?: string }> {
  try {
    const response = await axios.get('https://ipapi.co/json/', { timeout: 5000 });
    return {
      ip: response.data.ip,
      country: response.data.country_name,
      org: response.data.org,
    };
  } catch {
    try {
      const response = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
      return { ip: response.data.ip };
    } catch {
      return { ip: 'Unknown' };
    }
  }
}

async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('  ASTER API ACCESS DIAGNOSTICS');
  console.log('═'.repeat(70));

  // Check IP info
  console.log('\n📍 IP Information:');
  const ipInfo = await checkIP();
  console.log(`   IP: ${ipInfo.ip}`);
  if (ipInfo.country) console.log(`   Country: ${ipInfo.country}`);
  if (ipInfo.org) console.log(`   Provider: ${ipInfo.org}`);

  // Test each base URL
  for (const baseUrl of BASE_URLS) {
    console.log('\n' + '-'.repeat(70));
    console.log(`🌐 Testing: ${baseUrl}`);
    console.log('-'.repeat(70));

    // Test with default user agent first
    console.log('\n📋 Testing PUBLIC endpoints (no auth required):');
    
    let anySuccess = false;
    let allCloudFlare = true;

    for (const endpoint of ENDPOINTS) {
      const result = await testEndpoint(baseUrl, endpoint);
      
      const status = result.success 
        ? `✅ ${result.status}` 
        : `❌ ${result.status || 'ERR'}`;
      
      console.log(`   ${endpoint.name.padEnd(20)} ${status}${result.isCloudFlare ? ' (CloudFlare block)' : ''}`);
      
      if (result.success) {
        anySuccess = true;
        allCloudFlare = false;
        console.log(`      → ${result.data}`);
      } else if (result.status === 403 && result.isCloudFlare) {
        // CloudFlare block confirmed
      } else {
        allCloudFlare = false;
      }
    }

    if (allCloudFlare && !anySuccess) {
      console.log('\n⚠️  ALL endpoints blocked by CloudFlare');
      console.log('   This is NOT a signature issue - your IP/region is blocked');
      
      // Try with browser user agent
      console.log('\n🔄 Trying with browser User-Agent...');
      const browserUA = USER_AGENTS[0];
      const pingResult = await testEndpoint(baseUrl, ENDPOINTS[0], browserUA);
      
      if (pingResult.success) {
        console.log('   ✅ Browser User-Agent works!');
        console.log('   → Add this header to your requests:');
        console.log(`      User-Agent: ${browserUA?.substring(0, 50)}...`);
      } else {
        console.log('   ❌ Still blocked with browser User-Agent');
        console.log('   → This confirms IP/geo blocking, not User-Agent issue');
      }
    }
  }

  // Summary and recommendations
  console.log('\n' + '═'.repeat(70));
  console.log('  DIAGNOSIS');
  console.log('═'.repeat(70));
  
  console.log(`
If ALL public endpoints return 403:
  ❌ This is NOT a signature problem
  ❌ CloudFlare is blocking your entire request
  
Likely causes:
  1. 🌍 Geo-restriction (your country may be blocked)
  2. 🖥️  Datacenter/VPS IP (Aster blocks non-residential IPs)
  3. 🤖 Bot detection (rate limiting or pattern detection)

Solutions:
  1. Use a VPN with a different country (try Singapore, US, EU)
  2. Try from a residential IP (your home internet)
  3. Use a residential proxy service
  4. Check Aster's Telegram/Discord for region restrictions

Alternative - Get funding data from other exchanges:
  • Hyperliquid: Usually works from anywhere
  • Lighter: Usually works from anywhere
  
Run: npx ts-node test-funding-payments.ts
  (This will try all exchanges and show which ones work)
`);

  console.log('═'.repeat(70) + '\n');
}

main().catch(console.error);
