#!/usr/bin/env ts-node
/**
 * Verify that gas price fetching is working correctly
 * Run this to ensure the bot is using live gas prices, not hardcoded values
 */

import { ethers } from 'ethers';

async function verifyGasPriceFetching() {
  console.log('🔍 VERIFYING GAS PRICE FETCHING');
  console.log('═'.repeat(70));
  console.log();

  const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
  
  console.log(`📡 Connecting to: ${RPC_URL}`);
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  try {
    // Test 1: Fetch gas price
    console.log('\n✅ Test 1: Fetching current gas price...');
    const feeData = await provider.getFeeData();
    const gasPriceWei = feeData.gasPrice || 0n;
    const gasPriceGwei = Number(ethers.formatUnits(gasPriceWei, 'gwei'));
    
    console.log(`   Gas Price: ${gasPriceGwei.toFixed(4)} Gwei`);
    console.log(`   Gas Price (wei): ${gasPriceWei.toString()}`);
    
    // Validate
    if (gasPriceGwei === 0) {
      console.error('   ❌ FAILED: Gas price is 0!');
      return false;
    }
    if (gasPriceGwei > 10) {
      console.warn('   ⚠️  WARNING: Gas price very high for Base network');
    }
    if (gasPriceGwei < 0.0001) {
      console.warn('   ⚠️  WARNING: Gas price suspiciously low');
    }

    // Test 2: Calculate rebalance cost
    console.log('\n✅ Test 2: Calculating rebalance cost...');
    const GAS_UNITS = 450_000;
    const ETH_PRICE = 3000; // Approximate
    const gasCostETH = (GAS_UNITS * gasPriceGwei) / 1e9;
    const gasCostUSD = gasCostETH * ETH_PRICE;
    
    console.log(`   Gas Units: ${GAS_UNITS.toLocaleString()}`);
    console.log(`   Cost in ETH: ${gasCostETH.toFixed(6)} ETH`);
    console.log(`   Cost in USD: $${gasCostUSD.toFixed(4)}`);

    // Test 3: Multiple fetches to check consistency
    console.log('\n✅ Test 3: Consistency check (5 samples)...');
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const data = await provider.getFeeData();
      const price = data.gasPrice ? Number(ethers.formatUnits(data.gasPrice, 'gwei')) : 0;
      samples.push(price);
      console.log(`   Sample ${i + 1}: ${price.toFixed(4)} Gwei`);
      await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms
    }
    
    const avg = samples.reduce((a, b) => a + b) / samples.length;
    const stdDev = Math.sqrt(samples.reduce((sq, n) => sq + Math.pow(n - avg, 2), 0) / samples.length);
    
    console.log(`   Average: ${avg.toFixed(4)} Gwei`);
    console.log(`   Std Dev: ${stdDev.toFixed(4)} Gwei`);
    
    if (stdDev / avg > 0.5) {
      console.warn('   ⚠️  WARNING: High variance in gas price samples');
    }

    // Test 4: Block number check
    console.log('\n✅ Test 4: Network connectivity...');
    const blockNumber = await provider.getBlockNumber();
    const block = await provider.getBlock(blockNumber);
    
    console.log(`   Latest Block: ${blockNumber}`);
    console.log(`   Block Timestamp: ${new Date((block?.timestamp || 0) * 1000).toISOString()}`);
    
    const now = Date.now() / 1000;
    const blockAge = now - (block?.timestamp || 0);
    
    if (blockAge > 60) {
      console.error(`   ❌ FAILED: Block is ${blockAge.toFixed(0)}s old - RPC might be stale!`);
      return false;
    }
    console.log(`   Block Age: ${blockAge.toFixed(1)}s (✅ Fresh)`);

    // Summary
    console.log('\n═'.repeat(70));
    console.log('✅ ALL TESTS PASSED');
    console.log('═'.repeat(70));
    console.log();
    console.log('📋 SUMMARY:');
    console.log(`   ✅ Gas price fetching: WORKING`);
    console.log(`   ✅ Current gas price: ${gasPriceGwei.toFixed(4)} Gwei`);
    console.log(`   ✅ Rebalance cost: $${gasCostUSD.toFixed(4)}`);
    console.log(`   ✅ RPC connection: ACTIVE`);
    console.log();
    console.log('💡 TIP: Run this script periodically to verify gas price fetching');
    console.log('    If gas prices seem wrong, check your RPC_URL configuration');
    console.log();

    return true;

  } catch (error) {
    console.error('\n❌ ERROR:', error);
    console.error('\n🔧 TROUBLESHOOTING:');
    console.error('   1. Check RPC_URL is set correctly in .env');
    console.error('   2. Verify network connectivity');
    console.error('   3. Try a different RPC endpoint');
    console.error();
    return false;
  }
}

// Run verification
verifyGasPriceFetching()
  .then(success => process.exit(success ? 0 : 1))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });










