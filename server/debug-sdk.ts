import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const sdk = new Hyperliquid({ testnet: false, enableWs: false });
  await sdk.refreshAssetMapsNow();

  console.log('--- HYPE Assets ---');
  const keys = Object.keys(sdk.symbolConversion.exchangeToInternalNameMap);
  const hypeKeys = keys.filter(k => k.includes('HYPE'));
  console.log(hypeKeys);

  console.log('\n--- Mappings ---');
  for (const key of hypeKeys) {
    console.log(`${key} => ${sdk.symbolConversion.exchangeToInternalNameMap[key]}`);
  }
  
  console.log('\n--- Testing HYPE-SPOT Mapping ---');
  console.log(`HYPE-SPOT => ${sdk.symbolConversion.exchangeToInternalNameMap['HYPE-SPOT']}`);
  
  // Also check if there's any map that gives us IDs
  console.log('\n--- Asset to Index ---');
  const assetIndexKeys = Object.keys(sdk.symbolConversion.assetToIndexMap);
  const hypeIndexKeys = assetIndexKeys.filter(k => k.includes('HYPE'));
  for (const key of hypeIndexKeys) {
    console.log(`${key} => ${sdk.symbolConversion.assetToIndexMap[key]}`);
  }
}

main().catch(console.error);






