# Delta-Neutral Funding Rate Strategy

## ⚠️ What Was Wrong Before

The previous `FundingRateStrategy` was running a **NAKED SHORT** at 30x leverage:

```
❌ NAKED SHORT (DANGEROUS)
- Position: SHORT 1.71 ETH @ 30x leverage
- Collateral: ~$166 USDC
- Liquidation: ~3.3% price move UP = LIQUIDATED 💀
- Risk: UNLIMITED if ETH pumps
```

**This is NOT what the Bloom Vault document specifies!**

---

## ✅ Correct Approach: Delta-Neutral Funding Carry

From **Bloom Vault Strategies Submission - Section 4**:

> "Spot-hedge perp carry: hold spot long + short perp to capture funding while staying delta-neutral"

### How It Works

```
DELTA-NEUTRAL POSITION
┌─────────────────────────────────────────────────────┐
│  SPOT LONG         +       PERP SHORT               │
│  Buy $500 ETH              Short $500 ETH @ 3x      │
│                                                     │
│  If ETH ↑ 10%:     Spot +$50    Perp -$50  = $0    │
│  If ETH ↓ 10%:     Spot -$50    Perp +$50  = $0    │
│                                                     │
│  PROFIT = Funding Rate Payments (when positive)     │
└─────────────────────────────────────────────────────┘
```

### Key Parameters (from Bloom doc)

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| **Leverage** | 1.5-3x MAX | Conservative, prevents liquidation |
| **Health Factor** | ≥ 1.5 | Safety buffer |
| **Entry Threshold** | >0.01%/8h | ~10-15% APR minimum |
| **Funding Drift Tol** | ±0.005%/8h | Rebalance trigger |
| **Active Time** | ≥80% | Strategy should be deployed most of time |

### Yield Composition

| Source | Expected APR |
|--------|--------------|
| Funding Carry | 10-25% |
| Leverage (3x) | x3 multiplier |
| Auto-Compounding | +2-5% |
| **Gross Target** | **30-45%** |

---

## Implementation Requirements

### 1. Spot Venue (to hold spot ETH)
Options:
- **HyperLiquid Spot** (if available)
- **Uniswap/DEX** on Base
- **Aave** (deposit ETH as collateral)

### 2. Perp Venue (to short ETH)
- **HyperLiquid Perps** ✅ (already integrated)

### 3. Risk Management
- Health factor monitoring every cycle
- Auto-deleverage if HF < 1.5
- Auto-close if funding flips negative
- Delta rebalancing if drift > 5%

---

## Comparison: Old vs New

| Aspect | Old (Naked Short) | New (Delta-Neutral) |
|--------|-------------------|---------------------|
| **Directional Risk** | UNLIMITED | ZERO |
| **Liquidation Risk** | HIGH (3.3% move) | LOW (HF ≥ 1.5) |
| **Leverage** | 30x 😱 | 3x max |
| **Profit Source** | Funding + Price | Funding ONLY |
| **Max Drawdown** | 100% | ~5-10% |

---

## Next Steps

1. **Implement Spot Executor** for HyperLiquid or Base DEX
2. **Integrate Health Factor Monitoring** from HyperLiquid
3. **Deploy Delta-Neutral Strategy** with conservative params
4. **Backtest** with historical funding rates

---

## Position Closed ✅

The previous 30x naked short has been closed:
```
TX: 0xf336603aa6d06e1bfb75daf15c265b6107f080ebace707ff0f956197f2aa236f
```

Strategy is now **DISABLED** in `strategies.json` until proper delta-neutral implementation is complete.










