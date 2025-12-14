# 📊 View Live Keeper Bot Logs

## 🎯 Watch Live Logs in Real-Time

### Option 1: Follow All Logs (Recommended)
```bash
cd /home/aurellius/Documents/Bloom/server
tail -f keeper-bot-live.log
```

**Press `Ctrl+C` to stop watching**

### Option 2: Live with Color (if installed)
```bash
tail -f keeper-bot-live.log | grep --color=always -E "Performance|NAV|APY|Rebalance|ERROR|WARN|"
```

### Option 3: Watch in Separate Terminal
```bash
# Open a new terminal and run:
watch -n 5 'tail -50 /home/aurellius/Documents/Bloom/server/keeper-bot-live.log'
```

---

## 📊 What You'll See

### Every 5 Minutes - Full Analysis Cycle:
```
🔄 ═══════════════════════════════════════════════════════════
🔄 Starting scheduled analysis...
🔄 ═══════════════════════════════════════════════════════════

Processing pool: ETH/USDC 0.05% (0xd0b53d9277642d899df5c87a3966a349a798f224)
Deribit IV for ETH: 79.42%
ETH/USDC 0.05% Analysis: HistVol=54.88%, GarchVol=53.22%, IV=79.42%, Hurst=0.44, Drift=4.66

═══════════════════════════════════════════════════════════
📊 PERFORMANCE METRICS: ETH/USDC 0.05%
═══════════════════════════════════════════════════════════
💰 Initial Deposit:        $38.94
📈 Current NAV:            $38.94
✨ Total Fees Earned:      $0.0000
⛽ Total Gas Costs:        $0.0000
💵 Net Profit:             $0.0000 (0.00% ROI)
───────────────────────────────────────────────────────────
📊 Daily APY:              0.00%
📊 Annualized APY:         0.00%
📅 Fees Per Day:           $0.0000
───────────────────────────────────────────────────────────
🔄 Rebalance Count:        0
⚡ Avg Rebalance Cost:     $0.0000
⏱️  Time Running:           4.25 hours
═══════════════════════════════════════════════════════════
```

### Every 5 Minutes - Compact Update:
```
📊 ─── Performance Update ───
💰 ETH/USDC 0.05% | NAV: $38.94 | P&L: $0.0014 (0.00%) | APY: 0.7% | Rebalances: 0 | Fees: $0.0014
```

### Every Minute (Background):
- Silent performance tracking
- Updates metrics
- No console output (efficient)

### When Rebalance Happens:
```
[TRIGGER] Price 3455.23 hit edge of range [3437, 3455]
Triggering rebalance for ETH/USDC 0.05% with range 0.45%
Rebalance transaction sent: 0x...
🔄 Rebalance #1 completed | Gas: $0.5234
```

---

## 🔍 Filtering Logs

### Show Only Performance Metrics
```bash
tail -f keeper-bot-live.log | grep -A 15 "PERFORMANCE METRICS"
```

### Show Only Rebalance Events
```bash
tail -f keeper-bot-live.log | grep -i "rebalance"
```

### Show Only Errors/Warnings
```bash
tail -f keeper-bot-live.log | grep -E "ERROR|WARN"
```

### Show Only NAV Changes
```bash
tail -f keeper-bot-live.log | grep "Current NAV"
```

---

## 📈 Performance Metrics Explained

### Real-Time Metrics Tracked:

| Metric | Description | Update Frequency |
|--------|-------------|------------------|
| **Current NAV** | Total value of strategy | Every 1 min |
| **Total Fees Earned** | LP fees + Aave interest | Every 1 min |
| **Net Profit** | NAV change + fees - gas | Every 1 min |
| **ROI** | Return on investment % | Every 1 min |
| **Daily APY** | APY based on actual time | Every 5 min (logged) |
| **Annualized APY** | Projected yearly return | Every 5 min (logged) |
| **Rebalance Count** | Number of rebalances | On rebalance |
| **Total Gas Costs** | Cumulative gas spent | On rebalance |
| **Fees Per Day** | Average daily fee earning | Every 5 min |

### Metrics Update Schedule:
- **Every 1 minute**: Background tracking (silent)
- **Every 5 minutes**: Compact log line
- **Every 5 minutes**: Full metrics with analysis cycle
- **On events**: Rebalance costs, triggers, errors

---

## 🎯 Quick Commands

### Check if Bot is Running
```bash
ps aux | grep "nest start" | grep -v grep
```

### Stop the Bot
```bash
pkill -f "nest start"
```

### Restart the Bot
```bash
cd /home/aurellius/Documents/Bloom/server
pkill -f "nest start"
sleep 2
npm run start:dev > keeper-bot-live.log 2>&1 &
```

### View Last 100 Lines
```bash
tail -100 keeper-bot-live.log
```

### Search for Specific Event
```bash
grep "rebalance" keeper-bot-live.log
grep "APY" keeper-bot-live.log | tail -10
```

---

## 🚀 Advanced: Multiple Terminal Setup

### Terminal 1: Live Logs
```bash
tail -f keeper-bot-live.log
```

### Terminal 2: Performance Only
```bash
watch -n 10 'tail -100 keeper-bot-live.log | grep -A 10 "PERFORMANCE METRICS" | tail -15'
```

### Terminal 3: System Monitor
```bash
watch -n 5 'ps aux | grep nest && echo "---" && cast call 0xAEF957078630051EBeCaC56a78125bf8C1e3Fa2b "totalAssets()(uint256)" --rpc-url https://mainnet.base.org'
```

---

## 📊 Expected Log Pattern

### Startup:
```
🚀 Keeper Bot initialized with performance tracking
📡 Connected to https://mainnet.base.org
Loaded strategy address from config: 0xAEF95...
```

### Every 5 Minutes:
```
[Analysis Cycle]
→ Market data fetch
→ Statistical analysis
→ Performance metrics
→ Decision logic
→ Compact summary
```

### On Price Movement:
```
[TRIGGER] Price hit edge
→ Calculate new range
→ Execute rebalance
→ Log gas cost
→ Update metrics
```

---

## 🎨 Log Format Key

- `🔄` = Analysis cycle
- `📊` = Performance metrics
- `💰` = Financial data
- `✨` = Fees earned
- `⛽` = Gas costs
- `🚀` = System startup
- `⚠️` = Warnings
- `❌` = Errors
- `✅` = Success

---

## 💡 Pro Tips

1. **Run in tmux/screen** for persistent logs
```bash
tmux new -s keeper
cd /home/aurellius/Documents/Bloom/server
npm run start:dev
# Press Ctrl+B then D to detach
# tmux attach -t keeper to reattach
```

2. **Log to file with timestamps**
```bash
npm run start:dev 2>&1 | ts '[%Y-%m-%d %H:%M:%S]' | tee keeper-bot-timestamped.log
```

3. **Auto-restart on crash** (with PM2)
```bash
npm install -g pm2
pm2 start "npm run start:dev" --name keeper-bot
pm2 logs keeper-bot
```

---

**Current Log File**: `/home/aurellius/Documents/Bloom/server/keeper-bot-live.log`

**To start watching NOW**:
```bash
cd /home/aurellius/Documents/Bloom/server
tail -f keeper-bot-live.log
```

Press `Ctrl+C` to stop watching (bot keeps running)

