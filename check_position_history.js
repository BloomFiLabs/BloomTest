const { ethers } = require('ethers');

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const STRATEGY_ADDRESS = '0xeCBaadfEDeb5533F94DA4D680771EcCB5deFf8a6';
const POOL_ADDRESS = '0xd0b53D9277642d899DF5C87A3966A349A798F224';

const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
];

const LIQUIDITY_MANAGER_ABI = [
  'function getManagedPosition(address owner, address pool, uint256 rangePct1e5) view returns (uint256 tokenId, uint128 liquidity, int24 tickLower, int24 tickUpper)',
];

const LIQUIDITY_MANAGER = '0x41e80F26793a848DA2FD1AD99a749E89623926f2';

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  
  console.log('📊 Position Analysis\n');
  
  // Get current position
  const liquidityManager = new ethers.Contract(LIQUIDITY_MANAGER, LIQUIDITY_MANAGER_ABI, provider);
  const position = await liquidityManager.getManagedPosition(STRATEGY_ADDRESS, POOL_ADDRESS, 1950000);
  
  console.log('Position Details:');
  console.log(`  Token ID: ${position.tokenId}`);
  console.log(`  Liquidity: ${ethers.formatUnits(position.liquidity, 0)}`);
  console.log(`  Tick Lower: ${position.tickLower}`);
  console.log(`  Tick Upper: ${position.tickUpper}`);
  
  // Get current pool price
  const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, provider);
  const slot0 = await pool.slot0();
  
  console.log(`\nCurrent Pool State:`);
  console.log(`  Current Tick: ${slot0.tick}`);
  
  const inRange = slot0.tick >= position.tickLower && slot0.tick <= position.tickUpper;
  console.log(`  In Range: ${inRange ? '✅ YES - Earning fees!' : '❌ NO - Not earning fees'}`);
  
  if (!inRange) {
    console.log(`\n⚠️  Position is OUT OF RANGE`);
    console.log(`  Price needs to move into tick range [${position.tickLower}, ${position.tickUpper}]`);
    console.log(`  Current tick ${slot0.tick} is ${slot0.tick < position.tickLower ? 'below' : 'above'} the range`);
  } else {
    console.log(`\n✅ Position is IN RANGE and earning fees from swaps!`);
  }
  
  // Calculate position value
  const sqrtPriceX96 = slot0.sqrtPriceX96;
  const price = (Number(sqrtPriceX96) / (2 ** 96)) ** 2;
  const ethPrice = price * (10 ** 12); // Adjust for decimals
  
  console.log(`\nCurrent ETH Price: $${ethPrice.toFixed(2)}`);
  
  // Calculate tick prices
  const tickToPrice = (tick) => {
    return 1.0001 ** tick * (10 ** 12);
  };
  
  console.log(`\nPrice Range:`);
  console.log(`  Lower Price: $${tickToPrice(position.tickLower).toFixed(2)}`);
  console.log(`  Upper Price: $${tickToPrice(position.tickUpper).toFixed(2)}`);
  console.log(`  Current Price: $${ethPrice.toFixed(2)}`);
  
  const rangeWidth = ((tickToPrice(position.tickUpper) - tickToPrice(position.tickLower)) / tickToPrice(position.tickLower)) * 100;
  console.log(`  Range Width: ${rangeWidth.toFixed(2)}%`);
}

main().catch(console.error);
