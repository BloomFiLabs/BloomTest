import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const sdk = new Hyperliquid({ testnet: false, enableWs: false });
  // We need the map to be populated. If refresh hangs, we might be stuck.
  // But maybe we can inspect what's there by default or after a short wait.
  
  console.log('Refreshing maps...');
  try {
    await Promise.race([
      sdk.refreshAssetMapsNow(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);
  } catch (e) {
    console.log('Refresh timed out or failed, checking if partial data exists...');
  }

  // Check internal map
  const meta = sdk.symbolConversion;
  console.log('Map loaded?', meta.initialized);
  
  // Look for HYPE in the spot meta if accessible
  // The SDK stores meta in `spotMeta` or similar if we can find it.
  // Let's check `exchangeToInternalNameMap` for 'HYPE-SPOT'
  const internalName = meta.exchangeToInternalNameMap['HYPE-SPOT'];
  console.log('HYPE-SPOT internal name:', internalName);
  
  // If we can find the decimals used for this asset
  // The SDK usually uses `universe` data.
  
  console.log('Done');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });






