# Ready to Deploy! 🚀

## Current Status

Your environment is set up. You said you've filled in the `.env` files, so here's what to do:

---

## Step 1: Verify Your .env Files

### Check Contracts .env

```bash
cd contracts
cat .env
```

Should have:
- `PRIVATE_KEY=0x...` (your actual deployer private key)
- `RPC_URL=https://mainnet.base.org`
- `KEEPER_ADDRESS=0x...` (your keeper wallet address)

### Check Server .env

```bash
cd server
cat .env | grep -E "(KEEPER_PRIVATE_KEY|RPC_URL)"
```

Should have:
- `KEEPER_PRIVATE_KEY=0x...` (your actual keeper private key)  
- `RPC_URL=https://mainnet.base.org`

---

## Step 2: Deploy Contracts

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify -vvvv
```

This will:
1. Deploy all 4 contracts
2. Register strategy with vault
3. Authorize keeper
4. Write addresses to `deployed_addresses.json` and `server/src/config/contracts.json`

---

## Step 3: Verify Deployment

Check the output for:

```
LiquidityRangeManager: 0x...
CollateralManager: 0x...
BloomStrategyVault: 0x...
DeltaNeutralStrategy: 0x...
```

And verify keeper was authorized:

```bash
cast call <STRATEGY_ADDRESS> "keepers(address)(bool)" <KEEPER_ADDRESS> --rpc-url $RPC_URL
# Should return: true
```

---

## Step 4: Start the Keeper Bot

```bash
# Ensure database is running
cd server
sudo docker compose up -d

# Start the keeper
npm run start:dev
```

Watch the logs. You should see:
- ✅ "Processing pool: ETH/USDC 0.05%"
- ✅ "Loaded strategy address from config: 0x..."
- ✅ Analysis metrics (volatility, Hurst, etc.)

---

## If .env Files Need Setup

If your `.env` files still have placeholder values:

### Contracts/.env

```bash
cd contracts
nano .env
```

Add:
```
PRIVATE_KEY=0xYOUR_DEPLOYER_PRIVATE_KEY
RPC_URL=https://mainnet.base.org
KEEPER_ADDRESS=0xYOUR_KEEPER_WALLET_ADDRESS
```

### Server/.env  

```bash
cd server
nano .env
```

Add:
```
KEEPER_PRIVATE_KEY=0xYOUR_KEEPER_PRIVATE_KEY
RPC_URL=https://mainnet.base.org
```

---

## Quick Verification Commands

```bash
# Check contracts .env
cd contracts && source .env && echo "Deployer: ${PRIVATE_KEY:0:10}... Keeper: $KEEPER_ADDRESS"

# Check server .env
cd server && source .env && echo "Keeper PK: ${KEEPER_PRIVATE_KEY:0:10}... RPC: $RPC_URL"

# Test RPC connection
cast block-number --rpc-url https://mainnet.base.org
```

---

## Need Help?

Run the environment checker:
```bash
cd contracts
./check-env.sh
```

This will verify all required variables are set.

