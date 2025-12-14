## Rebalancer Logic

This note explains the mathematics and engineering behind the `TrendAwareStrategy` backtesting adapter and how those concepts translate to a production Uniswap v3 rebalancer. The goal is to give a blockchain engineer’s view of the “quant” layers without assuming a traditional finance background.

---

### 1. Inputs We Already Have

| Signal              | Source                                        | Purpose                              |
|---------------------|-----------------------------------------------|--------------------------------------|
| Hourly price series | Same OHLCV feed used for backtests            | Build rolling statistics             |
| Swap/gas costs      | Vault config or keeper cost model             | Net out rebalancing drag             |
| Position value      | Vault NAV allocation for this strategy        | Normalize costs/fees to percentages  |

We maintain a rolling 48-hour window (configurable) of hourly prices. Every heartbeat we recompute the stats below.

---

### 2. Hurst Exponent (Regime Detection)

**What:** A cheap way to tell if price is trending or mean-reverting.

**How:** Run Rescaled Range (R/S) analysis on the recent log prices:

1. Split the window into equal segments.
2. For each segment, compute the cumulative deviation from its mean.
3. Take the range of that cumulative series divided by the segment’s standard deviation (R/S ratio).
4. Regress `log(R/S)` on `log(window size)`; the slope is `H`.

**Interpretation:**

- `H ≈ 0.5` → random walk / chop
- `H < 0.45` → mean-reverting (tight, active ranges do well)
- `H > 0.55` → trending (price keeps running; ranges drift out)

We don’t hardcode decisions off `H` anymore; instead we feed the raw drift signal into the optimizer. But `H` tells us why the optimizer reacts the way it does.

---

### 3. Drift Velocity (Directional Speed)

While Hurst says “is there a trend?”, we also need “how fast is it moving?” We take the net log return over the window, annualize it, and clamp it to a max (5.0 = 500% APY equivalent) to protect the math:

```
totalRet   = |ln(price_end / price_start)|
hours      = windowLength
velocity   = min(5.0, totalRet / hours * 365 * 24)
```

This `velocity` feeds the deterministic exit rate in the optimizer: the faster the drift, the sooner a narrow range will be breached.

---

### 4. Volatility (Random Shake)

Using the same log returns:

```
mean      = avg(log returns)
variance  = avg((r - mean)^2)
volatility = sqrt(variance) * sqrt(365 * 24)   // annualized
```

Volatility drives the *diffusion* component of exit speed—how often you’ll leave the range purely from noise even without a trend.

---

### 5. Range Optimizer (Drift–Diffusion Model)

The `RangeOptimizer` scans candidate half-widths between 0.5% and 20% and picks the one that maximizes **net APY = (fee APR) − (rebalance cost drag)**.

#### 5.1 Fee Side

- Fee density grows super-linearly as you tighten the range (≈ width⁻¹·⁵).
- We scale by a time-in-range “efficiency ratio” to avoid assuming 100% uptime.
- Incentives/funding APR are simply additive.

#### 5.2 Cost Side

Expected rebalance frequency is the sum of:

```
diffusionRate ≈ volatility / width
driftRate     ≈ trendVelocity / width
rebalanceFrequency = diffusionRate + driftRate
```

Each rebalance burns:

```
costPerRebalance = gasCost + (positionValue * 0.5 * poolFeeTier)
annualCostDrag   = rebalanceFrequency * costPerRebalance / positionValue
```

Subtract that drag from the gross fee APR to get net APY. We brute-force the width that maximizes this metric.

---

### 6. Heartbeat Cadence

Once we know the optimal width, we schedule heartbeats:

- Tight range (< 10%) → check every 4h.
- Wide range (≥ 10%) → check every 12h.

This saves keeper gas in calm regimes while staying responsive when we’re running narrow.

---

### 7. Rebalance Trigger

We track the price where we last centered the position. On each heartbeat:

1. Compute % move since the last entry price.
2. Compare to `0.9 * activeRangeWidth * 100`.
3. If exceeded, flag `shouldRebalance` and emit a trade record (actual implementation would withdraw, swap, and redeposit).

This is equivalent to “price touched 90% of the band”, giving us a buffer for execution latency and sandwich protection.

---

### 8. Putting It All Together

1. **Ingestion:** Get price history, update volatility + drift.
2. **Solve:** Scan 0.5–20% widths, pick the one with highest net APY given current drift/diffusion and cost model.
3. **Schedule:** Set next heartbeat based on that width.
4. **Guard:** On heartbeat, check price drift vs. width, rebalance when the 90% edge is hit.

Because every step is deterministic and depends only on observable data (price history, cost estimates, allocation size), the strategy auto-tunes itself:

- Choppy periods → tighter ranges, more frequent but low-cost rebalances.
- Sustained trends → wider ranges, fewer rebalances, less gas burn.
- Cost spikes (gas or pool fees) → solver naturally widens to keep net APY positive.

This is the “rebalancer logic” that bridges quant intuition with an implementation you can unit test and deploy alongside the delta-neutral vault.



