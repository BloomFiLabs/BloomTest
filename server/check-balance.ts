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
  
  // Get spot balances using SDK
  const spotState = await sdk.info.spot.getSpotClearinghouseState(walletAddress);
  console.log('Spot balances:', JSON.stringify(spotState.balances, null, 2));
  
  const hype = spotState.balances.find((b: any) => b.coin === 'HYPE' || b.coin === 'HYPE-SPOT');
  if (hype) {
    console.log('\nHYPE balance:', hype);
    console.log(`Total: ${hype.total}`);
    console.log(`Hold: ${hype.hold}`);
    console.log(`Available: ${parseFloat(hype.total) - parseFloat(hype.hold)}`);
  }
}

main().catch(console.error);






