import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { ArbitrageExecutionPlan } from '../FundingArbitrageStrategy';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { StrategyConfig } from '../../value-objects/StrategyConfig';

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
  ): Promise<ArbitrageExecutionPlan | null>;

  buildPlanWithAllocation(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    allocationUsd: number,
    balances: ExecutionPlanContext,
    config: StrategyConfig,
    longMarkPrice?: number,
    shortMarkPrice?: number,
  ): Promise<ArbitrageExecutionPlan | null>;
}

