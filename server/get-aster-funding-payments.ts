/**
 * Get Aster funding payments and calculate real APY
 * 
 * Usage: npx ts-node get-aster-funding-payments.ts
 */

import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

interface FundingPayment {
  symbol: string;
  amount: number;
  asset: string;
  timestamp: Date;
  incomeType: string;
}

// Browser-like headers to avoid CloudFlare blocking
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
};

/**
 * Get Aster funding payments with Ethereum signature authentication
 */
async function getAsterFundingPayments(
  days: number = 30
): Promise<FundingPayment[]> {
  const BASE_URL = process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com';
  const userAddress = process.env.ASTER_USER;
  const signerAddress = process.env.ASTER_SIGNER;
  const privateKey = process.env.ASTER_PRIVATE_KEY;

  if (!userAddress || !signerAddress || !privateKey) {
    console.log('❌ Missing required environment variables:');
    console.log(`   ASTER_USER: ${userAddress ? '✓' : '✗ Missing'}`);
    console.log(`   ASTER_SIGNER: ${signerAddress ? '✓' : '✗ Missing'}`);
    console.log(`   ASTER_PRIVATE_KEY: ${privateKey ? '✓' : '✗ Missing'}`);
    return [];
  }

  const now = Date.now();
  const startTime = now - (days * 24 * 60 * 60 * 1000);

  try {
    const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(normalizedKey);

    const params: Record<string, any> = {
      incomeType: 'FUNDING_FEE',
      startTime: startTime,
      endTime: now,
      limit: 1000,
      timestamp: Date.now(),
      recvWindow: 60000,
    };

    // Trim dict (convert all values to strings) for signing
    const trimmedParams: Record<string, any> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) {
        trimmedParams[key] = String(value);
      }
    }

    const jsonStr = JSON.stringify(trimmedParams, Object.keys(trimmedParams).sort());
    const nonce = Math.floor(Date.now() * 1000);

    // Create Ethereum signature (Aster EIP191 personal sign format)
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
    const signatureHex = ethers.Signature.from({
      r: signature.r,
      s: signature.s,
      v: signature.v,
    }).serialized;

    const signedParams = {
      ...params,
      nonce,
      user: userAddress,
      signer: signerAddress,
      signature: signatureHex,
    };

    console.log(`📊 Fetching Aster funding payments from /fapi/v3/income...`);
    console.log(`   Time range: ${new Date(startTime).toISOString()} to ${new Date(now).toISOString()}`);
    console.log(`   User: ${userAddress.substring(0, 10)}...${userAddress.substring(38)}`);

    const response = await axios.get(`${BASE_URL}/fapi/v3/income`, {
      params: signedParams,
      timeout: 30000,
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/json',
      },
    });

    const data = response.data;
    
    if (Array.isArray(data)) {
      console.log(`\n✅ Found ${data.length} funding payment(s)`);
      
      const payments: FundingPayment[] = data.map((entry: any) => ({
        symbol: entry.symbol || 'UNKNOWN',
        amount: parseFloat(entry.income || '0'),
        asset: entry.asset || 'USDT',
        timestamp: new Date(entry.time),
        incomeType: entry.incomeType,
      }));

      return payments;
    }

    console.log(`❌ Unexpected response: ${JSON.stringify(data).substring(0, 200)}`);
    return [];
  } catch (error: any) {
    console.error(`❌ Aster API error: ${error.message}`);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data: ${JSON.stringify(error.response.data).substring(0, 300)}`);
      
      if (error.response.status === 403) {
        console.log('\n⚠️  403 Forbidden - This could be:');
        console.log('   1. CloudFlare blocking (geo-restriction or VPS IP)');
        console.log('   2. Invalid signature');
        console.log('   3. API access not enabled for your account');
      }
    }
    return [];
  }
}

/**
 * Test basic connectivity to Aster API
 */
async function testAsterConnectivity(): Promise<boolean> {
  const BASE_URLS = [
    'https://fapi.asterdex.com',
    'https://api.asterdex.com',
  ];
  
  console.log('\n🔍 Testing Aster API connectivity...');
  
  for (const baseUrl of BASE_URLS) {
    try {
      console.log(`   Trying ${baseUrl}/fapi/v1/time ...`);
      const response = await axios.get(`${baseUrl}/fapi/v1/time`, {
        timeout: 10000,
        headers: BROWSER_HEADERS,
      });
      console.log(`   ✅ ${baseUrl} is accessible! Server time: ${response.data.serverTime}`);
      return true;
    } catch (error: any) {
      console.log(`   ❌ ${baseUrl}: ${error.response?.status || error.message}`);
    }
    
    try {
      console.log(`   Trying ${baseUrl}/fapi/v1/exchangeInfo ...`);
      const response = await axios.get(`${baseUrl}/fapi/v1/exchangeInfo`, {
        timeout: 10000,
        headers: BROWSER_HEADERS,
      });
      if (response.data?.symbols) {
        console.log(`   ✅ ${baseUrl} is accessible! Found ${response.data.symbols.length} symbols`);
        return true;
      }
    } catch (error: any) {
      console.log(`   ❌ ${baseUrl}: ${error.response?.status || error.message}`);
    }
  }
  
  return false;
}

/**
 * Also try the /fapi/v1/income endpoint (may work without Eth signature)
 */
async function tryAlternativeEndpoint(days: number = 30): Promise<FundingPayment[]> {
  const BASE_URL = process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com';
  
  console.log('\n📊 Trying alternative: /fapi/v1/fundingRate (public endpoint)...');
  
  try {
    const now = Date.now();
    const startTime = now - (days * 24 * 60 * 60 * 1000);
    
    // This gives historical funding RATES, not payments
    // But we can use it to estimate expected payments
    const response = await axios.get(`${BASE_URL}/fapi/v1/fundingRate`, {
      params: {
        symbol: 'ETHUSDT',
        startTime,
        endTime: now,
        limit: 1000,
      },
      timeout: 30000,
      headers: BROWSER_HEADERS,
    });

    if (Array.isArray(response.data) && response.data.length > 0) {
      console.log(`✅ Found ${response.data.length} historical funding rate entries (not payments)`);
      console.log('\n📋 Recent funding rates:');
      
      // Show last 10 entries
      const recent = response.data.slice(-10);
      for (const entry of recent) {
        const rate = parseFloat(entry.fundingRate);
        const time = new Date(entry.fundingTime);
        console.log(`   ${time.toISOString().replace('T', ' ').substring(0, 19)} | Rate: ${(rate * 100).toFixed(4)}%`);
      }
      
      // Calculate average rate
      const avgRate = response.data.reduce((sum: number, e: any) => sum + parseFloat(e.fundingRate), 0) / response.data.length;
      console.log(`\n📈 Average funding rate: ${(avgRate * 100).toFixed(4)}%`);
      console.log(`   Annualized (8h payments): ${(avgRate * 3 * 365 * 100).toFixed(2)}%`);
      
      return []; // This endpoint doesn't return actual payments
    }
    
    return [];
  } catch (error: any) {
    console.error(`❌ Alternative endpoint error: ${error.message}`);
    return [];
  }
}

async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('  ASTER FUNDING PAYMENTS');
  console.log('═'.repeat(70));

  const days = 30;
  
  // First test connectivity
  const isConnected = await testAsterConnectivity();
  
  if (!isConnected) {
    console.log('\n❌ Cannot connect to Aster API from this location.');
    console.log('   CloudFlare is blocking all requests.');
    console.log('\n💡 Workarounds:');
    console.log('   1. Use a VPN with residential IP');
    console.log('   2. Try from a different network/location');
    console.log('   3. Check funding payments manually via Aster web UI');
    console.log('   4. Use Hyperliquid/Lighter funding data instead');
    console.log('\n' + '═'.repeat(70) + '\n');
    return;
  }
  
  // Try to get actual funding payments
  const payments = await getAsterFundingPayments(days);

  if (payments.length > 0) {
    // Group by symbol
    const bySymbol = new Map<string, { total: number; count: number; payments: FundingPayment[] }>();
    let totalFunding = 0;

    for (const payment of payments) {
      const existing = bySymbol.get(payment.symbol) || { total: 0, count: 0, payments: [] };
      existing.total += payment.amount;
      existing.count++;
      existing.payments.push(payment);
      bySymbol.set(payment.symbol, existing);
      totalFunding += payment.amount;
    }

    // Display individual payments
    console.log('\n📋 Individual Funding Payments:');
    console.log('-'.repeat(70));
    for (const payment of payments) {
      const sign = payment.amount >= 0 ? '+' : '';
      console.log(
        `${payment.timestamp.toISOString().replace('T', ' ').substring(0, 19)} | ` +
        `${payment.symbol.padEnd(12)} | ${sign}$${payment.amount.toFixed(4).padStart(10)} | ` +
        `Asset: ${payment.asset}`
      );
    }

    // Summary by symbol
    console.log('\n' + '═'.repeat(70));
    console.log('  SUMMARY BY SYMBOL');
    console.log('═'.repeat(70));
    
    for (const [symbol, data] of bySymbol) {
      const sign = data.total >= 0 ? '+' : '';
      console.log(`${symbol.padEnd(15)}: ${data.count} payments | ${sign}$${data.total.toFixed(4)}`);
    }

    // Overall summary
    console.log('\n' + '═'.repeat(70));
    console.log('  OVERALL SUMMARY');
    console.log('═'.repeat(70));
    
    const totalSign = totalFunding >= 0 ? '+' : '';
    const dailyAvg = totalFunding / days;
    const annualizedReturn = dailyAvg * 365;
    
    console.log(`\nTotal Funding (${days} days): ${totalSign}$${totalFunding.toFixed(4)}`);
    console.log(`Daily Average: ${totalSign}$${dailyAvg.toFixed(4)}`);
    console.log(`Annualized Return: ${totalSign}$${annualizedReturn.toFixed(2)}`);
    
    // If we know the position size, we could calculate APY
    console.log('\n💡 To calculate real APY:');
    console.log(`   APY = (${annualizedReturn.toFixed(2)} / YOUR_POSITION_SIZE) × 100%`);
    console.log('   Example with $10,000 position:');
    console.log(`   APY = (${annualizedReturn.toFixed(2)} / 10000) × 100% = ${(annualizedReturn / 10000 * 100).toFixed(2)}%`);
  } else {
    // Fallback: try to get funding rates at least
    await tryAlternativeEndpoint(days);
    
    console.log('\n' + '═'.repeat(70));
    console.log('  NO FUNDING PAYMENTS FOUND');
    console.log('═'.repeat(70));
    console.log('\nPossible reasons:');
    console.log('1. No positions held during funding events');
    console.log('2. API authentication failed (check env vars)');
    console.log('3. CloudFlare geo-blocking (try VPN)');
    console.log('\nTo verify your Aster credentials, try:');
    console.log('  npx ts-node investigate-aster-funding.ts');
  }

  console.log('\n' + '═'.repeat(70) + '\n');
}

main().catch(console.error);


