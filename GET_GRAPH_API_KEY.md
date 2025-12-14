# 🔑 Get Your Graph API Key

The bot now uses The Graph's gateway endpoint which requires an API key for authentication.

## Quick Setup (2 minutes)

### Step 1: Get Your API Key

Visit: **https://thegraph.com/studio/apikeys/**

1. **Sign in** with your wallet or email
2. Click **"Create API Key"**
3. **Copy** the generated API key

### Step 2: Add to Environment

```bash
cd /home/aurellius/Documents/Bloom/server
nano .env
```

Find this line:
```bash
GRAPH_API_KEY=your_api_key_here
```

Replace with your actual key:
```bash
GRAPH_API_KEY=abcd1234yourrealkeyhere5678efgh
```

Save and exit (Ctrl+X, then Y, then Enter).

### Step 3: Restart the Bot

```bash
pkill -f "nest start"
npm run start:dev > keeper-bot.log 2>&1 &
```

### Step 4: Verify It Works

```bash
# Wait 10 seconds for startup
sleep 10

# Trigger analysis
curl -X POST http://localhost:3000/bot/analyze

# Check logs
tail -f keeper-bot.log
```

You should see:
- ✅ No more "auth error: missing authorization header"
- ✅ "Processing pool: ETH/USDC 0.05%"
- ✅ Volatility, Hurst, and MACD analysis results

---

## Alternative: Test Without API Key

If you want to test without getting an API key right away, you can use a public endpoint (may have rate limits):

```typescript
// In UniswapGraphAdapter.ts, temporarily use:
private readonly SUBGRAPH_URL = 'https://api.studio.thegraph.com/query/48211/uniswap-v3-base/version/latest';

// And remove the authorization header in constructor
```

But for production use, you should get an API key from The Graph.

---

## API Key Benefits

✅ **Higher rate limits** - More queries per second  
✅ **Better reliability** - Priority access  
✅ **Analytics** - Track your API usage  
✅ **Free tier available** - 100k queries/month free

---

## Updated Configuration

The bot is now configured to use:

**Endpoint**: `https://gateway.thegraph.com/api/subgraphs/id/HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1`

**Subgraph**: Uniswap V3 (Base Network)  
**Authorization**: Bearer token (your API key)

This endpoint provides:
- Real-time Uniswap V3 pool data on Base
- Historical hourly candles (OHLCV)
- Volume and liquidity metrics
- Supports all Base Uniswap pools

---

## Troubleshooting

### Still getting auth errors?
- Make sure you copied the entire API key
- Check there are no extra spaces or quotes
- Restart the bot after adding the key

### Rate limit errors?
- Upgrade your Graph API key plan
- Or reduce polling frequency in BotService

### Pool data not found?
- Ensure the pool address is correct
- Verify the pool exists on Base network
- Check if the pool has sufficient volume/liquidity

---

**Once you add your API key and restart, the bot will be fully operational!** 🚀

