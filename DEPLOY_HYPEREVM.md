# Deploying Funding Strategy to HyperEVM

## Prerequisites

1.  **Hyperliquid RPC**: Added to `.env` (Done).
2.  **USDC Address**: Configured (`0xb88339CB7199b77E23DB6E890353E22632Ba630f`).
3.  **Funding Required**:
    - The deployment failed due to **Insufficient Funds**.
    - **Wallet Address**: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
    - **Required Amount**: ~0.005 HYPE (Estimated cost was 0.0037 HYPE)
    - Please send HYPE to this address on the HyperEVM Mainnet.

## Configuration

Check your `.env` file in `contracts/`:

```env
HYPERLIQUID_RPC_URL=https://hyperliquid-mainnet.g.alchemy.com/v2/fe3jXYwWdSG3qiVvQWBZ5
PRIVATE_KEY=<YOUR_PRIVATE_KEY> # Currently using default Anvil key
USDC_ADDRESS=0xb88339CB7199b77E23DB6E890353E22632Ba630f
ASSET_ID=4
KEEPER_ADDRESS=<YOUR_KEEPER_WALLET>
```

## Deployment

Once funded, run the deployment script:

```bash
cd contracts
forge script script/DeployHyperEVM.s.sol \
  --rpc-url $HYPERLIQUID_RPC_URL \
  --broadcast \
  --no-storage-caching
```

## Output

The script will output the deployed addresses:
- `BloomStrategyVault`
- `HyperEVMFundingStrategy`

Copy these addresses to your bot configuration.

## Next Steps

1.  **Fund the Vault**: Send USDC to the `BloomStrategyVault`.
2.  **Start the Keeper**: The keeper bot needs to call `rebalance()` on the strategy.
3.  **CoreWriter**: The strategy interacts with `CORE_WRITER` (0x...3333) to place perp orders on Hyperliquid L1.
