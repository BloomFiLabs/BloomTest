import { ArbitrageOpportunity } from '../services/FundingRateAggregator';

/**
 * Input for portfolio risk analysis
 */
export interface PortfolioRiskInput {
  allocations: Map<string, number>; // symbol -> allocation amount
  opportunities: Array<{
    opportunity: ArbitrageOpportunity;
    maxPortfolioFor35APY: number | null;
    volatilityMetrics: {
      averageSpread: number;
      stdDevSpread: number;
      minSpread: number;
      maxSpread: number;
      spreadDropsToZero: number;
      spreadReversals: number;
      maxHourlySpreadChange: number;
      stabilityScore: number;
    } | null;
  }>;
  aggregateAPY: number;
  totalPortfolio: number;
}

/**
 * Data quality assessment for risk metrics
 */
export interface DataQualityAssessment {
  hasSufficientDataForVaR: boolean;
  hasSufficientDataForDrawdown: boolean;
  hasSufficientDataForCorrelation: boolean;
  hasSufficientDataForBacktest: boolean;
  hasSufficientDataForConfidenceInterval: boolean;
  warnings: string[];
  hasIssues: boolean;
}

/**
 * Comprehensive risk metrics for investor reporting
 */
export interface PortfolioRiskMetrics {
  // Expected returns
  expectedAPY: number;
  expectedAPYConfidenceInterval: { lower: number; upper: number; confidence: number };
  
  // Risk metrics
  worstCaseAPY: number; // If all spreads reverse
  valueAtRisk95: number; // 95% VaR in USD (worst month)
  maximumDrawdown: number; // Maximum drawdown in USD
  sharpeRatio: number;
  
  // Historical validation
  historicalBacktest: {
    last30Days: { apy: number; realized: boolean };
    last90Days: { apy: number; realized: boolean };
    worstMonth: { apy: number; month: string };
    bestMonth: { apy: number; month: string };
  };
  
  // Stress tests
  stressTests: Array<{
    scenario: string;
    description: string;
    apy: number;
    timeToRecover: string;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  }>;
  
  // Correlation & concentration
  correlationRisk: {
    averageCorrelation: number;
    maxCorrelation: number;
    correlatedPairs: Array<{ pair1: string; pair2: string; correlation: number }>;
  };
  concentrationRisk: {
    maxAllocationPercent: number;
    top3AllocationPercent: number;
    herfindahlIndex: number; // Concentration index (0-1, higher = more concentrated)
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  };
  
  // Volatility breakdown
  volatilityBreakdown: Array<{
    symbol: string;
    allocation: number;
    allocationPercent: number;
    stabilityScore: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  }>;
}

/**
 * Interface for portfolio risk analyzer service
 * Domain port - infrastructure implements this
 */
export interface IPortfolioRiskAnalyzer {
  /**
   * Calculate comprehensive risk metrics for investor reporting
   */
  calculatePortfolioRiskMetrics(
    input: PortfolioRiskInput,
  ): Promise<PortfolioRiskMetrics & { dataQuality: DataQualityAssessment }>;
}
