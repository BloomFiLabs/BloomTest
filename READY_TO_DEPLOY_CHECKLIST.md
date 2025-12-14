# 🚀 Ready to Deploy Checklist

## Current Status

✅ **Keeper bot is running** and ready  
✅ **Contract addresses configured** in bot  
✅ **KEEPER_ADDRESS set** in deployment script  
⏳ **Waiting for wallet funding**

---

## Step 1: Fund Deployer Wallet ⛽

**Address**: `0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03`  
**Network**: Base (Chain ID: 8453)  
**Amount Needed**: ~0.0001 ETH (about $0.40 USD)

### How to Fund:
- **Bridge**: https://bridge.base.org
- **Coinbase**: Withdraw directly to Base network
- **Other exchanges** that support Base

### Check Balance:
```bash
cast balance 0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03 --rpc-url https://mainnet.base.org
```

---

## Step 2: Deploy Contracts 🏗️

Once funded, run:

```bash
cd /home/aurellius/Documents/Bloom/contracts
forge script script/Deploy.s.sol:DeployScript --rpc-url $RPC_URL --broadcast
```

The script will:
1. ✅ Deploy all 4 contracts
2. ✅ Register strategy with vault
3. ✅ **Automatically authorize your keeper wallet** (0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03)
4. ✅ Print contract addresses

---

## Step 3: Update Contract Addresses 📝

Copy the JSON output from the deployment and save it:

```bash
# The deployment will print JSON like this:
{"BloomStrategyVault":"0x...","CollateralManager":"0x...","DeltaNeutralStrategy":"0x...","LiquidityRangeManager":"0x..."}

# Save it to both locations:
nano contracts/deployed_addresses.json
nano server/src/config/contracts.json
```

Or I can help you do this automatically once deployment succeeds.

---

## Step 4: Restart Keeper Bot 🤖

```bash
cd /home/aurellius/Documents/Bloom/server
pkill -f "nest start"
npm run start:dev > keeper-bot.log 2>&1 &
```

The bot will automatically:
- Load the new contract addresses
- Start monitoring ETH/USDC pool every 5 minutes
- Execute rebalances when conditions are met

---

## Step 5: Verify Everything Works ✅

### Check Keeper Authorization:
```bash
cast call 0x8508f52aEd1760c0a4aacc4FD618e84EF9dc9872 \
  "keepers(address)(bool)" \
  0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03 \
  --rpc-url https://mainnet.base.org
```

Should return: `true`

### Check Bot Logs:
```bash
tail -f /home/aurellius/Documents/Bloom/server/keeper-bot.log
```

Look for:
- "Loaded DeltaNeutralStrategy address: 0x..."
- "Starting scheduled analysis..."
- "Processing pool: ETH/USDC 0.05%"

### View Contracts on BaseScan:
- Vault: https://basescan.org/address/0x9fcD1132f2E0bD4b07B9202bbe17D247F403fd14
- Strategy: https://basescan.org/address/0x8508f52aEd1760c0a4aacc4FD618e84EF9dc9872

---

## Important Notes 📌

### Security Consideration:
You're using the **same wallet** for deploying and keeping:
- **Address**: `0x16A1e17144f10091D6dA0eCA7F336Ccc76462e03`

For production, consider using separate wallets:
- **Deployer wallet**: Only for deployment (can be stored offline after)
- **Keeper wallet**: Hot wallet for automated rebalancing

### Gas Costs:
- **Deployment**: ~0.00001 ETH (one-time)
- **Keeper operations**: ~0.0001 ETH per rebalance
- **Recommended keeper balance**: 0.01 ETH for ~100 rebalances

### What's Already Done:
✅ All contract code ready  
✅ Bot fully configured  
✅ File-based storage working  
✅ Strategy address pre-configured  
✅ Keeper will be auto-authorized on deploy  

**You're literally one funding transaction away from going live!** 🎉

---

## Troubleshooting

### "Error: insufficient funds"
→ Wallet not funded yet or wrong network

### "could not decode result data"
→ Contracts not deployed yet

### "Keeper not authorized"
→ Shouldn't happen since KEEPER_ADDRESS is in .env, but run:
```bash
cd contracts && npm run setup-keeper
```

### Bot not processing pools
→ Check logs, restart bot, verify contract address loaded

---

**Ready when you are!** Fund the wallet and let's deploy! 🚀

