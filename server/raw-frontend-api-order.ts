/**
 * HyperLiquid Order Script - Official API Spec
 * 
 * This script places orders using the official HyperLiquid API endpoint
 * as specified in: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
 * 
 * Usage:
 *   1. Set PRIVATE_KEY in .env file
 *   2. Modify the order parameters below
 *   3. Run: npx tsx raw-frontend-api-order.ts
 */

import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { SymbolConverter, formatSize, formatPrice } from '@nktkas/hyperliquid/utils';
import { signL1Action } from '@nktkas/hyperliquid/signing';
import { OrderRequest, parser } from '@nktkas/hyperliquid/api/exchange';
import * as dotenv from 'dotenv';
import { ethers } from 'ethers';

// Load environment variables
dotenv.config();

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════

const ORDER_CONFIG = {
  // For SPOT orders, use format like "HYPE/USDC" or check spotMeta for exact name (e.g., "@107")
  // For PERP orders, use format like "ETH", "BTC", etc. (just the coin name, no "/" or "@")
  coin: 'ETH', // PERP order - ETH perpetual (asset ID: 1 = index in meta.universe)
  isBuy: true,
  size: 0.01, // Size in ETH (0.01 ETH at ~$3000 = ~$30 order value)
  limitPrice: 3000, // Price in USD (current market price ~$2996.75)
  timeInForce: 'Gtc' as 'Ioc' | 'Gtc' | 'FrontendMarket', // Good Till Cancel (can be overridden by hardcoded values)
  reduceOnly: false,
  // LEVERAGE SETTINGS (for perp orders only)
  // If set, position size will be calculated as: (available_margin * leverage) / mark_price
  // Leave as null to use the size above directly
  desiredLeverage: null as number | null, // e.g., 5 for 5x leverage, null to use size directly
  maxLeveragePercent: 80, // Use 80% of max leverage allowed by asset (safety buffer)
  // IMPORTANT: If trading on a sub-account, set this to the sub-account address
  // For main account, leave as null
  vaultAddress: null as `0x${string}` | null,
};

// ═══════════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║      HYPERLIQUID ORDER (OFFICIAL API SPEC)              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const privateKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) {
    console.error('❌ ERROR: PRIVATE_KEY not found in .env file');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(privateKey);
  const walletAddress = wallet.address;
  const vaultAddress = ORDER_CONFIG.vaultAddress;
  
  console.log(`Wallet (Signer): ${walletAddress}`);
  if (vaultAddress) {
    console.log(`Vault/Sub-Account: ${vaultAddress}`);
    console.log(`⚠️  Trading on behalf of sub-account (signing with master, executing on sub)`);
  } else {
    console.log(`Trading on main account`);
  }
  console.log('');

  // Initialize
  const transport = new HttpTransport({ isTestnet: false });
  const infoClient = new InfoClient({ transport });
  const symbolConverter = await SymbolConverter.create({ transport });

  // ═══════════════════════════════════════════════════════════
  // ACCOUNT STATE CHECK - Check BOTH accounts
  // ═══════════════════════════════════════════════════════════
  
  // The account that will execute the order
  const orderTargetAccount = vaultAddress || walletAddress;
  
  console.log('💰 Account State Check:');
  console.log('─'.repeat(60));
  console.log(`Order will execute on: ${orderTargetAccount}`);
  if (vaultAddress) {
    console.log(`(Sub-account specified in vaultAddress)`);
  } else {
    console.log(`(Main account - no vaultAddress set)`);
  }
  console.log('');

  // Check BOTH accounts to see where funds actually are
  const accountsToCheck = vaultAddress 
    ? [walletAddress, vaultAddress] // Check both if using sub-account
    : [walletAddress]; // Just main if not using sub-account

  const accountBalances: Array<{ address: string; accountValue: number; freeCollateral: number }> = [];

  for (const account of accountsToCheck) {
    try {
      const clearinghouseState = await infoClient.clearinghouseState({ user: account });
      const marginSummary = clearinghouseState.marginSummary;
      
      const accountValue = parseFloat(marginSummary.accountValue || '0');
      const totalMarginUsed = parseFloat(marginSummary.totalMarginUsed || '0');
      const freeCollateral = accountValue - totalMarginUsed;
      
      accountBalances.push({ address: account, accountValue, freeCollateral });
      
      const accountLabel = account === walletAddress ? 'MAIN ACCOUNT' : 'SUB-ACCOUNT';
      console.log(`📊 ${accountLabel} (${account.slice(0, 10)}...):`);
      console.log(`   Account Value: $${accountValue.toFixed(2)}`);
      console.log(`   Margin Used: $${totalMarginUsed.toFixed(2)}`);
      console.log(`   Free Collateral: $${freeCollateral.toFixed(2)}`);
      
      if (clearinghouseState.assetPositions && clearinghouseState.assetPositions.length > 0) {
        const activePositions = clearinghouseState.assetPositions.filter(
          (pos: any) => parseFloat(pos.position.szi || '0') !== 0
        );
        if (activePositions.length > 0) {
          console.log(`   Active Positions: ${activePositions.length}`);
        }
      }
      console.log('');
    } catch (error: any) {
      console.log(`   ⚠️  Could not check ${account}: ${error.message}\n`);
    }
  }

  // ⚠️ CRITICAL WARNING: Check if funds are in wrong account
  const targetAccountBalance = accountBalances.find(b => b.address === orderTargetAccount);
  const otherAccountBalance = accountBalances.find(b => b.address !== orderTargetAccount);
  
  if (targetAccountBalance && otherAccountBalance) {
    if (targetAccountBalance.freeCollateral < 10 && otherAccountBalance.freeCollateral > 10) {
      console.log('⚠️  ⚠️  ⚠️  CRITICAL WARNING ⚠️  ⚠️  ⚠️');
      console.log('─'.repeat(60));
      console.log(`   Funds are in: ${otherAccountBalance.address === walletAddress ? 'MAIN ACCOUNT' : 'SUB-ACCOUNT'}`);
      console.log(`   Order target: ${orderTargetAccount === walletAddress ? 'MAIN ACCOUNT' : 'SUB-ACCOUNT'}`);
      console.log(`   Main account balance: $${accountBalances.find(b => b.address === walletAddress)?.freeCollateral.toFixed(2) || '0'}`);
      console.log(`   Sub-account balance: $${accountBalances.find(b => b.address === vaultAddress)?.freeCollateral.toFixed(2) || '0'}`);
      console.log('');
      console.log('   💡 SOLUTION:');
      if (vaultAddress && otherAccountBalance.address === walletAddress) {
        console.log('      Funds are in MAIN account, but order targets SUB-ACCOUNT.');
        console.log('      Set vaultAddress: null to use main account');
      } else if (!vaultAddress && otherAccountBalance.address === vaultAddress) {
        console.log('      Funds are in SUB-ACCOUNT, but order targets MAIN account.');
        console.log(`      Set vaultAddress: '${vaultAddress}' to use sub-account`);
      }
      console.log('');
    }
  }
  
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // CHECK ASSET IDs FROM INFO ENDPOINT (Official Spec)
  // ═══════════════════════════════════════════════════════════
  // Per docs:
  // - Perp: index in meta.universe (e.g., BTC = 0)
  // - Spot: 10000 + index in spotMeta.universe (e.g., PURR/USDC = 10000 + 0 = 10000)
  // - Builder perps: 100000 + perp_dex_index * 10000 + index_in_meta
  
  console.log('🔍 Checking Asset IDs from Info Endpoint...');
  console.log('─'.repeat(60));
  
  // Get perp meta
  const perpMeta = await infoClient.meta();
  const perpIndex = perpMeta.universe?.findIndex((a: any) => a.name === ORDER_CONFIG.coin);
  const perpAsset = perpIndex !== undefined && perpIndex >= 0 ? perpMeta.universe[perpIndex] : null;
  const perpAssetId = perpIndex !== undefined && perpIndex >= 0 ? perpIndex : undefined;
  
  // Get spot meta
  let spotAsset: any = null;
  let spotAssetId: number | undefined = undefined;
  let spotIndex: number | undefined = undefined;
  let spotMeta: any = null;
  try {
    spotMeta = await infoClient.spotMeta();
    
    // First, try exact match
    spotIndex = spotMeta.universe?.findIndex((a: any) => {
      const name = a.name || '';
      return name === ORDER_CONFIG.coin;
    });
    
    // If not found, try partial match (e.g., "ETH" in "ETH/USDC" or vice versa)
    if (spotIndex === undefined || spotIndex < 0) {
      spotIndex = spotMeta.universe?.findIndex((a: any) => {
        const name = a.name || '';
        const coinBase = ORDER_CONFIG.coin.split('/')[0].split('-')[0]; // Get base (e.g., "ETH" from "ETH/USDC")
        return name.includes(coinBase) || coinBase.includes(name.split('/')[0].split('-')[0]);
      });
    }
    
    if (spotIndex !== undefined && spotIndex >= 0) {
      spotAsset = spotMeta.universe[spotIndex];
      spotAssetId = 10000 + spotIndex; // Official formula: 10000 + index
    } else {
      // List available spot pairs for debugging
      const availablePairs = spotMeta.universe?.slice(0, 20).map((a: any, idx: number) => {
        const id = 10000 + idx;
        return `${a.name || '@' + idx} (ID: ${id})`;
      }).join(', ') || 'none';
      console.log(`   Available spot pairs (first 20): ${availablePairs}`);
      if (spotMeta.universe && spotMeta.universe.length > 20) {
        console.log(`   ... and ${spotMeta.universe.length - 20} more`);
      }
    }
  } catch (error) {
    // Spot meta might not be available, that's OK
  }
  
  console.log(`Asset Name: "${ORDER_CONFIG.coin}"`);
  console.log('');
  
  if (perpAssetId !== undefined) {
    console.log(`✅ PERP Asset Found:`);
    console.log(`   Asset ID: ${perpAssetId} (index ${perpIndex} in meta.universe)`);
    console.log(`   Name: ${perpAsset?.name || ORDER_CONFIG.coin}`);
  } else {
    console.log(`❌ PERP Asset: NOT FOUND`);
  }
  
  if (spotAssetId !== undefined && spotIndex !== undefined) {
    console.log(`✅ SPOT Asset Found:`);
    console.log(`   Asset ID: ${spotAssetId} (10000 + index ${spotIndex} in spotMeta.universe)`);
    console.log(`   Name: ${spotAsset?.name || ORDER_CONFIG.coin}`);
    console.log(`   Formula: 10000 + ${spotIndex} = ${spotAssetId}`);
  } else {
    console.log(`❌ SPOT Asset: NOT FOUND`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // PREPARE ORDER
  // ═══════════════════════════════════════════════════════════

  // Determine if we want spot or perp
  // Spot orders: coin name includes "-SPOT", "/", or starts with "@" (e.g., "ETH/USDC", "HYPE-SPOT", "@107")
  // Perp orders: just the coin name (e.g., "ETH", "BTC")
  // Priority: If we found a spot asset, use it. Otherwise, try perp.
  const isSpotOrderByName = ORDER_CONFIG.coin.includes('-SPOT') || ORDER_CONFIG.coin.includes('/') || ORDER_CONFIG.coin.startsWith('@');
  const hasSpotAsset = spotAssetId !== undefined;
  const hasPerpAsset = perpAssetId !== undefined;
  
  let assetId: number;
  let marketType: string;
  
  // Use spot if: explicitly named as spot OR we found a spot asset (and no explicit perp preference)
  if (isSpotOrderByName || (hasSpotAsset && !hasPerpAsset)) {
    // Spot order - use spot asset ID (10000 + index)
    if (!spotAssetId) {
      console.log(`\n⚠️  Spot asset "${ORDER_CONFIG.coin}" not found.`);
      console.log(`   Available spot pairs shown above.`);
      console.log(`   Trying PURR/USDC as fallback...\n`);
      
      // Try PURR/USDC as fallback
      const fallbackIndex = spotMeta?.universe?.findIndex((a: any) => a.name === 'PURR/USDC');
      if (fallbackIndex !== undefined && fallbackIndex >= 0) {
        spotAssetId = 10000 + fallbackIndex;
        spotIndex = fallbackIndex;
        spotAsset = spotMeta.universe[fallbackIndex];
        console.log(`✅ Using fallback: PURR/USDC (Asset ID: ${spotAssetId})`);
      } else {
        throw new Error(`Spot asset ID not found for "${ORDER_CONFIG.coin}". Available pairs shown above. Try using one of them (e.g., "PURR/USDC")`);
      }
    }
    assetId = spotAssetId!; // We know it's defined because we checked above
    marketType = 'SPOT';
    console.log(`📋 Using SPOT Asset ID: ${assetId}`);
    console.log(`   Asset: ${spotAsset?.name || ORDER_CONFIG.coin}`);
    console.log(`   Formula: 10000 + ${spotIndex} = ${assetId}`);
  } else {
    // Perp order - use perp asset ID (just the index)
    if (perpAssetId === undefined) {
      throw new Error(`Perp asset ID not found for "${ORDER_CONFIG.coin}". If you want to place a spot order, use a spot pair name (e.g., "ETH/USDC" or "@107")`);
    }
    assetId = perpAssetId;
    marketType = 'PERP';
    console.log(`📋 Using PERP Asset ID: ${assetId}`);
    console.log(`   Index in meta.universe: ${perpIndex}`);
  }
  console.log('');

  // Fetch current market price and use it for the order
  let currentMarketPrice: number | null = null;
  try {
    const allMids = await infoClient.allMids();
    currentMarketPrice = parseFloat(allMids[ORDER_CONFIG.coin] || '0');
    if (currentMarketPrice > 0) {
      console.log(`📊 Current Market Price: $${currentMarketPrice}`);
      console.log(`   Your Configured Limit Price: $${ORDER_CONFIG.limitPrice}`);
      
      // For IOC orders, use the exact market price to ensure execution
      // For buy orders, use market price (or slightly above for aggressive fills)
      // For sell orders, use market price (or slightly below for aggressive fills)
      if (ORDER_CONFIG.timeInForce === 'Ioc') {
        // IOC orders: round market price to tick size (0.01) to avoid validation errors
        // Round to nearest 0.01 (2 decimal places) for spot orders
        const roundedPrice = Math.round(currentMarketPrice * 100) / 100;
        ORDER_CONFIG.limitPrice = roundedPrice;
        console.log(`   ✅ IOC Order: Using market price rounded to tick size: $${ORDER_CONFIG.limitPrice} (from $${currentMarketPrice})`);
      } else {
        // For GTC/ALO orders, allow some deviation but keep it close
        if (ORDER_CONFIG.isBuy) {
          // Buy: use market price or slightly above (max 0.5% above)
          const maxPrice = currentMarketPrice * 1.005;
          if (ORDER_CONFIG.limitPrice > maxPrice || ORDER_CONFIG.limitPrice < currentMarketPrice * 0.95) {
            ORDER_CONFIG.limitPrice = parseFloat(currentMarketPrice.toFixed(4));
            console.log(`   ⚠️  Adjusting buy limit price to market price $${ORDER_CONFIG.limitPrice}`);
          }
        } else {
          // Sell: use market price or slightly below (max 0.5% below)
          const minPrice = currentMarketPrice * 0.995;
          if (ORDER_CONFIG.limitPrice < minPrice || ORDER_CONFIG.limitPrice > currentMarketPrice * 1.05) {
            ORDER_CONFIG.limitPrice = parseFloat(currentMarketPrice.toFixed(4));
            console.log(`   ⚠️  Adjusting sell limit price to market price $${ORDER_CONFIG.limitPrice}`);
          }
        }
      }
      console.log(`   ✅ Final Limit Price: $${ORDER_CONFIG.limitPrice}\n`);
    } else {
      console.log(`   ⚠️  Market price not available, using configured price $${ORDER_CONFIG.limitPrice}\n`);
    }
  } catch (error) {
    console.log(`   ⚠️  Could not fetch market price: ${error}, using configured limit price $${ORDER_CONFIG.limitPrice}\n`);
  }

  // Get szDecimals and price decimals
  let szDecimals: number;
  let priceDecimals: number;
  
  if (marketType === 'SPOT' && spotAsset) {
    // For spot assets, check the spot asset metadata
    // Spot assets have szDecimals for size and potentially different decimals for price
    szDecimals = symbolConverter.getSzDecimals(ORDER_CONFIG.coin) || 
                 (spotAsset as any).szDecimals || 
                 8; // Default fallback
    
    // For spot orders, price decimals might be in the asset metadata
    // USDC pairs typically use fewer decimals for price (e.g., 2-6)
    // Check spot asset metadata for price decimals
    priceDecimals = (spotAsset as any).pxDecimals || 
                    (spotAsset as any).priceDecimals || 
                    6; // Default to 6 decimals for USDC pairs
    
    console.log(`   szDecimals: ${szDecimals}`);
    console.log(`   priceDecimals: ${priceDecimals}`);
    console.log(`   Spot asset metadata:`, JSON.stringify(spotAsset, null, 2));
    
    // Check if we need to get decimals from the token metadata
    // Spot assets have tokens array [baseTokenId, quoteTokenId]
    if (spotAsset.tokens && Array.isArray(spotAsset.tokens)) {
      console.log(`   Base token ID: ${spotAsset.tokens[0]}`);
      console.log(`   Quote token ID: ${spotAsset.tokens[1]}`);
      console.log(`   (Quote is typically USDC=0, which has 6 decimals)`);
    }
  } else {
    szDecimals = symbolConverter.getSzDecimals(ORDER_CONFIG.coin) || 4; // Default for perp
    priceDecimals = szDecimals; // For perp, price decimals usually match size decimals
    console.log(`   szDecimals: ${szDecimals}`);
  }
  
  if (szDecimals === undefined) {
    throw new Error(`Could not find szDecimals for "${ORDER_CONFIG.coin}"`);
  }
  
  // Use hardcoded values from actionInput to ensure consistency
  // These values are set in actionInput below - update them there if you want to change the order
  const HARDCODED_VALUES = {
    assetId: 159,
    isBuy: false,
    price: "34.618",
    reduceOnly: false,
    size: "0.4",
    timeInForce: "Gtc" as const,
  };
  
  // Override calculated values with hardcoded ones
  assetId = HARDCODED_VALUES.assetId;
  const formattedSize = HARDCODED_VALUES.size;
  let formattedPrice = HARDCODED_VALUES.price; // Use let instead of const since we might modify it
  ORDER_CONFIG.isBuy = HARDCODED_VALUES.isBuy;
  ORDER_CONFIG.reduceOnly = HARDCODED_VALUES.reduceOnly;
  // @ts-ignore - Override timeInForce type to allow FrontendMarket
  ORDER_CONFIG.timeInForce = HARDCODED_VALUES.timeInForce;
  
  // Ensure price has proper precision and is divisible by tick size
  // For spot orders, tick size is typically 0.01 (2 decimal places)
  // Round to nearest tick size to avoid "Price must be divisible by tick size" error
  if (marketType === 'SPOT') {
    const priceNum = parseFloat(ORDER_CONFIG.limitPrice.toString());
    // Round to 2 decimal places (0.01 tick size) for spot orders
    const roundedPrice = Math.round(priceNum * 100) / 100;
    formattedPrice = roundedPrice.toFixed(2);
    console.log(`   ⚠️  Rounded price from $${priceNum} to $${formattedPrice} (tick size: 0.01)`);
  }
  
  // Check if formatted size is zero
  if (parseFloat(formattedSize) === 0) {
    console.log(`\n⚠️  WARNING: Formatted size is zero!`);
    console.log(`   Original size: ${ORDER_CONFIG.size}`);
    console.log(`   Formatted size: "${formattedSize}"`);
    console.log(`   szDecimals: ${szDecimals}`);
    console.log(`   This might be too small for this asset. Try a larger size.\n`);
  }
  
  // Check if formatted price is zero
  if (parseFloat(formattedPrice) === 0 && ORDER_CONFIG.limitPrice > 0) {
    console.log(`\n⚠️  WARNING: Formatted price is zero!`);
    console.log(`   Original price: ${ORDER_CONFIG.limitPrice}`);
    console.log(`   Formatted price: "${formattedPrice}"`);
    console.log(`   priceDecimals: ${priceDecimals}`);
    console.log(`   Try using a different priceDecimals value (e.g., 2, 4, 6, or 8)\n`);
    
    // Try with different price decimals
    for (const testDecimals of [2, 4, 6, 8]) {
      const testPrice = formatPrice(ORDER_CONFIG.limitPrice.toString(), testDecimals, false);
      console.log(`   Test with ${testDecimals} decimals: "${testPrice}"`);
      if (parseFloat(testPrice) > 0) {
        console.log(`   ✅ Use priceDecimals: ${testDecimals}`);
        priceDecimals = testDecimals;
        break;
      }
    }
    
    // Reformat with corrected decimals
    const correctedPrice = formatPrice(ORDER_CONFIG.limitPrice.toString(), priceDecimals, false);
    console.log(`   Corrected price: "${correctedPrice}"\n`);
  }

  // Calculate order value using ACTUAL formatted values (what HyperLiquid will see)
  const formattedSizeNum = parseFloat(formattedSize);
  const formattedPriceNum = parseFloat(formattedPrice);
  const actualOrderValue = formattedSizeNum * formattedPriceNum;
  
  console.log('📋 Order Details:');
  console.log('─'.repeat(60));
  console.log(`   Asset: ${ORDER_CONFIG.coin}`);
  console.log(`   Asset ID: ${assetId} (${marketType})`);
  console.log(`   Side: ${ORDER_CONFIG.isBuy ? 'BUY' : 'SELL'}`);
  console.log(`   Size: ${ORDER_CONFIG.size} -> "${formattedSize}" (parsed: ${formattedSizeNum})`);
  console.log(`   Price: $${ORDER_CONFIG.limitPrice} -> "${formattedPrice}" (parsed: $${formattedPriceNum})`);
  console.log(`   Order Value: ${formattedSizeNum} × ${formattedPriceNum} = $${actualOrderValue.toFixed(2)}`);
  console.log(`   Time in Force: ${ORDER_CONFIG.timeInForce}`);
  console.log('');
  
  if (marketType === 'SPOT') {
    console.log('   ℹ️  SPOT ORDER: Requires USDC balance in spot wallet');
    console.log('   ℹ️  Margin checks are for perp orders, not spot');
    if (actualOrderValue < 10) {
      console.log(`\n   ⚠️  WARNING: Order value ($${actualOrderValue.toFixed(2)}) is below $10 minimum!`);
      console.log(`   Minimum order value: $10 USDC`);
      console.log(`   Current order value: $${actualOrderValue.toFixed(2)}`);
      const minSize = Math.ceil(10 / formattedPriceNum);
      console.log(`   Increase size to at least: ${minSize} tokens (at price $${formattedPriceNum})`);
      console.log(`   Or increase price to at least: $${(10 / formattedSizeNum).toFixed(2)} (at size ${formattedSizeNum})\n`);
    } else {
      console.log(`   ✅ Order value ($${actualOrderValue.toFixed(2)}) meets $10 minimum`);
    }
  } else {
    console.log('   ℹ️  PERP ORDER: Requires margin in perp account');
  }
  console.log('');

  // Build action using parser (ensures correct format for signing)
  // CRITICAL: Use the SAME values for both signing and request body!
  // These are the hardcoded values - update them here to change the order
  const actionInput = {
    type: 'order' as const,
    orders: [{
      a: HARDCODED_VALUES.assetId, // Uses hardcoded value from above (159)
      b: HARDCODED_VALUES.isBuy, // Uses hardcoded value from above (false)
      p: HARDCODED_VALUES.price, // Uses hardcoded value from above ("34.618")
      r: HARDCODED_VALUES.reduceOnly, // Uses hardcoded value from above (false)
      s: HARDCODED_VALUES.size, // Uses hardcoded value from above ("0.4")
      t: { limit: { tif: HARDCODED_VALUES.timeInForce } }, // Uses hardcoded value from above ("FrontendMarket")
    }],
    grouping: 'na' as const,
  };

  // Parse action to ensure correct format
  const action = parser(OrderRequest.entries.action)(actionInput);

  // Generate nonce (current timestamp in milliseconds as per API spec)
  const nonce = Date.now();
  const expiresAfter = Date.now() + 10000; // Optional: 10 seconds in the future

  console.log('🔐 Signing...');
  console.log(`   Nonce: ${nonce}`);
  console.log(`   Expires After: ${expiresAfter}`);
  console.log('');

  // Sign using SDK's signL1Action
  // IMPORTANT: When using sub-accounts, you sign with the master account
  // but the vaultAddress field tells HyperLiquid which account to execute on
  const signature = await signL1Action({
    wallet: wallet, // Master account signs
    action,
    nonce,
    isTestnet: false,
    expiresAfter,
    vaultAddress: vaultAddress || undefined, // Sub-account address (if using sub-account)
  });

  // Verify signature by checking the wallet's public key
  console.log('🔍 Verifying Signature...');
  try {
    // Get the wallet's public key and derive address
    const publicKey = wallet.signingKey.publicKey;
    const addressFromPublicKey = ethers.computeAddress(publicKey);
    
    console.log(`   Signature Components:`);
    console.log(`      r: ${signature.r}`);
    console.log(`      s: ${signature.s}`);
    console.log(`      v: ${signature.v}`);
    console.log(`   Wallet Address: ${walletAddress}`);
    console.log(`   Address from Public Key: ${addressFromPublicKey}`);
    
    if (addressFromPublicKey.toLowerCase() === walletAddress.toLowerCase()) {
      console.log(`   ✅ Signature verification: Wallet address matches public key!`);
      console.log(`   ✅ The signature was generated by the correct wallet.`);
    } else {
      console.log(`   ❌ ERROR: Address mismatch!`);
      console.log(`      Expected: ${walletAddress}`);
      console.log(`      Got: ${addressFromPublicKey}`);
      console.log(`   ⚠️  This indicates the signature may be invalid!`);
    }
  } catch (error: any) {
    console.log(`   ⚠️  Could not verify signature: ${error.message}`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // BUILD REQUEST (Official API Spec)
  // ═══════════════════════════════════════════════════════════

  // CRITICAL: Use the SAME action that was signed!
  // The request body must match exactly what was signed, otherwise signature validation fails
  const requestBody: any = {
    action: actionInput, // Use the SAME actionInput that was signed
    nonce,
    signature: {
      r: signature.r,
      s: signature.s,
      v: signature.v,
    },
    expiresAfter,
  };
  
  // Set vaultAddress - CRITICAL for sub-accounts!
  // Per Discord thread: "to perform actions on behalf of a subaccount or vault
  // signing should be done by the master account and the vaultAddress field 
  // should be set to the address of the subaccount or vault"
  if (vaultAddress) {
    requestBody.vaultAddress = vaultAddress;
  } else {
    requestBody.vaultAddress = null;
  }

  console.log('📤 RAW REQUEST PAYLOAD:');
  console.log('─'.repeat(60));
  console.log(JSON.stringify(requestBody, null, 2));
  console.log('');
  console.log('🔍 Key Fields:');
  console.log(`   Signer (wallet): ${walletAddress}`);
  console.log(`   vaultAddress: ${requestBody.vaultAddress || 'null (main account)'}`);
  console.log(`   → Order will execute on: ${requestBody.vaultAddress || walletAddress}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════
  // SEND REQUEST (Official API Endpoint)
  // ═══════════════════════════════════════════════════════════

  const API_URL = 'https://api.hyperliquid.xyz/exchange';
  
  try {
    console.log(`📡 Sending to: ${API_URL}`);
    console.log('─'.repeat(60));
    console.log('');

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const result = await response.json();

    console.log('📥 RESPONSE:');
    console.log('─'.repeat(60));
    console.log(JSON.stringify(result, null, 2));
    console.log('');

    // Parse response
    if (result.status === 'ok' && result.response?.data?.statuses?.[0]) {
      const status = result.response.data.statuses[0];
      
      if ('filled' in status && status.filled) {
        console.log('✅ ORDER FILLED!');
        console.log(`   Filled Size: ${status.filled.totalSz}`);
        if (status.filled.avgPx) {
          console.log(`   Average Price: $${status.filled.avgPx}`);
        }
        if (status.filled.oid) {
          console.log(`   Order ID: ${status.filled.oid}`);
        }
      } else if ('resting' in status && status.resting) {
        console.log('⏳ ORDER RESTING (waiting to be filled)');
        console.log(`   Order ID: ${status.resting.oid}`);
      } else if ('error' in status && status.error) {
        console.log('❌ ORDER ERROR:');
        const errorMsg = typeof status.error === 'string' ? status.error : JSON.stringify(status.error);
        console.log(`   ${errorMsg}`);
      }
    } else {
      console.log('⚠️  Unexpected response format');
    }

  } catch (error: any) {
    console.error('❌ REQUEST FAILED:');
    console.error(`   ${error.message}`);
    
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    
    process.exit(1);
  }

  console.log('\n✅ Done!');
}

main().catch((error) => {
  console.error('\n💥 Fatal error:', error);
  process.exit(1);
});
