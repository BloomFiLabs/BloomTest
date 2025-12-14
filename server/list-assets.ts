import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const sdk = new Hyperliquid({ testnet: true, enableWs: false });
  
  console.log('Fetching asset maps...');
  // We must wait for this. If it hangs, we have a network issue, not an SDK issue.
  await sdk.refreshAssetMapsNow();
  
  console.log('--- SPOT ASSETS ---');
  // Get the internal map directly to see what keys are valid
  // @ts-ignore
  const map = sdk.symbolConversion.exchangeToInternalNameMap;
  const keys = Object.keys(map).filter(k => k.includes('HYPE'));
  
  if (keys.length === 0) {
    console.log('CRITICAL: No assets found matching "HYPE". Dumping first 10 assets:');
    console.log(Object.keys(map).slice(0, 10));
  } else {
    console.log('Found HYPE assets:', keys);
    keys.forEach(k => {
       console.log(`  "${k}" -> "${map[k]}"`);
    });
  }
  
  // Also check the universe to see decimals
  console.log('\n--- META ---');
  // @ts-ignore
  const spotMeta = sdk.symbolConversion.spotMeta; 
  // Or whatever property holds it. The SDK uses `info.spot.getSpotMeta()` internally?
  // Let's try to fetch meta via API if we can't inspect internal state easily.
  
  const meta = await sdk.info.spot.getMeta();
  const hype = meta.universe.find((u: any) => u.name === 'HYPE' || u.name.includes('HYPE'));
  console.log('HYPE Meta:', hype);
}

main().catch(console.error);

