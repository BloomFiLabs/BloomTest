/**
 * Rescue USDC from Strategy Contract
 * 
 * For HyperEVMFundingStrategy which doesn't have rescueTokens,
 * we'll try to use the vault to withdraw, or check if owner can transfer directly
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.HYPERLIQUID_RPC_URL || 'https://rpc.hyperliquid.xyz/evm';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY not set in .env');
}

const STRATEGY_ADDRESS = '0x247062659f997BDb5975b984c2bE2aDF87661314';
const VAULT_ADDRESS = '0x7eedc4088b197b4ee05bbb00b8c957c411b533df';
const USDC_ADDRESS = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';

const STRATEGY_ABI = [
  'function owner() view returns (address)',
  'function vault() view returns (address)',
  'function totalPrincipal() view returns (uint256)',
  'function withdraw(uint256) external',
];

const VAULT_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
];

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           RESCUE USDC FROM STRATEGY CONTRACT              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const ownerAddress = wallet.address;

  console.log(`Owner: ${ownerAddress}`);
  console.log(`Strategy: ${STRATEGY_ADDRESS}`);
  console.log(`Vault: ${VAULT_ADDRESS}\n`);

  const strategy = new ethers.Contract(STRATEGY_ADDRESS, STRATEGY_ABI, wallet);
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

  // Check ownership
  const strategyOwner = await strategy.owner();
  console.log(`Strategy Owner: ${strategyOwner}`);
  console.log(`Is Owner: ${strategyOwner.toLowerCase() === ownerAddress.toLowerCase()}\n`);

  // Check USDC balance in strategy
  const usdcBalance = await usdc.balanceOf(STRATEGY_ADDRESS);
  console.log(`USDC in Strategy: ${ethers.formatUnits(usdcBalance, 6)} USDC\n`);

  if (usdcBalance === 0n) {
    console.log('✅ No USDC to rescue');
    return;
  }

  // Check if vault has shares
  try {
    const vaultShares = await vault.balanceOf(ownerAddress);
    const vaultTotalAssets = await vault.totalAssets();
    console.log(`Vault Shares: ${ethers.formatEther(vaultShares)}`);
    console.log(`Vault Total Assets: ${ethers.formatUnits(vaultTotalAssets, 6)} USDC`);

    if (vaultShares > 0n) {
      const assetsFromShares = await vault.convertToAssets(vaultShares);
      console.log(`Assets from shares: ${ethers.formatUnits(assetsFromShares, 6)} USDC\n`);

      console.log('💰 Attempting to withdraw from vault (which should pull from strategy)...');
      try {
        const tx = await vault.withdraw(assetsFromShares, ownerAddress, ownerAddress);
        console.log(`Transaction: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`✅ Withdrawal confirmed in block ${receipt?.blockNumber}`);
        
        const finalBalance = await usdc.balanceOf(ownerAddress);
        console.log(`Final USDC balance: ${ethers.formatUnits(finalBalance, 6)} USDC`);
        return;
      } catch (e: any) {
        console.log(`❌ Vault withdrawal failed: ${e.message}\n`);
      }
    }
  } catch (e: any) {
    console.log(`⚠️  Could not check vault: ${e.message}\n`);
  }

  // If we're the owner, we could potentially add a rescue function via upgrade
  // But for now, the funds are stuck unless we can use the vault
  console.log('⚠️  Cannot rescue USDC directly - contract has no rescueTokens function');
  console.log('   Options:');
  console.log('   1. Use vault to withdraw (if you have vault shares)');
  console.log('   2. Deploy a new version with rescueTokens and upgrade');
  console.log('   3. Funds may be recoverable through vault withdraw mechanism');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

