import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';
dotenv.config();

/**
 * MINIMAL WORKING SCRIPT - Just place one order
 * Using SDK exactly as documented, no hacks
 */
async function main() {
  const privateKey = process.env.PRIVATE_KEY!;
  const walletAddress = '0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03';
  
  console.log('Initializing SDK...');
  const sdk = new Hyperliquid({ 
    privateKey, 
    walletAddress,
    testnet: false,
    enableWs: false 
  });
  
  // Wait for asset maps to load
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Get balance
  console.log('Checking balance...');
  const spotState = await sdk.info.spot.getSpotClearinghouseState(walletAddress);
  const hype = spotState.balances.find((b: any) => b.coin === 'HYPE-SPOT');
  console.log(`HYPE balance: ${hype.total} (hold: ${hype.hold})`);
  
  // Place order - simplest possible
  console.log('\nPlacing order...');
  const result = await sdk.exchange.placeOrder({
    coin: 'HYPE-SPOT',
    is_buy: false,
    sz: 0.01,
    limit_px: 30,
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: false,
  });
  
  console.log('\nResult:');
  console.log(JSON.stringify(result, null, 2));
  
  // If error, try to understand it
  if (result.response?.data?.statuses?.[0]?.error) {
    const error = result.response.data.statuses[0].error;
    console.log(`\n❌ Error: ${error}`);
    
    // Check if it's a balance issue
    if (error.includes('balance')) {
      console.log('\nBalance error detected. Checking all balances...');
      console.log('Spot balances:', spotState.balances);
    }
  } else if (result.response?.data?.statuses?.[0]?.filled) {
    console.log('\n✅ ORDER FILLED!');
  }
}

main().catch(console.error);

