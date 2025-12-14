/**
 * Leveraged HyperSwap V3 Strategy Keeper Bot
 * 
 * Connected to on-chain deployed contract:
 * - Vault: 0x77899978a2605b48668E2073b99EE51446f75e31
 * - Strategy: 0x8a84642BF5FF4316dad8Bc01766DE68d6287f126
 * 
 * Features:
 * - 2-3x leverage via HyperLend
 * - Smart earning trimming from winning positions
 * - Auto-deleverage fallback
 * - Emergency exit protection
 */

import { ethers } from 'ethers';
import { gql, GraphQLClient } from 'graphql-request';
import * as dotenv from 'dotenv';

dotenv.config();

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════

const CONFIG = {
  // Network
  rpcUrl: process.env.HYPEREVM_RPC_URL || 'https://rpc.hyperliquid.xyz/evm',
  chainId: 999,
  
  // Deployed & FUNDED contracts (via proper vault deposit)
  vaultAddress: '0x77899978a2605b48668E2073b99EE51446f75e31',
  strategyAddress: '0x8a84642BF5FF4316dad8Bc01766DE68d6287f126',
  
  // Tokens
  usdcAddress: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
  
  // Pool for LP
  poolAddress: '0x55443b2A8Ee28dc35172d9e7D8982b4282415356', // USDC/USD₮
  
  // Subgraph
  subgraphUrl: 'https://api.goldsky.com/api/public/project_cm97l77ib0cz601wlgi9wb0ec/subgraphs/v3-subgraph/6.0.0/gn',
  
  // Health thresholds (must match contract)
  targetHF: 20000,        // 2.0
  trimThreshold: 15000,   // 1.5
  deleverageThreshold: 13000, // 1.3
  emergencyThreshold: 11500, // 1.15
  
  // Execution
  intervalSeconds: 30,
  dryRun: process.env.DRY_RUN !== 'false',
};

// ═══════════════════════════════════════════════════════════
// ABIs
// ═══════════════════════════════════════════════════════════

const STRATEGY_ABI = [
  // Views
  'function getHealthFactor() view returns (uint256)',
  'function checkHealth() view returns (uint8)',
  'function getCurrentLeverage() view returns (uint256)',
  'function getLendData() view returns (uint256 collateral, uint256 debt, uint256 availableBorrow, uint256 liquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function getPerps() view returns (tuple(uint32 coin, int64 szi, int64 entryPx)[])',
  'function getPerpEquity() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalPrincipal() view returns (uint256)',
  'function targetLeverage() view returns (uint256)',
  'function maxLeverage() view returns (uint256)',
  
  // Actions
  'function depositCollateral(uint256 amt)',
  'function withdrawCollateral(uint256 amt)',
  'function borrow(uint256 amt)',
  'function repay(uint256 amt)',
  'function adjustHedge(bool isLong, uint64 sz, uint64 px)',
  'function transferUSD(uint64 amt, bool toPerp)',
  'function closeAllPerps()',
  'function trimFromPerp(uint64 amount)',
  'function deleverage(uint256 repayAmount)',
  'function leverageUp(uint256 borrowAmount)',
  'function emergencyExit()',
  
  // Events
  'event EarningsTrimmed(string source, uint256 amount)',
  'event Deleveraged(uint256 repaid, uint256 newHF)',
  'event LeveragedUp(uint256 borrowed, uint256 newLev)',
  'event EmergencyExit(uint256 returned)',
  'event HedgeAdjusted(int64 size)',
];

const VAULT_ABI = [
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
];

// ═══════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════

let provider: ethers.JsonRpcProvider;
let signer: ethers.Wallet;
let strategyContract: ethers.Contract;
let vaultContract: ethers.Contract;
let graphClient: GraphQLClient;

// ═══════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════

async function initialize() {
  console.log('🔧 Initializing...');
  
  provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY not set in environment');
  }
  
  signer = new ethers.Wallet(privateKey, provider);
  console.log(`   Keeper address: ${signer.address}`);
  
  strategyContract = new ethers.Contract(CONFIG.strategyAddress, STRATEGY_ABI, signer);
  vaultContract = new ethers.Contract(CONFIG.vaultAddress, VAULT_ABI, signer);
  graphClient = new GraphQLClient(CONFIG.subgraphUrl);
  
  // Verify connection
  const [healthFactor, leverage] = await Promise.all([
    strategyContract.getHealthFactor().catch(() => BigInt(0)),
    strategyContract.getCurrentLeverage().catch(() => BigInt(10000)),
  ]);
  
  console.log(`   Connected to strategy: ${CONFIG.strategyAddress}`);
  console.log(`   Current HF: ${Number(healthFactor) / 10000}`);
  console.log(`   Current Leverage: ${Number(leverage) / 10000}x`);
}

// ═══════════════════════════════════════════════════════════
// DATA FETCHING
// ═══════════════════════════════════════════════════════════

async function fetchStrategyState() {
  const [
    healthFactor,
    healthAction,
    leverage,
    lendData,
    perps,
    perpEquity,
    totalAssets,
    principal,
  ] = await Promise.all([
    strategyContract.getHealthFactor(),
    strategyContract.checkHealth(),
    strategyContract.getCurrentLeverage(),
    strategyContract.getLendData(),
    strategyContract.getPerps().catch(() => []),
    strategyContract.getPerpEquity().catch(() => BigInt(0)),
    strategyContract.totalAssets().catch(() => BigInt(0)),
    strategyContract.totalPrincipal().catch(() => BigInt(0)),
  ]);
  
  return {
    healthFactor: Number(healthFactor) / 10000,
    healthAction: Number(healthAction),
    leverage: Number(leverage) / 10000,
    collateral: Number(lendData[0]) / 1e6,
    debt: Number(lendData[1]) / 1e6,
    availableBorrow: Number(lendData[2]) / 1e6,
    perps,
    perpEquity: Number(perpEquity) / 1e6,
    totalAssets: Number(totalAssets) / 1e6,
    principal: Number(principal) / 1e6,
  };
}

async function fetchFundingRate(): Promise<{ rate: number; markPrice: number }> {
  try {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    const data = await response.json();
    const hypeIndex = data[0]?.universe?.findIndex((m: any) => m.name === 'HYPE') ?? -1;
    const ctx = data[1]?.[hypeIndex];
    
    return {
      rate: parseFloat(ctx?.funding) || 0.000125,
      markPrice: parseFloat(ctx?.markPx) || 33,
    };
  } catch {
    return { rate: 0.000125, markPrice: 33 };
  }
}

async function fetchPoolAPR(): Promise<number> {
  const query = gql`
    query GetPoolAPR($pool: String!) {
      poolDayDatas(where: { pool: $pool }, orderBy: date, orderDirection: desc, first: 7) {
        feesUSD
        tvlUSD
      }
    }
  `;
  
  try {
    const data = await graphClient.request<any>(query, { pool: CONFIG.poolAddress });
    let totalFees = 0, totalTvl = 0, count = 0;
    
    for (const day of data.poolDayDatas || []) {
      const fees = parseFloat(day.feesUSD);
      const tvl = parseFloat(day.tvlUSD);
      if (tvl > 0) { totalFees += fees; totalTvl += tvl; count++; }
    }
    
    if (count === 0) return 80;
    return (totalFees / count / (totalTvl / count)) * 365 * 100;
  } catch {
    return 80;
  }
}

// ═══════════════════════════════════════════════════════════
// HEALTH ACTIONS
// ═══════════════════════════════════════════════════════════

async function trimEarnings(state: Awaited<ReturnType<typeof fetchStrategyState>>) {
  // Check perp PnL
  let perpPnL = 0;
  for (const pos of state.perps) {
    const pnl = Number(pos.szi) * (state.perpEquity - Number(pos.entryPx));
    perpPnL += pnl;
  }
  
  const lpPnL = state.totalAssets - state.principal;
  
  console.log(`   Perp PnL: $${perpPnL.toFixed(2)}`);
  console.log(`   LP PnL: $${lpPnL.toFixed(2)}`);
  
  if (perpPnL > 10) {
    // Trim from perp (convert to 1e6 scale for contract)
    const trimAmount = Math.floor(perpPnL * 0.5 * 1e6);
    console.log(`   ✂️  Trimming $${(trimAmount / 1e6).toFixed(2)} from perp`);
    
    if (!CONFIG.dryRun) {
      const tx = await strategyContract.trimFromPerp(trimAmount);
      console.log(`   TX: ${tx.hash}`);
      await tx.wait();
    }
    return { trimmed: true, source: 'perp', amount: trimAmount / 1e6 };
  }
  
  return { trimmed: false, source: 'none', amount: 0 };
}

async function doDeleverage(state: Awaited<ReturnType<typeof fetchStrategyState>>) {
  // Calculate repay amount to restore target HF
  // HF = (collateral * 0.75) / debt
  // targetHF = (collateral * 0.75) / (debt - repay)
  // repay = debt - (collateral * 0.75) / targetHF
  const targetBorrowed = (state.collateral * 0.75) / 2.0; // target HF = 2.0
  const repayAmount = Math.max(0, state.debt - targetBorrowed);
  
  console.log(`   ⚠️  Deleveraging: Repaying $${repayAmount.toFixed(2)}`);
  
  if (!CONFIG.dryRun && repayAmount > 0) {
    const repayAmountWei = BigInt(Math.floor(repayAmount * 1e6));
    const tx = await strategyContract.deleverage(repayAmountWei);
    console.log(`   TX: ${tx.hash}`);
    await tx.wait();
  }
  
  return { repaid: repayAmount };
}

async function doEmergencyExit() {
  console.log('   🚨 EMERGENCY EXIT');
  
  if (!CONFIG.dryRun) {
    const tx = await strategyContract.emergencyExit();
    console.log(`   TX: ${tx.hash}`);
    await tx.wait();
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN EXECUTION CYCLE
// ═══════════════════════════════════════════════════════════

async function executeCycle() {
  console.log('\n' + '═'.repeat(70));
  console.log('       LEVERAGED STRATEGY EXECUTION CYCLE');
  console.log('═'.repeat(70));
  console.log(`⏰ ${new Date().toISOString()}`);
  
  // 1. Fetch on-chain state
  const state = await fetchStrategyState();
  
  console.log('\n📊 ON-CHAIN STATE:');
  console.log(`   Health Factor:  ${state.healthFactor.toFixed(2)} ${state.healthFactor >= 2 ? '✅' : state.healthFactor >= 1.5 ? '🟡' : '🔴'}`);
  console.log(`   Leverage:       ${state.leverage.toFixed(2)}x`);
  console.log(`   Collateral:     $${state.collateral.toFixed(2)}`);
  console.log(`   Debt:           $${state.debt.toFixed(2)}`);
  console.log(`   Total Assets:   $${state.totalAssets.toFixed(2)}`);
  console.log(`   Principal:      $${state.principal.toFixed(2)}`);
  console.log(`   PnL:            $${(state.totalAssets - state.principal).toFixed(2)}`);
  
  // 2. Check health action
  const healthLabels = ['HEALTHY', 'TRIM', 'DELEVERAGE', 'EMERGENCY'];
  console.log(`\n🏥 HEALTH ACTION: ${healthLabels[state.healthAction]}`);
  
  // 3. Execute health actions
  if (state.healthAction === 3) {
    await doEmergencyExit();
    return;
  }
  
  if (state.healthAction === 2) {
    // Deleverage threshold - try trim first
    const trimResult = await trimEarnings(state);
    if (!trimResult.trimmed) {
      await doDeleverage(state);
    }
    return;
  }
  
  if (state.healthAction === 1) {
    // Trim threshold
    await trimEarnings(state);
    return;
  }
  
  // 4. Calculate APY
  const [poolAPR, funding] = await Promise.all([
    fetchPoolAPR(),
    fetchFundingRate(),
  ]);
  
  const fundingAPY = funding.rate * 8760 * 100;
  const borrowCost = (state.leverage - 1) * 5.5;
  const leveragedAPY = (poolAPR + fundingAPY) * state.leverage - borrowCost;
  
  console.log('\n📈 APY METRICS:');
  console.log(`   Pool APR:       ${poolAPR.toFixed(2)}%`);
  console.log(`   Funding APY:    ${fundingAPY.toFixed(2)}%`);
  console.log(`   Borrow Cost:    -${borrowCost.toFixed(2)}%`);
  console.log(`   ─────────────────────────`);
  console.log(`   NET LEVERAGED:  ${leveragedAPY.toFixed(2)}% 🎯`);
  
  // 5. Check if should leverage up
  if (state.healthFactor > 2.5 && state.leverage < 2.0 && state.collateral > 0) {
    console.log('\n📈 Could leverage up (HF healthy, below target leverage)');
    // Would call leverageUp() here
  }
  
  console.log('\n✅ POSITION HEALTHY');
  console.log('═'.repeat(70));
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║     LEVERAGED HYPERSWAP V3 STRATEGY - LIVE KEEPER BOT             ║');
  console.log('╠════════════════════════════════════════════════════════════════════╣');
  console.log('║  Vault:    0x658aF928F56391bFdbf3A7d16D5016db08f791d0              ║');
  console.log('║  Strategy: 0x6b1B1bb0DfF1104c7eE3C88bC18f371D17C21e04              ║');
  console.log('╠════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Dry Run: ${CONFIG.dryRun ? 'YES (no txs)' : 'NO (LIVE!)'}                                           ║`);
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  
  await initialize();
  
  // Initial run
  await executeCycle();
  
  // Continuous monitoring
  console.log(`\n🔄 Running keeper loop every ${CONFIG.intervalSeconds}s...`);
  
  setInterval(async () => {
    try {
      await executeCycle();
    } catch (error: any) {
      console.error('\n❌ Execution error:', error.message);
    }
  }, CONFIG.intervalSeconds * 1000);
}

main().catch(console.error);

