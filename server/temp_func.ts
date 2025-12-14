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






