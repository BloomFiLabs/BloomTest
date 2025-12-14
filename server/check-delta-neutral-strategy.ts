/**
 * Check and withdraw from DeltaNeutralFundingStrategy
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

const STRATEGY_ADDRESS = '0x2632250Df5F0aF580f3A91fCBBA119bcEd65107B';
const VAULT_ADDRESS = '0x7Eedc4088b197B4EE05BBB00B8c957C411B533Df';
const USDC_ADDRESS = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';

const STRATEGY_ABI = [
  'function owner() view returns (address)',
  'function vault() view returns (address)',
  'function totalAssets() view returns (uint256)',
  'function totalPrincipal() view returns (uint256)',
  'function getIdleUSDC() view returns (uint256)',
  'function getHyperLendData() view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
  'function getPerpEquity() view returns (uint256)',
  'function emergencyWithdrawAll() external',
  'function closeAllPerpPositions() external',
  'function withdrawCollateral(uint256) external',
];

const VAULT_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     CHECK DELTA NEUTRAL FUNDING STRATEGY                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'HyperEVM',
    chainId: 999,
  });
  const wallet = new ethers.Wallet(PRIVATE_KEY_SAFE, provider);
  const ownerAddress = wallet.address;

  console.log(`Owner: ${ownerAddress}`);
  console.log(`Strategy: ${STRATEGY_ADDRESS}`);
  console.log(`Vault: ${VAULT_ADDRESS}\n`);

  const strategy = new ethers.Contract(STRATEGY_ADDRESS, STRATEGY_ABI, wallet);
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

  // Check ownership
  try {
    const strategyOwner = await strategy.owner();
    console.log(`Strategy Owner: ${strategyOwner}`);
    console.log(`Is Owner: ${strategyOwner.toLowerCase() === ownerAddress.toLowerCase()}\n`);
  } catch (e: any) {
    console.log(`⚠️  Could not check ownership: ${e.message}\n`);
  }

  // Check strategy state
  let totalAssets = 0n;
  let totalPrincipal = 0n;
  let idleUSDC = 0n;

  try {
    totalAssets = await strategy.totalAssets();
    console.log(`Total Assets: ${ethers.formatUnits(totalAssets, 6)} USDC`);
  } catch (e: any) {
    console.log(`⚠️  totalAssets() failed: ${e.message}`);
  }

  try {
    totalPrincipal = await strategy.totalPrincipal();
    console.log(`Total Principal: ${ethers.formatUnits(totalPrincipal, 6)} USDC`);
  } catch (e: any) {
    console.log(`⚠️  totalPrincipal() failed: ${e.message}`);
  }

  try {
    idleUSDC = await strategy.getIdleUSDC();
    console.log(`Idle USDC: ${ethers.formatUnits(idleUSDC, 6)} USDC`);
  } catch (e: any) {
    console.log(`⚠️  getIdleUSDC() failed: ${e.message}`);
  }

  // Check HyperLend
  try {
    const [collateral, debt, availableBorrows, liquidationThreshold, ltv, healthFactor] = 
      await strategy.getHyperLendData();
    
    console.log(`\n📊 HyperLend Position:`);
    console.log(`   Collateral: ${ethers.formatUnits(collateral, 6)} USD`);
    console.log(`   Debt: ${ethers.formatUnits(debt, 18)} ETH`);
    console.log(`   Health Factor: ${ethers.formatEther(healthFactor)}`);

    if (collateral > 0n || debt > 0n) {
      console.log(`\n   ⚠️  Has HyperLend position - will need to withdraw/repay`);
    }
  } catch (e: any) {
    console.log(`\n⚠️  Could not get HyperLend data: ${e.message}`);
  }

  // Check perp
  try {
    const perpEquity = await strategy.getPerpEquity();
    console.log(`\n📈 Perp Position:`);
    console.log(`   Perp Equity: ${ethers.formatUnits(perpEquity, 6)} USD`);

    if (perpEquity !== 0n) {
      console.log(`   ⚠️  Has perp position - will need to close`);
    }
  } catch (e: any) {
    console.log(`\n⚠️  Could not get perp equity: ${e.message}`);
  }

  // Check raw balances
  const usdcInStrategy = await usdc.balanceOf(STRATEGY_ADDRESS);
  console.log(`\n💵 Raw Token Balances:`);
  console.log(`   USDC in strategy contract: ${ethers.formatUnits(usdcInStrategy, 6)} USDC`);

  // Check vault shares
  try {
    const vaultShares = await vault.balanceOf(ownerAddress);
    const vaultTotalAssets = await vault.totalAssets();
    console.log(`\n📦 Vault State:`);
    console.log(`   Your vault shares: ${ethers.formatEther(vaultShares)}`);
    console.log(`   Vault total assets: ${ethers.formatUnits(vaultTotalAssets, 6)} USDC`);

    if (vaultShares > 0n) {
      const assetsFromShares = await vault.convertToAssets(vaultShares);
      console.log(`   Assets from your shares: ${ethers.formatUnits(assetsFromShares, 6)} USDC`);
      
      if (assetsFromShares > 0n) {
        console.log(`\n💰 Attempting to withdraw from vault...`);
        const tx = await vault.withdraw(assetsFromShares, ownerAddress, ownerAddress, {
          gasLimit: 1000000,
        });
        console.log(`   Transaction: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`   ✅ Withdrawal confirmed in block ${receipt?.blockNumber}`);
        
        const finalBalance = await usdc.balanceOf(ownerAddress);
        console.log(`   Final USDC balance: ${ethers.formatUnits(finalBalance, 6)} USDC`);
      }
    } else {
      console.log(`\n   No vault shares to withdraw`);
    }
  } catch (e: any) {
    console.log(`\n⚠️  Could not check/withdraw from vault: ${e.message}`);
  }

  // If there are assets but no vault shares, try emergency withdraw
  if ((totalAssets > 0n || idleUSDC > 0n || usdcInStrategy > 0n) && totalPrincipal > 0n) {
    console.log(`\n⚠️  Strategy has assets but you may not have vault shares`);
    console.log(`   Strategy principal: ${ethers.formatUnits(totalPrincipal, 6)} USDC`);
    console.log(`   You may need to deposit to vault first, or use emergency functions`);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

