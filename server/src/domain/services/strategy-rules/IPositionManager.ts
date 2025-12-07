import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ArbitrageOpportunity } from '../FundingRateAggregator';

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

import { PerpPosition } from '../../value-objects/PerpOrder';
import { ArbitrageExecutionResult } from '../FundingArbitrageStrategy';

export interface IPositionManager {
  getAllPositions(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
  ): Promise<PerpPosition[]>;

  closeAllPositions(
    positions: PerpPosition[],
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    result: ArbitrageExecutionResult,
  ): Promise<{ closed: PerpPosition[]; stillOpen: PerpPosition[] }>;

  handleAsymmetricFills(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    fills: AsymmetricFill[],
    result: ArbitrageExecutionResult,
  ): Promise<void>;

  closeFilledPosition(
    adapter: IPerpExchangeAdapter,
    symbol: string,
    side: 'LONG' | 'SHORT',
    size: number,
    exchangeType: ExchangeType,
    result: ArbitrageExecutionResult,
  ): Promise<void>;
}

