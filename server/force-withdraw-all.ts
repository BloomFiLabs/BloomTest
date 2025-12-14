/**
 * Force Withdraw All - Use emergency functions to get everything out
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
const USDC = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';
const WETH = '0xADcb2f358Eae6492F61A5F87eb8893d09391d160';

const STRATEGY_ABI = [
  'function owner() view returns (address)',
  'function keepers(address) view returns (bool)',
  'function emergencyWithdrawAll() external',
  'function closeAllPerpPositions() external',
  'function withdrawCollateral(uint256) external',
  'function repay(address, uint256) external',
  'function getHyperLendData() view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
];

const VAULT_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
  'function withdraw(uint256, address, address) returns (uint256)',
  'function totalAssets() view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         FORCE WITHDRAW ALL - EMERGENCY MODE              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'HyperEVM',
    chainId: 999,
  });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const ownerAddress = wallet.address;

  console.log(`Owner: ${ownerAddress}`);
  console.log(`Strategy: ${STRATEGY}\n`);

  const strategy = new ethers.Contract(STRATEGY, STRATEGY_ABI, wallet);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);

  // Check permissions
  const strategyOwner = await strategy.owner();
  const isKeeper = await strategy.keepers(ownerAddress);
  
  console.log(`Strategy Owner: ${strategyOwner}`);
  console.log(`Is Keeper: ${isKeeper}`);
  console.log(`Is Owner: ${strategyOwner.toLowerCase() === ownerAddress.toLowerCase()}\n`);

  if (strategyOwner.toLowerCase() !== ownerAddress.toLowerCase() && !isKeeper) {
    console.log('❌ You are not the owner or keeper! Cannot proceed.');
    return;
  }

  // Try emergency withdraw all first (this should handle everything)
  console.log('🚨 STEP 1: Emergency Withdraw All');
  console.log('─'.repeat(60));
  console.log('   This function should close all positions and withdraw everything...\n');
  
  try {
    const tx = await strategy.emergencyWithdrawAll({ gasLimit: 2000000 });
    console.log(`   Transaction: ${tx.hash}`);
    console.log(`   Waiting for confirmation...`);
    const receipt = await tx.wait();
    console.log(`   ✅ Emergency withdraw confirmed in block ${receipt?.blockNumber}`);
  } catch (e: any) {
    console.log(`   ⚠️  Emergency withdraw failed: ${e.message}`);
    console.log(`   Trying individual steps...\n`);
    
    // Fallback: Try individual steps
    console.log('🔧 STEP 2: Individual Withdrawal Steps');
    console.log('─'.repeat(60));
    
    // 2a. Close perp positions
    try {
      console.log('\n   2a. Closing perp positions...');
      const tx1 = await strategy.closeAllPerpPositions({ gasLimit: 1000000 });
      await tx1.wait();
      console.log(`   ✅ Perp positions closed`);
    } catch (e2: any) {
      console.log(`   ⚠️  ${e2.message}`);
    }

    // 2b. Repay debt
    try {
      console.log('\n   2b. Repaying debt...');
      const [collateral, debt] = await strategy.getHyperLendData();
      if (debt > 0n) {
        const tx2 = await strategy.repay(WETH, ethers.MaxUint256, { gasLimit: 500000 });
        await tx2.wait();
        console.log(`   ✅ Debt repaid`);
      } else {
        console.log(`   ℹ️  No debt`);
      }
    } catch (e2: any) {
      console.log(`   ⚠️  ${e2.message}`);
    }

    // 2c. Withdraw collateral
    try {
      console.log('\n   2c. Withdrawing collateral...');
      const [collateral] = await strategy.getHyperLendData();
      if (collateral > 0n) {
        const tx3 = await strategy.withdrawCollateral(ethers.MaxUint256, { gasLimit: 500000 });
        await tx3.wait();
        console.log(`   ✅ Collateral withdrawn`);
      } else {
        console.log(`   ℹ️  No collateral`);
      }
    } catch (e2: any) {
      console.log(`   ⚠️  ${e2.message}`);
    }
  }

  // Wait a bit for everything to settle
  console.log('\n⏳ Waiting 5 seconds for positions to settle...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Check final state
  console.log('\n📊 Final State Check:');
  console.log('─'.repeat(60));

  try {
    const [collateral, debt] = await strategy.getHyperLendData();
    console.log(`   HyperLend Collateral: ${ethers.formatUnits(collateral, 6)} USD`);
    console.log(`   HyperLend Debt: ${ethers.formatUnits(debt, 18)} ETH`);
  } catch (e) {}

  const usdcInStrategy = await usdc.balanceOf(STRATEGY);
  console.log(`   USDC in Strategy: ${ethers.formatUnits(usdcInStrategy, 6)} USDC`);

  // Withdraw from vault if you have shares
  console.log('\n💰 STEP 3: Withdraw from Vault');
  console.log('─'.repeat(60));

  try {
    const vault = new ethers.Contract(VAULT, VAULT_ABI, wallet);
    const shares = await vault.balanceOf(ownerAddress);
    
    if (shares > 0n) {
      console.log(`   You have ${ethers.formatEther(shares)} vault shares`);
      
      try {
        const assets = await vault.convertToAssets(shares);
        console.log(`   Assets value: ${ethers.formatUnits(assets, 6)} USDC`);
        
        if (assets > 0n) {
          console.log(`   Withdrawing...`);
          const tx = await vault.withdraw(assets, ownerAddress, ownerAddress, { gasLimit: 1000000 });
          console.log(`   Transaction: ${tx.hash}`);
          await tx.wait();
          console.log(`   ✅ Withdrawn from vault`);
        }
      } catch (e: any) {
        console.log(`   ⚠️  Could not convert shares or withdraw: ${e.message}`);
      }
    } else {
      console.log(`   No vault shares`);
    }
  } catch (e: any) {
    console.log(`   ⚠️  Vault check failed: ${e.message}`);
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

