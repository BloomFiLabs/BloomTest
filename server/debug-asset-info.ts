import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const privateKey = process.env.PRIVATE_KEY!;
  const walletAddress = '0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03';
  
  const sdk = new Hyperliquid({ 
    privateKey, 
    walletAddress,
    testnet: false, 
    enableWs: false 
  });
  
  // Get spot meta to see szDecimals for HYPE
  const spotMeta = await sdk.info.spot.getSpotMeta();
  const hypePair = spotMeta.universe.find((p: any) => p.name === 'HYPE-SPOT');
  
  console.log('HYPE-SPOT pair info:');
  console.log(JSON.stringify(hypePair, null, 2));
  
  // Get user state to see what the API thinks we have
  const userState = await sdk.info.userState(walletAddress);
  console.log('\nUser state spot balances:');
  console.log(JSON.stringify(userState.spotBalances, null, 2));
  
  // Try with a very small size to see if it's a minimum order issue
  console.log('\nTrying tiny order: 0.01 HYPE');
  const result1 = await sdk.exchange.placeOrder({
    coin: 'HYPE-SPOT',
    is_buy: false,
    sz: 0.01,
    limit_px: 30,
    order_type: { limit: { tif: 'Ioc' } },
    reduce_only: false,
  });
  console.log('Result:', JSON.stringify(result1, null, 2));
}

main().catch(console.error);





