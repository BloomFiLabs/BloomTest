/**
 * Test script to fetch funding payments from all exchanges
 * 
 * This verifies that each exchange's funding payment API works before
 * implementing them as proper adapters.
 * 
 * Usage: npx ts-node test-funding-payments.ts
 */

import axios from 'axios';
import * as crypto from 'crypto';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// Types
// ============================================================================

interface FundingPayment {
  exchange: string;
  symbol: string;
  amount: number;        // USD amount (positive = received, negative = paid)
  fundingRate: number;   // The rate applied
  positionSize: number;  // Position size at time of funding
  timestamp: Date;
  rawData?: any;         // Original response for debugging
}

// ============================================================================
// Hyperliquid - userFunding endpoint
// ============================================================================

async function getHyperliquidFundingPayments(
  walletAddress: string,
  startTime?: number,
  endTime?: number
): Promise<FundingPayment[]> {
  console.log('\n' + '='.repeat(60));
  console.log('📊 HYPERLIQUID - Fetching Funding Payments');
  console.log('='.repeat(60));

  const API_URL = 'https://api.hyperliquid.xyz/info';
  
  // Default to last 7 days if not specified
  const now = Date.now();
  const start = startTime || now - (7 * 24 * 60 * 60 * 1000);
  const end = endTime || now;

  console.log(`Wallet: ${walletAddress}`);
  console.log(`Time range: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}`);

  try {
    const response = await axios.post(API_URL, {
      type: 'userFunding',
      user: walletAddress,
      startTime: start,
      endTime: end,
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    const data = response.data;
    
    if (!Array.isArray(data)) {
      console.log('❌ Unexpected response format:', JSON.stringify(data).substring(0, 200));
      return [];
    }

    console.log(`\n✅ Found ${data.length} funding payment(s)`);

    const payments: FundingPayment[] = [];
    let totalFunding = 0;

    for (const entry of data) {
      if (entry.delta?.type === 'funding') {
        const amount = parseFloat(entry.delta.usdc || '0');
        const rate = parseFloat(entry.delta.fundingRate || '0');
        const size = parseFloat(entry.delta.szi || '0');
        
        totalFunding += amount;

        const payment: FundingPayment = {
          exchange: 'Hyperliquid',
          symbol: entry.delta.coin,
          amount: amount,
          fundingRate: rate,
          positionSize: Math.abs(size),
          timestamp: new Date(entry.time),
          rawData: entry,
        };

        payments.push(payment);

        // Log each payment
        const sign = amount >= 0 ? '+' : '';
        console.log(
          `  ${new Date(entry.time).toISOString().replace('T', ' ').substring(0, 19)} | ` +
          `${entry.delta.coin.padEnd(8)} | ${sign}$${amount.toFixed(4).padStart(10)} | ` +
          `Rate: ${(rate * 100).toFixed(4)}% | Size: ${Math.abs(size).toFixed(4)}`
        );
      }
    }

    const totalSign = totalFunding >= 0 ? '+' : '';
    console.log(`\n📈 Total Funding (Hyperliquid): ${totalSign}$${totalFunding.toFixed(4)}`);

    return payments;
  } catch (error: any) {
    console.error(`❌ Hyperliquid error: ${error.message}`);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data: ${JSON.stringify(error.response.data).substring(0, 300)}`);
    }
    return [];
  }
}

// ============================================================================
// Aster - /fapi/v1/income endpoint with FUNDING_FEE type
// ============================================================================

async function getAsterFundingPayments(
  apiKey: string,
  apiSecret: string,
  startTime?: number,
  endTime?: number
): Promise<FundingPayment[]> {
  console.log('\n' + '='.repeat(60));
  console.log('📊 ASTER - Fetching Funding Payments');
  console.log('='.repeat(60));

  const BASE_URL = process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com';
  
  // Default to last 7 days if not specified
  const now = Date.now();
  const start = startTime || now - (7 * 24 * 60 * 60 * 1000);
  const end = endTime || now;

  console.log(`Time range: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}`);

  // Aster requires Ethereum signature authentication for /fapi/v3/income
  // HMAC authentication doesn't work for this endpoint
  const userAddress = process.env.ASTER_USER;
  const signerAddress = process.env.ASTER_SIGNER;
  const privateKey = process.env.ASTER_PRIVATE_KEY;

  if (!userAddress || !signerAddress || !privateKey) {
    console.log('⚠️ ASTER_USER, ASTER_SIGNER, or ASTER_PRIVATE_KEY not set');
    console.log('   Aster funding payments require Ethereum signature authentication');
    return [];
  }

  return await getAsterFundingWithEthSignature(start, end);
}

/**
 * Get Aster funding payments with Ethereum signature authentication
 * Uses /fapi/v3/income endpoint which requires Ethereum signature (not HMAC)
 */
async function getAsterFundingWithEthSignature(
  startTime: number,
  endTime: number
): Promise<FundingPayment[]> {
  const BASE_URL = process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com';
  const userAddress = process.env.ASTER_USER;
  const signerAddress = process.env.ASTER_SIGNER;
  const privateKey = process.env.ASTER_PRIVATE_KEY;

  if (!userAddress || !signerAddress || !privateKey) {
    console.log('   ⚠️ ASTER_USER, ASTER_SIGNER, or ASTER_PRIVATE_KEY not set');
    return [];
  }

  try {
    const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(normalizedKey);

    const params: Record<string, any> = {
      incomeType: 'FUNDING_FEE',
      startTime: startTime,
      endTime: endTime,
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

    console.log('Trying with Ethereum signature auth on /fapi/v3/income...');

    const response = await axios.get(`${BASE_URL}/fapi/v3/income`, {
      params: signedParams,
      timeout: 30000,
    });

    const data = response.data;
    if (Array.isArray(data)) {
      console.log(`\n✅ Found ${data.length} funding payment(s)`);
      
      const payments: FundingPayment[] = [];
      let totalFunding = 0;

      for (const entry of data) {
        const amount = parseFloat(entry.income || '0');
        totalFunding += amount;

        const payment: FundingPayment = {
          exchange: 'Aster',
          symbol: entry.symbol || 'UNKNOWN',
          amount: amount,
          fundingRate: 0,
          positionSize: 0,
          timestamp: new Date(entry.time),
          rawData: entry,
        };

        payments.push(payment);

        // Log each payment
        const sign = amount >= 0 ? '+' : '';
        console.log(
          `  ${new Date(entry.time).toISOString().replace('T', ' ').substring(0, 19)} | ` +
          `${(entry.symbol || 'UNKNOWN').padEnd(12)} | ${sign}$${amount.toFixed(4).padStart(10)} | ` +
          `Asset: ${entry.asset || 'USDT'}`
        );
      }

      const totalSign = totalFunding >= 0 ? '+' : '';
      console.log(`\n📈 Total Funding (Aster): ${totalSign}$${totalFunding.toFixed(4)}`);

      return payments;
    }

    console.log(`   Response: ${JSON.stringify(data).substring(0, 200)}`);
    return [];
  } catch (error: any) {
    console.error(`❌ Aster Eth signature auth error: ${error.message}`);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data: ${JSON.stringify(error.response.data).substring(0, 200)}`);
    }
    return [];
  }
}

// ============================================================================
// Lighter - /api/v1/positionFunding endpoint
// ============================================================================

async function getLighterFundingPayments(
  accountIndex: number,
  apiKey: string,
  apiKeyIndex: number = 1
): Promise<FundingPayment[]> {
  console.log('\n' + '='.repeat(60));
  console.log('📊 LIGHTER - Fetching Funding Payments');
  console.log('='.repeat(60));

  const BASE_URL = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
  
  console.log(`Account Index: ${accountIndex}`);
  console.log(`API Key Index: ${apiKeyIndex}`);

  try {
    // Import SignerClient for authentication
    const { SignerClient, ApiClient } = await import('@reservoir0x/lighter-ts-sdk');
    
    // Normalize API key
    let normalizedKey = apiKey;
    if (normalizedKey.startsWith('0x')) {
      normalizedKey = normalizedKey.slice(2);
    }
    
    // Create SignerClient for auth token
    const signerClient = new SignerClient({
      url: BASE_URL,
      privateKey: normalizedKey,
      accountIndex: accountIndex,
      apiKeyIndex: apiKeyIndex,
    });

    await signerClient.initialize();
    await signerClient.ensureWasmClient();

    // Create auth token
    console.log('Creating auth token...');
    const authToken = await signerClient.createAuthTokenWithExpiry(600); // 10 minutes
    console.log(`Auth token created: ${authToken.substring(0, 30)}...`);

    // Try the positionFunding endpoint with auth
    const response = await axios.get(`${BASE_URL}/api/v1/positionFunding`, {
      params: {
        account_index: accountIndex,
        limit: 100,
        auth: authToken,
      },
      timeout: 30000,
      headers: {
        'accept': 'application/json',
      },
    });

    const data = response.data;
    
    console.log(`\n✅ Response received`);
    console.log(`Response structure: ${JSON.stringify(data).substring(0, 500)}`);

    // Parse the response based on actual structure
    const payments: FundingPayment[] = [];
    let totalFunding = 0;

    // Handle different response formats
    // Actual Lighter response: { code: 200, position_fundings: [...] }
    let fundingData: any[] = [];
    if (Array.isArray(data)) {
      fundingData = data;
    } else if (data.position_fundings && Array.isArray(data.position_fundings)) {
      fundingData = data.position_fundings;
    } else if (data.funding_payments && Array.isArray(data.funding_payments)) {
      fundingData = data.funding_payments;
    } else if (data.position_funding && Array.isArray(data.position_funding)) {
      fundingData = data.position_funding;
    } else if (data.data && Array.isArray(data.data)) {
      fundingData = data.data;
    }

    console.log(`Found ${fundingData.length} funding entries`);

    // Get market symbol mapping
    const marketSymbols = await getLighterMarketSymbols();

    for (const entry of fundingData) {
      // Lighter API response format:
      // { timestamp, market_id, funding_id, change, rate, position_size, position_side }
      // "change" is the funding payment amount (can be positive or negative)
      const amount = parseFloat(entry.change || entry.funding_payment || entry.amount || '0');
      
      totalFunding += amount;

      const marketId = entry.market_id || entry.market_index || 0;
      const symbol = marketSymbols.get(marketId) || `Market-${marketId}`;
      const side = entry.position_side || 'unknown';

      const payment: FundingPayment = {
        exchange: 'Lighter',
        symbol: symbol,
        amount: amount,
        fundingRate: parseFloat(entry.rate || entry.funding_rate || '0'),
        positionSize: parseFloat(entry.position_size || entry.size || '0'),
        timestamp: new Date((entry.timestamp || entry.time || Date.now()) * 1000), // Unix seconds to ms
        rawData: entry,
      };

      payments.push(payment);

      // Log each payment
      const sign = amount >= 0 ? '+' : '';
      console.log(
        `  ${payment.timestamp.toISOString().replace('T', ' ').substring(0, 19)} | ` +
        `${symbol.padEnd(10)} | ${sign}$${amount.toFixed(4).padStart(10)} | ` +
        `Rate: ${(payment.fundingRate * 100).toFixed(4)}% | Size: ${payment.positionSize.toFixed(2)} (${side})`
      );
    }

    const totalSign = totalFunding >= 0 ? '+' : '';
    console.log(`\n📈 Total Funding (Lighter): ${totalSign}$${totalFunding.toFixed(4)}`);

    return payments;
  } catch (error: any) {
    console.error(`❌ Lighter error: ${error.message}`);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data: ${JSON.stringify(error.response.data).substring(0, 300)}`);
      
      // If 401/403, we need auth
      if (error.response.status === 401 || error.response.status === 403) {
        console.log('\n⚠️  Lighter requires authentication for this endpoint.');
        console.log('   Will need to implement auth token generation using SignerClient.');
        
        // Try alternative: explorer API for positions with funding
        return await getLighterFundingFromExplorer(accountIndex);
      }
    }
    return [];
  }
}

/**
 * Get Lighter market ID to symbol mapping from Explorer API
 */
async function getLighterMarketSymbols(): Promise<Map<number, string>> {
  const symbolMap = new Map<number, string>();
  
  try {
    const response = await axios.get('https://explorer.elliot.ai/api/markets', {
      timeout: 10000,
      headers: { 'accept': 'application/json' },
    });

    if (response.data && Array.isArray(response.data)) {
      for (const market of response.data) {
        const marketIndex = market.market_index ?? market.marketIndex ?? market.index ?? null;
        const symbol = market.symbol || market.baseAsset || market.name;
        
        if (marketIndex !== null && symbol) {
          const normalizedSymbol = symbol
            .replace('USDC', '')
            .replace('USDT', '')
            .replace('-PERP', '')
            .toUpperCase();
          symbolMap.set(marketIndex, normalizedSymbol);
        }
      }
    }
  } catch (error: any) {
    console.log(`   Warning: Could not fetch market symbols: ${error.message}`);
  }
  
  return symbolMap;
}

/**
 * Fallback: Try to get funding info from Lighter Explorer API
 */
async function getLighterFundingFromExplorer(accountIndex: number): Promise<FundingPayment[]> {
  console.log('\n📊 Trying Lighter Explorer API fallback...');
  
  try {
    // Try the account transactions endpoint which may include funding
    const response = await axios.get(
      `https://explorer.elliot.ai/api/accounts/${accountIndex}/transactions`,
      {
        params: {
          limit: 100,
          type: 'funding', // Try filtering by type
        },
        timeout: 30000,
        headers: { 'accept': 'application/json' },
      }
    );

    const data = response.data;
    console.log(`Explorer API response: ${JSON.stringify(data).substring(0, 500)}`);

    const payments: FundingPayment[] = [];
    
    // Parse based on actual response structure
    if (data.transactions && Array.isArray(data.transactions)) {
      for (const tx of data.transactions) {
        if (tx.type === 'funding' || tx.tx_type === 'funding') {
          const amount = parseFloat(tx.amount || tx.funding_payment || '0') / 1e6; // Micro-USDC
          payments.push({
            exchange: 'Lighter',
            symbol: tx.market_symbol || `Market-${tx.market_index}`,
            amount: amount,
            fundingRate: parseFloat(tx.funding_rate || '0'),
            positionSize: 0,
            timestamp: new Date(tx.timestamp || Date.now()),
            rawData: tx,
          });
        }
      }
    }

    return payments;
  } catch (error: any) {
    console.error(`❌ Explorer fallback error: ${error.message}`);
    return [];
  }
}

// ============================================================================
// Main execution
// ============================================================================

async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('  FUNDING PAYMENTS TEST SCRIPT');
  console.log('  Testing funding payment APIs for all exchanges');
  console.log('═'.repeat(70));

  // Load environment variables
  const hyperliquidPrivateKey = process.env.PRIVATE_KEY || process.env.HYPERLIQUID_PRIVATE_KEY;
  const asterApiKey = process.env.ASTER_API_KEY;
  const asterApiSecret = process.env.ASTER_API_SECRET;
  const lighterAccountIndex = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '1000');
  const lighterApiKey = process.env.LIGHTER_API_KEY;
  const lighterApiKeyIndex = parseInt(process.env.LIGHTER_API_KEY_INDEX || '1');

  const allPayments: FundingPayment[] = [];
  let totalFunding = 0;

  // ========== HYPERLIQUID ==========
  if (hyperliquidPrivateKey) {
    try {
      const normalizedKey = hyperliquidPrivateKey.startsWith('0x') 
        ? hyperliquidPrivateKey 
        : `0x${hyperliquidPrivateKey}`;
      const wallet = new ethers.Wallet(normalizedKey);
      const walletAddress = wallet.address;
      
      const hyperliquidPayments = await getHyperliquidFundingPayments(walletAddress);
      allPayments.push(...hyperliquidPayments);
      
      const hlTotal = hyperliquidPayments.reduce((sum, p) => sum + p.amount, 0);
      totalFunding += hlTotal;
    } catch (error: any) {
      console.error(`\n❌ Failed to process Hyperliquid: ${error.message}`);
    }
  } else {
    console.log('\n⚠️  Skipping Hyperliquid - PRIVATE_KEY not set');
  }

  // ========== ASTER ==========
  if (asterApiKey && asterApiSecret) {
    try {
      const asterPayments = await getAsterFundingPayments(asterApiKey, asterApiSecret);
      allPayments.push(...asterPayments);
      
      const asterTotal = asterPayments.reduce((sum, p) => sum + p.amount, 0);
      totalFunding += asterTotal;
    } catch (error: any) {
      console.error(`\n❌ Failed to process Aster: ${error.message}`);
    }
  } else {
    console.log('\n⚠️  Skipping Aster - ASTER_API_KEY or ASTER_API_SECRET not set');
  }

  // ========== LIGHTER ==========
  if (lighterApiKey) {
    try {
      const lighterPayments = await getLighterFundingPayments(
        lighterAccountIndex,
        lighterApiKey,
        lighterApiKeyIndex
      );
      allPayments.push(...lighterPayments);
      
      const lighterTotal = lighterPayments.reduce((sum, p) => sum + p.amount, 0);
      totalFunding += lighterTotal;
    } catch (error: any) {
      console.error(`\n❌ Failed to process Lighter: ${error.message}`);
    }
  } else {
    console.log('\n⚠️  Skipping Lighter - LIGHTER_API_KEY not set');
  }

  // ========== SUMMARY ==========
  console.log('\n' + '═'.repeat(70));
  console.log('  SUMMARY');
  console.log('═'.repeat(70));
  
  // Group by exchange
  const byExchange = new Map<string, { count: number; total: number }>();
  for (const payment of allPayments) {
    const existing = byExchange.get(payment.exchange) || { count: 0, total: 0 };
    existing.count++;
    existing.total += payment.amount;
    byExchange.set(payment.exchange, existing);
  }

  console.log('\nFunding by Exchange:');
  for (const [exchange, data] of byExchange) {
    const sign = data.total >= 0 ? '+' : '';
    console.log(`  ${exchange.padEnd(12)}: ${data.count.toString().padStart(4)} payments | ${sign}$${data.total.toFixed(4)}`);
  }

  // Group by symbol
  const bySymbol = new Map<string, number>();
  for (const payment of allPayments) {
    const key = `${payment.exchange}:${payment.symbol}`;
    bySymbol.set(key, (bySymbol.get(key) || 0) + payment.amount);
  }

  console.log('\nFunding by Symbol:');
  const sortedSymbols = Array.from(bySymbol.entries()).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  for (const [key, amount] of sortedSymbols.slice(0, 10)) {
    const sign = amount >= 0 ? '+' : '';
    console.log(`  ${key.padEnd(25)}: ${sign}$${amount.toFixed(4)}`);
  }
  if (sortedSymbols.length > 10) {
    console.log(`  ... and ${sortedSymbols.length - 10} more`);
  }

  // Calculate APY estimate
  const daysOfData = 7; // Default query range
  const estimatedDailyReturn = totalFunding / daysOfData;
  const estimatedAnnualReturn = estimatedDailyReturn * 365;
  
  // Estimate capital (would need actual position data)
  // For now, just show raw numbers
  
  const totalSign = totalFunding >= 0 ? '+' : '';
  console.log('\n' + '-'.repeat(40));
  console.log(`Total Funding (${daysOfData} days): ${totalSign}$${totalFunding.toFixed(4)}`);
  console.log(`Estimated Daily Return: ${totalSign}$${estimatedDailyReturn.toFixed(4)}`);
  console.log(`Estimated Annual Return: ${totalSign}$${estimatedAnnualReturn.toFixed(2)}`);
  console.log('-'.repeat(40));

  // Show sample raw data for debugging
  if (allPayments.length > 0) {
    console.log('\n📋 Sample Raw Data (first entry per exchange):');
    const seen = new Set<string>();
    for (const payment of allPayments) {
      if (!seen.has(payment.exchange)) {
        seen.add(payment.exchange);
        console.log(`\n${payment.exchange}:`);
        console.log(JSON.stringify(payment.rawData, null, 2));
      }
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  TEST COMPLETE');
  console.log('═'.repeat(70) + '\n');
}

// Run the script
main().catch(console.error);

