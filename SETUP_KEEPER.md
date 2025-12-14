# Keeper Setup Guide

## Step 1: Add Keeper Private Key

Edit `server/.env` and add:

```bash
KEEPER_PRIVATE_KEY=0xYOUR_KEEPER_PRIVATE_KEY_HERE
```

**Security Notes:**
- Use a DIFFERENT wallet than your deployer wallet
- Fund this wallet with ~0.01 ETH on Base for gas fees
- Never commit this private key to git

## Step 2: Run the Setup Script

```bash
cd contracts
npm run setup-keeper
```

The script will:
1. ✅ Load deployed contract addresses
2. ✅ Derive keeper address from KEEPER_PRIVATE_KEY
3. ✅ Check if keeper is already authorized
4. ✅ Call `setKeeper(keeperAddress, true)` on the strategy
5. ✅ Verify the authorization was successful

## Step 3: Start the Keeper Bot

```bash
cd ../server
npm run start:dev
```

## Deployed Contract Addresses

- **DeltaNeutralStrategy**: `0x8508f52aEd1760c0a4aacc4FD618e84EF9dc9872`
- **BloomStrategyVault**: `0x9fcD1132f2E0bD4b07B9202bbe17D247F403fd14`
- **CollateralManager**: `0x247062659f997BDb5975b984c2bE2aDF87661314`
- **LiquidityRangeManager**: `0x7Eedc4088b197B4EE05BBB00B8c957C411B533Df`

All addresses saved to:
- `contracts/deployed_addresses.json`
- `server/src/config/contracts.json` ✅

## What the Script Does

```typescript
// 1. Derives keeper address from private key
const keeperWallet = new ethers.Wallet(keeperPrivateKey);
const keeperAddress = keeperWallet.address;

// 2. Connects as deployer (contract owner)
const strategy = new ethers.Contract(strategyAddress, ABI, deployerWallet);

// 3. Authorizes keeper
await strategy.setKeeper(keeperAddress, true);

// 4. Verifies
const isAuthorized = await strategy.keepers(keeperAddress);
```

## Troubleshooting

### "KEEPER_PRIVATE_KEY not found"
- Make sure you added it to `server/.env`
- Check that it starts with `0x`

### "Deployer wallet is not the contract owner"
- You must run the script with the same wallet that deployed the contracts
- Check that `PRIVATE_KEY` in `contracts/.env` is correct

### "Transaction failed"
- Make sure deployer wallet has ETH on Base
- Check Base RPC is responsive

### Manual Setup (Alternative)

If the script fails, you can manually authorize the keeper using `cast`:

```bash
# Get your keeper address
cast wallet address --private-key $KEEPER_PRIVATE_KEY

# Authorize keeper (run as deployer)
cast send 0x8508f52aEd1760c0a4aacc4FD618e84EF9dc9872 \
  "setKeeper(address,bool)" \
  <KEEPER_ADDRESS> \
  true \
  --private-key $PRIVATE_KEY \
  --rpc-url https://mainnet.base.org

# Verify
cast call 0x8508f52aEd1760c0a4aacc4FD618e84EF9dc9872 \
  "keepers(address)(bool)" \
  <KEEPER_ADDRESS> \
  --rpc-url https://mainnet.base.org
```

## Next Steps

Once keeper is authorized:
1. Start the bot: `cd server && npm run start:dev`
2. Monitor logs for rebalance triggers
3. Test with small deposits first
4. Check strategy performance on BaseScan

Ready to go! 🚀

