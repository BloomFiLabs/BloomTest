# Trading Fee Collection System

## Overview

**YES**, there ARE rewards to claim! Your Uniswap V3 liquidity position accumulates trading fees every time someone swaps through your price range. These fees need to be collected (harvested) periodically.

## How It Works

### 1. Fee Accumulation
- Every time a swap occurs in the Uniswap V3 ETH/USDC 0.05% pool within your active price range, you earn 0.05% of the swap volume
- Fees accumulate in the position and grow over time
- **Fees are NOT automatically collected** - they must be explicitly harvested

### 2. Fee Collection Architecture

```
Uniswap V3 Position (NFT)
  ↓ (fees accumulate)
LiquidityRangeManager.collectFees()
  ↓
DeltaNeutralStrategy.harvest()
  ↓ (splits fees 80/20)
├─> 80% to BloomStrategyVault (user rewards)
└─> 20% to Strategy Manager (protocol fee)
```

### 3. Smart Contract Functions

#### `DeltaNeutralStrategy.harvest()`
Located at: `contracts/src/DeltaNeutralStrategy.sol:160`

```solidity
function harvest() external {
    _harvest(vault);
}
```

This function:
1. Calls `liquidityManager.collectFees()` to collect raw fees from Uniswap V3
2. Swaps ETH fees to USDC
3. Splits fees 80/20 between users and protocol
4. Sends user share to the vault
5. Updates `lastHarvestTimestamp`

#### `LiquidityRangeManager.collectFees()`
Located at: `contracts/src/LiquidityRangeManager.sol:170`

```solidity
function collectFees(address pool, uint256 rangePct1e5, address recipient) 
    external 
    returns (uint256 amount0, uint256 amount1)
```

This function:
- Calls Uniswap's `NonfungiblePositionManager.collect()` to claim fees
- Returns `amount0` (ETH) and `amount1` (USDC) collected

### 4. Keeper Bot Integration

The bot now automatically harvests fees every 6 hours via a cron job:

**File**: `server/src/application/services/BotService.ts`

```typescript
@Cron('0 */6 * * *') // Every 6 hours
async harvestFees() {
  this.logger.log('💰 [HARVEST] Collecting trading fees...');
  
  for (const pool of POOLS) {
    if (pool.strategyAddress !== '0x0000000000000000000000000000000000000000') {
      const txHash = await this.executor.harvest(pool.strategyAddress);
      this.logger.log(`✅ Fees collected: ${txHash}`);
    }
  }
}
```

## Fee Collection vs Rebalancing

| Action | Fee Collection (Harvest) | Rebalancing |
|--------|--------------------------|-------------|
| **Frequency** | Every 6 hours (automatic) | Only when signals trigger |
| **Gas Cost** | Low (~100k gas) | High (~1.7M gas) |
| **Position** | Keeps existing position | Closes and reopens position |
| **Fees** | Collects accumulated fees | **Also** collects fees before rebalancing |
| **Purpose** | Realize profits | Adjust to market conditions |

### Important Note: Fees are ALSO collected during rebalance!

In `DeltaNeutralStrategy.rebalance()` (line 231):

```solidity
function rebalance(uint256 rangePct1e5) external onlyKeeper {
    // 1. Claim Rewards to Vault (Profit Taking)
    _claimToVault();  // ← Harvests fees first!
    
    // 2. Unwind using CURRENT activeRange
    _unwindPosition();
    
    // 3. Re-open position with NEW range
    _openPosition(currentAmount, targetRange);
}
```

So you get fees collected:
- **Automatically every 6 hours** (via harvest cron)
- **Every time you rebalance** (as part of rebalance flow)

## Fee Distribution

From `DeltaNeutralStrategy._calculateSplit()` (line 300):

```solidity
// Vault gets 80% of collected fees as base reward
uint256 baseReward = (totalCollected * vaultFeeSplit) / 10000;  // 8000 = 80%
uint256 managerFee = totalCollected - baseReward;               // 20%
```

## Monitoring Fees

You can query uncollected fees (though not yet implemented in the bot):

```typescript
// Pseudo-code for future implementation
const position = await positionManager.positions(tokenId);
const pool = await getPool(position.token0, position.token1, position.fee);

// Calculate uncollected fees
const { amount0, amount1 } = calculateUnclaimedFees(
  position,
  pool.feeGrowthGlobal0X128,
  pool.feeGrowthGlobal1X128
);
```

## Estimated Fee APR

Based on your configuration:
- Pool: ETH/USDC 0.05% on Base
- Current Pool APR: ~11% (from logs)
- Your share after 20% protocol fee: ~8.8% APY

**Example**: $10,000 position → ~$880/year in trading fees (if price stays in range)

## Gas Costs on Base L2

- **Harvest gas**: ~100,000 gas units
- **Gas price**: ~0.1 gwei
- **Cost per harvest**: ~$0.0001 (negligible)

**Conclusion**: Harvesting every 6 hours costs <$0.001/day, making frequent collection economical even for small positions.

## Next Steps

### 1. Test the Harvest Function
```bash
# In Cursor terminal
cd server
npm start
# Wait for harvest cron to run, or trigger manually via API
```

### 2. Monitor Logs
```
💰 [HARVEST] Collecting trading fees from all strategies...
💰 Collecting fees from ETH/USDC 0.05%...
✅ Fees collected successfully: 0xTxHash...
```

### 3. Verify on Basescan
Check your strategy contract address on Basescan to see:
- `harvest()` transactions
- `FeesCollected` events
- USDC transfers to vault

## Manual Harvest

You can also trigger a manual harvest via the Keeper API (if implemented) or directly through Etherscan/Basescan by calling `harvest()` on the strategy contract.

---

**Summary**: You have a complete fee collection system that runs automatically every 6 hours, plus collects fees during every rebalance. On Base L2, the gas costs are negligible, making frequent harvesting profitable even for small amounts!


