import { ExchangeType } from '../../value-objects/ExchangeConfig';
import { IPerpExchangeAdapter } from '../../ports/IPerpExchangeAdapter';
import { ArbitrageOpportunity } from '../FundingRateAggregator';
import { Result } from '../../common/Result';
import { DomainException } from '../../exceptions/DomainException';

export interface IBalanceManager {
  getWalletUsdcBalance(): Promise<Result<number, DomainException>>;

  checkAndDepositWalletFunds(
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    uniqueExchanges: Set<ExchangeType>,
  ): Promise<Result<void, DomainException>>;

  attemptRebalanceForOpportunity(
    opportunity: ArbitrageOpportunity,
    adapters: Map<ExchangeType, IPerpExchangeAdapter>,
    requiredCollateral: number,
    longBalance: number,
    shortBalance: number,
  ): Promise<Result<boolean, DomainException>>;
}
