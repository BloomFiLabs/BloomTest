import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const sdk = new Hyperliquid({ testnet: false, enableWs: false });
  await sdk.refreshAssetMapsNow();
  
  const sc = sdk.symbolConversion;
  console.log('Props:', Object.keys(sc));
  
  // If we can check internal state
  // @ts-ignore
  if (sc.assetToDecimalMap) console.log('Has decimal map');
  // @ts-ignore
  if (sc.spotMeta) console.log('Has spotMeta');
}

main().catch(console.error);






