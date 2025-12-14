# 🏊 Pool Configuration - Base Network

## Currently Monitored Pools

### ✅ Active Strategy (Funds Deployed)
1. **ETH/USDC 0.05%**
   - Address: `0xd0b53d9277642d899DF5C87A3966A349A798F224`
   - Strategy: `0xAEF957078630051EBeCaC56a78125bf8C1e3Fa2b` ✅
   - Status: **LIVE** with $38.94 deployed
   - Shows performance metrics ✅

### 📊 Monitored Only (No Strategy Yet)
2. **ETH/USDbC 0.05%**
   - Address: `0x4c36388be6f416a29c8d8eee81c771ce6be14b18`
   - Strategy: Not deployed
   - Status: Analysis only, no automated management

3. **ETH/USDT 0.05%**
   - Address: `0xCb0E5bFa72bBb4d16AB5aA0c60601c438F04b4ad`
   - Strategy: Not deployed
   - Status: Analysis only, no automated management

4. **WBTC/USDC 0.3%**
   - Address: `0xEB467AEb058D27Ed7223dD8b991bC88F42e2eA6C`
   - Strategy: Not deployed
   - Status: Analysis only, no automated management

---

## 📈 What You'll See

### Every 5 Minutes - Full Analysis:
```
Processing pool: ETH/USDC 0.05%
Processing pool: ETH/USDbC 0.05%
Processing pool: ETH/USDT 0.05%
Processing pool: WBTC/USDC 0.3%
```

### Performance Metrics:
- **Only ETH/USDC** shows performance metrics (it has active strategy)
- Other pools show analysis only until strategies are deployed

---

## 🚀 Deploying Additional Strategies

To add automated management for other pools:

### 1. Deploy Strategy for Specific Pool
```bash
cd /home/aurellius/Documents/Bloom/contracts

# Edit Deploy.s.sol to specify different pool address
# Then deploy:
forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast
```

### 2. Update Configuration
The deploy script will automatically update `contracts.json` with new addresses.

### 3. Map Strategy to Pool
Edit `BotService.ts` to map the new strategy to its pool:
```typescript
if (config.DeltaNeutralStrategy2) {
  POOLS[2].strategyAddress = config.DeltaNeutralStrategy2;
}
```

---

## 💡 Why Multiple Pools?

### Diversification Benefits:
1. **ETH/USDC** - Primary ETH exposure, highest liquidity
2. **ETH/USDT** - Alternative stablecoin, different trading patterns  
3. **WBTC/USDC** - Bitcoin exposure, uncorrelated with ETH
4. **WBTC/USDT** - (Not added yet, low liquidity on Base)

### Risk Distribution:
- Spread capital across multiple assets
- Different volatility profiles
- Reduced concentration risk

---

## 🎯 Current Setup

**Active Management**: 1 pool (ETH/USDC)  
**Monitoring**: 4 pools total  
**Capital Deployed**: $38.94 (ETH/USDC only)  

**Recommended Next Steps**:
1. Monitor ETH/USDC performance for 24-48 hours
2. Scale up capital in ETH/USDC if performing well
3. Deploy strategies for other pools once confident
4. Distribute capital across multiple pools for diversification

---

## 🔍 Pool Statistics (Base Network)

| Pool | Fee Tier | TVL (approx) | Volume | Notes |
|------|----------|--------------|--------|-------|
| ETH/USDC | 0.05% | $50M+ | High | Main pool ✅ |
| ETH/USDbC | 0.05% | $20M+ | Medium | Legacy USDC |
| ETH/USDT | 0.05% | $5M+ | Medium | Alt stable |
| WBTC/USDC | 0.3% | $2M+ | Low | BTC exposure |

**Note**: Lower fee tiers (0.05%) = tighter spreads, more volume  
Higher fee tiers (0.3%) = wider spreads, compensate for volatility

---

**Last Updated**: Nov 23, 2025 23:57 UTC

