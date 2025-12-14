# Testing Checklist: Ready for Real Funds?

## 🚨 Critical Issues to Fix First

### 1. Contract Interface Mismatch ⚠️ **BLOCKER**
**Problem**: `EthersStrategyExecutor` calls `rebalance()` with no parameters, but `HyperEVMFundingStrategy.rebalance()` requires:
- `bool isLong`
- `uint64 priceLimit`
- `uint64 size`
- `bool reduceOnly`

**Status**: ❌ **NOT READY** - This will cause transaction failures

**Fix Needed**: Update `EthersStrategyExecutor` to:
1. Calculate position size and direction based on funding rate signals
2. Determine price limits from current market price
3. Pass correct parameters to `rebalance()`

### 2. Strategy Mismatch ⚠️ **ARCHITECTURAL ISSUE**
**Problem**: The keeper bot is configured for **Uniswap v3 liquidity range management** (ETH/USDC pools), but `HyperEVMFundingStrategy` is for **HyperLiquid funding rate capture**.

**Current Bot Logic**:
- Monitors Uniswap pool prices
- Optimizes liquidity ranges
- Rebalances when price hits range edges

**HyperEVMFundingStrategy Needs**:
- Monitor HyperLiquid funding rates
- Calculate target delta (long/short)
- Execute perp trades based on funding signals

**Status**: ❌ **NOT READY** - Bot logic doesn't match strategy contract

**Options**:
- **Option A**: Create a new keeper bot for HyperLiquid funding strategy
- **Option B**: Adapt existing bot to work with HyperLiquid (different data sources, different rebalance logic)

---

## ✅ What You Have

### Infrastructure
- ✅ Keeper bot service (NestJS)
- ✅ Statistical analysis (GARCH, Hurst, MACD)
- ✅ Database persistence (PostgreSQL)
- ✅ Smart contract executor (Ethers)
- ✅ Market data adapter (Uniswap Graph)
- ✅ Volatility data (Deribit)

### Smart Contracts
- ✅ `BloomStrategyVault` - ERC4626 vault
- ✅ `HyperEVMFundingStrategy` - Funding rate strategy contract
- ✅ Keeper authorization system

---

## 📋 Pre-Deployment Checklist

### 1. Smart Contract Deployment
- [ ] Deploy `BloomStrategyVault` to target network (Base/HyperLiquid)
- [ ] Deploy `HyperEVMFundingStrategy` with correct parameters:
  - Vault address
  - USDC address
  - Asset ID (e.g., ETH = ?)
- [ ] Register strategy with vault: `vault.registerStrategy(strategyAddress)`
- [ ] Set keeper address: `strategy.setKeeper(keeperAddress, true)`
- [ ] Verify contract addresses and save them

### 2. Environment Configuration
Create `.env` file in `/server` directory:

```bash
# Blockchain
RPC_URL=https://api.hyperliquid.xyz/exchange  # Or your HyperLiquid RPC
KEEPER_PRIVATE_KEY=0x...  # Private key of keeper wallet

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your_password
DB_DATABASE=bloom_bot

# Optional: Deribit API (for IV data)
DERIBIT_API_KEY=your_key
DERIBIT_API_SECRET=your_secret

# Server
PORT=3000
```

### 3. Database Setup
- [ ] Install PostgreSQL
- [ ] Create database: `CREATE DATABASE bloom_bot;`
- [ ] Run migrations (TypeORM will auto-sync with `synchronize: true`)

### 4. Keeper Wallet
- [ ] Create dedicated keeper wallet (separate from deployer)
- [ ] Fund keeper wallet with native token (for gas)
- [ ] **DO NOT** store large amounts in keeper wallet
- [ ] Verify keeper address matches `KEEPER_PRIVATE_KEY` in `.env`

### 5. Bot Configuration
Update `BotService.ts` POOLS array with:
- [ ] Actual strategy contract addresses (currently all `0x0000...`)
- [ ] Correct pool addresses for your target markets
- [ ] Remove or comment out pools you're not using

### 6. Funding Rate Data Source
- [ ] Set up Synthetix subgraph connection (from memory: ID `82hQpNuzNB5i5xcFKhk6ZiKcacTWvPeukAkxrKsm8dfM`)
- [ ] Create adapter to fetch `fundingRateUpdates` with:
  - `timestamp`
  - `market`
  - `fundingRate`
  - `funding`
- [ ] Integrate funding rate signals into rebalance decision logic

---

## 🔧 Required Code Changes

### 1. Fix EthersStrategyExecutor
The executor needs to calculate rebalance parameters:

```typescript
async rebalance(strategyAddress: string, params: {
  isLong: boolean;
  priceLimit: bigint;
  size: bigint;
  reduceOnly: boolean;
}): Promise<string> {
  // Call contract with parameters
  const tx = await contract.rebalance(
    params.isLong,
    params.priceLimit,
    params.size,
    params.reduceOnly,
    { gasLimit }
  );
}
```

### 2. Create Funding Rate Adapter
Need to fetch funding rates from Synthetix subgraph:

```typescript
// New adapter: SynthetixGraphAdapter.ts
async getFundingRate(market: string): Promise<FundingRate> {
  // Query subgraph for latest fundingRateUpdate
  // Return: { rate, timestamp, market }
}
```

### 3. Update Bot Logic
Replace Uniswap range logic with funding rate logic:

```typescript
// Instead of checking price vs range
// Check funding rate vs threshold
const fundingRate = await fundingAdapter.getFundingRate(market);
if (Math.abs(fundingRate.rate) > THRESHOLD) {
  // Calculate target position
  const isLong = fundingRate.rate < 0; // Negative = long pays short
  const size = calculatePositionSize(fundingRate);
  await executor.rebalance(strategyAddress, { isLong, ... });
}
```

---

## 🧪 Testing Steps (Before Real Funds)

### 1. Unit Tests
- [ ] Run: `pnpm test`
- [ ] Verify all 38 tests pass
- [ ] Add tests for new funding rate logic

### 2. Integration Tests
- [ ] Test contract deployment script
- [ ] Test keeper authorization
- [ ] Test rebalance execution (on testnet)
- [ ] Test emergency exit

### 3. Testnet Deployment
- [ ] Deploy to HyperLiquid testnet (if available)
- [ ] Fund with test tokens
- [ ] Run keeper bot for 24-48 hours
- [ ] Monitor logs for errors
- [ ] Verify rebalances execute correctly

### 4. Dry Run (Mainnet)
- [ ] Deploy contracts to mainnet
- [ ] **DO NOT** deposit funds yet
- [ ] Run keeper bot in "dry-run" mode (log only, no execution)
- [ ] Verify it fetches data correctly
- [ ] Verify it calculates signals correctly
- [ ] Monitor for 24-48 hours

---

## 💰 Starting with Real Funds

### Minimum Requirements Met:
- [ ] All critical issues fixed
- [ ] Contracts deployed and verified
- [ ] Keeper bot running successfully on testnet
- [ ] Dry-run successful on mainnet
- [ ] Monitoring/alerting set up
- [ ] Emergency exit tested

### Recommended Starting Amount:
- **Start Small**: $1,000 - $5,000 USDC
- **Monitor Closely**: Check logs every few hours
- **Scale Gradually**: Increase after 1-2 weeks of successful operation

### Risk Management:
- [ ] Set position size limits
- [ ] Set maximum leverage limits
- [ ] Set stop-loss thresholds
- [ ] Monitor funding rate exposure
- [ ] Have emergency exit plan ready

---

## 📊 Monitoring Setup

### Logs to Monitor:
- [ ] Rebalance execution attempts
- [ ] Transaction confirmations
- [ ] Funding rate changes
- [ ] Position size changes
- [ ] Error logs
- [ ] Gas costs

### Alerts to Set Up:
- [ ] Failed rebalance attempts
- [ ] High gas costs
- [ ] Unusual funding rates
- [ ] Position size limits exceeded
- [ ] Bot service downtime

---

## 🎯 Summary

**Current Status**: ❌ **NOT READY** for real funds

**Blockers**:
1. Contract interface mismatch (rebalance parameters)
2. Strategy mismatch (Uniswap bot vs HyperLiquid strategy)
3. Missing funding rate data adapter
4. Contracts not deployed
5. Configuration incomplete

**Estimated Time to Ready**: 2-3 days of development work

**Next Steps**:
1. Fix `EthersStrategyExecutor` to match contract interface
2. Create funding rate adapter (Synthetix subgraph)
3. Update bot logic for funding rate strategy
4. Deploy contracts to testnet
5. Test thoroughly before mainnet

