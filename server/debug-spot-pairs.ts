import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Test with a different spot pair to see if issue is HYPE-specific
 */
async function main() {
  const privateKey = process.env.PRIVATE_KEY!;
  const walletAddress = '0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03';
  
  const sdk = new Hyperliquid({ 
    privateKey, 
    walletAddress,
    testnet: false,
    enableWs: false 
  });
  
  // Get all spot pairs
  const spotMeta = await sdk.info.spot.getSpotMeta();
  console.log('Available spot pairs:');
  spotMeta.universe.slice(0, 10).forEach((p: any) => {
    console.log(`  ${p.name} (index: ${p.index}, tokens: ${p.tokens})`);
  });
  
  // Check our balances
  const spotState = await sdk.info.spot.getSpotClearinghouseState(walletAddress);
  console.log('\nOur spot balances:');
  spotState.balances.forEach((b: any) => {
    if (parseFloat(b.total) > 0) {
      console.log(`  ${b.coin} (token ${b.token}): ${b.total}`);
    }
  });
  
  // We only have HYPE, so we can't test other pairs
  // But let's see if maybe the issue is that we need USDC to sell HYPE?
  // Or maybe there's a minimum order value?
  
  console.log('\n=== Trying to understand the error ===');
  console.log('Error: "Insufficient spot balance asset=10107"');
  console.log('Asset 10107 = pair index 107 (HYPE-SPOT)');
  console.log('But balance is token 150 (HYPE base token)');
  console.log('\nMaybe HyperLiquid checks balance for the PAIR, not the token?');
  console.log('Or maybe there\'s a bug in the SDK?');
  
  // Let's try one more thing - what if we need to specify the order differently?
  // Or maybe the size needs to be in a specific format?
}

main().catch(console.error);





