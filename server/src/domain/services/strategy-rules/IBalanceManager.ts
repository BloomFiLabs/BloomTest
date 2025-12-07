import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ArbitrageOpportunity } from '../FundingRateAggregator';

export interface IBalanceManager {
  getWalletUsdcBalance(): Promise<number>;

  checkAndDepositWalletFunds(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    uniqueExchanges: Set<ExchangeType>,
  ): Promise<void>;

  attemptRebalanceForOpportunity(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    requiredCollateral: number,
    longBalance: number,
    shortBalance: number,
  ): Promise<boolean>;
}

