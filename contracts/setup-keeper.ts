import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables
dotenv.config();

const STRATEGY_ABI = [
  'function setKeeper(address keeper, bool active) external',
  'function keepers(address) view returns (bool)',
  'function owner() view returns (address)',
];

async function main() {
  console.log('🔧 Setting up Keeper for Delta Neutral Strategy\n');

  // Load deployed addresses
  const addressesPath = path.join(__dirname, 'deployed_addresses.json');
  if (!fs.existsSync(addressesPath)) {
    throw new Error('deployed_addresses.json not found! Deploy contracts first.');
  }

  const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf-8'));
  const strategyAddress = addresses.DeltaNeutralStrategy;

  console.log(`Strategy Address: ${strategyAddress}`);

  // Get deployer private key
  const deployerPrivateKey = process.env.PRIVATE_KEY;
  if (!deployerPrivateKey) {
    throw new Error('PRIVATE_KEY not set in .env');
  }

  // Get keeper address from server .env
  const serverEnvPath = path.join(__dirname, '../server/.env');
  let keeperPrivateKey: string | undefined;
  
  console.log(`Looking for server .env at: ${serverEnvPath}`);
  
  if (fs.existsSync(serverEnvPath)) {
    const serverEnv = fs.readFileSync(serverEnvPath, 'utf-8');
    const match = serverEnv.match(/KEEPER_PRIVATE_KEY=(0x[a-fA-F0-9]+)/);
    if (match) {
      keeperPrivateKey = match[1].trim();
    }
  } else {
    console.log(`Server .env file not found at ${serverEnvPath}`);
  }

  if (!keeperPrivateKey) {
    console.log('\n⚠️  KEEPER_PRIVATE_KEY not found in server/.env');
    console.log('Please add it and run this script again.\n');
    process.exit(1);
  }

  // Derive keeper address
  const keeperWallet = new ethers.Wallet(keeperPrivateKey);
  const keeperAddress = keeperWallet.address;

  console.log(`Keeper Address: ${keeperAddress}\n`);

  // Connect to Base
  const rpcUrl = process.env.RPC_URL || 'https://mainnet.base.org';
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const deployerWallet = new ethers.Wallet(deployerPrivateKey, provider);

  console.log(`Deployer Address: ${deployerWallet.address}`);
  console.log(`RPC URL: ${rpcUrl}\n`);

  // Connect to strategy contract
  const strategy = new ethers.Contract(strategyAddress, STRATEGY_ABI, deployerWallet);

  // Check if deployer is owner
  console.log('Checking ownership...');
  const owner = await strategy.owner();
  console.log(`Contract Owner: ${owner}`);
  
  if (owner.toLowerCase() !== deployerWallet.address.toLowerCase()) {
    throw new Error('Deployer wallet is not the contract owner!');
  }

  // Check if keeper is already authorized
  console.log('\nChecking if keeper is already authorized...');
  const isAuthorized = await strategy.keepers(keeperAddress);
  
  if (isAuthorized) {
    console.log('✅ Keeper is already authorized!');
    console.log('\n🎉 Setup complete! You can start the keeper bot:\n');
    console.log('  cd server');
    console.log('  npm run start:dev\n');
    return;
  }

  console.log('❌ Keeper not authorized yet\n');

  // Authorize keeper
  console.log('Authorizing keeper...');
  console.log(`Calling: setKeeper(${keeperAddress}, true)`);
  
  const tx = await strategy.setKeeper(keeperAddress, true);
  console.log(`Transaction sent: ${tx.hash}`);
  console.log('Waiting for confirmation...');
  
  const receipt = await tx.wait();
  console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);

  // Verify
  console.log('\nVerifying authorization...');
  const isNowAuthorized = await strategy.keepers(keeperAddress);
  
  if (isNowAuthorized) {
    console.log('✅ Keeper successfully authorized!');
    console.log('\n🎉 Setup complete! You can now start the keeper bot:\n');
    console.log('  cd server');
    console.log('  npm run start:dev\n');
  } else {
    console.log('❌ Verification failed. Keeper not authorized.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  });

