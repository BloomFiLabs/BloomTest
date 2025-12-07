import { Injectable, Logger } from '@nestjs/common';
import { IPortfolioOptimizer, PortfolioOptimizationInput } from './IPortfolioOptimizer';
import { CostCalculator } from './CostCalculator';
import { HistoricalFundingRateService } from '../../../infrastructure/services/HistoricalFundingRateService';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { OrderType } from '../../value-objects/PerpOrder';

/**
 * Portfolio optimizer for funding arbitrage strategy
 * Calculates optimal position sizes and allocations across multiple opportunities
 */
@Injectable()
export class PortfolioOptimizer implements IPortfolioOptimizer {
  private readonly logger = new Logger(PortfolioOptimizer.name);

  constructor(
    private readonly costCalculator: CostCalculator,
    private readonly historicalService: HistoricalFundingRateService,
    private readonly config: StrategyConfig,
  ) {}

  async calculateMaxPortfolioForTargetAPY(
    opportunity: ArbitrageOpportunity,
    longBidAsk: { bestBid: number; bestAsk: number },
    shortBidAsk: { bestBid: number; bestAsk: number },
    targetNetAPY: number = 0.35,
  ): Promise<number | null> {
    const periodsPerYear = 24 * 365;

    // Get historical weighted average rates (more robust than current snapshot)
    const currentLongRate =
      opportunity.longRate !== undefined && !isNaN(opportunity.longRate)
        ? opportunity.longRate
        : 0;
    const currentShortRate =
      opportunity.shortRate !== undefined && !isNaN(opportunity.shortRate)
        ? opportunity.shortRate
        : 0;

    const historicalLongRate = this.historicalService.getWeightedAverageRate(
      opportunity.symbol,
      opportunity.longExchange,
      currentLongRate,
    );
    const historicalShortRate = this.historicalService.getWeightedAverageRate(
      opportunity.symbol,
      opportunity.shortExchange,
      currentShortRate,
    );

    // Get historical weighted average spread
    const historicalSpread = this.historicalService.getAverageSpread(
      opportunity.symbol,
      opportunity.longExchange,
      opportunity.symbol,
      opportunity.shortExchange,
      currentLongRate,
      currentShortRate,
    );

    // Use historical spread for initial gross APY calculation
    const grossAPY = Math.abs(historicalSpread) * periodsPerYear;

    if (grossAPY <= targetNetAPY) {
      return null; // Can't achieve target if gross APY is too low
    }

    // Get OI data
    const longOI = opportunity.longOpenInterest || 0;
    const shortOI = opportunity.shortOpenInterest || 0;
    const minOI = Math.min(longOI, shortOI);

    if (minOI <= 0) {
      return null; // Need OI data to calculate slippage
    }

    // Get fee rates from config
    const longFeeRate =
      this.config.exchangeFeeRates.get(opportunity.longExchange) || 0.0005;
    const shortFeeRate =
      this.config.exchangeFeeRates.get(opportunity.shortExchange) || 0.0005;
    const totalFeeRate = (longFeeRate + shortFeeRate) * 2; // Entry + exit fees for both legs

    // Binary search for max position size
    let low = 1000; // $1k minimum
    let high = Math.min(minOI * 0.1, 10000000); // Max 10% of OI or $10M
    let maxPortfolio: number | null = null;
    let finalEffectiveGrossAPY: number = 0;

    // Iterate to find max position size
    for (let iter = 0; iter < 50; iter++) {
      const testPosition = (low + high) / 2;

      // Calculate slippage for this position size
      const longSlippage = this.costCalculator.calculateSlippageCost(
        testPosition,
        longBidAsk.bestBid,
        longBidAsk.bestAsk,
        longOI,
        OrderType.LIMIT,
      );
      const shortSlippage = this.costCalculator.calculateSlippageCost(
        testPosition,
        shortBidAsk.bestBid,
        shortBidAsk.bestAsk,
        shortOI,
        OrderType.LIMIT,
      );
      const entrySlippage = longSlippage + shortSlippage;
      const exitSlippage = entrySlippage;
      const totalSlippageCost = entrySlippage + exitSlippage;

      // Calculate fees (entry + exit for both legs)
      const entryFees = testPosition * (longFeeRate + shortFeeRate);
      const exitFees = entryFees;
      const totalFees = entryFees + exitFees;

      // Calculate funding rate impact for this position size
      const longFundingImpact = this.costCalculator.predictFundingRateImpact(
        testPosition,
        longOI,
        historicalLongRate,
      );
      const shortFundingImpact = this.costCalculator.predictFundingRateImpact(
        testPosition,
        shortOI,
        historicalShortRate,
      );

      // Adjust funding rates based on our position impact
      const adjustedLongRate = historicalLongRate + longFundingImpact;
      const adjustedShortRate = historicalShortRate - shortFundingImpact;
      const adjustedSpread = Math.abs(adjustedLongRate - adjustedShortRate);
      const adjustedGrossAPY = adjustedSpread * periodsPerYear;
      const effectiveGrossAPY = adjustedGrossAPY;

      // Total one-time costs amortized over a year
      const totalOneTimeCosts = totalSlippageCost + totalFees;
      const amortizedCostsPerHour = totalOneTimeCosts / periodsPerYear;

      // Calculate net return per hour using adjusted gross APY
      const grossReturnPerHour =
        (effectiveGrossAPY / periodsPerYear) * testPosition;
      const netReturnPerHour = grossReturnPerHour - amortizedCostsPerHour;
      const netAPY =
        testPosition > 0
          ? (netReturnPerHour * periodsPerYear) / testPosition
          : 0;

      if (Math.abs(netAPY - targetNetAPY) < 0.001) {
        maxPortfolio = testPosition;
        finalEffectiveGrossAPY = effectiveGrossAPY;
        break;
      } else if (netAPY > targetNetAPY) {
        low = testPosition;
        maxPortfolio = testPosition;
        finalEffectiveGrossAPY = effectiveGrossAPY;
      } else {
        high = testPosition;
      }

      if (high - low < 100) {
        break; // Converged
      }
    }

    // Apply volatility-based portfolio size reduction
    if (maxPortfolio !== null && maxPortfolio > 0) {
      const volatilityMetrics =
        this.historicalService.getSpreadVolatilityMetrics(
          opportunity.symbol,
          opportunity.longExchange,
          opportunity.symbol,
          opportunity.shortExchange,
          30, // 30 days
        );

      if (volatilityMetrics) {
        const finalTestPosition = maxPortfolio;

        // Recalculate costs for final position size
        const finalLongSlippage = this.costCalculator.calculateSlippageCost(
          finalTestPosition,
          longBidAsk.bestBid,
          longBidAsk.bestAsk,
          longOI,
          OrderType.LIMIT,
        );
        const finalShortSlippage = this.costCalculator.calculateSlippageCost(
          finalTestPosition,
          shortBidAsk.bestBid,
          shortBidAsk.bestAsk,
          shortOI,
          OrderType.LIMIT,
        );
        const finalEntrySlippage = finalLongSlippage + finalShortSlippage;
        const finalExitSlippage = finalEntrySlippage;
        const finalTotalSlippageCost = finalEntrySlippage + finalExitSlippage;
        const finalEntryFees = finalTestPosition * (longFeeRate + shortFeeRate);
        const finalExitFees = finalEntryFees;
        const finalTotalFees = finalEntryFees + finalExitFees;
        const finalTotalOneTimeCosts = finalTotalSlippageCost + finalTotalFees;

        // Calculate hourly return for final position
        const finalHourlyReturn =
          (finalEffectiveGrossAPY / periodsPerYear) * finalTestPosition;
        const breakEvenHours =
          finalHourlyReturn > 0
            ? finalTotalOneTimeCosts / finalHourlyReturn
            : Infinity;

        // Volatility-based portfolio reduction factors
        const stabilityPenalty = 1 - volatilityMetrics.stabilityScore;

        const maxBreakEvenHours =
          volatilityMetrics.stabilityScore < 0.5 ? 24 : 48;
        const breakEvenPenalty =
          breakEvenHours > maxBreakEvenHours && breakEvenHours < Infinity
            ? Math.min(
                0.5,
                (breakEvenHours - maxBreakEvenHours) / maxBreakEvenHours,
              )
            : 0;

        const maxChangePenalty =
          volatilityMetrics.maxHourlySpreadChange > 0.0001
            ? Math.min(
                0.3,
                (volatilityMetrics.maxHourlySpreadChange - 0.0001) / 0.0002,
              )
            : 0;

        const reversalPenalty =
          volatilityMetrics.spreadReversals > 5
            ? Math.min(0.2, (volatilityMetrics.spreadReversals - 5) / 25)
            : 0;

        // Combine all penalties
        const totalVolatilityPenalty = Math.min(
          0.7,
          stabilityPenalty * 0.4 +
            breakEvenPenalty * 0.3 +
            maxChangePenalty * 0.2 +
            reversalPenalty * 0.1,
        );

        // Apply volatility reduction
        const volatilityAdjustedMaxPortfolio =
          maxPortfolio * (1 - totalVolatilityPenalty);

        // Ensure minimum portfolio size ($1k)
        const finalMaxPortfolio = Math.max(1000, volatilityAdjustedMaxPortfolio);

        return finalMaxPortfolio;
      }
    }

    return maxPortfolio;
  }

  async calculateOptimalAllocation(
    opportunities: PortfolioOptimizationInput[],
    totalCapital: number | null = null,
    targetAggregateAPY: number = 0.35,
  ): Promise<{
    allocations: Map<string, number>;
    totalPortfolio: number;
    aggregateAPY: number;
    opportunityCount: number;
    dataQualityWarnings: string[];
  }> {
    const dataQualityWarnings: string[] = [];

    // Filter to only opportunities that can achieve target APY AND have valid historical data
    const validOpportunities = opportunities.filter((item) => {
      if (
        item.maxPortfolioFor35APY === null ||
        item.maxPortfolioFor35APY === undefined ||
        item.maxPortfolioFor35APY <= 0
      ) {
        return false;
      }

      // Validate historical data quality
      const currentLongRate =
        item.opportunity.longRate !== undefined &&
        !isNaN(item.opportunity.longRate)
          ? item.opportunity.longRate
          : 0;
      const currentShortRate =
        item.opportunity.shortRate !== undefined &&
        !isNaN(item.opportunity.shortRate)
          ? item.opportunity.shortRate
          : 0;

      const historicalSpread = this.historicalService.getAverageSpread(
        item.opportunity.symbol,
        item.opportunity.longExchange,
        item.opportunity.symbol,
        item.opportunity.shortExchange,
        currentLongRate,
        currentShortRate,
      );

      const validation = this.validateHistoricalDataQuality(
        item.opportunity,
        historicalSpread,
      );
      if (!validation.isValid) {
        dataQualityWarnings.push(
          `${item.opportunity.symbol}: ${validation.reason}`,
        );
        return false;
      }

      return true;
    });

    if (validOpportunities.length === 0) {
      this.logger.warn(
        `No valid opportunities after filtering. ${dataQualityWarnings.length} opportunities excluded due to invalid spreads:`,
      );
      dataQualityWarnings.forEach((warning) =>
        this.logger.warn(`  - ${warning}`),
      );
      return {
        allocations: new Map(),
        totalPortfolio: 0,
        aggregateAPY: 0,
        opportunityCount: 0,
        dataQualityWarnings,
      };
    }

    if (dataQualityWarnings.length > 0) {
      this.logger.debug(
        `Data Quality: ${dataQualityWarnings.length} opportunities excluded due to invalid spreads`,
      );
      dataQualityWarnings.forEach((warning) =>
        this.logger.debug(`  - ${warning}`),
      );
    }

    const periodsPerYear = 24 * 365;
    const allocations = new Map<string, number>();

    // Calculate max total portfolio
    const maxTotalPortfolio = validOpportunities.reduce(
      (sum, item) => sum + (item.maxPortfolioFor35APY || 0),
      0,
    );

    // Binary search for optimal total portfolio size
    let low = 0;
    let high =
      totalCapital !== null
        ? Math.min(totalCapital, maxTotalPortfolio)
        : maxTotalPortfolio;
    let bestTotalPortfolio = 0;
    let bestAllocations = new Map<string, number>();
    let bestAggregateAPY = 0;

    for (let iter = 0; iter < 50; iter++) {
      const testTotalPortfolio = (low + high) / 2;

      // Calculate weights based on max portfolio sizes
      const weights = new Map<string, number>();
      const totalMaxPortfolio = validOpportunities.reduce(
        (sum, item) => sum + (item.maxPortfolioFor35APY || 0),
        0,
      );

      validOpportunities.forEach((item) => {
        const weight =
          totalMaxPortfolio > 0
            ? (item.maxPortfolioFor35APY || 0) / totalMaxPortfolio
            : 1 / validOpportunities.length;
        weights.set(item.opportunity.symbol, weight);
      });

      // Allocate proportionally, capped at each opportunity's max portfolio
      const testAllocations = new Map<string, number>();
      let actualTotalPortfolio = 0;

      validOpportunities.forEach((item) => {
        const weight = weights.get(item.opportunity.symbol) || 0;
        const baseAllocation = Math.min(
          testTotalPortfolio * weight,
          item.maxPortfolioFor35APY || 0,
        );

        // Apply data quality risk factor
        const dataQualityRiskFactor = this.calculateDataQualityRiskFactor(
          item.opportunity,
        );
        const allocation = baseAllocation * dataQualityRiskFactor;

        testAllocations.set(item.opportunity.symbol, allocation);
        actualTotalPortfolio += allocation;
      });

      // Calculate weighted average APY
      let totalWeightedReturn = 0;
      let totalAllocated = 0;

      testAllocations.forEach((allocation, symbol) => {
        if (allocation > 0) {
          const item = validOpportunities.find(
            (o) => o.opportunity.symbol === symbol,
          );
          if (item && item.maxPortfolioFor35APY) {
            const currentLongRate =
              item.opportunity.longRate !== undefined &&
              !isNaN(item.opportunity.longRate)
                ? item.opportunity.longRate
                : 0;
            const currentShortRate =
              item.opportunity.shortRate !== undefined &&
              !isNaN(item.opportunity.shortRate)
                ? item.opportunity.shortRate
                : 0;

            const historicalSpread = this.historicalService.getAverageSpread(
              item.opportunity.symbol,
              item.opportunity.longExchange,
              item.opportunity.symbol,
              item.opportunity.shortExchange,
              currentLongRate,
              currentShortRate,
            );

            const volatilityMetrics =
              this.historicalService.getSpreadVolatilityMetrics(
                item.opportunity.symbol,
                item.opportunity.longExchange,
                item.opportunity.symbol,
                item.opportunity.shortExchange,
                30,
              );

            const grossAPY = Math.abs(historicalSpread) * periodsPerYear;
            const maxPortfolio = item.maxPortfolioFor35APY;
            const allocationRatio = Math.min(allocation / maxPortfolio, 1);

            // Recalculate slippage and fees at actual allocation size
            const longFeeRate =
              this.config.exchangeFeeRates.get(item.opportunity.longExchange) ||
              0.0005;
            const shortFeeRate =
              this.config.exchangeFeeRates.get(item.opportunity.shortExchange) ||
              0.0005;
            const totalFeeRate = (longFeeRate + shortFeeRate) * 2;

            const longSlippage = this.costCalculator.calculateSlippageCost(
              allocation,
              item.longBidAsk.bestBid,
              item.longBidAsk.bestAsk,
              item.opportunity.longOpenInterest || 0,
              OrderType.LIMIT,
            );
            const shortSlippage = this.costCalculator.calculateSlippageCost(
              allocation,
              item.shortBidAsk.bestBid,
              item.shortBidAsk.bestAsk,
              item.opportunity.shortOpenInterest || 0,
              OrderType.LIMIT,
            );
            const totalSlippageCost = (longSlippage + shortSlippage) * 2;

            // Calculate funding rate impact
            const historicalLongRate =
              this.historicalService.getWeightedAverageRate(
                item.opportunity.symbol,
                item.opportunity.longExchange,
                item.opportunity.longRate || 0,
              );
            const historicalShortRate =
              this.historicalService.getWeightedAverageRate(
                item.opportunity.symbol,
                item.opportunity.shortExchange,
                item.opportunity.shortRate || 0,
              );

            const longFundingImpact = this.costCalculator.predictFundingRateImpact(
              allocation,
              item.opportunity.longOpenInterest || 0,
              historicalLongRate,
            );
            const shortFundingImpact = this.costCalculator.predictFundingRateImpact(
              allocation,
              item.opportunity.shortOpenInterest || 0,
              historicalShortRate,
            );

            const adjustedLongRate = historicalLongRate + longFundingImpact;
            const adjustedShortRate = historicalShortRate - shortFundingImpact;
            const adjustedSpread = Math.abs(
              adjustedLongRate - adjustedShortRate,
            );
            const adjustedGrossAPY = adjustedSpread * periodsPerYear;

            // Calculate net APY
            const totalOneTimeCosts =
              totalSlippageCost + allocation * totalFeeRate;
            const amortizedCostsPerHour = totalOneTimeCosts / periodsPerYear;
            const grossReturnPerHour =
              (adjustedGrossAPY / periodsPerYear) * allocation;
            const netReturnPerHour = grossReturnPerHour - amortizedCostsPerHour;
            let estimatedNetAPY =
              allocation > 0
                ? (netReturnPerHour * periodsPerYear) / allocation
                : 0;

            // Apply volatility risk adjustment
            if (volatilityMetrics) {
              const riskPenaltyFactor = 0.15;
              const riskDiscount =
                (1 - volatilityMetrics.stabilityScore) * riskPenaltyFactor;
              const zeroDropPenalty =
                volatilityMetrics.spreadDropsToZero > 0 ? 0.1 : 0;
              const reversalPenalty =
                volatilityMetrics.spreadReversals > 10 ? 0.05 : 0;

              const totalRiskDiscount = Math.min(
                0.3,
                riskDiscount + zeroDropPenalty + reversalPenalty,
              );
              estimatedNetAPY = estimatedNetAPY * (1 - totalRiskDiscount);
            }

            totalWeightedReturn += allocation * estimatedNetAPY;
            totalAllocated += allocation;
          }
        }
      });

      const aggregateAPY =
        totalAllocated > 0 ? totalWeightedReturn / totalAllocated : 0;

      if (Math.abs(aggregateAPY - targetAggregateAPY) < 0.001) {
        bestTotalPortfolio = actualTotalPortfolio;
        bestAllocations = testAllocations;
        bestAggregateAPY = aggregateAPY;
        break;
      } else if (aggregateAPY > targetAggregateAPY) {
        low = testTotalPortfolio;
        bestTotalPortfolio = actualTotalPortfolio;
        bestAllocations = testAllocations;
        bestAggregateAPY = aggregateAPY;
      } else {
        high = testTotalPortfolio;
      }

      if (high - low < 1000) {
        break; // Converged
      }
    }

    // Sanity check: cap at reasonable limit
    const MAX_REASONABLE_PORTFOLIO = 50_000_000;
    let finalPortfolio = bestTotalPortfolio;
    if (bestTotalPortfolio > MAX_REASONABLE_PORTFOLIO) {
      this.logger.warn(
        `Portfolio size ${bestTotalPortfolio.toLocaleString()} exceeds reasonable limit`,
      );
      finalPortfolio = MAX_REASONABLE_PORTFOLIO;
      const scaleFactor = MAX_REASONABLE_PORTFOLIO / bestTotalPortfolio;
      bestAllocations.forEach((amount, symbol) => {
        bestAllocations.set(symbol, amount * scaleFactor);
      });
    }

    return {
      allocations: bestAllocations,
      totalPortfolio: finalPortfolio,
      aggregateAPY: bestAggregateAPY,
      opportunityCount: Array.from(bestAllocations.values()).filter(
        (v) => v > 0,
      ).length,
      dataQualityWarnings,
    };
  }

  calculateDataQualityRiskFactor(opportunity: ArbitrageOpportunity): number {
    const longData = this.historicalService.getHistoricalData(
      opportunity.symbol,
      opportunity.longExchange,
    ) || [];
    const shortData = this.historicalService.getHistoricalData(
      opportunity.symbol,
      opportunity.shortExchange,
    ) || [];

    // Target: 168+ hourly points (7 days) or 21+ Aster points (7 days at 8-hour intervals)
    const longExchange = opportunity.longExchange;
    const shortExchange = opportunity.shortExchange;
    const targetLongPoints = longExchange === ExchangeType.ASTER ? 21 : 168;
    const targetShortPoints = shortExchange === ExchangeType.ASTER ? 21 : 168;

    // Calculate data quality score for each exchange (0-1)
    const longQuality = Math.min(1.0, longData.length / targetLongPoints);
    const shortQuality = Math.min(1.0, shortData.length / targetShortPoints);

    // Use minimum quality (both exchanges need good data)
    const minQuality = Math.min(longQuality, shortQuality);

    // Risk factor: 1.0 = full allocation (high quality), 0.3 = minimal allocation (very poor data)
    let riskFactor: number;
    if (minQuality < 0.1) {
      riskFactor = 0.3;
    } else if (minQuality < 0.5) {
      riskFactor = 0.3 + ((minQuality - 0.1) * (0.7 - 0.3)) / (0.5 - 0.1);
    } else {
      riskFactor = 0.7 + ((minQuality - 0.5) * (1.0 - 0.7)) / (1.0 - 0.5);
    }

    return Math.max(0.1, Math.min(1.0, riskFactor)); // Clamp between 0.1 and 1.0
  }

  validateHistoricalDataQuality(
    opportunity: ArbitrageOpportunity,
    historicalSpread: number,
  ): { isValid: boolean; reason?: string } {
    // Only reject if spread is obviously invalid (negative or impossibly high)
    const absSpread = Math.abs(historicalSpread);
    if (absSpread > 0.5) {
      return {
        isValid: false,
        reason: `Invalid historical spread: ${(historicalSpread * 100).toFixed(4)}% (exceeds 50% threshold)`,
      };
    }

    // Check if we have matched data points
    const currentSpread = Math.abs(
      opportunity.longRate - opportunity.shortRate,
    );
    if (Math.abs(historicalSpread - currentSpread) < 0.0000001) {
      return {
        isValid: false,
        reason: `No historical matched data (using current spread fallback)`,
      };
    }

    return { isValid: true };
  }
}

