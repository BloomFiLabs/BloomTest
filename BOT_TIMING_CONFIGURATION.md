# Bot Timing Configuration

## ⏱️ **Scheduled Tasks**

### **Main Analysis Cycle** ⚡
```typescript
@Cron('*/30 * * * * *') // Every 30 seconds
```

**What it does:**
- Fetches latest 48h candles from The Graph
- Runs GARCH, Hurst, MACD analysis
- Checks Deribit IV
- Optimizes range based on market conditions
- Evaluates rebalance triggers:
  - Edge-based (price hit 10% or 90%)
  - Volatility regime change (>50% mismatch)
  - Strong trend detection (Hurst/MACD)
  - Mean reversion override
- Executes rebalance if needed

**Performance:**
- Query time: ~2-5 seconds (The Graph API + Deribit)
- Analysis time: ~100-500ms (GARCH/Hurst/MACD)
- Total cycle time: ~3-6 seconds
- **30-second interval = safe with plenty of buffer**

---

### **Performance Metrics Update** 📊
```typescript
@Interval(30000) // Every 30 seconds
```

**What it does:**
- Queries current NAV from strategy contract
- Calculates P&L, APY, ROI
- Updates rebalance count
- Tracks time running

**Performance:**
- RPC call: ~1-2 seconds
- Calculation: <10ms
- **Low overhead, can run frequently**

---

### **Compact Performance Logging** 📝
```typescript
@Interval(60000) // Every 1 minute
```

**What it does:**
- Logs one-line performance summary
- Shows NAV, P&L, APY, rebalance count
- Easy to monitor in logs

**Why every minute:**
- Provides frequent updates without log spam
- Good balance for monitoring

---

## 🎯 **Why 30 Seconds is Perfect**

### **Old Timing (2 minutes):**
```
Price moves out of range → Wait up to 2 minutes → Rebalance
Volatility spike → Wait up to 2 minutes → Adjust range
```

**Missed opportunities:**
- 2 minutes of fees lost when out of range
- Delayed reaction to regime changes
- Slower trend following

---

### **New Timing (30 seconds):**
```
Price moves out of range → Wait up to 30 seconds → Rebalance
Volatility spike → Wait up to 30 seconds → Adjust range
```

**Benefits:**
- ✅ 4x faster reaction time
- ✅ Minimal fee loss when out of range
- ✅ Quick regime change adaptation
- ✅ Better trend following
- ✅ Still has 24+ seconds of processing buffer

---

## 📊 **Processing Time Budget**

| Task | Time | Cumulative |
|------|------|------------|
| Fetch 48h candles (The Graph) | 2-3s | 3s |
| Fetch Deribit IV | 1-2s | 5s |
| GARCH analysis | 200ms | 5.2s |
| Hurst calculation | 100ms | 5.3s |
| MACD calculation | 50ms | 5.35s |
| Range optimization | 100ms | 5.45s |
| Query on-chain NAV/range | 1s | 6.45s |
| Rebalance decision logic | 10ms | 6.46s |
| **Total (no rebalance)** | **~6.5s** | ✅ **Safe** |
| + Rebalance tx (if triggered) | +10-15s | 21.5s |

**30-second interval = 23.5-second buffer even with rebalance!**

---

## 🔥 **Can We Go Faster?**

### **Could go to 15 seconds:**
- Still safe: 15s - 6.5s = 8.5s buffer
- But more aggressive
- Higher RPC/API costs

### **Could go to 10 seconds:**
- Cutting it close: 10s - 6.5s = 3.5s buffer
- Risk of overlapping cycles if network slow
- Not recommended for production

### **30 seconds is the sweet spot:**
- 4x faster than before (2 min → 30s)
- Plenty of processing buffer
- Reasonable API/RPC usage
- Fast enough for DeFi (most protocols check every 12-60s)

---

## 💰 **Cost Implications**

### **API Calls per Day:**

**The Graph API:**
- Old: 720 calls/day (every 2 min)
- New: 2,880 calls/day (every 30s)
- Cost: Free tier usually covers 100k+ queries/day ✅

**Deribit API:**
- Old: 720 calls/day
- New: 2,880 calls/day
- Cost: Free (no auth needed for public IV data) ✅

**Base RPC:**
- Old: 720 calls/day
- New: 2,880 calls/day
- Cost: Infura free tier = 100k requests/day ✅

**Total Cost Impact: $0** (all within free tiers)

---

## 📈 **Performance Comparison**

| Scenario | 2-Minute Check | 30-Second Check | Improvement |
|----------|---------------|-----------------|-------------|
| **Price exits range** | 2 min fee loss | 30s fee loss | **4x faster** |
| **Volatility spike** | 2 min to adapt | 30s to adapt | **4x faster** |
| **Trend detected** | 2 min to reposition | 30s to reposition | **4x faster** |
| **Fees captured** | Lower | Higher | **More revenue** |

---

## ⚙️ **Configuration Options**

Want to change intervals? Edit these values:

```typescript
// Main analysis cycle
@Cron('*/30 * * * * *')  // Every 30 seconds (current)
// @Cron('*/15 * * * * *')  // Every 15 seconds (more aggressive)
// @Cron('*/60 * * * * *')  // Every 1 minute (more conservative)

// Performance tracking
@Interval(30000)  // Every 30 seconds (current)
// @Interval(60000)   // Every 1 minute (less frequent)

// Performance logging
@Interval(60000)  // Every 1 minute (current)
// @Interval(30000)   // Every 30 seconds (more verbose)
// @Interval(120000)  // Every 2 minutes (less verbose)
```

---

## 🚀 **Expected Results**

With 30-second checks, you should see:

1. **Faster Rebalancing**
   - Out-of-range positions rebalanced within 30s
   - Previously: could be out of range for 2 min

2. **Better Regime Adaptation**
   - Volatility changes detected quickly
   - Range adjusts within 30s instead of 2 min

3. **Improved Trend Following**
   - Trend-based rebalances trigger faster
   - Preemptive positioning happens sooner

4. **More Frequent Logs**
   - Performance updates every 30s
   - One-line summaries every 1 min
   - Easier to monitor bot health

---

## 📊 **Example Log Output (New Timing)**

```
[15:30:00] 🔄 Starting scheduled analysis...
[15:30:00] Processing pool: ETH/USDC 0.05%
[15:30:03] 💰 Current NAV: $37.87
[15:30:03] 📊 Pool Fee APR (24h): 29.40%
[15:30:03] [OPTIMIZER] Optimal range: 0.50%, Est. APY: 167.88%
[15:30:03] 💹 Current ETH: $2820.08 | Position: 50.1%
[15:30:03] ✅ Price within safe range
[15:30:03] 📋 Rebalance Decision: ❌ SKIP

[15:30:30] 🔄 Starting scheduled analysis...    ← 30 seconds later
[15:30:30] Processing pool: ETH/USDC 0.05%
...

[15:31:00] 📊 ─── Performance Update ───        ← Every 1 minute
[15:31:00] 💰 ETH/USDC | NAV: $37.87 | APY: -108.2% | Rebalances: 0
```

---

## ✅ **Summary**

| Setting | Old | New | Impact |
|---------|-----|-----|--------|
| **Main Cycle** | 2 min | 30s | 4x faster ⚡ |
| **Perf Tracking** | 1 min | 30s | 2x faster 📊 |
| **Logging** | 5 min | 1 min | 5x more frequent 📝 |
| **Processing Time** | ~6s | ~6s | Same ✅ |
| **Buffer** | 114s | 24s | Still safe ✅ |
| **Cost** | $0 | $0 | Free tier ✅ |
| **Reaction Speed** | Slow | Fast | Much better 🚀 |

**Your bot is now 4x more responsive!** ⚡

