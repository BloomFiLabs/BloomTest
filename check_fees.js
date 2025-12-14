const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const STRATEGY_ADDRESS = '0xeCBaadfEDeb5533F94DA4D680771EcCB5deFf8a6';
const LIQUIDITY_MANAGER = '0x41e80F26793a848DA2FD1AD99a749E89623926f2';

const STRATEGY_ABI = [
  'function activeRange() view returns (uint256)',
  'function pool() view returns (address)',
  'function lastHarvestTimestamp() view returns (uint256)',
];

const LIQUIDITY_MANAGER_ABI = [
  'function getManagedPosition(address owner, address pool, uint256 rangePct1e5) view returns (uint256 tokenId, uint128 liquidity, int24 tickLower, int24 tickUpper)',
];

const POSITION_MANAGER_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  
  const strategy = new ethers.Contract(STRATEGY_ADDRESS, STRATEGY_ABI, provider);
  const liquidityManager = new ethers.Contract(LIQUIDITY_MANAGER, LIQUIDITY_MANAGER_ABI, provider);
  
  console.log('🔍 Checking DeltaNeutralStrategy for uncollected fees...\n');
  console.log(`Strategy: ${STRATEGY_ADDRESS}`);
  
  // Get strategy info
  const activeRange = await strategy.activeRange();
  const poolAddress = await strategy.pool();
  const lastHarvest = await strategy.lastHarvestTimestamp();
  
  console.log(`Active Range: ${activeRange} (${Number(activeRange) / 100000}%)`);
  console.log(`Pool: ${poolAddress}`);
  console.log(`Last Harvest: ${new Date(Number(lastHarvest) * 1000).toISOString()}`);
  console.log(`Time since harvest: ${Math.floor((Date.now() / 1000 - Number(lastHarvest)) / 3600)} hours\n`);
  
  // Get position info
  const position = await liquidityManager.getManagedPosition(STRATEGY_ADDRESS, poolAddress, activeRange);
  console.log(`Position Token ID: ${position.tokenId}`);
  console.log(`Liquidity: ${ethers.formatUnits(position.liquidity, 0)}`);
  console.log(`Tick Range: [${position.tickLower}, ${position.tickUpper}]\n`);
  
  if (position.tokenId > 0) {
    // Query Uniswap Position Manager to see uncollected fees
    const POSITION_MANAGER = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1'; // Base mainnet
    const positionManager = new ethers.Contract(POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
    
    const positionData = await positionManager.positions(position.tokenId);
    console.log('💰 Uncollected Fees:');
    console.log(`   Token0 (ETH): ${ethers.formatEther(positionData.tokensOwed0)} ETH`);
    console.log(`   Token1 (USDC): ${ethers.formatUnits(positionData.tokensOwed1, 6)} USDC`);
    
    const totalValueUSD = parseFloat(ethers.formatEther(positionData.tokensOwed0)) * 3500 + parseFloat(ethers.formatUnits(positionData.tokensOwed1, 6));
    console.log(`   Total Value: ~$${totalValueUSD.toFixed(2)}`);
    
    // Check current pool price
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    const slot0 = await pool.slot0();
    console.log(`\n📊 Current Pool Tick: ${slot0.tick}`);
    console.log(`   Position In Range: ${slot0.tick >= position.tickLower && slot0.tick <= position.tickUpper ? '✅ YES' : '❌ NO'}`);
  } else {
    console.log('⚠️  No active position found!');
  }
}

main().catch(console.error);
