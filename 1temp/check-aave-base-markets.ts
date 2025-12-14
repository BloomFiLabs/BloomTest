#!/usr/bin/env npx tsx
/**
 * Check Aave V3 Base Markets
 * 
 * To go delta-neutral, we need to be able to BORROW the volatile asset.
 * This checks which assets are available on Aave V3 Base.
 */

import { ethers } from 'ethers';

// Aave V3 Pool on Base
const AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';

// Aave V3 Pool ABI (minimal)
const POOL_ABI = [
  'function getReservesList() external view returns (address[])',
  'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
];

// ERC20 ABI for getting symbol
const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function name() external view returns (string)',
];

// Known Base tokens for reference
const KNOWN_TOKENS: { [key: string]: string } = {
  '0x4200000000000000000000000000000000000006': 'WETH',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
  '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA': 'USDbC',
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'cbBTC',
  '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb': 'DAI',
  '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22': 'cbETH',
  // ZORA token (if it exists as ERC20)
  '0x78a087d713be963bf307b18f2ff8122ef9a63ae9': 'ZORA', // Placeholder, need to verify
};

const RPC_URL = 'https://mainnet.base.org';

async function main() {
  console.log('');
  console.log('═'.repeat(80));
  console.log('🏦 AAVE V3 BASE NETWORK MARKETS');
  console.log('═'.repeat(80));
  console.log('');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const pool = new ethers.Contract(AAVE_POOL, POOL_ABI, provider);

  console.log('Fetching available markets...\n');

  try {
    const reserves = await pool.getReservesList();
    
    console.log(`Found ${reserves.length} markets on Aave V3 Base:\n`);
    console.log('Asset                           | Address                                    | Borrowable?');
    console.log('-'.repeat(80));

    const borrowableAssets: string[] = [];
    const nonBorrowableAssets: string[] = [];

    for (const reserveAddress of reserves) {
      let symbol = KNOWN_TOKENS[reserveAddress.toLowerCase()];
      
      // If not in known tokens, try to fetch symbol from contract
      if (!symbol) {
        try {
          const token = new ethers.Contract(reserveAddress, ERC20_ABI, provider);
          symbol = await token.symbol();
        } catch (e) {
          symbol = 'UNKNOWN';
        }
      }

      // Get reserve data to check if borrowing is enabled
      try {
        const reserveData = await pool.getReserveData(reserveAddress);
        const config = reserveData.configuration;
        
        // Bit 5 of configuration indicates if borrowing is enabled
        const borrowingEnabled = (config & (1n << 5n)) !== 0n;
        
        const status = borrowingEnabled ? '✅ YES' : '❌ NO';
        
        console.log(
          `${symbol.padEnd(31)} | ` +
          `${reserveAddress} | ` +
          status
        );

        if (borrowingEnabled) {
          borrowableAssets.push(symbol);
        } else {
          nonBorrowableAssets.push(symbol);
        }
      } catch (e) {
        console.log(
          `${symbol.padEnd(31)} | ` +
          `${reserveAddress} | ` +
          '⚠️  ERROR'
        );
      }
    }

    console.log('');
    console.log('═'.repeat(80));
    console.log('📊 SUMMARY');
    console.log('═'.repeat(80));
    console.log('');
    console.log(`Total Assets:      ${reserves.length}`);
    console.log(`Borrowable:        ${borrowableAssets.length}`);
    console.log(`Non-Borrowable:    ${nonBorrowableAssets.length}`);
    console.log('');

    console.log('✅ BORROWABLE ASSETS (Can go delta-neutral):');
    console.log('   ' + borrowableAssets.join(', '));
    console.log('');

    if (nonBorrowableAssets.length > 0) {
      console.log('❌ NON-BORROWABLE ASSETS (Cannot go delta-neutral):');
      console.log('   ' + nonBorrowableAssets.join(', '));
      console.log('');
    }

    console.log('═'.repeat(80));
    console.log('🎯 DELTA-NEUTRAL STRATEGY VIABILITY');
    console.log('═'.repeat(80));
    console.log('');

    const canBorrowWETH = borrowableAssets.includes('WETH');
    const canBorrowZORA = borrowableAssets.includes('ZORA');

    if (canBorrowWETH) {
      console.log('✅ WETH/USDC POOL:');
      console.log('   - WETH is borrowable on Aave');
      console.log('   - Can go delta-neutral');
      console.log('   - Pool APR: 48.35%');
      console.log('   - Estimated Net APY: 15-25%');
      console.log('');
    } else {
      console.log('❌ WETH/USDC POOL:');
      console.log('   - WETH is NOT borrowable on Aave');
      console.log('   - Cannot go delta-neutral');
      console.log('');
    }

    if (canBorrowZORA) {
      console.log('✅ ZORA/USDC POOL:');
      console.log('   - ZORA is borrowable on Aave');
      console.log('   - Can go delta-neutral');
      console.log('   - Pool APR: 63.31%');
      console.log('   - Estimated Net APY: 30-50%');
      console.log('');
    } else {
      console.log('❌ ZORA/USDC POOL:');
      console.log('   - ZORA is NOT borrowable on Aave');
      console.log('   - Cannot go delta-neutral');
      console.log('   - Would have LONG ZORA exposure (risky!)');
      console.log('');
    }

    console.log('═'.repeat(80));
    console.log('💡 RECOMMENDATION');
    console.log('═'.repeat(80));
    console.log('');

    if (canBorrowWETH && !canBorrowZORA) {
      console.log('✅ USE WETH/USDC POOL');
      console.log('');
      console.log('   ZORA is not available on Aave, so you cannot hedge ZORA exposure.');
      console.log('   WETH/USDC is the best option for true delta-neutral strategy.');
      console.log('');
      console.log('   With fixed APR calculation:');
      console.log('   - Base APR: 48.35% (7-day avg)');
      console.log('   - Net APY: 15-25%');
      console.log('   - Your current $37.74 position: $6-9/year profit');
      console.log('');
    } else if (canBorrowZORA && canBorrowWETH) {
      console.log('🚀 BOTH POOLS VIABLE!');
      console.log('');
      console.log('   You can choose based on APR:');
      console.log('   - ZORA/USDC: 63.31% APR → 30-50% Net APY');
      console.log('   - WETH/USDC: 48.35% APR → 15-25% Net APY');
      console.log('');
    } else {
      console.log('⚠️  NEITHER POOL IDEAL');
      console.log('');
      console.log('   Consider other chains (Arbitrum, Optimism) with more Aave markets.');
      console.log('');
    }

  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

main().catch(console.error);










