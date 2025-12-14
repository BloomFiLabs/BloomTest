/**
 * Find LP Positions - Scan all NFTs
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.HYPERLIQUID_RPC_URL || 'https://rpc.hyperliquid.xyz/evm';
const POSITION_MANAGER = '0x6eDA206207c09e5428F281761DdC0D300851fBC8';
const USDC = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';

const addresses = [
  '0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03', // Wallet
  '0x7Eedc4088b197B4EE05BBB00B8c957C411B533Df', // Vault
  '0x2632250Df5F0aF580f3A91fCBBA119bcEd65107B', // Strategy 1
  '0x247062659f997BDb5975b984c2bE2aDF87661314', // Strategy 2
];

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           FIND LP POSITIONS - FULL SCAN                    ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'HyperEVM',
    chainId: 999,
  });

  const positionManager = new ethers.Contract(POSITION_MANAGER, [
    'function totalSupply() view returns (uint256)',
    'function tokenByIndex(uint256) view returns (uint256)',
    'function ownerOf(uint256) view returns (address)',
    'function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)',
  ], provider);

  try {
    const totalSupply = await positionManager.totalSupply();
    console.log(`Total LP NFTs: ${totalSupply.toString()}\n`);

    // Check last 500 NFTs (most recent)
    const checkCount = Math.min(500, Number(totalSupply));
    console.log(`Scanning last ${checkCount} NFTs...\n`);

    let found = 0;

    for (let i = 0; i < checkCount; i++) {
      try {
        const tokenId = await positionManager.tokenByIndex(totalSupply - BigInt(i) - 1n);
        const owner = await positionManager.ownerOf(tokenId);
        
        const addressMatch = addresses.find(addr => 
          addr.toLowerCase() === owner.toLowerCase()
        );

        if (addressMatch) {
          found++;
          const position = await positionManager.positions(tokenId);
          const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = position;
          
          console.log(`\n✅ FOUND LP POSITION #${found}!`);
          console.log(`   Token ID: ${tokenId}`);
          console.log(`   Owner: ${owner}`);
          console.log(`   Token0: ${token0}`);
          console.log(`   Token1: ${token1}`);
          console.log(`   Fee: ${fee}`);
          console.log(`   Liquidity: ${liquidity.toString()}`);
          console.log(`   Tick Range: [${tickLower}, ${tickUpper}]`);
          console.log(`   Tokens Owed0: ${tokensOwed0.toString()}`);
          console.log(`   Tokens Owed1: ${tokensOwed1.toString()}`);
          
          // Check if USDC
          if (token0.toLowerCase() === USDC.toLowerCase()) {
            console.log(`   💰 CONTAINS USDC AS TOKEN0!`);
          }
          if (token1.toLowerCase() === USDC.toLowerCase()) {
            console.log(`   💰 CONTAINS USDC AS TOKEN1!`);
          }
        }

        // Progress indicator
        if ((i + 1) % 100 === 0) {
          console.log(`   Scanned ${i + 1}/${checkCount}...`);
        }
      } catch (e) {
        // Skip errors
      }
    }

    if (found === 0) {
      console.log(`\n⚠️  No LP positions found in last ${checkCount} NFTs`);
      console.log(`   Try scanning more or check if positions are older`);
    } else {
      console.log(`\n✅ Found ${found} LP position(s) total!`);
    }

  } catch (e: any) {
    console.log(`❌ Error: ${e.message}`);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

