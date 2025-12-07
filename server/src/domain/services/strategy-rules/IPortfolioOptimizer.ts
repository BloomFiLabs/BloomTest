import { ArbitrageOpportunity } from '../FundingRateAggregator';

export interface PortfolioAllocation {
  allocations: Map<string, number>; // symbol -> allocation amount
  totalPortfolio: number;
  aggregateAPY: number;
  opportunityCount: number;
  dataQualityWarnings: string[];
}

export interface PortfolioOptimizationInput {
  opportunity: ArbitrageOpportunity;
  maxPortfolioFor35APY: number | null;
  longBidAsk: { bestBid: number; bestAsk: number };
  shortBidAsk: { bestBid: number; bestAsk: number };
}

export interface IPortfolioOptimizer {
  calculateMaxPortfolioForTargetAPY(
    opportunity: ArbitrageOpportunity,
    longBidAsk: { bestBid: number; bestAsk: number },
    shortBidAsk: { bestBid: number; bestAsk: number },
    targetNetAPY?: number,
  ): Promise<number | null>;

  calculateOptimalAllocation(
    opportunities: PortfolioOptimizationInput[],
    totalCapital: number | null,
    targetAggregateAPY?: number,
  ): Promise<PortfolioAllocation>;

  calculateDataQualityRiskFactor(
    opportunity: ArbitrageOpportunity,
  ): number;

  validateHistoricalDataQuality(
    opportunity: ArbitrageOpportunity,
    historicalSpread: number,
  ): { isValid: boolean; reason?: string };
}

