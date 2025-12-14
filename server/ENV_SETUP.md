# Environment Variables Setup Guide

## Quick Start

1. **Copy the example file**:
   ```bash
   cp .env.example .env
   ```

2. **Fill in the required variables** (see below)

3. **Never commit `.env` to git** (it's in `.gitignore`)

---

## Required Variables

### 🔴 Critical (Bot won't work without these)

| Variable | Description | Example |
|----------|-------------|---------|
| `RPC_URL` | Blockchain RPC endpoint | `https://mainnet.base.org` |
| `KEEPER_PRIVATE_KEY` | Keeper wallet private key | `0x1234...` (or without 0x) |

### 🟡 Storage Configuration

| Variable | Default | Options | Description |
|----------|---------|---------|-------------|
| `STORAGE_TYPE` | `postgres` | `postgres`, `file`, `memory` | Storage adapter to use |

**If `STORAGE_TYPE=postgres`** (default, production):
| Variable | Description | Example |
|----------|-------------|---------|
| `DB_HOST` | PostgreSQL host | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_USERNAME` | PostgreSQL username | `postgres` |
| `DB_PASSWORD` | PostgreSQL password | `your_password` |
| `DB_DATABASE` | Database name | `bloom_bot` |

**If `STORAGE_TYPE=file`** (development):
| Variable | Default | Description |
|----------|---------|-------------|
| `STORAGE_DATA_DIR` | `./data` | Directory for JSON storage files |

**If `STORAGE_TYPE=memory`** (testing):
- No additional config needed (data lost on restart)

### 🟡 Optional (has defaults)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `KEEPER_SYMBOLS` | Auto-discover | Comma-separated list of symbols to trade (e.g., `ETH,BTC,SOL`). If not set, all common assets are auto-discovered. |
| `KEEPER_BLACKLISTED_SYMBOLS` | `NVDA` | Comma-separated list of symbols to exclude from trading (e.g., `NVDA,EXPERIMENTAL`). Defaults to `NVDA` (experimental market). |
| `KEEPER_MIN_SPREAD` | `0.0001` | Minimum funding rate spread to execute trades (0.01%) |
| `KEEPER_MAX_POSITION_SIZE_USD` | `10000` | Maximum position size per trade in USD |

---

## Detailed Setup

### 1. Blockchain Configuration

**RPC_URL**: Choose based on your network:
- **Base Mainnet**: `https://mainnet.base.org`
- **Base Sepolia (testnet)**: `https://sepolia.base.org`
- **Alchemy/Infura**: `https://base-mainnet.g.alchemy.com/v2/YOUR_KEY`

**KEEPER_PRIVATE_KEY**: 
- Create a dedicated wallet for the keeper bot
- **DO NOT** use your main wallet or deployer wallet
- Fund with small amount of ETH (0.01-0.1 ETH) for gas only
- Format: Can include or exclude `0x` prefix

### 2. Storage Configuration

Choose your storage type based on your needs:

#### Option A: PostgreSQL (Production) - Default
```bash
STORAGE_TYPE=postgres
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your_password
DB_DATABASE=bloom_bot
```

**PostgreSQL Setup**:
```bash
# Install PostgreSQL (if not installed)
sudo apt install postgresql postgresql-contrib

# Create database
sudo -u postgres psql
CREATE DATABASE bloom_bot;
CREATE USER bloom_user WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE bloom_bot TO bloom_user;
\q
```

#### Option B: File-Based (Development)
```bash
STORAGE_TYPE=file
STORAGE_DATA_DIR=./data  # Optional, defaults to ./data
```

**No setup needed!** Data stored in `./data/bot_state.json`

#### Option C: In-Memory (Testing)
```bash
STORAGE_TYPE=memory
```

**No setup needed!** Data lost on restart (perfect for testing)

### 3. Trading Configuration

**Symbol Whitelist/Blacklist**:

- **`KEEPER_SYMBOLS`**: If set, only these symbols will be traded (whitelist mode)
  ```bash
  KEEPER_SYMBOLS=ETH,BTC,SOL,AVAX
  ```

- **`KEEPER_BLACKLISTED_SYMBOLS`**: Symbols to exclude from trading (blacklist mode)
  ```bash
  KEEPER_BLACKLISTED_SYMBOLS=NVDA,EXPERIMENTAL
  ```
  Defaults to `NVDA` (experimental market). Blacklisted symbols are filtered out even during auto-discovery.

**Note**: If `KEEPER_SYMBOLS` is set, blacklist is still applied to filter out any blacklisted symbols from the whitelist.

### 4. Wallet Setup

**Two Separate Wallets Recommended**:

1. **Deployer Wallet** (`PRIVATE_KEY` in contracts/.env):
   - Deploys contracts
   - Becomes contract owner
   - Needs ETH for deployment gas

2. **Keeper Wallet** (`KEEPER_PRIVATE_KEY` in server/.env):
   - Executes rebalance transactions
   - Should be authorized as keeper: `strategy.setKeeper(keeperAddress, true)`
   - Needs small amount of ETH for gas only

---

## Security Best Practices

1. ✅ **Never commit `.env` files** to git
2. ✅ **Use separate wallets** for deployer and keeper
3. ✅ **Keep keeper wallet funded minimally** (0.01-0.1 ETH)
4. ✅ **Use environment-specific files** (.env.local, .env.production)
5. ✅ **Rotate keys periodically** if compromised
6. ✅ **Use hardware wallets** for deployer if possible

---

## Verification

After setting up `.env`, verify it works:

```bash
# Test database connection
psql -h $DB_HOST -U $DB_USERNAME -d $DB_DATABASE -c "SELECT 1;"

# Test RPC connection (if you have cast/forge)
cast block-number --rpc-url $RPC_URL

# Start bot (will fail gracefully if config is wrong)
pnpm run start:dev
```

---

## Troubleshooting

**"No private key provided"**:
- Check `KEEPER_PRIVATE_KEY` is set
- Remove `0x` prefix if present (or add it if missing)

**"Database connection failed"**:
- Verify PostgreSQL is running: `sudo systemctl status postgresql`
- Check credentials match your PostgreSQL setup
- Ensure database exists: `psql -l | grep bloom_bot`

**"RPC connection failed"**:
- Verify RPC URL is correct
- Check network connectivity
- Try alternative RPC endpoint

