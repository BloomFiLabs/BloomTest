import axios from 'axios';

/**
 * Test script to verify historical funding rate APIs for all exchanges
 * Tests actual endpoints and documents findings
 */

interface TestResult {
  exchange: string;
  endpoint: string;
  method: string;
  success: boolean;
  dataPoints?: number;
  dateRange?: { start: Date; end: Date };
  error?: string;
  responseSample?: any;
  rateLimit?: string;
}

const results: TestResult[] = [];

// Helper to format dates
function formatDate(date: Date): string {
  return date.toISOString();
}

// Helper to log results
function logResult(result: TestResult) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Exchange: ${result.exchange}`);
  console.log(`Endpoint: ${result.endpoint}`);
  console.log(`Method: ${result.method}`);
  console.log(`Success: ${result.success ? '✅' : '❌'}`);
  
  if (result.success) {
    console.log(`Data Points: ${result.dataPoints || 0}`);
    if (result.dateRange) {
      console.log(`Date Range: ${formatDate(result.dateRange.start)} to ${formatDate(result.dateRange.end)}`);
    }
    if (result.responseSample) {
      console.log(`Response Sample (first 2 entries):`);
      console.log(JSON.stringify(result.responseSample.slice(0, 2), null, 2));
    }
  } else {
    console.log(`Error: ${result.error}`);
  }
  
  if (result.rateLimit) {
    console.log(`Rate Limit Info: ${result.rateLimit}`);
  }
  
  results.push(result);
}

/**
 * Test Hyperliquid fundingHistory endpoint
 */
async function testHyperliquidFundingHistory() {
  console.log('\n🔍 Testing Hyperliquid fundingHistory endpoint...');
  
  const API_URL = 'https://api.hyperliquid.xyz/info';
  const symbol = 'ETH';
  const endTime = Date.now();
  const startTime = endTime - (30 * 24 * 60 * 60 * 1000); // 30 days ago
  
  try {
    const response = await axios.post(API_URL, {
      type: 'fundingHistory',
      coin: symbol,
      startTime: startTime,
      endTime: endTime,
    }, {
      timeout: 30000,
    });
    
    if (Array.isArray(response.data) && response.data.length > 0) {
      const firstEntry = response.data[0];
      const lastEntry = response.data[response.data.length - 1];
      
      logResult({
        exchange: 'Hyperliquid',
        endpoint: 'POST /info (type: fundingHistory)',
        method: 'POST',
        success: true,
        dataPoints: response.data.length,
        dateRange: {
          start: new Date(firstEntry.time),
          end: new Date(lastEntry.time),
        },
        responseSample: response.data.slice(0, 2),
        rateLimit: 'Unknown - no rate limit info in response',
      });
      
      // Log data structure
      console.log('\n📊 Data Structure:');
      console.log(`  - Fields: ${Object.keys(firstEntry).join(', ')}`);
      console.log(`  - Sample entry:`, JSON.stringify(firstEntry, null, 2));
      
      return response.data;
    } else {
      logResult({
        exchange: 'Hyperliquid',
        endpoint: 'POST /info (type: fundingHistory)',
        method: 'POST',
        success: false,
        error: `Unexpected response format: ${JSON.stringify(response.data).substring(0, 200)}`,
      });
      return null;
    }
  } catch (error: any) {
    logResult({
      exchange: 'Hyperliquid',
      endpoint: 'POST /info (type: fundingHistory)',
      method: 'POST',
      success: false,
      error: error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).substring(0, 200)}`
        : error.message,
    });
    return null;
  }
}

/**
 * Test Aster historical funding rate endpoints (Binance-compatible)
 */
async function testAsterHistoricalFundingRates() {
  console.log('\n🔍 Testing Aster historical funding rate endpoints...');
  
  const baseUrl = 'https://fapi.asterdex.com';
  const symbol = 'ETHUSDT';
  const endTime = Date.now();
  const startTime = endTime - (30 * 24 * 60 * 60 * 1000); // 30 days ago
  
  // Test 1: /fapi/v1/fundingRate with startTime and endTime
  try {
    const response = await axios.get(`${baseUrl}/fapi/v1/fundingRate`, {
      params: {
        symbol,
        startTime,
        endTime,
        limit: 1000, // Max limit
      },
      timeout: 30000,
    });
    
    if (Array.isArray(response.data) && response.data.length > 0) {
      const firstEntry = response.data[0];
      const lastEntry = response.data[response.data.length - 1];
      
      logResult({
        exchange: 'Aster',
        endpoint: 'GET /fapi/v1/fundingRate',
        method: 'GET',
        success: true,
        dataPoints: response.data.length,
        dateRange: {
          start: new Date(firstEntry.fundingTime),
          end: new Date(lastEntry.fundingTime),
        },
        responseSample: response.data.slice(0, 2),
        rateLimit: 'Unknown - check response headers',
      });
      
      console.log('\n📊 Data Structure:');
      console.log(`  - Fields: ${Object.keys(firstEntry).join(', ')}`);
      console.log(`  - Sample entry:`, JSON.stringify(firstEntry, null, 2));
      
      return response.data;
    } else if (response.data && typeof response.data === 'object') {
      // May return object with array inside
      const dataArray = response.data.data || response.data.result || [];
      if (Array.isArray(dataArray) && dataArray.length > 0) {
        logResult({
          exchange: 'Aster',
          endpoint: 'GET /fapi/v1/fundingRate',
          method: 'GET',
          success: true,
          dataPoints: dataArray.length,
          responseSample: dataArray.slice(0, 2),
        });
        return dataArray;
      }
    }
    
    logResult({
      exchange: 'Aster',
      endpoint: 'GET /fapi/v1/fundingRate',
      method: 'GET',
      success: false,
      error: `Unexpected response format: ${JSON.stringify(response.data).substring(0, 200)}`,
    });
  } catch (error: any) {
    logResult({
      exchange: 'Aster',
      endpoint: 'GET /fapi/v1/fundingRate',
      method: 'GET',
      success: false,
      error: error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).substring(0, 200)}`
        : error.message,
    });
  }
  
  // Test 2: /fapi/v1/fundingRate/history (if exists)
  try {
    const response = await axios.get(`${baseUrl}/fapi/v1/fundingRate/history`, {
      params: { symbol },
      timeout: 30000,
    });
    
    logResult({
      exchange: 'Aster',
      endpoint: 'GET /fapi/v1/fundingRate/history',
      method: 'GET',
      success: true,
      dataPoints: Array.isArray(response.data) ? response.data.length : 0,
      responseSample: Array.isArray(response.data) ? response.data.slice(0, 2) : response.data,
    });
  } catch (error: any) {
    logResult({
      exchange: 'Aster',
      endpoint: 'GET /fapi/v1/fundingRate/history',
      method: 'GET',
      success: false,
      error: error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).substring(0, 200)}`
        : error.message,
    });
  }
  
  return null;
}

/**
 * Test Lighter historical funding rate endpoints
 */
async function testLighterHistoricalFundingRates() {
  console.log('\n🔍 Testing Lighter historical funding rate endpoints...');
  
  const baseUrl = 'https://mainnet.zklighter.elliot.ai';
  const explorerUrl = 'https://explorer.elliot.ai';
  const marketIndex = 0; // ETH market
  
  // Test 1: /api/v1/funding-rates with query parameters
  try {
    const endTime = Date.now();
    const startTime = endTime - (30 * 24 * 60 * 60 * 1000); // 30 days ago
    
    const response = await axios.get(`${baseUrl}/api/v1/funding-rates`, {
      params: {
        market_id: marketIndex,
        start_time: startTime,
        end_time: endTime,
      },
      timeout: 30000,
    });
    
    if (response.data && (Array.isArray(response.data) || response.data.funding_rates)) {
      const dataArray = Array.isArray(response.data) ? response.data : response.data.funding_rates;
      
      if (Array.isArray(dataArray) && dataArray.length > 0) {
        logResult({
          exchange: 'Lighter',
          endpoint: 'GET /api/v1/funding-rates (with date params)',
          method: 'GET',
          success: true,
          dataPoints: dataArray.length,
          responseSample: dataArray.slice(0, 2),
        });
        
        console.log('\n📊 Data Structure:');
        console.log(`  - Fields: ${Object.keys(dataArray[0]).join(', ')}`);
        console.log(`  - Sample entry:`, JSON.stringify(dataArray[0], null, 2));
        
        return dataArray;
      }
    }
    
    logResult({
      exchange: 'Lighter',
      endpoint: 'GET /api/v1/funding-rates (with date params)',
      method: 'GET',
      success: false,
      error: `Unexpected response format: ${JSON.stringify(response.data).substring(0, 200)}`,
    });
  } catch (error: any) {
    logResult({
      exchange: 'Lighter',
      endpoint: 'GET /api/v1/funding-rates (with date params)',
      method: 'GET',
      success: false,
      error: error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).substring(0, 200)}`
        : error.message,
    });
  }
  
  // Test 2: Explorer API endpoints
  try {
    const response = await axios.get(`${explorerUrl}/api/v1/funding-rates`, {
      params: { market_id: marketIndex },
      timeout: 30000,
    });
    
    logResult({
      exchange: 'Lighter (Explorer)',
      endpoint: 'GET explorer.elliot.ai/api/v1/funding-rates',
      method: 'GET',
      success: true,
      dataPoints: Array.isArray(response.data) ? response.data.length : 0,
      responseSample: Array.isArray(response.data) ? response.data.slice(0, 2) : response.data,
    });
  } catch (error: any) {
    logResult({
      exchange: 'Lighter (Explorer)',
      endpoint: 'GET explorer.elliot.ai/api/v1/funding-rates',
      method: 'GET',
      success: false,
      error: error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data).substring(0, 200)}`
        : error.message,
    });
  }
  
  return null;
}

/**
 * Test Lighter SDK methods
 */
async function testLighterSDK() {
  console.log('\n🔍 Testing Lighter SDK (@reservoir0x/lighter-ts-sdk)...');
  
  try {
    // Try to import SDK
    const { ApiClient } = await import('@reservoir0x/lighter-ts-sdk');
    
    const baseUrl = 'https://mainnet.zklighter.elliot.ai';
    const apiClient = new ApiClient({ host: baseUrl });
    
    // Check SDK methods
    console.log('\n📚 Available SDK methods:');
    console.log(`  - apiClient methods: ${Object.keys(apiClient).join(', ')}`);
    
    // Try to find funding rate methods
    if ((apiClient as any).funding) {
      console.log(`  - funding methods: ${Object.keys((apiClient as any).funding).join(', ')}`);
    }
    if ((apiClient as any).market) {
      console.log(`  - market methods: ${Object.keys((apiClient as any).market).join(', ')}`);
    }
    
    logResult({
      exchange: 'Lighter SDK',
      endpoint: '@reservoir0x/lighter-ts-sdk',
      method: 'SDK',
      success: true,
      error: 'SDK available - check methods above',
    });
  } catch (error: any) {
    logResult({
      exchange: 'Lighter SDK',
      endpoint: '@reservoir0x/lighter-ts-sdk',
      method: 'SDK',
      success: false,
      error: `Failed to import SDK: ${error.message}`,
    });
  }
}

/**
 * Main test function
 */
async function main() {
  console.log('🚀 Starting Historical Funding Rate API Verification');
  console.log('='.repeat(80));
  
  // Test Hyperliquid
  await testHyperliquidFundingHistory();
  await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit delay
  
  // Test Aster
  await testAsterHistoricalFundingRates();
  await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit delay
  
  // Test Lighter
  await testLighterHistoricalFundingRates();
  await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit delay
  
  // Test Lighter SDK
  await testLighterSDK();
  
  // Summary
  console.log('\n\n' + '='.repeat(80));
  console.log('📊 SUMMARY');
  console.log('='.repeat(80));
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`\n✅ Successful: ${successful.length}`);
  successful.forEach(r => {
    console.log(`  - ${r.exchange}: ${r.endpoint} (${r.dataPoints || 0} data points)`);
  });
  
  console.log(`\n❌ Failed: ${failed.length}`);
  failed.forEach(r => {
    console.log(`  - ${r.exchange}: ${r.endpoint}`);
    console.log(`    Error: ${r.error}`);
  });
  
  console.log('\n' + '='.repeat(80));
  console.log('✅ Test complete!');
  console.log('='.repeat(80));
}

// Run tests
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});












