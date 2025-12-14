/**
 * Deep Chain Analysis - Find All Funds
 * Like Chainalysis - comprehensive on-chain investigation
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.HYPERLIQUID_RPC_URL || 'https://rpc.hyperliquid.xyz/evm';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY not set in .env');
}

const WALLET_ADDRESS = '0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03';
const VAULT_ADDRESS = '0x7Eedc4088b197B4EE05BBB00B8c957C411B533Df';
const STRATEGY_1 = '0x2632250Df5F0aF580f3A91fCBBA119bcEd65107B';
const STRATEGY_2 = '0x247062659f997BDb5975b984c2bE2aDF87661314';

const USDC_ADDRESS = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';
const WETH_ADDRESS = '0xADcb2f358Eae6492F61A5F87eb8893d09391d160';
const WHYPE_ADDRESS = '0x5555555555555555555555555555555555555555';

// HyperLend Pool
const HYPERLEND_POOL = '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b';

// HyperSwap V3
const POSITION_MANAGER = '0x6eDA206207c09e5428F281761DdC0D300851fBC8';
const FACTORY = '0xB1c0fa0B789320044A6F623cFe5eBda9562602E3';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
];

const HYPERLEND_ABI = [
  'function getUserAccountData(address) view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
  'function getReserveData(address) view returns (tuple)',
];

const POSITION_MANAGER_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)',
];

// Events to search for
const TRANSFER_EVENT = 'event Transfer(address indexed from, address indexed to, uint256 value)';
const DEPOSIT_EVENT = 'event Deposit(address indexed user, address indexed asset, uint256 amount)';
const WITHDRAW_EVENT = 'event Withdraw(address indexed user, address indexed asset, uint256 amount)';
const MINT_EVENT = 'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)';

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         DEEP CHAIN ANALYSIS - FIND ALL FUNDS             ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'HyperEVM',
    chainId: 999,
  });

  console.log(`Analyzing: ${WALLET_ADDRESS}\n`);

  // 1. Check all token balances
  await checkAllTokenBalances(provider);

  // 2. Check HyperLend positions
  await checkHyperLendPositions(provider);

  // 3. Check LP positions (multiple methods)
  await checkLPPositions(provider);

  // 4. Check strategy contract balances
  await checkStrategyBalances(provider);

  // 5. Check vault balances
  await checkVaultBalances(provider);

  // 6. Search for recent transactions
  await searchRecentTransactions(provider);

  // 7. Check for LP NFTs with different methods
  await checkLPNFTsAdvanced(provider);
}

async function checkAllTokenBalances(provider: ethers.Provider) {
  console.log('📊 STEP 1: Checking All Token Balances');
  console.log('─'.repeat(60));

  const tokens = [
    { address: USDC_ADDRESS, name: 'USDC' },
    { address: WETH_ADDRESS, name: 'WETH' },
    { address: WHYPE_ADDRESS, name: 'WHYPE' },
  ];

  for (const token of tokens) {
    try {
      const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
      const balance = await contract.balanceOf(WALLET_ADDRESS);
      const decimals = await contract.decimals();
      const symbol = await contract.symbol();
      
      if (balance > 0n) {
        console.log(`   ✅ ${symbol}: ${ethers.formatUnits(balance, decimals)}`);
      }
    } catch (e: any) {
      console.log(`   ⚠️  ${token.name}: Error - ${e.message}`);
    }
  }

  // Check in vault
  try {
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const vaultBalance = await usdc.balanceOf(VAULT_ADDRESS);
    if (vaultBalance > 0n) {
      console.log(`   ✅ USDC in Vault: ${ethers.formatUnits(vaultBalance, 6)}`);
    }
  } catch (e) {}

  // Check in strategies
  for (const strategy of [STRATEGY_1, STRATEGY_2]) {
    try {
      const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
      const balance = await usdc.balanceOf(strategy);
      if (balance > 0n) {
        console.log(`   ✅ USDC in Strategy ${strategy.slice(0, 10)}...: ${ethers.formatUnits(balance, 6)}`);
      }
    } catch (e) {}
  }

  console.log('');
}

async function checkHyperLendPositions(provider: ethers.Provider) {
  console.log('🏦 STEP 2: Checking HyperLend Positions');
  console.log('─'.repeat(60));

  try {
    const lendingPool = new ethers.Contract(HYPERLEND_POOL, HYPERLEND_ABI, provider);

    // Check wallet position
    try {
      const [totalCollateralUSD, totalDebtUSD, availableBorrowsUSD, currentLiquidationThreshold, ltv, healthFactor] =
        await lendingPool.getUserAccountData(WALLET_ADDRESS);
      
      console.log(`   Wallet Position:`);
      console.log(`      Collateral: ${ethers.formatUnits(totalCollateralUSD, 8)} USD`);
      console.log(`      Debt: ${ethers.formatUnits(totalDebtUSD, 8)} USD`);
      console.log(`      Health Factor: ${ethers.formatUnits(healthFactor, 18)}`);
      
      if (totalCollateralUSD > 0n) {
        console.log(`   ✅ FOUND COLLATERAL IN WALLET!`);
      }
    } catch (e: any) {
      console.log(`   ⚠️  Could not check wallet position: ${e.message}`);
    }

    // Check vault position
    try {
      const [totalCollateralUSD, totalDebtUSD, availableBorrowsUSD, currentLiquidationThreshold, ltv, healthFactor] =
        await lendingPool.getUserAccountData(VAULT_ADDRESS);
      
      console.log(`\n   Vault Position:`);
      console.log(`      Collateral: ${ethers.formatUnits(totalCollateralUSD, 8)} USD`);
      console.log(`      Debt: ${ethers.formatUnits(totalDebtUSD, 8)} USD`);
      
      if (totalCollateralUSD > 0n) {
        console.log(`   ✅ FOUND COLLATERAL IN VAULT!`);
      }
    } catch (e: any) {
      console.log(`   ⚠️  Could not check vault position: ${e.message}`);
    }

    // Check strategy positions
    for (const strategy of [STRATEGY_1, STRATEGY_2]) {
      try {
        const [totalCollateralUSD, totalDebtUSD, availableBorrowsUSD, currentLiquidationThreshold, ltv, healthFactor] =
          await lendingPool.getUserAccountData(strategy);
        
        if (totalCollateralUSD > 0n || totalDebtUSD > 0n) {
          console.log(`\n   Strategy ${strategy.slice(0, 10)}... Position:`);
          console.log(`      Collateral: ${ethers.formatUnits(totalCollateralUSD, 8)} USD`);
          console.log(`      Debt: ${ethers.formatUnits(totalDebtUSD, 8)} USD`);
          console.log(`   ✅ FOUND POSITION IN STRATEGY!`);
        }
      } catch (e) {
        // Skip
      }
    }

  } catch (e: any) {
    console.log(`   ❌ Error checking HyperLend: ${e.message}`);
  }

  console.log('');
}

async function checkLPPositions(provider: ethers.Provider) {
  console.log('💧 STEP 3: Checking LP Positions (Multiple Methods)');
  console.log('─'.repeat(60));

  // Method 1: Check NFT balance
  try {
    const positionManager = new ethers.Contract(POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
    const nftBalance = await positionManager.balanceOf(WALLET_ADDRESS);
    console.log(`   NFT Balance (Position Manager): ${nftBalance.toString()}`);

    if (nftBalance > 0n) {
      console.log(`   ✅ FOUND ${nftBalance.toString()} LP NFT(s)!`);
      
      for (let i = 0; i < Number(nftBalance); i++) {
        const tokenId = await positionManager.tokenOfOwnerByIndex(WALLET_ADDRESS, i);
        const position = await positionManager.positions(tokenId);
        const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = position;
        
        console.log(`\n      Position #${i + 1} (Token ID: ${tokenId}):`);
        console.log(`         Token0: ${token0}`);
        console.log(`         Token1: ${token1}`);
        console.log(`         Fee: ${fee}`);
        console.log(`         Liquidity: ${liquidity.toString()}`);
        console.log(`         Tick Range: [${tickLower}, ${tickUpper}]`);
      }
    }
  } catch (e: any) {
    console.log(`   ⚠️  Method 1 failed: ${e.message}`);
  }

  // Method 2: Check vault LP positions
  try {
    const positionManager = new ethers.Contract(POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
    const nftBalance = await positionManager.balanceOf(VAULT_ADDRESS);
    if (nftBalance > 0n) {
      console.log(`\n   ✅ FOUND ${nftBalance.toString()} LP NFT(s) IN VAULT!`);
    }
  } catch (e) {}

  // Method 3: Check strategy LP positions
  for (const strategy of [STRATEGY_1, STRATEGY_2]) {
    try {
      const positionManager = new ethers.Contract(POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
      const nftBalance = await positionManager.balanceOf(strategy);
      if (nftBalance > 0n) {
        console.log(`\n   ✅ FOUND ${nftBalance.toString()} LP NFT(s) IN STRATEGY ${strategy.slice(0, 10)}...!`);
      }
    } catch (e) {}
  }

  console.log('');
}

async function checkStrategyBalances(provider: ethers.Provider) {
  console.log('🎯 STEP 4: Deep Dive Strategy Contract Balances');
  console.log('─'.repeat(60));

  const strategies = [
    { address: STRATEGY_1, name: 'DeltaNeutralFundingStrategy' },
    { address: STRATEGY_2, name: 'HyperEVMFundingStrategy' },
  ];

  for (const strategy of strategies) {
    console.log(`\n   ${strategy.name} (${strategy.address}):`);

    // Check USDC
    try {
      const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
      const balance = await usdc.balanceOf(strategy.address);
      console.log(`      USDC: ${ethers.formatUnits(balance, 6)}`);
      if (balance > 0n) {
        console.log(`      ✅ FOUND USDC!`);
      }
    } catch (e) {}

    // Check WETH
    try {
      const weth = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, provider);
      const balance = await weth.balanceOf(strategy.address);
      if (balance > 0n) {
        console.log(`      WETH: ${ethers.formatEther(balance)}`);
        console.log(`      ✅ FOUND WETH!`);
      }
    } catch (e) {}

    // Try to call strategy methods
    try {
      const strategyContract = new ethers.Contract(strategy.address, [
        'function totalAssets() view returns (uint256)',
        'function totalPrincipal() view returns (uint256)',
        'function getIdleUSDC() view returns (uint256)',
      ], provider);

      try {
        const totalAssets = await strategyContract.totalAssets();
        console.log(`      Total Assets: ${ethers.formatUnits(totalAssets, 6)} USDC`);
      } catch (e) {}

      try {
        const totalPrincipal = await strategyContract.totalPrincipal();
        console.log(`      Total Principal: ${ethers.formatUnits(totalPrincipal, 6)} USDC`);
      } catch (e) {}

      try {
        const idleUSDC = await strategyContract.getIdleUSDC();
        if (idleUSDC > 0n) {
          console.log(`      Idle USDC: ${ethers.formatUnits(idleUSDC, 6)}`);
          console.log(`      ✅ FOUND IDLE USDC!`);
        }
      } catch (e) {}
    } catch (e) {}
  }

  console.log('');
}

async function checkVaultBalances(provider: ethers.Provider) {
  console.log('📦 STEP 5: Deep Dive Vault Balances');
  console.log('─'.repeat(60));

  try {
    const vault = new ethers.Contract(VAULT_ADDRESS, [
      'function totalAssets() view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
      'function totalSupply() view returns (uint256)',
      'function asset() view returns (address)',
    ], provider);

    try {
      const totalAssets = await vault.totalAssets();
      console.log(`   Total Assets: ${ethers.formatUnits(totalAssets, 6)} USDC`);
      if (totalAssets > 0n) {
        console.log(`   ✅ FOUND ASSETS IN VAULT!`);
      }
    } catch (e: any) {
      console.log(`   ⚠️  Could not get totalAssets: ${e.message}`);
    }

    try {
      const walletShares = await vault.balanceOf(WALLET_ADDRESS);
      console.log(`   Your Shares: ${ethers.formatEther(walletShares)}`);
      if (walletShares > 0n) {
        console.log(`   ✅ FOUND VAULT SHARES!`);
      }
    } catch (e) {}

    try {
      const totalSupply = await vault.totalSupply();
      console.log(`   Total Supply: ${ethers.formatEther(totalSupply)}`);
    } catch (e) {}
  } catch (e: any) {
    console.log(`   ❌ Error checking vault: ${e.message}`);
  }

  console.log('');
}

async function searchRecentTransactions(provider: ethers.Provider) {
  console.log('🔍 STEP 6: Searching Recent Transactions');
  console.log('─'.repeat(60));

  try {
    const currentBlock = await provider.getBlockNumber();
    console.log(`   Current Block: ${currentBlock}`);
    
    // Search last 10,000 blocks for transfers
    const fromBlock = Math.max(0, currentBlock - 10000);
    console.log(`   Searching blocks ${fromBlock} to ${currentBlock}...`);

    // Search for USDC transfers TO wallet
    const usdc = new ethers.Contract(USDC_ADDRESS, [TRANSFER_EVENT], provider);
    const filterTo = usdc.filters.Transfer(null, WALLET_ADDRESS);
    const eventsTo = await usdc.queryFilter(filterTo, fromBlock, currentBlock);
    
    if (eventsTo.length > 0) {
      console.log(`   ✅ Found ${eventsTo.length} USDC transfers TO wallet`);
      eventsTo.slice(-5).forEach((e, i) => {
        console.log(`      ${i + 1}. Block ${e.blockNumber}: ${ethers.formatUnits(e.args[2], 6)} USDC`);
      });
    }

    // Search for USDC transfers FROM wallet
    const filterFrom = usdc.filters.Transfer(WALLET_ADDRESS, null);
    const eventsFrom = await usdc.queryFilter(filterFrom, fromBlock, currentBlock);
    
    if (eventsFrom.length > 0) {
      console.log(`   Found ${eventsFrom.length} USDC transfers FROM wallet`);
    }

  } catch (e: any) {
    console.log(`   ⚠️  Error searching transactions: ${e.message}`);
  }

  console.log('');
}

async function checkLPNFTsAdvanced(provider: ethers.Provider) {
  console.log('🎫 STEP 7: Advanced LP NFT Search');
  console.log('─'.repeat(60));

  // Check if Position Manager is an ERC721Enumerable
  try {
    const positionManager = new ethers.Contract(POSITION_MANAGER, [
      'function totalSupply() view returns (uint256)',
      'function tokenByIndex(uint256) view returns (uint256)',
      'function ownerOf(uint256) view returns (address)',
      'function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)',
    ], provider);

    try {
      const totalSupply = await positionManager.totalSupply();
      console.log(`   Total LP NFTs in existence: ${totalSupply.toString()}`);
      
      // Check last 100 NFTs to see if any belong to our addresses
      const addressesToCheck = [WALLET_ADDRESS, VAULT_ADDRESS, STRATEGY_1, STRATEGY_2];
      const checkCount = Math.min(Number(totalSupply), 100);
      
      console.log(`   Checking last ${checkCount} NFTs...`);
      
      for (let i = 0; i < checkCount; i++) {
        try {
          const tokenId = await positionManager.tokenByIndex(totalSupply - BigInt(i) - 1n);
          const owner = await positionManager.ownerOf(tokenId);
          
          if (addressesToCheck.some(addr => addr.toLowerCase() === owner.toLowerCase())) {
            const position = await positionManager.positions(tokenId);
            const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = position;
            
            console.log(`\n   ✅ FOUND LP POSITION!`);
            console.log(`      Token ID: ${tokenId}`);
            console.log(`      Owner: ${owner}`);
            console.log(`      Token0: ${token0}`);
            console.log(`      Token1: ${token1}`);
            console.log(`      Liquidity: ${liquidity.toString()}`);
            console.log(`      Fee: ${fee}`);
            console.log(`      Tick Range: [${tickLower}, ${tickUpper}]`);
          }
        } catch (e) {
          // Skip individual errors
        }
      }
    } catch (e: any) {
      console.log(`   ⚠️  Could not enumerate NFTs: ${e.message}`);
    }
  } catch (e: any) {
    console.log(`   ⚠️  Advanced search failed: ${e.message}`);
  }

  console.log('');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

