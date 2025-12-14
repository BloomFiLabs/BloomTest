/**
 * Close LP Position and Withdraw All Funds
 * Based on the active position shown in the bot output
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

const STRATEGY = '0x2632250Df5F0aF580f3A91fCBBA119bcEd65107B';
const USDC = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';
const WETH = '0xADcb2f358Eae6492F61A5F87eb8893d09391d160';
const POSITION_MANAGER = '0x6eDA206207c09e5428F281761DdC0D300851fBC8';

const STRATEGY_ABI = [
  'function owner() view returns (address)',
  'function keepers(address) view returns (bool)',
  'function getHyperLendData() view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
  'function getIdleUSDC() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalPrincipal() view returns (uint256)',
  'function closeAllPerpPositions() external',
  'function withdrawCollateral(uint256) external',
  'function repay(address, uint256) external',
  'function emergencyWithdrawAll() external',
  'function closeLP() external',
  'function collectLPFees() external',
];

const POSITION_MANAGER_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)',
  'function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256)) external returns (uint256, uint256)',
  'function collect((uint256,address,uint128,uint128)) external returns (uint256, uint256)',
  'function burn(uint256) external',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
];

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      CLOSE LP POSITION & WITHDRAW ALL FUNDS               ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'HyperEVM',
    chainId: 999,
  });
  const wallet = new ethers.Wallet(PRIVATE_KEY_SAFE, provider);
  const ownerAddress = wallet.address;

  console.log(`Owner: ${ownerAddress}`);
  console.log(`Strategy: ${STRATEGY}\n`);

  const strategy = new ethers.Contract(STRATEGY, STRATEGY_ABI, wallet);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);

  // Check permissions
  try {
    const strategyOwner = await strategy.owner();
    const isKeeper = await strategy.keepers(ownerAddress);
    
    console.log(`Strategy Owner: ${strategyOwner}`);
    console.log(`Is Keeper: ${isKeeper}`);
    console.log(`Is Owner: ${strategyOwner.toLowerCase() === ownerAddress.toLowerCase()}\n`);

    if (strategyOwner.toLowerCase() !== ownerAddress.toLowerCase() && !isKeeper) {
      console.log('❌ You are not the owner or keeper! Cannot proceed.');
      return;
    }
  } catch (e: any) {
    console.log(`⚠️  Could not check permissions: ${e.message}`);
    console.log(`   Proceeding anyway...\n`);
  }

  // Check current state
  console.log('📊 Current State:');
  console.log('─'.repeat(60));

  try {
    const [collateral, debt] = await strategy.getHyperLendData();
    console.log(`   HyperLend Collateral: ${ethers.formatUnits(collateral, 6)} USD`);
    console.log(`   HyperLend Debt: ${ethers.formatUnits(debt, 18)} ETH`);
  } catch (e: any) {
    console.log(`   ⚠️  Could not get HyperLend data: ${e.message}`);
  }

  try {
    const idleUSDC = await strategy.getIdleUSDC();
    console.log(`   Idle USDC: ${ethers.formatUnits(idleUSDC, 6)} USDC`);
  } catch (e: any) {
    console.log(`   ⚠️  Could not get idle USDC: ${e.message}`);
  }

  // Check LP positions
  const positionManager = new ethers.Contract(POSITION_MANAGER, POSITION_MANAGER_ABI, wallet);
  const nftBalance = await positionManager.balanceOf(STRATEGY);
  console.log(`   LP NFT Positions: ${nftBalance.toString()}\n`);

  if (nftBalance > 0n) {
    console.log(`✅ Found ${nftBalance.toString()} LP position(s)!`);
    
    for (let i = 0; i < Number(nftBalance); i++) {
      const tokenId = await positionManager.tokenOfOwnerByIndex(STRATEGY, i);
      const position = await positionManager.positions(tokenId);
      const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = position;
      
      console.log(`\n   Position #${i + 1} (Token ID: ${tokenId}):`);
      console.log(`      Token0: ${token0}`);
      console.log(`      Token1: ${token1}`);
      console.log(`      Liquidity: ${liquidity.toString()}`);
      console.log(`      Tokens Owed0: ${tokensOwed0.toString()}`);
      console.log(`      Tokens Owed1: ${tokensOwed1.toString()}`);
    }
  }

  console.log('\n🔧 Executing Withdrawal Steps:');
  console.log('─'.repeat(60));

  // Step 1: Close perp positions
  console.log('\n1️⃣  Closing perp positions...');
  try {
    const tx1 = await strategy.closeAllPerpPositions({ gasLimit: 500000 });
    console.log(`   Transaction: ${tx1.hash}`);
    await tx1.wait();
    console.log(`   ✅ Perp positions closed`);
  } catch (e: any) {
    if (e.message.includes('no position') || e.message.includes('No position')) {
      console.log(`   ℹ️  No perp positions to close`);
    } else {
      console.log(`   ⚠️  Failed: ${e.message}`);
    }
  }

  // Step 2: Collect LP fees and close LP positions
  if (nftBalance > 0n) {
    console.log('\n2️⃣  Collecting LP fees and closing LP positions...');
    
    for (let i = 0; i < Number(nftBalance); i++) {
      try {
        const tokenId = await positionManager.tokenOfOwnerByIndex(STRATEGY, i);
        const position = await positionManager.positions(tokenId);
        const [, , , , , , , liquidity, , , tokensOwed0, tokensOwed1] = position;
        
        // First, collect fees
        if (tokensOwed0 > 0n || tokensOwed1 > 0n) {
          console.log(`   Collecting fees for position ${tokenId}...`);
          try {
            // Need to approve position manager if needed
            // Then collect fees
            const collectParams = {
              tokenId: tokenId,
              recipient: STRATEGY,
              amount0Max: tokensOwed0,
              amount1Max: tokensOwed1,
            };
            
            // Try using strategy's collectLPFees if it exists
            try {
              const txCollect = await strategy.collectLPFees({ gasLimit: 500000 });
              console.log(`   Collecting fees tx: ${txCollect.hash}`);
              await txCollect.wait();
              console.log(`   ✅ Fees collected`);
            } catch (e2: any) {
              console.log(`   ⚠️  collectLPFees failed: ${e2.message}`);
            }
          } catch (e: any) {
            console.log(`   ⚠️  Fee collection failed: ${e.message}`);
          }
        }

        // Close LP position (decrease liquidity to 0)
        if (liquidity > 0n) {
          console.log(`   Closing LP position ${tokenId}...`);
          try {
            // Try strategy's closeLP function
            const txClose = await strategy.closeLP({ gasLimit: 1000000 });
            console.log(`   Closing LP tx: ${txClose.hash}`);
            await txClose.wait();
            console.log(`   ✅ LP position closed`);
          } catch (e2: any) {
            console.log(`   ⚠️  closeLP failed: ${e2.message}`);
            console.log(`   You may need to manually decrease liquidity and burn the NFT`);
          }
        }
      } catch (e: any) {
        console.log(`   ⚠️  Error processing position ${i}: ${e.message}`);
      }
    }
  } else {
    console.log('\n2️⃣  No LP positions to close');
  }

  // Step 3: Repay debt
  console.log('\n3️⃣  Repaying debt...');
  try {
    const [collateral, debt] = await strategy.getHyperLendData();
    if (debt > 0n) {
      // Repay full debt
      const tx3 = await strategy.repay(WETH, ethers.MaxUint256, { gasLimit: 500000 });
      console.log(`   Transaction: ${tx3.hash}`);
      await tx3.wait();
      console.log(`   ✅ Debt repaid`);
    } else {
      console.log(`   ℹ️  No debt to repay`);
    }
  } catch (e: any) {
    console.log(`   ⚠️  Repay failed: ${e.message}`);
  }

  // Step 4: Withdraw all collateral
  console.log('\n4️⃣  Withdrawing all collateral from HyperLend...');
  try {
    const [collateral] = await strategy.getHyperLendData();
    if (collateral > 0n) {
      const tx4 = await strategy.withdrawCollateral(ethers.MaxUint256, { gasLimit: 500000 });
      console.log(`   Transaction: ${tx4.hash}`);
      await tx4.wait();
      console.log(`   ✅ Collateral withdrawn`);
    } else {
      console.log(`   ℹ️  No collateral to withdraw`);
    }
  } catch (e: any) {
    console.log(`   ⚠️  Withdraw collateral failed: ${e.message}`);
    // Try emergency withdraw
    try {
      console.log(`   Trying emergencyWithdrawAll...`);
      const txEmergency = await strategy.emergencyWithdrawAll({ gasLimit: 1000000 });
      console.log(`   Transaction: ${txEmergency.hash}`);
      await txEmergency.wait();
      console.log(`   ✅ Emergency withdraw complete`);
    } catch (e2: any) {
      console.log(`   ❌ Emergency withdraw also failed: ${e2.message}`);
    }
  }

  // Step 5: Check final balances
  console.log('\n5️⃣  Final Balances:');
  console.log('─'.repeat(60));

  const finalUSDC = await usdc.balanceOf(STRATEGY);
  console.log(`   USDC in Strategy: ${ethers.formatUnits(finalUSDC, 6)} USDC`);

  try {
    const [finalCollateral, finalDebt] = await strategy.getHyperLendData();
    console.log(`   HyperLend Collateral: ${ethers.formatUnits(finalCollateral, 6)} USD`);
    console.log(`   HyperLend Debt: ${ethers.formatUnits(finalDebt, 18)} ETH`);
  } catch (e) {}

  const finalNFTBalance = await positionManager.balanceOf(STRATEGY);
  console.log(`   LP NFT Positions: ${finalNFTBalance.toString()}`);

  // Step 6: Withdraw from vault if you have shares
  console.log('\n6️⃣  Withdrawing from vault...');
  try {
    const vault = new ethers.Contract('0x7Eedc4088b197B4EE05BBB00B8c957C411B533Df', [
      'function balanceOf(address) view returns (uint256)',
      'function convertToAssets(uint256) view returns (uint256)',
      'function withdraw(uint256, address, address) returns (uint256)',
    ], wallet);

    const shares = await vault.balanceOf(ownerAddress);
    if (shares > 0n) {
      const assets = await vault.convertToAssets(shares);
      const tx6 = await vault.withdraw(assets, ownerAddress, ownerAddress, { gasLimit: 500000 });
      console.log(`   Transaction: ${tx6.hash}`);
      await tx6.wait();
      console.log(`   ✅ Withdrawn ${ethers.formatUnits(assets, 6)} USDC from vault`);
    } else {
      console.log(`   ℹ️  No vault shares to withdraw`);
    }
  } catch (e: any) {
    console.log(`   ⚠️  Vault withdrawal failed: ${e.message}`);
  }

  // Final wallet balance
  const walletUSDC = await usdc.balanceOf(ownerAddress);
  console.log(`\n💰 Final Wallet USDC Balance: ${ethers.formatUnits(walletUSDC, 6)} USDC`);

  console.log('\n✅ Withdrawal process complete!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

