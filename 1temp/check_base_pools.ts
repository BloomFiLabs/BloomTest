/**
 * Check what pools exist on Base network
 */

const WETH_BASE = '0x4200000000000000000000000000000000000006'; // WETH on Base
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base  
const USDT_BASE = '0x'; // Need to find
const WBTC_BASE = '0x'; // Need to find - might be cbBTC

console.log('Base Network Token Addresses:');
console.log('WETH:', WETH_BASE);
console.log('USDC:', USDC_BASE);
console.log('');
console.log('Note: Base uses cbBTC (Coinbase Wrapped BTC), not WBTC');
console.log('cbBTC address: 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf');
console.log('');
console.log('Likely pools on Base:');
console.log('  - WETH/USDC 0.05%');
console.log('  - WETH/USDC 0.3%');
console.log('  - cbBTC/USDC 0.3%');
console.log('  - cbBTC/WETH 0.3%');
