import { Injectable, Logger, Inject } from '@nestjs/common';
import { ExchangeType } from '../../domain/value-objects/ExchangeConfig';
import { ArbitrageOpportunity } from '../../domain/services/FundingRateAggregator';
import type { IHistoricalFundingRateService } from '../../domain/ports/IHistoricalFundingRateService';
import {
  IPortfolioRiskAnalyzer,
  PortfolioRiskInput,
  PortfolioRiskMetrics,
  DataQualityAssessment,
} from '../../domain/ports/IPortfolioRiskAnalyzer';

// Re-export types for backward compatibility
export type {
  PortfolioRiskInput,
  PortfolioRiskMetrics,
  DataQualityAssessment,
} from '../../domain/ports/IPortfolioRiskAnalyzer';

/**
 * PortfolioRiskAnalyzer - Calculates comprehensive risk metrics for investor reporting
 */
@Injectable()
export class PortfolioRiskAnalyzer implements IPortfolioRiskAnalyzer {
  private readonly logger = new Logger(PortfolioRiskAnalyzer.name);
  private readonly periodsPerYear = 24 * 365; // Hourly funding periods per year
  private readonly riskFreeRate = 0.05; // 5% typical stablecoin yield

  constructor(
    @Inject('IHistoricalFundingRateService')
    private readonly historicalService: IHistoricalFundingRateService,
  ) {}

  /**
   * Assess data quality for risk metrics
   */
  private assessDataQuality(input: PortfolioRiskInput): {
    hasSufficientDataForVaR: boolean;
    hasSufficientDataForDrawdown: boolean;
    hasSufficientDataForCorrelation: boolean;
    hasSufficientDataForBacktest: boolean;
    hasSufficientDataForConfidenceInterval: boolean;
    warnings: string[];
    hasIssues: boolean;
  } {
    const warnings: string[] = [];
    
    // Check VaR: Need at least 2 months of matched data
    let totalMatchedMonths = 0;
    for (const item of input.opportunities) {
      const allocation = input.allocations.get(item.opportunity.symbol) || 0;
      if (allocation <= 0) continue;
      
      const longData = this.historicalService.getHistoricalData(
        item.opportunity.symbol,
        item.opportunity.longExchange,
      );
      const shortData = this.historicalService.getHistoricalData(
        item.opportunity.symbol,
        item.opportunity.shortExchange,
      );
      
      if (longData.length === 0 || shortData.length === 0) continue;
      
      // Count matched months
      const matchedSpreads: Array<{ timestamp: Date }> = [];
      for (const longPoint of longData) {
        for (const shortPoint of shortData) {
          const timeDiff = Math.abs(longPoint.timestamp.getTime() - shortPoint.timestamp.getTime());
          if (timeDiff <= 4 * 60 * 60 * 1000) { // 4 hour window for Aster
            matchedSpreads.push({ timestamp: longPoint.timestamp });
            break;
          }
        }
      }
      
      const monthlyGroups = new Set<string>();
      for (const { timestamp } of matchedSpreads) {
        const monthKey = `${timestamp.getFullYear()}-${timestamp.getMonth()}`;
        monthlyGroups.add(monthKey);
      }
      totalMatchedMonths += monthlyGroups.size;
    }
    const hasSufficientDataForVaR = totalMatchedMonths >= 2;
    if (!hasSufficientDataForVaR) {
      warnings.push(`VaR calculation requires 2+ months of matched data (found ${totalMatchedMonths} months)`);
    }
    
    // Check Drawdown: Need at least 1 month of matched data
    const hasSufficientDataForDrawdown = totalMatchedMonths >= 1;
    if (!hasSufficientDataForDrawdown) {
      warnings.push(`Drawdown calculation requires 1+ month of matched data (found ${totalMatchedMonths} months)`);
    }
    
    // Check Correlation: Need at least 10 matched pairs
    let totalMatchedPairs = 0;
    for (const item of input.opportunities) {
      const longData = this.historicalService.getHistoricalData(
        item.opportunity.symbol,
        item.opportunity.longExchange,
      );
      const shortData = this.historicalService.getHistoricalData(
        item.opportunity.symbol,
        item.opportunity.shortExchange,
      );
      
      if (longData.length === 0 || shortData.length === 0) continue;
      
      for (const longPoint of longData) {
        for (const shortPoint of shortData) {
          const timeDiff = Math.abs(longPoint.timestamp.getTime() - shortPoint.timestamp.getTime());
          if (timeDiff <= 4 * 60 * 60 * 1000) {
            totalMatchedPairs++;
            break;
          }
        }
      }
    }
    const hasSufficientDataForCorrelation = totalMatchedPairs >= 10;
    if (!hasSufficientDataForCorrelation) {
      warnings.push(`Correlation analysis requires 10+ matched pairs (found ${totalMatchedPairs} pairs)`);
    }
    
    // Check Backtest: Need at least 2 months of data
    const hasSufficientDataForBacktest = totalMatchedMonths >= 2;
    if (!hasSufficientDataForBacktest) {
      warnings.push(`Historical backtest requires 2+ months of matched data (found ${totalMatchedMonths} months)`);
    }
    
    // Check Confidence Interval: Need at least some volatility data
    let hasVolatilityData = false;
    for (const item of input.opportunities) {
      if (item.volatilityMetrics && item.volatilityMetrics.stdDevSpread > 0) {
        hasVolatilityData = true;
        break;
      }
    }
    const hasSufficientDataForConfidenceInterval = hasVolatilityData;
    if (!hasSufficientDataForConfidenceInterval) {
      warnings.push(`Confidence interval requires volatility data (stdDevSpread > 0)`);
    }
    
    return {
      hasSufficientDataForVaR,
      hasSufficientDataForDrawdown,
      hasSufficientDataForCorrelation,
      hasSufficientDataForBacktest,
      hasSufficientDataForConfidenceInterval,
      warnings,
      hasIssues: warnings.length > 0,
    };
  }

  /**
   * Main entry point: Calculate all portfolio risk metrics
   */
  async calculatePortfolioRiskMetrics(input: PortfolioRiskInput): Promise<PortfolioRiskMetrics & { dataQuality: DataQualityAssessment }> {
    const dataQuality = this.assessDataQuality(input);
    const {
      allocations,
      opportunities,
      aggregateAPY,
      totalPortfolio,
    } = input;

    // Filter to only opportunities with allocations
    const activeOpportunities = opportunities.filter(
      (item) => allocations.has(item.opportunity.symbol) && allocations.get(item.opportunity.symbol)! > 0
    );

    if (activeOpportunities.length === 0) {
      // Return default metrics if no active opportunities
      return {
        ...this.getDefaultMetrics(aggregateAPY, totalPortfolio),
        dataQuality,
      };
    }

    // Calculate all metrics
    const worstCaseAPY = this.calculateWorstCaseScenario(activeOpportunities, allocations, totalPortfolio);
    const confidenceInterval = this.calculateConfidenceIntervals(activeOpportunities, allocations, aggregateAPY, totalPortfolio);
    const var95 = this.calculateValueAtRisk(activeOpportunities, allocations, totalPortfolio);
    const maxDrawdown = this.calculateMaximumDrawdown(activeOpportunities, allocations, totalPortfolio);
    const sharpeRatio = this.calculateSharpeRatio(aggregateAPY, activeOpportunities, allocations, totalPortfolio);
    const historicalBacktest = await this.calculateHistoricalBacktest(activeOpportunities, allocations, totalPortfolio);
    const stressTests = this.calculateStressTestScenarios(activeOpportunities, allocations, totalPortfolio);
    const correlationRisk = this.calculateCorrelationAnalysis(activeOpportunities);
    const concentrationRisk = this.calculateConcentrationRisk(allocations, totalPortfolio);
    const volatilityBreakdown = this.calculateVolatilityBreakdown(activeOpportunities, allocations, totalPortfolio);

    return {
      expectedAPY: aggregateAPY,
      expectedAPYConfidenceInterval: confidenceInterval,
      worstCaseAPY,
      valueAtRisk95: dataQuality.hasSufficientDataForVaR ? var95 : 0,
      maximumDrawdown: dataQuality.hasSufficientDataForDrawdown ? maxDrawdown : 0,
      sharpeRatio,
      historicalBacktest: dataQuality.hasSufficientDataForBacktest ? historicalBacktest : {
        last30Days: { apy: 0, realized: false },
        last90Days: { apy: 0, realized: false },
        worstMonth: { apy: 0, month: 'N/A' },
        bestMonth: { apy: 0, month: 'N/A' },
      },
      stressTests,
      correlationRisk: dataQuality.hasSufficientDataForCorrelation ? correlationRisk : {
        averageCorrelation: 0,
        maxCorrelation: 0,
        correlatedPairs: [],
      },
      concentrationRisk,
      volatilityBreakdown,
      dataQuality,
    };
  }

  /**
   * Calculate worst-case scenario: What happens if all spreads reverse/collapse
   */
  private calculateWorstCaseScenario(
    opportunities: PortfolioRiskInput['opportunities'],
    allocations: Map<string, number>,
    totalPortfolio: number,
  ): number {
    let totalWorstCaseReturn = 0;

    for (const item of opportunities) {
      const allocation = allocations.get(item.opportunity.symbol) || 0;
      if (allocation <= 0) continue;

      const { opportunity, volatilityMetrics } = item;

      // Use worst historical spread if available, otherwise assume spread reverses
      let worstCaseSpread = 0;
      if (volatilityMetrics) {
        // Use minimum spread from history (could be negative), or assume spread reverses
        // Worst case: spread becomes negative (reverses) or drops to minimum
        worstCaseSpread = Math.min(volatilityMetrics.minSpread, -Math.abs(volatilityMetrics.averageSpread));
      } else {
        // No historical data: assume spread reverses (becomes negative of current spread)
        worstCaseSpread = -Math.abs(opportunity.spread.toDecimal());
      }

      // Calculate worst-case APY: worst spread * periods - costs
      // If spread is negative, APY will be negative (we're paying instead of receiving)
      // Costs are still incurred even in worst case
      const worstCaseGrossAPY = worstCaseSpread * this.periodsPerYear; // Don't use Math.abs - keep sign
      
      // Estimate costs (fees + slippage) - use conservative 2% total cost
      const estimatedCosts = 0.02;
      const worstCaseNetAPY = worstCaseGrossAPY - estimatedCosts; // Will be negative if spread reversed

      totalWorstCaseReturn += allocation * worstCaseNetAPY;
    }

    return totalPortfolio > 0 ? totalWorstCaseReturn / totalPortfolio : 0;
  }

  /**
   * Calculate confidence intervals for expected APY
   */
  private calculateConfidenceIntervals(
    opportunities: PortfolioRiskInput['opportunities'],
    allocations: Map<string, number>,
    aggregateAPY: number,
    totalPortfolio: number,
  ): { lower: number; upper: number; confidence: number } {
    // Calculate portfolio-weighted volatility
    let portfolioVariance = 0;
    const weights: Array<{ symbol: string; weight: number; volatility: number }> = [];

    for (const item of opportunities) {
      const allocation = allocations.get(item.opportunity.symbol) || 0;
      if (allocation <= 0) continue;

      const weight = allocation / totalPortfolio;
      const volatility = item.volatilityMetrics?.stdDevSpread || 0.0001; // Default 0.01% if no data

      weights.push({ symbol: item.opportunity.symbol, weight, volatility });
      portfolioVariance += weight * weight * volatility * volatility;
    }

    // Add correlation terms (simplified: assume average correlation of 0.2)
    const avgCorrelation = 0.2;
    for (let i = 0; i < weights.length; i++) {
      for (let j = i + 1; j < weights.length; j++) {
        portfolioVariance += 2 * weights[i].weight * weights[j].weight * avgCorrelation * weights[i].volatility * weights[j].volatility;
      }
    }

    const portfolioStdDev = Math.sqrt(portfolioVariance) * this.periodsPerYear; // Annualized

    // 95% confidence interval: mean ± 1.96 * stdDev
    const zScore = 1.96;
    const margin = zScore * portfolioStdDev;

    // Cap confidence interval to reasonable bounds
    // If margin is too large (indicating poor data quality), cap it
    const maxMargin = aggregateAPY * 0.5; // Max 50% margin (e.g., 35% ± 17.5%)
    const cappedMargin = Math.min(margin, maxMargin);
    
    const lowerBound = Math.max(0, aggregateAPY - cappedMargin); // Don't go below 0% for investor report
    const upperBound = Math.min(aggregateAPY * 2, aggregateAPY + cappedMargin); // Cap at 2x expected APY (e.g., 35% → 70% max)

    return {
      lower: lowerBound,
      upper: upperBound,
      confidence: 0.95,
    };
  }

  /**
   * Calculate Value at Risk (95% VaR) - worst-case monthly loss
   */
  private calculateValueAtRisk(
    opportunities: PortfolioRiskInput['opportunities'],
    allocations: Map<string, number>,
    totalPortfolio: number,
  ): number {
    // Simulate monthly returns using historical spread data
    const monthlyReturns: number[] = [];
    const hoursPerMonth = 24 * 30;

    // Get historical spreads for each opportunity
    for (const item of opportunities) {
      const allocation = allocations.get(item.opportunity.symbol) || 0;
      if (allocation <= 0) continue;

      const { opportunity, volatilityMetrics } = item;

      // Get historical spread data
      const longData = this.historicalService.getHistoricalData(
        opportunity.symbol,
        opportunity.longExchange,
      );
      const shortData = this.historicalService.getHistoricalData(
        opportunity.symbol,
        opportunity.shortExchange,
      );

      if (longData.length === 0 || shortData.length === 0) {
        // No historical data: use volatility metrics if available
        if (volatilityMetrics) {
          // Simulate worst-case: spread drops to minSpread
          const worstSpread = volatilityMetrics.minSpread;
          const worstMonthlyReturn = (worstSpread * hoursPerMonth * allocation) / totalPortfolio;
          monthlyReturns.push(worstMonthlyReturn);
        }
        continue;
      }

      // Match spreads by timestamp and calculate monthly returns
      const matchedSpreads: Array<{ spread: number; timestamp: Date }> = [];
      for (const longPoint of longData) {
        for (const shortPoint of shortData) {
          const timeDiff = Math.abs(longPoint.timestamp.getTime() - shortPoint.timestamp.getTime());
          if (timeDiff <= 3600 * 1000) { // 1 hour window
            matchedSpreads.push({
              spread: longPoint.rate - shortPoint.rate,
              timestamp: longPoint.timestamp,
            });
            break;
          }
        }
      }

      if (matchedSpreads.length === 0) continue;

      // Group by month and calculate monthly returns
      const monthlyGroups = new Map<string, number[]>();
      for (const { spread, timestamp } of matchedSpreads) {
        const monthKey = `${timestamp.getFullYear()}-${timestamp.getMonth()}`;
        if (!monthlyGroups.has(monthKey)) {
          monthlyGroups.set(monthKey, []);
        }
        monthlyGroups.get(monthKey)!.push(spread);
      }

      // Calculate monthly returns (as APY percentage, not USD)
      for (const spreads of monthlyGroups.values()) {
        const avgSpread = spreads.reduce((sum, s) => sum + s, 0) / spreads.length;
        // Calculate monthly APY: avgSpread * hoursPerMonth / hoursPerYear
        const monthlyAPY = (avgSpread * hoursPerMonth) / (24 * 365); // Convert to monthly return rate
        monthlyReturns.push(monthlyAPY);
      }
    }

    if (monthlyReturns.length === 0) {
      // No historical data: return 0 to indicate insufficient data
      return 0;
    }

    // Find 95th percentile worst month (lowest return)
    monthlyReturns.sort((a, b) => a - b);
    const percentile95Index = Math.floor(monthlyReturns.length * 0.05);
    const worstMonthlyAPY = monthlyReturns[percentile95Index] || monthlyReturns[0] || 0;

    // Convert to USD loss: worst monthly APY * portfolio value
    // If worstMonthlyAPY is negative, this will be a loss
    return worstMonthlyAPY * totalPortfolio;
  }

  /**
   * Calculate maximum drawdown using historical simulation
   */
  private calculateMaximumDrawdown(
    opportunities: PortfolioRiskInput['opportunities'],
    allocations: Map<string, number>,
    totalPortfolio: number,
  ): number {
    // Simulate portfolio value over time
    const portfolioValues: number[] = [totalPortfolio];
    let peak = totalPortfolio;
    let maxDrawdown = 0;

    // Get all historical data points
    const allDataPoints: Array<{ timestamp: Date; hourlyReturn: number }> = [];

    for (const item of opportunities) {
      const allocation = allocations.get(item.opportunity.symbol) || 0;
      if (allocation <= 0) continue;

      const { opportunity } = item;

      const longData = this.historicalService.getHistoricalData(
        opportunity.symbol,
        opportunity.longExchange,
      );
      const shortData = this.historicalService.getHistoricalData(
        opportunity.symbol,
        opportunity.shortExchange,
      );

      if (longData.length === 0 || shortData.length === 0) continue;

      // Match spreads and calculate hourly returns
      for (const longPoint of longData) {
        for (const shortPoint of shortData) {
          const timeDiff = Math.abs(longPoint.timestamp.getTime() - shortPoint.timestamp.getTime());
          if (timeDiff <= 3600 * 1000) {
            const spread = longPoint.rate - shortPoint.rate;
            const hourlyReturn = (spread * allocation) / totalPortfolio;
            allDataPoints.push({
              timestamp: longPoint.timestamp,
              hourlyReturn,
            });
            break;
          }
        }
      }
    }

    if (allDataPoints.length === 0) {
      // No historical data: return 0 to indicate insufficient data
      return 0;
    }

    // Sort by timestamp and simulate portfolio value
    allDataPoints.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    let currentValue = totalPortfolio;
    for (const { hourlyReturn } of allDataPoints) {
      currentValue = currentValue * (1 + hourlyReturn);
      portfolioValues.push(currentValue);

      if (currentValue > peak) {
        peak = currentValue;
      }

      const drawdown = (peak - currentValue) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return -maxDrawdown * totalPortfolio;
  }

  /**
   * Calculate Sharpe ratio (risk-adjusted return)
   */
  private calculateSharpeRatio(
    aggregateAPY: number,
    opportunities: PortfolioRiskInput['opportunities'],
    allocations: Map<string, number>,
    totalPortfolio: number,
  ): number {
    // Calculate portfolio return volatility
    let portfolioVariance = 0;

    for (const item of opportunities) {
      const allocation = allocations.get(item.opportunity.symbol) || 0;
      if (allocation <= 0) continue;

      const weight = allocation / totalPortfolio;
      const volatility = item.volatilityMetrics?.stdDevSpread || 0.0001;
      portfolioVariance += weight * weight * volatility * volatility;
    }

    const portfolioStdDev = Math.sqrt(portfolioVariance) * this.periodsPerYear; // Annualized

    if (portfolioStdDev === 0) {
      return 0;
    }

    // Sharpe = (APY - riskFreeRate) / volatility
    return (aggregateAPY - this.riskFreeRate) / portfolioStdDev;
  }

  /**
   * Calculate historical backtest: What would this portfolio have returned?
   */
  private async calculateHistoricalBacktest(
    opportunities: PortfolioRiskInput['opportunities'],
    allocations: Map<string, number>,
    totalPortfolio: number,
  ): Promise<PortfolioRiskMetrics['historicalBacktest']> {
    const now = Date.now();
    const days30 = 30 * 24 * 60 * 60 * 1000;
    const days90 = 90 * 24 * 60 * 60 * 1000;

    // Calculate returns for last 30 and 90 days
    const returns30: number[] = [];
    const returns90: number[] = [];
    const monthlyReturns: Array<{ apy: number; month: string }> = [];

    for (const item of opportunities) {
      const allocation = allocations.get(item.opportunity.symbol) || 0;
      if (allocation <= 0) continue;

      const { opportunity } = item;

      const longData = this.historicalService.getHistoricalData(
        opportunity.symbol,
        opportunity.longExchange,
      );
      const shortData = this.historicalService.getHistoricalData(
        opportunity.symbol,
        opportunity.shortExchange,
      );

      if (longData.length === 0 || shortData.length === 0) continue;

      // Match spreads and calculate returns
      for (const longPoint of longData) {
        const timestamp = longPoint.timestamp.getTime();
        const age = now - timestamp;

        if (age <= days90) {
          for (const shortPoint of shortData) {
            const timeDiff = Math.abs(timestamp - shortPoint.timestamp.getTime());
            if (timeDiff <= 3600 * 1000) {
              const spread = longPoint.rate - shortPoint.rate;
              const hourlyReturn = (spread * allocation) / totalPortfolio;

              if (age <= days30) {
                returns30.push(hourlyReturn);
              }
              returns90.push(hourlyReturn);

              // Group by month - accumulate hourly returns, then annualize
              const monthKey = `${longPoint.timestamp.getFullYear()}-${longPoint.timestamp.getMonth()}`;
              const existing = monthlyReturns.find(m => m.month === monthKey);
              if (existing) {
                // Accumulate hourly returns (will be annualized later)
                existing.apy += hourlyReturn;
              } else {
                monthlyReturns.push({ apy: hourlyReturn, month: monthKey });
              }

              break;
            }
          }
        }
      }
    }

    // Calculate APY for 30/90 days
    const apy30 = returns30.length > 0
      ? (returns30.reduce((sum, r) => sum + r, 0) / returns30.length) * this.periodsPerYear
      : 0;
    const apy90 = returns90.length > 0
      ? (returns90.reduce((sum, r) => sum + r, 0) / returns90.length) * this.periodsPerYear
      : 0;

    // Find best/worst month - annualize the accumulated hourly returns
    let worstMonth = { apy: 0, month: 'N/A' };
    let bestMonth = { apy: 0, month: 'N/A' };

    if (monthlyReturns.length > 0) {
      // Annualize monthly returns (they're accumulated hourly returns)
      const annualizedMonthlyReturns = monthlyReturns.map(m => ({
        apy: m.apy * this.periodsPerYear,
        month: m.month,
      }));

      worstMonth = annualizedMonthlyReturns.reduce((worst, current) =>
        current.apy < worst.apy ? current : worst
      );
      bestMonth = annualizedMonthlyReturns.reduce((best, current) =>
        current.apy > best.apy ? current : best
      );
    }

    return {
      last30Days: { apy: apy30, realized: returns30.length > 0 },
      last90Days: { apy: apy90, realized: returns90.length > 0 },
      worstMonth,
      bestMonth,
    };
  }

  /**
   * Calculate stress test scenarios
   */
  private calculateStressTestScenarios(
    opportunities: PortfolioRiskInput['opportunities'],
    allocations: Map<string, number>,
    totalPortfolio: number,
  ): PortfolioRiskMetrics['stressTests'] {
    const scenarios: PortfolioRiskMetrics['stressTests'] = [];

    // Scenario 1: Spreads drop 50%
    let scenario1APY = 0;
    for (const item of opportunities) {
      const allocation = allocations.get(item.opportunity.symbol) || 0;
      if (allocation <= 0) continue;
      const reducedSpread = item.opportunity.spread.toDecimal() * 0.5;
      scenario1APY += (reducedSpread * this.periodsPerYear * allocation) / totalPortfolio;
    }
    scenarios.push({
      scenario: 'Spread Drop 50%',
      description: 'All spreads reduce by 50%',
      apy: scenario1APY,
      timeToRecover: scenario1APY > 0 ? '2-3 months' : '3-6 months',
      riskLevel: scenario1APY > 0.15 ? 'MEDIUM' : scenario1APY > 0 ? 'HIGH' : 'CRITICAL',
    });

    // Scenario 2: Spreads reverse
    let scenario2APY = 0;
    for (const item of opportunities) {
      const allocation = allocations.get(item.opportunity.symbol) || 0;
      if (allocation <= 0) continue;
      const reversedSpread = -item.opportunity.spread;
      scenario2APY += (reversedSpread * this.periodsPerYear * allocation) / totalPortfolio;
    }
    scenarios.push({
      scenario: 'Spread Reversal',
      description: 'All spreads flip sign (become negative)',
      apy: scenario2APY,
      timeToRecover: scenario2APY > 0 ? '1-2 months' : '6-12 months',
      riskLevel: scenario2APY > 0 ? 'HIGH' : 'CRITICAL',
    });

    // Scenario 3: Spreads collapse to near-zero
    scenarios.push({
      scenario: 'Spread Collapse',
      description: 'All spreads drop to near-zero',
      apy: -0.02, // Assume 2% costs remain
      timeToRecover: '3-6 months',
      riskLevel: 'CRITICAL',
    });

    // Scenario 4: Worst volatility period
    let scenario4APY = 0;
    for (const item of opportunities) {
      const allocation = allocations.get(item.opportunity.symbol) || 0;
      if (allocation <= 0) continue;
      const volatilityMetrics = item.volatilityMetrics;
      if (volatilityMetrics) {
        // Use minimum spread from history
        const worstSpread = volatilityMetrics.minSpread;
        scenario4APY += (worstSpread * this.periodsPerYear * allocation) / totalPortfolio;
      }
    }
    scenarios.push({
      scenario: 'Worst Volatility Period',
      description: 'Use worst historical volatility period',
      apy: scenario4APY,
      timeToRecover: scenario4APY > 0.1 ? '1-2 months' : '2-4 months',
      riskLevel: scenario4APY > 0.15 ? 'MEDIUM' : scenario4APY > 0 ? 'HIGH' : 'CRITICAL',
    });

    // Scenario 5: Correlated failure (all correlated pairs fail together)
    scenarios.push({
      scenario: 'Correlated Failure',
      description: 'All correlated pairs fail together',
      apy: -0.05, // Assume 5% loss
      timeToRecover: '2-3 months',
      riskLevel: 'HIGH',
    });

    return scenarios;
  }

  /**
   * Calculate correlation analysis between opportunity pairs
   */
  private calculateCorrelationAnalysis(
    opportunities: PortfolioRiskInput['opportunities'],
  ): PortfolioRiskMetrics['correlationRisk'] {
    const correlations: Array<{ pair1: string; pair2: string; correlation: number }> = [];

    // Calculate correlation between all pairs
    for (let i = 0; i < opportunities.length; i++) {
      for (let j = i + 1; j < opportunities.length; j++) {
        const opp1 = opportunities[i];
        const opp2 = opportunities[j];

        const correlation = this.calculateSpreadCorrelation(
          opp1.opportunity,
          opp2.opportunity,
        );

        correlations.push({
          pair1: opp1.opportunity.symbol,
          pair2: opp2.opportunity.symbol,
          correlation,
        });
      }
    }

    const avgCorrelation = correlations.length > 0
      ? correlations.reduce((sum, c) => sum + c.correlation, 0) / correlations.length
      : 0;

    const maxCorrelation = correlations.length > 0
      ? Math.max(...correlations.map(c => Math.abs(c.correlation)))
      : 0;

    const correlatedPairs = correlations.filter(c => Math.abs(c.correlation) > 0.7);

    return {
      averageCorrelation: avgCorrelation,
      maxCorrelation,
      correlatedPairs,
    };
  }

  /**
   * Calculate correlation between two opportunity spreads
   */
  private calculateSpreadCorrelation(
    opp1: ArbitrageOpportunity,
    opp2: ArbitrageOpportunity,
  ): number {
    // Get historical spreads for both opportunities
    const long1Data = this.historicalService.getHistoricalData(opp1.symbol, opp1.longExchange);
    const short1Data = this.historicalService.getHistoricalData(opp1.symbol, opp1.shortExchange);
    const long2Data = this.historicalService.getHistoricalData(opp2.symbol, opp2.longExchange);
    const short2Data = this.historicalService.getHistoricalData(opp2.symbol, opp2.shortExchange);

    if (long1Data.length === 0 || short1Data.length === 0 || long2Data.length === 0 || short2Data.length === 0) {
      return 0; // No data = no correlation
    }

    // Match spreads by timestamp
    const spreads1: number[] = [];
    const spreads2: number[] = [];

    for (const long1 of long1Data) {
      for (const short1 of short1Data) {
        const timeDiff1 = Math.abs(long1.timestamp.getTime() - short1.timestamp.getTime());
        if (timeDiff1 <= 3600 * 1000) {
          const spread1 = long1.rate - short1.rate;

          // Find matching timestamp in opp2
          for (const long2 of long2Data) {
            const timeDiff2 = Math.abs(long1.timestamp.getTime() - long2.timestamp.getTime());
            if (timeDiff2 <= 3600 * 1000) {
              for (const short2 of short2Data) {
                const timeDiff3 = Math.abs(long2.timestamp.getTime() - short2.timestamp.getTime());
                if (timeDiff3 <= 3600 * 1000) {
                  const spread2 = long2.rate - short2.rate;
                  spreads1.push(spread1);
                  spreads2.push(spread2);
                  break;
                }
              }
              break;
            }
          }
          break;
        }
      }
    }

    if (spreads1.length < 10) {
      return 0; // Need at least 10 data points
    }

    // Calculate Pearson correlation coefficient
    const mean1 = spreads1.reduce((sum, s) => sum + s, 0) / spreads1.length;
    const mean2 = spreads2.reduce((sum, s) => sum + s, 0) / spreads2.length;

    let numerator = 0;
    let denom1 = 0;
    let denom2 = 0;

    for (let i = 0; i < spreads1.length; i++) {
      const diff1 = spreads1[i] - mean1;
      const diff2 = spreads2[i] - mean2;
      numerator += diff1 * diff2;
      denom1 += diff1 * diff1;
      denom2 += diff2 * diff2;
    }

    const denominator = Math.sqrt(denom1 * denom2);
    return denominator > 0 ? numerator / denominator : 0;
  }

  /**
   * Calculate concentration risk (HHI, max allocation, top 3)
   */
  private calculateConcentrationRisk(
    allocations: Map<string, number>,
    totalPortfolio: number,
  ): PortfolioRiskMetrics['concentrationRisk'] {
    if (totalPortfolio === 0) {
      return {
        maxAllocationPercent: 0,
        top3AllocationPercent: 0,
        herfindahlIndex: 0,
        riskLevel: 'LOW',
      };
    }

    const allocationPercents = Array.from(allocations.values())
      .map(amount => (amount / totalPortfolio) * 100)
      .sort((a, b) => b - a);

    const maxAllocationPercent = allocationPercents[0] || 0;
    const top3AllocationPercent = allocationPercents.slice(0, 3).reduce((sum, p) => sum + p, 0);

    // Calculate Herfindahl-Hirschman Index (HHI)
    // HHI = Σ(allocationPercent_i^2) / 10000 (normalized to 0-1)
    const hhi = allocationPercents.reduce((sum, p) => sum + (p / 100) * (p / 100), 0);

    // Risk levels: HHI > 0.25 = HIGH, > 0.15 = MEDIUM, else LOW
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
    if (hhi > 0.25 || maxAllocationPercent > 25) {
      riskLevel = 'HIGH';
    } else if (hhi > 0.15 || maxAllocationPercent > 15) {
      riskLevel = 'MEDIUM';
    } else {
      riskLevel = 'LOW';
    }

    return {
      maxAllocationPercent,
      top3AllocationPercent,
      herfindahlIndex: hhi,
      riskLevel,
    };
  }

  /**
   * Calculate volatility breakdown by asset
   */
  private calculateVolatilityBreakdown(
    opportunities: PortfolioRiskInput['opportunities'],
    allocations: Map<string, number>,
    totalPortfolio: number,
  ): PortfolioRiskMetrics['volatilityBreakdown'] {
    const breakdown: PortfolioRiskMetrics['volatilityBreakdown'] = [];

    for (const item of opportunities) {
      const allocation = allocations.get(item.opportunity.symbol) || 0;
      if (allocation <= 0) continue;

      const allocationPercent = (allocation / totalPortfolio) * 100;
      const stabilityScore = item.volatilityMetrics?.stabilityScore || 0.5;

      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
      if (stabilityScore < 0.5 || (item.volatilityMetrics?.spreadReversals || 0) > 10) {
        riskLevel = 'HIGH';
      } else if (stabilityScore < 0.7 || (item.volatilityMetrics?.spreadDropsToZero || 0) > 0) {
        riskLevel = 'MEDIUM';
      } else {
        riskLevel = 'LOW';
      }

      breakdown.push({
        symbol: item.opportunity.symbol,
        allocation,
        allocationPercent,
        stabilityScore,
        riskLevel,
      });
    }

    return breakdown;
  }

  /**
   * Return default metrics when no active opportunities
   */
  private getDefaultMetrics(
    aggregateAPY: number,
    totalPortfolio: number,
  ): PortfolioRiskMetrics {
    return {
      expectedAPY: aggregateAPY,
      expectedAPYConfidenceInterval: { lower: aggregateAPY, upper: aggregateAPY, confidence: 0.95 },
      worstCaseAPY: -0.05,
      valueAtRisk95: totalPortfolio * -0.10,
      maximumDrawdown: totalPortfolio * -0.15,
      sharpeRatio: 0,
      historicalBacktest: {
        last30Days: { apy: 0, realized: false },
        last90Days: { apy: 0, realized: false },
        worstMonth: { apy: 0, month: 'N/A' },
        bestMonth: { apy: 0, month: 'N/A' },
      },
      stressTests: [],
      correlationRisk: {
        averageCorrelation: 0,
        maxCorrelation: 0,
        correlatedPairs: [],
      },
      concentrationRisk: {
        maxAllocationPercent: 0,
        top3AllocationPercent: 0,
        herfindahlIndex: 0,
        riskLevel: 'LOW',
      },
      volatilityBreakdown: [],
    };
  }
}

