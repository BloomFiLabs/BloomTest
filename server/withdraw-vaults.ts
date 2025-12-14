/**
 * Withdraw from Vaults
 * Focus on the vaults, skip the stuck strategy
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

const RPC_URL = process.env.HYPERLIQUID_RPC_URL || 'https://rpc.hyperliquid.xyz/evm';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY not set in .env');
}

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

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║              WITHDRAW FROM VAULTS                         ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'HyperEVM',
    chainId: 999,
  });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const ownerAddress = wallet.address;

  console.log(`Owner: ${ownerAddress}\n`);

  // Load vault addresses
  const strategiesConfig = loadStrategiesConfig();
  const contractsConfig = loadContractsConfig();

  const vaults = new Set<string>();
  
  // Add vaults from strategies config
  strategiesConfig.forEach((s: any) => {
    if (s.vaultAddress) vaults.add(s.vaultAddress.toLowerCase());
  });

  // Add from contracts config
  if (contractsConfig.BloomStrategyVault) {
    vaults.add(contractsConfig.BloomStrategyVault.toLowerCase());
  }

  console.log(`Found ${vaults.size} vault(s) to check\n`);

  for (const vaultAddress of vaults) {
    await processVault(vaultAddress, ownerAddress, wallet, provider);
  }
}

async function processVault(vaultAddress: string, ownerAddress: string, wallet: ethers.Wallet, provider: ethers.Provider) {
  console.log(`\n📦 Processing Vault: ${vaultAddress}`);
  console.log('─'.repeat(60));

  try {
    // Try to get code to see if contract exists
    const code = await provider.getCode(vaultAddress);
    if (code === '0x') {
      console.log('   ⚠️  No contract code at this address - may not be deployed');
      return;
    }

    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, wallet);
    
    // Check ownership with timeout
    let vaultOwner: string;
    try {
      vaultOwner = await Promise.race([
        vault.owner(),
        new Promise<string>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 10000)
        )
      ]) as string;
      
      console.log(`Vault Owner: ${vaultOwner}`);
      
      if (vaultOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
        console.log(`⚠️  Warning: Vault owner is ${vaultOwner}, not ${ownerAddress}`);
        console.log(`   Skipping vault withdrawal (not owner)`);
        return;
      }
    } catch (e: any) {
      console.log(`⚠️  Could not check ownership: ${e.message}`);
      console.log(`   Proceeding anyway...`);
    }

    // Get asset address
    let assetAddress: string;
    try {
      assetAddress = await Promise.race([
        vault.asset(),
        new Promise<string>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 10000)
        )
      ]) as string;
    } catch (e: any) {
      console.log(`❌ Could not get asset address: ${e.message}`);
      return;
    }

    const asset = new ethers.Contract(assetAddress, ERC20_ABI, wallet);
    let assetSymbol: string;
    let assetDecimals: number;
    
    try {
      assetSymbol = await asset.symbol();
      assetDecimals = await asset.decimals();
    } catch (e) {
      assetSymbol = 'TOKEN';
      assetDecimals = 18;
    }

    console.log(`Asset: ${assetSymbol} (${assetAddress})`);

    // Check balances
    let totalAssets = 0n;
    let ownerShares = 0n;
    let totalSupply = 0n;

    try {
      totalAssets = await Promise.race([
        vault.totalAssets(),
        new Promise<bigint>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 10000)
        )
      ]) as bigint;
      console.log(`Total Assets in Vault: ${ethers.formatUnits(totalAssets, assetDecimals)} ${assetSymbol}`);
    } catch (e: any) {
      console.log(`⚠️  Could not get totalAssets: ${e.message}`);
    }

    try {
      ownerShares = await Promise.race([
        vault.balanceOf(ownerAddress),
        new Promise<bigint>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 10000)
        )
      ]) as bigint;
      console.log(`Your Shares: ${ethers.formatEther(ownerShares)}`);
    } catch (e: any) {
      console.log(`⚠️  Could not get shares: ${e.message}`);
    }

    try {
      totalSupply = await Promise.race([
        vault.totalSupply(),
        new Promise<bigint>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 10000)
        )
      ]) as bigint;
      console.log(`Total Supply: ${ethers.formatEther(totalSupply)}`);
    } catch (e: any) {
      console.log(`⚠️  Could not get totalSupply: ${e.message}`);
    }

    if (ownerShares === 0n) {
      console.log('   ✅ No shares to withdraw');
      return;
    }

    // Convert shares to assets
    let assetsToWithdraw = 0n;
    try {
      assetsToWithdraw = await Promise.race([
        vault.convertToAssets(ownerShares),
        new Promise<bigint>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 10000)
        )
      ]) as bigint;
      console.log(`Assets to Withdraw: ${ethers.formatUnits(assetsToWithdraw, assetDecimals)} ${assetSymbol}`);
    } catch (e: any) {
      console.log(`⚠️  Could not convert shares to assets: ${e.message}`);
      // Fallback: use totalAssets proportionally
      if (totalSupply > 0n && totalAssets > 0n) {
        assetsToWithdraw = (ownerShares * totalAssets) / totalSupply;
        console.log(`   Using proportional calculation: ${ethers.formatUnits(assetsToWithdraw, assetDecimals)} ${assetSymbol}`);
      } else {
        console.log('   ❌ Cannot calculate assets to withdraw');
        return;
      }
    }

    if (assetsToWithdraw === 0n) {
      console.log('   ✅ No assets to withdraw');
      return;
    }

    // Check strategies registered with vault
    try {
      const strategiesLength = await Promise.race([
        vault.strategiesLength(),
        new Promise<bigint>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 5000)
        )
      ]) as bigint;
      console.log(`\n   Strategies registered: ${strategiesLength}`);
      
      if (strategiesLength > 0) {
        console.log('   ⚠️  Vault has strategies - funds will be withdrawn from strategies first');
      }
    } catch (e) {
      // Some vaults might not have this function
    }

    // Withdraw from vault
    console.log(`\n💰 Withdrawing ${ethers.formatUnits(assetsToWithdraw, assetDecimals)} ${assetSymbol}...`);
    
    try {
      const tx = await vault.withdraw(assetsToWithdraw, ownerAddress, ownerAddress, {
        gasLimit: 500000,
      });
      console.log(`   Transaction: ${tx.hash}`);
      console.log(`   Waiting for confirmation...`);
      
      const receipt = await tx.wait();
      console.log(`   ✅ Withdrawal confirmed in block ${receipt?.blockNumber}`);

      // Final balance check
      const finalBalance = await asset.balanceOf(ownerAddress);
      console.log(`   Final ${assetSymbol} balance: ${ethers.formatUnits(finalBalance, assetDecimals)}`);
    } catch (e: any) {
      console.log(`   ❌ Withdrawal failed: ${e.message}`);
      if (e.data) {
        console.log(`   Error data: ${e.data}`);
      }
    }

  } catch (error: any) {
    console.log(`   ❌ Error processing vault: ${error.message}`);
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

