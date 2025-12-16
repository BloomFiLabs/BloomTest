import { BaseDomainEvent } from './DomainEvent';
import { ArbitrageOpportunity } from '../services/FundingRateAggregator';
import { ArbitrageExecutionPlan } from '../services/FundingArbitrageStrategy';
import { PerpOrderResponse } from '../value-objects/PerpOrder';
import { PerpPosition } from '../entities/PerpPosition';
import { ExchangeType } from '../value-objects/ExchangeConfig';

/**
 * Arbitrage opportunity discovered event
 */
export class ArbitrageOpportunityDiscoveredEvent extends BaseDomainEvent {
  public readonly eventType = 'ArbitrageOpportunityDiscovered';

  constructor(
    public readonly opportunity: ArbitrageOpportunity,
    public readonly symbol: string,
  ) {
    super('ArbitrageOpportunityDiscovered');
  }
}

/**
 * Execution plan created event
 */
export class ExecutionPlanCreatedEvent extends BaseDomainEvent {
  public readonly eventType = 'ExecutionPlanCreated';

  constructor(
    public readonly plan:
      | ArbitrageExecutionPlan
      | import('../services/strategy-rules/PerpSpotExecutionPlanBuilder').PerpSpotExecutionPlan,
    public readonly opportunity: ArbitrageOpportunity,
    public readonly symbol: string,
  ) {
    super('ExecutionPlanCreated');
  }
}

/**
 * Orders placed event
 */
export class OrdersPlacedEvent extends BaseDomainEvent {
  public readonly eventType = 'OrdersPlaced';

  constructor(
    public readonly symbol: string,
    public readonly longOrderId: string,
    public readonly shortOrderId: string,
    public readonly longExchange: ExchangeType,
    public readonly shortExchange: ExchangeType,
    public readonly positionSize: number,
  ) {
    super('OrdersPlaced');
  }
}

/**
 * Orders filled event
 */
export class OrdersFilledEvent extends BaseDomainEvent {
  public readonly eventType = 'OrdersFilled';

  constructor(
    public readonly symbol: string,
    public readonly longResponse: PerpOrderResponse,
    public readonly shortResponse: PerpOrderResponse,
    public readonly longExchange: ExchangeType,
    public readonly shortExchange: ExchangeType,
  ) {
    super('OrdersFilled');
  }
}

/**
 * Asymmetric fill event (one leg filled, other pending)
 */
export class AsymmetricFillEvent extends BaseDomainEvent {
  public readonly eventType = 'AsymmetricFill';

  constructor(
    public readonly symbol: string,
    public readonly longFilled: boolean,
    public readonly shortFilled: boolean,
    public readonly longExchange: ExchangeType,
    public readonly shortExchange: ExchangeType,
    public readonly positionSize: number,
    public readonly longOrderId?: string,
    public readonly shortOrderId?: string,
  ) {
    super('AsymmetricFill');
  }
}

/**
 * Position closed event
 */
export class PositionClosedEvent extends BaseDomainEvent {
  public readonly eventType = 'PositionClosed';

  constructor(
    public readonly position: PerpPosition,
    public readonly closeResponse: PerpOrderResponse,
  ) {
    super('PositionClosed');
  }
}

/**
 * Rebalancing attempted event
 */
export class RebalancingAttemptedEvent extends BaseDomainEvent {
  public readonly eventType = 'RebalancingAttempted';

  constructor(
    public readonly symbol: string,
    public readonly fromExchange: ExchangeType,
    public readonly toExchange: ExchangeType,
    public readonly amount: number,
    public readonly success: boolean,
    public readonly reason?: string,
  ) {
    super('RebalancingAttempted');
  }
}

/**
 * Opportunity evaluation failed event
 */
export class OpportunityEvaluationFailedEvent extends BaseDomainEvent {
  public readonly eventType = 'OpportunityEvaluationFailed';

  constructor(
    public readonly opportunity: ArbitrageOpportunity,
    public readonly error: string,
    public readonly symbol: string,
  ) {
    super('OpportunityEvaluationFailed');
  }
}

/**
 * Order execution failed event
 */
export class OrderExecutionFailedEvent extends BaseDomainEvent {
  public readonly eventType = 'OrderExecutionFailed';

  constructor(
    public readonly symbol: string,
    public readonly error: string,
    public readonly orderId?: string,
    public readonly exchange?: ExchangeType,
  ) {
    super('OrderExecutionFailed');
  }
}

/**
 * Strategy execution completed event
 */
export class StrategyExecutionCompletedEvent extends BaseDomainEvent {
  public readonly eventType = 'StrategyExecutionCompleted';

  constructor(
    public readonly opportunitiesEvaluated: number,
    public readonly opportunitiesExecuted: number,
    public readonly totalExpectedReturn: number,
    public readonly errors: string[],
  ) {
    super('StrategyExecutionCompleted');
  }
}
