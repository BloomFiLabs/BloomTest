import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { ArbitrageExecutionPlan } from '../FundingArbitrageStrategy';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { StrategyConfig } from '../../value-objects/StrategyConfig';
import { Result } from '../../common/Result';
import { DomainException } from '../../exceptions/DomainException';

export interface ExecutionPlanContext {
  longBalance: number;
  shortBalance: number;
}

export interface IExecutionPlanBuilder {
  buildPlan(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    balances: ExecutionPlanContext,
    config: StrategyConfig,
    longMarkPrice?: number,
    shortMarkPrice?: number,
    maxPositionSizeUsd?: number,
    leverageOverride?: number,
  ): Promise<Result<ArbitrageExecutionPlan, DomainException>>;

  buildPlanWithAllocation(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    allocationUsd: number,
    balances: ExecutionPlanContext,
    config: StrategyConfig,
    longMarkPrice?: number,
    shortMarkPrice?: number,
    leverageOverride?: number,
  ): Promise<Result<ArbitrageExecutionPlan, DomainException>>;
}






