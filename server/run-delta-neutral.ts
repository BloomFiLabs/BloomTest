/**
 * Run Delta-Neutral Funding Strategy - EOA Keeper Version
 * 
 * NEW ARCHITECTURE (EOA Keeper):
 * 1. Contract receives USDC deposits
 * 2. Contract swaps USDC -> HYPE on HyperSwap V3
 * 3. Contract sends native HYPE to keeper EOA
 * 4. Keeper bridges HYPE to its own HyperCore account
 * 5. Keeper trades via HyperLiquid API (spot + perps)
 * 
 * This bypasses the CoreWriter limitation where smart contracts
 * cannot place orders on HyperCore.
 */

import { ethers } from 'ethers';
import { Hyperliquid } from 'hyperliquid';
import * as dotenv from 'dotenv';

dotenv.config();

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════

const CONFIG = {
  // Contract addresses - DEPLOYED Nov 26, 2024
  strategyAddress: '0x68b766f6944403b9cf7993764f3bd016c76ce49c', // DeltaNeutralStrategyLite
  vaultAddress: '0x319673bb860adb353d7384c56241021ec948c438',   // BloomStrategyVault
  usdcAddress: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
  
  // System addresses
  hypeBridgeAddress: '0x2222222222222222222222222222222222222222',
  whypeAddress: '0x5555555555555555555555555555555555555555',
  
  // HyperSwap V3
  defaultPoolFee: 3000, // 0.3% fee tier
  bridgeSlippageBps: 100, // 1% max slippage
  
  // Trading parameters
  minOrderValue: 10, // HyperLiquid minimum ~$10
  maxPositionSizeUSD: 100,
  
  // Funding parameters
  minFundingRateAPY: 0, // Set to 0 for testing (normally 5)
  minNetCarryAPY: -10,  // Set low for testing (normally 3)
  borrowAPY: 3.61,      // HyperLend UETH borrow rate
  
  // Execution
  intervalSeconds: 60,
};

// ═══════════════════════════════════════════════════════════
// ABIS
// ═══════════════════════════════════════════════════════════

const STRATEGY_ABI = [
  // View functions
  'function getUsdcBal() external view returns (uint256)',
  'function getHypeBal() external view returns (uint256)',
  'function totalPrincipal() external view returns (uint256)',
  'function keeperAddress() external view returns (address)',
  'function getKeeperAddress() external view returns (address)',
  
  // New keeper functions
  'function swapAndSendToKeeper(uint256 usdcAmt, uint256 minHype, uint24 fee) external',
  'function sendHypeToKeeper(uint256 amount) external',
  
  // Legacy (kept for future use)
  'function swapAndBridge(uint256 usdcAmt, uint256 minHype, uint24 fee) external',
];

// ═══════════════════════════════════════════════════════════
// HYPERLIQUID SDK CLIENT
// ═══════════════════════════════════════════════════════════

let hlClient: Hyperliquid | null = null;

async function getHLClient(privateKey: string, walletAddress: string): Promise<Hyperliquid> {
  if (!hlClient) {
    hlClient = new Hyperliquid({
      privateKey: privateKey,
      walletAddress: walletAddress, // Must explicitly set wallet address
      testnet: false,
      enableWs: false, // Disable WebSocket for simplicity
    });
    
    // Manually refresh asset maps to ensure they're loaded
    console.log('   Loading asset maps...');
    await hlClient.refreshAssetMapsNow();
    
    // PATCH: Manually register HYPE for spot trading
    try {
      // @ts-ignore
      const sc = hlClient.symbolConversion;
      if (sc) {
        console.log('   🔧 Patching SDK asset maps for HYPE...');
        // @ts-ignore
        if (sc.exchangeToInternalNameMap) {
          // @ts-ignore
          sc.exchangeToInternalNameMap['HYPE-SPOT'] = 'HYPE';
          // @ts-ignore
          sc.exchangeToInternalNameMap['HYPE'] = 'HYPE';
        }
        // @ts-ignore
        if (sc.assetToIndexMap) {
          // @ts-ignore
          sc.assetToIndexMap['HYPE'] = 10107; // 10000 + 107 (HYPE/USDC pair index)
        }
      }
    } catch (e) {
      console.log('   ⚠️ Patch failed:', e);
    }
    
    console.log('   Asset maps loaded!');
  }
  return hlClient;
}

// ═══════════════════════════════════════════════════════════
// HYPERLIQUID API HELPERS
// ═══════════════════════════════════════════════════════════

async function getHyperLiquidData(asset: string): Promise<{ rate: number; predicted: number; markPrice: number }> {
  try {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    const data = await response.json();
    
    const meta = data[0]?.universe || [];
    const assetIndex = meta.findIndex((m: any) => m.name === asset);
    
    if (assetIndex === -1) return { rate: 0, predicted: 0, markPrice: 0 };
    
    const assetCtx = data[1]?.[assetIndex];
    if (!assetCtx) return { rate: 0, predicted: 0, markPrice: 0 };
    
    return {
      rate: parseFloat(assetCtx.funding) || 0,
      predicted: parseFloat(assetCtx.premium) || 0,
      markPrice: parseFloat(assetCtx.markPx) || 0,
    };
  } catch (error) {
    console.error('Failed to fetch HyperLiquid data:', error);
    return { rate: 0, predicted: 0, markPrice: 0 };
  }
}

async function getHYPEPrice(): Promise<number> {
  try {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'allMids' }),
    });
    const data = await response.json();
    return parseFloat(data['HYPE']) || 30;
  } catch (error) {
    console.error('Failed to fetch HYPE price:', error);
    return 30;
  }
}

async function getHyperCoreSpotBalances(address: string): Promise<{coin: string, total: string, hold: string}[]> {
  try {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotClearinghouseState', user: address }),
    });
    const data = await response.json();
    return data.balances || [];
  } catch (error) {
    console.error('Failed to fetch spot balances:', error);
    return [];
  }
}

async function getKeeperHyperCoreState(address: string) {
  try {
    const [spotBalances, perpState] = await Promise.all([
      getHyperCoreSpotBalances(address),
      fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: address }),
      }).then(r => r.json()),
    ]);
    
    // Extract perp positions
    const positions = perpState?.assetPositions?.map((p: any) => ({
      coin: p.position.coin,
      size: parseFloat(p.position.szi),
      entryPx: parseFloat(p.position.entryPx),
      unrealizedPnl: parseFloat(p.position.unrealizedPnl),
      leverage: parseFloat(p.position.leverage?.value || '1'),
    })) || [];
    
    return {
      spotBalances,
      perpEquity: parseFloat(perpState?.marginSummary?.accountValue || '0'),
      perpPositions: positions,
      withdrawable: parseFloat(perpState?.withdrawable || '0'),
    };
  } catch (error) {
    console.error('Failed to fetch keeper state:', error);
    return { spotBalances: [], perpEquity: 0, perpPositions: [], withdrawable: 0 };
  }
}

// ═══════════════════════════════════════════════════════════
// KEEPER BRIDGE FUNCTION
// ═══════════════════════════════════════════════════════════

async function bridgeHypeToHyperCore(wallet: ethers.Wallet, amount: bigint): Promise<boolean> {
  try {
    console.log(`   📤 Bridging ${ethers.formatEther(amount)} HYPE to HyperCore...`);
    
    const tx = await wallet.sendTransaction({
      to: CONFIG.hypeBridgeAddress,
      value: amount,
    });
    
    console.log(`   ⏳ Tx: ${tx.hash}`);
    await tx.wait();
    console.log(`   ✅ Bridge tx confirmed!`);
    
    // Wait for HyperCore to process
    await new Promise(resolve => setTimeout(resolve, 5000));
    return true;
  } catch (error: any) {
    console.error(`   ❌ Bridge failed: ${error.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// HYPERLIQUID INTERNAL TRANSFERS
// ═══════════════════════════════════════════════════════════

/**
 * Transfer USDC from spot to perp margin (required before trading perps)
 */
async function transferToPerp(hl: Hyperliquid, usdcAmount: number): Promise<boolean> {
  try {
    console.log(`   📤 Transferring $${usdcAmount.toFixed(2)} USDC from spot to perp margin...`);
    
    const result = await hl.exchange.transferBetweenSpotAndPerp(usdcAmount, true); // true = spot to perp
    console.log(`   📝 Transfer result:`, JSON.stringify(result, null, 2));
    
    if (result.status === 'ok') {
      console.log(`   ✅ Transfer successful!`);
      return true;
    }
    return false;
  } catch (error: any) {
    console.error(`   ❌ Transfer failed: ${error.message}`);
    return false;
  }
}

/**
 * Place a raw spot order bypassing SDK scaling
 */
async function placeSpotOrderRaw(
  hl: Hyperliquid,
  assetId: number,
  isBuy: boolean,
  size: number,
  price: number
): Promise<{ success: boolean; error?: string }> {
  try {
    // HACK: SDK likely uses 18 decimals for unknown HYPE asset.
    // HYPE has 8 decimals on wire.
    // We divide by 10^10 so when SDK multiplies by 10^18, we get correct 10^8 scaled value.
    
    // Use 98% of balance to avoid rounding issues where SDK rounds up 1 wei
    const safeSize = size * 0.98;
    
    // Use string with fixed precision to avoid float errors
    const hackSize = (safeSize / 1e10).toFixed(20);
    
    console.log(`   📊 Placing hacked order: ${size} -> ${safeSize} -> ${hackSize} HYPE @ ${price}`);
    
    // We use 'HYPE-SPOT' which we patched in the map to point to internal name 'HYPE' -> asset 10107
    const result = await hl.exchange.placeOrder({
      coin: 'HYPE-SPOT', 
      is_buy: isBuy,
      sz: hackSize,
      limit_px: price,
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: false,
    });
    
    console.log(`   📝 Order result:`, JSON.stringify(result, null, 2));
    
    if (result.response?.type === 'order' && result.response?.data?.statuses) {
      const status = result.response.data.statuses[0];
      if (status?.filled) {
        console.log(`   ✅ Raw Order filled! Size: ${status.filled.totalSz}`);
        return { success: true };
      } else if (status?.error) {
        return { success: false, error: status.error };
      }
    }
    return { success: false, error: 'Unknown response' };
  } catch (error: any) {
    console.error(`   ❌ Raw order failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Sell spot asset for USDC using HyperLiquid SDK
 * This is needed to convert HYPE to USDC for perp margin
 */
async function sellSpotForUSDC(
  hl: Hyperliquid,
  coin: string,
  size: number,
  price: number
): Promise<{ success: boolean; error?: string }> {
  // Use raw order for HYPE to avoid SDK decimal issues
  if (coin.includes('HYPE')) {
    // HYPE asset ID is 10107
    return placeSpotOrderRaw(hl, 10107, false, size, price);
  }

  try {
    // SDK uses "HYPE-SPOT" format
    const spotCoin = coin.includes('-SPOT') ? coin : `${coin}-SPOT`;
    // Round size to 2 decimals for HYPE
    const roundedSize = Math.floor(size * 100) / 100;
    // Round price to 2 decimals
    const roundedPrice = Math.floor(price * 100) / 100;
    
    console.log(`   📊 Selling ${roundedSize} ${spotCoin} @ $${roundedPrice.toFixed(2)}...`);
    
    const result = await hl.exchange.placeOrder({
      coin: spotCoin,
      is_buy: false,
      sz: roundedSize,
      limit_px: roundedPrice,
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: false,
    });
    
    console.log(`   📝 Order result:`, JSON.stringify(result, null, 2));
    
    if (result.response?.type === 'order' && result.response?.data?.statuses) {
      const status = result.response.data.statuses[0];
      if (status?.filled) {
        console.log(`   ✅ Sold! Size: ${status.filled.totalSz}`);
        return { success: true };
      } else if (status?.error) {
        return { success: false, error: status.error };
      }
    }
    return { success: false, error: 'Unknown response' };
  } catch (error: any) {
    console.error(`   ❌ Sell failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════
// HYPERLIQUID EXCHANGE API TRADING
// ═══════════════════════════════════════════════════════════

/**
 * Place a spot order using HyperLiquid SDK
 * Note: SDK uses "HYPE-SPOT" format for spot assets
 */
async function placeSpotOrder(
  hl: Hyperliquid,
  coin: string,
  isBuy: boolean,
  size: number,
  limitPrice: number
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    // SDK uses "HYPE-SPOT" format for spot
    const spotCoin = coin.includes('-SPOT') ? coin : `${coin}-SPOT`;
    console.log(`   📊 Placing spot ${isBuy ? 'BUY' : 'SELL'} ${size.toFixed(4)} ${spotCoin} @ $${limitPrice.toFixed(2)}...`);
    
    const result = await hl.exchange.placeOrder({
      coin: spotCoin,
      is_buy: isBuy,
      sz: size,
      limit_px: limitPrice,
      order_type: { limit: { tif: 'Ioc' } }, // Immediate-or-Cancel
      reduce_only: false,
    });
    
    console.log(`   📝 Order result:`, JSON.stringify(result, null, 2));
    
    if (result.response?.type === 'order' && result.response?.data?.statuses) {
      const status = result.response.data.statuses[0];
      if (status?.filled) {
        console.log(`   ✅ Order filled! Size: ${status.filled.totalSz}`);
        return { success: true, orderId: status.filled.oid?.toString() };
      } else if (status?.resting) {
        console.log(`   ⏳ Order resting (partial fill or waiting)`);
        return { success: true, orderId: status.resting.oid?.toString() };
      } else if (status?.error) {
        console.log(`   ❌ Order error: ${status.error}`);
        return { success: false, error: status.error };
      }
    }
    
    return { success: false, error: 'Unknown response format' };
  } catch (error: any) {
    console.error(`   ❌ Spot order failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Place a perp order using HyperLiquid SDK
 * Note: SDK uses "ETH-PERP" format, not "ETH"
 */
async function placePerpOrder(
  hl: Hyperliquid,
  coin: string,
  isLong: boolean,
  size: number,
  limitPrice: number,
  reduceOnly: boolean = false
): Promise<{ success: boolean; orderId?: string; error?: string }> {
  try {
    // SDK uses "ETH-PERP" format
    const perpCoin = coin.includes('-PERP') ? coin : `${coin}-PERP`;
    const side = isLong ? 'LONG' : 'SHORT';
    console.log(`   📊 Placing perp ${side} ${size.toFixed(4)} ${perpCoin} @ $${limitPrice.toFixed(2)}...`);
    
    const result = await hl.exchange.placeOrder({
      coin: perpCoin,
      is_buy: isLong,
      sz: size,
      limit_px: limitPrice,
      order_type: { limit: { tif: 'Ioc' } }, // Immediate-or-Cancel
      reduce_only: reduceOnly,
    });
    
    console.log(`   📝 Order result:`, JSON.stringify(result, null, 2));
    
    if (result.response?.type === 'order' && result.response?.data?.statuses) {
      const status = result.response.data.statuses[0];
      if (status?.filled) {
        console.log(`   ✅ Order filled! Size: ${status.filled.totalSz}`);
        return { success: true, orderId: status.filled.oid?.toString() };
      } else if (status?.resting) {
        console.log(`   ⏳ Order resting`);
        return { success: true, orderId: status.resting.oid?.toString() };
      } else if (status?.error) {
        console.log(`   ❌ Order error: ${status.error}`);
        return { success: false, error: status.error };
      }
    }
    
    return { success: false, error: 'Unknown response format' };
  } catch (error: any) {
    console.error(`   ❌ Perp order failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Close all perp positions
 */
async function closeAllPerpPositions(hl: Hyperliquid, positions: any[]): Promise<boolean> {
  try {
    for (const pos of positions) {
      if (Math.abs(pos.size) < 0.0001) continue;
      
      const isLong = pos.size > 0;
      const closeSize = Math.abs(pos.size);
      
      // Use market price for immediate close
      // pos.coin is already in the format like "ETH" from the API
      const midPrice = await getHyperLiquidData(pos.coin).then(d => d.markPrice);
      const closePrice = isLong ? midPrice * 0.98 : midPrice * 1.02; // Aggressive price for IOC
      
      console.log(`   📤 Closing ${pos.coin}-PERP position: ${pos.size} @ ~$${closePrice.toFixed(2)}`);
      
      // placePerpOrder will add -PERP suffix
      await placePerpOrder(hl, pos.coin, !isLong, closeSize, closePrice, true);
    }
    return true;
  } catch (error: any) {
    console.error(`   ❌ Failed to close positions: ${error.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// POSITION STATE
// ═══════════════════════════════════════════════════════════

interface PositionState {
  isOpen: boolean;
  spotSizeETH: number;
  perpSizeETH: number;
  entryPrice: number;
  openedAt: Date | null;
}

let position: PositionState = {
  isOpen: false,
  spotSizeETH: 0,
  perpSizeETH: 0,
  entryPrice: 0,
  openedAt: null,
};

// ═══════════════════════════════════════════════════════════
// MAIN EXECUTION
// ═══════════════════════════════════════════════════════════

async function execute(
  contract: ethers.Contract,
  wallet: ethers.Wallet,
  provider: ethers.Provider,
  hl: Hyperliquid
) {
  console.log('\n' + '═'.repeat(70));
  console.log(`🔄 [${new Date().toISOString()}] Delta-Neutral Strategy (EOA Keeper)`);
  console.log('═'.repeat(70));

  try {
    // 1. Fetch market data
    const hlData = await getHyperLiquidData('ETH');
    const hypePrice = await getHYPEPrice();
    const markPrice = hlData.markPrice;

    // Funding APY calculation: rate * 3 * 365 * 100 (3 funding periods per day)
    const fundingAPY = hlData.rate * 3 * 365 * 100;
    const netCarryAPY = fundingAPY - CONFIG.borrowAPY;

    console.log(`\n📊 MARKET DATA:`);
    console.log(`   ETH Price:     $${markPrice.toFixed(2)}`);
    console.log(`   HYPE Price:    $${hypePrice.toFixed(2)}`);
    console.log(`   Funding Rate:  ${(hlData.rate * 100).toFixed(4)}%/8h (${fundingAPY.toFixed(1)}% APY)`);
    console.log(`   Net Carry:     ${netCarryAPY.toFixed(1)}% APY`);

    // 2. Fetch contract state
    const [contractUSDC, contractHYPE] = await Promise.all([
      contract.getUsdcBal().catch(() => BigInt(0)),
      contract.getHypeBal().catch(() => BigInt(0)),
    ]);

    const contractUSDCValue = Number(contractUSDC) / 1e6;
    const contractHYPEValue = Number(contractHYPE) / 1e18;

    console.log(`\n📊 CONTRACT STATE (EVM):`);
    console.log(`   USDC Balance:  $${contractUSDCValue.toFixed(2)}`);
    console.log(`   HYPE Balance:  ${contractHYPEValue.toFixed(4)} (~$${(contractHYPEValue * hypePrice).toFixed(2)})`);

    // 3. Fetch keeper state (EOA)
    const keeperAddress = wallet.address;
    const keeperEVMBalance = await provider.getBalance(keeperAddress);
    const keeperEVMHype = Number(keeperEVMBalance) / 1e18;
    
    const keeperCoreState = await getKeeperHyperCoreState(keeperAddress);
    const keeperCoreHype = keeperCoreState.spotBalances.find(b => b.coin === 'HYPE');
    const keeperCoreUsdc = keeperCoreState.spotBalances.find(b => b.coin === 'USDC');
    
    const keeperHypeOnCore = keeperCoreHype ? parseFloat(keeperCoreHype.total) : 0;
    const keeperUsdcOnCore = keeperCoreUsdc ? parseFloat(keeperCoreUsdc.total) : 0;

    console.log(`\n📊 KEEPER STATE (EOA: ${keeperAddress.slice(0, 10)}...):`);
    console.log(`   EVM HYPE:      ${keeperEVMHype.toFixed(4)} (~$${(keeperEVMHype * hypePrice).toFixed(2)})`);
    console.log(`   Core HYPE:     ${keeperHypeOnCore.toFixed(4)} (~$${(keeperHypeOnCore * hypePrice).toFixed(2)})`);
    console.log(`   Core USDC:     $${keeperUsdcOnCore.toFixed(2)}`);
    console.log(`   Perp Equity:   $${keeperCoreState.perpEquity.toFixed(2)}`);
    
    // Show existing perp positions
    if (keeperCoreState.perpPositions.length > 0) {
      console.log(`   Perp Positions:`);
      for (const pos of keeperCoreState.perpPositions) {
        if (Math.abs(pos.size) > 0.0001) {
          const side = pos.size > 0 ? 'LONG' : 'SHORT';
          console.log(`      ${pos.coin}: ${side} ${Math.abs(pos.size).toFixed(4)} @ $${pos.entryPx.toFixed(2)} (PnL: $${pos.unrealizedPnl.toFixed(2)})`);
        }
      }
    }

    // 4. Decision logic
    
    // STEP A: If contract has USDC, swap to HYPE and send to keeper
    if (contractUSDCValue > 1) {
      console.log(`\n🔄 STEP A: Transfer capital from contract to keeper`);
      
      const expectedHype = contractUSDCValue / hypePrice;
      const minHypeOut = expectedHype * (1 - CONFIG.bridgeSlippageBps / 10000);
      
      console.log(`   📤 Swapping $${contractUSDCValue.toFixed(2)} USDC -> HYPE and sending to keeper...`);
      
      const usdcAmount = ethers.parseUnits(contractUSDCValue.toFixed(6), 6);
      const minHypeWei = ethers.parseUnits(minHypeOut.toFixed(18), 18);
      
      const tx = await contract.swapAndSendToKeeper(usdcAmount, minHypeWei, CONFIG.defaultPoolFee);
      console.log(`   ⏳ Tx: ${tx.hash}`);
      await tx.wait();
      console.log(`   ✅ HYPE sent to keeper!`);
      
      // Wait and re-check keeper balance
      await new Promise(resolve => setTimeout(resolve, 3000));
      const newKeeperBalance = await provider.getBalance(keeperAddress);
      const newKeeperHype = Number(newKeeperBalance) / 1e18;
      console.log(`   💰 Keeper now has ${newKeeperHype.toFixed(4)} HYPE on EVM`);
      
      return; // Exit this cycle, next cycle will bridge
    }
    
    // STEP B: If keeper has HYPE on EVM, bridge to HyperCore
    if (keeperEVMHype > 0.01 && keeperEVMHype * hypePrice > 1) {
      console.log(`\n🔄 STEP B: Bridge keeper's HYPE to HyperCore`);
      
      // Keep some for gas
      const hypeToKeep = 0.01; // ~$0.30 for gas
      const hypeToBridge = keeperEVMHype - hypeToKeep;
      
      if (hypeToBridge > 0.01) {
        const bridgeAmount = ethers.parseEther(hypeToBridge.toFixed(18));
        await bridgeHypeToHyperCore(wallet, bridgeAmount);
        return; // Exit, next cycle will trade
      }
    }
    
    // STEP C: If keeper has capital on HyperCore, execute strategy
    const totalKeeperCapital = keeperHypeOnCore * hypePrice + keeperUsdcOnCore + keeperCoreState.perpEquity;
    
    // Check for existing perp positions (we might already be in a trade)
    const ethPerpPos = keeperCoreState.perpPositions.find(p => p.coin === 'ETH');
    const hasEthPosition = ethPerpPos && Math.abs(ethPerpPos.size) > 0.0001;
    
    if (hasEthPosition) {
      // We have an existing position - monitor it
      console.log(`\n📈 EXISTING POSITION:`);
      const side = ethPerpPos!.size > 0 ? 'LONG' : 'SHORT';
      console.log(`   ${ethPerpPos!.coin}: ${side} ${Math.abs(ethPerpPos!.size).toFixed(4)} ETH`);
      console.log(`   Entry: $${ethPerpPos!.entryPx.toFixed(2)}`);
      console.log(`   PnL: $${ethPerpPos!.unrealizedPnl.toFixed(2)}`);
      console.log(`   Net Carry APY: ${netCarryAPY.toFixed(1)}%`);

      // Check exit conditions
      if (netCarryAPY < 0) {
        console.log(`\n   ⚠️ Net carry went negative! Closing position...`);
        await closeAllPerpPositions(hl, keeperCoreState.perpPositions);
        position.isOpen = false;
      } else {
        console.log(`\n   ✅ HOLDING - Collecting funding payments`);
      }
      return;
    }
    
    if (totalKeeperCapital >= CONFIG.minOrderValue) {
      console.log(`\n🔄 STEP C: Execute trading strategy`);
      console.log(`   Total capital on HyperCore: $${totalKeeperCapital.toFixed(2)}`);
      
      // Check if funding rate is attractive
      if (fundingAPY < CONFIG.minFundingRateAPY) {
        console.log(`\n   ⏸️ WAIT: Funding APY ${fundingAPY.toFixed(1)}% below minimum ${CONFIG.minFundingRateAPY}%`);
        return;
      }

      if (netCarryAPY < CONFIG.minNetCarryAPY) {
        console.log(`\n   ⏸️ WAIT: Net carry ${netCarryAPY.toFixed(1)}% below minimum ${CONFIG.minNetCarryAPY}%`);
        return;
      }

      // Check if we need to convert HYPE to USDC for perp margin
      // HyperLiquid perps require USDC margin, not HYPE
      if (keeperHypeOnCore * hypePrice >= CONFIG.minOrderValue && keeperUsdcOnCore < CONFIG.minOrderValue) {
        console.log(`\n   📤 Converting HYPE to USDC for perp margin...`);
        console.log(`      HYPE balance: ${keeperHypeOnCore.toFixed(4)} (~$${(keeperHypeOnCore * hypePrice).toFixed(2)})`);
        
        // Sell HYPE for USDC at market
        const sellPrice = hypePrice * 0.98; // 2% slippage for IOC
        const sellResult = await sellSpotForUSDC(hl, 'HYPE', keeperHypeOnCore, sellPrice);
        
        if (sellResult.success) {
          console.log(`   ✅ HYPE sold for USDC!`);
          await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for settlement
        } else {
          console.log(`   ⚠️ HYPE sell failed: ${sellResult.error}`);
          console.log(`   Will retry next cycle...`);
        }
        return; // Next cycle will transfer to perp
      }
      
      // Check if we need to transfer USDC from spot to perp margin
      if (keeperUsdcOnCore >= CONFIG.minOrderValue && keeperCoreState.perpEquity < CONFIG.minOrderValue) {
        console.log(`\n   📤 Transferring USDC to perp margin...`);
        console.log(`      Spot USDC: $${keeperUsdcOnCore.toFixed(2)}`);
        console.log(`      Perp Equity: $${keeperCoreState.perpEquity.toFixed(2)}`);

        // Transfer 90% of USDC to perp (keep some for spot trading fees)
        const transferAmount = keeperUsdcOnCore * 0.9;
        const transferred = await transferToPerp(hl, transferAmount);
        
        if (transferred) {
          console.log(`   ✅ Transferred $${transferAmount.toFixed(2)} to perp margin!`);
          await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for settlement
        }
        return; // Next cycle will open position
      }
      
      // Now we have USDC in perp margin - open position
      const perpMargin = keeperCoreState.perpEquity;
      const positionSizeUSD = Math.min(perpMargin * 0.8, CONFIG.maxPositionSizeUSD); // Use 80% of margin
      // ETH has szDecimals: 4, so round to 4 decimal places
      const positionSizeETH = Math.floor((positionSizeUSD / markPrice) * 10000) / 10000;
      
      if (positionSizeUSD >= CONFIG.minOrderValue && perpMargin >= CONFIG.minOrderValue) {
        console.log(`\n   📈 Opening SHORT perp position (funding capture):`);
        console.log(`      Size: ${positionSizeETH.toFixed(4)} ETH ($${positionSizeUSD.toFixed(2)})`);
        console.log(`      Perp Margin: $${perpMargin.toFixed(2)}`);
        console.log(`      Expected APY: ${netCarryAPY.toFixed(1)}%`);
        
        // Short ETH perp at market
        // Round price to 1 decimal place for ETH
        const shortPrice = Math.floor(markPrice * 0.98 * 10) / 10; // 2% below for aggressive IOC fill
        const perpResult = await placePerpOrder(hl, 'ETH', false, positionSizeETH, shortPrice);
        
        if (perpResult.success) {
          position = {
            isOpen: true,
            spotSizeETH: 0,
            perpSizeETH: positionSizeETH,
            entryPrice: markPrice,
            openedAt: new Date(),
          };
          console.log(`\n   ✅ SHORT position opened!`);
          console.log(`      Collecting funding payments at ${fundingAPY.toFixed(1)}% APY`);
        } else {
          console.log(`\n   ❌ Failed to open position: ${perpResult.error}`);
      }
      } else {
        console.log(`\n   ⏸️ WAIT: Need more margin in perp account`);
        console.log(`      Perp Margin: $${perpMargin.toFixed(2)}`);
        console.log(`      Spot USDC: $${keeperUsdcOnCore.toFixed(2)}`);
        console.log(`      Spot HYPE: ${keeperHypeOnCore.toFixed(4)} (~$${(keeperHypeOnCore * hypePrice).toFixed(2)})`);
      }
    } else {
      console.log(`\n   ⏸️ WAIT: Insufficient capital ($${totalKeeperCapital.toFixed(2)} < $${CONFIG.minOrderValue})`);
      console.log(`   Deposit USDC to the vault to start trading.`);
    }

  } catch (error: any) {
    console.error(`\n❌ Error: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║      DELTA-NEUTRAL FUNDING STRATEGY - EOA Keeper Version           ║');
  console.log('╠════════════════════════════════════════════════════════════════════╣');
  console.log('║  Architecture:                                                     ║');
  console.log('║  1. Contract swaps USDC -> HYPE and sends to keeper EOA            ║');
  console.log('║  2. Keeper bridges HYPE to its own HyperCore account               ║');
  console.log('║  3. Keeper trades via HyperLiquid API (spot + perps)               ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝');
  console.log('');

  const rpcUrl = process.env.HYPERLIQUID_RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;

  if (!rpcUrl || !privateKey) {
    console.error('❌ Missing HYPERLIQUID_RPC_URL or PRIVATE_KEY in .env');
    process.exit(1);
  }

  // Initialize providers
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(CONFIG.strategyAddress, STRATEGY_ABI, wallet);

  // Initialize HyperLiquid SDK with explicit wallet address
  console.log('🔌 Initializing HyperLiquid SDK...');
  const hl = await getHLClient(privateKey, wallet.address);
  console.log('✅ SDK initialized\n');

  console.log(`📍 Keeper EOA:  ${wallet.address}`);
  console.log(`📍 Strategy:    ${CONFIG.strategyAddress}`);
  console.log(`📍 Vault:       ${CONFIG.vaultAddress}`);
  console.log(`📍 Max Size:    $${CONFIG.maxPositionSizeUSD}`);
  console.log(`\n⏰ Running every ${CONFIG.intervalSeconds} seconds...`);
  console.log('   Press Ctrl+C to stop\n');

  // Run immediately
  await execute(contract, wallet, provider, hl);

  // Then run on interval
  setInterval(() => execute(contract, wallet, provider, hl), CONFIG.intervalSeconds * 1000);
}

main().catch(console.error);
