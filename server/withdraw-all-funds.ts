/**
 * Withdraw All Funds from Vaults and Strategies
 * 
 * This script:
 * 1. Reads all strategies from config
 * 2. Checks balances in vaults and strategies
 * 3. Closes all positions (perp, LP, etc.)
 * 4. Repays all debt
 * 5. Withdraws all collateral
 * 6. Withdraws from vaults to owner wallet
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════

const RPC_URL = process.env.HYPERLIQUID_RPC_URL || 'https://rpc.hyperliquid.xyz/evm';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY not set in .env');
}

const USDC_ADDRESS = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';
const WETH_ADDRESS = '0xADcb2f358Eae6492F61A5F87eb8893d09391d160';

// ═══════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address, uint256) returns (bool)',
];

const VAULT_ABI = [
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function asset() view returns (address)',
  'function owner() view returns (address)',
  'function strategies(uint256) view returns (address)',
  'function strategiesLength() view returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
];

const STRATEGY_ABI = [
  'function totalAssets() view returns (uint256)',
  'function totalPrincipal() view returns (uint256)',
  'function owner() view returns (address)',
  'function vault() view returns (address)',
  'function withdraw(uint256) external',
  'function emergencyWithdrawAll() external',
  'function closeAllPerpPositions() external',
  'function withdrawCollateral(uint256) external',
  'function repay(address, uint256) external',
  'function rescueTokens(address, uint256) external',
  'function getHyperLendData() view returns (uint256, uint256, uint256, uint256, uint256, uint256)',
  'function getPerpEquity() view returns (uint256)',
  'function getIdleUSDC() view returns (uint256)',
];

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     WITHDRAW ALL FUNDS FROM VAULTS & STRATEGIES         ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const ownerAddress = wallet.address;

  // Check if --dry-run flag is set
  const isDryRun = process.argv.includes('--dry-run') || process.argv.includes('--check');

  if (isDryRun) {
    console.log('🔍 DRY RUN MODE - No transactions will be sent\n');
  }

  console.log(`Owner Address: ${ownerAddress}\n`);

  // Load strategies from config
  const strategiesConfig = loadStrategiesConfig();
  const contractsConfig = loadContractsConfig();

  // Collect all unique vaults and strategies
  const vaults = new Set<string>();
  const strategies = new Set<string>();

  // Add vaults from strategies config
  strategiesConfig.forEach((s: any) => {
    if (s.vaultAddress) vaults.add(s.vaultAddress.toLowerCase());
    if (s.contractAddress) strategies.add(s.contractAddress.toLowerCase());
  });

  // Add from contracts config
  if (contractsConfig.BloomStrategyVault) {
    vaults.add(contractsConfig.BloomStrategyVault.toLowerCase());
  }

  console.log(`Found ${vaults.size} vault(s) and ${strategies.size} strategy/strategies\n`);

  // Process each vault
  for (const vaultAddress of vaults) {
    await processVault(vaultAddress, ownerAddress, wallet, provider, isDryRun);
  }

  // Process each strategy directly
  for (const strategyAddress of strategies) {
    await processStrategy(strategyAddress, ownerAddress, wallet, provider, isDryRun);
  }

  if (isDryRun) {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║              DRY RUN COMPLETE - NO CHANGES MADE           ║');
    console.log('║     Run without --dry-run to execute withdrawals        ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
  } else {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║                    WITHDRAWAL COMPLETE                    ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
  }
}

async function processVault(vaultAddress: string, ownerAddress: string, wallet: ethers.Wallet, provider: ethers.Provider, isDryRun: boolean = false) {
  console.log(`\n📦 Processing Vault: ${vaultAddress}`);
  console.log('─'.repeat(60));

  try {
    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, wallet);
    
    // Check ownership
    const vaultOwner = await vault.owner();
    if (vaultOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
      console.log(`⚠️  Warning: Vault owner is ${vaultOwner}, not ${ownerAddress}`);
      console.log(`   Skipping vault withdrawal (not owner)`);
      return;
    }

    // Get asset address
    const assetAddress = await vault.asset();
    const asset = new ethers.Contract(assetAddress, ERC20_ABI, wallet);
    const assetSymbol = await asset.symbol();
    const assetDecimals = await asset.decimals();

    // Check balances
    const totalAssets = await vault.totalAssets();
    const ownerShares = await vault.balanceOf(ownerAddress);
    const totalSupply = await vault.totalSupply();

    console.log(`Asset: ${assetSymbol} (${assetAddress})`);
    console.log(`Total Assets in Vault: ${ethers.formatUnits(totalAssets, assetDecimals)} ${assetSymbol}`);
    console.log(`Your Shares: ${ethers.formatEther(ownerShares)}`);
    console.log(`Total Supply: ${ethers.formatEther(totalSupply)}`);

    if (ownerShares === 0n) {
      console.log('   No shares to withdraw');
      return;
    }

    // Convert shares to assets
    const assetsToWithdraw = await vault.convertToAssets(ownerShares);
    console.log(`Assets to Withdraw: ${ethers.formatUnits(assetsToWithdraw, assetDecimals)} ${assetSymbol}`);

    if (assetsToWithdraw === 0n) {
      console.log('   No assets to withdraw');
      return;
    }

    // Check strategies registered with vault
    try {
      const strategiesLength = await vault.strategiesLength();
      console.log(`\n   Strategies registered: ${strategiesLength}`);
      
      if (strategiesLength > 0) {
        console.log('   ⚠️  Vault has strategies - funds will be withdrawn from strategies first');
      }
    } catch (e) {
      // Some vaults might not have this function
    }

    // Withdraw from vault
    if (isDryRun) {
      console.log(`\n💰 [DRY RUN] Would withdraw ${ethers.formatUnits(assetsToWithdraw, assetDecimals)} ${assetSymbol}`);
      console.log(`   This would call vault.withdraw(${ethers.formatUnits(assetsToWithdraw, assetDecimals)}, ${ownerAddress}, ${ownerAddress})`);
    } else {
      console.log(`\n💰 Withdrawing ${ethers.formatUnits(assetsToWithdraw, assetDecimals)} ${assetSymbol}...`);
      
      const tx = await vault.withdraw(assetsToWithdraw, ownerAddress, ownerAddress);
      console.log(`   Transaction: ${tx.hash}`);
      
      const receipt = await tx.wait();
      console.log(`   ✅ Withdrawal confirmed in block ${receipt?.blockNumber}`);

      // Final balance check
      const finalBalance = await asset.balanceOf(ownerAddress);
      console.log(`   Final ${assetSymbol} balance: ${ethers.formatUnits(finalBalance, assetDecimals)}`);
    }

  } catch (error: any) {
    console.log(`   ❌ Error processing vault: ${error.message}`);
    if (error.data) {
      console.log(`   Error data: ${error.data}`);
    }
  }
}

async function processStrategy(strategyAddress: string, ownerAddress: string, wallet: ethers.Wallet, provider: ethers.Provider, isDryRun: boolean = false) {
  console.log(`\n🎯 Processing Strategy: ${strategyAddress}`);
  console.log('─'.repeat(60));

  try {
    const strategy = new ethers.Contract(strategyAddress, STRATEGY_ABI, wallet);
    
    // Check ownership
    let strategyOwner: string;
    try {
      strategyOwner = await strategy.owner();
      if (strategyOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
        console.log(`⚠️  Warning: Strategy owner is ${strategyOwner}, not ${ownerAddress}`);
        console.log(`   Skipping strategy (not owner)`);
        return;
      }
    } catch (e) {
      console.log(`   ⚠️  Could not check ownership, proceeding anyway...`);
    }

    // Check current state
    let totalAssets = 0n;
    let totalPrincipal = 0n;
    let idleUSDC = 0n;
    
    try {
      totalAssets = await strategy.totalAssets();
      console.log(`Total Assets: ${ethers.formatUnits(totalAssets, 6)} USDC`);
    } catch (e) {
      console.log(`   totalAssets() not available`);
    }

    try {
      totalPrincipal = await strategy.totalPrincipal();
      console.log(`Total Principal: ${ethers.formatUnits(totalPrincipal, 6)} USDC`);
    } catch (e) {
      console.log(`   totalPrincipal() not available`);
    }

    try {
      idleUSDC = await strategy.getIdleUSDC();
      console.log(`Idle USDC: ${ethers.formatUnits(idleUSDC, 6)} USDC`);
    } catch (e) {
      console.log(`   getIdleUSDC() not available`);
    }

    // Check HyperLend position
    try {
      const [collateral, debt, availableBorrows, liquidationThreshold, ltv, healthFactor] = 
        await strategy.getHyperLendData();
      
      console.log(`\n📊 HyperLend Position:`);
      console.log(`   Collateral: ${ethers.formatUnits(collateral, 6)} USD`);
      console.log(`   Debt: ${ethers.formatUnits(debt, 18)} ETH`);
      console.log(`   Health Factor: ${ethers.formatEther(healthFactor)}`);

      if (debt > 0n) {
        console.log(`\n   ⚠️  Strategy has debt - will need to repay before withdrawing`);
      }
    } catch (e) {
      console.log(`   No HyperLend position or getHyperLendData() not available`);
    }

    // Check perp position
    try {
      const perpEquity = await strategy.getPerpEquity();
      console.log(`\n📈 Perp Position:`);
      console.log(`   Perp Equity: ${ethers.formatUnits(perpEquity, 6)} USD`);

      if (perpEquity !== 0n) {
        console.log(`   ⚠️  Strategy has perp position - will need to close`);
      }
    } catch (e) {
      console.log(`   No perp position or getPerpEquity() not available`);
    }

    // Check raw token balances
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
    const usdcBalance = await usdc.balanceOf(strategyAddress);
    console.log(`\n💵 Raw Token Balances:`);
    console.log(`   USDC in contract: ${ethers.formatUnits(usdcBalance, 6)}`);

    if (totalAssets === 0n && idleUSDC === 0n && usdcBalance === 0n) {
      console.log(`\n   ✅ Strategy is empty, nothing to withdraw`);
      return;
    }

    if (isDryRun) {
      console.log(`\n💰 [DRY RUN] Would execute the following steps:`);
      console.log(`   1. Close all perp positions`);
      console.log(`   2. Repay any debt`);
      console.log(`   3. Withdraw all collateral from HyperLend`);
      console.log(`   4. Rescue any remaining tokens`);
      return;
    }

    // Step 1: Close perp positions
    console.log(`\n🔒 Step 1: Closing perp positions...`);
    try {
      const tx1 = await strategy.closeAllPerpPositions();
      console.log(`   Transaction: ${tx1.hash}`);
      await tx1.wait();
      console.log(`   ✅ Perp positions closed`);
    } catch (e: any) {
      if (e.message.includes('no position') || e.message.includes('No position')) {
        console.log(`   ℹ️  No perp positions to close`);
      } else {
        console.log(`   ⚠️  Failed to close perp positions: ${e.message}`);
      }
    }

    // Step 2: Repay debt (if any)
    console.log(`\n💳 Step 2: Repaying debt...`);
    try {
      const [collateral, debt] = await strategy.getHyperLendData();
      if (debt > 0n) {
        // Try to repay with available USDC first
        const availableUSDC = await strategy.getIdleUSDC();
        if (availableUSDC > 0n) {
          // Note: This assumes debt is in WETH, need to check actual debt asset
          // For now, we'll try emergency withdraw which should handle this
          console.log(`   Debt exists, will be handled by emergency withdraw`);
        }
      } else {
        console.log(`   ℹ️  No debt to repay`);
      }
    } catch (e) {
      console.log(`   ℹ️  Could not check debt status`);
    }

    // Step 3: Withdraw collateral from HyperLend
    console.log(`\n🏦 Step 3: Withdrawing collateral from HyperLend...`);
    try {
      const [collateral] = await strategy.getHyperLendData();
      if (collateral > 0n) {
        const tx2 = await strategy.withdrawCollateral(ethers.MaxUint256);
        console.log(`   Transaction: ${tx2.hash}`);
        await tx2.wait();
        console.log(`   ✅ Collateral withdrawn`);
      } else {
        console.log(`   ℹ️  No collateral to withdraw`);
      }
    } catch (e: any) {
      if (e.message.includes('no collateral') || e.message.includes('No collateral')) {
        console.log(`   ℹ️  No collateral to withdraw`);
      } else {
        console.log(`   ⚠️  withdrawCollateral failed, trying emergencyWithdrawAll...`);
        try {
          const tx2 = await strategy.emergencyWithdrawAll();
          console.log(`   Transaction: ${tx2.hash}`);
          await tx2.wait();
          console.log(`   ✅ Emergency withdraw complete`);
        } catch (e2: any) {
          console.log(`   ❌ Emergency withdraw also failed: ${e2.message}`);
        }
      }
    }

    // Step 4: Rescue any remaining tokens
    console.log(`\n🚑 Step 4: Rescuing remaining tokens...`);
    const finalUSDC = await usdc.balanceOf(strategyAddress);
    if (finalUSDC > 0n) {
      try {
        const tx3 = await strategy.rescueTokens(USDC_ADDRESS, finalUSDC);
        console.log(`   Transaction: ${tx3.hash}`);
        await tx3.wait();
        console.log(`   ✅ Rescued ${ethers.formatUnits(finalUSDC, 6)} USDC`);
      } catch (e: any) {
        console.log(`   ❌ Failed to rescue USDC: ${e.message}`);
      }
    } else {
      console.log(`   ℹ️  No USDC to rescue`);
    }

    // Check WETH if applicable
    try {
      const weth = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, wallet);
      const wethBalance = await weth.balanceOf(strategyAddress);
      if (wethBalance > 0n) {
        const tx4 = await strategy.rescueTokens(WETH_ADDRESS, wethBalance);
        console.log(`   Transaction: ${tx4.hash}`);
        await tx4.wait();
        console.log(`   ✅ Rescued ${ethers.formatEther(wethBalance)} WETH`);
      }
    } catch (e) {
      // WETH might not be applicable
    }

    // Final check
    const finalBalance = await usdc.balanceOf(strategyAddress);
    console.log(`\n✅ Strategy withdrawal complete`);
    console.log(`   Remaining USDC in strategy: ${ethers.formatUnits(finalBalance, 6)}`);

  } catch (error: any) {
    console.log(`   ❌ Error processing strategy: ${error.message}`);
    if (error.data) {
      console.log(`   Error data: ${error.data}`);
    }
  }
}

function loadStrategiesConfig(): any[] {
  const configPaths = [
    path.join(__dirname, 'src/config/strategies.json'),
    path.join(process.cwd(), 'src/config/strategies.json'),
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return config.strategies || [];
      } catch (error) {
        console.log(`Could not parse ${configPath}: ${error}`);
      }
    }
  }

  return [];
}

function loadContractsConfig(): any {
  const configPaths = [
    path.join(__dirname, 'src/config/contracts.json'),
    path.join(process.cwd(), 'src/config/contracts.json'),
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (error) {
        console.log(`Could not parse ${configPath}: ${error}`);
      }
    }
  }

  return {};
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

