/**
 * Check HyperLend transaction history to see how collateral was deposited
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

dotenv.config();

const CONFIG = {
  rpcUrl: process.env.HYPERLIQUID_RPC_URL || 'https://rpc.hyperliquid.xyz/evm',
  strategyAddress: '0x8a84642BF5FF4316dad8Bc01766DE68d6287f126',
  hyperLendPool: '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b',
  usdcAddress: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
};

// ABI for deposit event
const DEPOSIT_EVENT_ABI = [
  'event Deposit(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referral)',
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint256 borrowRateMode, uint256 borrowRate, uint16 indexed referral)',
];

async function main() {
  console.log('═'.repeat(70));
  console.log('  CHECKING HYPERLEND TRANSACTION HISTORY');
  console.log('═'.repeat(70));
  console.log(`Strategy: ${CONFIG.strategyAddress}`);
  console.log(`HyperLend Pool: ${CONFIG.hyperLendPool}`);
  console.log('');

  const provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl);
  const hyperLend = new ethers.Contract(CONFIG.hyperLendPool, DEPOSIT_EVENT_ABI, provider);

  // Get recent blocks (last 1000 blocks)
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - 10000);
  
  console.log(`📡 Scanning blocks ${fromBlock} to ${currentBlock}...`);
  console.log('');

  try {
    // Look for Deposit events where onBehalfOf is the strategy
    const depositFilter = hyperLend.filters.Deposit(null, null, CONFIG.strategyAddress);
    const deposits = await hyperLend.queryFilter(depositFilter, fromBlock, currentBlock);

    console.log(`📥 Found ${deposits.length} deposit events for strategy:`);
    console.log('');
    
    for (const deposit of deposits.slice(-10)) { // Last 10 deposits
      if ('args' in deposit && deposit.args) {
        const args = deposit.args;
        const reserve = args.reserve;
        const amount = Number(args.amount) / 1e6; // USDC has 6 decimals
        const block = await provider.getBlock(deposit.blockNumber);
        if (block) {
          const tx = await deposit.getTransaction();
          
          console.log(`   Block ${deposit.blockNumber} (${new Date(block.timestamp * 1000).toISOString()})`);
          console.log(`   Reserve: ${reserve}`);
          console.log(`   Amount: $${amount.toFixed(2)}`);
          console.log(`   TX: ${tx.hash}`);
          console.log(`   From: ${tx.from}`);
          console.log('');
        }
      }
    }

    // Look for Borrow events
    const borrowFilter = hyperLend.filters.Borrow(null, null, CONFIG.strategyAddress);
    const borrows = await hyperLend.queryFilter(borrowFilter, fromBlock, currentBlock);

    console.log(`📤 Found ${borrows.length} borrow events for strategy:`);
    console.log('');
    
    for (const borrow of borrows.slice(-10)) {
      if ('args' in borrow && borrow.args) {
        const args = borrow.args;
        const reserve = args.reserve;
        const amount = Number(args.amount) / 1e6;
        const block = await provider.getBlock(borrow.blockNumber);
        
        if (block) {
          console.log(`   Block ${borrow.blockNumber} (${new Date(block.timestamp * 1000).toISOString()})`);
          console.log(`   Reserve: ${reserve}`);
          console.log(`   Amount: $${amount.toFixed(2)}`);
          console.log('');
        }
      }
    }

    // Check if USDC address matches
    console.log('═'.repeat(70));
    console.log('  ADDRESS VERIFICATION');
    console.log('═'.repeat(70));
    console.log(`HyperEVM USDC: ${CONFIG.usdcAddress}`);
    console.log('');
    
    if (deposits.length > 0) {
      const lastDeposit = deposits[deposits.length - 1];
      if ('args' in lastDeposit && lastDeposit.args) {
        const reserve = lastDeposit.args.reserve;
        console.log(`Last deposit reserve: ${reserve}`);
        console.log(`Match: ${reserve?.toLowerCase() === CONFIG.usdcAddress.toLowerCase() ? '✅ YES' : '❌ NO'}`);
        console.log('');
      }
    }

  } catch (error: any) {
    console.log(`❌ Error: ${error.message}`);
    console.log('');
    console.log('This might mean:');
    console.log('1. No deposits have been made yet');
    console.log('2. The event signature is different');
    console.log('3. The block range is too small');
  }
}

main().catch(console.error);


