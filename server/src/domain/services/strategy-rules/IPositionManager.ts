import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { Result } from '../../common/Result';
import { DomainException } from '../../exceptions/DomainException';

export interface AsymmetricFill {
  symbol: string;
  longFilled: boolean;
  shortFilled: boolean;
  longOrderId?: string;
  shortOrderId?: string;
  longExchange: ExchangeType;
  shortExchange: ExchangeType;
  positionSize: number;
  opportunity: ArbitrageOpportunity;
  timestamp: Date;
}

import { PerpPosition } from '../../entities/PerpPosition';
import { ArbitrageExecutionResult } from '../FundingArbitrageStrategy';

export interface IPositionManager {
  getAllPositions(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<Result<PerpPosition[], DomainException>>;

  closeAllPositions(
    positions: PerpPosition[],
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
  ): Promise<Result<{ closed: PerpPosition[]; stillOpen: PerpPosition[] }, DomainException>>;

  handleAsymmetricFills(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    fills: AsymmetricFill[],
    result: ArbitrageExecutionResult,
  ): Promise<Result<void, DomainException>>;

  closeFilledPosition(
    adapter: IPerpExchangeAdapter,
    symbol: string,
    side: 'LONG' | 'SHORT',
    size: number,
    exchangeType: ExchangeType,
    result: ArbitrageExecutionResult,
  ): Promise<Result<void, DomainException>>;
}
