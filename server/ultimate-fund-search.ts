/**
 * Ultimate Fund Search - Check everything possible
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
const HYPERLEND_POOL = '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b';
const USDC = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';
const POSITION_MANAGER = '0x6eDA206207c09e5428F281761DdC0D300851fBC8';

// HyperLend aToken (USDC deposit token)
// When you deposit USDC to HyperLend, you get aUSDC tokens
// Let's find the aUSDC address
const HYPERLEND_ATOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function underlyingAsset() view returns (address)',
];

const HYPERLEND_POOL_ABI = [
  'function getUserAccountData(address) view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
  'function getReserveData(address) view returns (tuple(uint256, uint128, uint128, uint128, uint128, uint128, uint128, uint40, uint16, address, address, address, address, address, uint8))',
];

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         ULTIMATE FUND SEARCH - EVERYTHING                   ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'HyperEVM',
    chainId: 999,
  });

  // 1. Get HyperLend reserve data to find aToken address
  console.log('🔍 STEP 1: Finding HyperLend aToken Address');
  console.log('─'.repeat(60));
  
  try {
    const lendingPool = new ethers.Contract(HYPERLEND_POOL, HYPERLEND_POOL_ABI, provider);
    
    // Get reserve data for USDC
    const reserveData = await lendingPool.getReserveData(USDC);
    // Reserve data is a tuple, need to access properly
    // Try to get the aToken address - it's usually at a specific index
    // Let's try accessing as array or tuple
    let aTokenAddress: string;
    try {
      // Try as array access
      aTokenAddress = reserveData[6];
    } catch {
      // Try as tuple property
      aTokenAddress = reserveData.aTokenAddress || reserveData[6];
    }
    
    // Convert to address if it's a number
    if (typeof aTokenAddress === 'bigint' || typeof aTokenAddress === 'number') {
      aTokenAddress = ethers.getAddress('0x' + BigInt(aTokenAddress).toString(16).padStart(40, '0'));
    }
    
    console.log(`   aUSDC Address: ${aTokenAddress}`);
    
    // Check aToken balance
    const aToken = new ethers.Contract(aTokenAddress, HYPERLEND_ATOKEN_ABI, provider);
    const aTokenBalance = await aToken.balanceOf(STRATEGY);
    console.log(`   aUSDC Balance: ${ethers.formatUnits(aTokenBalance, 6)}`);
    
    if (aTokenBalance > 0n) {
      console.log(`   ✅ FOUND COLLATERAL IN HYPERLEND!`);
      console.log(`   💰 This is the 110 USDC!`);
    }
    
    // Also check wallet
    const walletATokenBalance = await aToken.balanceOf('0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03');
    if (walletATokenBalance > 0n) {
      console.log(`   ✅ FOUND aUSDC IN WALLET: ${ethers.formatUnits(walletATokenBalance, 6)}`);
    }
    
  } catch (e: any) {
    console.log(`   ⚠️  Error: ${e.message}`);
  }

  // 2. Check all possible LP positions by scanning recent mints
  console.log('\n💧 STEP 2: Scanning for LP Positions');
  console.log('─'.repeat(60));
  
  try {
    const positionManager = new ethers.Contract(POSITION_MANAGER, [
      'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1, uint256)',
      'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
    ], provider);

    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 50000); // Last 50k blocks
    
    console.log(`   Scanning blocks ${fromBlock} to ${currentBlock}...`);
    
    // Search for mints to our addresses
    const addresses = [
      '0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03',
      '0x7Eedc4088b197B4EE05BBB00B8c957C411B533Df',
      STRATEGY,
    ];

    for (const address of addresses) {
      try {
        const mintFilter = positionManager.filters.Mint(null, address);
        const mints = await positionManager.queryFilter(mintFilter, fromBlock, currentBlock);
        
        if (mints.length > 0) {
          console.log(`\n   ✅ FOUND ${mints.length} LP MINT(S) for ${address.slice(0, 10)}...`);
          
          for (const mint of mints.slice(-5)) { // Last 5
            console.log(`      Block ${mint.blockNumber}:`);
            console.log(`         Amount0: ${mint.args[5]?.toString() || 'N/A'}`);
            console.log(`         Amount1: ${mint.args[6]?.toString() || 'N/A'}`);
          }
        }
      } catch (e: any) {
        if (!e.message.includes('10 block range')) {
          console.log(`   ⚠️  Error checking ${address}: ${e.message}`);
        }
      }
    }
  } catch (e: any) {
    console.log(`   ⚠️  LP scan error: ${e.message}`);
  }

  // 3. Check if strategy has any other token balances
  console.log('\n💵 STEP 3: Check All Token Balances in Strategy');
  console.log('─'.repeat(60));
  
  const commonTokens = [
    { address: USDC, name: 'USDC' },
    { address: '0xADcb2f358Eae6492F61A5F87eb8893d09391d160', name: 'WETH' },
    { address: '0x5555555555555555555555555555555555555555', name: 'WHYPE' },
  ];

  for (const token of commonTokens) {
    try {
      const tokenContract = new ethers.Contract(token.address, [
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)',
      ], provider);
      
      const balance = await tokenContract.balanceOf(STRATEGY);
      const decimals = await tokenContract.decimals();
      
      if (balance > 0n) {
        console.log(`   ✅ ${token.name}: ${ethers.formatUnits(balance, decimals)}`);
      }
    } catch (e) {
      // Skip
    }
  }

  // 4. Try to read strategy storage directly
  console.log('\n🔐 STEP 4: Reading Strategy Storage');
  console.log('─'.repeat(60));
  
  try {
    // totalPrincipal is likely at a specific storage slot
    // Solidity storage: mapping and uint256 are at specific slots
    // Let's try to read storage slot 0 (first state variable)
    const storage0 = await provider.getStorage(STRATEGY, 0);
    console.log(`   Storage Slot 0: ${storage0}`);
    
    // Try a few more slots
    for (let i = 1; i < 10; i++) {
      try {
        const storage = await provider.getStorage(STRATEGY, i);
        if (storage !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
          console.log(`   Storage Slot ${i}: ${storage}`);
          // Convert to USDC if it looks like it (6 decimals, reasonable amount)
          const value = BigInt(storage);
          if (value > 1000000n && value < 1000000000000n) { // Between 1 and 1M USDC
            console.log(`      → Could be USDC amount: ${ethers.formatUnits(value, 6)}`);
          }
        }
      } catch (e) {
        // Skip
      }
    }
  } catch (e: any) {
    console.log(`   ⚠️  Storage read error: ${e.message}`);
  }

  console.log('\n✅ Search complete!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

