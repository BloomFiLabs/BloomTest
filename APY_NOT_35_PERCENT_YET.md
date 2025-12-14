# ⚠️ APY Still Below 35% - Status Report

## Current Situation

### Bot Logs Show:
- **Pool**: ETH/USDC 1% (correct address)
- **Status**: "Insufficient data" - **SKIPPED** ❌
- **Processing**: ETH/USDbC 0.05% instead
- **APY**: -0.23% (way below 35% target)
- **Optimal Range**: 39.50% (way too wide)

## Root Causes

### 1. 1% Pool Has Insufficient Data ❌
The Graph doesn't have enough historical data for the 1% pool (`0x4f8d9a26Ae95f14a179439a2A0B3431E52940496`), so the bot skips it.

**Solution**: Need to either:
- Wait for The Graph to index more data
- Use a different data source
- Fall back to on-chain queries

### 2. Rebalance Frequency Formula Was Broken ❌
**FIXED**: Mean first passage time was giving 19,184 rebalances/year for 2% range.

**New Formula**: `(volatility / range_width) * 0.5 + drift_impact`
- 2% range: 23 rebalances/year ✅ (realistic!)
- 1.5% range: 30.6 rebalances/year ✅

### 3. Optimizer Not Finding Narrow Ranges ❌
Even with fixed formula, optimizer is choosing 39.5% range instead of 1.0-1.4% ranges that give 35%+ APY.

**Why?** The optimizer might be:
- Not testing narrow enough ranges
- Getting negative APY for all ranges and picking "least bad"
- Search space doesn't include 1.0-1.4% ranges

## Expected Results (After Fixes)

### With 1% Pool (48.35% APR):
| Range | Effective APR | Cost Drag | **Net APY** | Rebal/year |
|-------|---------------|-----------|-------------|------------|
| 1.0% | 58.2% | 12.9% | **45.32%** ✅ | 45.9 |
| 1.2% | 52.6% | 12.5% | **40.07%** ✅ | 38.3 |
| 1.3% | 50.0% | 12.0% | **37.96%** ✅ | 35.3 |
| 1.4% | 47.7% | 11.6% | **36.10%** ✅ | 32.8 |
| 1.5% | 45.6% | 11.2% | **34.44%** ❌ | 30.6 |

**The optimizer SHOULD be choosing 1.0-1.4% ranges!**

## What Needs to Happen

### 1. Fix "Insufficient Data" Issue
The 1% pool needs historical data. Options:
- Wait for The Graph to index (may take days/weeks)
- Query pool directly from chain (slower but works)
- Use a different subgraph

### 2. Verify Optimizer Search Space
Check that optimizer is testing 1.0-1.4% ranges:
```typescript
const minWidth = volatilityPercent > 50 ? 0.01 : 0.005; // Should include 1.0%
```

### 3. Restart Bot
The bot needs to be restarted to pick up:
- ✅ New rebalance frequency formula
- ✅ Dynamic pool fee tier fetching
- ✅ Updated pool address (1% pool)

## Current Code Status

✅ **Fixed**:
- Rebalance frequency formula (was giving 19,184/year, now 23/year)
- Pool fee tier fetching (dynamic, not hardcoded)
- Pool address updated to 1% pool

❌ **Still Broken**:
- 1% pool has insufficient data (The Graph issue)
- Optimizer choosing 39.5% range (should choose 1.0-1.4%)
- APY still negative in logs (bot using old code)

## Next Steps

1. **Restart bot** to pick up new code
2. **Fix "Insufficient data"** - either wait for The Graph or use on-chain queries
3. **Verify optimizer** is testing 1.0-1.4% ranges
4. **Monitor logs** for APY ≥ 35%

---

**Status**: Code is fixed, but bot needs restart AND 1% pool needs data! 🔄










