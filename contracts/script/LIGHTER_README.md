# Lighter Perpetual Futures Order Script

This Forge script allows you to interact with Lighter Protocol's perpetual futures contracts via the Ethereum Virtual Machine (EVM).

## Prerequisites

1. **Foundry/Forge** installed
2. **Environment variables** set up (see below)
3. **Lighter contract addresses** (update in script or via env vars)

## Setup

### 1. Set Environment Variables

Create a `.env` file or export variables:

```bash
export PRIVATE_KEY=0x...
export RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
export LIGHTER_PERPS_CONTRACT=0x...  # Lighter perps contract address
export LIGHTER_GATEWAY_CONTRACT=0x...  # Lighter gateway contract address
```

### 2. Update Contract Addresses

The script includes placeholder addresses. You need to:

1. Find Lighter's actual contract addresses from their documentation:
   - Perpetual Futures Contract
   - Gateway Contract (Ethereum Gateway)
   
2. Either:
   - Set them via environment variables (recommended)
   - Update the default values in the script

**Lighter Resources:**
- Website: https://lighter.xyz/
- Ethereum Gateway: https://app.lighter.xyz/ethereum-gateway/
- Documentation: https://docs.lighter.xyz/

### 3. Verify Interface Matches

The interfaces in `src/interfaces/ILighterPerps.sol` are based on common perpetual futures patterns. **You must verify these match Lighter's actual ABI** and update them if needed.

## Usage

### Check Script Info

```bash
forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \
  --rpc-url $RPC_URL
```

### Place a Limit Order

```bash
# Parameters: marketId, size, price, isBuy, leverage
# Example: Market 0, 1 ETH, $2000, BUY, 10x leverage
forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \
  --sig "placeLimitOrder(uint256,uint256,uint256,bool,uint256)" \
  0 1000000000000000000 2000000000 true 10 \
  --rpc-url $RPC_URL --broadcast
```

**Parameter Details:**
- `marketId`: Market ID (e.g., 0 for ETH/USDC)
- `size`: Order size in base asset units (1e18 = 1 ETH)
- `price`: Limit price in quote asset units (2000e6 = $2000 USDC)
- `isBuy`: `true` for LONG/BUY, `false` for SHORT/SELL
- `leverage`: Leverage multiplier (10 = 10x)

### Close a Position

```bash
# Parameters: marketId, size, isBuy
# Example: Close 0.5 ETH of LONG position
forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \
  --sig "closePosition(uint256,uint256,bool)" \
  0 500000000000000000 false \
  --rpc-url $RPC_URL --broadcast
```

### Cancel an Order

```bash
# Parameters: orderId
forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \
  --sig "cancelOrder(uint256)" \
  12345 \
  --rpc-url $RPC_URL --broadcast
```

### Check Position

```bash
# Parameters: marketId
forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \
  --sig "checkPosition(uint256)" \
  0 \
  --rpc-url $RPC_URL
```

### Deposit Collateral

```bash
# Parameters: token, amount
# Example: Deposit 1000 USDC (1e6 = 1 USDC)
forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \
  --sig "depositCollateral(address,uint256)" \
  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 1000000000 \
  --rpc-url $RPC_URL --broadcast
```

### Withdraw Collateral

```bash
# Parameters: token, amount
forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \
  --sig "withdrawCollateral(address,uint256)" \
  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 1000000000 \
  --rpc-url $RPC_URL --broadcast
```

### Check Gateway Balance

```bash
# Parameters: token
forge script script/LighterPerpsOrder.s.sol:LighterPerpsOrder \
  --sig "checkGatewayBalance(address)" \
  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --rpc-url $RPC_URL
```

## Common Token Addresses (Ethereum Mainnet)

- **USDC**: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- **WETH**: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`
- **USDT**: `0xdAC17F958D2ee523a2206206994597C13D831ec7`

## Important Notes

1. **Contract Addresses**: The script uses placeholder addresses. You **must** update them with Lighter's actual contract addresses.

2. **Interface Verification**: The interfaces are based on common patterns. Verify they match Lighter's actual ABI and update if needed.

3. **Market IDs**: Market IDs are protocol-specific. Check Lighter's documentation for the correct market IDs.

4. **Decimals**: 
   - ETH: 18 decimals (1e18 = 1 ETH)
   - USDC: 6 decimals (1e6 = 1 USDC)
   - USDT: 6 decimals (1e6 = 1 USDT)

5. **Testing**: Always test on a testnet first before using mainnet.

6. **Security**: Never commit your private key. Use environment variables or a secure key management system.

## Troubleshooting

### "LIGHTER_PERPS contract not set"
- Set the `LIGHTER_PERPS_CONTRACT` environment variable
- Or update the default address in the script

### "LIGHTER_GATEWAY contract not set"
- Set the `LIGHTER_GATEWAY_CONTRACT` environment variable
- Or update the default address in the script

### Function signature errors
- The interface may not match Lighter's actual ABI
- Check Lighter's documentation and update the interface accordingly

### Insufficient balance
- Ensure you have enough collateral deposited in the gateway
- Check your wallet balance for the token you're trying to deposit

## Next Steps

1. Get Lighter's contract addresses from their documentation
2. Verify the interface matches their ABI
3. Test on a testnet first
4. Update market IDs based on Lighter's market structure
5. Adjust function signatures if needed

