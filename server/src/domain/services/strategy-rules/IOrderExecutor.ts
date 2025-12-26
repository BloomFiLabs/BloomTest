import {
  ArbitrageExecutionPlan,
  ArbitrageExecutionResult,
} from '../FundingArbitrageStrategy';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { PerpSpotExecutionPlan } from './PerpSpotExecutionPlanBuilder';
import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { PerpOrderResponse } from '../../value-objects/PerpOrder';
import { Result } from '../../common/Result';
import { DomainException } from '../../exceptions/DomainException';

export interface IOrderExecutor {
  waitForOrderFill(
    adapter: IPerpExchangeAdapter,
    orderId: string,
    symbol: string,
    exchangeType: ExchangeType,
    expectedSize: number,
    maxRetries?: number,
    pollIntervalMs?: number,
    isClosingPosition?: boolean,
    orderSide?: 'LONG' | 'SHORT',
    expectedPrice?: number,
    reduceOnly?: boolean,
    entryPrice?: number,
  ): Promise<PerpOrderResponse>;

  executeSinglePosition(
    bestOpportunity: {
      plan: ArbitrageExecutionPlan;
      opportunity: ArbitrageOpportunity;
    },
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
  ): Promise<Result<ArbitrageExecutionResult, DomainException>>;

  executeMultiplePositions(
    opportunities: Array<{
      opportunity: ArbitrageOpportunity;
      plan: ArbitrageExecutionPlan | PerpSpotExecutionPlan | null;
      maxPortfolioFor35APY: number | null;
      isExisting?: boolean;
      currentValue?: number;
      currentCollateral?: number;
      additionalCollateralNeeded?: number;
    }>,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    exchangeBalances: Map<ExchangeType, number>,
    result: ArbitrageExecutionResult,
  ): Promise<
    Result<
      {
        successfulExecutions: number;
        totalOrders: number;
        totalExpectedReturn: number;
      },
      DomainException
    >
  >;
}
