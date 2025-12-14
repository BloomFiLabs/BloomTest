const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const STRATEGY_ADDRESS = '0xeCBaadfEDeb5533F94DA4D680771EcCB5deFf8a6';

const STRATEGY_ABI = [
  'event FeesCollected(address indexed owner, uint256 indexed tokenId, uint256 amount0, uint256 amount1)',
  'event ManagerFeeTaken(uint256 amount)',
  'function lastHarvestTimestamp() view returns (uint256)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const strategy = new ethers.Contract(STRATEGY_ADDRESS, STRATEGY_ABI, provider);
  
  console.log('💰 Checking last harvest details...\n');
  
  const lastHarvest = await strategy.lastHarvestTimestamp();
  const harvestTime = new Date(Number(lastHarvest) * 1000);
  
  console.log(`Last Harvest Time: ${harvestTime.toISOString()}`);
  console.log(`Time ago: ${Math.floor((Date.now() - harvestTime.getTime()) / 60000)} minutes ago\n`);
  
  // Get the block number for that timestamp (approximate)
  const latestBlock = await provider.getBlockNumber();
  const latestBlockData = await provider.getBlock(latestBlock);
  const blocksPerHour = 1800; // Base produces ~1 block every 2 seconds
  const hoursSinceHarvest = (Date.now() / 1000 - Number(lastHarvest)) / 3600;
  const estimatedHarvestBlock = latestBlock - Math.floor(hoursSinceHarvest * blocksPerHour);
  
  console.log(`Estimated harvest block: ${estimatedHarvestBlock}`);
  console.log(`Searching from block ${estimatedHarvestBlock} to ${latestBlock}...\n`);
  
  // Query events
  const feesCollectedFilter = strategy.filters.FeesCollected();
  const managerFeeFilter = strategy.filters.ManagerFeeTaken();
  
  try {
    const feesEvents = await strategy.queryFilter(feesCollectedFilter, estimatedHarvestBlock, latestBlock);
    const managerEvents = await strategy.queryFilter(managerFeeFilter, estimatedHarvestBlock, latestBlock);
    
    if (feesEvents.length > 0) {
      console.log('📊 FeesCollected Events:');
      feesEvents.forEach((event, i) => {
        const args = event.args;
        const eth = ethers.formatEther(args.amount0);
        const usdc = ethers.formatUnits(args.amount1, 6);
        const ethPrice = 3500; // approximate
        const totalUSD = parseFloat(eth) * ethPrice + parseFloat(usdc);
        
        console.log(`\nEvent ${i + 1}:`);
        console.log(`  Block: ${event.blockNumber}`);
        console.log(`  Token ID: ${args.tokenId}`);
        console.log(`  ETH collected: ${eth} ETH`);
        console.log(`  USDC collected: ${usdc} USDC`);
        console.log(`  Estimated Value: $${totalUSD.toFixed(2)}`);
      });
    } else {
      console.log('No FeesCollected events found in recent blocks');
    }
    
    if (managerEvents.length > 0) {
      console.log('\n💼 Manager Fee Events:');
      managerEvents.forEach((event, i) => {
        const amount = ethers.formatUnits(event.args.amount, 6);
        console.log(`\nEvent ${i + 1}:`);
        console.log(`  Block: ${event.blockNumber}`);
        console.log(`  Manager Fee (20%): ${amount} USDC`);
        
        // Calculate total from manager fee
        const totalCollected = parseFloat(amount) / 0.2;
        const userShare = totalCollected * 0.8;
        console.log(`  User Share (80%): $${userShare.toFixed(2)} USDC`);
        console.log(`  Total Collected: $${totalCollected.toFixed(2)}`);
      });
    } else {
      console.log('\nNo Manager Fee events found in recent blocks');
    }
    
  } catch (error) {
    console.error('Error querying events:', error.message);
    console.log('\nTry checking Basescan manually:');
    console.log(`https://basescan.org/address/${STRATEGY_ADDRESS}#events`);
  }
}

main().catch(console.error);
