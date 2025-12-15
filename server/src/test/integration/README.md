# Integration Testing with Testnets

## Overview

This directory contains integration tests that run against **real testnet APIs** (where available) to validate exchange adapter functionality with actual network conditions.

## Testnet Availability

| Exchange | Testnet Available | Environment Variables |
|----------|------------------|----------------------|
| **Hyperliquid** | ✅ Yes | `HYPERLIQUID_TESTNET=true` |
| **Extended** | ✅ Yes (Starknet Sepolia) | `EXTENDED_TESTNET=true`, `EXTENDED_API_BASE_URL=https://api.sepolia.extended.exchange` |
| **Lighter** | ⚠️ Limited (use small mainnet amounts) | `LIGHTER_API_BASE_URL=https://mainnet.zklighter.elliot.ai` |
| **Aster** | ❌ No (Layer-1 testnet coming Q1 2026) | Use small mainnet amounts |

## Running Integration Tests

```bash
# Run all integration tests (uses testnets)
pnpm run test:integration

# Run specific exchange tests
pnpm run test:integration -- --grep "Hyperliquid"
pnpm run test:integration -- --grep "Lighter"

# Run with verbose logging
DEBUG=* pnpm run test:integration
```

## Environment Setup

Create a `.env.testnet` file with the following configuration:

```bash
# =============================================================================
# HYPERLIQUID TESTNET
# =============================================================================
# Hyperliquid has a fully functional testnet at testnet.hyperliquid.xyz
# Get testnet funds from the faucet
# Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
HYPERLIQUID_TESTNET=true
HYPERLIQUID_PRIVATE_KEY=your_testnet_wallet_private_key

# =============================================================================
# EXTENDED TESTNET (Starknet Sepolia)
# =============================================================================
# Extended runs on Starknet Sepolia for testnet
# Get testnet STRK from a faucet
# Docs: https://api.docs.extended.exchange/
EXTENDED_TESTNET=true
EXTENDED_API_BASE_URL=https://api.sepolia.extended.exchange
EXTENDED_API_KEY=your_testnet_api_key
EXTENDED_STARK_PRIVATE_KEY=your_testnet_stark_private_key
EXTENDED_STARK_PUBLIC_KEY=your_testnet_stark_public_key
EXTENDED_VAULT_NUMBER=0

# =============================================================================
# LIGHTER (No dedicated testnet - use mainnet with caution)
# =============================================================================
# Lighter doesn't have a public testnet API anymore
# For testing, use mainnet with SMALL amounts or mock mode
# Integration tests are READ-ONLY for mainnet unless ALLOW_MAINNET_ORDERS=true
LIGHTER_API_BASE_URL=https://mainnet.zklighter.elliot.ai
LIGHTER_API_KEY=your_api_key
LIGHTER_ACCOUNT_INDEX=your_account_index
LIGHTER_API_KEY_INDEX=1

# =============================================================================
# ASTER (No dedicated testnet - use mainnet with caution)
# =============================================================================
# Aster doesn't have a public testnet API yet (coming Q1 2026)
# Integration tests are READ-ONLY for mainnet
ASTER_BASE_URL=https://fapi.asterdex.com
ASTER_API_KEY=your_api_key
ASTER_API_SECRET=your_api_secret
ASTER_PRIVATE_KEY=your_wallet_private_key

# =============================================================================
# SAFETY FLAGS
# =============================================================================
# Set to true to allow placing orders on mainnet during tests
# ⚠️ USE WITH EXTREME CAUTION - real funds at risk!
ALLOW_MAINNET_ORDERS=false

# Mock capital for simulation mode
MOCK_CAPITAL_USD=10000
```

### Getting Testnet Credentials

1. **Hyperliquid Testnet**:
   - Go to https://testnet.hyperliquid.xyz
   - Connect a wallet (use a dedicated test wallet!)
   - Get testnet funds from the faucet
   - Export your wallet private key

2. **Extended Testnet** (Starknet Sepolia):
   - Create an account at https://sepolia.extended.exchange
   - Get testnet STRK from Starknet Sepolia faucet
   - Generate API keys from account settings

## Test Categories

### 1. Connection Tests
- API connectivity
- Authentication
- WebSocket connections

### 2. Market Data Tests
- Fetch funding rates
- Get order book
- Get mark prices
- Symbol/market resolution

### 3. Order Flow Tests (testnet only)
- Place limit orders
- Cancel orders
- Check order status
- Get open orders

### 4. Position Tests (testnet only)
- Open positions
- Close positions
- Get position data

## Safety Features

- All order flow tests use **minimum position sizes**
- Tests automatically clean up (cancel orders, close positions)
- Mainnet tests are read-only unless `ALLOW_MAINNET_ORDERS=true`

