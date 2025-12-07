import { Injectable, Logger } from '@nestjs/common';
import { IOpportunityEvaluator } from './IOpportunityEvaluator';
import {
  HistoricalFundingRateService,
  HistoricalMetrics,
} from '../../../infrastructure/services/HistoricalFundingRateService';
import { FundingRateAggregator } from '../FundingRateAggregator';
import { PositionLossTracker } from '../../../infrastructure/services/PositionLossTracker';
import { CostCalculator } from './CostCalculator';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { ArbitrageExecutionPlan } from '../FundingArbitrageStrategy';
import { PerpPosition } from '../../entities/PerpPosition';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';

/**
 * Opportunity evaluator for funding arbitrage strategy
 * Handles opportunity evaluation with historical data, worst-case selection, and rebalancing decisions
 */
@Injectable()
export class OpportunityEvaluator implements IOpportunityEvaluator {
  private readonly logger = new Logger(OpportunityEvaluator.name);

  constructor(
    private readonly historicalService: HistoricalFundingRateService,
    private readonly aggregator: FundingRateAggregator,
    private readonly lossTracker: PositionLossTracker,
    private readonly costCalculator: CostCalculator,
    private readonly config: StrategyConfig,
  ) {}

  evaluateOpportunityWithHistory(
    opportunity: ArbitrageOpportunity,
    plan: ArbitrageExecutionPlan | null,
  ): {
    breakEvenHours: number | null;
    historicalMetrics: {
      long: HistoricalMetrics | null;
      short: HistoricalMetrics | null;
    };
    worstCaseBreakEvenHours: number | null;
    consistencyScore: number;
  } {
    const longMetrics = this.historicalService.getHistoricalMetrics(
      opportunity.symbol,
      opportunity.longExchange,
    );
    const shortMetrics = this.historicalService.getHistoricalMetrics(
      opportunity.symbol,
      opportunity.shortExchange,
    );

    // Calculate consistency score (average of both exchanges)
    const consistencyScore =
      longMetrics && shortMetrics
        ? (longMetrics.consistencyScore + shortMetrics.consistencyScore) / 2
        : longMetrics?.consistencyScore || shortMetrics?.consistencyScore || 0;

    // Calculate worst-case break-even using minimum historical rates
    let worstCaseBreakEvenHours: number | null = null;
    if (plan && longMetrics && shortMetrics) {
      const periodsPerYear = 24 * 365;
      const worstCaseLongRate = longMetrics.minRate;
      const worstCaseShortRate = shortMetrics.minRate;
      const worstCaseSpread = Math.abs(worstCaseShortRate - worstCaseLongRate);
      const worstCaseAPY = worstCaseSpread * periodsPerYear;

      const avgMarkPrice =
        opportunity.longMarkPrice && opportunity.shortMarkPrice
          ? (opportunity.longMarkPrice + opportunity.shortMarkPrice) / 2
          : opportunity.longMarkPrice || opportunity.shortMarkPrice || 0;
      const positionSizeUsd = plan.positionSize * avgMarkPrice;
      const worstCaseHourlyReturn =
        (worstCaseAPY / periodsPerYear) * positionSizeUsd;

      if (worstCaseHourlyReturn > 0) {
        const totalCosts = plan.estimatedCosts.total;
        worstCaseBreakEvenHours = totalCosts / worstCaseHourlyReturn;
      }
    }

    return {
      breakEvenHours: plan ? null : (opportunity as any).breakEvenHours || null,
      historicalMetrics: {
        long: longMetrics,
        short: shortMetrics,
      },
      worstCaseBreakEvenHours,
      consistencyScore,
    };
  }

  async selectWorstCaseOpportunity(
    allOpportunities: Array<{
      opportunity: ArbitrageOpportunity;
      plan: ArbitrageExecutionPlan | null;
      netReturn: number;
      positionValueUsd: number;
      breakEvenHours: number | null;
    }>,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    maxPositionSizeUsd: number | undefined,
    exchangeBalances: Map<ExchangeType, number>,
  ): Promise<{
    opportunity: ArbitrageOpportunity;
    plan: ArbitrageExecutionPlan;
    reason: string;
  } | null> {
    if (allOpportunities.length === 0) {
      return null;
    }

    // Evaluate all opportunities with historical metrics
    const evaluated: Array<{
      opportunity: ArbitrageOpportunity;
      plan: ArbitrageExecutionPlan | null;
      historical: ReturnType<typeof this.evaluateOpportunityWithHistory>;
      score: number;
    }> = [];

    for (const item of allOpportunities) {
      if (!item.plan) continue; // Skip if no plan

      const historical = this.evaluateOpportunityWithHistory(
        item.opportunity,
        item.plan,
      );

      // Calculate score: (consistencyScore * avgHistoricalRate * liquidity) / worstCaseBreakEvenHours
      // Higher score = better worst-case opportunity
      const longMetrics = historical.historicalMetrics.long;
      const shortMetrics = historical.historicalMetrics.short;
      const avgHistoricalRate =
        longMetrics && shortMetrics
          ? (longMetrics.averageRate + shortMetrics.averageRate) / 2
          : 0;

      // Use open interest as liquidity proxy
      const longOI = item.opportunity.longOpenInterest || 0;
      const shortOI = item.opportunity.shortOpenInterest || 0;
      const minOI = Math.min(longOI, shortOI);
      // Normalize liquidity score: 0-1 scale based on OI (higher OI = better liquidity)
      const liquidity =
        minOI > 0
          ? Math.min(1, Math.max(0, Math.log10(Math.max(minOI / 1000, 1)) / 10))
          : 0.1; // Default low liquidity score if OI unavailable

      const worstCaseBreakEven = historical.worstCaseBreakEvenHours || Infinity;
      const score =
        worstCaseBreakEven < Infinity && worstCaseBreakEven > 0
          ? (historical.consistencyScore *
              Math.abs(avgHistoricalRate) *
              liquidity) /
            worstCaseBreakEven
          : 0;

      evaluated.push({
        opportunity: item.opportunity,
        plan: item.plan,
        historical,
        score,
      });
    }

    if (evaluated.length === 0) {
      return null;
    }

    // Sort by score (highest first)
    evaluated.sort((a, b) => b.score - a.score);
    const best = evaluated[0];

    // Only select if worst-case break-even is reasonable
    const worstCaseBreakEvenDays = best.historical.worstCaseBreakEvenHours
      ? best.historical.worstCaseBreakEvenHours / 24
      : Infinity;

    if (worstCaseBreakEvenDays > this.config.maxWorstCaseBreakEvenDays) {
      this.logger.warn(
        `Worst-case opportunity has break-even > ${this.config.maxWorstCaseBreakEvenDays} days, skipping`,
      );
      return null;
    }

    const reason =
      `Worst-case scenario selection: ` +
      `Consistency: ${(best.historical.consistencyScore * 100).toFixed(1)}%, ` +
      `Worst-case break-even: ${worstCaseBreakEvenDays.toFixed(1)} days, ` +
      `Score: ${best.score.toFixed(4)}`;

    this.logger.log(
      `🎯 Selected WORST-CASE opportunity: ${best.opportunity.symbol} - ${reason}`,
    );

    return {
      opportunity: best.opportunity,
      plan: best.plan!,
      reason,
    };
  }

  async shouldRebalance(
    currentPosition: PerpPosition,
    newOpportunity: ArbitrageOpportunity,
    newPlan: ArbitrageExecutionPlan,
    cumulativeLoss: number,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<{
    shouldRebalance: boolean;
    reason: string;
    currentBreakEvenHours: number | null;
    newBreakEvenHours: number | null;
  }> {
    // Get current position's funding rate
    let currentFundingRate = 0;
    try {
      const rates = await this.aggregator.getFundingRates(
        currentPosition.symbol,
      );
      const currentRate = rates.find(
        (r) => r.exchange === currentPosition.exchangeType,
      );
      if (currentRate) {
        currentFundingRate =
          currentPosition.side === OrderSide.LONG
            ? currentRate.currentRate
            : -currentRate.currentRate; // Flip for SHORT
      }
    } catch (error: any) {
      this.logger.debug(
        `Failed to get funding rate for current position: ${error.message}`,
      );
    }

    const avgMarkPrice = currentPosition.markPrice || 0;
    const positionValueUsd = currentPosition.size * avgMarkPrice;

    // Get current position's remaining break-even hours
    const currentBreakEvenData = this.lossTracker.getRemainingBreakEvenHours(
      currentPosition,
      currentFundingRate,
      positionValueUsd,
    );

    // Handle case where position was already closed
    const isPositionClosed =
      currentBreakEvenData.remainingBreakEvenHours === Infinity &&
      currentBreakEvenData.remainingCost === Infinity &&
      currentBreakEvenData.hoursHeld === 0;

    const currentBreakEvenHours =
      currentBreakEvenData.remainingBreakEvenHours === Infinity
        ? Infinity
        : currentBreakEvenData.remainingBreakEvenHours;

    // If position was already closed, treat it as if we have no outstanding costs
    const p1FeesOutstanding = isPositionClosed
      ? 0
      : currentBreakEvenData.remainingCost;

    // Calculate new position's hourly return
    const periodsPerYear = 24 * 365;
    const newPositionSizeUsd = newPlan.positionSize * avgMarkPrice;
    const newHourlyReturn =
      (newOpportunity.expectedReturn / periodsPerYear) * newPositionSizeUsd;

    // Calculate P2 costs (entry fees + exit fees + slippage)
    const p2EntryFees = newPlan.estimatedCosts.fees / 2; // Entry is half of total fees
    const p2ExitFees = newPlan.estimatedCosts.fees / 2; // Exit is half of total fees
    const p2Slippage = newPlan.estimatedCosts.slippage; // Slippage cost

    // Total costs for P2 = P1 fees outstanding + P2 entry fees + P2 exit fees + P2 slippage
    const totalCostsP2 =
      p1FeesOutstanding + p2EntryFees + p2ExitFees + p2Slippage;

    // Get switching costs breakdown for logging
    this.lossTracker.getSwitchingCosts(
      currentPosition,
      currentFundingRate,
      p2EntryFees,
      p2ExitFees,
      positionValueUsd,
    );

    // Calculate P2 time-to-break-even with all costs
    let p2TimeToBreakEven: number;
    if (newHourlyReturn <= 0) {
      p2TimeToBreakEven = Infinity;
    } else {
      p2TimeToBreakEven = totalCostsP2 / newHourlyReturn;
    }

    // Edge case 1: New position is instantly profitable
    if (newPlan.expectedNetReturn > 0) {
      this.logger.log(
        `✅ Rebalancing approved: New opportunity is instantly profitable ` +
          `(net return: $${newPlan.expectedNetReturn.toFixed(4)}/period)`,
      );
      return {
        shouldRebalance: true,
        reason: 'New opportunity is instantly profitable',
        currentBreakEvenHours:
          currentBreakEvenHours === Infinity ? null : currentBreakEvenHours,
        newBreakEvenHours: null, // Not applicable for profitable positions
      };
    }

    // Edge case 2: Current position already profitable
    if (currentBreakEvenData.remainingCost <= 0) {
      this.logger.log(
        `⏸️  Skipping rebalance: Current position already profitable ` +
          `(fees earned: $${currentBreakEvenData.feesEarnedSoFar.toFixed(4)} > costs: $${(currentBreakEvenData.remainingCost + currentBreakEvenData.feesEarnedSoFar).toFixed(4)})`,
      );
      return {
        shouldRebalance: false,
        reason:
          'Current position already profitable, new position not instantly profitable',
        currentBreakEvenHours: 0,
        newBreakEvenHours:
          p2TimeToBreakEven === Infinity ? null : p2TimeToBreakEven,
      };
    }

    // Edge case 3: Current position never breaks even
    if (currentBreakEvenHours === Infinity) {
      // Current position never breaks even, always rebalance if new one is better
      if (p2TimeToBreakEven < Infinity) {
        this.logger.log(
          `✅ Rebalancing approved: Current position never breaks even, ` +
            `new position has finite TTBE (${p2TimeToBreakEven.toFixed(2)}h)`,
        );
        return {
          shouldRebalance: true,
          reason:
            'Current position never breaks even, new position has finite break-even time',
          currentBreakEvenHours: null,
          newBreakEvenHours: p2TimeToBreakEven,
        };
      }
      // Both never break even - avoid churn
      this.logger.log(
        `⏸️  Skipping rebalance: Both positions never break even (avoiding churn)`,
      );
      return {
        shouldRebalance: false,
        reason: 'Both positions never break even',
        currentBreakEvenHours: null,
        newBreakEvenHours: null,
      };
    }

    // Edge case 4: New position never breaks even
    if (p2TimeToBreakEven === Infinity) {
      this.logger.log(
        `⏸️  Skipping rebalance: New position never breaks even ` +
          `(P1 remaining TTBE: ${currentBreakEvenHours.toFixed(2)}h)`,
      );
      return {
        shouldRebalance: false,
        reason: 'New position never breaks even',
        currentBreakEvenHours,
        newBreakEvenHours: null,
      };
    }

    // Main comparison: Compare P2 TTBE (with all costs) vs P1 remaining TTBE
    if (p2TimeToBreakEven < currentBreakEvenHours) {
      const hoursSaved = currentBreakEvenHours - p2TimeToBreakEven;
      const improvementPercent =
        ((currentBreakEvenHours - p2TimeToBreakEven) / currentBreakEvenHours) *
        100;

      this.logger.log(
        `✅ Rebalancing approved: P2 TTBE (${p2TimeToBreakEven.toFixed(2)}h) < P1 remaining TTBE (${currentBreakEvenHours.toFixed(2)}h) ` +
          `→ saves ${hoursSaved.toFixed(2)}h (${improvementPercent.toFixed(1)}% faster)`,
      );
      return {
        shouldRebalance: true,
        reason: `P2 TTBE (${p2TimeToBreakEven.toFixed(2)}h) < P1 remaining TTBE (${currentBreakEvenHours.toFixed(2)}h) - saves ${hoursSaved.toFixed(2)}h`,
        currentBreakEvenHours,
        newBreakEvenHours: p2TimeToBreakEven,
      };
    }

    // Not worth switching - P1 will break even faster
    const hoursLost = p2TimeToBreakEven - currentBreakEvenHours;
    this.logger.log(
      `⏸️  Skipping rebalance: P1 remaining TTBE (${currentBreakEvenHours.toFixed(2)}h) < P2 TTBE (${p2TimeToBreakEven.toFixed(2)}h) ` +
        `→ would lose ${hoursLost.toFixed(2)}h`,
    );
    return {
      shouldRebalance: false,
      reason: `P1 remaining TTBE (${currentBreakEvenHours.toFixed(2)}h) < P2 TTBE (${p2TimeToBreakEven.toFixed(2)}h)`,
      currentBreakEvenHours,
      newBreakEvenHours: p2TimeToBreakEven,
    };
  }
}

