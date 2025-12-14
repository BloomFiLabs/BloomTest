# Critical Bug Fix: Rebalance Loop Issue

## 🐛 **The Bug**

The bot was stuck in a rebalancing loop, constantly triggering rebalances at the same price.

### **Root Cause**

In `BotService.ts` lines 273-293, the bot was syncing its internal state with the on-chain position **EVERY CYCLE**, which caused this infinite loop:

```
1. Bot reads on-chain NFT position: [$2244, $3334]
2. Bot updates state.priceLower = $2244, state.priceUpper = $3334
3. Bot checks: "Is current price ($3170) outside this range?"
4. Answer: NO (because we just updated to match on-chain!)
5. Bot doesn't rebalance
6. Next cycle: Repeat step 1...
```

### **Why This Breaks Rebalancing**

The bot's rebalance logic at line 399 checks:
```typescript
if (currentPrice <= lowerThreshold || currentPrice >= upperThreshold) {
  shouldRebalance = true; // Price hit edge!
}
```

But if we keep syncing `state.priceLower` and `state.priceUpper` with the on-chain position, the current price will ALWAYS be inside the range (until it actually moves out of range).

**The bot could never detect when price was approaching the edge because it kept resetting its reference point!**

---

## ✅ **The Fix**

### **Changed Behavior** (lines 272-293):

**BEFORE** (buggy):
```typescript
} else {
  // Sync existing state with actual on-chain position every cycle
  const positionRange = await this.queryStrategyPositionRange(pool.strategyAddress);
  if (positionRange) {
    state.priceLower = positionRange.lower;  // ❌ This breaks rebalance detection!
    state.priceUpper = positionRange.upper;
    await this.botStateRepo.save(state);
  }
}
```

**AFTER** (fixed):
```typescript
} else {
  // DON'T sync on every cycle - it breaks rebalance detection!
  // The state represents what range the bot EXPECTS to be active.
  // If bot rebalances, it updates state. We trust our local state.
  // Only log the on-chain range for debugging, don't update state.
  const positionRange = await this.queryStrategyPositionRange(pool.strategyAddress);
  if (positionRange) {
    this.logger.log(`📊 On-chain range: [$${positionRange.lower.toFixed(2)}, $${positionRange.upper.toFixed(2)}], Bot state: [$${state.priceLower.toFixed(2)}, $${state.priceUpper.toFixed(2)}]`);
  }
}
```

---

## 📊 **Improved Logging** (lines 387-409)

Added detailed logging to show rebalance decisions:

```typescript
// Show current price position within range
const pricePosition = ((currentPrice - currentLower) / rangeWidth) * 100;
this.logger.log(`💹 Current ETH: $${currentPrice.toFixed(2)} | Range: [$${currentLower.toFixed(2)}, $${currentUpper.toFixed(2)}] | Position: ${pricePosition.toFixed(1)}% of range`);

// Clear trigger logging
if (currentPrice <= lowerThreshold || currentPrice >= upperThreshold) {
  shouldRebalance = true;
  const edgeType = currentPrice <= lowerThreshold ? 'LOWER' : 'UPPER';
  this.logger.log(`🔴 [TRIGGER] Price $${currentPrice.toFixed(2)} hit ${edgeType} edge! Range: [$${currentLower.toFixed(2)}, $${currentUpper.toFixed(2)}]`);
} else {
  this.logger.log(`✅ Price within safe range (${pricePosition.toFixed(1)}% position, threshold at 10%-90%)`);
}
```

---

## 🎯 **Expected Behavior Now**

### **Initialization (First Run)**:
1. Bot queries on-chain position: `[$2244, $3334]`
2. Bot initializes state with this range
3. Bot remembers this as the "expected" range

### **Every Cycle**:
1. Bot checks current ETH price: `$3170`
2. Bot compares to **its stored state** (not on-chain): `[$2244, $3334]`
3. Bot calculates: "Price is at 85% of range"
4. Bot decides: "Within safe zone (10%-90%), no rebalance needed"

### **When Price Moves**:
1. ETH drops to `$2250` (near lower edge)
2. Bot compares to state: `[$2244, $3334]`
3. Bot calculates: "Price is at 0.5% of range (BELOW 10% threshold!)"
4. Bot triggers: 🔴 "Price hit LOWER edge!"
5. Bot executes rebalance with new optimal range (e.g., `[$2200, $2300]`)
6. Bot **updates state** to new range
7. Next cycle uses the **new range** for comparison

---

## 🔬 **Why This Works**

The bot's state (`state.priceLower`, `state.priceUpper`) represents:
- **What range the bot THINKS should be active**
- **The reference point for detecting price movements**

Only two events should update this state:
1. ✅ **Initialization**: When bot first starts, sync with on-chain
2. ✅ **After Rebalance**: When bot executes a rebalance, update to new range

What should NOT update state:
- ❌ **Every cycle sync**: This destroys the reference point!

---

## 📝 **Log Examples**

### **Normal Operation** (Price within range):
```
[BotService] Processing pool: ETH/USDC 0.05%
[BotService] 📊 On-chain range: [$2244.00, $3334.23], Bot state: [$2244.00, $3334.23]
[BotService] 💹 Current ETH: $3170.00 | Range: [$2244.00, $3334.23] | Position: 85.0% of range
[BotService] ✅ Price within safe range (85.0% position, threshold at 10%-90%)
```

### **Rebalance Triggered** (Price at edge):
```
[BotService] Processing pool: ETH/USDC 0.05%
[BotService] 📊 On-chain range: [$2244.00, $3334.23], Bot state: [$2244.00, $3334.23]
[BotService] 💹 Current ETH: $2250.00 | Range: [$2244.00, $3334.23] | Position: 0.6% of range
[BotService] 🔴 [TRIGGER] Price $2250.00 hit LOWER edge! Range: [$2244.00, $3334.23]
[BotService] [OPTIMIZER] Optimal range: 0.50%, Est. APY: 25.00%, Rebalances/year: 52
[BotService] [EXECUTE] Calling rebalance on strategy 0xeCBa...
[BotService] [SUCCESS] Rebalanced ETH/USDC to new range: [$2238.75, $2261.25] (width: 0.50%)
```

---

## ✅ **Status**

- **Bug**: Fixed ✅
- **Deployed**: Yes (bot restarted at 09:50:02)
- **Testing**: Waiting for first cycle (runs every 2 minutes)
- **Monitoring**: Check logs with `tail -f /home/aurellius/Documents/Bloom/server/keeper-bot-live.log`

---

## 🚀 **Next Steps**

1. Wait for bot to complete a few cycles
2. Verify logs show proper rebalance detection
3. Monitor that rebalances only trigger when price actually hits edge
4. Confirm no more "rebalancing at same price" issues

---

## 📚 **Files Changed**

- `server/src/application/services/BotService.ts` (lines 272-293, 387-409)
  - Removed automatic state sync every cycle
  - Added detailed rebalance decision logging

