import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { ArbitrageExecutionPlan } from '../FundingArbitrageStrategy';
import { PerpSpotExecutionPlan } from './PerpSpotExecutionPlanBuilder';
import { PerpPosition } from '../../entities/PerpPosition';
import { Result } from '../../common/Result';
import { DomainException } from '../../exceptions/DomainException';
import { HistoricalMetrics } from '../../ports/IHistoricalFundingRateService';

export interface IOpportunityEvaluator {
  evaluateOpportunityWithHistory(
    opportunity: ArbitrageOpportunity,
    plan: ArbitrageExecutionPlan | PerpSpotExecutionPlan | null,
  ): Result<
    {
      breakEvenHours: number | null;
      historicalMetrics: {
        long: HistoricalMetrics | null;
        short: HistoricalMetrics | null;
      };
      worstCaseBreakEvenHours: number | null;
      consistencyScore: number;
    },
    DomainException
  >;

  selectWorstCaseOpportunity(
    allOpportunities: Array<{
      opportunity: ArbitrageOpportunity;
      plan: ArbitrageExecutionPlan | PerpSpotExecutionPlan | null;
      netReturn: number;
      positionValueUsd: number;
      breakEvenHours: number | null;
    }>,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    maxPositionSizeUsd: number | undefined,
    exchangeBalances: Map<ExchangeType, number>,
  ): Promise<
    Result<
      {
        opportunity: ArbitrageOpportunity;
        plan: ArbitrageExecutionPlan | PerpSpotExecutionPlan;
        reason: string;
      } | null,
      DomainException
    >
  >;

  shouldRebalance(
    currentPosition: PerpPosition,
    newOpportunity: ArbitrageOpportunity,
    newPlan: ArbitrageExecutionPlan,
    cumulativeLoss: number,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<
    Result<
      {
        shouldRebalance: boolean;
        reason: string;
        currentBreakEvenHours: number | null;
        newBreakEvenHours: number | null;
      },
      DomainException
    >
  >;
}
