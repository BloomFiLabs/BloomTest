# Bloom Deployment Guide

## Prerequisites

Before deploying, ensure you have:

1. ✅ Two separate wallets:
   - **Deployer wallet** (will own the contracts)
   - **Keeper wallet** (will execute rebalances)

2. ✅ Both wallets funded with ETH on Base:
   - Deployer: ~0.05 ETH (for deployment gas)
   - Keeper: ~0.01 ETH (for rebalance gas)

3. ✅ Environment variables configured (see below)

---

## Step 1: Configure Environment Variables

### Contracts `.env` (contracts/.env)

```bash
# Deployer wallet private key (with 0x prefix)
PRIVATE_KEY=0x...your_deployer_private_key...

# Base Mainnet RPC
RPC_URL=https://mainnet.base.org

# Keeper wallet ADDRESS (not private key!)
KEEPER_ADDRESS=0x...your_keeper_wallet_address...

# Optional: Etherscan API key for verification
ETHERSCAN_API_KEY=your_api_key
```

### Server `.env` (server/.env)

Already configured from Prisma setup. Should have:

```bash
# Keeper wallet private key
KEEPER_PRIVATE_KEY=0x...your_keeper_private_key...

# Base Mainnet RPC (same as contracts)
RPC_URL=https://mainnet.base.org

# Database connection
DATABASE_URL="postgresql://postgres:bloom_dev_password@localhost:5432/bloom_bot?schema=public"
STORAGE_TYPE=postgres
```

---

## Step 2: Deploy Contracts

```bash
cd contracts
source .env
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify -vvvv
```

### What the deploy script does:

1. Deploys `LiquidityRangeManager`
2. Deploys `CollateralManager`
3. Deploys `BloomStrategyVault`
4. Deploys `DeltaNeutralStrategy`
5. Registers strategy with vault
6. **Authorizes keeper wallet** (if KEEPER_ADDRESS is set)
7. Writes contract addresses to:
   - `contracts/deployed_addresses.json`
   - `server/src/config/contracts.json`

---

## Step 3: Verify Deployment

Check that all contracts were deployed:

```bash
# View deployed addresses
cat deployed_addresses.json

# Check keeper was authorized
cast call <STRATEGY_ADDRESS> "keepers(address)(bool)" <KEEPER_ADDRESS> --rpc-url $RPC_URL
```

Expected output: `true`

---

## Step 4: Start the Keeper Bot

### Start Database (if not already running)

```bash
cd server
sudo docker compose up -d
```

### Start the Keeper

```bash
cd server
npm run start:dev
```

The bot will:
- Load contract addresses from `src/config/contracts.json`
- Connect to Base RPC
- Monitor ETH/USDC pool price
- Execute rebalances when needed

---

## Step 5: Monitor & Test

### View Bot Logs

```bash
# Watch logs in real-time
cd server
npm run start:dev

# Look for:
# - "Processing pool: ETH/USDC 0.05%"
# - "Analysis: HistVol=..., Hurst=..."
# - "[TRIGGER] Price hit edge of range"
# - "[EXECUTE] Calling rebalance..."
```

### Check Bot Status (API)

```bash
# Get status for a pool
curl http://localhost:3000/bot/status/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640

# Trigger manual analysis
curl -X POST http://localhost:3000/bot/analyze
```

### Manually Trigger Rebalance (for testing)

```bash
# From deployer wallet
cast send <STRATEGY_ADDRESS> "rebalance(uint256)" 500000 \
  --private-key $PRIVATE_KEY \
  --rpc-url $RPC_URL
```

---

## Troubleshooting

### "No keeper address provided"

Add `KEEPER_ADDRESS` to `contracts/.env` and redeploy, OR manually authorize:

```bash
cast send <STRATEGY_ADDRESS> "setKeeper(address,bool)" <KEEPER_ADDRESS> true \
  --private-key $PRIVATE_KEY \
  --rpc-url $RPC_URL
```

### "Keeper wallet not initialized"

Check `server/.env` has `KEEPER_PRIVATE_KEY` set.

### "Strategy address 0x0000..."

Contract addresses weren't loaded. Check `server/src/config/contracts.json` exists.

### "Insufficient funds"

Keeper wallet needs ETH for gas. Send 0.01-0.1 ETH to keeper address.

---

## Next Steps After Deployment

1. **Fund the Vault**:
   ```bash
   # Approve USDC
   cast send 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "approve(address,uint256)" <VAULT_ADDRESS> 1000000000 --private-key $YOUR_KEY --rpc-url $RPC_URL
   
   # Deposit USDC (1000 USDC = 1000 * 1e6)
   cast send <VAULT_ADDRESS> "deposit(uint256,address)" 1000000000 <YOUR_ADDRESS> --private-key $YOUR_KEY --rpc-url $RPC_URL
   ```

2. **Monitor Performance**:
   - Watch bot logs for rebalances
   - Check vault balance: `cast call <VAULT_ADDRESS> "totalAssets()(uint256)" --rpc-url $RPC_URL`
   - View Prisma Studio: `cd server && npx prisma studio`

3. **Scale Gradually**:
   - Start with small amounts ($100-$1000)
   - Monitor for 24-48 hours
   - Increase after successful operation

---

## Emergency Procedures

### Emergency Exit (Close All Positions)

```bash
cast send <STRATEGY_ADDRESS> "emergencyExit()" \
  --private-key $PRIVATE_KEY \
  --rpc-url $RPC_URL
```

### Stop Keeper Bot

```bash
# Stop the bot (Ctrl+C)
# or
pkill -f "nest start"
```

### Stop Database

```bash
cd server
sudo docker compose down
```

