import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { PerpPosition } from '../../entities/PerpPosition';
import { Result } from '../../common/Result';
import { DomainException } from '../../exceptions/DomainException';

export interface IdleFundsInfo {
  exchange: ExchangeType;
  idleBalance: number;
  reason: 'unused_balance' | 'unfilled_order';
  orderId?: string;
  symbol?: string;
}

export interface PositionPerformance {
  position: PerpPosition;
  expectedReturnPerPeriod: number;
  expectedAPY: number;
  opportunity?: ArbitrageOpportunity;
}

export interface IdleFundsAllocation {
  source: IdleFundsInfo;
  target: {
    opportunity: ArbitrageOpportunity;
    allocation: number;
    reason: 'best_performing' | 'next_opportunity';
  };
}

export interface IIdleFundsManager {
  /**
   * Detect idle funds across all exchanges
   * @param adapters Exchange adapters
   * @param currentPositions Current open positions
   * @param openOrders Map of exchange -> order IDs that are still pending
   * @param failedOrders Map of exchange -> order IDs that have exhausted retries
   * @returns Array of idle funds information
   */
  detectIdleFunds(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    currentPositions: PerpPosition[],
    openOrders: Map<ExchangeType, string[]>,
    failedOrders: Map<ExchangeType, Array<{ orderId: string; symbol: string; timestamp: Date }>>,
  ): Promise<Result<IdleFundsInfo[], DomainException>>;

  /**
   * Rank positions by performance (expected return)
   * @param positions Current positions
   * @param opportunities Available opportunities
   * @returns Sorted array of position performance (best first)
   */
  rankPositionsByPerformance(
    positions: PerpPosition[],
    opportunities: ArbitrageOpportunity[],
  ): PositionPerformance[];

  /**
   * Allocate idle funds to best opportunities
   * @param idleFunds Detected idle funds
   * @param opportunities Available opportunities (sorted by expected return, best first)
   * @param currentPositions Current positions
   * @param exchangeBalances Current exchange balances
   * @returns Allocation plan
   */
  allocateIdleFunds(
    idleFunds: IdleFundsInfo[],
    opportunities: ArbitrageOpportunity[],
    currentPositions: PerpPosition[],
    exchangeBalances: Map<ExchangeType, number>,
  ): Result<IdleFundsAllocation[], DomainException>;

  /**
   * Execute idle funds allocation
   * @param allocations Allocation plan
   * @param adapters Exchange adapters
   * @returns Execution result
   */
  executeAllocations(
    allocations: IdleFundsAllocation[],
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<Result<{ allocated: number; allocations: number }, DomainException>>;
}



