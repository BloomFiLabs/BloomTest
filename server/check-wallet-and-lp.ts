/**
 * Check wallet balances and LP positions
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.HYPERLIQUID_RPC_URL || 'https://rpc.hyperliquid.xyz/evm';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY not set in .env');
}
// TypeScript now knows PRIVATE_KEY is defined after the check
const PRIVATE_KEY_SAFE: string = PRIVATE_KEY;

const USDC_ADDRESS = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';
const WETH_ADDRESS = '0xADcb2f358Eae6492F61A5F87eb8893d09391d160';
const WHYPE_ADDRESS = '0x5555555555555555555555555555555555555555';

// HyperSwap V3 Position Manager
const POSITION_MANAGER = '0x6eDA206207c09e5428F281761DdC0D300851fBC8';

// Known LP pools
const POOLS = [
  { address: '0x337b56d87a6185cd46af3ac2cdf03cbc37070c30', name: 'WHYPE/USD₮0' },
  { address: '0x55443b2A8Ee28dc35172d9e7D8982b4282415356', name: 'USDC/USD₮0' },
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

const NFT_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function tokenByIndex(uint256) view returns (uint256)',
];

const POSITION_MANAGER_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)',
];

const POOL_ABI = [
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
];

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        CHECK WALLET BALANCES & LP POSITIONS               ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'HyperEVM',
    chainId: 999,
  });
  const wallet = new ethers.Wallet(PRIVATE_KEY_SAFE, provider);
  const walletAddress = wallet.address;

  console.log(`Wallet Address: ${walletAddress}\n`);

  // Check native balance (ETH/HYPE)
  const nativeBalance = await provider.getBalance(walletAddress);
  console.log(`💰 Native Balance: ${ethers.formatEther(nativeBalance)} HYPE\n`);

  // Check token balances
  console.log('📊 Token Balances:');
  console.log('─'.repeat(60));

  const tokens = [
    { address: USDC_ADDRESS, name: 'USDC' },
    { address: WETH_ADDRESS, name: 'WETH' },
    { address: WHYPE_ADDRESS, name: 'WHYPE' },
  ];

  for (const token of tokens) {
    try {
      const tokenContract = new ethers.Contract(token.address, ERC20_ABI, provider);
      const balance = await tokenContract.balanceOf(walletAddress);
      const decimals = await tokenContract.decimals();
      const symbol = await tokenContract.symbol();
      
      if (balance > 0n) {
        console.log(`   ${symbol}: ${ethers.formatUnits(balance, decimals)}`);
      }
    } catch (e: any) {
      // Token might not exist or have different interface
    }
  }

  // Check for LP NFT positions (Uniswap V3 style)
  console.log('\n🎫 Checking for LP NFT Positions (HyperSwap V3):');
  console.log('─'.repeat(60));

  try {
    const positionManager = new ethers.Contract(POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
    const nftBalance = await positionManager.balanceOf(walletAddress);
    
    console.log(`   NFT Balance: ${nftBalance.toString()}`);

    if (nftBalance > 0n) {
      console.log(`\n   Found ${nftBalance.toString()} LP position(s)!`);
      
      for (let i = 0; i < Number(nftBalance); i++) {
        try {
          const tokenId = await positionManager.tokenOfOwnerByIndex(walletAddress, i);
          console.log(`\n   Position #${i + 1} - Token ID: ${tokenId.toString()}`);
          
          // Get position details
          const position = await positionManager.positions(tokenId);
          const [
            nonce,
            operator,
            token0,
            token1,
            fee,
            tickLower,
            tickUpper,
            liquidity,
            feeGrowthInside0LastX128,
            feeGrowthInside1LastX128,
            tokensOwed0,
            tokensOwed1,
          ] = position;

          console.log(`      Token0: ${token0}`);
          console.log(`      Token1: ${token1}`);
          console.log(`      Fee Tier: ${fee}`);
          console.log(`      Liquidity: ${liquidity.toString()}`);
          console.log(`      Tick Range: [${tickLower}, ${tickUpper}]`);
          console.log(`      Tokens Owed0: ${tokensOwed0.toString()}`);
          console.log(`      Tokens Owed1: ${tokensOwed1.toString()}`);

          // Try to get token symbols
          try {
            const token0Contract = new ethers.Contract(token0, ERC20_ABI, provider);
            const token1Contract = new ethers.Contract(token1, ERC20_ABI, provider);
            const token0Symbol = await token0Contract.symbol();
            const token1Symbol = await token1Contract.symbol();
            console.log(`      Pair: ${token0Symbol}/${token1Symbol}`);
          } catch (e) {
            // Couldn't get symbols
          }
        } catch (e: any) {
          console.log(`      ⚠️  Could not read position ${i}: ${e.message}`);
        }
      }
    } else {
      console.log(`   No LP NFT positions found`);
    }
  } catch (e: any) {
    console.log(`   ⚠️  Could not check LP positions: ${e.message}`);
    console.log(`   This might mean the Position Manager contract is different or not accessible`);
  }

  // Check strategy contracts for any remaining funds
  console.log('\n🏦 Checking Strategy Contracts:');
  console.log('─'.repeat(60));

  const strategies = [
    { address: '0x2632250Df5F0aF580f3A91fCBBA119bcEd65107B', name: 'DeltaNeutralFundingStrategy' },
    { address: '0x247062659f997BDb5975b984c2bE2aDF87661314', name: 'HyperEVMFundingStrategy' },
  ];

  for (const strategy of strategies) {
    try {
      const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
      const balance = await usdc.balanceOf(strategy.address);
      if (balance > 0n) {
        console.log(`   ${strategy.name}: ${ethers.formatUnits(balance, 6)} USDC`);
      }
    } catch (e) {
      // Skip
    }
  }

  // Summary
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                      SUMMARY                               ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  
  const finalNative = await provider.getBalance(walletAddress);
  const finalUSDC = await new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider).balanceOf(walletAddress);
  
  console.log(`\n💰 Wallet Balances:`);
  console.log(`   Native (HYPE): ${ethers.formatEther(finalNative)}`);
  console.log(`   USDC: ${ethers.formatUnits(finalUSDC, 6)}`);
  
  try {
    const positionManager = new ethers.Contract(POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
    const nftBalance = await positionManager.balanceOf(walletAddress);
    if (nftBalance > 0n) {
      console.log(`\n🎫 LP Positions: ${nftBalance.toString()} NFT(s) found`);
      console.log(`   These positions may contain liquidity that can be withdrawn`);
    }
  } catch (e) {
    // Skip
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

