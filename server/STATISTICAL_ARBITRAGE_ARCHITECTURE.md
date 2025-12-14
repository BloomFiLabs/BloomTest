# Statistical Arbitrage Architecture

## Overview

The Keeper Bot has been refactored from **reactive** threshold-based rebalancing to a **predictive** statistical arbitrage approach. Instead of waiting for negative events (price drift, time decay), the bot now uses leading indicators to preemptively adjust positioning.

## Paradigm Shift

| Feature | Previous (Reactive) | Current (Predictive) |
|---------|-------------------|---------------------|
| **Triggers** | Hard thresholds (Price ±X%, Time = 24h) | Probability signals (Vol > threshold, Trend strength) |
| **Cost Reality** | Pay for the move after drift occurred | Pay to position before the move |
| **Market View** | Agnostic (Price is random) | Opinionated (Price is Trending or Reverting) |
| **Logic Location** | Simple, verifiable on-chain | Complex ML/Stat models, off-chain |

## Three-Module Decision System

### Module A: Volatility Oracle (GARCH / IV)

**Question**: "Is the market about to get violent?"

**Logic**:
- Ingests Deribit Implied Volatility (IV) or runs GARCH model on recent price action
- If **Volatility Spike Predicted** (>100% annualized): Pre-emptively widen liquidity ranges
- If **Volatility Crushing** (<30% annualized): Narrow ranges to capture higher fees in tight zone

**Win**: Avoid "stopping out" (rebalancing into a falling knife) during choppy turbulence.

**Implementation**: `assessVolatilityRegime()` in `RebalanceDecisionEngine`

**Thresholds**:
- Significant mismatch: >25% difference between current and optimal range
- Confidence threshold: >60% to trigger rebalance

### Module B: Regime Classifier (Trend vs. Mean Reversion)

**Question**: "Is the price moving away permanently, or will it come back?"

**Logic using Hurst Exponent and MACD**:

#### Scenario 1: Mean Reversion
- **Conditions**: 
  - Hurst < 0.45 (mean-reverting)
  - MACD neutral
  - Price near edge (15-85%)
- **Action**: DON'T Rebalance. Wait for price to return to range.
- **Benefit**: Saves gas, avoids "selling the bottom"

#### Scenario 2: Trending
- **Conditions**:
  - Hurst > 0.55 OR MACD strength > 0.3
  - Price near edge (15-85%)
- **Action**: Rebalance IMMEDIATELY
- **Benefit**: Reduces drift (Impermanent Loss) by realigning with new trend faster

#### Scenario 3: Extreme Edge (Safety)
- **Conditions**: Price < 5% or > 95% of range
- **Action**: ALWAYS rebalance (safety override)
- **Confidence**: 95%

**Implementation**: `classifyRegime()` in `RebalanceDecisionEngine`

### Module C: Execution Optimization (Gas & Slippage)

**Question**: "Is this the cheapest moment to execute?"

**Logic**:
- On **L1 (Ethereum)**: Checks base_fee
- On **L2 (Base)**: Gas negligible, but checks liquidity depth
- **Action**: If slippage impact is high, wait for better conditions

**Implementation**: `assessExecutionTiming()` in `RebalanceDecisionEngine`

**Thresholds**:
- Gas spike: >1.0 gwei on Base (normal ~0.1 gwei)
- Preferred execution: Price centered (40-60% of range) for lower slippage

## Decision Priority Hierarchy

The `combineSignals()` method implements a clear priority hierarchy:

1. **Priority 1: Extreme Edge** (5-95%)
   - Always rebalance (safety override)
   - Confidence: 95%

2. **Priority 2: Strong Regime Signal** (>70% confidence)
   - If trending: Rebalance immediately
   - If mean-reverting: Wait for snap-back

3. **Priority 3: Volatility Regime Change** (>60% confidence)
   - Check execution timing
   - Adjust range if conditions favorable

4. **Default: No Rebalance**
   - All systems nominal

## Code Architecture

### New Components

1. **`RebalanceDecisionEngine`** (`server/src/domain/services/RebalanceDecisionEngine.ts`)
   - Injectable NestJS service
   - Combines volatility, regime, and execution signals
   - Returns `RebalanceDecision` with reason and confidence

2. **`RebalanceDecision` Interface**
   ```typescript
   interface RebalanceDecision {
     shouldRebalance: boolean;
     reason: string;
     confidence: number; // 0-1
     targetRangeWidth?: number;
   }
   ```

### Refactored Components

**`BotService`** (`server/src/application/services/BotService.ts`)
- Removed simple threshold logic (price ±10%, 30% range mismatch, etc.)
- Now calls `decisionEngine.decide()`
- Passes pre-calculated `pricePosition` and `currentRangeWidth` (no duplication)
- Logs decision reason and confidence for transparency

### Integration

The decision engine is provided via `DomainModule` and injected into `BotService`:

```typescript
constructor(
  @Inject('IMarketDataProvider') private readonly marketData: IMarketDataProvider,
  @Inject('IBotStateRepository') private readonly botStateRepo: IBotStateRepository,
  @Inject('IStrategyExecutor') private readonly executor: IStrategyExecutor,
  @Inject('IBlockchainAdapter') private readonly blockchain: IBlockchainAdapter,
  private readonly analyst: StatisticalAnalyst,
  private readonly optimizer: RangeOptimizer,
  private readonly decisionEngine: RebalanceDecisionEngine, // ← New
  private readonly deribit: DeribitAdapter,
) { ... }
```

## Benefits Over Reactive Approach

1. **Drift Reduction**: Catch trends early, reduce impermanent loss
2. **Gas Savings**: Avoid unnecessary rebalances during mean reversion
3. **Volatility Adaptive**: Pre-emptively widen ranges before turbulence
4. **Cost-Aware**: Only execute when conditions are favorable
5. **Transparent**: Every decision logged with reason and confidence

## Validation Strategy

### Backtest Comparison

1. **Baseline**: Run previous reactive logic (rebalance at 5% deviation or 24h) over 3 months
   - Record: Total Return, Max Drawdown, Total Fees Paid

2. **Inject Signals**: Run new predictive logic over same period
   - Compare: APY, Drift, Rebalance Frequency, Total Costs

3. **Decision**: Deploy if `Predictive_APY > Reactive_APY + Dev_Cost`

### Hypothesis

Alpha will NOT come from "saving gas" (on Base L2, gas is negligible).

Alpha will come from:
- **Drift Reduction**: Avoiding whipsaw rebalances
- **Trend Capture**: Catching breakouts earlier
- **Mean Reversion**: Waiting for price snap-back instead of panic selling

## Next Steps

1. ✅ Implement decision engine with three modules
2. ✅ Integrate into `BotService`
3. ✅ Add logging for transparency
4. ⏳ Run backtest comparison (Reactive vs Predictive)
5. ⏳ Tune thresholds based on backtest results
6. ⏳ Deploy to production with monitoring

## Key Metrics to Track

- **Rebalance Frequency**: Should decrease (fewer false positives)
- **Drift (IL)**: Should decrease (better trend detection)
- **APY**: Should increase (better fee capture + lower drift)
- **Confidence Distribution**: Track how often high-confidence decisions succeed
- **Regime Classification Accuracy**: Measure mean-reversion vs trending predictions

## File Reference

- **Decision Engine**: `server/src/domain/services/RebalanceDecisionEngine.ts`
- **Bot Service**: `server/src/application/services/BotService.ts`
- **Domain Module**: `server/src/domain/domain.module.ts`
- **Tests**: TBD (add unit tests for decision engine)


