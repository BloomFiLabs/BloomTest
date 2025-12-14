/**
 * Get funding payments from all 3 exchanges and calculate real APY
 * 
 * Usage: npx ts-node get-all-funding-payments.ts [days] [capitalDeployed]
 * 
 * Examples:
 *   npx ts-node get-all-funding-payments.ts          # 30 days, auto-detect capital
 *   npx ts-node get-all-funding-payments.ts 7        # 7 days
 *   npx ts-node get-all-funding-payments.ts 30 1000  # 30 days, $1000 capital
 */

import axios from 'axios';
import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

// Browser-like headers
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
};

interface FundingPayment {
  exchange: string;
  symbol: string;
  amount: number;
  timestamp: Date;
}

interface ExchangeSummary {
  exchange: string;
  payments: FundingPayment[];
  totalReceived: number;
  totalPaid: number;
  netFunding: number;
  winCount: number;
  lossCount: number;
  bySymbol: Map<string, { total: number; wins: number; losses: number }>;
}

interface WinRateMetrics {
  totalPayments: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  expectancy: number;
}

// ============================================================================
// HYPERLIQUID
// ============================================================================

async function fetchHyperliquidPayments(days: number): Promise<FundingPayment[]> {
  const privateKey = process.env.PRIVATE_KEY || process.env.HYPERLIQUID_PRIVATE_KEY;
  if (!privateKey) {
    console.log('⚠️  Hyperliquid: No PRIVATE_KEY configured');
    return [];
  }

  const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new ethers.Wallet(normalizedKey);
  const address = wallet.address;

  const now = Date.now();
  const startTime = now - (days * 24 * 60 * 60 * 1000);

  try {
    const response = await axios.post('https://api.hyperliquid.xyz/info', {
      type: 'userFunding',
      user: address,
      startTime,
      endTime: now,
    }, { headers: HEADERS, timeout: 30000 });

    const data = response.data;
    if (!Array.isArray(data)) return [];

    const payments: FundingPayment[] = [];
    for (const entry of data) {
      if (entry.delta?.type === 'funding') {
        payments.push({
          exchange: 'Hyperliquid',
          symbol: entry.delta.coin || 'UNKNOWN',
          amount: parseFloat(entry.delta.usdc || '0'),
          timestamp: new Date(entry.time),
        });
      }
    }

    return payments;
  } catch (error: any) {
    console.error(`❌ Hyperliquid error: ${error.message}`);
    return [];
  }
}

// ============================================================================
// ASTER
// ============================================================================

async function fetchAsterPayments(days: number): Promise<FundingPayment[]> {
  const userAddress = process.env.ASTER_USER;
  const signerAddress = process.env.ASTER_SIGNER;
  const privateKey = process.env.ASTER_PRIVATE_KEY;

  if (!userAddress || !signerAddress || !privateKey) {
    console.log('⚠️  Aster: Missing ASTER_USER, ASTER_SIGNER, or ASTER_PRIVATE_KEY');
    return [];
  }

  const baseUrl = process.env.ASTER_BASE_URL || 'https://fapi.asterdex.com';
  const now = Date.now();
  const startTime = now - (days * 24 * 60 * 60 * 1000);

  try {
    const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(normalizedKey);

    const params: Record<string, any> = {
      incomeType: 'FUNDING_FEE',
      startTime,
      endTime: now,
      limit: 1000,
      timestamp: Date.now(),
      recvWindow: 60000,
    };

    const trimmedParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      trimmedParams[key] = String(value);
    }

    const jsonStr = JSON.stringify(trimmedParams, Object.keys(trimmedParams).sort());
    const nonce = Math.floor(Date.now() * 1000);

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
      ['string', 'address', 'address', 'uint256'],
      [jsonStr, userAddress, signerAddress, nonce]
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

    const response = await axios.get(`${baseUrl}/fapi/v3/income`, {
      params: signedParams,
      headers: HEADERS,
      timeout: 30000,
    });

    const data = response.data;
    if (!Array.isArray(data)) return [];

    return data.map((entry: any) => ({
      exchange: 'Aster',
      symbol: entry.symbol || 'UNKNOWN',
      amount: parseFloat(entry.income || '0'),
      timestamp: new Date(entry.time),
    }));
  } catch (error: any) {
    console.error(`❌ Aster error: ${error.message}`);
    return [];
  }
}

// ============================================================================
// LIGHTER
// ============================================================================

async function fetchLighterPayments(days: number): Promise<FundingPayment[]> {
  const accountIndex = parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '0');
  const apiKey = process.env.LIGHTER_API_KEY;
  const apiKeyIndex = parseInt(process.env.LIGHTER_API_KEY_INDEX || '1');
  const baseUrl = process.env.LIGHTER_API_BASE_URL || 'https://mainnet.zklighter.elliot.ai';

  if (!apiKey || accountIndex === 0) {
    console.log('⚠️  Lighter: Missing LIGHTER_API_KEY or LIGHTER_ACCOUNT_INDEX');
    return [];
  }

  try {
    const { SignerClient } = await import('@reservoir0x/lighter-ts-sdk');

    let normalizedKey = apiKey;
    if (normalizedKey.startsWith('0x')) {
      normalizedKey = normalizedKey.slice(2);
    }

    const signerClient = new SignerClient({
      url: baseUrl,
      privateKey: normalizedKey,
      accountIndex,
      apiKeyIndex,
    });

    await signerClient.initialize();
    await signerClient.ensureWasmClient();

    const authToken = await signerClient.createAuthTokenWithExpiry(600);

    const response = await axios.get(`${baseUrl}/api/v1/positionFunding`, {
      params: {
        account_index: accountIndex,
        limit: 100,
        auth: authToken,
      },
      headers: { accept: 'application/json' },
      timeout: 30000,
    });

    const data = response.data;
    let fundingData: any[] = [];
    if (data.position_fundings) fundingData = data.position_fundings;
    else if (Array.isArray(data)) fundingData = data;

    // Get market symbols
    const marketsRes = await axios.get('https://explorer.elliot.ai/api/markets', { timeout: 10000 });
    const symbolMap = new Map<number, string>();
    if (Array.isArray(marketsRes.data)) {
      for (const m of marketsRes.data) {
        symbolMap.set(m.market_index, m.symbol);
      }
    }

    const now = Date.now();
    const cutoff = now - (days * 24 * 60 * 60 * 1000);

    const payments: FundingPayment[] = [];
    for (const entry of fundingData) {
      const timestamp = (entry.timestamp || 0) * 1000;
      if (timestamp < cutoff) continue;

      const marketId = entry.market_id || 0;
      const symbol = symbolMap.get(marketId) || `Market-${marketId}`;

      payments.push({
        exchange: 'Lighter',
        symbol,
        amount: parseFloat(entry.change || '0'),
        timestamp: new Date(timestamp),
      });
    }

    return payments;
  } catch (error: any) {
    console.error(`❌ Lighter error: ${error.message}`);
    return [];
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const days = parseInt(process.argv[2] || '30');
  const capitalDeployed = parseFloat(process.argv[3] || '0');

  console.log('');
  console.log('═'.repeat(80));
  console.log('  💰 ALL EXCHANGES FUNDING SUMMARY');
  console.log('═'.repeat(80));
  console.log(`  Period: Last ${days} days`);
  console.log('');

  // Fetch from all exchanges in parallel
  console.log('📡 Fetching from exchanges...');
  const [hyperliquidPayments, asterPayments, lighterPayments] = await Promise.all([
    fetchHyperliquidPayments(days),
    fetchAsterPayments(days),
    fetchLighterPayments(days),
  ]);

  // Create summaries
  const exchanges: ExchangeSummary[] = [
    { exchange: 'Hyperliquid', payments: hyperliquidPayments, totalReceived: 0, totalPaid: 0, netFunding: 0, winCount: 0, lossCount: 0, bySymbol: new Map() },
    { exchange: 'Aster', payments: asterPayments, totalReceived: 0, totalPaid: 0, netFunding: 0, winCount: 0, lossCount: 0, bySymbol: new Map() },
    { exchange: 'Lighter', payments: lighterPayments, totalReceived: 0, totalPaid: 0, netFunding: 0, winCount: 0, lossCount: 0, bySymbol: new Map() },
  ];

  let grandTotalReceived = 0;
  let grandTotalPaid = 0;
  let grandWins = 0;
  let grandLosses = 0;
  const allWinAmounts: number[] = [];
  const allLossAmounts: number[] = [];

  for (const ex of exchanges) {
    for (const p of ex.payments) {
      if (p.amount > 0) {
        ex.totalReceived += p.amount;
        grandTotalReceived += p.amount;
        ex.winCount++;
        grandWins++;
        allWinAmounts.push(p.amount);
      } else if (p.amount < 0) {
        ex.totalPaid += Math.abs(p.amount);
        grandTotalPaid += Math.abs(p.amount);
        ex.lossCount++;
        grandLosses++;
        allLossAmounts.push(Math.abs(p.amount));
      }
      
      const current = ex.bySymbol.get(p.symbol) || { total: 0, wins: 0, losses: 0 };
      current.total += p.amount;
      if (p.amount > 0) current.wins++;
      else if (p.amount < 0) current.losses++;
      ex.bySymbol.set(p.symbol, current);
    }
    ex.netFunding = ex.totalReceived - ex.totalPaid;
  }

  // Calculate win rate metrics
  const totalPayments = grandWins + grandLosses;
  const winRate = totalPayments > 0 ? (grandWins / totalPayments) * 100 : 0;
  const profitFactor = grandTotalPaid > 0 ? grandTotalReceived / grandTotalPaid : grandTotalReceived > 0 ? Infinity : 0;
  const avgWin = allWinAmounts.length > 0 ? allWinAmounts.reduce((a, b) => a + b, 0) / allWinAmounts.length : 0;
  const avgLoss = allLossAmounts.length > 0 ? allLossAmounts.reduce((a, b) => a + b, 0) / allLossAmounts.length : 0;
  const largestWin = allWinAmounts.length > 0 ? Math.max(...allWinAmounts) : 0;
  const largestLoss = allLossAmounts.length > 0 ? Math.max(...allLossAmounts) : 0;
  const winPct = grandWins / (totalPayments || 1);
  const lossPct = grandLosses / (totalPayments || 1);
  const expectancy = (winPct * avgWin) - (lossPct * avgLoss);

  const grandNetFunding = grandTotalReceived - grandTotalPaid;
  const dailyAvg = grandNetFunding / days;
  const annualized = dailyAvg * 365;

  // Win Rate Section
  console.log('');
  console.log('-'.repeat(80));
  console.log('  📊 WIN RATE ANALYSIS');
  console.log('-'.repeat(80));
  
  const wrEmoji = winRate >= 70 ? '🔥' : winRate >= 55 ? '✅' : winRate >= 45 ? '⚠️' : '❌';
  const pfEmoji = profitFactor >= 2.0 ? '🔥 Excellent' : profitFactor >= 1.5 ? '✅ Good' : profitFactor >= 1.0 ? '⚠️ Break-even' : '❌ Losing';
  
  console.log(`\n  ${wrEmoji} Win Rate:        ${winRate.toFixed(1)}% (${grandWins}W / ${grandLosses}L)`);
  console.log(`  📈 Profit Factor:   ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)} ${pfEmoji}`);
  console.log(`  💵 Average Win:     +$${avgWin.toFixed(4)}`);
  console.log(`  💸 Average Loss:    -$${avgLoss.toFixed(4)}`);
  console.log(`  🎯 Win/Loss Ratio:  ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '∞'}x`);
  console.log(`  📊 Expectancy:      ${expectancy >= 0 ? '+' : ''}$${expectancy.toFixed(4)} per payment`);
  console.log(`  🏆 Largest Win:     +$${largestWin.toFixed(4)}`);
  console.log(`  💀 Largest Loss:    -$${largestLoss.toFixed(4)}`);

  // Display by exchange
  console.log('');
  console.log('-'.repeat(80));
  console.log('  🏦 BY EXCHANGE');
  console.log('-'.repeat(80));

  for (const ex of exchanges) {
    if (ex.payments.length === 0) continue;
    
    const sign = ex.netFunding >= 0 ? '+' : '';
    const exWinRate = ex.payments.length > 0 ? (ex.winCount / ex.payments.length) * 100 : 0;
    const exWrEmoji = exWinRate >= 70 ? '🔥' : exWinRate >= 55 ? '✅' : exWinRate >= 45 ? '⚠️' : '❌';
    
    console.log(`\n  ${ex.exchange}:`);
    console.log(`     Payments: ${ex.payments.length} | ${exWrEmoji} Win Rate: ${exWinRate.toFixed(1)}%`);
    console.log(`     Received: +$${ex.totalReceived.toFixed(4)}`);
    console.log(`     Paid:     -$${ex.totalPaid.toFixed(4)}`);
    console.log(`     Net:      ${sign}$${ex.netFunding.toFixed(4)}`);

    // Top symbols with win rate
    const sortedSymbols = Array.from(ex.bySymbol.entries())
      .sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total))
      .slice(0, 5);
    
    if (sortedSymbols.length > 0) {
      console.log('     Top symbols:');
      for (const [symbol, data] of sortedSymbols) {
        const s = data.total >= 0 ? '+' : '';
        const symWr = (data.wins + data.losses) > 0 ? (data.wins / (data.wins + data.losses)) * 100 : 0;
        console.log(`       ${symbol.padEnd(12)}: ${s}$${data.total.toFixed(4)} | WR: ${symWr.toFixed(0)}%`);
      }
    }
  }

  // Grand total
  console.log('');
  console.log('═'.repeat(80));
  console.log('  GRAND TOTAL');
  console.log('═'.repeat(80));
  
  const netSign = grandNetFunding >= 0 ? '+' : '';
  console.log(`\n  Total Received:      +$${grandTotalReceived.toFixed(4)}`);
  console.log(`  Total Paid:          -$${grandTotalPaid.toFixed(4)}`);
  console.log(`  Net Funding:         ${netSign}$${grandNetFunding.toFixed(4)}`);
  console.log(`\n  Daily Average:       ${netSign}$${dailyAvg.toFixed(4)}`);
  console.log(`  Annualized:          ${netSign}$${annualized.toFixed(2)}`);

  // APY calculation
  if (capitalDeployed > 0) {
    const realAPY = (annualized / capitalDeployed) * 100;
    console.log(`\n  📈 Real APY (on $${capitalDeployed}): ${realAPY.toFixed(2)}%`);
  } else {
    console.log('\n  💡 To calculate APY, provide capital as second argument:');
    console.log(`     npx ts-node get-all-funding-payments.ts ${days} 1000`);
  }

  // APY table for different capitals
  console.log('\n  📊 APY at different capital levels:');
  console.log('     Capital     | Real APY');
  console.log('     -----------+---------');
  for (const cap of [500, 1000, 2000, 5000, 10000]) {
    const apy = (annualized / cap) * 100;
    console.log(`     $${cap.toString().padEnd(9)} | ${apy.toFixed(2)}%`);
  }

  console.log('');
  console.log('═'.repeat(80));
  console.log('');
}

main().catch(console.error);

