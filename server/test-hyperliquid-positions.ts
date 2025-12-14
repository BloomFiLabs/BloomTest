/**
 * Test script to debug Hyperliquid position parsing
 * Specifically tests the "coin" field structure
 */

import * as dotenv from 'dotenv';
import { InfoClient, HttpTransport } from '@nktkas/hyperliquid';

dotenv.config();

const WALLET_ADDRESS = process.env.HYPERLIQUID_WALLET_ADDRESS || process.env.WALLET_ADDRESS;
const IS_TESTNET = process.env.HYPERLIQUID_TESTNET === 'true';

if (!WALLET_ADDRESS) {
  console.error('❌ ERROR: HYPERLIQUID_WALLET_ADDRESS or WALLET_ADDRESS must be set in .env');
  process.exit(1);
}

async function testPositions() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      TEST HYPERLIQUID POSITION PARSING                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log(`📡 Wallet Address: ${WALLET_ADDRESS}`);
  console.log(`🌐 Testnet: ${IS_TESTNET}\n`);

  try {
    // Initialize SDK
    console.log('🔐 Initializing HyperLiquid SDK...');
    const transport = new HttpTransport({ isTestnet: IS_TESTNET });
    const infoClient = new InfoClient({ transport });
    console.log('✅ SDK initialized\n');

    // Get clearinghouse state
    console.log('📊 Fetching clearinghouse state...');
    const clearinghouseState = await infoClient.clearinghouseState({ user: WALLET_ADDRESS });
    console.log('✅ State fetched\n');

    // Get meta to understand asset structure
    console.log('🔍 Fetching meta (universe) to understand asset structure...');
    const meta = await infoClient.meta();
    console.log(`✅ Meta fetched: ${meta.universe?.length || 0} assets in universe\n`);

    // Analyze positions
    if (clearinghouseState.assetPositions && clearinghouseState.assetPositions.length > 0) {
      console.log('📈 Analyzing Positions:\n');
      
      for (let i = 0; i < clearinghouseState.assetPositions.length; i++) {
        const assetPos = clearinghouseState.assetPositions[i];
        const position = assetPos.position;
        const size = parseFloat(position.szi || '0');
        
        if (size === 0) {
          console.log(`   Position ${i + 1}: Zero size, skipping\n`);
          continue;
        }

        console.log(`   Position ${i + 1}:`);
        console.log(`     Size: ${size > 0 ? 'LONG' : 'SHORT'} ${Math.abs(size)}`);
        console.log(`     Entry Price: $${parseFloat(position.entryPx || '0').toFixed(2)}`);
        console.log(`     Unrealized PnL: $${parseFloat(position.unrealizedPnl || '0').toFixed(2)}`);
        console.log(`     Margin Used: $${parseFloat(position.marginUsed || '0').toFixed(2)}`);
        
        // Analyze coin field
        const coin = position.coin;
        console.log(`     Coin field: ${JSON.stringify(coin)}`);
        console.log(`     Coin type: ${typeof coin}`);
        
        // Try to resolve coin name
        let coinName: string | null = null;
        if (typeof coin === 'string') {
          // Check if it's a numeric string (index) or coin name
          const parsed = parseInt(coin, 10);
          if (!isNaN(parsed) && String(parsed) === coin) {
            // It's a numeric string, treat as index
            console.log(`     → Detected as numeric string (index): ${parsed}`);
            if (meta.universe && parsed >= 0 && parsed < meta.universe.length) {
              coinName = meta.universe[parsed]?.name || null;
              console.log(`     → Resolved to coin name: ${coinName}`);
            } else {
              console.log(`     → ⚠️  Index ${parsed} out of range (universe length: ${meta.universe?.length || 0})`);
            }
          } else {
            // It's already a coin name
            coinName = coin;
            console.log(`     → Detected as coin name: ${coinName}`);
          }
        } else if (typeof coin === 'number') {
          // It's a numeric index
          console.log(`     → Detected as number (index): ${coin}`);
          if (meta.universe && coin >= 0 && coin < meta.universe.length) {
            coinName = meta.universe[coin]?.name || null;
            console.log(`     → Resolved to coin name: ${coinName}`);
          } else {
            console.log(`     → ⚠️  Index ${coin} out of range (universe length: ${meta.universe?.length || 0})`);
          }
        } else {
          console.log(`     → ⚠️  Unknown coin type: ${typeof coin}`);
        }
        
        if (coinName) {
          console.log(`     ✅ Final coin name: ${coinName}`);
        } else {
          console.log(`     ❌ Could not resolve coin name`);
        }
        
        console.log('');
      }
    } else {
      console.log('📈 No positions found\n');
    }

    // Show universe mapping for reference
    if (meta.universe && meta.universe.length > 0) {
      console.log('📋 Universe Mapping (first 20 assets):');
      for (let i = 0; i < Math.min(20, meta.universe.length); i++) {
        const asset = meta.universe[i];
        console.log(`   Index ${i}: ${asset.name}`);
      }
      if (meta.universe.length > 20) {
        console.log(`   ... and ${meta.universe.length - 20} more`);
      }
      console.log('');
    }

    console.log('✅ Test completed successfully!');

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the test
testPositions()
  .then(() => {
    console.log('\n✅ Test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });
















