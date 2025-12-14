import axios from 'axios';
import { ApiClient } from '@reservoir0x/lighter-ts-sdk';

const BASE_URL = 'https://mainnet.zklighter.elliot.ai';

// Market IDs that are failing according to logs
const TEST_MARKET_IDS = [19, 4, 17, 18, 84, 88, 113, 27, 39, 22, 31, 114, 50, 83, 82, 58, 25];

// Also test a few known working markets
const WORKING_MARKET_IDS = [0, 1, 2]; // ETH, BTC, etc.

const ALL_MARKET_IDS = [...TEST_MARKET_IDS, ...WORKING_MARKET_IDS];

interface TestResult {
  marketId: number;
  orderBookDetails?: {
    success: boolean;
    hasData: boolean;
    hasOpenInterest: boolean;
    hasLastTradePrice: boolean;
    lastTradePrice?: number;
    openInterest?: number;
    response?: any;
    error?: string;
  };
  method1_orderBookSDK?: {
    success: boolean;
    hasBestBid: boolean;
    hasBestAsk: boolean;
    midPrice?: number;
    response?: any;
    error?: string;
  };
  method2_fundingRates?: {
    success: boolean;
    hasData: boolean;
    hasMarkPrice: boolean;
    markPrice?: number;
    response?: any;
    error?: string;
  };
  method3_marketDataSDK?: {
    success: boolean;
    hasMarkPrice: boolean;
    hasPrice: boolean;
    markPrice?: number;
    response?: any;
    error?: string;
  };
}

async function testOrderBookDetails(marketId: number): Promise<TestResult['orderBookDetails']> {
  try {
    const url = `${BASE_URL}/api/v1/orderBookDetails`;
    const response = await axios.get(url, {
      timeout: 10000,
      params: { market_id: marketId },
    });

    const result: TestResult['orderBookDetails'] = {
      success: true,
      hasData: false,
      hasOpenInterest: false,
      hasLastTradePrice: false,
      response: response.data,
    };

    if (response.data?.code === 200 && response.data?.order_book_details?.length > 0) {
      result.hasData = true;
      const detail = response.data.order_book_details[0];
      
      if (detail.open_interest !== undefined && detail.open_interest !== null) {
        result.hasOpenInterest = true;
        result.openInterest = typeof detail.open_interest === 'string' 
          ? parseFloat(detail.open_interest) 
          : detail.open_interest;
      }
      
      if (detail.last_trade_price !== undefined && detail.last_trade_price !== null) {
        result.hasLastTradePrice = true;
        result.lastTradePrice = typeof detail.last_trade_price === 'string'
          ? parseFloat(detail.last_trade_price)
          : detail.last_trade_price;
      }
    }

    return result;
  } catch (error: any) {
    return {
      success: false,
      hasData: false,
      hasOpenInterest: false,
      hasLastTradePrice: false,
      error: error.response 
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message,
    };
  }
}

async function testMethod1_OrderBookSDK(marketId: number, apiClient: ApiClient): Promise<TestResult['method1_orderBookSDK']> {
  try {
    const orderBook = await (apiClient as any).order?.getOrderBookDetails({ marketIndex: marketId } as any) as any;
    
    const result: TestResult['method1_orderBookSDK'] = {
      success: true,
      hasBestBid: false,
      hasBestAsk: false,
      response: orderBook,
    };

    if (orderBook?.bestBid?.price) {
      result.hasBestBid = true;
    }
    
    if (orderBook?.bestAsk?.price) {
      result.hasBestAsk = true;
    }

    if (result.hasBestBid && result.hasBestAsk) {
      result.midPrice = (parseFloat(orderBook.bestBid.price) + parseFloat(orderBook.bestAsk.price)) / 2;
    }

    return result;
  } catch (error: any) {
    return {
      success: false,
      hasBestBid: false,
      hasBestAsk: false,
      error: error.message || String(error),
    };
  }
}

async function testMethod2_FundingRates(marketId: number): Promise<TestResult['method2_fundingRates']> {
  try {
    const url = `${BASE_URL}/api/v1/funding-rates`;
    const response = await axios.get(url, {
      timeout: 10000,
      params: { market_index: marketId },
    });

    const result: TestResult['method2_fundingRates'] = {
      success: true,
      hasData: false,
      hasMarkPrice: false,
      response: response.data,
    };

    if (response.data && Array.isArray(response.data) && response.data.length > 0) {
      result.hasData = true;
      const latest = response.data[0];
      
      if (latest.mark_price) {
        result.hasMarkPrice = true;
        result.markPrice = parseFloat(latest.mark_price);
      } else if (latest.price) {
        result.hasMarkPrice = true;
        result.markPrice = parseFloat(latest.price);
      }
    }

    return result;
  } catch (error: any) {
    return {
      success: false,
      hasData: false,
      hasMarkPrice: false,
      error: error.response
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error.message,
    };
  }
}

async function testMethod3_MarketDataSDK(marketId: number, apiClient: ApiClient): Promise<TestResult['method3_marketDataSDK']> {
  try {
    const marketData = await (apiClient as any).market?.getMarketData({ marketIndex: marketId });
    
    const result: TestResult['method3_marketDataSDK'] = {
      success: true,
      hasMarkPrice: false,
      hasPrice: false,
      response: marketData,
    };

    if (marketData?.markPrice) {
      result.hasMarkPrice = true;
      result.markPrice = parseFloat(marketData.markPrice);
    } else if (marketData?.price) {
      result.hasPrice = true;
      result.markPrice = parseFloat(marketData.price);
    }

    return result;
  } catch (error: any) {
    return {
      success: false,
      hasMarkPrice: false,
      hasPrice: false,
      error: error.message || String(error),
    };
  }
}

async function testMarket(marketId: number, apiClient: ApiClient): Promise<TestResult> {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing Market ID: ${marketId}`);
  console.log('='.repeat(80));

  const result: TestResult = { marketId };

  // Test orderBookDetails API (used by getOpenInterest)
  console.log(`\n1. Testing orderBookDetails API...`);
  result.orderBookDetails = await testOrderBookDetails(marketId);
  if (result.orderBookDetails.success && result.orderBookDetails.hasLastTradePrice) {
    console.log(`   ✅ SUCCESS: last_trade_price = ${result.orderBookDetails.lastTradePrice}`);
  } else {
    console.log(`   ❌ FAILED: ${result.orderBookDetails.error || 'No last_trade_price in response'}`);
    if (result.orderBookDetails.response) {
      console.log(`   Response structure:`, JSON.stringify(result.orderBookDetails.response, null, 2).substring(0, 500));
    }
  }

  // Test Method 1: Order Book SDK
  console.log(`\n2. Testing Method 1: order?.getOrderBookDetails() SDK...`);
  result.method1_orderBookSDK = await testMethod1_OrderBookSDK(marketId, apiClient);
  if (result.method1_orderBookSDK.success && result.method1_orderBookSDK.midPrice) {
    console.log(`   ✅ SUCCESS: midPrice = ${result.method1_orderBookSDK.midPrice}`);
  } else {
    console.log(`   ❌ FAILED: ${result.method1_orderBookSDK.error || 'No bestBid/bestAsk in response'}`);
    if (result.method1_orderBookSDK.response) {
      console.log(`   Response structure:`, JSON.stringify(result.method1_orderBookSDK.response, null, 2).substring(0, 500));
    }
  }

  // Test Method 2: Funding Rates API
  console.log(`\n3. Testing Method 2: /api/v1/funding-rates endpoint...`);
  result.method2_fundingRates = await testMethod2_FundingRates(marketId);
  if (result.method2_fundingRates.success && result.method2_fundingRates.markPrice) {
    console.log(`   ✅ SUCCESS: markPrice = ${result.method2_fundingRates.markPrice}`);
  } else {
    console.log(`   ❌ FAILED: ${result.method2_fundingRates.error || 'No mark_price in response'}`);
    if (result.method2_fundingRates.response) {
      console.log(`   Response structure:`, JSON.stringify(result.method2_fundingRates.response, null, 2).substring(0, 500));
    }
  }

  // Test Method 3: Market Data SDK
  console.log(`\n4. Testing Method 3: market?.getMarketData() SDK...`);
  result.method3_marketDataSDK = await testMethod3_MarketDataSDK(marketId, apiClient);
  if (result.method3_marketDataSDK.success && result.method3_marketDataSDK.markPrice) {
    console.log(`   ✅ SUCCESS: markPrice = ${result.method3_marketDataSDK.markPrice}`);
  } else {
    console.log(`   ❌ FAILED: ${result.method3_marketDataSDK.error || 'No markPrice/price in response'}`);
    if (result.method3_marketDataSDK.response) {
      console.log(`   Response structure:`, JSON.stringify(result.method3_marketDataSDK.response, null, 2).substring(0, 500));
    }
  }

  // Summary
  console.log(`\n📊 Summary for Market ${marketId}:`);
  const methods = [
    { name: 'orderBookDetails', result: result.orderBookDetails },
    { name: 'Method 1 (OrderBook SDK)', result: result.method1_orderBookSDK },
    { name: 'Method 2 (Funding Rates)', result: result.method2_fundingRates },
    { name: 'Method 3 (Market Data SDK)', result: result.method3_marketDataSDK },
  ];

  const workingMethods = methods.filter(m => {
    if (m.name === 'orderBookDetails') {
      return m.result?.hasLastTradePrice;
    }
    return m.result?.markPrice !== undefined;
  });

  if (workingMethods.length > 0) {
    console.log(`   ✅ Working methods: ${workingMethods.map(m => m.name).join(', ')}`);
  } else {
    console.log(`   ❌ ALL METHODS FAILED`);
  }

  return result;
}

async function main() {
  console.log('🔍 Lighter API Diagnostic Test');
  console.log(`Testing ${ALL_MARKET_IDS.length} markets (${TEST_MARKET_IDS.length} failing + ${WORKING_MARKET_IDS.length} working)`);
  console.log(`Base URL: ${BASE_URL}\n`);

  const apiClient = new ApiClient({ host: BASE_URL });
  const results: TestResult[] = [];

  for (const marketId of ALL_MARKET_IDS) {
    try {
      const result = await testMarket(marketId, apiClient);
      results.push(result);
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error: any) {
      console.error(`\n❌ Unexpected error testing market ${marketId}:`, error.message);
      results.push({
        marketId,
        orderBookDetails: { success: false, hasData: false, hasOpenInterest: false, hasLastTradePrice: false, error: error.message },
      });
    }
  }

  // Final summary
  console.log(`\n\n${'='.repeat(80)}`);
  console.log('📊 FINAL SUMMARY');
  console.log('='.repeat(80));

  const orderBookDetailsWorking = results.filter(r => r.orderBookDetails?.hasLastTradePrice).length;
  const method1Working = results.filter(r => r.method1_orderBookSDK?.midPrice !== undefined).length;
  const method2Working = results.filter(r => r.method2_fundingRates?.markPrice !== undefined).length;
  const method3Working = results.filter(r => r.method3_marketDataSDK?.markPrice !== undefined).length;

  console.log(`\nSuccess Rates:`);
  console.log(`  orderBookDetails (last_trade_price): ${orderBookDetailsWorking}/${results.length} (${(orderBookDetailsWorking/results.length*100).toFixed(1)}%)`);
  console.log(`  Method 1 (OrderBook SDK): ${method1Working}/${results.length} (${(method1Working/results.length*100).toFixed(1)}%)`);
  console.log(`  Method 2 (Funding Rates): ${method2Working}/${results.length} (${(method2Working/results.length*100).toFixed(1)}%)`);
  console.log(`  Method 3 (Market Data SDK): ${method3Working}/${results.length} (${(method3Working/results.length*100).toFixed(1)}%)`);

  const allFailed = results.filter(r => 
    !r.orderBookDetails?.hasLastTradePrice &&
    !r.method1_orderBookSDK?.midPrice &&
    !r.method2_fundingRates?.markPrice &&
    !r.method3_marketDataSDK?.markPrice
  );

  if (allFailed.length > 0) {
    console.log(`\n❌ Markets where ALL methods failed: ${allFailed.map(r => r.marketId).join(', ')}`);
  }

  console.log(`\n✅ Recommendation: Use orderBookDetails API for mark price (${orderBookDetailsWorking}/${results.length} success rate)`);
}

main().catch(console.error);












