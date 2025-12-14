const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const STRATEGY_ADDRESS = '0xeCBaadfEDeb5533F94DA4D680771EcCB5deFf8a6';

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  
  console.log('🔍 Checking harvest transaction history...\n');
  console.log(`Strategy: ${STRATEGY_ADDRESS}`);
  console.log(`Basescan: https://basescan.org/address/${STRATEGY_ADDRESS}\n`);
  
  // Get recent blocks
  const latestBlock = await provider.getBlockNumber();
  console.log(`Latest block: ${latestBlock}`);
  console.log(`\nTo see harvest transactions, visit:`);
  console.log(`https://basescan.org/address/${STRATEGY_ADDRESS}#internaltx`);
  console.log(`\nLook for transactions to:`);
  console.log(`- harvest() function`);
  console.log(`- rebalance() function`);
  console.log(`- Events: FeesCollected, ManagerFeeTaken`);
}

main().catch(console.error);
