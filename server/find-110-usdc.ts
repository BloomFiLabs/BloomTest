/**
 * Find the 110 USDC - Deep dive into DeltaNeutralFundingStrategy
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.HYPERLIQUID_RPC_URL || 'https://rpc.hyperliquid.xyz/evm';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY not set in .env');
}

const STRATEGY = '0x2632250Df5F0aF580f3A91fCBBA119bcEd65107B';
const VAULT = '0x7Eedc4088b197B4EE05BBB00B8c957C411B533Df';
const HYPERLEND_POOL = '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b';
const USDC = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';
const POSITION_MANAGER = '0x6eDA206207c09e5428F281761DdC0D300851fBC8';

const STRATEGY_ABI = [
  'function totalAssets() view returns (uint256)',
  'function totalPrincipal() view returns (uint256)',
  'function getIdleUSDC() view returns (uint256)',
  'function getHyperLendData() view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
  'function getPerpEquity() view returns (uint256)',
  'function getCollateralBalance() view returns (uint256)',
  'function lendingPool() view returns (address)',
  'function usdc() view returns (address)',
];

const HYPERLEND_ABI = [
  'function getUserAccountData(address) view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
];

const POSITION_MANAGER_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           FIND THE 110 USDC - DEEP DIVE                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'HyperEVM',
    chainId: 999,
  });

  const strategy = new ethers.Contract(STRATEGY, STRATEGY_ABI, provider);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, provider);

  console.log(`Strategy: ${STRATEGY}\n`);

  // 1. Check strategy state
  console.log('📊 Strategy State:');
  console.log('─'.repeat(60));
  
  try {
    const totalAssets = await strategy.totalAssets();
    console.log(`   Total Assets: ${ethers.formatUnits(totalAssets, 6)} USDC`);
  } catch (e: any) {
    console.log(`   ⚠️  totalAssets: ${e.message}`);
  }

  try {
    const totalPrincipal = await strategy.totalPrincipal();
    console.log(`   Total Principal: ${ethers.formatUnits(totalPrincipal, 6)} USDC`);
  } catch (e: any) {
    console.log(`   ⚠️  totalPrincipal: ${e.message}`);
  }

  try {
    const idleUSDC = await strategy.getIdleUSDC();
    console.log(`   Idle USDC: ${ethers.formatUnits(idleUSDC, 6)} USDC`);
    if (idleUSDC > 0n) {
      console.log(`   ✅ FOUND IDLE USDC!`);
    }
  } catch (e: any) {
    console.log(`   ⚠️  getIdleUSDC: ${e.message}`);
  }

  // 2. Check HyperLend position
  console.log('\n🏦 HyperLend Position:');
  console.log('─'.repeat(60));
  
  try {
    const [collateral, debt, availableBorrows, liquidationThreshold, ltv, healthFactor] = 
      await strategy.getHyperLendData();
    
    console.log(`   Collateral: ${ethers.formatUnits(collateral, 6)} USD`);
    console.log(`   Debt: ${ethers.formatUnits(debt, 18)} ETH`);
    console.log(`   Health Factor: ${ethers.formatEther(healthFactor)}`);
    
    if (collateral > 0n) {
      console.log(`   ✅ FOUND COLLATERAL IN HYPERLEND!`);
      console.log(`   💰 This is likely where the 110 USDC is!`);
    }
  } catch (e: any) {
    console.log(`   ⚠️  getHyperLendData: ${e.message}`);
    
    // Try direct HyperLend call
    try {
      const lendingPool = new ethers.Contract(HYPERLEND_POOL, HYPERLEND_ABI, provider);
      const [totalCollateralUSD, totalDebtUSD, availableBorrowsUSD, currentLiquidationThreshold, ltv, healthFactor] =
        await lendingPool.getUserAccountData(STRATEGY);
      
      console.log(`\n   Direct HyperLend Query:`);
      console.log(`      Collateral: ${ethers.formatUnits(totalCollateralUSD, 8)} USD`);
      console.log(`      Debt: ${ethers.formatUnits(totalDebtUSD, 8)} USD`);
      
      if (totalCollateralUSD > 0n) {
        console.log(`   ✅ FOUND COLLATERAL IN HYPERLEND!`);
        console.log(`   💰 This is likely where the 110 USDC is!`);
      }
    } catch (e2: any) {
      console.log(`   ⚠️  Direct HyperLend query failed: ${e2.message}`);
    }
  }

  // 3. Check perp equity
  console.log('\n📈 Perp Position:');
  console.log('─'.repeat(60));
  
  try {
    const perpEquity = await strategy.getPerpEquity();
    console.log(`   Perp Equity: ${ethers.formatUnits(perpEquity, 6)} USD`);
    if (perpEquity !== 0n) {
      console.log(`   ✅ FOUND PERP POSITION!`);
    }
  } catch (e: any) {
    console.log(`   ⚠️  getPerpEquity: ${e.message}`);
  }

  // 4. Check collateral balance
  try {
    const collateralBalance = await strategy.getCollateralBalance();
    console.log(`\n   Collateral Balance: ${ethers.formatUnits(collateralBalance, 6)} USDC`);
    if (collateralBalance > 0n) {
      console.log(`   ✅ FOUND COLLATERAL BALANCE!`);
    }
  } catch (e: any) {
    console.log(`   ⚠️  getCollateralBalance: ${e.message}`);
  }

  // 5. Check raw USDC balance
  console.log('\n💵 Raw Token Balances:');
  console.log('─'.repeat(60));
  
  const usdcInStrategy = await usdc.balanceOf(STRATEGY);
  console.log(`   USDC in Strategy Contract: ${ethers.formatUnits(usdcInStrategy, 6)} USDC`);

  // 6. Check LP positions owned by strategy
  console.log('\n💧 LP Positions:');
  console.log('─'.repeat(60));
  
  try {
    const positionManager = new ethers.Contract(POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
    const nftBalance = await positionManager.balanceOf(STRATEGY);
    console.log(`   LP NFT Balance: ${nftBalance.toString()}`);
    
    if (nftBalance > 0n) {
      console.log(`   ✅ FOUND ${nftBalance.toString()} LP POSITION(S)!`);
      console.log(`   💰 This could be where the 110 USDC is!`);
      
      for (let i = 0; i < Number(nftBalance); i++) {
        const tokenId = await positionManager.tokenOfOwnerByIndex(STRATEGY, i);
        const position = await positionManager.positions(tokenId);
        const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = position;
        
        console.log(`\n      Position #${i + 1} (Token ID: ${tokenId}):`);
        console.log(`         Token0: ${token0}`);
        console.log(`         Token1: ${token1}`);
        console.log(`         Fee: ${fee}`);
        console.log(`         Liquidity: ${liquidity.toString()}`);
        console.log(`         Tokens Owed0: ${tokensOwed0.toString()}`);
        console.log(`         Tokens Owed1: ${tokensOwed1.toString()}`);
        
        // Check if token0 or token1 is USDC
        if (token0.toLowerCase() === USDC.toLowerCase() || token1.toLowerCase() === USDC.toLowerCase()) {
          console.log(`         ✅ THIS POSITION CONTAINS USDC!`);
        }
      }
    }
  } catch (e: any) {
    console.log(`   ⚠️  LP check failed: ${e.message}`);
  }

  // 7. Check vault
  console.log('\n📦 Vault Check:');
  console.log('─'.repeat(60));
  
  try {
    const vault = new ethers.Contract(VAULT, [
      'function totalAssets() view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
    ], provider);
    
    const vaultAssets = await vault.totalAssets();
    console.log(`   Vault Total Assets: ${ethers.formatUnits(vaultAssets, 6)} USDC`);
    
    if (vaultAssets > 0n) {
      console.log(`   ✅ FOUND ASSETS IN VAULT!`);
    }
  } catch (e: any) {
    console.log(`   ⚠️  Vault check failed: ${e.message}`);
  }

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                      SUMMARY                               ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('\nThe 110.9 USDC principal suggests funds were deposited.');
  console.log('Check the findings above to locate where they are:\n');
  console.log('   - HyperLend collateral (most likely)');
  console.log('   - LP positions');
  console.log('   - Perp margin');
  console.log('   - Vault');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

