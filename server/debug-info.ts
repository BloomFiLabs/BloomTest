import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const sdk = new Hyperliquid({ testnet: true, enableWs: false });
  
  console.log('Info keys:', Object.keys(sdk.info));
  console.log('Info.spot keys:', Object.keys(sdk.info.spot));
  
  // Try to find the meta function
  try {
      // @ts-ignore
      const meta = await sdk.info.spot.getSpotMeta();
      console.log('Meta found via getSpotMeta');
      const universe = meta.universe;
      const hype = universe.find((u: any) => u.name.includes('HYPE'));
      console.log('HYPE:', hype);
  } catch (e: any) {
      console.log('getSpotMeta failed:', e.message);
  }
}

main().catch(console.error);






